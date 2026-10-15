// C1 — the verified edit loop, engine contract:
//   1. Mid-turn drain: reminders that become ready while tools run reach the
//      model in the SAME turn, attached to the tool-results message.
//   2. Turn-end settle (confirmTurnEnd, durable children only): when the model
//      finishes, the host may settle an in-flight verifier run. Red verdicts
//      mark the turn blocked / needs_verification and are surfaced as
//      UNRESOLVED — they NEVER re-open the loop. The old "inject and keep the
//      turn alive" end gate was dropped on 2026-10-15 together with every other
//      end-of-turn re-verification push.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

/** A provider that plays back one scripted reply per call. */
function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "scripted",
    calls: [],
    async *stream(req) {
      const me = this;
      me.calls.push(req.messages.map((m) => m.content.map((b) => b.type).join("+")).join(" | "));
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        yield { type: "tool_use_start", id: `tu_${call}`, name: script.tool.name };
        yield { type: "tool_use_input_done", id: `tu_${call}`, input: script.tool.input };
        yield {
          type: "message_done",
          message: {
            id: `m_${call}`,
            role: "assistant",
            content: [{ type: "tool_use", id: `tu_${call}`, name: script.tool.name, input: script.tool.input }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
      } else {
        yield { type: "text_delta", text: script.text };
        yield {
          type: "message_done",
          message: {
            id: `m_${call}`,
            role: "assistant",
            content: [{ type: "text", text: script.text }],
            createdAt: new Date().toISOString(),
          },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "end_turn",
        };
      }
    },
  };
}

function editTool(touched) {
  return {
    schema: {
      name: "Edit",
      description: "fake edit",
      inputJsonSchema: { type: "object" },
      safety: "workspace-write",
    },
    async call() {
      return { output: "edited", touchedFiles: [touched] };
    },
  };
}

async function drain(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("C1 mid-turn drain: a reminder ready after a tool batch lands in the SAME turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  const pending = [];
  const provider = scriptedProvider([
    { tool: { name: "Edit", input: { file_path: "a.ts" } } },
    { text: "done" },
  ]);
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [
        {
          ...editTool(path.join(dir, "a.ts")),
          async call() {
            // The "verifier finished while tools ran" moment.
            pending.push({ text: "VERIFY RED: a.ts broke the typecheck", source: "verifier" });
            return { output: "edited", touchedFiles: [path.join(dir, "a.ts")] };
          },
        },
      ],
      workspace: dir,
      drainSystemReminders: () => pending.splice(0),
    },
    "sess_c1_mid",
  );
  engine.appendUserMessage("edit the file");
  const events = await drain(engine);

  const injected = events.filter((e) => e.type === "system_reminder_injected" && /VERIFY RED/.test(e.text));
  assert.equal(injected.length, 1, "the red verdict surfaced mid-turn");

  // It rode the tool-results user message, so the NEXT provider call saw it.
  assert.match(provider.calls.at(-1), /tool_result\+system_reminder/, "model saw tool_result + reminder together");
  await rm(dir, { recursive: true, force: true });
});

test("turn-end settle: a red confirmTurnEnd verdict marks the turn blocked WITHOUT re-opening the loop", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  // Three scripted replies are available; only the FIRST may ever be used.
  const provider = scriptedProvider([{ text: "done (1)" }, { text: "done (2)" }, { text: "done (3)" }]);
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      confirmTurnEnd: async () => {
        gateCalls++;
        return [{ text: "typecheck is still red on a.ts", source: "verifier" }];
      },
    },
    "sess_c1_settle_red",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);

  assert.equal(gateCalls, 1, "the settle hook runs exactly once, when the model finishes");
  assert.equal(provider.calls.length, 1, "the model is NOT sent back in to 'fix it before finishing'");
  assert.ok(
    !events.some((e) => e.type === "system_reminder_injected" && /^typecheck is still red/.test(e.text)),
    "the verdict is never injected as a system reminder into this turn",
  );
  const unresolved = events.filter((e) => e.type === "system_reminder_injected" && /UNRESOLVED at turn end/.test(e.text));
  assert.equal(unresolved.length, 1, "the red verdict is surfaced once, honestly");
  const end = events.find((e) => e.type === "turn_end");
  assert.equal(end.status, "needs_verification");
  assert.equal(end.workStatus, "blocked");
  assert.ok(end.unverified.missing.some((m) => /never resolved/.test(m)), "the gap rides the event structurally");
  assert.equal(engine.history().at(-1).role, "assistant", "history ends on the model's own message, not an engine push");
  await rm(dir, { recursive: true, force: true });
});

test("turn-end settle: a green confirmTurnEnd ends the turn completed in one round", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  let gateCalls = 0;
  const provider = scriptedProvider([{ text: "all done!" }, { text: "never reached" }]);
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      confirmTurnEnd: async () => {
        gateCalls++;
        return [];
      },
    },
    "sess_c1_settle_green",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);
  assert.equal(gateCalls, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(events.find((e) => e.type === "turn_end").status, "completed");
  assert.match(engine.history().at(-1).content[0].text, /all done/);
  await rm(dir, { recursive: true, force: true });
});

test("turn-end settle: a hook that throws is reported as unresolved, not retried", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  const provider = scriptedProvider([{ text: "done" }, { text: "never reached" }]);
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "scripted",
      systemPrompt: "s",
      tools: [],
      workspace: dir,
      confirmTurnEnd: async () => { throw new Error("spawn EACCES"); },
    },
    "sess_c1_settle_throw",
  );
  engine.appendUserMessage("do the thing");
  const events = await drain(engine);
  assert.equal(provider.calls.length, 1, "no re-run of the checks is demanded from the model");
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /UNRESOLVED at turn end.*spawn EACCES/.test(e.text)));
  assert.equal(events.find((e) => e.type === "turn_end").workStatus, "blocked");
  await rm(dir, { recursive: true, force: true });
});

test("C1 gate is skipped entirely when not configured (zero-cost default)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-c1-"));
  const provider = scriptedProvider([{ text: "done" }]);
  const engine = QueryEngine.forTesting(
    { provider, model: "scripted", systemPrompt: "s", tools: [], workspace: dir },
    "sess_c1_off",
  );
  engine.appendUserMessage("hi");
  const events = await drain(engine);
  assert.equal(events.find((e) => e.type === "turn_end").status, "completed");
  await rm(dir, { recursive: true, force: true });
});
