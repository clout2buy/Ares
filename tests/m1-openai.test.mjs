// M1.4 — OpenAI Responses provider, SSE parsing.
//
// We mock fetch with a canned SSE stream and verify the provider emits
// the right StreamEvent sequence for text and function-call paths.

import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIResponsesProvider } from "../packages/core/dist/index.js";

function makeStreamFromString(s) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

function mockFetch(sseBody, status = 200) {
  return async () =>
    new Response(makeStreamFromString(sseBody), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
}

const auth = {
  token: "test-key",
  source: "env:OPENAI_API_KEY",
  mode: "api-key",
  endpoint: "openai-platform",
};

test("OpenAIResponsesProvider: parses text_delta and message_done", async () => {
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hel" })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })}\n\n`,
  ].join("");

  const provider = new OpenAIResponsesProvider({ auth, fetchImpl: mockFetch(sse), endpointUrl: "http://x" });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "you are a test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" }],
    tools: [],
  })) {
    events.push(e);
  }

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["text_delta", "text_delta", "message_done"]);
  assert.equal(events[0].text, "Hel");
  assert.equal(events[1].text, "lo");

  const done = events.at(-1);
  assert.equal(done.message.role, "assistant");
  assert.equal(done.message.content[0].text, "Hello");
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 2);
  assert.equal(done.stopReason, "end_turn");
});

test("OpenAIResponsesProvider: parses streaming function call", async () => {
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_2" } })}\n\n`,
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", id: "call_abc", name: "Read" },
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "call_abc",
      delta: '{"file_p',
    })}\n\n`,
    `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.delta",
      item_id: "call_abc",
      delta: 'ath":"/tmp/x.txt"}',
    })}\n\n`,
    `event: response.function_call_arguments.done\ndata: ${JSON.stringify({
      type: "response.function_call_arguments.done",
      item_id: "call_abc",
    })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_2", status: "completed", usage: { input_tokens: 5, output_tokens: 4 } },
    })}\n\n`,
  ].join("");

  const provider = new OpenAIResponsesProvider({ auth, fetchImpl: mockFetch(sse), endpointUrl: "http://x" });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
    tools: [{ name: "Read", description: "read file", input_schema: { type: "object" } }],
  })) {
    events.push(e);
  }

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "tool_use_start",
    "tool_use_input_delta",
    "tool_use_input_delta",
    "tool_use_input_done",
    "message_done",
  ]);

  const done = events.find((e) => e.type === "tool_use_input_done");
  assert.equal(done.id, "call_abc");
  assert.deepEqual(done.input, { file_path: "/tmp/x.txt" });

  const final = events.at(-1);
  const toolUse = final.message.content.find((b) => b.type === "tool_use");
  assert.equal(toolUse.name, "Read");
  assert.deepEqual(toolUse.input, { file_path: "/tmp/x.txt" });
});

test("OpenAIResponsesProvider: emits error event on HTTP failure", async () => {
  const provider = new OpenAIResponsesProvider({
    auth,
    fetchImpl: async () =>
      new Response("rate limit", { status: 429, headers: { "content-type": "text/plain" } }),
    endpointUrl: "http://x",
  });
  const events = [];
  for await (const e of provider.stream({
    model: "gpt-4o",
    system: "test",
    messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
    tools: [],
  })) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "http_429");
  assert.equal(events[0].error.retriable, true);
});

test("OpenAIResponsesProvider: missing auth → no_auth error", async () => {
  const provider = new OpenAIResponsesProvider({ fetchImpl: async () => new Response("never") });
  // No auth env vars, no file
  const prevKey = process.env.OPENAI_API_KEY;
  const prevTok = process.env.CRIX_OPENAI_OAUTH_TOKEN;
  const prevHome = process.env.CRIX_HOME;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CRIX_OPENAI_OAUTH_TOKEN;
  process.env.CRIX_HOME = "/nonexistent/path/crix-test";
  try {
    const events = [];
    for await (const e of provider.stream({
      model: "gpt-4o",
      system: "x",
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "x" }], createdAt: "now" }],
      tools: [],
    })) {
      events.push(e);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].error.code, "no_auth");
  } finally {
    if (prevKey) process.env.OPENAI_API_KEY = prevKey;
    if (prevTok) process.env.CRIX_OPENAI_OAUTH_TOKEN = prevTok;
    if (prevHome) process.env.CRIX_HOME = prevHome;
    else delete process.env.CRIX_HOME;
  }
});
