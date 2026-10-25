// redactSecrets must stay linear-time (issue #28).
//
// The JWT-shaped pattern used \b fences, and `-` is a non-word character, so
// every hyphen inside a long base64url run was a fresh start position that
// re-scanned the rest of the run: 400KB of tool-error output took 14s on the
// synchronous friction/crash/triage logging paths and froze the daemon. These
// tests pin the fix: big inputs finish fast, real JWTs are still caught, and
// anything past the scan ceiling is dropped rather than passed through raw.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { MAX_REDACT_CHARS, redactSecrets } from "../packages/protocol/dist/index.js";

// Two megabytes of base64url with dots and hyphens sprinkled through it, so it
// is full of short dotted segments that look almost like JWT pieces.
function nearJwtJunk(chars) {
  const raw = randomBytes(Math.ceil(chars * 0.75) + 64).toString("base64url");
  let out = "";
  let i = 0;
  let k = 0;
  while (out.length < chars) {
    const n = 3 + (k++ % 13);
    out += raw.slice(i % raw.length, (i % raw.length) + n) + (k % 2 ? "." : "-");
    i += n;
  }
  return out.slice(0, chars);
}

test("2 MB of near-JWT junk is redacted in well under 200 ms", () => {
  const input = nearJwtJunk(2 * 1024 * 1024);
  const started = performance.now();
  const out = redactSecrets(input);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)} ms — the scan has gone super-linear again`);
  assert.equal(typeof out, "string");
});

test("a 400 KB dot-free base64url run (the issue's repro) is instant", () => {
  const input = randomBytes(400 * 768).toString("base64url");
  const started = performance.now();
  const out = redactSecrets(input);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)} ms (was 14 s before the fix)`);
  assert.equal(out, input, "a run without dots is not a JWT and must come back untouched");
});

test("real JWTs are still redacted, hyphen-adjacent or not", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(redactSecrets(`token=${jwt} done`), "token=[REDACTED] done");
  assert.equal(redactSecrets(`x-${jwt}`), "[REDACTED]");
  assert.equal(redactSecrets(`{"jwt":"${jwt}"}`), '{"jwt":"[REDACTED]"}');
  // Ordinary dotted things stay: versions, hosts, short segments.
  assert.equal(redactSecrets("node v22.22.3 at api.example.com"), "node v22.22.3 at api.example.com");
});

test("input past the ceiling is cut with a marker, never returned unscanned", () => {
  const key = "sk-" + "a".repeat(40);
  const input = "x".repeat(MAX_REDACT_CHARS + 10) + key;
  const out = redactSecrets(input);
  assert.ok(out.length < input.length);
  assert.ok(!out.includes(key), "a key beyond the ceiling must not leak through");
  assert.match(out, /more chars dropped: too large to redact\]$/);
});
