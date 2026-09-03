// Adversarial verifier auto-spawn.
//
// When a turn is about to end with ≥ ARES_VERIFY_SUBAGENT_MIN_FILES (3)
// changed files and no behavioral proof, and the host wired a subagent runner,
// the engine runs the `verifier` subagent ONCE per turn with the changed files
// and the derived project checks. PASS + Command-run block = proof at the
// current generation; FAIL blocks. Never from inside a subagent, never twice,
// ARES_VERIFY_SUBAGENT=0 disables.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { QueryEngine, parseVerifierVerdict, resetProjectChecksCache, runAtSubagentDepth } from "../packages/core/dist/index.js";

function scriptedProvider(scripts) {
  let call = 0;
  return {
    name: "scripted",
    calls: 0,
    async *stream() {
      this.calls++;
      const script = scripts[Math.min(call++, scripts.length - 1)];
      if (script.tools) {
        const uses = script.tools.map((tool, i) => ({ id: `tu_${call}_${i}`, ...tool }));
        for (const use of uses) {
          yield { type: "tool_use_start", id: use.id, name: use.name };
          yield { type: "tool_use_input_done", id: use.id, input: use.input };
        }
        yield {
          type: "message_done",
          message: { id: `m_${call}`, role: "assistant", content: uses.map((use) => ({ type: "tool_use", id: use.id, name: use.name, input: use.input })), createdAt: new Date().toISOString() },
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

function editTool(root) {
  return {
    schema: { name: "Edit", description: "edit", inputJsonSchema: { type: "object" }, safety: "workspace-write", concurrency: "parallel-safe" },
    async call(input) { return { output: "edited", touchedFiles: [path.join(root, input.file_path)] }; },
  };
}

const PASS_REPORT = [
  "### Check: package tests",
  "**Command run:** pnpm test",
  "**Output observed:** 12 passing",
  "**Result: PASS**",
  "VERDICT: PASS",
].join("\n");
const FAIL_REPORT = "### Check: boundary\n**Command run:** node probe.mjs\n**Output observed:** TypeError\n**Result: FAIL**\nVERDICT: FAIL";
const LAZY_PASS = "I read the code and it looks right.\nVERDICT: PASS";

function fakeRunner(report, { has = true, status = "completed" } = {}) {
  const runner = {
    spawns: [],
    has: () => has,
    async run(req) {
      runner.spawns.push(req);
      return { id: "agent_fake", status, workStatus: "verified", summary: typeof report === "function" ? report(req) : report };
    },
  };
  return runner;
}

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ares-verify-spawn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@acme/app", scripts: { test: "node --test", build: "tsc -b" } }));
  await mkdir(path.join(root, "tests"), { recursive: true });
  resetProjectChecksCache();
  return root;
}

function engineFor(root, files, runner, extra = {}) {
  const provider = scriptedProvider([
    { tools: files.map((file_path) => ({ name: "Edit", input: { file_path } })) },
    { text: "done" },
    { text: "still done" },
  ]);
  const engine = QueryEngine.forTesting({
    provider,
    model: "scripted",
    systemPrompt: "code",
    tools: [editTool(root)],
    workspace: root,
    requireVerificationEvidence: true,
    subagentRunner: runner,
    ...extra,
  }, `sess_spawn_${files.length}_${Math.random().toString(36).slice(2, 8)}`);
  engine.appendUserMessage("do the work");
  return { engine, provider };
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
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("3 changed files: the verifier spawns once, a PASS with command evidence verifies the turn", async (t) => {
  const root = await workspace(t);
  const runner = fakeRunner(PASS_REPORT);
  const { engine } = engineFor(root, ["a.ts", "b.ts", "c.ts"], runner);
  const events = await collect(engine);
  assert.equal(runner.spawns.length, 1, "exactly one spawn");
  const req = runner.spawns[0];
  assert.equal(req.subagent_type, "verifier");
  assert.equal(req.workspace, root);
  for (const f of ["a.ts", "b.ts", "c.ts"]) assert.match(req.prompt, new RegExp(`- ${f}`), "prompt lists the changed files");
  assert.match(req.prompt, /test: `npm test`/, "prompt carries the derived project checks");
  assert.match(req.prompt, /build: `npm run build`/);
  assert.ok(events.some((e) => e.type === "subagent_start" && e.name === "verifier"));
  assert.ok(events.some((e) => e.type === "subagent_end" && e.status === "completed"));
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "verified", "PASS + Command-run counts as behavioral proof");
  assert.equal(end.status, "completed");
});

test("2 changed files: no spawn", async (t) => {
  const root = await workspace(t);
  const runner = fakeRunner(PASS_REPORT);
  const { engine } = engineFor(root, ["a.ts", "b.ts"], runner);
  const events = await collect(engine);
  assert.equal(runner.spawns.length, 0);
  assert.equal(events.findLast((e) => e.type === "turn_end").status, "needs_verification");
});

test("inside a child (cfg.subagentDepth > 0 OR AsyncLocalStorage depth): never spawns", async (t) => {
  const root = await workspace(t);
  const byConfig = fakeRunner(PASS_REPORT);
  await collect(engineFor(root, ["a.ts", "b.ts", "c.ts"], byConfig, { subagentDepth: 1 }).engine);
  assert.equal(byConfig.spawns.length, 0, "config depth guard");
  const byAls = fakeRunner(PASS_REPORT);
  await runAtSubagentDepth(1, async () => collect(engineFor(root, ["a.ts", "b.ts", "c.ts"], byAls).engine));
  assert.equal(byAls.spawns.length, 0, "AsyncLocalStorage depth guard");
});

test("a FAIL blocks the turn and the model gets one repair round; still only one spawn", async (t) => {
  const root = await workspace(t);
  const runner = fakeRunner(FAIL_REPORT);
  const { engine, provider } = engineFor(root, ["a.ts", "b.ts", "c.ts"], runner);
  const events = await collect(engine);
  assert.equal(runner.spawns.length, 1, "never more than once per turn even across repeated done-claims");
  const reminder = events.find((e) => e.type === "system_reminder_injected" && /VERDICT: FAIL/.test(e.text));
  assert.ok(reminder, "verdict + evidence fed back as a system reminder");
  assert.match(reminder.text, /TypeError/);
  const end = events.findLast((e) => e.type === "turn_end");
  assert.equal(end.workStatus, "blocked");
  assert.equal(end.status, "needs_verification");
  assert.ok(provider.calls >= 3, "the model was given a round to repair after the FAIL");
});

test("a PASS without a Command-run block is not proof", async (t) => {
  const root = await workspace(t);
  const runner = fakeRunner(LAZY_PASS);
  const { engine } = engineFor(root, ["a.ts", "b.ts", "c.ts"], runner);
  const events = await collect(engine);
  assert.equal(runner.spawns.length, 1);
  assert.equal(events.findLast((e) => e.type === "turn_end").workStatus, "unverified");
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /no Command-run evidence/.test(e.text)));
});

test("ARES_VERIFY_SUBAGENT=0 and ARES_VERIFY_SUBAGENT_MIN_FILES are honoured; a runner without `verifier` is skipped", async (t) => {
  const root = await workspace(t);
  await withEnv("ARES_VERIFY_SUBAGENT", "0", async () => {
    const runner = fakeRunner(PASS_REPORT);
    await collect(engineFor(root, ["a.ts", "b.ts", "c.ts"], runner).engine);
    assert.equal(runner.spawns.length, 0, "kill-switch");
  });
  await withEnv("ARES_VERIFY_SUBAGENT_MIN_FILES", "2", async () => {
    const runner = fakeRunner(PASS_REPORT);
    await collect(engineFor(root, ["a.ts", "b.ts"], runner).engine);
    assert.equal(runner.spawns.length, 1, "threshold knob lowers the bar");
  });
  const noType = fakeRunner(PASS_REPORT, { has: false });
  await collect(engineFor(root, ["a.ts", "b.ts", "c.ts"], noType).engine);
  assert.equal(noType.spawns.length, 0);
});

test("parseVerifierVerdict: last VERDICT line wins; Command-run detection", () => {
  assert.deepEqual(parseVerifierVerdict(PASS_REPORT), { verdict: "PASS", hasCommandRun: true });
  assert.deepEqual(parseVerifierVerdict(LAZY_PASS), { verdict: "PASS", hasCommandRun: false });
  assert.deepEqual(parseVerifierVerdict("VERDICT: PASS\n...later...\n**VERDICT: FAIL**"), { verdict: "FAIL", hasCommandRun: false });
  assert.deepEqual(parseVerifierVerdict("nothing here"), { verdict: null, hasCommandRun: false });
});
