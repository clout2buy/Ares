// C6 — Retry-After honoring (v0.11.0 reliability, external-user track).
//
// Free/low-tier provider keys (what a coworker pastes in) return 429s carrying a
// `Retry-After` reset window. The engine's exponential backoff caps at 12s, so a
// longer window would burn every retry and fail a turn that waiting would have
// completed. parseRetryAfterMs turns the header into the ms the retry loop honors
// via Math.max(backoff, retryAfterMs). Pure function — clock-free, clamped.

import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs } from "../packages/core/dist/index.js";

const h = (v) => new Headers(v === undefined ? {} : { "retry-after": v });

test("Retry-After: absent header → 0 (fall back to normal backoff)", () => {
  assert.equal(parseRetryAfterMs(h(undefined)), 0);
});

test("Retry-After: delta-seconds → milliseconds", () => {
  assert.equal(parseRetryAfterMs(h("30")), 30_000);
  assert.equal(parseRetryAfterMs(h("1")), 1_000);
});

test("Retry-After: surrounding whitespace tolerated", () => {
  assert.equal(parseRetryAfterMs(h("  10  ")), 10_000);
});

test("Retry-After: clamped to 60s so a turn never freezes for minutes", () => {
  assert.equal(parseRetryAfterMs(h("120")), 60_000);
  assert.equal(parseRetryAfterMs(h("99999")), 60_000);
});

test("Retry-After: zero / negative / garbage / HTTP-date → 0", () => {
  assert.equal(parseRetryAfterMs(h("0")), 0);
  assert.equal(parseRetryAfterMs(h("-5")), 0);
  assert.equal(parseRetryAfterMs(h("soon")), 0);
  // HTTP-date form is intentionally ignored (no clock dependency).
  assert.equal(parseRetryAfterMs(h("Wed, 21 Oct 2026 07:28:00 GMT")), 0);
});
