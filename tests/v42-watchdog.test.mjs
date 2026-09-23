// Verifies the per-tool execution WATCHDOG — THE fix for the 5-minute hang:
//   1. A tool that never resolves is aborted within its deadline and becomes a
//      clean is_error tool_result, and the TURN PROCEEDS (no multi-minute hang).
//   2. watchdogTimeoutMs:0 no longer means UNBOUNDED — it means "no fixed
//      number is right for this tool", and the tool either derives a deadline
//      from its input or falls to the engine ceiling. A healthy tool is still
//      never interrupted.
//   3. The aborted tool actually sees its signal fire (so its own fetch/child
//      tears down, not just the engine moving on).

import test from "node:test";
import assert from "node:assert/strict";

import { QueryEngine } from "../packages/core/dist/index.js";

const now = () => new Date().toISOString();

/** A provider that calls `toolName` on round 1, then ends with text on round 2
 *  (after the tool_result returns) — so the turn can complete post-watchdog. */
function provider(toolName) {
  let round = 0;
  return {
    name: "wd-provider",
    async *stream() {
      round++;
      if (round === 1) {
        yield { type: "tool_use_start", id: "t1", name: toolName };
        yield { type: "tool_use_input_done", id: "t1", input: {} };
        yield {
          type: "message_done",
          message: { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: toolName, input: {} }], createdAt: now() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a2", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: now() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function run(tool, toolName) {
  const engine = QueryEngine.forTesting(
    { provider: provider(toolName), model: "test", systemPrompt: "t", tools: [tool], workspace: "D:\\Ares", maxTurns: 5 },
    "sess_wd",
  );
  engine.appendUserMessage("go");
  return engine;
}

test("watchdog: a hung tool is aborted within deadline and the turn proceeds", async () => {
  let sawAbort = false;
  const hang = {
    schema: { name: "Hang", description: "never resolves", inputJsonSchema: { type: "object", properties: {} }, safety: "external-state", concurrency: "parallel-safe", watchdogTimeoutMs: 200 },
    call(_input, ctx) {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
      });
    },
  };

  const start = Date.now();
  const events = [];
  for await (const ev of run(hang, "Hang").streamTurn()) events.push(ev);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 4000, `turn finished fast (was ${elapsed}ms), not a multi-minute hang`);
  assert.equal(sawAbort, true, "the tool's own signal fired so its work tears down");
  const err = events.find((e) => e.type === "tool_error" && /watchdog/i.test(e.error));
  assert.ok(err, "a watchdog tool_error was emitted");
  assert.equal(events.at(-1).type, "turn_end");
  assert.equal(events.at(-1).status, "completed", "the turn completed gracefully after the watchdog");
});

test("watchdog: watchdogTimeoutMs:0 still lets a healthy tool run to completion", async () => {
  let ran = false;
  const quick = {
    schema: { name: "Quick", description: "fast", inputJsonSchema: { type: "object", properties: {} }, safety: "external-state", concurrency: "parallel-safe", watchdogTimeoutMs: 0 },
    async call() { ran = true; return { output: { ok: true } }; },
  };
  const events = [];
  for await (const ev of run(quick, "Quick").streamTurn()) events.push(ev);
  assert.equal(ran, true, "the tool ran");
  assert.ok(events.some((e) => e.type === "tool_end"), "produced a normal tool_end, no watchdog error");
  assert.ok(!events.some((e) => e.type === "tool_error" && /watchdog/i.test(e.error)), "no watchdog fired");
});

test("watchdog: a tool that declares 0 but derives a deadline is held to it", async () => {
  // This is the mechanism that makes a "self-capping" tool safe. Bash and
  // PowerShell declare 0 and derive their deadline from the command's own
  // timeout. Before this existed, 0 meant the engine did not race the call at
  // all — so when the shell's own kill failed to settle (an orphaned
  // `docker exec` holding the stdout pipe, 2026-09-22), nothing above it ever
  // gave up and the turn sat wedged for 18 minutes.
  let sawAbort = false;
  const selfCapping = {
    schema: {
      name: "SelfCapping",
      description: "declares its own budget, then fails to honour it",
      inputJsonSchema: { type: "object", properties: {} },
      safety: "workspace-write",
      concurrency: "exclusive",
      watchdogTimeoutMs: 0,
      watchdogFor: (input) => input?.budgetMs ?? 200,
    },
    // The whole point: this promise NEVER settles on its own.
    call(_input, ctx) {
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
      });
    },
  };

  const start = Date.now();
  const events = [];
  for await (const ev of run(selfCapping, "SelfCapping").streamTurn()) events.push(ev);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 4000, `settled in ${elapsed}ms — a promise that never resolves cannot wedge the turn`);
  assert.equal(sawAbort, true, "and the tool's own signal fired so its work tears down");
  assert.ok(events.some((e) => e.type === "tool_error" && /watchdog/i.test(e.error)), "surfaced as a correctable tool error");
  assert.equal(events.at(-1).status, "completed", "the turn carried on rather than being killed");
});
