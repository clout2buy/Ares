// C1 — microcompact rung (feat/core-consolidation, coding-win track).
//
// The cheap layer beneath heavy compaction: when history passes ~60% of the
// compaction threshold, the engine clears OLD compactable tool_result BODIES
// (keeping the most recent N) in place with NO model call — so context stays lean
// and the expensive summarizer fires far later, while every assistant reasoning
// step and user message is preserved (unlike a blunt trim). The "slow / lobotomy" fix.
//
// usage.inputTokens=0 keeps tokenScale pinned at 1.0 (calibration skips realPrompt<=0),
// so the threshold math is deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine } from "../packages/core/dist/index.js";

const PLACEHOLDER = "[old tool output cleared to save context";

function tenReadsThenIdle() {
  let calls = 0;
  const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
  return {
    name: "mc-provider",
    ids,
    async *stream() {
      calls += 1;
      if (calls === 1) {
        for (const id of ids) {
          yield { type: "tool_use_start", id, name: "Read" };
          yield { type: "tool_use_input_done", id, input: {} };
        }
        yield {
          type: "message_done",
          message: {
            id: "tools",
            role: "assistant",
            content: ids.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })),
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: `done${calls}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

// A "Read" tool whose result is ~1600 chars: 10 of them ≈ 4000 est tokens, which
// lands in (0.6*T, T] for T=5000 — micro fires, heavy does not.
const readTool = {
  schema: { name: "Read", description: "fake read", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
  async call() {
    return { output: "L".repeat(1600) };
  },
};

function toolResults(engine) {
  const out = [];
  for (const m of engine.history()) {
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

test("C1: microcompact clears old tool bodies past the threshold, keeps the most recent N", async () => {
  const provider = tenReadsThenIdle();
  const engine = new QueryEngine(
    {
      provider,
      model: "m",
      systemPrompt: "s",
      tools: [readTool],
      workspace: process.platform === "win32" ? "D:\\Ares" : "/tmp",
      maxTurns: 5,
      compactionThresholdTokens: 5000,
    },
    "sess_microcompact",
  );

  // Turn 1: produce 10 big Read results (no compaction at turn start — history is empty).
  engine.appendUserMessage("gather");
  for await (const _ of engine.streamTurn()) { /* drain */ }
  assert.equal(toolResults(engine).length, 10, "ten tool results recorded");
  assert.equal(toolResults(engine).filter((r) => r.content.startsWith(PLACEHOLDER)).length, 0, "nothing cleared yet");

  // Turn 2: at stream start, microcompact fires and clears the oldest 4 (keep last 6).
  engine.appendUserMessage("again");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  const micro = events.find((e) => e.type === "system_reminder_injected" && /microcompacted/.test(e.text));
  assert.ok(micro, "a microcompact event is emitted");
  assert.equal(micro.source, "compaction");
  assert.match(micro.text, /microcompacted 4 old tool output/);

  const results = toolResults(engine);
  const cleared = results.filter((r) => typeof r.content === "string" && r.content.startsWith(PLACEHOLDER));
  const kept = results.filter((r) => r.content === "L".repeat(1600));
  assert.equal(cleared.length, 4, "oldest 4 cleared");
  assert.equal(kept.length, 6, "most recent 6 kept at full fidelity");

  // No heavy compaction recap was created (microcompact kept us under threshold).
  const hadHeavy = events.some((e) => e.type === "compaction");
  assert.equal(hadHeavy, false, "heavy summarizer did not need to run");
});
