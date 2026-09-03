// Truncated tool-call recovery — the C3 ladder extension.
//
// Field evidence: a Write whose arguments hit the output-token cap mid-stream
// used to surface "<tool_use_error>… truncated before its arguments finished
// streaming — re-issue it" immediately, and the model re-issued the same giant
// call and truncated again. The fix withholds that error and retries the model
// through the EXISTING max-output-tokens escalation ladder (shared cap of 3);
// only when the ladder is exhausted does the error surface, now with a
// "write smaller pieces" hint. The partial tool_use is stripped BEFORE it
// reaches history, so tool_use/tool_result pairing stays valid on every exit —
// abort mid-ladder included (the invariant behind the bricked-session 400s).

import test from "node:test";
import assert from "node:assert/strict";
import { QueryEngine } from "../packages/core/dist/index.js";

const WORKSPACE = process.platform === "win32" ? "D:\\Ares" : "/tmp";

function makePutTool() {
  const calls = [];
  return {
    calls,
    tool: {
      schema: { name: "Put", description: "fake write", inputJsonSchema: { type: "object", properties: {} }, safety: "read-only", concurrency: "parallel-safe" },
      async call(input) {
        calls.push(input);
        return { output: "stored" };
      },
    },
  };
}

/** message_done whose content holds a tool_use that NEVER streamed an
 *  input_done — the truncated-mid-arguments signature. */
function truncatedDone(id, callNumber) {
  return {
    type: "message_done",
    message: {
      id: `msg${callNumber}`,
      role: "assistant",
      content: [
        { type: "text", text: `attempt ${callNumber}: writing the file` },
        { type: "tool_use", id, name: "Put", input: { partial: true } },
      ],
      createdAt: new Date().toISOString(),
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "max_tokens",
  };
}

function idleDone(callNumber) {
  return {
    type: "message_done",
    message: { id: `done${callNumber}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "end_turn",
  };
}

function makeEngine(provider, tool, sessionId) {
  return QueryEngine.forTesting(
    { provider, model: "m", systemPrompt: "s", tools: [tool], workspace: WORKSPACE, maxTurns: 10 },
    sessionId,
  );
}

function historyBlocks(engine) {
  const uses = [];
  const results = [];
  for (const m of engine.history()) {
    for (const b of m.content) {
      if (b.type === "tool_use") uses.push(b);
      if (b.type === "tool_result") results.push(b);
    }
  }
  return { uses, results };
}

function assertPairingValid(engine) {
  const { uses, results } = historyBlocks(engine);
  assert.deepEqual(
    uses.map((u) => u.id).sort(),
    results.map((r) => r.tool_use_id).sort(),
    "every tool_use in history has exactly one paired tool_result",
  );
}

test("truncated tool call on attempt 1 is withheld and retried; the re-issued tool runs with no error surfaced", async () => {
  let calls = 0;
  const put = makePutTool();
  const provider = {
    name: "trunc-once",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield truncatedDone("w1", calls);
        return;
      }
      if (calls === 2) {
        yield { type: "tool_use_start", id: "w2", name: "Put" };
        yield { type: "tool_use_input_done", id: "w2", input: { file: "x", body: "complete" } };
        yield {
          type: "message_done",
          message: { id: "msg2", role: "assistant", content: [{ type: "tool_use", id: "w2", name: "Put", input: { file: "x", body: "complete" } }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield idleDone(calls);
    },
  };

  const engine = makeEngine(provider, put.tool, "sess_trunc_recover");
  engine.appendUserMessage("write the file");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  assert.equal(events.filter((e) => e.type === "tool_error").length, 0, "no tool_use_error surfaced");
  assert.equal(put.calls.length, 1, "the re-issued call actually ran");
  assert.deepEqual(put.calls[0], { file: "x", body: "complete" });
  assert.ok(
    events.some((e) => e.type === "system_reminder_injected" && /tool call truncated at token cap/.test(e.text)),
    "the ladder announced the withheld retry",
  );
  const { uses, results } = historyBlocks(engine);
  assert.deepEqual(uses.map((u) => u.id), ["w2"], "the partial w1 never reached history");
  assert.equal(results.some((r) => r.is_error === true), false, "no is_error result anywhere");
  assertPairingValid(engine);
  assert.equal(events.at(-1).type, "turn_end");
  assert.equal(events.at(-1).status, "completed");
});

test("sentinel-args truncation (parse error stashed under the sentinel key) is withheld the same way", async () => {
  let calls = 0;
  const put = makePutTool();
  const sentinelInput = { "__tool_use_error__": "<tool_use_error>tool call 'Put' arguments were truncated mid-stream — re-issue it.</tool_use_error>" };
  const provider = {
    name: "trunc-sentinel",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool_use_start", id: "s1", name: "Put" };
        yield { type: "tool_use_input_done", id: "s1", input: sentinelInput };
        yield {
          type: "message_done",
          message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id: "s1", name: "Put", input: sentinelInput }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "max_tokens",
        };
        return;
      }
      if (calls === 2) {
        yield { type: "tool_use_start", id: "s2", name: "Put" };
        yield { type: "tool_use_input_done", id: "s2", input: { ok: true } };
        yield {
          type: "message_done",
          message: { id: "msg2", role: "assistant", content: [{ type: "tool_use", id: "s2", name: "Put", input: { ok: true } }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "tool_use",
        };
        return;
      }
      yield idleDone(calls);
    },
  };

  const engine = makeEngine(provider, put.tool, "sess_trunc_sentinel");
  engine.appendUserMessage("write it");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  assert.equal(events.filter((e) => e.type === "tool_error").length, 0, "sentinel truncation withheld, not surfaced");
  assert.equal(put.calls.length, 1, "clean re-issue ran");
  const { uses } = historyBlocks(engine);
  assert.deepEqual(uses.map((u) => u.id), ["s2"], "partial sentinel call never reached history");
  assertPairingValid(engine);
});

test("ladder exhaustion surfaces the error WITH the smaller-pieces hint; pairing stays valid", async () => {
  let calls = 0;
  const put = makePutTool();
  const provider = {
    name: "trunc-always",
    async *stream() {
      calls += 1;
      if (calls <= 4) {
        yield truncatedDone(`t${calls}`, calls);
        return;
      }
      yield idleDone(calls);
    },
  };

  const engine = makeEngine(provider, put.tool, "sess_trunc_exhaust");
  engine.appendUserMessage("write the huge file");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  const retries = events.filter((e) => e.type === "system_reminder_injected" && /tool call truncated at token cap — retrying/.test(e.text));
  assert.equal(retries.length, 3, "exactly the shared ladder cap of 3 withheld retries");

  const toolErrors = events.filter((e) => e.type === "tool_error");
  assert.equal(toolErrors.length, 1, "the 4th truncation surfaces the correctable error");
  assert.match(toolErrors[0].error, /truncated before its arguments finished streaming/);
  assert.match(
    toolErrors[0].error,
    /use Edit with targeted hunks, or write the file in sections/,
    "exhausted ladder appends the smaller-pieces hint",
  );

  const { uses, results } = historyBlocks(engine);
  assert.deepEqual(uses.map((u) => u.id), ["t4"], "only the surfaced (4th) partial call reached history");
  const errResult = results.find((r) => r.tool_use_id === "t4");
  assert.ok(errResult && errResult.is_error === true, "surfaced error is a paired is_error tool_result");
  assert.match(String(errResult.content), /write the file in sections/);
  assert.equal(put.calls.length, 0, "no partial call ever executed");
  assertPairingValid(engine);
  assert.equal(events.at(-1).type, "turn_end");
});

test("interrupt mid-ladder leaves tool_use/tool_result pairing valid", async () => {
  let calls = 0;
  const put = makePutTool();
  let engineRef = null;
  const provider = {
    name: "trunc-interrupt",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield truncatedDone("z1", calls);
        return;
      }
      // Mid-ladder: the owner interrupts WHILE the retry streams another
      // truncated call. No withholding may happen after an abort — the partial
      // call must get its paired correctable is_error instead.
      engineRef.interrupt();
      yield truncatedDone("z2", calls);
    },
  };

  const engine = makeEngine(provider, put.tool, "sess_trunc_interrupt");
  engineRef = engine;
  engine.appendUserMessage("write the file");
  const events = [];
  for await (const e of engine.streamTurn()) events.push(e);

  const { uses, results } = historyBlocks(engine);
  // The engine surfaces an owner interrupt as a provider abort: the aborted
  // stream's message never reaches history, so no partial tool_use exists at
  // all — and the round-1 withheld partial (z1) must have been stripped, not
  // left as an orphan. Either way the sacred invariant holds: zero unpaired
  // tool_use blocks.
  assert.ok(!uses.some((u) => u.id === "z1"), "withheld round-1 partial never reached history");
  for (const use of uses) {
    assert.ok(results.some((r) => r.tool_use_id === use.id), `tool_use ${use.id} is paired`);
  }
  assertPairingValid(engine);
  assert.equal(put.calls.length, 0, "nothing executed after the interrupt");
  const end = events.at(-1);
  assert.equal(end.type, "turn_end");
  assert.equal(end.status, "interrupted");
});
