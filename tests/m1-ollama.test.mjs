// M1.5 — OllamaCloudPool tests with mocked NDJSON streams.
//
// Covers single-stream parsing, per-slot serialization, cross-slot
// parallelism, and the apply()/summarize() one-shot helpers.

import test from "node:test";
import assert from "node:assert/strict";
import { OllamaCloudPool } from "../packages/core/dist/index.js";

function ndjsonStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
      }
      controller.close();
    },
  });
}

function mockChat(chunks, status = 200) {
  return async (_url, _init) =>
    new Response(ndjsonStream(chunks), {
      status,
      headers: { "content-type": "application/x-ndjson" },
    });
}

function captureChat(chunks, captured, status = 200) {
  return async (_url, init) => {
    captured.body = JSON.parse(init.body);
    return new Response(ndjsonStream(chunks), {
      status,
      headers: { "content-type": "application/x-ndjson" },
    });
  };
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

// ─── single stream ─────────────────────────────────────────────────────

test("OllamaCloudPool: normalizes bind hosts and missing URL schemes", () => {
  assert.equal(new OllamaCloudPool({ slots, host: "0.0.0.0" }).host, "http://127.0.0.1:11434");
  assert.equal(new OllamaCloudPool({ slots, host: "0.0.0.0:11555" }).host, "http://127.0.0.1:11555");
  assert.equal(new OllamaCloudPool({ slots, host: "localhost:11434" }).host, "http://localhost:11434");
});

test("OllamaCloudPool: thrown fetch errors become stream error events", async () => {
  const pool = new OllamaCloudPool({
    slots,
    host: "http://127.0.0.1:11434",
    fetchImpl: async () => {
      throw new TypeError("bad URL");
    },
    useAnthropicCompat: false,
  });
  const events = [];
  for await (const event of pool.stream("reasoner", baseReq)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error.message, /bad URL/);
});

test("OllamaCloudPool: parses text + tool_call from streaming NDJSON", async () => {
  const chunks = [
    { message: { role: "assistant", content: "Hel" }, done: false },
    { message: { role: "assistant", content: "lo " }, done: false },
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", function: { name: "Read", arguments: '{"file_path":"/x"}' } },
        ],
      },
      done: false,
    },
    { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 10, eval_count: 5 },
  ];
  const pool = new OllamaCloudPool({ slots, fetchImpl: mockChat(chunks) , useAnthropicCompat: false });

  const events = [];
  for await (const e of pool.stream("reasoner", baseReq)) events.push(e);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "text_delta",
    "text_delta",
    "tool_use_start",
    "tool_use_input_delta",
    "tool_use_input_done",
    "message_done",
  ]);
  const done = events.at(-1);
  assert.equal(done.message.role, "assistant");
  assert.equal(done.message.content[0].text, "Hello ");
  assert.equal(done.message.content[1].type, "tool_use");
  assert.equal(done.message.content[1].name, "Read");
  assert.deepEqual(done.message.content[1].input, { file_path: "/x" });
  assert.equal(done.usage.inputTokens, 10);
  assert.equal(done.usage.outputTokens, 5);
});

test("OllamaCloudPool: serializes every tool_result as its own tool message", async () => {
  const chunks = [
    { message: { role: "assistant", content: "done" }, done: false },
    { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 10, eval_count: 5 },
  ];
  const captured = {};
  const pool = new OllamaCloudPool({ slots, fetchImpl: captureChat(chunks, captured) , useAnthropicCompat: false });

  await consumeAll(pool.stream("reasoner", {
    ...baseReq,
    messages: [
      ...baseReq.messages,
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_a", name: "Read", input: { file_path: "/tmp/a" } },
          { type: "tool_use", id: "call_b", name: "Glob", input: { pattern: "*" } },
        ],
        createdAt: "now",
      },
      {
        id: "t1",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a", content: "A" },
          { type: "tool_result", tool_use_id: "call_b", content: "B" },
        ],
        createdAt: "now",
      },
    ],
  }));

  const assistantMessages = captured.body.messages.filter((m) => m.role === "assistant");
  assert.deepEqual(assistantMessages[0].tool_calls, [
    {
      type: "function",
      function: { index: 0, name: "Read", arguments: { file_path: "/tmp/a" } },
    },
    {
      type: "function",
      function: { index: 1, name: "Glob", arguments: { pattern: "*" } },
    },
  ]);
  const toolMessages = captured.body.messages.filter((m) => m.role === "tool");
  assert.deepEqual(toolMessages, [
    { role: "tool", tool_name: "Read", content: "A" },
    { role: "tool", tool_name: "Glob", content: "B" },
  ]);
});

// ─── per-slot serialization ────────────────────────────────────────────

test("OllamaCloudPool: per-slot single concurrency (serializes same-slot calls)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  // Each request takes ~50ms.
  const fetchImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 50));
    const body = ndjsonStream([
      { message: { content: "ok" }, done: false },
      { message: { content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    inFlight--;
    return new Response(body, { status: 200 });
  };
  const pool = new OllamaCloudPool({ slots, fetchImpl , useAnthropicCompat: false });

  // Three back-to-back REASONER calls should serialize → maxInFlight = 1.
  await Promise.all([
    consumeAll(pool.stream("reasoner", baseReq)),
    consumeAll(pool.stream("reasoner", baseReq)),
    consumeAll(pool.stream("reasoner", baseReq)),
  ]);
  assert.equal(maxInFlight, 1, "reasoner slot must serialize");
});

// ─── cross-slot parallelism ────────────────────────────────────────────

test("OllamaCloudPool: different slots run in parallel", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 50));
    const body = ndjsonStream([
      { message: { content: "ok" }, done: false },
      { message: { content: "" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    ]);
    inFlight--;
    return new Response(body, { status: 200 });
  };
  const pool = new OllamaCloudPool({ slots, fetchImpl , useAnthropicCompat: false });

  // REASONER + APPLY + SUMMARIZE concurrently → maxInFlight should hit 3.
  await Promise.all([
    consumeAll(pool.stream("reasoner", baseReq)),
    consumeAll(pool.stream("apply", baseReq)),
    consumeAll(pool.stream("summarize", baseReq)),
  ]);
  assert.equal(maxInFlight, 3, "3 different slots must run in parallel");
});

// ─── apply() helper ────────────────────────────────────────────────────

test("OllamaCloudPool.apply(): returns concatenated text", async () => {
  const chunks = [
    { message: { content: "final " }, done: false },
    { message: { content: "content" }, done: false },
    { message: { content: "" }, done: true, prompt_eval_count: 100, eval_count: 2 },
  ];
  const pool = new OllamaCloudPool({ slots, fetchImpl: mockChat(chunks) , useAnthropicCompat: false });
  const result = await pool.apply({
    file: "src/x.ts",
    original: "old",
    instructions: "do thing",
    sketch: "// ... existing code ...\nnew\n// ... existing code ...",
  });
  assert.equal(result, "final content");
});

// ─── summarize() helper ────────────────────────────────────────────────

test("OllamaCloudPool.summarize(): returns plain summary", async () => {
  const chunks = [
    { message: { content: "It says hello." }, done: false },
    { message: { content: "" }, done: true, prompt_eval_count: 200, eval_count: 4 },
  ];
  const pool = new OllamaCloudPool({ slots, fetchImpl: mockChat(chunks) , useAnthropicCompat: false });
  const result = await pool.summarize({ input: "long blob of text" });
  assert.equal(result, "It says hello.");
});

// ─── health / model discovery ──────────────────────────────────────────

test("OllamaCloudPool.health(): reports unreachable when host down", async () => {
  const pool = new OllamaCloudPool({
    slots,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const h = await pool.health();
  assert.equal(h.reachable, false);
  assert.equal(h.availableModels.length, 0);
  assert.equal(h.slots.length, 3);
  assert.equal(h.slots.every((s) => s.present === false), true);
});

test("OllamaCloudPool.health(): reports present-vs-missing models", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen3-coder:480b-cloud" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  const pool = new OllamaCloudPool({ slots, fetchImpl , useAnthropicCompat: false });
  const h = await pool.health();
  assert.equal(h.reachable, true);
  const reasoner = h.slots.find((s) => s.name === "reasoner");
  const apply = h.slots.find((s) => s.name === "apply");
  assert.equal(reasoner.present, true);
  assert.equal(apply.present, false);
});

// ─── helpers ───────────────────────────────────────────────────────────

async function consumeAll(gen) {
  for await (const _ of gen) {
    // noop
  }
}
