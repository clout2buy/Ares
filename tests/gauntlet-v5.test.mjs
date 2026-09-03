// coding-v5 (repo-scale) gauntlet — the plumbing proof.
//
//   1. the suite is registered as "coding-v5", never the default, and every
//      fixture is repo-shaped (3–6 files, a node --test script, a CRLF file)
//   2. the scripted mock solutions score 1.0 on every task — fixtures
//      materialize, CRLF survives, real node --test runs, trace probes judge
//   3. a no-op agent scores 0 across the suite
//   4. the diffScope probe rejects an out-of-scope change even when the tests
//      pass; planBeforeEdit rejects an edit that precedes the plan
//
// Reality only: probes spawn real node processes against the workspaces.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runGauntlet, runProbe, fileInScope, CODING_GAUNTLET_V5, GAUNTLET_SUITES } from "../packages/operator/dist/index.js";
import { V5_SOLUTIONS } from "./eval/gauntletV5Solutions.mjs";

// ─── Minimal real tools ────────────────────────────────────────────────────

function inside(workspace, rel) {
  const target = path.resolve(workspace, rel);
  if (!target.startsWith(path.resolve(workspace))) throw new Error("path escapes workspace");
  return target;
}

function fakeTools(workspace) {
  const schema = (name, desc) => ({ name, description: desc, inputJsonSchema: { type: "object" }, safety: "workspace-write" });
  return [
    {
      schema: schema("Write", "write a file"),
      async call(input) {
        const target = inside(workspace, input.file_path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, input.content, "utf8");
        return { output: `wrote ${input.file_path}`, touchedFiles: [input.file_path] };
      },
    },
    {
      schema: schema("Edit", "replace a string in a file"),
      async call(input) {
        const target = inside(workspace, input.file_path);
        const current = await readFile(target, "utf8");
        if (!current.includes(input.old_string)) throw new Error(`old_string not found in ${input.file_path}`);
        await writeFile(target, current.replace(input.old_string, input.new_string), "utf8");
        return { output: `edited ${input.file_path}`, touchedFiles: [input.file_path] };
      },
    },
    {
      schema: schema("TodoWrite", "record a plan"),
      async call(input) {
        return { output: { todos: input.todos ?? [] } };
      },
    },
    {
      // Only `rm <file>` — enough for the refactor task's deletion, and proof
      // that diffScope sees shell-made changes by their bytes.
      schema: schema("Bash", "run a command"),
      async call(input) {
        const m = /^rm\s+(?:-f\s+)?(\S+)$/.exec(String(input.command ?? "").trim());
        if (!m) throw new Error("fake Bash supports only `rm <file>`");
        await unlink(inside(workspace, m[1]));
        return { output: "", touchedFiles: [m[1]] };
      },
    },
  ];
}

/** Replays `steps` once (all tool calls in one message), then says done forever. */
function scriptedProvider(stepsFor) {
  return {
    name: "mock",
    async *stream(req) {
      const prompt = req.messages[0]?.content?.find((b) => b.type === "text")?.text ?? "";
      const steps = stepsFor(prompt);
      const alreadyActed = req.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"));
      if (!alreadyActed && steps.length > 0) {
        const content = steps.map((s, i) => ({ type: "tool_use", id: `tu_${i}`, name: s.name, input: s.input }));
        for (const block of content) {
          yield { type: "tool_use_start", id: block.id, name: block.name };
          yield { type: "tool_use_input_done", id: block.id, input: block.input };
        }
        yield { type: "message_done", message: { id: "m_act", role: "assistant", content, createdAt: new Date().toISOString() }, usage: { inputTokens: 10, outputTokens: 10 }, stopReason: "tool_use" };
        return;
      }
      const text = "Done — changes made and verified.";
      yield { type: "text_delta", text };
      yield { type: "message_done", message: { id: "m_done", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() }, usage: { inputTokens: 5, outputTokens: 5 }, stopReason: "end_turn" };
    },
  };
}

const talkOnlyProvider = {
  name: "talker",
  async *stream() {
    const text = "I have carefully analyzed the repository and everything is now implemented and passing.";
    yield { type: "text_delta", text };
    yield { type: "message_done", message: { id: "m", role: "assistant", content: [{ type: "text", text }], createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  },
};

const taskByPrompt = (prompt) => CODING_GAUNTLET_V5.find((t) => t.prompt === prompt);

// ─── 1. shape ──────────────────────────────────────────────────────────────

test("coding-v5: registered, not the default, and every fixture is repo-shaped", () => {
  assert.equal(GAUNTLET_SUITES["coding-v5"], CODING_GAUNTLET_V5);
  assert.equal(Object.keys(GAUNTLET_SUITES)[0], "coding-v1", "registration order untouched — v1 stays first");
  assert.equal(CODING_GAUNTLET_V5.length, 6);
  const ids = new Set();
  for (const task of CODING_GAUNTLET_V5) {
    assert.ok(!ids.has(task.id), `duplicate id ${task.id}`);
    ids.add(task.id);
    const files = Object.keys(task.files);
    assert.ok(files.length >= 3 && files.length <= 8, `${task.id}: ${files.length} files`);
    const pkg = JSON.parse(task.files["package.json"]);
    assert.match(pkg.scripts.test, /^node --test /, `${task.id}: real node --test script`);
    assert.ok(files.some((f) => task.files[f].includes("\r\n")), `${task.id}: at least one CRLF file`);
    assert.ok(task.probes.some((p) => p.kind === "diffScope"), `${task.id}: has a diffScope probe`);
    assert.ok(task.probes.some((p) => p.kind === "command"), `${task.id}: has a real command probe`);
    assert.equal(task.allProbesRequired, true);
    assert.ok(V5_SOLUTIONS[task.id]?.length > 0, `${task.id}: has a mock solution`);
  }
  assert.ok(CODING_GAUNTLET_V5.find((t) => t.id === "v5-ambiguous-spec-plan-first").probes.some((p) => p.kind === "planBeforeEdit"));
});

// ─── 2. mock run ───────────────────────────────────────────────────────────

test("coding-v5: the scripted mock solutions score 1.0 on every task", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-v5-"));
  try {
    const report = await runGauntlet({
      provider: scriptedProvider((prompt) => V5_SOLUTIONS[taskByPrompt(prompt).id]),
      model: "scripted",
      suite: "coding-v5",
      tasks: CODING_GAUNTLET_V5,
      workspaceRoot: root,
      tools: (ws) => fakeTools(ws),
    });
    assert.equal(report.suite, "coding-v5");
    for (const t of report.tasks) {
      assert.equal(t.score, 1, `${t.id}: ${JSON.stringify(t.probes, null, 1)}${t.error ? ` error=${t.error}` : ""}`);
      assert.equal(t.integrityPassed, true, `${t.id}: protected files intact`);
    }
    assert.equal(report.total, 1);
    assert.equal(report.complete, true, JSON.stringify(report.tasks.map((t) => t.error)));
    // The refactor's shell deletion shows up in the change set — bytes, not tool claims.
    const refactor = report.tasks.find((t) => t.id === "v5-refactor-shared-helper");
    assert.ok(refactor.changedFiles.includes("src/util/slug.mjs"), refactor.changedFiles.join(","));
    // The plan-first task changed exactly one file.
    const plan = report.tasks.find((t) => t.id === "v5-ambiguous-spec-plan-first");
    assert.deepEqual(plan.changedFiles, ["docs/PLAN-88.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── 3. no-op agent ────────────────────────────────────────────────────────

test("coding-v5: a confident no-op agent scores 0 on every task", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-v5-noop-"));
  try {
    const report = await runGauntlet({ provider: talkOnlyProvider, model: "talker", suite: "coding-v5", tasks: CODING_GAUNTLET_V5, workspaceRoot: root, tools: () => [] });
    for (const t of report.tasks) assert.equal(t.score, 0, `${t.id} scored ${t.score}`);
    assert.equal(report.total, 0);
    assert.equal(report.metrics.falseGreenRate, 1, "every completion claim was a false green");
    // The plan-first task fails on the trace, not just on the missing file.
    const plan = report.tasks.find((t) => t.id === "v5-ambiguous-spec-plan-first");
    assert.match(plan.probes[0].summary, /no plan\/todo call/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── 4. trace probes ───────────────────────────────────────────────────────

test("coding-v5: diffScope rejects an out-of-scope change even when the tests pass", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ares-gauntlet-v5-scope-"));
  try {
    const task = CODING_GAUNTLET_V5.find((t) => t.id === "v5-cause-not-symptom");
    // Fixes the cause AND "tidies" cart.mjs — a symptom-adjacent edit outside the allowed set.
    const steps = [
      ...V5_SOLUTIONS["v5-cause-not-symptom"],
      { name: "Edit", input: { file_path: "src/cart.mjs", old_string: "let sum = 0;", new_string: "let sum = 0; // running total" } },
    ];
    const report = await runGauntlet({ provider: scriptedProvider(() => steps), model: "scripted", tasks: [task], workspaceRoot: root, tools: (ws) => fakeTools(ws) });
    const [result] = report.tasks;
    const byKind = Object.fromEntries(task.probes.map((p, i) => [p.kind === "command" ? `command${i}` : p.kind, result.probes[i]]));
    assert.equal(byKind.command0.met, true, "the tests DO pass");
    assert.equal(byKind.diffScope.met, false);
    assert.match(byKind.diffScope.summary, /out-of-scope change\(s\): src\/cart\.mjs/);
    assert.equal(result.score, 0, "allProbesRequired gates the task to zero");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding-v5: runProbe judges diffScope / planBeforeEdit from the trace, and fails closed without one", async () => {
  const trace = (changedFiles, names) => ({ changedFiles, toolCalls: names.map((name) => ({ name })) });
  const scope = { kind: "diffScope", allowed: ["src/a.mjs", "docs/", "tests/**"] };
  assert.equal((await runProbe(scope, { trace: trace(["src/a.mjs", "docs/x.md", "tests/deep/y.test.mjs"], []) })).met, true);
  assert.equal((await runProbe(scope, { trace: trace(["src/b.mjs"], []) })).met, false);
  assert.equal((await runProbe(scope, { trace: trace([], []) })).met, true, "no changes is within any scope");
  assert.equal((await runProbe(scope, {})).met, false, "no trace → not met");
  assert.equal(fileInScope("src\\a.mjs", ["src/a.mjs"]), true, "backslashes normalize");
  assert.equal(fileInScope("srcx/a.mjs", ["src/"]), false, "directory rule needs the slash boundary");

  const plan = { kind: "planBeforeEdit" };
  assert.equal((await runProbe(plan, { trace: trace([], ["Read", "TodoWrite", "Write"]) })).met, true);
  assert.equal((await runProbe(plan, { trace: trace([], ["Read", "TodoWrite"]) })).met, true, "a plan and no edits is fine");
  const late = await runProbe(plan, { trace: trace([], ["Write", "TodoWrite"]) });
  assert.equal(late.met, false);
  assert.match(late.summary, /Write at call 1 preceded the first plan at call 2/);
  assert.equal((await runProbe(plan, { trace: trace([], ["Bash", "Read"]) })).met, false, "no plan at all");
  assert.equal((await runProbe(plan, {})).met, false);
});
