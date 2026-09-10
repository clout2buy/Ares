// Ollama's native /api/chat had NO generation cap: maxOutputTokens was used
// only to size num_ctx, never sent as num_predict. Ollama's own default is -1
// (api/types.go DefaultOptions) — "generate until the context is full".
//
// Field incident (2026-09-10, glm-5.2 via ollama): asked to change a counter
// from refresh rate to FPS, the model produced ~1,900 lines of uninterrupted
// reasoning before its first tool call and made FOUR tool calls in an entire
// session. It identified the one-line fix three separate times ("this is a
// one-line change. Let me try it") and never ran it — emitting a tool_use block
// ENDS generation, so with no cap there is no pressure to ever stop thinking.

import test from "node:test";
import assert from "node:assert/strict";
import { ollamaNumPredict } from "../packages/core/dist/providers/ollamaCloud.js";

const ALLOWANCE = 8_192;

test("reasoning off / absent → the plain output allowance", () => {
  assert.equal(ollamaNumPredict(ALLOWANCE, undefined), ALLOWANCE);
  assert.equal(ollamaNumPredict(ALLOWANCE, "off"), ALLOWANCE);
});

test("the thinking budget is ADDED to the allowance, never shared with it", () => {
  // Sharing would starve the visible reply: the model spends the whole budget
  // reasoning and returns empty content with finish_reason=length.
  assert.equal(ollamaNumPredict(ALLOWANCE, "medium"), 8_192 + ALLOWANCE);
  assert.equal(ollamaNumPredict(ALLOWANCE, "high"), 16_384 + ALLOWANCE);
  assert.equal(ollamaNumPredict(ALLOWANCE, "max"), 65_536 + ALLOWANCE);
});

test("every level returns a FINITE positive cap — never Ollama's -1", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined]) {
    const n = ollamaNumPredict(ALLOWANCE, level);
    assert.ok(Number.isFinite(n), `${level} → finite`);
    assert.ok(n > 0, `${level} → positive, not -1 (unbounded)`);
  }
});

test("a higher reasoning dial buys more room, monotonically", () => {
  const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const caps = levels.map((l) => ollamaNumPredict(ALLOWANCE, l));
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i] > caps[i - 1], `${levels[i]} > ${levels[i - 1]}`);
  }
});

test("the cap always leaves room for a visible reply after the thinking block", () => {
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    const n = ollamaNumPredict(ALLOWANCE, level);
    assert.ok(n - ALLOWANCE >= 0, `${level} keeps the full reply allowance`);
  }
});

test("ARES_OLLAMA_NUM_PREDICT overrides, mirroring ARES_OLLAMA_NUM_CTX", () => {
  const prev = process.env.ARES_OLLAMA_NUM_PREDICT;
  try {
    process.env.ARES_OLLAMA_NUM_PREDICT = "4096";
    assert.equal(ollamaNumPredict(ALLOWANCE, "max"), 4_096, "operator escape hatch wins");
    // Junk must not disable the cap — that would restore the unbounded bug.
    process.env.ARES_OLLAMA_NUM_PREDICT = "not-a-number";
    assert.equal(ollamaNumPredict(ALLOWANCE, "high"), 16_384 + ALLOWANCE);
    process.env.ARES_OLLAMA_NUM_PREDICT = "-1";
    assert.equal(ollamaNumPredict(ALLOWANCE, "high"), 16_384 + ALLOWANCE, "-1 is rejected, not honoured");
  } finally {
    if (prev === undefined) delete process.env.ARES_OLLAMA_NUM_PREDICT;
    else process.env.ARES_OLLAMA_NUM_PREDICT = prev;
  }
});
