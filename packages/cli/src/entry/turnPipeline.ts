// Extracted from entry.ts — turnPipeline.

import { repositoryMapReminder, runReliabilityTriage, sideQuery, sideQueryJson, writeCrashLogSync } from "@ares/core";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { PermissionMode, TurnEndStatus } from "@ares/protocol";
import { messageText } from "@ares/protocol";
import { notice } from "../terminalUi.js";
import { consciousnessContextReminder } from "../consciousnessContext.js";
import { deliberateForTurn, emitLifecycle, gainForTarget, lawsPromptBlock, unifiedRecallForTurn, runWitness } from "@ares/agent";
import { listCapabilities } from "@ares/operator";
import { buildForegroundReminder, classifyUserIntent, livenessScore, MemoryRouter, MemoryStore, nodesInScope, OWNER_SCOPE, withConsolidationLock } from "@ares/mind";
import { SessionManager, GarrisonServer } from "@ares/garrison";
import { CliRuntimeContext, cliRuntimeContext, compactLine } from "./runtime.js";
import { LiveSession } from "./sessionFactory.js";
import { mnemosyneRecaller } from "./mnemosyneRuntime.js";
import { applyPlanPressure } from "./planPressure.js";
import { crossSurfaceBeforeTurn } from "./crossSurfaceDigest.js";
import { composeSystemPrompt, promptEnvironment, promptWorkflowSurfaces, toolDoctrineFor, type PersonaConfig, type ProviderFamily } from "./prompt/index.js";

// ─── tenant scope ─────────────────────────────────────────────────────────────
//
// Who is on the other end of this turn. The owner (CLI/desktop, or an owner
// chat on Telegram) recalls from and writes to the owner pool; a guest gets an
// isolated `guest:<chatId>` scope (see @ares/mind isIsolatedScope) so the
// owner's projects, plans and finances never surface in a guest's recall and a
// guest's chatter never lands in the owner's memory.
//
// PLUMBING GAP (not fixable from this file): the Telegram bridge
// (packages/channels/src/telegram/bridge.ts) knows chatId + roster role but
// sends only { sessionId, text } over the gateway wire; the garrison
// SessionManager terminates that mapping and hands entry.ts a LiveSession that
// carries neither. Until the bridge/garrison/sessionFactory owners thread it
// through, every LiveSession resolves to the owner — the same behaviour as
// before, now with the seam in place: set `live.tenant` (TenantAwareLiveSession)
// or pass `opts.tenant` to prepareUserTurn and isolation switches on.

export type TurnTenant =
  | { role: "owner" }
  | { role: "guest"; chatId: string | number; name?: string };

/** The optional field the session factory should add to LiveSession. */
export interface TenantAwareLiveSession {
  tenant?: TurnTenant;
}

/** Memory scope for a tenant: the owner pool, or an isolated guest scope. */
export function memoryScopeForTenant(tenant?: TurnTenant): string {
  if (!tenant || tenant.role === "owner") return OWNER_SCOPE;
  return `guest:${String(tenant.chatId).trim()}`;
}

const turnTenants = new WeakMap<LiveSession, TurnTenant>();

function resolveTenant(live: LiveSession, override?: TurnTenant): TurnTenant {
  return override ?? (live as Partial<TenantAwareLiveSession>).tenant ?? { role: "owner" };
}

// ─── live Mind bridge (v6) — wires Living Memory + learned capabilities into
// the ACTUAL conversation, so Ares recalls, captures, and knows itself instead
// of behaving like a fresh chatbot every turn. Read-only/best-effort: the Mind
// must never break a turn.
const LIVE_MEMORY_ITEM_CHARS = 420;

let reliabilityMaintenance: Promise<void> | null = null;
let lastReliabilityMaintenanceErrorAt = 0;

/** Outcome of the most recent triage run in this process. */
export interface TriageLivenessRecord {
  at: number;
  files: number;
  observations: number;
  candidates: number;
  /**
   * Why the run did no work, when it deliberately did none.
   *
   * Load-bearing: triage returns an EMPTY run (files: 0) when it is throttled by
   * cadence, disabled, lock-contended, or under test. Without this field a
   * deliberate skip is indistinguishable from the v0.29 blindness bug, and the
   * cockpit reports a healthy throttle as "dead".
   */
  skipped?: "disabled" | "test" | "cadence" | "locked";
}

// The result used to be discarded (`.then(() => undefined)`), which is exactly
// how triage sat DEAD for three releases: it ran, read zero rollout files
// because of a realpath guard, reported coverage.files === 0, and nobody ever
// saw the number. Keeping the last run lets the cockpit show a zero as a zero.
let lastTriage: TriageLivenessRecord | null = null;

export function lastTriageRun(): TriageLivenessRecord | null {
  return lastTriage;
}

function scheduleReliabilityMaintenance(live: LiveSession): void {
  if (reliabilityMaintenance) return;
  setImmediate(() => {
    if (reliabilityMaintenance) return;
    reliabilityMaintenance = runReliabilityTriage({
      home: live.context.aresHome,
      workspace: live.context.workspace,
    }).then((run) => {
      lastTriage = {
        at: Date.now(),
        files: run?.coverage?.files ?? 0,
        observations: run?.coverage?.observations ?? 0,
        candidates: run?.newCandidates?.length ?? 0,
        skipped: run?.skipped,
      };
    }).catch((error: unknown) => {
      const now = Date.now();
      if (now - lastReliabilityMaintenanceErrorAt < 60 * 60_000) return;
      lastReliabilityMaintenanceErrorAt = now;
      writeCrashLogSync(live.context.aresHome, {
        at: new Date(now).toISOString(),
        kind: "manual",
        process: "reliability-triage",
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        process.stderr.write("[triage] maintenance failed; run `ares triage scan` for details.\n");
      } catch { /* diagnostics stay best-effort */ }
    }).finally(() => {
      reliabilityMaintenance = null;
    });
  });
}

const LIVE_MEMORY_BLOCK_CHARS = 2_400;

// Hard token budget for the injected memory block. The tiered context compiler
// packs recalled fragments under this ceiling (procedural > semantic) so a big
// recall never quietly eats the model's window. Override with ARES_MEMORY_TOKEN_BUDGET.
const LIVE_MEMORY_TOKEN_BUDGET = (() => {
  const raw = Number(process.env.ARES_MEMORY_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 700;
})();

/**
 * Inject the repo's current git state into the session prompt — branch, short
 * status, and the last few commits — so the model stops spending its first
 * tool calls rediscovering the project every session (the way Claude Code does).
 * Best-effort and cheap; silent when the cwd isn't a git repo.
 */
function gitRun(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let settled = false;
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // A killed child's partial stdout is indistinguishable from a clean
      // result — resolve empty so callers treat a timeout as "no data".
      settle("");
    }, 3000);
    // Never let the kill timer keep the process alive past a fast git exit.
    (timer as { unref?: () => void }).unref?.();
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => settle(""));
    child.on("close", () => settle(out.trim()));
  });
}

/** Facts about the current HEAD commit for the after-action reflection trigger. */
export async function gatherGitRunFacts(workspace: string): Promise<{ sha: string; subject: string; changedFiles: string[] } | null> {
  const sha = await gitRun(workspace, ["rev-parse", "HEAD"]);
  if (!sha) return null; // not a git repo / no commits
  const subject = await gitRun(workspace, ["log", "-1", "--format=%s"]);
  const filesRaw = await gitRun(workspace, ["show", "--name-only", "--format=", "HEAD"]);
  const changedFiles = filesRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
  return { sha, subject, changedFiles };
}

export async function loadGitContext(context: CliRuntimeContext): Promise<string> {
  const cwd = context.workspace;
  const run = (args: string[]): Promise<string> => gitRun(cwd, args);
  try {
    const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch) return ""; // not a git repo
    const [status, log] = await Promise.all([
      run(["status", "-s", "--untracked-files=no"]),
      run(["log", "-5", "--oneline", "--no-decorate"]),
    ]);
    const lines = ["", "## Git", `- Branch: ${branch}`];
    if (status) {
      const trimmed = status.split("\n").slice(0, 30).join("\n");
      lines.push("- Uncommitted changes (tracked):", "```", trimmed, "```");
    } else {
      lines.push("- Working tree clean (tracked files)");
    }
    if (log) lines.push("- Recent commits:", "```", log, "```");
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

/**
 * "What you know" ranking for the system prompt: owner-pool semantic nodes by
 * livenessScore (decayed strength + recency of last activation), NOT raw
 * `strength`. Raw strength never decays, so a node reinforced fifty times in
 * March out-ranked everything learned since and stuck to the prompt forever.
 * Guest-scoped nodes never reach the owner's prompt. Pure; exported for tests.
 */
export function rankLiveMindNodes<N extends { kind: string; content: string; strength: number; at: string; lastActivatedAt: string; scope?: string }>(
  nodes: readonly N[],
  now: Date,
): N[] {
  return nodesInScope(nodes, OWNER_SCOPE)
    .filter((n) => n.kind === "semantic" && !/^Recurring theme "/.test(n.content))
    .map((n) => ({ n, score: livenessScore(n as unknown as Parameters<typeof livenessScore>[0], now) }))
    .sort((a, b) => b.score - a.score)
    .map((s) => s.n);
}

export async function loadLiveMindContext(context: CliRuntimeContext): Promise<string> {
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const caps = await listCapabilities(context.home);
    const learned = caps.filter((c) => c.status === "mastered" || c.status === "have");
    const known = rankLiveMindNodes(store.all(), new Date()).slice(0, 8);
    if (learned.length === 0 && known.length === 0) return "";
    const lines: string[] = [
      "",
      "# Your living memory & learned capabilities",
      "This is continuous you — not a fresh assistant booting from zero. The items below are things you actually know and can do, accumulated over time. Draw on them naturally; never announce that you're 'checking memory'.",
    ];
    if (known.length) {
      lines.push("", "What you know:");
      for (const n of known) lines.push(`- ${compactLine(n.content, LIVE_MEMORY_ITEM_CHARS)}`);
    }
    if (learned.length) {
      lines.push("", "Capabilities you can rely on:");
      for (const c of learned) lines.push(`- ${c.name}${c.skillRef ? ` (skill: ${c.skillRef})` : ""}`);
    }
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

/**
 * Host side of engine failure-signature recall: when a tool has failed the same
 * way twice, look in living memory for a remembered fix for that error and hand
 * it back as a short hint. Best-effort and read-only — a lookup never reinforces
 * or mutates memory, and never throws into the turn. Only distilled knowledge
 * (procedural/insight/semantic) counts as a "fix"; raw episodic replay is ignored.
 */
export async function recallFailureFixFromMemory(
  memoryFile: string | undefined,
  input: { tool: string; signature: string; error: string },
): Promise<string | null> {
  if (!memoryFile) return null;
  try {
    const store = await MemoryStore.open(memoryFile);
    // Cue on the error text (the durable part), not the volatile tool id.
    const cue = `${input.tool} ${input.error}`.slice(0, 300).trim();
    if (!cue) return null;
    const peek = (store as { peek?: (c: string, o?: { limit?: number }) => unknown }).peek;
    const entries = typeof peek === "function"
      ? await Promise.resolve(peek.call(store, cue, { limit: 3 }))
      : await store.remember(cue, { limit: 3 });
    const list = Array.isArray(entries) ? entries : [];
    const FIX_KINDS = new Set(["procedural", "insight", "semantic", "belief"]);
    for (const r of list as Array<{ node?: { content?: string; kind?: string } }>) {
      const kind = r.node?.kind;
      const content = r.node?.content?.trim();
      if (content && (!kind || FIX_KINDS.has(kind))) return content.slice(0, 300);
    }
    return null;
  } catch {
    return null; // memory must never break a turn
  }
}

/** Remove inline image bytes from semantic/lifecycle channels. The exact image
 * blocks still travel through Session content; memory, routing telemetry, and
 * the coding journal need only a stable attachment marker. Mirroring megabytes
 * of base64 through lifecycle IPC was enough to stall Desktop during image
 * steering. */
export function semanticUserMessage(userMessage: string): string {
  return userMessage
    .replace(/data:image\/[a-z0-9.+-]+[^,\r\n]*;base64,[^\s]+/gi, "[attached image]")
    .trim();
}

export async function prepareUserTurn(
  live: LiveSession,
  userMessage: string,
  opts: { tenant?: TurnTenant } = {},
): Promise<void> {
  const semanticMessage = semanticUserMessage(userMessage);
  const tenant = resolveTenant(live, opts.tenant);
  turnTenants.set(live, tenant);
  // Structural plan-before-edit verdict for THIS turn, read by the engine at
  // its first model call. Graded on the raw text so slash commands stay exempt.
  applyPlanPressure(live.planPressure, userMessage);
  await live.agentRuntime?.beforeTurn(semanticMessage);
  await mindBeforeTurn(live, semanticMessage, tenant);
  // "Elsewhere today": what the same owner said on other surfaces recently.
  // Gated inside (first turn, or new activity since the last injection); a
  // guest tenant gets nothing. Never throws.
  await crossSurfaceBeforeTurn(live, tenant);
  const codingState = live.codingJournal.beginTurn(semanticMessage);
  if (codingState) {
    live.queueSystemReminder(codingState, "instructions");
    if (process.env.ARES_REPO_MAP !== "0") {
      live.repositoryMapCodingTurns = (live.repositoryMapCodingTurns ?? 0) + 1;
      const snapshot = live.codingJournal.snapshot();
      const priorTouchedCount = live.repositoryMapTouchedCount ?? 0;
      const newlyTouched = snapshot.touchedFiles.slice(priorTouchedCount);
      const boundaryChanged = newlyTouched.some((file) =>
        /(^|\/)(?:package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[^.]+)?\.json|pyproject\.toml|cargo\.toml|go\.mod|agents\.md)$/i.test(file.replace(/\\/g, "/")),
      );
      const due = !live.repositoryMapText || boundaryChanged ||
        live.repositoryMapCodingTurns - (live.repositoryMapLastTurn ?? 0) >= 6;
      if (due) {
        const map = await repositoryMapReminder(live.context.workspace).catch(() => "");
        if (map) {
          live.repositoryMapText = map;
          live.repositoryMapLastTurn = live.repositoryMapCodingTurns;
          live.repositoryMapTouchedCount = snapshot.touchedFiles.length;
          live.queueSystemReminder(map, "instructions");
        }
      }
    }
    if (live.codingJournal.persistedVerificationDebtForCurrentTurn()) {
      const persistedFiles = live.codingJournal.snapshot().touchedFiles.map((file) =>
        path.isAbsolute(file) ? file : path.resolve(live.context.workspace, file),
      );
      if (persistedFiles.length) live.verifier.scheduleFor(persistedFiles);
    }
    // Unlike the session-creation prompt, this captures the CURRENT dirty tree
    // after prior edits or external changes in a long-running task.
    const git = await loadGitContext(live.context);
    if (git) live.queueSystemReminder(`CURRENT REPOSITORY DELTA${git}`, "instructions");
  }
  // Peripheral awareness: a bounded note of what the local watcher has recently
  // seen, injected only when something fresh is buffered (usually nothing). The
  // reminder is hard-capped in items + chars so it can't dominate the window.
  const awareness = consciousnessContextReminder();
  if (awareness) live.queueSystemReminder(awareness, "memory");
  live.queueSystemReminder(buildForegroundReminder(semanticMessage), "instructions");
}

async function mindBeforeTurn(live: LiveSession, userMessage: string, tenant: TurnTenant): Promise<void> {
  const text = userMessage.trim();
  if (!text) return;
  try {
    const intent = classifyUserIntent(text);
    const scope = memoryScopeForTenant(tenant);
    // Owner writes stay UNSCOPED (the pre-tenancy shape every reader already
    // understands); only guests get a stamp.
    const writeScope = scope === OWNER_SCOPE ? {} : { scope };
    // Single canonical recall: v6 living memory (source of truth) merged with the
    // legacy v4 vector store, surfaced as ONE reminder. The turn never reads the
    // two substrates as separate stores again.
    //
    // When Mnemosyne is reachable (or this process can host it), living recall
    // goes through the single-writer server instead of opening memory.jsonl
    // here — reinforcement is a WRITE, and this was the per-turn contention
    // point. Null (disabled/unavailable) falls through to the direct open
    // inside unifiedRecallForTurn, byte-for-byte the pre-Mnemosyne path.
    const livingViaMnemosyne = await mnemosyneRecaller(
      live.context.aresHome,
      live.context.mind.memoryFile,
    ).catch(() => null);
    const prepared = live.agentRuntime?.prepared;
    const recall = await unifiedRecallForTurn({
      query: text,
      workspace: live.context.workspace,
      livingMemoryFile: live.context.mind.memoryFile,
      openLiving: livingViaMnemosyne ? async () => livingViaMnemosyne : undefined,
      shouldRecall: intent.shouldRecall,
      limit: 5,
      itemChars: LIVE_MEMORY_ITEM_CHARS,
      blockChars: LIVE_MEMORY_BLOCK_CHARS,
      tokenBudget: LIVE_MEMORY_TOKEN_BUDGET,
      vector: prepared?.enabled
        ? { config: prepared.config, home: prepared.home, useOllama: process.env.ARES_AGENT_OLLAMA_RECALL === "1" }
        : undefined,
      // Owner pool, or an isolated guest scope — see the tenant block at the
      // top of this file for the (upstream) plumbing that sets it.
      scope,
    });
    live.lastRecallIds = recall.livingIds;
    live.lastUserMessage = text;
    if (recall.reminder) {
      live.queueSystemReminder(recall.reminder, "memory");
      const count = recall.items.length;
      emitLifecycle({ type: "recall_surfaced", count, gain: gainForTarget("RECALL", count) });
    }
    // Advisory cognition (Phase 2C step 3): think WITH what was just recalled and
    // offer a non-binding suggestion. Reuses the unified recall (no second query),
    // never writes a decision, and is gated so trivial turns skip it entirely.
    const advisory = await deliberateForTurn({
      situation: text,
      recalled: recall.living,
      shouldDeliberate: intent.shouldRecall,
      emit: (t) => emitLifecycle({ type: "thought", kind: t.kind, text: t.text }),
    });
    if (advisory.reminder) {
      live.queueSystemReminder(advisory.reminder, "memory");
    }
    // Capture the user's message as an episodic memory — this is how Ares learns
    // over time. The "turn" channel (not "manual", which is the ungated path for
    // explicit Memory-tool writes) collapses near-repeats of the last 7 days
    // into the node that already exists and drops greetings/acks outright.
    if (intent.shouldCapture) {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      await new MemoryRouter(store).write("turn", [{ kind: "episodic", content: text.slice(0, 400), source: live.session.meta.id, ...writeScope }]);
    }
  } catch {
    // never break a turn over memory
  }
}

/**
 * Turn epilogue (ARES V5+V6). Three steps, all best-effort:
 *   1. the agent runtime's own afterTurn lifecycle;
 *   2. V6 consequence settling — every living memory injected into this turn
 *      gets the outcome recorded (win on completed, loss otherwise) so strength
 *      tracks usefulness, not recall popularity;
 *   3. V5 Witness — a cheap sideQuery fork reviews the finished turn and may
 *      write candidate hypotheses into living memory.
 * Nothing here may break the session loop.
 */
export async function finishTurn(
  live: LiveSession,
  turnStatus: TurnEndStatus,
): Promise<void> {
  // `needs_verification` is a COMPLETED loop whose work is unverified; for
  // settling purposes it is "completed" with lastWorkStatus doing the gating.
  const finalStatus: "completed" | "interrupted" | "failed" =
    turnStatus === "needs_verification" ? "completed" : turnStatus;
  if (
    turnStatus === "failed" ||
    turnStatus === "interrupted" ||
    live.session.lastWorkStatus === "unverified" ||
    live.session.lastWorkStatus === "blocked"
  ) {
    await live.verifier.cancel().catch(() => undefined);
  }
  await live.agentRuntime?.afterTurn(finalStatus);
  try {
    await live.codingJournal.finishTurn(turnStatus);
  } catch (error) {
    live.queueSystemReminder(
      `Coding journal persistence failed: ${error instanceof Error ? error.message : String(error)}. Re-establish task state from the rollout and repository before continuing; do not assume the prior turn's working state was saved.`,
      "instructions",
    );
  }

  // V6 — settle the artifacts that were in play.
  // Reliability reconciliation is post-turn and globally idempotent. Every
  // Core session reaches this seam, while the collector's cross-process lease and
  // durable cadence prevent live sessions from duplicating work. Collection
  // only files redacted candidates; it never launches a model, shell, or edit.
  scheduleReliabilityMaintenance(live);

  const ids = live.lastRecallIds ?? [];
  live.lastRecallIds = undefined;
  {
    // Keep a durable copy BEFORE the consuming branch below, and unconditionally
    // — a turn that recalled nothing is itself a reportable fact, and the
    // cockpit cannot distinguish "recalled nothing" from "I read the field too
    // late" unless this is always written.
    const workStatus = live.session.lastWorkStatus;
    live.lastRecallSummary = {
      ids: [...ids],
      won: finalStatus === "completed" && (workStatus === "verified" || workStatus === "not_applicable"),
      at: Date.now(),
    };
  }
  if (ids.length > 0) {
    try {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      const workStatus = live.session.lastWorkStatus;
      await store.recordOutcome(ids, {
        won: finalStatus === "completed" && (workStatus === "verified" || workStatus === "not_applicable"),
        note: `in play for a turn that ${finalStatus} with work status ${workStatus}`,
      });
    } catch {
      // consequence settling never breaks the loop
    }
  }

  // V5 — the Witness reviews substantive turns. Interrupted turns teach nothing
  // reliable; failed turns are reviewed (failures carry feedback/belief signal).
  const userMessage = live.lastUserMessage;
  live.lastUserMessage = undefined;
  if (!userMessage || finalStatus === "interrupted") return;
  if (finalStatus === "completed" && (live.session.lastWorkStatus === "unverified" || live.session.lastWorkStatus === "blocked")) return;
  if (process.env.ARES_WITNESS === "0" || !live.agentRuntime?.prepared.enabled) return;
  try {
    const intent = classifyUserIntent(userMessage);
    if (intent.lowSignal || !intent.shouldCapture) return;
    const history = live.session.engine.history();
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const assistantText = lastAssistant ? messageText(lastAssistant) : "";
    if (!assistantText) return;
    const store = await MemoryStore.open(live.context.mind.memoryFile);
    const witnessScope = memoryScopeForTenant(turnTenants.get(live));
    const report = await runWitness({
      conversation: { user: userMessage, assistant: assistantText, status: finalStatus },
      store,
      source: live.session.meta.id,
      // A guest's turn teaches guest-scoped hypotheses; the owner's stay unscoped.
      ...(witnessScope === OWNER_SCOPE ? {} : { scope: witnessScope }),
      // The Witness runs on post-turn settling — an unbounded model call here
      // means the turn never finishes settling. witness.ts forwards this
      // signal into ask(); sideQuery also carries its own 60s default now.
      signal: AbortSignal.timeout(60_000),
      ask: ({ system, user, schemaHint, signal }) =>
        sideQueryJson({
          provider: live.selection.provider,
          model: live.selection.model,
          system,
          user,
          schemaHint,
          signal,
          onUsage: (usage) =>
            live.session.recordAuxiliaryUsage(
              "witness",
              live.selection.provider.name,
              live.selection.model,
              usage,
            ),
        }),
    });
    if (report.accepted.length > 0) {
      emitLifecycle({
        type: "capture_detected",
        kinds: report.accepted.map((n) => n.tags?.find((t) => t.startsWith("crucible:")) ?? "candidate"),
        excerpt: report.accepted[0].content.slice(0, 120),
        gain: gainForTarget("MEMORY", report.accepted.length, "hypotheses"),
      });
    }
  } catch {
    // the Witness is opportunistic — a failed review costs nothing
  }
}

/** Release process-local helpers when a live session is discarded. Durable
 * background supervisors intentionally survive ordinary host/session teardown;
 * session deletion and evaluation cleanup call killAll explicitly. */
export async function disposeLiveSession(live: LiveSession): Promise<void> {
  await live.verifier.cancel().catch(() => undefined);
  live.shellRegistry.detachAll();
  await live.agentRuntime?.sessionEnded().catch(() => undefined);
  live.agentRuntime?.stop();
}

export async function mindSessionEnded(): Promise<void> {
  try {
    const memoryFile = cliRuntimeContext().mind.memoryFile;
    const store = await MemoryStore.open(memoryFile);
    // sleep: forget the trivial, crystallize recurring themes — skipped when
    // another Ares process (daemon/garrison) holds the consolidation lock.
    await withConsolidationLock(memoryFile, () => store.consolidate());
  } catch {
    // never fatal
  }
}

/**
 * Compose the system prompt.
 *
 * The persona, the shared craft core, the per-model overlay AND the surfaces
 * (tool doctrine, workflows, environment) live in `./prompt/` — this function
 * is the seam that knows the live environment (cwd, platform, date, mode).
 *
 * `opts.providerFamily`/`opts.model` select the coding overlay. Callers that
 * know the live selection should pass it; omitting it simply drops the overlay
 * rather than guessing a family, so a caller that can't know stays correct.
 *
 * `opts.tools` (the turn's tool catalog by name) selects the tool-keyed
 * doctrine: a catalog without ComputerUse pays nothing for the coordinate
 * contract. Omitted = every entry, so a host that doesn't pass its catalog
 * loses nothing it had before.
 */
export function buildSystemPrompt(
  permissionMode: PermissionMode = "workspace-write",
  context = cliRuntimeContext(),
  opts: { providerFamily?: ProviderFamily; model?: string; persona?: PersonaConfig; tools?: readonly string[] } = {},
): string {
  const platform = process.platform === "win32" ? "Windows (PowerShell first)" : process.platform;
  const cwd = context.workspace;
  const today = new Date().toISOString().slice(0, 10);

  return composeSystemPrompt({
    persona: opts.persona,
    providerFamily: opts.providerFamily,
    model: opts.model,
    // The owner's standing orders — read fresh (mtime-cached) on every
    // compose, so a law recorded this turn is in force in the very next
    // provider call, in EVERY session, agent runtime or not.
    laws: lawsPromptBlock(),
    surfaces: {
      tools: toolDoctrineFor(opts.tools),
      workflows: promptWorkflowSurfaces(permissionMode),
      environment: promptEnvironment(permissionMode, cwd, platform, today),
    },
  });
}

