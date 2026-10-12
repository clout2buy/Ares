// A thinking-only / empty end_turn must not end the turn "completed" in silence:
// the guard nudges, retries with thinking OFF, and finally surfaces an error.

import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine } from "../packages/core/dist/index.js";

process.env.ARES_ADAPTIVE_REASONING = "0";

const done = (content, stopReason = "end_turn") => ({
  type: "message_done",
  message: { id: `m${Math.random()}`, role: "assistant", content, createdAt: new Date().toISOString() },
  usage: { inputTokens: 0, outputTokens: 0 },
  stopReason,
});

function makeEngine(script, seen) {
  const provider = {
    name: "scripted",
    async *stream(req) {
      seen.push(req.reasoningLevel);
      yield script[Math.min(seen.length - 1, script.length - 1)]();
    },
  };
  return QueryEngine.forTesting(
    { provider, model: "m", systemPrompt: "s", tools: [], workspace: "/tmp", maxTurns: 6, reasoningLevel: "high" },
    "sess_empty_guard",
  );
}

async function run(engine) {
  engine.appendUserMessage("do the thing");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);
  return events;
}

const empty = () => done([{ type: "thinking", text: "", signature: "SIG" }]);
const text = () => done([{ type: "text", text: "done" }]);

test("empty reply then text: retry runs with thinking off, dial restored after output", async () => {
  const seen = [];
  const engine = makeEngine([empty, text], seen);
  const events = await run(engine);
  assert.deepEqual(seen, ["high", "off"]);
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /empty assistant turn/.test(e.text)));
  assert.ok(!events.some((e) => e.type === "error"));
  assert.equal(events.at(-1).status, "completed");
});

test("persistently empty: two nudges, then an empty_response error instead of silent completion", async () => {
  const seen = [];
  const engine = makeEngine([empty], seen);
  const events = await run(engine);
  assert.equal(seen.length, 3, "original + two nudged retries");
  const err = events.find((e) => e.type === "error");
  assert.equal(err?.error.code, "empty_response");
  assert.equal(err?.error.retriable, true);
});
