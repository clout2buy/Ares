// secretRedact - a portable, dependency-free scrubber for credential-shaped
// substrings. Used anywhere untrusted or diagnostic text might be persisted
// or displayed (crash logs, browser error surfaces, etc.) so a stray API key
// or bearer token never survives a copy/paste or a written file.
//
// Deliberately regex-based and conservative: false positives (over-redacting
// something that merely looks like a secret) are cheap; false negatives
// (leaking a real key) are not.

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI/Anthropic-style API keys. Real keys embed hyphens after the prefix
  // and inside the body (sk-ant-api03-..., sk-proj-...).
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // Stripe secret/restricted keys use underscores rather than `sk-`. Test-mode
  // keys are credentials too and routinely appear in local diagnostics.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g,
  // Google API keys (Gemini/Maps/etc.).
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // Telegram bot tokens: numeric bot id, colon, then a long base64url secret.
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  // Standalone JWTs and other long, multi-segment dotted bearer-style tokens.
  // Requiring three substantial segments avoids ordinary versions and hosts.
  //
  // The segments are fenced with lookarounds, NOT \b, and bounded. `-` is a
  // non-word character, so with \b every hyphen inside a long base64url run was
  // a fresh start position and each one re-scanned the rest of the run: a 400KB
  // tool-error blob took 14s and froze the daemon's event loop (issue #28). The
  // lookbehind only lets a match begin where a run begins, so each run is walked
  // once; the segment cap bounds the backtrack when no dot follows.
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{6,4096}(?:\.[A-Za-z0-9_-]{6,4096}){2,}(?![A-Za-z0-9_-])/g,
  // HTTP Authorization headers. Bound the token to its real character set so
  // trailing JSON punctuation is not consumed and serialization stays valid.
  /\b(?:Proxy-)?Authorization\s*:\s*Basic\s+[A-Za-z0-9+/=]{8,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // Credentials embedded in URL userinfo (https://user:password@host).
  /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  // AWS access key IDs.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub personal access tokens.
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-.
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
];

// Generic credential-shaped fields need special handling: crashLog serializes
// an object to JSON *before* redaction, so replacing the whole `"token":"..."`
// match would remove structural quotes and corrupt the JSONL. These expressions
// capture the key/delimiter prefix and replace only the value, retaining its
// original quote style. Quoted values intentionally accept punctuation, spaces,
// and escaped characters; provider/OAuth tokens are not reliably alphanumeric.
const DOUBLE_QUOTED_SECRET_FIELD =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password|passphrase|authorization|credential|cookie)\b["']?\s*[:=]\s*)"(?:\\.|[^"\\])*"/gi;
const SINGLE_QUOTED_SECRET_FIELD =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password|passphrase|authorization|credential|cookie)\b["']?\s*[:=]\s*)'(?:\\.|[^'\\])*'/gi;
const UNQUOTED_SECRET_FIELD =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|client[_-]?secret|private[_-]?key|secret|password|passphrase|authorization|credential|cookie)\b["']?\s*[:=]\s*)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * The most text one call will scan. The callers are synchronous logging paths
 * (frictionLog, crashLog, reliabilityTriage) that hand over whole tool-error
 * blobs uncapped; every pattern above is linear now, but a ceiling keeps a
 * multi-megabyte paste from ever owning the event loop again. Anything past it
 * is dropped with a marker rather than passed through unscanned - a truncated
 * log is cheap, a leaked key is not.
 */
export const MAX_REDACT_CHARS = 2 * 1024 * 1024;

/**
 * Replace anything that looks like a credential in `text` with `[REDACTED]`.
 * Safe to call on arbitrary/untrusted strings - never throws. Input beyond
 * MAX_REDACT_CHARS is cut, never returned unredacted.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  if (out.length > MAX_REDACT_CHARS) {
    const dropped = out.length - MAX_REDACT_CHARS;
    out = `${out.slice(0, MAX_REDACT_CHARS)}\n…[${dropped} more chars dropped: too large to redact]`;
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  out = out.replace(DOUBLE_QUOTED_SECRET_FIELD, (_match, prefix: string) => `${prefix}"[REDACTED]"`);
  out = out.replace(SINGLE_QUOTED_SECRET_FIELD, (_match, prefix: string) => `${prefix}'[REDACTED]'`);
  out = out.replace(UNQUOTED_SECRET_FIELD, (_match, prefix: string) => `${prefix}[REDACTED]`);
  return out;
}
