// Credential preflights for the keyed cloud providers.
//
// Field report (2026-10-26, a coworker's desktop): every prompt on every agent
// opened with three error bubbles — Ollama 403 "payment past due", Anthropic
// 401 "invalid x-api-key", "No OpenRouter API key" — before the fourth rung
// (DeepSeek) finally answered. Two things were wrong:
//
//   1. Anthropic and OpenRouter had NO preflight, so the failover ladder
//      resolved them as "configured" and spent a whole turn attempt finding
//      out the key was bad or missing. The ladder's contract is "a rejecting
//      backup is skipped, not fatal" — these rungs never got the chance to
//      reject.
//   2. The pinned provider was re-tried on every turn even while it was
//      retired (daemon.ts handles that side).
//
// These probes are cheap: a presence check first (no network), then one
// authenticated GET against the provider's cheapest endpoint. A NETWORK
// failure passes the probe — a blip must not retire a provider whose key is
// fine; the turn itself will report it. Only an explicit 401/402/403 (or a
// missing key) rejects. Every network call is injectable so the gate is unit
// testable without a daemon.

export type CredentialPreflight = { ok: true } | { ok: false; error: string };

export interface CredentialProbeOptions {
  fetchImpl?: typeof fetch;
  /** Probe deadline; the ladder's own preflight timeout is 8s. */
  timeoutMs?: number;
}

const AUTH_STATUSES = new Set([401, 402, 403]);

async function readShortBody(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return "";
  }
}

/** Anthropic: `x-api-key` against /v1/models (the cheapest authenticated
 *  endpoint). `key` empty + `oauth` false → not configured. An OAuth sign-in
 *  (Claude account) is trusted without a probe: its tokens refresh themselves
 *  and a 401 there means "sign in again", which the turn path already handles
 *  with an in-chat prompt. */
export async function preflightAnthropicCredential(
  input: { key: string; oauth: boolean },
  opts: CredentialProbeOptions = {},
): Promise<CredentialPreflight> {
  if (!input.key) {
    return input.oauth
      ? { ok: true }
      : { ok: false, error: "No Anthropic API key and no Claude sign-in. Add a key or sign in under Settings → API Keys." };
  }
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": input.key, "anthropic-version": "2023-06-01", Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000),
    });
    if (AUTH_STATUSES.has(res.status)) {
      const body = await readShortBody(res);
      return { ok: false, error: `Anthropic rejected the API key (${res.status}${body ? `: ${body}` : ""}). Paste a working key under Settings → API Keys.` };
    }
    return { ok: true };
  } catch {
    // Unreachable ≠ unauthorized. Let the turn find out.
    return { ok: true };
  }
}

/** OpenRouter: Bearer against /api/v1/auth/key — returns the key's own
 *  limits, and 401 for a bad key. Empty key → not configured. */
export async function preflightOpenRouterCredential(
  input: { key: string },
  opts: CredentialProbeOptions = {},
): Promise<CredentialPreflight> {
  if (!input.key) {
    return { ok: false, error: "No OpenRouter API key. Add one under Settings → API Keys." };
  }
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${input.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6_000),
    });
    if (AUTH_STATUSES.has(res.status)) {
      const body = await readShortBody(res);
      return { ok: false, error: `OpenRouter rejected the API key (${res.status}${body ? `: ${body}` : ""}). Paste a working key under Settings → API Keys.` };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** The one-line reason a retired provider is being skipped, for the turn
 *  notice: "retired 4 min ago (http_403: …)". */
export function describeRetirement(reason: string, retiredAtMs: number, nowMs: number = Date.now()): string {
  const ageMin = Math.max(0, Math.round((nowMs - retiredAtMs) / 60_000));
  const when = ageMin < 1 ? "just now" : ageMin === 1 ? "1 min ago" : `${ageMin} min ago`;
  const why = reason.replace(/\s+/g, " ").trim();
  return `retired ${when}${why ? ` (${why.length > 140 ? `${why.slice(0, 137)}…` : why})` : ""}`;
}
