// "The `content[].thinking` in the thinking mode must be passed back to the API"
//
// Field sessions on Opus 4.6 hit this 400 nineteen times: the assistant turn
// before the pending tool_result carried no thinking block (a round that ran
// with thinking off, an aborted stream, an older rollout), and the next round
// asked for thinking. The block cannot be conjured, so the provider must retry
// ONCE with thinking off and thinking blocks stripped — and never loop.

import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../packages/core/dist/index.js";

function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function stream(s) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

const PASSBACK_400 = JSON.stringify({
  error: { message: "The `content[].thinking` in the thinking mode must be passed back to the API.", type: "invalid_request_error" },
});

const OK_BODY = [
  sse("message_start", { message: { id: "msg_ok", usage: { input_tokens: 5, output_tokens: 1 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "recovered" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  sse("message_stop", {}),
].join("");

const history = [
  { id: "u0", role: "user", content: [{ type: "text", text: "go" }], createdAt: "now" },
  // signed thinking from an earlier round — legal to replay, but stripped on the clean retry
  { id: "a0", role: "assistant", content: [{ type: "thinking", text: "plan", signature: "sig_ok" }, { type: "tool_use", id: "t0", name: "Read", input: {} }], createdAt: "now" },
  { id: "u1", role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "file" }], createdAt: "now" },
  // the poison shape: tool_use with NO thinking block, followed by its result
  { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }], createdAt: "now" },
  { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "edited" }], createdAt: "now" },
];

test("passback 400 → one retry with thinking off and thinking blocks stripped, then a normal stream", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response(PASSBACK_400, { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(stream(OK_BODY), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, endpointUrl: "http://x" });

  const events = [];
  for await (const e of provider.stream({ model: "claude-opus-4-6", system: "s", messages: history, tools: [], reasoningLevel: "medium" })) {
    events.push(e);
  }

  assert.equal(bodies.length, 2, "exactly one retry");
  assert.ok(bodies[0].thinking, "the first request asked for thinking");
  assert.equal(bodies[1].thinking, undefined, "the retry runs with thinking off");
  const retryThinking = bodies[1].messages.flatMap((m) => m.content).filter((b) => b.type === "thinking");
  assert.equal(retryThinking.length, 0, "no thinking blocks on the retry");
  // the tool pairing survives the strip
  const retryUses = bodies[1].messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").map((b) => b.id);
  assert.deepEqual(retryUses, ["t0", "t1"]);

  assert.ok(events.some((e) => e.type === "text_delta" && e.text === "recovered"), "the retry streamed normally");
  assert.ok(!events.some((e) => e.type === "error"), "no error event surfaced");
});

test("passback 400 twice → surfaces the error instead of looping", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(PASSBACK_400, { status: 400, headers: { "content-type": "application/json" } });
  };
  const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, endpointUrl: "http://x" });
  const events = [];
  for await (const e of provider.stream({ model: "claude-opus-4-6", system: "s", messages: history, tools: [], reasoningLevel: "medium" })) {
    events.push(e);
  }
  assert.equal(calls, 2, "retried once, then stopped");
  const err = events.find((e) => e.type === "error");
  assert.ok(err, "an error event is surfaced");
  assert.match(err.error.message, /passed back/);
});
