// Act-first tool forcing must never be the thing that kills a turn.
//
// Field transcript, mid-task on a live remote-admin job:
//
//   Kimi returned 400: {"error":{"message":"tool_choice 'specified' is
//   incompatible with thinking enabled","type":"invalid_request_error"}}
//   failed · 1.5s · 0 calls
//
// The turn died outright and the owner had to switch models by hand. anthropic.ts
// has guarded this since it was written -- its comment even says "Anthropic
// disallows it with extended thinking" -- but this path (Kimi, DeepSeek,
// OpenRouter and every other OpenAI-compat endpoint) had no equivalent, so the
// same complaint was fatal instead of survivable.
//
// Dropping the forcing costs one nudge toward acting. Failing the turn costs
// the turn. Reasoning is kept: it is the more valuable half and the only one
// the owner chose deliberately.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterProvider, isForcedToolChoice } from "../packages/core/dist/providers/openrouter.js";

function sseResponse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const OK_STREAM = [
  { choices: [{ delta: { content: "done" }, index: 0 }] },
  { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
];

/** Records every request body the provider sends. */
function recordingFetch(responder) {
  const sent = [];
  const impl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return responder(body, sent.length);
  };
  return { impl, sent };
}

function providerWith(fetchImpl) {
  return new OpenRouterProvider({
    apiKey: "test-key",
    model: "k3",
    baseUrl: "https://api.kimi.com/coding/v1",
    providerName: "kimi",
    fetchImpl,
  });
}

async function drain(gen) {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const REQ = {
  system: "sys",
  messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], createdAt: "" }],
  tools: [{ name: "Read", description: "read", input_schema: { type: "object", properties: {} } }],
  toolChoice: { name: "Read" },
  reasoningLevel: "high",
};

test("a 400 naming tool_choice is retried once WITHOUT it, instead of failing the turn", async () => {
  const { impl, sent } = recordingFetch((_body, n) => {
    if (n === 1) {
      return new Response(
        JSON.stringify({ error: { message: "tool_choice 'specified' is incompatible with thinking enabled", type: "invalid_request_error" } }),
        { status: 400 },
      );
    }
    return sseResponse(OK_STREAM);
  });

  const events = await drain(providerWith(impl).stream(REQ));

  assert.equal(sent.length, 2, "exactly one retry");
  assert.ok(sent[0].tool_choice !== undefined, "first attempt carried the forcing");
  assert.equal(sent[1].tool_choice, undefined, "retry dropped it");
  assert.ok(!events.some((e) => e.type === "error"), `turn survived: ${JSON.stringify(events.filter((e) => e.type === "error"))}`);
});

test("the retry keeps reasoning — the half the owner actually chose", async () => {
  const { impl, sent } = recordingFetch((_b, n) =>
    n === 1 ? new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }) : sseResponse(OK_STREAM),
  );
  await drain(providerWith(impl).stream(REQ));

  const first = JSON.stringify(sent[0]);
  const retry = JSON.stringify(sent[1]);
  assert.ok(/reasoning/.test(first), "precondition: reasoning was requested");
  assert.ok(/reasoning/.test(retry), "reasoning must survive the retry");
  assert.ok(sent[1].tools, "the tools themselves are still offered — only the FORCING is dropped");
});

test("it retries only once — a second 400 is a real error, not a loop", async () => {
  const { impl, sent } = recordingFetch(() =>
    new Response(JSON.stringify({ error: { message: "still no" } }), { status: 400 }),
  );
  const events = await drain(providerWith(impl).stream(REQ));

  assert.equal(sent.length, 2, "one retry, then give up");
  assert.ok(events.some((e) => e.type === "error"), "the real failure is reported, not swallowed");
});

test("a 400 on a request with NO tool_choice is reported immediately", async () => {
  const { impl, sent } = recordingFetch(() =>
    new Response(JSON.stringify({ error: { message: "context too long" } }), { status: 400 }),
  );
  const events = await drain(providerWith(impl).stream({ ...REQ, toolChoice: undefined }));

  assert.equal(sent.length, 1, "nothing to strip, so nothing to retry");
  assert.ok(events.some((e) => e.type === "error"));
});

test("non-400 failures are untouched by this path", async () => {
  for (const status of [401, 429, 500]) {
    const { impl, sent } = recordingFetch(() => new Response("nope", { status }));
    const events = await drain(providerWith(impl).stream(REQ));
    assert.equal(sent.length, 1, `${status} must not trigger a tool_choice retry`);
    assert.ok(events.some((e) => e.type === "error"), `${status} surfaces as an error`);
  }
});

test("a successful first attempt keeps the forcing — the retry is not eager", async () => {
  const { impl, sent } = recordingFetch(() => sseResponse(OK_STREAM));
  await drain(providerWith(impl).stream(REQ));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].tool_choice !== undefined, "forcing is still applied when the endpoint accepts it");
});

test("only real FORCING is retried away — not the default, not a deliberate 'none'", () => {
  // "auto" is what an absent choice maps to, so it cannot be what the endpoint
  // objected to. "none" is a deliberate suppression a retry must not undo.
  assert.equal(isForcedToolChoice("auto"), false);
  assert.equal(isForcedToolChoice("none"), false);
  assert.equal(isForcedToolChoice(undefined), false);
  assert.equal(isForcedToolChoice(null), false);

  assert.equal(isForcedToolChoice("required"), true);
  assert.equal(isForcedToolChoice({ type: "function", function: { name: "Read" } }), true);
});

test("a 'none' suppression survives a 400 rather than being silently re-enabled", async () => {
  const { impl, sent } = recordingFetch(() =>
    new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 }),
  );
  await drain(providerWith(impl).stream({ ...REQ, toolChoice: "none" }));
  assert.equal(sent.length, 1, "no retry: dropping 'none' would let the model call tools it was denied");
});
