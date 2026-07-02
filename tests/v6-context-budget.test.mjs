// v6 context budgeting + chat tuning — proves a long thread can't hard-fail
// with context_length_exceeded, and that interactive chat passes a reasoning
// budget + output cap through to the provider (so a trivial "hi" can't hang
// for minutes on a reasoning model).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { budgetMessages, Session, stringifyModelToolOutput } from "../packages/core/dist/index.js";

function textMsg(role, chars, tag) {
  return {
    id: `m_${tag}`,
    role,
    content: [{ type: "text", text: "x".repeat(chars) }],
    createdAt: new Date().toISOString(),
  };
}

test("budget: oldest messages trim away, the pending message always survives", () => {
  // 5 messages ~1000 tokens each (4000 chars), budget 2500 tokens, no overhead.
  const msgs = [0, 1, 2, 3, 4].map((i) => textMsg(i % 2 ? "assistant" : "user", 4000, `${i}`));
  const { messages, trimmed } = budgetMessages(msgs, 2500, 0);
  assert.ok(trimmed >= 3, `expected to trim the bulk, trimmed ${trimmed}`);
  assert.ok(messages.length <= 2, `kept too many: ${messages.length}`);
  assert.equal(messages[messages.length - 1].id, "m_4", "the latest (pending) message must be kept");
});

test("budget: an under-budget thread is returned untouched", () => {
  const msgs = [textMsg("user", 40, "a"), textMsg("assistant", 40, "b")];
  const { messages, trimmed } = budgetMessages(msgs, 10_000, 0);
  assert.equal(trimmed, 0);
  assert.equal(messages.length, 2);
});

test("budget: never leaves a leading orphan tool_result", () => {
  const msgs = [
    textMsg("user", 4000, "task"),
    { id: "m_call", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }, { type: "text", text: "x".repeat(3600) }], createdAt: new Date().toISOString() },
    { id: "m_result", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(3600) }], createdAt: new Date().toISOString() },
    textMsg("user", 200, "final"),
  ];
  const { messages } = budgetMessages(msgs, 1500, 0);
  // The kept window must not begin with a tool_result (would orphan into a
  // function_call_output with no preceding call).
  const first = messages[0];
  const leadsWithToolResult = first.role === "user" && first.content[0]?.type === "tool_result";
  assert.equal(leadsWithToolResult, false, "kept window must not start with a tool_result");
  assert.equal(messages[messages.length - 1].id, "m_final");
});

test("chat tuning: reasoningLevel + maxOutputTokens reach the provider", async () => {
  let captured = null;
  const provider = {
    name: "capture",
    async *stream(req) {
      captured = req;
      yield {
        type: "message_done",
        message: { id: "a1", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-budget-"));
  const session = new Session({
    workspace,
    provider,
    model: "test-model",
    systemPrompt: "s",
    tools: [],
    reasoningLevel: "high",
    maxOutputTokens: 1234,
    contextBudgetTokens: 0,
  });
  // A substantive ask so the adaptive router keeps the configured ceiling — this
  // test verifies the dial PLUMBS THROUGH; the router's downshift logic has its
  // own coverage in reasoning-router.test.mjs.
  for await (const _event of session.send("Refactor the auth module to add a token refresh path and cover it with tests")) {
    void _event;
  }
  assert.ok(captured, "provider should have been called");
  assert.equal(captured.reasoningLevel, "high");
  assert.equal(captured.maxOutputTokens, 1234);
});

test("chat tuning: setReasoningLevel updates the dial live", async () => {
  const levels = [];
  const provider = {
    name: "capture",
    async *stream(req) {
      levels.push(req.reasoningLevel);
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-reason-"));
  const session = new Session({ workspace, provider, model: "m", systemPrompt: "s", tools: [], reasoningLevel: "low", contextBudgetTokens: 0 });
  // Substantive asks so the adaptive router preserves the configured level and
  // this stays a pure plumbing test for setReasoningLevel.
  for await (const _e of session.send("Please implement a debounce utility and unit-test it")) void _e;
  session.setReasoningLevel("max");
  for await (const _e of session.send("Now design a retry policy for the HTTP client with backoff")) void _e;
  assert.deepEqual(levels, ["low", "max"]);
});

test("chat tuning: setProvider updates the live context budget", async () => {
  const captured = [];
  const provider = (name) => ({
    name,
    async *stream(req) {
      captured.push({ name, count: req.messages.length, model: req.model });
      yield {
        type: "message_done",
        message: { id: `a_${name}`, role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  });
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-model-context-"));
  const session = new Session({
    workspace,
    provider: provider("small"),
    model: "small-model",
    systemPrompt: "s",
    tools: [],
    initialMessages: Array.from({ length: 8 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 4_000, `switch_${i}`)),
    contextBudgetTokens: 1_500,
    compactionThresholdTokens: 1_000_000,
  });

  for await (const _event of session.send("one")) void _event;
  await session.setProvider(provider("large"), "large-model", {
    contextBudgetTokens: 100_000,
    compactionThresholdTokens: 1_000_000,
  });
  for await (const _event of session.send("two")) void _event;

  assert.equal(captured[0].name, "small");
  assert.equal(captured[1].name, "large");
  assert.equal(captured[1].model, "large-model");
  assert.ok(captured[1].count > captured[0].count, "larger model budget should restore more history");
});

test("chat tuning: context-limit errors retry with a smaller recent-history window", async () => {
  const callMessageCounts = [];
  const provider = {
    name: "context-limit-on-history",
    async *stream(req) {
      callMessageCounts.push(req.messages.length);
      if (req.messages.length > 1) {
        yield {
          type: "error",
          error: { code: "http_400", message: "prompt too long; exceeded max context length", retriable: false },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "a", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-context-retry-"));
  const oldMessages = Array.from({ length: 10 }, (_, i) => textMsg(i % 2 ? "assistant" : "user", 20_000, `old_${i}`));
  const session = new Session({
    workspace,
    provider,
    model: "m",
    systemPrompt: "s",
    tools: [],
    initialMessages: oldMessages,
    contextBudgetTokens: 100_000,
  });

  const events = [];
  for await (const event of session.send("final")) events.push(event);

  assert.ok(callMessageCounts.length > 1, "provider should be retried after context rejection");
  assert.equal(callMessageCounts.at(-1), 1, "final retry should keep only the pending user message");
  assert.equal(events.some((event) => event.type === "error"), false, "transient context errors should not surface as final errors");
  assert.equal(events.at(-1)?.type, "turn_end");
  assert.equal(events.at(-1)?.status, "completed");
});

test("chat tuning: tool results are bounded before entering model context", () => {
  const result = stringifyModelToolOutput("x".repeat(40_000));
  assert.ok(result.length < 25_000, "model-facing tool result should be clipped");
  assert.match(result, /tool result truncated/);
});
