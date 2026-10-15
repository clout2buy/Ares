// No end-of-turn re-verification. These tests used to pin the GUI
// ground-truth gate and the spec-checklist gate (the BeanBrawl grey-screen
// lesson). On 2026-10-15 the owner dropped every re-verification push after a
// field session re-tested each deliverable three to four times unprompted, a
// README latched on as a "spec" for the whole session, and the agent flopped
// in front of an audience. The engine now:
//   1. never pushes "take a fresh screenshot" or "re-open the spec" after the
//      model has finished — the turn ends on the model's first completion;
//   2. still records the truth in telemetry: GUI work without visual proof
//      ends workStatus "unverified" / status "needs_verification", and a
//      screenshot newer than the mutation lifts the GUI block;
//   3. no longer treats a .md Read as a spec (CodingJournal has no spec docs).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine, CodingJournal } from "../packages/core/dist/index.js";

const now = () => new Date().toISOString();

/** Provider that emits one scripted tool call per round, then tries to end
 *  every round after the script is exhausted. `rounds` counts provider calls. */
function scriptedProvider(calls) {
  let r = 0;
  const provider = {
    name: "scripted",
    get rounds() { return r; },
    async *stream() {
      const i = r++;
      const call = calls[i];
      if (!call) {
        yield { type: "message_done", message: { id: `end${i}`, role: "assistant", content: [{ type: "text", text: "done" }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
        return;
      }
      const id = `t${i}`;
      yield { type: "tool_use_start", id, name: call.name };
      yield { type: "tool_use_input_done", id, input: call.input };
      yield { type: "message_done", message: { id: `a${i}`, role: "assistant", content: [{ type: "tool_use", id, name: call.name, input: call.input }], createdAt: now() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
    },
  };
  return provider;
}

const sceneEditTool = {
  schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
  async call() { return { output: "edited", touchedFiles: ["D:/game/scenes/Main.tscn"] }; },
};

const computerUseTool = {
  schema: { name: "ComputerUse", description: "desktop", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "exclusive" },
  async call() { return { output: { ok: true, screenshotPath: "shot.png" } }; },
};

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

function makeEngine(provider, tools, extraCfg = {}) {
  const engine = QueryEngine.forTesting(
    {
      provider,
      model: "test",
      systemPrompt: "t",
      tools,
      workspace: "D:\\Ares",
      // Test fixture for a provider manifest with match.files=["*.tscn"]. Core
      // itself intentionally knows no engine/editor extensions.
      environmentArtifactSignals: ({ touchedFiles = [] }) => {
        const file = touchedFiles.find((candidate) => /\.tscn$/i.test(candidate));
        return file ? [`provider:test.scene:file:${path.basename(file)}`] : [];
      },
      ...extraCfg,
    },
    "sess_gui",
  );
  engine.appendUserMessage("build the game");
  return engine;
}

const verifierPush = (e) =>
  e.type === "system_reminder_injected" &&
  /WINDOWED app artifact|GUI-UNVERIFIED|re-open the task spec|behavior-capable verifier run|UNVERIFIED at turn end/.test(e.text);

test("no re-verification: a GUI edit without a screenshot ends on the first 'done' — no push, no marker", async () => {
  const provider = scriptedProvider([{ name: "Edit", input: { file_path: "Main.tscn" } }]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));

  assert.equal(provider.rounds, 2, "edit round + one completion round; the engine never re-opened the turn");
  assert.ok(!events.some(verifierPush), "no screenshot/spec/proof push of any kind");
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "needs_verification", "telemetry stays honest");
  assert.equal(end.workStatus, "unverified", "GUI work without visual proof is recorded as unverified");
  assert.ok(end.unverified.missing.some((m) => /screenshot/.test(m)), "the structural gap still names the missing screenshot");
});

test("no re-verification: a screenshot newer than the mutation lifts the GUI block in telemetry", async () => {
  const provider = scriptedProvider([
    { name: "Edit", input: { file_path: "Main.tscn" } },
    { name: "ComputerUse", input: { action: "screenshot" } },
  ]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));
  assert.equal(provider.rounds, 3);
  assert.ok(!events.some(verifierPush));
  const end = events.findLast((e) => e.type === "turn_end");
  assert.ok(!(end.unverified?.missing ?? []).some((m) => /screenshot/.test(m)), "fresh pixels settle the GUI part of the gap");
});

test("no re-verification: a screenshot taken BEFORE the last mutation still counts as missing, silently", async () => {
  const provider = scriptedProvider([
    { name: "ComputerUse", input: { action: "screenshot" } },
    { name: "Edit", input: { file_path: "Main.tscn" } },
  ]);
  const events = await collect(makeEngine(provider, [sceneEditTool, computerUseTool]));
  assert.equal(provider.rounds, 3);
  assert.ok(!events.some(verifierPush), "stale screenshot → no push either");
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "unverified");
});

test("CodingJournal: a .md Read is NOT recorded as a spec and the reminder carries no spec line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-specdocs-"));
  const journal = await CodingJournal.open({ workspace: root, sessionId: "sess_spec" });
  journal.beginTurn("Build the game described in the task markdown");
  journal.recordTurnEvent({ type: "tool_start", id: "r1", name: "Read", input: { file_path: path.join(root, "task", "README.md") }, activityDescription: "" });
  assert.equal(typeof journal.specDocsForCurrentTurn, "undefined", "the spec-doc surface is gone");
  assert.doesNotMatch(journal.renderReminder(), /spec docs/i, "no 'completion is diffed against these' line");
  assert.doesNotMatch(journal.renderReminder(), /verification command is required/i, "no overflow verification demand");
  await journal.flush();
  await rm(root, { recursive: true, force: true });
});
