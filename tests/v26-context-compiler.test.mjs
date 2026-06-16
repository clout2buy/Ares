// Verifies the token-budgeted memory context compiler — "less memory, better
// selected." The compiler decides which few fragments reach the model under a
// hard budget, prioritized by tier, gated by active project, never overflowing.

import test from "node:test";
import assert from "node:assert/strict";

import { compileContext, budgetForMessage, estimateTokensDefault } from "../packages/mind/dist/index.js";

const frag = (tier, content, extra = {}) => ({ tier, content, ...extra });

// ── Tiny prompt → tiny memory ─────────────────────────────────────────────────

test("budget: a trivial message earns a small budget; a real one earns the full budget", () => {
  assert.equal(budgetForMessage("hi", 4000), 1000, "greeting → 25%");
  assert.equal(budgetForMessage("ok", 4000), 1000);
  assert.equal(budgetForMessage("", 4000, 0), 0, "empty → floor");
  assert.equal(
    budgetForMessage("implement the bounded parallel Task executor with a cap", 4000),
    4000,
    "a substantive message → full budget",
  );
});

test("tiny prompt gets tiny memory: the packet shrinks with the budget", () => {
  // Enough fragments (~2100 tokens) that the small 1000-token budget must cut.
  const fragments = Array.from({ length: 200 }, (_, i) => frag("semantic", `fact number ${i} about the system internals and how it behaves`));
  const big = compileContext({ userMessage: "explain the architecture in depth", tokenBudget: 4000, fragments });
  const small = compileContext({ userMessage: "hi", tokenBudget: budgetForMessage("hi", 4000), fragments });
  assert.ok(small.tokens < big.tokens, `trivial prompt packs less memory (small ${small.tokens} < big ${big.tokens})`);
  assert.ok(small.included.length < big.included.length);
  assert.ok(small.tokens <= 1000, "trivial prompt stays within the shrunk budget");
});

// ── Budget is never exceeded ──────────────────────────────────────────────────

test("budget is never exceeded, no matter how many fragments are offered", () => {
  const fragments = Array.from({ length: 200 }, (_, i) => frag("semantic", `memory entry ${i} ${"x".repeat(40)}`));
  for (const budget of [0, 1, 50, 200, 1000]) {
    const packet = compileContext({ userMessage: "go", tokenBudget: budget, fragments });
    assert.ok(packet.tokens <= budget, `tokens ${packet.tokens} <= budget ${budget}`);
    // estimate the rendered fragments independently as a cross-check
    const independent = packet.included.reduce((n, f) => n + estimateTokensDefault(f.content), 0);
    assert.ok(independent <= budget, "independently re-estimated inclusion also within budget");
  }
});

// ── Tier priority under pressure ──────────────────────────────────────────────

test("tier priority: working + procedural survive a tight budget before recent", () => {
  const fragments = [
    frag("recent", "we were chatting about the weather earlier"),
    frag("semantic", "the parser uses a recursive descent strategy"),
    frag("working", "GOAL: fix the failing parser test"),
    frag("procedural", "verify before fixing; commit honestly"),
  ];
  // Budget only big enough for ~2 short fragments.
  const packet = compileContext({ userMessage: "continue the task", tokenBudget: 25, fragments });
  const tiers = packet.included.map((f) => f.tier);
  assert.ok(tiers.includes("working"), "working memory made the cut");
  assert.ok(tiers.includes("procedural"), "procedural made the cut");
  assert.ok(!tiers.includes("recent"), "recent chatter was the first cut");
});

// ── Project gating ────────────────────────────────────────────────────────────

test("project: an Ares task gets the Ares packet; an unrelated task does not", () => {
  const fragments = [
    frag("project", "Repo github.com/clout2buy/Ares, branch main, roadmap: memory then Garrison", { project: "Ares" }),
    frag("semantic", "the user prefers concise answers"),
  ];
  const onAres = compileContext({ userMessage: "what's next on the roadmap", activeProject: "Ares", tokenBudget: 4000, fragments });
  assert.ok(onAres.included.some((f) => f.tier === "project"), "Ares project packet is included for an Ares task");

  const onDinner = compileContext({ userMessage: "what should I cook tonight", activeProject: "cooking", tokenBudget: 4000, fragments });
  assert.ok(!onDinner.included.some((f) => f.tier === "project"), "Ares repo history stays OUT of an unrelated task");
  assert.ok(onDinner.dropped.some((f) => f.project === "Ares"), "the cross-project fragment was dropped, not silently included");
});

test("project: a fragment with no project tag is always eligible", () => {
  const fragments = [frag("procedural", "run the gate: build, test, tsc -b --force, cargo build")];
  const packet = compileContext({ userMessage: "do the thing", activeProject: "anything", tokenBudget: 4000, fragments });
  assert.equal(packet.included.length, 1, "untagged procedural rule is project-agnostic");
});

// ── Ranking + rendering ───────────────────────────────────────────────────────

test("score: higher-scored fragments win their tier's slots", () => {
  const fragments = [
    frag("semantic", "low relevance note about something tangential", { score: 0.1 }),
    frag("semantic", "high relevance: the exact API the user asked about", { score: 0.9 }),
  ];
  const packet = compileContext({ userMessage: "the api", tokenBudget: 18, fragments });
  assert.equal(packet.included.length, 1);
  assert.match(packet.included[0].content, /high relevance/, "the higher score was kept");
});

test("render: included fragments are sectioned by tier and cite their source", () => {
  const fragments = [
    frag("working", "GOAL: ship the compiler", { source: "session" }),
    frag("semantic", "compiler lives in @ares/mind", { source: "mem_123" }),
  ];
  const packet = compileContext({ userMessage: "status", tokenBudget: 4000, fragments });
  assert.match(packet.text, /## Working memory/);
  assert.match(packet.text, /## Relevant knowledge/);
  assert.match(packet.text, /\[mem_123\]/, "source pointer is cited for traceability");
});

test("render: nothing eligible / nothing fits → empty packet", () => {
  assert.equal(compileContext({ userMessage: "x", tokenBudget: 4000, fragments: [] }).text, "");
  const tooBig = compileContext({ userMessage: "x", tokenBudget: 1, fragments: [frag("semantic", "a".repeat(400))] });
  assert.equal(tooBig.text, "");
  assert.equal(tooBig.tokens, 0);
  assert.equal(tooBig.dropped.length, 1);
});

// ── Per-tier ceilings ─────────────────────────────────────────────────────────

test("tierBudgets: a per-tier ceiling caps that tier even when the total has room", () => {
  const fragments = Array.from({ length: 10 }, (_, i) => frag("recent", `log line ${i} ${"y".repeat(30)}`));
  const packet = compileContext({ userMessage: "go", tokenBudget: 4000, tierBudgets: { recent: 20 }, fragments });
  assert.ok(packet.byTier.recent <= 20, `recent tier capped at 20 (got ${packet.byTier.recent})`);
  assert.ok(packet.dropped.length > 0, "excess recent fragments dropped despite total budget room");
});
