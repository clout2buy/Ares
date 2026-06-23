// Retry-After honoring — shared across providers.
//
// Free/low-tier API keys (exactly what a coworker pastes in) hit 429s that carry
// a `Retry-After` header telling you when the window resets. Ares's exponential
// backoff caps at 12s, so a 30s reset window would burn all retries and fail a
// turn that simply waiting would have completed. Parsing the header lets the
// retry loop wait the right amount.

/**
 * Parse an HTTP `Retry-After` header into milliseconds.
 *
 * Anthropic, OpenAI, and OpenRouter all send the delta-seconds form (e.g.
 * `Retry-After: 30`). The HTTP-date form is intentionally ignored (returns 0) so
 * this stays a pure function with no clock dependency — none of our providers use
 * it, and a missing/odd value should fall back to the normal backoff, not block.
 *
 * Clamped to [0, 60s]: a provider asking for minutes shouldn't freeze a turn —
 * past the clamp, the normal retry budget and provider failover take over. Returns
 * 0 when absent or unparseable, so callers can `Math.max` it against their own
 * backoff without a branch.
 */
export function parseRetryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (!raw) return 0;
  const secs = Number(raw.trim());
  if (!Number.isFinite(secs) || secs <= 0) return 0; // ignore HTTP-date / garbage
  return Math.min(Math.round(secs * 1000), 60_000);
}
