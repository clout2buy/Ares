// Current Claude models return thinking with display omitted: an empty-text
// thinking block carrying only a signature. Dropping it hid the reasoning chain
// from replayed tool loops; it must survive assembly and be replayed signed.

import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../packages/core/dist/index.js";

const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
const stream = (s) => {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(s)); c.close(); } });
};

const THINKING_ONLY = [
  sse("message_start", { message: { id: "msg_t", usage: { input_tokens: 5, output_tokens: 1 } } }),
  sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
  sse("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SIG123" } }),
  sse("content_block_stop", { index: 0 }),
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 105 } }),
  sse("message_stop", {}),
].join("");

test("omitted-display thinking (empty text + signature) is kept in the assembled message", async () => {
  const fetchImpl = async () => new Response(stream(THINKING_ONLY), { status: 200, headers: { "content-type": "text/event-stream" } });
  const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, endpointUrl: "http://x" });
  let done;
  for await (const e of provider.stream({
    model: "claude-opus-5-5", system: "s", tools: [], reasoningLevel: "high",
    messages: [{ id: "u", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" }],
  })) if (e.type === "message_done") done = e;
  assert.deepEqual(done.message.content, [{ type: "thinking", text: "", signature: "SIG123" }]);
  assert.equal(done.usage.outputTokens, 105);
});

test("a kept omitted-thinking block is replayed with its signature ahead of the tool call", async () => {
  let body;
  const ok = [
    sse("message_start", { message: { id: "m", usage: { input_tokens: 1, output_tokens: 1 } } }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    sse("message_stop", {}),
  ].join("");
  const fetchImpl = async (_u, init) => { body = JSON.parse(init.body); return new Response(stream(ok), { status: 200 }); };
  const provider = new AnthropicProvider({ apiKey: "k", fetchImpl, endpointUrl: "http://x" });
  for await (const _ of provider.stream({
    model: "claude-opus-5-5", system: "s", tools: [], reasoningLevel: "high",
    messages: [
      { id: "u0", role: "user", content: [{ type: "text", text: "go" }], createdAt: "now" },
      { id: "a0", role: "assistant", content: [{ type: "thinking", text: "", signature: "SIG123" }, { type: "tool_use", id: "t0", name: "Read", input: {} }], createdAt: "now" },
      { id: "u1", role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "x" }], createdAt: "now" },
    ],
  })) { /* drain */ }
  const assistant = body.messages.find((m) => m.role === "assistant");
  assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "", signature: "SIG123" });
  assert.equal(assistant.content[1].type, "tool_use");
});
