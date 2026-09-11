// A credit-shaped 402 should shrink max_tokens to fit and retry, not die.
//
// Field dead-end (2026-09-11): a session pinned to opus-5 hit its Anthropic
// usage window, failed over onto a nearly-empty OpenRouter key, and got:
//
//   OpenRouter 402: "You requested up to 32768 tokens, but can only afford
//   10033. ... lower max_tokens / prompt size to fit your remaining balance."
//
// Every Claude-class session asks for a flat 32768 output tokens, so the
// fallback could never afford it and the turn died with nothing tried — while
// other sessions (smaller, or on a different model) worked fine, which is what
// made it look like an account problem when it was a per-request-size one.
//
// The provider states what it CAN afford; shrinking to it and retrying once
// turns a dead turn into a shorter reply.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenRouterProvider, affordableMaxTokens } from "../packages/core/dist/providers/openrouter.js";

function sse(chunks) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const OK = [
  { choices: [{ delta: { content: "ok" }, index: 0 }] },
  { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
];

function recordingFetch(responder) {
  const sent = [];
  return { impl: async (_u, init) => { const b = JSON.parse(init.body); sent.push(b); return responder(b, sent.length); }, sent };
}
function provider(fetchImpl) {
  return new OpenRouterProvider({ apiKey: "k", model: "k3", baseUrl: "https://api.kimi.com/coding/v1", providerName: "kimi", fetchImpl });
}
async function drain(gen) { const e = []; for await (const x of gen) e.push(x); return e; }

const REQ = {
  system: "s",
  messages: [{ id: "m", role: "user", content: [{ type: "text", text: "hi" }], createdAt: "" }],
  tools: [],
  maxOutputTokens: 32768,
};

const CREDIT_402 = JSON.stringify({
  error: { message: "This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford 10033.", code: 402 },
});

test("parses the affordable amount out of the 402 body", () => {
  assert.equal(affordableMaxTokens(CREDIT_402), 10033);
  assert.equal(affordableMaxTokens("no number here"), null);
  assert.equal(affordableMaxTokens("can only afford 0"), null);
});

test("a credit 402 shrinks max_tokens under the affordable amount and retries", async () => {
  const { impl, sent } = recordingFetch((_b, n) => (n === 1 ? new Response(CREDIT_402, { status: 402 }) : sse(OK)));
  const events = await drain(provider(impl).stream(REQ));

  assert.equal(sent.length, 2, "one shrink-and-retry");
  assert.equal(sent[0].max_tokens, 32768, "first attempt asked for the full budget");
  assert.ok(sent[1].max_tokens <= 10033, `retry must fit the affordable amount, got ${sent[1].max_tokens}`);
  assert.ok(sent[1].max_tokens >= 256, "but still enough to be worth sending");
  assert.ok(!events.some((e) => e.type === "error"), "the turn survives");
});

test("with no stated amount it halves and retries", async () => {
  const vague = JSON.stringify({ error: { message: "insufficient credits", code: 402 } });
  const { impl, sent } = recordingFetch((_b, n) => (n === 1 ? new Response(vague, { status: 402 }) : sse(OK)));
  await drain(provider(impl).stream(REQ));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].max_tokens, 16384, "halved from 32768");
});

test("it retries only once — a second 402 is reported, not looped", async () => {
  const { impl, sent } = recordingFetch(() => new Response(CREDIT_402, { status: 402 }));
  const events = await drain(provider(impl).stream(REQ));
  assert.equal(sent.length, 2, "shrink once, then give up");
  assert.ok(events.some((e) => e.type === "error"), "the real 402 surfaces if the shrink still can't afford it");
});

test("a 402 that cannot be shrunk usefully is reported rather than retried into the floor", async () => {
  // Affordable amount below the 256 floor: there is no point retrying.
  const tiny = JSON.stringify({ error: { message: "can only afford 12", code: 402 } });
  const { impl, sent } = recordingFetch(() => new Response(tiny, { status: 402 }));
  const events = await drain(provider(impl).stream(REQ));
  assert.equal(sent.length, 1, "no retry when the affordable amount is uselessly small");
  assert.ok(events.some((e) => e.type === "error"));
});

test("the retry keeps everything else identical — only max_tokens moves", async () => {
  const { impl, sent } = recordingFetch((_b, n) => (n === 1 ? new Response(CREDIT_402, { status: 402 }) : sse(OK)));
  await drain(provider(impl).stream({ ...REQ, system: "keep me", reasoningLevel: "high" }));
  assert.equal(sent[0].system, sent[1].system, "system prompt unchanged");
  assert.deepEqual(sent[0].messages, sent[1].messages, "history unchanged");
});
