// Field report 2026-11-06: one chat's distilled memory bled into another and
// tripped Anthropic's refusal. Ares's memory now works like Claude Code: the
// durable "about you" facts (type:user / feedback / reference, synthesis,
// hand-written) are shared across every session; a session's own working state
// (type:project and any other auto-distilled fact) recalls only back into the
// session that produced it.

import test from "node:test";
import assert from "node:assert/strict";
import { unifiedRecallForTurn } from "../packages/agent/dist/index.js";

// A stub living store: returns the same node set for any cue, so the test is
// purely about the cross-session gate, not the ranking.
function storeOf(nodes) {
  const entries = nodes.map((node) => ({ node, viaAssociation: false }));
  return async () => ({ remember: async () => entries, peek: () => entries });
}

const NODES = [
  { id: "u1", kind: "semantic", content: "the owner is called Noah and works nights", tags: ["reflected", "type:user", "session:sess_A"], source: "conversation-reflection" },
  { id: "f1", kind: "semantic", content: "the owner wants small asks answered with exactly that change", tags: ["reflected", "type:feedback", "session:sess_A"], source: "conversation-reflection" },
  { id: "r1", kind: "semantic", content: "the owner's box is reachable at doingbox", tags: ["reflected", "type:reference", "session:sess_A"], source: "conversation-reflection" },
  { id: "p_other", kind: "semantic", content: "the owner is rebuilding the theater panel", tags: ["reflected", "type:project", "session:sess_A"], source: "conversation-reflection" },
  { id: "p_own", kind: "semantic", content: "this session is wiring the refusal self-heal", tags: ["reflected", "type:project", "session:sess_B"], source: "conversation-reflection" },
  { id: "syn", kind: "insight", content: "the owner prefers shipping over polishing", source: "synthesis" },
  { id: "manual", kind: "semantic", content: "the owner said to always ask before defaulting", source: "manual", tags: ["type:project"] },
];

async function recallInto(sessionId) {
  const res = await unifiedRecallForTurn({
    query: "make an agent", shouldRecall: true, openLiving: storeOf(NODES), sessionId, limit: 20,
  });
  return new Set(res.items.map((i) => i.id));
}

test("durable about-you facts cross into any session; another session's project state does not", async () => {
  const ids = await recallInto("sess_B");
  // Shared layers cross.
  assert.ok(ids.has("u1"), "type:user crosses");
  assert.ok(ids.has("f1"), "type:feedback crosses");
  assert.ok(ids.has("r1"), "type:reference crosses");
  assert.ok(ids.has("syn"), "synthesized insight crosses");
  assert.ok(ids.has("manual"), "a hand-written (manual) fact crosses even if typed project");
  // The current session's own project state recalls back into it.
  assert.ok(ids.has("p_own"), "this session's own working state recalls");
  // Another session's working state is NOT visible here — the bleed that
  // tripped the refusal.
  assert.ok(!ids.has("p_other"), "another session's project state is isolated out");
});

test("the same project fact recalls in its own session", async () => {
  const ids = await recallInto("sess_A");
  assert.ok(ids.has("p_other"), "sess_A sees its own project state");
  assert.ok(!ids.has("p_own"), "sess_A does not see sess_B's project state");
});

test("with no sessionId (CLI/eval), nothing is filtered — behavior unchanged", async () => {
  const res = await unifiedRecallForTurn({
    query: "anything", shouldRecall: true, openLiving: storeOf(NODES), limit: 20,
  });
  const ids = new Set(res.items.map((i) => i.id));
  assert.ok(ids.has("p_other") && ids.has("p_own"), "no isolation applied without a session id");
});
