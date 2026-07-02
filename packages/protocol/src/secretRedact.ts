// secretRedact — a portable, dependency-free scrubber for credential-shaped
// substrings. Used anywhere untrusted or diagnostic text might be persisted
// or displayed (crash logs, the browser App.tsx error surface, …) so a stray
// API key or bearer token never survives a copy/paste or a written file.
//
// Deliberately regex-based and conservative: false positives (over-redacting
// something that merely looks like a secret) are cheap; false negatives
// (leaking a real key) are not.

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI/Anthropic-style API keys: sk-... . Real keys embed hyphens right
  // after the prefix and inside the body (sk-ant-api03-..., sk-proj-...) — an
  // alnum-only body (the original pattern) misses BOTH shapes entirely, which
  // is the single most important key to catch since sk-ant-* is Anthropic's,
  // Ares's default provider.
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  // HTTP Authorization headers: "Bearer <token>". Bounded to a real token
  // charset (base64url/JWT-shaped) rather than a greedy \S+ — an unbounded
  // \S+ consumes trailing JSON punctuation (closing quote/brace/comma) when
  // the token sits inside a JSON string, corrupting the very crash-log JSONL
  // this exists to keep parseable.
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  // AWS access key IDs.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // GitHub personal access tokens.
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  // Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-
  /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
  // Generic fallback: a key/token/secret/password/authorization-shaped field
  // name followed by a long alnum/dash/underscore value — catches anything
  // the named patterns above miss (custom provider keys, etc.). Allows an
  // optional quote between the field name and the delimiter (["']?  before
  // \s*[:=]) since crashLog.ts's primary caller feeds this JSON.stringify'd
  // text, where every key is quoted ("token":"..."), not bare (token: "...").
  /\b(api[_-]?key|token|secret|password|authorization)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_-]{20,})["']?/gi,
];

/**
 * Replace anything that looks like a credential in `text` with `[REDACTED]`.
 * Safe to call on arbitrary/untrusted strings — never throws.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups) => {
      // The generic field-name pattern has capture groups; keep the field
      // name for readability and only blank the value.
      if (groups.length >= 2 && typeof groups[0] === "string" && typeof groups[1] === "string") {
        return `${groups[0]}: [REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return out;
}
