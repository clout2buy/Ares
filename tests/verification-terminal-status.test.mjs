// Terminal verification gate — the turn_end STATUS is honest about coding proof.
//
// Field data: 79% of coding turns (49/62) ended workStatus "unverified" while
// status said "completed", so every UI/eval reading status scored success.
// Contract now:
//   - status "completed" ONLY when workStatus is verified or not_applicable
//   - otherwise "needs_verification" (workStatus preserved) carrying a
//     STRUCTURAL `unverified` gap {files, checksRun, missing} — no transcript
//     warning line (the user-facing UNVERIFIED warning was removed by owner order)
//   - the anti-spiral cap is untouched (no extra loop iterations)
//   - ARES_STRICT_VERIFY=0 restores the legacy "completed" stamping

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine } from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "scripted",
    calls: 0,
    async *stream() {
      this.calls++;
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tool) {
        const id = `tu_${call}`;
        yield { type: "tool_use_start", id, name: script.tool.name };
        yield { type: "tool_use_input_done", id, input: script.tool.input };
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: [{ type: "tool_use", id, name: script.tool.name, input: script.tool.input }], createdAt: new Date().toISOString() },
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use",
        };
        return;
      }
      yield { type: "text_delta", text: script.text };
      yield {
        type: "message_done",
        message: { id: `m_${call}`, role: "assistant", content: [{ type: "text", text: script.text }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function editTool(file) {
  return {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call() { return { output: "edited", touchedFiles: [file] }; },
  };
}

function bashTool(exitCodeFor = () => 0) {
  return {
    schema: { name: "Bash", description: "shell", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "exclusive" },
    async call(input) {
      const exitCode = exitCodeFor(input.command);
      return { output: { command: input.command, exitCode, timedOut: false, stdout: exitCode === 0 ? "ok" : "1 failing", stderr: "" } };
    },
  };
}

async function collect(engine) {
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

const noWarningLine = (events) =>
  !events.some((e) => e.type === "system_reminder_injected" && /VERIFICATION INCOMPLETE/.test(e.text));

test("unverified coding changes end needs_verification with a structural gap, no transcript warning", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = scriptedProvider([
    { tool: { name: "Edit", input: { file_path: "src/feature.ts" } } },
    { text: "done" },
    { text: "still done" },
  ]);
  const engine = QueryEngine.forTesting({
    provider,
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "src", "feature.ts"))],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_term_unverified");
  engine.appendUserMessage("change the feature");
  const events = await collect(engine);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "needs_verification");
  assert.equal(end.workStatus, "unverified", "workStatus is preserved alongside the new status");
  assert.equal(provider.calls, 3, "the anti-spiral cap is untouched — no extra loop iterations");
  assert.deepEqual(end.unverified.files, [path.join("src", "feature.ts")], "names the changed file");
  assert.deepEqual(end.unverified.checksRun, [], "names which checks ran (none)");
  assert.ok(end.unverified.missing.some((m) => /behavioral/.test(m)), "names what is missing");
  assert.ok(noWarningLine(events), "no user-facing warning line (standing order 2026-08-17)");
  assert.equal(engine.history().at(-1).role, "assistant", "history is not padded with an engine-written line");
});

test("verified coding changes still end completed with no gap", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "src/feature.ts" } } },
      { text: "done" },
      { tool: { name: "Bash", input: { command: "pnpm test", description: "Run tests" } } },
      { text: "verified" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "src", "feature.ts")), bashTool()],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_term_verified");
  engine.appendUserMessage("fix the feature");
  const events = await collect(engine);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.equal(end.workStatus, "verified");
  assert.equal(end.unverified, undefined);
});

test("a conversational turn (no coding) ends completed / not_applicable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider([{ text: "hello" }]),
    model: "scripted",
    systemPrompt: "chat",
    tools: [],
    workspace: root,
    requireVerificationEvidence: true,
  }, "sess_term_chat");
  engine.appendUserMessage("hi");
  const events = await collect(engine);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.equal(end.workStatus, "not_applicable");
  assert.equal(end.unverified, undefined);
});

test("a stuck red end-gate ends needs_verification / blocked and the gap says the checks were never resolved", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider([{ text: "done (1)" }, { text: "done (2)" }, { text: "done (3)" }]),
    model: "scripted",
    systemPrompt: "code",
    tools: [],
    workspace: root,
    confirmTurnEnd: async () => [{ text: "typecheck is still red on a.ts", source: "verifier" }],
  }, "sess_term_blocked");
  engine.appendUserMessage("do the thing");
  const events = await collect(engine);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "needs_verification");
  assert.equal(end.workStatus, "blocked");
  assert.ok(end.unverified.missing.some((m) => /never resolved/.test(m)));
  assert.ok(noWarningLine(events));
});

test("the gap names a failed manual check and the stale static host verifier run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = () => ({
    mutationGeneration: 2,
    passedCommands: 1,
    failedCommands: 0,
    skippedCommands: 0,
    latestRunGeneration: 1,
    latestRunStatus: "passed",
    latestRunStrength: "static",
    latestLabels: ["typescript"],
  });
  const engine = QueryEngine.forTesting({
    provider: scriptedProvider([
      { tool: { name: "Edit", input: { file_path: "a.ts" } } },
      { tool: { name: "Bash", input: { command: "pnpm test", description: "tests" } } },
      { text: "done" },
      { text: "still done" },
    ]),
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(path.join(root, "a.ts")), bashTool(() => 1)],
    workspace: root,
    requireVerificationEvidence: true,
    verificationEvidence: evidence,
  }, "sess_term_detail");
  engine.appendUserMessage("change a.ts");
  const events = await collect(engine);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.status, "needs_verification");
  const ran = end.unverified.checksRun.join(" | ");
  assert.match(ran, /host verifier: passed\/static on STALE/);
  assert.match(ran, /\[typescript\]/);
  assert.match(ran, /manual FAIL: `pnpm test`/);
});

test("ARES_STRICT_VERIFY=0 restores legacy completed stamping (workStatus still honest)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-term-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withEnv("ARES_STRICT_VERIFY", "0", async () => {
    const engine = QueryEngine.forTesting({
      provider: scriptedProvider([
        { tool: { name: "Edit", input: { file_path: "a.ts" } } },
        { text: "done" },
        { text: "still done" },
      ]),
      model: "scripted",
      systemPrompt: "code",
      tools: [editTool(path.join(root, "a.ts"))],
      workspace: root,
      requireVerificationEvidence: true,
    }, "sess_term_legacy");
    engine.appendUserMessage("change a.ts");
    const events = await collect(engine);
    const end = events.findLast((e) => e.type === "turn_end");
    assert.equal(end.status, "completed");
    assert.equal(end.workStatus, "unverified");
    assert.equal(end.unverified, undefined);
  });
});
