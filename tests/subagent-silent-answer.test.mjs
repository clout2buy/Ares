// Subagents dying silent (field window Sep 20 - Nov 2: 26 of 29 runs failed,
// 16 as "(subagent produced no text output)" after a failing tool). A child
// that ends without text now gets one tool-less nudge turn to write its
// answer, and if it still says nothing the parent gets an account of what it
// was doing and how it failed instead of a bare failure.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AresSubagentRunner, SubagentRegistry, SUBAGENT_ANSWER_NUDGE, silentChildAccount } from "../packages/core/dist/index.js";
import { ReadTool, adaptToolForEngine } from "../packages/tools/dist/index.js";

const readTool = adaptToolForEngine(ReadTool, (base) => ({ ...base, permissionMode: "bypass", fileReadStamps: base.fileReadStamps }));

function done(id, content, stopReason = "end_turn") {
  return {
    type: "message_done",
    message: { id, role: "assistant", content, createdAt: new Date().toISOString() },
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason,
  };
}

/** Reads a missing file (tool error), then ends with no text. On the nudge it
 *  answers with `nudgeAnswer` (or stays silent when that is empty). */
class SilentChildProvider {
  constructor(file, nudgeAnswer) {
    this.file = file;
    this.nudgeAnswer = nudgeAnswer;
    this.name = "silent-child";
    this.sawNudge = 0;
  }
  async *stream(req) {
    const wire = JSON.stringify(req.messages);
    if (wire.includes("You stopped without writing your answer")) {
      this.sawNudge++;
      yield done(`m_nudge_${this.sawNudge}`, this.nudgeAnswer ? [{ type: "text", text: this.nudgeAnswer }] : []);
      return;
    }
    const hasToolResult = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    if (!hasToolResult) {
      const input = { file_path: this.file };
      yield { type: "tool_use_start", id: "rd", name: "Read" };
      yield { type: "tool_use_input_done", id: "rd", input };
      yield done("m_read", [{ type: "tool_use", id: "rd", name: "Read", input }], "tool_use");
      return;
    }
    yield done("m_silent", []);
  }
}

async function runChild(nudgeAnswer) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ares-silent-"));
  const provider = new SilentChildProvider(path.join(tmp, "missing.ts"), nudgeAnswer);
  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry([{ name: "reader", description: "reads", systemPrompt: "Read.", toolWhitelist: ["Read"], maxTurns: 4 }]),
    provider,
    model: "mock",
    parentTools: [readTool],
    baseSystemPrompt: "base",
  });
  const result = await runner.run({ subagent_type: "reader", description: "child", prompt: "read the file", workspace: tmp });
  return { provider, result };
}

test("the nudge text tells the child to stop calling tools and answer", () => {
  assert.match(SUBAGENT_ANSWER_NUDGE, /Do not call any more tools/);
  assert.match(SUBAGENT_ANSWER_NUDGE, /final answer/);
});

test("a child that ends silent gets one nudge turn, and its answer reaches the parent", async () => {
  const { provider, result } = await runChild("The file does not exist; nothing to report.");
  assert.equal(provider.sawNudge, 1, "exactly one nudge turn");
  assert.match(result.summary, /The file does not exist; nothing to report\./);
  assert.doesNotMatch(result.summary, /ended without writing an answer/);
  assert.equal(result.status, "completed");
});

test("a child still silent after the nudge returns what it was doing and its last tool error", async () => {
  const { provider, result } = await runChild("");
  assert.equal(provider.sawNudge, 1, "never more than one nudge");
  assert.match(result.summary, /ended without writing an answer/);
  assert.match(result.summary, /What it was doing/);
  assert.match(result.summary, /- Read: .*FAILED: /);
  assert.doesNotMatch(result.summary, /produced no text output/);
});

test("ARES_SUBAGENT_ANSWER_NUDGE=0 skips the nudge but still explains", async () => {
  process.env.ARES_SUBAGENT_ANSWER_NUDGE = "0";
  try {
    const { provider, result } = await runChild("unused");
    assert.equal(provider.sawNudge, 0);
    assert.match(result.summary, /ended without writing an answer/);
  } finally {
    delete process.env.ARES_SUBAGENT_ANSWER_NUDGE;
  }
});

test("silentChildAccount names steps, outcomes and the engine error", () => {
  const text = silentChildAccount([
    { type: "tool_start", id: "a", name: "PowerShell", input: {}, activityDescription: "Running npm test" },
    { type: "tool_error", id: "a", error: "PowerShell exited with code 1\nhint: x", durationMs: 1 },
    { type: "tool_start", id: "b", name: "Grep", input: {}, activityDescription: "Searching" },
    { type: "error", error: { code: "x", message: "provider 500", retriable: false } },
  ], "failed", 2);
  assert.match(text, /turn status: failed; 2 tool calls/);
  assert.match(text, /- PowerShell: Running npm test -> FAILED: PowerShell exited with code 1 hint: x/);
  assert.match(text, /- Grep: Searching -> did not finish/);
  assert.match(text, /Last engine error: provider 500/);
});

test("durable (session-kernel) children get the same one nudge", async () => {
  const { createRequire } = await import("node:module");
  const { SessionKernelStore } = await import("../packages/core/dist/index.js");
  const BetterSqlite3 = createRequire(new URL("../packages/core/package.json", import.meta.url))("better-sqlite3");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ares-silent-durable-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  try {
    store.createSession({ id: "parent-session", workspaceKey: workspace });
    let nudges = 0;
    const provider = {
      name: "silent-durable",
      async *stream(req) {
        const nudged = JSON.stringify(req.messages).includes("You stopped without writing your answer");
        if (nudged) nudges++;
        yield done(`m_${nudges}`, nudged ? [{ type: "text", text: "durable answer" }] : []);
      },
    };
    const runner = new AresSubagentRunner({
      registry: new SubagentRegistry([{ name: "worker", description: "w", systemPrompt: "work", toolWhitelist: [], maxTurns: 2 }]),
      provider,
      model: "mock",
      parentTools: [],
      baseSystemPrompt: "base",
      sessionKernel: store,
      contextBudgetTokens: 0,
    });
    const result = await runner.run({
      subagent_type: "worker",
      description: "durable",
      prompt: "do it",
      parentSessionId: "parent-session",
      invocationId: "tool-use-silent",
      workspace,
    });
    assert.equal(nudges, 1);
    assert.match(result.summary, /durable answer/);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
