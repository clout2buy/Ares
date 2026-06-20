// V3 — Anthropic provider (Messages API v1, streaming SSE) + sideQuery.
//
// Canned-SSE fixture tests in the m1-* provider style: mock fetch returns
// a recorded event stream; we assert the provider emits the right
// StreamEvent sequence, builds the right request shape (cache_control
// breakpoints, thinking budget), and that sideQuery/sideQueryJson — the
// Witness/title/memory-selection primitive — behave on a stub provider.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  sideQuery,
  sideQueryJson,
} from "../packages/core/dist/index.js";

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

function captureFetch(sseBody, captured, status = 200) {
  return async (_url, init) => {
    captured.body = JSON.parse(init.body);
    captured.headers = init.headers;
    return new Response(makeStreamFromString(sseBody), {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
}

function sse(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function userMessage(text) {
  return { id: "u1", role: "user", content: [{ type: "text", text }], createdAt: "now" };
}

test("AnthropicProvider: text-only stream → deltas, usage, cache token capture", async () => {
  const body = [
    sse("message_start", {
      message: {
        id: "msg_1",
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 20,
        },
      },
    }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }),
    // Malformed SSE data line — must be skipped, not crash the stream.
    "event: content_block_delta\ndata: {this is not json\n\n",
    sse("ping", {}),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }),
    sse("message_stop", {}),
  ].join("");

  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: mockFetch(body),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "claude-fable-5",
    system: "you are a test",
    messages: [userMessage("hi")],
    tools: [],
  })) {
    events.push(e);
  }

  assert.deepEqual(
    events.map((e) => e.type),
    ["text_delta", "text_delta", "message_done"],
  );
  assert.equal(events[0].text, "Hel");
  assert.equal(events[1].text, "lo");

  const done = events.at(-1);
  assert.equal(done.message.role, "assistant");
  assert.deepEqual(done.message.content, [{ type: "text", text: "Hello" }]);
  assert.equal(done.message.id, "msg_1");
  assert.equal(done.stopReason, "end_turn");
  assert.equal(done.usage.inputTokens, 200);
  assert.equal(done.usage.outputTokens, 12);
  assert.equal(done.usage.cacheReadTokens, 80);
  assert.equal(done.usage.cacheWriteTokens, 20);
});

test("AnthropicProvider: tool-use stream → start, input deltas, parsed input_done", async () => {
  const body = [
    sse("message_start", {
      message: { id: "msg_2", usage: { input_tokens: 50, output_tokens: 1 } },
    }),
    sse("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "Read" },
    }),
    sse("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_p' },
    }),
    sse("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'ath":"a.txt"}' },
    }),
    sse("content_block_stop", { index: 0 }),
    sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
    sse("message_stop", {}),
  ].join("");

  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: mockFetch(body),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "claude-fable-5",
    system: "test",
    messages: [userMessage("read it")],
    tools: [{ name: "Read", description: "read file", input_schema: { type: "object" } }],
  })) {
    events.push(e);
  }

  assert.deepEqual(
    events.map((e) => e.type),
    ["tool_use_start", "tool_use_input_delta", "tool_use_input_delta", "tool_use_input_done", "message_done"],
  );
  assert.equal(events[0].id, "toolu_1");
  assert.equal(events[0].name, "Read");

  const inputDone = events.find((e) => e.type === "tool_use_input_done");
  assert.deepEqual(inputDone.input, { file_path: "a.txt" });

  const final = events.at(-1);
  assert.equal(final.stopReason, "tool_use");
  const toolUse = final.message.content.find((b) => b.type === "tool_use");
  assert.equal(toolUse.id, "toolu_1");
  assert.equal(toolUse.name, "Read");
  assert.deepEqual(toolUse.input, { file_path: "a.txt" });
});

test("AnthropicProvider: request shape — cache breakpoints, thinking budget, headers", async () => {
  const body = [
    sse("message_start", { message: { id: "msg_3", usage: { input_tokens: 1, output_tokens: 1 } } }),
    sse("message_stop", {}),
  ].join("");
  const captured = {};
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: captureFetch(body, captured),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "claude-sonnet-4-6", // budget-class: fable models take adaptive thinking instead
    system: "the stable prefix",
    messages: [userMessage("go")],
    tools: [
      { name: "Read", description: "read file", input_schema: { type: "object" } },
      { name: "Write", description: "write file", input_schema: { type: "object" } },
    ],
    reasoningLevel: "medium",
    maxOutputTokens: 2048,
  })) {
    events.push(e);
  }
  assert.equal(events.at(-1).type, "message_done");

  assert.equal(captured.headers["anthropic-version"], "2023-06-01");
  assert.equal(captured.headers["x-api-key"], "test-key");

  const req = captured.body;
  assert.equal(req.model, "claude-sonnet-4-6");
  assert.equal(req.stream, true);

  // System carries the cache breakpoint on its (single, last) block.
  assert.deepEqual(req.system, [
    { type: "text", text: "the stable prefix", cache_control: { type: "ephemeral" } },
  ]);

  // cache_control sits on the LAST tool only.
  assert.equal(req.tools.length, 2);
  assert.equal(Object.hasOwn(req.tools[0], "cache_control"), false);
  assert.deepEqual(req.tools[1].cache_control, { type: "ephemeral" });

  // reasoningLevel medium → 8192-token thinking budget; max_tokens grows to
  // fit budget + visible-output allowance (Anthropic requires budget < max).
  assert.deepEqual(req.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(req.max_tokens, 8192 + 2048);

  // The last block of the most recent message carries the rolling conversation
  // cache breakpoint (S3) so a long session reuses its history prefix.
  assert.deepEqual(req.messages, [
    { role: "user", content: [{ type: "text", text: "go", cache_control: { type: "ephemeral" } }] },
  ]);

  // Without reasoningLevel: no thinking param, default 8192 max_tokens.
  const captured2 = {};
  const provider2 = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: captureFetch(body, captured2),
    endpointUrl: "http://x",
  });
  for await (const _ of provider2.stream({
    model: "claude-fable-5",
    system: "test",
    messages: [userMessage("go")],
    tools: [],
  })) {
    // drain
  }
  assert.equal(Object.hasOwn(captured2.body, "thinking"), false);
  assert.equal(captured2.body.max_tokens, 8192);
});

test("AnthropicProvider: OAuth uses the Claude Code request contract", async () => {
  const previous = process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
  process.env.ARES_ANTHROPIC_OAUTH_TOKEN = "oauth-token";
  const captured = {};
  const body = [
    sse("message_start", { message: { id: "msg_oauth", usage: { input_tokens: 1, output_tokens: 0 } } }),
    sse("message_stop", {}),
  ].join("");
  try {
    const provider = new AnthropicProvider({
      fetchImpl: captureFetch(body, captured),
      endpointUrl: "http://x",
    });
    for await (const _ of provider.stream({
      model: "claude-sonnet-4-6",
      system: "Ares system",
      messages: [userMessage("go")],
      tools: [],
    })) {
      // drain
    }

    assert.equal(captured.headers.Authorization, "Bearer oauth-token");
    assert.equal(captured.headers["x-app"], "cli");
    assert.match(captured.headers["User-Agent"], /^claude-cli\//);
    assert.match(captured.headers["anthropic-beta"], /claude-code-20250219/);
    assert.match(captured.headers["anthropic-beta"], /oauth-2025-04-20/);
    assert.equal(captured.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.equal(captured.body.system[1].text, "Ares system");
  } finally {
    if (previous === undefined) delete process.env.ARES_ANTHROPIC_OAUTH_TOKEN;
    else process.env.ARES_ANTHROPIC_OAUTH_TOKEN = previous;
  }
});

test("AnthropicProvider: 429 → single error event, retriable", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    endpointUrl: "http://x",
  });
  const events = [];
  for await (const e of provider.stream({
    model: "claude-fable-5",
    system: "test",
    messages: [userMessage("x")],
    tools: [],
  })) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.code, "http_429");
  assert.equal(events[0].error.retriable, true);
});

test("AnthropicProvider: context-limit 400 carries the body message, not retriable", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: "prompt is too long: 210000 tokens > 200000 maximum",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    endpointUrl: "http://x",
  });
  const events = [];
  for await (const e of provider.stream({
    model: "claude-fable-5",
    system: "test",
    messages: [userMessage("x")],
    tools: [],
  })) {
    events.push(e);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.message, /prompt is too long/);
  assert.equal(events[0].error.retriable, false);
});

test("AnthropicProvider: abort mid-stream stops cleanly (no message_done, no error)", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    sse("message_start", { message: { id: "msg_5", usage: { input_tokens: 9, output_tokens: 1 } } }),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }),
    sse("message_stop", {}),
  ];
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });

  const controller = new AbortController();
  const provider = new AnthropicProvider({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    endpointUrl: "http://x",
  });

  const events = [];
  for await (const e of provider.stream({
    model: "claude-fable-5",
    system: "test",
    messages: [userMessage("x")],
    tools: [],
    signal: controller.signal,
  })) {
    events.push(e);
    if (e.type === "text_delta") controller.abort();
  }

  // The first text_delta arrived; after abort the generator ends without
  // a terminal message_done or a spurious error event.
  assert.ok(events.some((e) => e.type === "text_delta"));
  assert.ok(!events.some((e) => e.type === "message_done"));
  assert.ok(!events.some((e) => e.type === "error"));
});

test("AnthropicProvider: missing API key → no_auth error", async () => {
  const prevAres = process.env.ARES_ANTHROPIC_API_KEY;
  const prevPlain = process.env.ANTHROPIC_API_KEY;
  const prevDisableOauth = process.env.ARES_DISABLE_ANTHROPIC_OAUTH;
  delete process.env.ARES_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.ARES_DISABLE_ANTHROPIC_OAUTH = "1";
  try {
    const provider = new AnthropicProvider({ fetchImpl: async () => new Response("never") });
    const events = [];
    for await (const e of provider.stream({
      model: "claude-fable-5",
      system: "test",
      messages: [userMessage("x")],
      tools: [],
    })) {
      events.push(e);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].error.code, "no_auth");
    assert.equal(events[0].error.retriable, false);
  } finally {
    if (prevAres !== undefined) process.env.ARES_ANTHROPIC_API_KEY = prevAres;
    if (prevPlain !== undefined) process.env.ANTHROPIC_API_KEY = prevPlain;
    if (prevDisableOauth === undefined) delete process.env.ARES_DISABLE_ANTHROPIC_OAUTH;
    else process.env.ARES_DISABLE_ANTHROPIC_OAUTH = prevDisableOauth;
  }
});

// ─── sideQuery / sideQueryJson ──────────────────────────────────────────

function stubProvider(events, captured = {}) {
  return {
    name: "stub",
    async *stream(req) {
      captured.req = req;
      for (const e of events) yield e;
    },
  };
}

const doneEvent = {
  type: "message_done",
  message: { id: "m", role: "assistant", content: [], createdAt: "now" },
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
};

test("sideQuery: concatenates text deltas, defaults maxOutputTokens to 1024", async () => {
  const captured = {};
  const provider = stubProvider(
    [
      { type: "thinking_delta", text: "hmm" },
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      doneEvent,
    ],
    captured,
  );

  const out = await sideQuery({
    provider,
    model: "claude-fable-5",
    system: "you title sessions",
    user: "title this",
  });

  assert.equal(out, "Hello world");
  assert.equal(captured.req.model, "claude-fable-5");
  assert.equal(captured.req.system, "you title sessions");
  assert.deepEqual(captured.req.tools, []);
  assert.equal(captured.req.maxOutputTokens, 1024);
  assert.equal(captured.req.messages.length, 1);
  assert.equal(captured.req.messages[0].role, "user");
  assert.equal(captured.req.messages[0].content[0].text, "title this");
});

test("sideQuery: throws on error event", async () => {
  const provider = stubProvider([
    { type: "error", error: { code: "http_500", message: "boom upstream", retriable: true } },
  ]);
  await assert.rejects(
    sideQuery({ provider, model: "m", system: "s", user: "u" }),
    /boom upstream/,
  );
});

test("sideQueryJson: parses fenced JSON and injects the schema hint into the user turn", async () => {
  const captured = {};
  const provider = stubProvider(
    [
      { type: "text_delta", text: 'Sure! ```json\n{"title": "Fix auth", "tags": ["bug"]}\n``` done.' },
      doneEvent,
    ],
    captured,
  );

  const out = await sideQueryJson({
    provider,
    model: "claude-fable-5",
    system: "you extract titles",
    user: "extract from this transcript",
    schemaHint: '{"title": string, "tags": string[]}',
  });

  assert.deepEqual(out, { title: "Fix auth", tags: ["bug"] });
  // The volatile schema hint lands in the USER turn, never the system
  // prompt — the cached prefix must stay byte-stable.
  assert.equal(captured.req.system, "you extract titles");
  assert.match(captured.req.messages[0].content[0].text, /extract from this transcript/);
  assert.match(captured.req.messages[0].content[0].text, /"title": string/);
});

test("sideQueryJson: throws with the raw reply when no JSON can be parsed", async () => {
  const provider = stubProvider([
    { type: "text_delta", text: "I refuse to answer in JSON today." },
    doneEvent,
  ]);
  await assert.rejects(
    sideQueryJson({ provider, model: "m", system: "s", user: "u", schemaHint: "{}" }),
    /I refuse to answer in JSON today/,
  );
});

test("anthropic: fable-class models get adaptive thinking, no budget, no max_tokens growth", async () => {
  const captured = {};
  const sse = [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const provider = new AnthropicProvider({
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      captured.body = JSON.parse(init.body);
      return new Response(makeStreamFromString(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  for await (const _event of provider.stream({
    model: "claude-fable-5",
    system: "s",
    messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" }],
    tools: [],
    reasoningLevel: "high",
  })) {
    // drain
  }
  assert.deepEqual(captured.body.thinking, { type: "adaptive" });
  assert.equal(captured.body.max_tokens, 8192, "max_tokens not grown for adaptive thinking");
});

test("AnthropicProvider: orphaned tool blocks are sanitized to text (no 400)", async () => {
  const body = [
    sse("message_start", { message: { id: "msg_orphan", usage: { input_tokens: 1, output_tokens: 1 } } }),
    sse("message_stop", {}),
  ].join("");
  const captured = {};
  const provider = new AnthropicProvider({ apiKey: "k", fetchImpl: captureFetch(body, captured), endpointUrl: "http://x" });

  // History after a mid-conversation provider switch: a tool_result whose
  // tool_use was dropped, AND a tool_use with no result. Both must NOT survive
  // as tool blocks (Anthropic 400s on either).
  const messages = [
    { id: "u0", role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_GONE", content: "stale result" }], createdAt: "now" },
    { id: "a0", role: "assistant", content: [{ type: "tool_use", id: "toolu_NORESULT", name: "Read", input: {} }], createdAt: "now" },
    { id: "u1", role: "user", content: [{ type: "text", text: "continue" }], createdAt: "now" },
  ];

  for await (const _ of provider.stream({ model: "claude-sonnet-4-6", system: "s", messages, tools: [] })) { /* drain */ }

  const sent = JSON.stringify(captured.body.messages);
  assert.ok(!sent.includes("tool_result"), "orphaned tool_result must be converted, not sent");
  assert.ok(!sent.includes("tool_use"), "orphaned tool_use must be converted, not sent");
  assert.ok(sent.includes("earlier tool result"), "orphaned result kept as context text");
  assert.ok(sent.includes("earlier") && sent.includes("Read"), "orphaned call kept as context text");
});
