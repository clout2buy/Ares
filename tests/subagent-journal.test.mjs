// Subagent flight recorder + structured handoff (subagentJournal.ts).
//
// The teardown gap: a subagent run returned only its final prose — the parent
// had no structured record of what the child actually DID. These tests lock:
//   - the journal is fed from engine events (tool_start/tool_end/tool_error),
//     bounded (~50 entries), and flushed to disk incrementally (crash evidence);
//   - the runner's result carries a compact structured handoff AND renders it
//     into the summary the parent model sees;
//   - a journal persistence failure NEVER fails the subagent run.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AresSubagentRunner,
  SubagentRegistry,
  SubagentJournal,
  renderSubagentHandoff,
} from "../packages/core/dist/index.js";
import { ReadTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

const makeTmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-journal-"));

// ─── Unit: SubagentJournal ─────────────────────────────────────────────────────

function start(id, name, activity) {
  return { type: "tool_start", id, name, input: {}, activityDescription: activity };
}
function end(id, touchedFiles) {
  return { type: "tool_end", id, output: {}, touchedFiles, durationMs: 5 };
}

test("journal: records tool sequence, files, commands, errors into the handoff", async () => {
  const tmp = await makeTmp();
  const j = new SubagentJournal(path.join(tmp, "agents", "a1"), { id: "a1", type: "t", description: "d" });

  j.record(start("t1", "Read", "Read src/a.ts"));
  j.record(end("t1", []));
  j.record(start("t2", "Bash", "Run npm test"));
  j.record(end("t2", []));
  j.record(start("t3", "Edit", "Edit src/a.ts"));
  j.record(end("t3", [path.join(tmp, "src", "a.ts")]));
  j.record(start("t4", "Write", "Write src/b.ts"));
  j.record({ type: "tool_error", id: "t4", error: "EACCES: permission denied", durationMs: 3 });

  const h = await j.finish("completed");
  assert.equal(h.outcome, "completed");
  assert.equal(h.toolCalls, 4);
  assert.equal(h.commandsRun, 1, "only Bash/PowerShell count as commands");
  assert.deepEqual(h.filesTouched, [path.join(tmp, "src", "a.ts")]);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /Write: EACCES/);
  assert.ok(h.journalPath.endsWith("journal.json"));

  const onDisk = JSON.parse(await fs.readFile(h.journalPath, "utf8"));
  assert.equal(onDisk.entries.length, 4);
  assert.equal(onDisk.entries[0].ok, true);
  assert.equal(onDisk.entries[3].ok, false, "errored call marked not-ok on disk");
});

test("journal: bounded to the last 50 entries (flight recorder, not transcript)", async () => {
  const tmp = await makeTmp();
  const j = new SubagentJournal(path.join(tmp, "a2"), { id: "a2", type: "t", description: "d" });
  for (let i = 0; i < 60; i++) {
    j.record(start(`t${i}`, "Read", `Read file-${i}.ts`));
    j.record(end(`t${i}`, []));
  }
  const h = await j.finish("completed");
  assert.equal(h.toolCalls, 60, "the COUNT keeps the truth even when entries roll");
  const onDisk = JSON.parse(await fs.readFile(h.journalPath, "utf8"));
  assert.equal(onDisk.entries.length, 50);
  assert.equal(onDisk.dropped, 10);
  assert.match(onDisk.entries[0].target, /file-10/, "oldest entries rolled off");
});

test("journal: in-flight entry hits disk BEFORE the tool ends (crash evidence)", async () => {
  const tmp = await makeTmp();
  const j = new SubagentJournal(path.join(tmp, "a3"), { id: "a3", type: "t", description: "d" });
  j.record(start("t1", "Bash", "Run rm -rf ./dist"));
  await j.flushed();
  const onDisk = JSON.parse(await fs.readFile(j.journalPath, "utf8"));
  assert.equal(onDisk.outcome, "running");
  assert.equal(onDisk.entries.length, 1);
  assert.equal(onDisk.entries[0].ok, undefined, "in-flight = no verdict yet — exactly what a crash leaves behind");
  assert.match(onDisk.entries[0].target, /rm -rf/);
});

test("journal: max_turns_exceeded maps to a 'turn-limit' outcome", async () => {
  const tmp = await makeTmp();
  const j = new SubagentJournal(path.join(tmp, "a4"), { id: "a4", type: "t", description: "d" });
  j.record({ type: "error", error: { code: "max_turns_exceeded", message: "exceeded 2 turn iterations", retriable: false } });
  const h = await j.finish("failed");
  assert.equal(h.outcome, "turn-limit");
});

test("journal: unwritable directory degrades to journalPath '' — never throws", async () => {
  const tmp = await makeTmp();
  const blocker = path.join(tmp, "blocked");
  await fs.writeFile(blocker, "a file where the journal dir should go", "utf8");
  const j = new SubagentJournal(path.join(blocker, "a5"), { id: "a5", type: "t", description: "d" });
  j.record(start("t1", "Read", "Read x"));
  j.record(end("t1", []));
  const h = await j.finish("completed");
  assert.equal(h.journalPath, "", "persistence failure surfaces as an empty path, not a crash");
  assert.equal(h.toolCalls, 1, "in-memory accounting still intact");
});

test("handoff render: compact (≤700 chars) and carries the load-bearing facts", () => {
  const rendered = renderSubagentHandoff({
    outcome: "error",
    filesTouched: Array.from({ length: 20 }, (_, i) => `src/very/long/path/module-${i}.ts`),
    commandsRun: 7,
    toolCalls: 42,
    errors: ["Bash: exit 1 — tests failed", "Edit: old_string not found"],
    journalPath: "C:\\ws\\.ares\\agents\\a\\journal.json",
  });
  assert.ok(rendered.length <= 700, `rendered handoff stays compact (${rendered.length} chars)`);
  assert.match(rendered, /outcome: error/);
  assert.match(rendered, /tool calls: 42/);
  assert.match(rendered, /commands run: 7/);
  assert.match(rendered, /\(\+12 more\)/, "file list truncates, count survives");
  assert.match(rendered, /old_string not found/);
  assert.match(rendered, /journal\.json/);
});

// ─── Integration: AresSubagentRunner wiring ────────────────────────────────────

// One Read tool call, then a clean finish (same pattern as v24).
class WholeFileReadProvider {
  constructor(file) {
    this.file = file;
    this.name = "wholefile-read";
  }
  async *stream(req) {
    const hasToolResult = req.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    if (!hasToolResult) {
      const id = "rd";
      yield { type: "tool_use_start", id, name: "Read" };
      yield { type: "tool_use_input_done", id, input: { file_path: this.file } };
      yield {
        type: "message_done",
        message: { id: "m_read", role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: this.file } }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "tool_use",
      };
    } else {
      yield {
        type: "message_done",
        message: { id: "m_done", role: "assistant", content: [{ type: "text", text: "read complete" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 0 },
        stopReason: "end_turn",
      };
    }
  }
}

// Never stops asking for tools — forces the maxTurns ceiling.
class EndlessToolProvider {
  constructor(file) {
    this.file = file;
    this.name = "endless";
    this.n = 0;
  }
  async *stream() {
    const id = `rd${this.n++}`;
    yield { type: "tool_use_start", id, name: "Read" };
    yield { type: "tool_use_input_done", id, input: { file_path: this.file } };
    yield {
      type: "message_done",
      message: { id: `m${this.n}`, role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: this.file } }], createdAt: new Date().toISOString() },
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: "tool_use",
    };
  }
}

const readTool = adaptToolForEngine(ReadTool, (base) => ({
  ...base,
  permissionMode: "bypass",
  fileReadStamps: base.fileReadStamps,
}));

function makeRunner(provider) {
  const registry = new SubagentRegistry([
    { name: "reader", description: "reads a file", systemPrompt: "Read the file.", toolWhitelist: ["Read"], maxTurns: 3 },
  ]);
  return new AresSubagentRunner({
    registry,
    provider,
    model: "mock",
    parentTools: [readTool],
    baseSystemPrompt: "base",
  });
}

test("runner: result carries a structured handoff + renders it into the summary", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "a.ts");
  await fs.writeFile(file, "const a = 1;\n", "utf8");

  const r = await makeRunner(new WholeFileReadProvider(file)).run({
    subagent_type: "reader", description: "read a", prompt: "read", workspace: tmp,
  });

  assert.equal(r.status, "completed");
  assert.equal(r.handoff.outcome, "completed");
  assert.equal(r.handoff.toolCalls, 1);
  assert.equal(r.handoff.commandsRun, 0);
  assert.deepEqual(r.handoff.errors, []);
  assert.equal(r.handoff.journalPath, path.join(path.dirname(r.transcriptPath), "journal.json"),
    "journal lives next to the transcript under .ares/agents/<id>/");
  assert.match(r.summary, /read complete/, "the child's prose survives");
  assert.match(r.summary, /subagent handoff/, "…and the flight-recorder facts ride alongside it");
  assert.match(r.summary, /outcome: completed/);

  const onDisk = JSON.parse(await fs.readFile(r.handoff.journalPath, "utf8"));
  assert.equal(onDisk.id, r.id);
  assert.equal(onDisk.outcome, "completed");
  assert.equal(onDisk.entries.length, 1);
  assert.equal(onDisk.entries[0].tool, "Read");
});

test("runner: a failing tool lands in handoff.errors — the parent sees the truth", async () => {
  const tmp = await makeTmp();
  const missing = path.join(tmp, "does-not-exist.ts");
  const r = await makeRunner(new WholeFileReadProvider(missing)).run({
    subagent_type: "reader", description: "read missing", prompt: "read", workspace: tmp,
  });
  assert.equal(r.handoff.toolCalls, 1);
  assert.equal(r.handoff.errors.length, 1);
  assert.match(r.handoff.errors[0], /^Read: /);
  assert.match(r.summary, /recent errors:/);
});

test("runner: exhausting maxTurns yields outcome 'turn-limit', not a vague error", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "loop.ts");
  await fs.writeFile(file, "const loop = 1;\n", "utf8");
  const r = await makeRunner(new EndlessToolProvider(file)).run({
    subagent_type: "reader", description: "loop", prompt: "read forever", workspace: tmp,
  });
  assert.equal(r.status, "failed");
  assert.equal(r.handoff.outcome, "turn-limit");
  assert.ok(r.handoff.toolCalls >= 1);
});

test("runner: journal persistence failure never fails the run", async () => {
  const tmp = await makeTmp();
  const file = path.join(tmp, "b.ts");
  await fs.writeFile(file, "const b = 2;\n", "utf8");
  // Block <workspace>/.ares entirely — journal, meta and transcript writes all fail.
  await fs.writeFile(path.join(tmp, ".ares"), "not a directory", "utf8");

  const r = await makeRunner(new WholeFileReadProvider(file)).run({
    subagent_type: "reader", description: "read b", prompt: "read", workspace: tmp,
  });
  assert.equal(r.status, "completed", "the run itself is untouched");
  assert.equal(r.handoff.outcome, "completed");
  assert.equal(r.handoff.journalPath, "", "unpersistable journal degrades to ''");
  assert.match(r.summary, /subagent handoff/, "in-memory handoff still rendered");
});
