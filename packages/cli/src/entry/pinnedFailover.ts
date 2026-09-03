// Pinned-model failover — a pin is a preference, not a suicide pact.
//
// Field data (188 turns, one month): 42 failed, dominated by provider stream
// deaths — ollama `fetch failed` ×19, anthropic 404 ×15 / 400 ×10, openrouter
// 401 ×5. Under the old doctrine a pinned model got ZERO cross-provider help:
// the turn died with "enable Auto routing if you want failover". That was the
// right instinct (the model must never switch by itself) applied to the wrong
// moment (the message is already lost). The new contract keeps the pin sacred
// across turns while rescuing THIS turn:
//
//   (a) one same-provider retry after a transient network failure — the
//       engine's own S1 ladder has already backed off; this is the last
//       cheap chance before leaving the account the owner chose;
//   (b) a walk down a configured backup chain (`routing.backup`, default =
//       the Auto ranking) with a visible route_resolved carrying
//       reason:"failover" + from/to so the UI can say "switched to X because Y";
//   (c) the pin is restored on the next turn — the daemon remembers the
//       pre-failover selection and puts it back when the turn settles.
//
// Image-bearing turns never fail over onto a blind model (same guard as the
// vision detour). The Ares Gateway is never failed away from — it IS the
// routing layer. ARES_PINNED_FAILOVER=0 restores the old stop-and-say-so
// behaviour wholesale.
//
// Everything here is pure or dependency-injected so the whole ladder is
// testable with fake providers and no daemon process.

import { isLocalProviderDownMessage } from "./localProviderDiagnosis.js";
import { TERMINAL_PROVIDERS, providerFamilyForSelection, type ProviderSelection } from "./providers.js";
import { modelLikelyHasVision } from "./sessionFactory.js";
import type { UiSettings } from "../uiSettings.js";

/** The Auto ranking: most-likely-to-actually-work first (mirrors
 *  pickHealthyFallback's candidate order). Ollama last — free, but often
 *  not running. */
export const DEFAULT_BACKUP_CHAIN: readonly string[] = ["anthropic", "openrouter", "deepseek", "ollama"];

/** ARES_PINNED_FAILOVER=0 → the pre-v0.46 doctrine (pinned turns die in place). */
export function pinnedFailoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARES_PINNED_FAILOVER !== "0";
}

/**
 * The owner's backup chain. Read from `routing.backup` in ui.json (a list of
 * provider ids, walked in order) or ARES_ROUTING_BACKUP (comma-separated);
 * unknown ids are dropped so a typo can't route to nowhere. Falls back to
 * the Auto ranking. `routing` is typed per-lane in UiSettings, so the
 * `backup` member is read loosely here — the daemon's set_routing normalizer
 * keeps lanes only, which is why the env knob exists as the second path.
 */
export function backupChain(
  settings: Pick<UiSettings, "routing" | "routingBackup"> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const known = new Set<string>(TERMINAL_PROVIDERS);
  // Typed `routingBackup` first; the loose `routing.backup` spelling is kept so a
  // hand-edited ui.json from the first cut keeps working.
  const fromSettings = Array.isArray(settings?.routingBackup) && settings.routingBackup.length > 0
    ? settings.routingBackup
    : (settings?.routing as { backup?: unknown } | undefined)?.backup;
  const fromEnv = typeof env.ARES_ROUTING_BACKUP === "string" ? env.ARES_ROUTING_BACKUP.split(",") : null;
  const raw = Array.isArray(fromSettings) && fromSettings.length > 0 ? fromSettings : fromEnv ?? [];
  const chain = raw
    .map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""))
    .filter((x) => x && known.has(x));
  return chain.length > 0 ? [...new Set(chain)] : [...DEFAULT_BACKUP_CHAIN];
}

export { classifyLocalProviderDown, isLocalProviderDownMessage, isLocalProviderHost, withLocalProviderDiagnosis } from "./localProviderDiagnosis.js";

/** A failure that a SECOND try on the same provider could plausibly survive:
 *  a dropped socket, a DNS hiccup, a stalled stream. NOT auth, NOT 404/400,
 *  NOT "server not running" — those fail identically on retry. */
export function isTransientNetworkFailure(fatal: string | null | undefined): boolean {
  const blob = (fatal ?? "").toLowerCase();
  if (!blob) return false;
  if (isLocalProviderDownMessage(blob)) return false;
  return /fetch failed|econnreset|etimedout|enotfound|eai_again|socket hang up|network|stream_stall|reasoning_stall|premature close|aborted|und_err/.test(blob);
}

export type PinnedFailoverDecision =
  | { action: "retry"; reason: string }
  | { action: "switch"; selection: ProviderSelection; from: string; to: string; reason: string; reasons: string[] }
  | { action: "stop"; reason: string };

export interface PinnedFailoverInput {
  /** The pinned selection that just failed. */
  current: ProviderSelection;
  /** `${code}: ${message}` of the fatal provider error. */
  fatal: string;
  /** How many times THIS turn has failed on the pin so far (1 = first death). */
  attempt: number;
  /** The turn carries image blocks — a blind backup is no rescue. */
  hasImages: boolean;
  /** Families retired for the session (auth/balance deaths). */
  dead: ReadonlySet<string>;
  /** Families already tried this turn — never ping-pong. */
  tried: ReadonlySet<string>;
  /** Backup chain (provider ids, in order). */
  chain: readonly string[];
  /** Resolve a family (default model) into a live selection — selectProvider
   *  in production, a fake in tests. Throwing = not configured. */
  resolve: (family: string) => Promise<ProviderSelection>;
  /** Optional cheap preflight; a rejecting backup is skipped, not fatal. */
  preflight?: (selection: ProviderSelection) => Promise<void>;
}

/** One rung of the pinned-turn rescue ladder. Pure given its injected resolver. */
export async function decidePinnedFailover(input: PinnedFailoverInput): Promise<PinnedFailoverDecision> {
  const currentFamily = providerFamilyForSelection(input.current);
  // The Ares Gateway already picks the real provider and key server-side; a
  // gateway failure is a terminal account condition, never a reason to spend
  // the owner's local keys.
  if (currentFamily === "ares") return { action: "stop", reason: "gateway failures are surfaced, never failed over" };
  // The mock family is a test harness: a scripted failure must stay a failure,
  // never wander onto whatever real provider the developer's machine has.
  if (currentFamily === "mock") return { action: "stop", reason: "mock provider failures are never failed over" };
  if (input.attempt <= 1 && isTransientNetworkFailure(input.fatal)) {
    return { action: "retry", reason: `transient network failure on ${currentFamily} — one same-provider retry` };
  }
  const from = `${currentFamily}/${input.current.model}`;
  const skipped: string[] = [];
  for (const family of input.chain) {
    if (family === currentFamily || input.tried.has(family)) continue;
    if (input.dead.has(family)) {
      skipped.push(`${family} (retired this session)`);
      continue;
    }
    let candidate: ProviderSelection;
    try {
      candidate = await input.resolve(family);
      if (input.preflight) await input.preflight(candidate);
    } catch (err) {
      skipped.push(`${family} (${err instanceof Error ? err.message : "not configured"})`);
      continue;
    }
    if (input.hasImages && !modelLikelyHasVision(candidate.model)) {
      skipped.push(`${family}/${candidate.model} (cannot see the attached image)`);
      continue;
    }
    const to = `${providerFamilyForSelection(candidate)}/${candidate.model}`;
    const reasons = [`pinned ${from} failed: ${input.fatal}`, `backup chain → ${to}`];
    if (skipped.length > 0) reasons.push(`skipped ${skipped.join(", ")}`);
    return { action: "switch", selection: candidate, from, to, reason: "failover", reasons };
  }
  return {
    action: "stop",
    reason: skipped.length > 0
      ? `no usable backup (${skipped.join(", ")})`
      : "no backup provider configured",
  };
}
