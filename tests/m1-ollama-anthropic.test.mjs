// M1.8 — verify Ollama Cloud Anthropic-compat path.
//
// Setup: ANTHROPIC_BASE_URL=http://localhost:11434 + ANTHROPIC_AUTH_TOKEN=ollama
// makes Crix auto-route through Ollama's /v1/messages endpoint with
// Anthropic-shape messages (zero translation since our protocol IS that shape).

import test from "node:test";
import assert from "node:assert/strict";
import {
  OllamaCloudPool,
  OLLAMA_CLOUD_MODELS,
  ollamaCloudModelsFor,
} from "../packages/core/dist/index.js";

function sseStream(events) {
  const encoder = new TextEncoder();
  const lines = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

const slots = {
  reasoner: { model: "qwen3-coder:480b-cloud" },
  apply: { model: "devstral-small-2:24b-cloud" },
  summarize: { model: "gpt-oss:20b-cloud" },
};

const baseReq = {
  model: "ignored-pool-overrides",
  system: "You are helpful.",
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "now" },
  ],
  tools: [],
};

// ─── auto-enable detection ─────────────────────────────────────────────

test("auto-enables Anthropic compat when ANTHROPIC_BASE_URL is set", () => {
  const prev = { base: process.env.ANTHROPIC_BASE_URL, tok: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_BASE_URL = "http://localhost:11434";
  process.env.ANTHROPIC_AUTH_TOKEN = "ollama";
  try {
    const pool = new OllamaCloudPool({ slots });
    assert.equal(pool.useAnthropicCompat, true);
    assert.equal(pool.host, "http://localhost:11434");
  } finally {
    if (prev.base) process.env.ANTHROPIC_BASE_URL = prev.base;
    else delete process.env.ANTHROPIC_BASE_URL;
    if (prev.tok) process.env.ANTHROPIC_AUTH_TOKEN = prev.tok;
    else delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

test("does NOT auto-enable when no Anthropic env vars are set", () => {
  const prev = { base: process.env.ANTHROPIC_BASE_URL, tok: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const pool = new OllamaCloudPool({ slots });
    assert.equal(pool.useAnthropicCompat, false);
  } finally {
    if (prev.base) process.env.ANTHROPIC_BASE_URL = prev.base;
    if (prev.tok) process.env.ANTHROPIC_AUTH_TOKEN = prev.tok;
  }
});

// ─── /v1/messages streaming ────────────────────────────────────────────

test("Anthropic compat: parses message_start → content_block_delta → message_stop", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_abc", usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  let capturedUrl = "";
  let capturedHeaders = null;
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers;
    return new Response(sseStream(events), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const pool = new OllamaCloudPool({
    slots,
    fetchImpl,
    useAnthropicCompat: true,
    apiKey: "ollama",
  });
  const got = [];
  for await (const e of pool.stream("reasoner", baseReq)) got.push(e);

  // URL went to /v1/messages
  assert.match(capturedUrl, /\/v1\/messages$/);
  // Required Anthropic header sent
  assert.equal(capturedHeaders["anthropic-version"], "2023-06-01");
  assert.equal(capturedHeaders["x-api-key"], "ollama");

  // Stream event sequence
  const types = got.map((e) => e.type);
  assert.deepEqual(types, ["text_delta", "text_delta", "message_done"]);
  const done = got.at(-1);
  assert.equal(done.message.role, "assistant");
  assert.equal(done.message.content[0].text, "Hello");
  assert.equal(done.message.id, "msg_abc");
  assert.equal(done.usage.outputTokens, 2);
  assert.equal(done.stopReason, "end_turn");
});

test("Anthropic compat: parses streaming tool_use with input_json_delta", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 5, output_tokens: 0 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_xyz", name: "Read" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"file_p' },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'ath":"/tmp/a"}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
  const pool = new OllamaCloudPool({
    slots,
    fetchImpl: async () => new Response(sseStream(events), { status: 200 }),
    useAnthropicCompat: true,
    apiKey: "ollama",
  });
  const got = [];
  for await (const e of pool.stream("reasoner", baseReq)) got.push(e);

  const types = got.map((e) => e.type);
  assert.deepEqual(types, [
    "tool_use_start",
    "tool_use_input_delta",
    "tool_use_input_delta",
    "tool_use_input_done",
    "message_done",
  ]);
  const done = got.find((e) => e.type === "tool_use_input_done");
  assert.equal(done.id, "toolu_xyz");
  assert.deepEqual(done.input, { file_path: "/tmp/a" });

  const final = got.at(-1);
  const toolUse = final.message.content.find((b) => b.type === "tool_use");
  assert.equal(toolUse.name, "Read");
  assert.deepEqual(toolUse.input, { file_path: "/tmp/a" });
  assert.equal(final.stopReason, "tool_use");
});

test("Anthropic compat: sends cache_control breakpoints and image blocks", async () => {
  const events = [
    { type: "message_start", message: { id: "msg_img", usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 3 } } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  const captured = {};
  const pool = new OllamaCloudPool({
    slots,
    fetchImpl: async (_url, init) => {
      captured.body = JSON.parse(init.body);
      return new Response(sseStream(events), { status: 200 });
    },
    useAnthropicCompat: true,
    apiKey: "ollama",
  });
  const got = [];
  for await (const e of pool.stream("reasoner", {
    ...baseReq,
    messages: [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
        ],
        createdAt: "now",
      },
    ],
    tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }],
  })) got.push(e);

  assert.deepEqual(captured.body.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(captured.body.tools[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(captured.body.messages[0].content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
  assert.equal(got.at(-1).usage.cacheReadTokens, 3);
});

test("Anthropic compat: HTTP error surfaces as retriable on 429/5xx", async () => {
  const pool = new OllamaCloudPool({
    slots,
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
    useAnthropicCompat: true,
    apiKey: "ollama",
  });
  const got = [];
  for await (const e of pool.stream("reasoner", baseReq)) got.push(e);
  assert.equal(got.length, 1);
  assert.equal(got[0].type, "error");
  assert.equal(got[0].error.code, "http_429");
  assert.equal(got[0].error.retriable, true);
});

// ─── curated model catalog ─────────────────────────────────────────────

test("OLLAMA_CLOUD_MODELS exposes a non-empty curated list", () => {
  assert.ok(OLLAMA_CLOUD_MODELS.length >= 8, `expected >=8 models, got ${OLLAMA_CLOUD_MODELS.length}`);
  for (const m of OLLAMA_CLOUD_MODELS) {
    assert.ok(typeof m.id === "string" && m.id.length > 0);
    assert.ok(["reasoner", "apply", "summarize", "general"].includes(m.role));
    assert.ok(typeof m.hint === "string" && m.hint.length > 0);
  }
});

test("ollamaCloudModelsFor filters by role", () => {
  const reasoners = ollamaCloudModelsFor("reasoner");
  const appliers = ollamaCloudModelsFor("apply");
  const summarizers = ollamaCloudModelsFor("summarize");
  assert.ok(reasoners.length > 0, "expected at least one reasoner");
  assert.ok(appliers.length > 0, "expected at least one apply model");
  assert.ok(summarizers.length > 0, "expected at least one summarize model");
  assert.ok(reasoners.every((m) => m.role === "reasoner"));
});
