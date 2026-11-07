// Field report 2026-11-06: Ares sessions on Opus 5.5 started "auto-blocking" —
// Anthropic returned stop_reason: "refusal" on ordinary turns. The trigger was
// a security-flavored record surfacing through auto-recall (living memory / the
// Oricle pack / the advisory thought), not the user's own request. The engine
// now self-heals: on a refusal it strips the recalled-memory reminders and
// retries once. If there is nothing recalled to blame, it surfaces the refusal
// explanation instead of silently looping.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../packages/core/dist/index.js";

const SAFEGUARD = "Anthropic's safety safeguards stopped this reply.";

function refusalMessage() {
  return {
    type: "message_done",
    message: { id: "refused", role: "assistant", content: [{ type: "text", text: SAFEGUARD }], createdAt: new Date().toISOString() },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "refusal",
  };
}

function okMessage(text = "ok") {
  return {
    type: "message_done",
    message: { id: "ok", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

test("a refusal retries once with recalled memory stripped, and the retry goes through", async () => {
  const requests = [];
  let calls = 0;
  const provider = {
    name: "refuse-then-ok",
    async *stream(req) {
      calls++;
      requests.push(JSON.stringify(req.messages));
      if (calls === 1) { yield refusalMessage(); return; }
      yield { type: "text_delta", text: "the real answer" };
      yield okMessage("the real answer");
    },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-refusal-"));
  // One recalled-memory reminder rides the prompt — the kind auto-recall injects.
  const reminders = [{ text: "RECALLED: a poisoned fact about the owner's setup", source: "memory", key: "oricle" }];
  const session = new Session({
    workspace, provider, model: "claude-opus-5-5", systemPrompt: "s", tools: [], contextBudgetTokens: 0,
    drainSystemReminders: () => reminders.splice(0),
  });

  const events = [];
  for await (const e of session.send("make an agent")) events.push(e);

  assert.equal(calls, 2, "the turn was retried exactly once");
  assert.equal(events.at(-1)?.status, "completed", "the retried turn completes");
  // The first (refused) attempt carried the recalled memory; the retry did not.
  assert.match(requests[0], /poisoned fact/, "the first attempt carried the recalled memory");
  assert.doesNotMatch(requests[1], /poisoned fact/, "the retry stripped the recalled memory");
  // The user sees the real answer, never the safeguard line.
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.match(text, /the real answer/);
  assert.doesNotMatch(text, /safeguards stopped/, "the dead-end refusal text never reaches the user");
});

test("a refusal with no recalled memory to blame surfaces the explanation, no endless retry", async () => {
  let calls = 0;
  const provider = {
    name: "always-refuse",
    async *stream() { calls++; yield refusalMessage(); },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-refusal-bare-"));
  const session = new Session({
    workspace, provider, model: "claude-opus-5-5", systemPrompt: "s", tools: [], contextBudgetTokens: 0,
    drainSystemReminders: () => [],
  });

  const events = [];
  for await (const e of session.send("something the model itself declines")) events.push(e);

  assert.equal(calls, 1, "nothing to strip means no retry — the turn does not loop");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.match(text, /safeguards stopped/, "the explanation is surfaced when the refusal cannot be self-healed");
  assert.ok(["completed", "failed"].includes(events.at(-1)?.status), "the turn terminates");
});

test("a refusal that persists after the strip stops retrying and surfaces the explanation", async () => {
  let calls = 0;
  const provider = {
    name: "refuse-twice",
    async *stream() { calls++; yield refusalMessage(); },
  };
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-refusal-persist-"));
  const reminders = [{ text: "RECALLED: still poisoned", source: "memory", key: "recall" }];
  const session = new Session({
    workspace, provider, model: "claude-opus-5-5", systemPrompt: "s", tools: [], contextBudgetTokens: 0,
    drainSystemReminders: () => reminders.splice(0),
  });

  const events = [];
  for await (const e of session.send("make an agent")) events.push(e);

  assert.equal(calls, 2, "retried once after stripping, then gave up — never an infinite loop");
  const text = events.filter((e) => e.type === "text_delta").map((e) => e.text).join("");
  assert.match(text, /safeguards stopped/, "the explanation is surfaced once the retry budget is spent");
});
