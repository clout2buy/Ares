// The opencode reminder doctrine: remind on TRANSITION, stay silent on
// standing state. A turn that did no coding work must not inherit an old
// objective's verification nag — and its status is not_applicable, because
// statuses describe turns, not the journal's standing debt.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

function chattyProvider(text) {
  return {
    name: "chat-scripted",
    async *stream() {
      yield { type: "text_delta", text };
      yield {
        type: "message_done",
        message: { id: "m1", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

test("a chat-only turn with standing journal debt gets NO verification nag and ends not_applicable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = QueryEngine.forTesting({
    provider: chattyProvider("You serve it over http://localhost — file:// won't work for WebGPU."),
    model: "scripted",
    systemPrompt: "chat",
    tools: [],
    workspace: root,
    // Standing debt from a PRIOR turn's objective (the persisted journal).
    outstandingVerificationRequired: () => true,
    persistedVerificationDebt: () => true,
    persistedVerificationScopeComplete: () => true,
  }, "sess_transition_chat");
  engine.appendUserMessage("do i serve it for webgpu to work?");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);

  const nags = events.filter((e) =>
    e.type === "system_reminder_injected" &&
    /behavior-capable verifier run|UNVERIFIED at turn end|re-open the task spec/i.test(e.text));
  assert.equal(nags.length, 0, `chat turn must not be nagged, got: ${nags.map((n) => n.text.slice(0, 60)).join(" | ")}`);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.equal(end.workStatus, "not_applicable", "a turn that did no coding work makes no claims to verify");
});

test("a turn that DOES mutate ends on its first 'done' too — honest workStatus, no push", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-transition-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "a.ts");
  let call = 0;
  const provider = {
    name: "work-scripted",
    async *stream() {
      if (call++ === 0) {
        const id = "t1";
        yield { type: "tool_use_start", id, name: "Edit" };
        yield { type: "tool_use_input_done", id, input: { file_path: "a.ts" } };
        yield {
          type: "message_done",
          message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id, name: "Edit", input: { file_path: "a.ts" } }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield {
        type: "message_done",
        message: { id: `m${call}`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  const engine = QueryEngine.forTesting({
    provider,
    model: "scripted",
    systemPrompt: "code",
    tools: [{
      schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
      async call() { return { output: "edited", touchedFiles: [file] }; },
    }],
    workspace: root,
  }, "sess_transition_work");
  engine.appendUserMessage("change a.ts");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  // Since 2026-10-15 there is no proof-gate push at all: the mutating turn
  // ends on the model's first "done" with honest telemetry and no nag.
  assert.ok(
    !events.some((e) => e.type === "system_reminder_injected" && /behavior-capable verifier run|UNVERIFIED at turn end/i.test(e.text)),
    "no proof-gate push re-opens a mutating turn either",
  );
  assert.equal(call, 2, "edit round + one completion round");
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "unverified");
});
