// Eval-harness self-test — proves the SHIPPED coding-agent eval harness works.
//
// This runs the eval runner (tests/eval/runner.mjs) in mock mode and asserts
// the harness machinery is sound: it loads and runs every task, drives the
// real QueryEngine loop, grades each workspace with real probes, and produces
// a scoreboard with a computed success rate + token/timing metrics.
//
// IMPORTANT: this test validates the HARNESS, not agent quality. Mock mode
// solves tasks by construction, so a 100% rate here means "the plumbing,
// grading, and scoreboard math are correct" — NOT "the agent is good." Real
// quality numbers come from `node tests/eval/runner.mjs --provider anthropic`.
// See tests/eval/README.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  loadTasks,
  runEval,
  gradeTask,
  runAgentOnTask,
  makeScriptedProvider,
  formatScoreboard,
} from "./eval/runner.mjs";

test("harness: loads a suite of coding tasks with valid grade specs", async () => {
  const tasks = await loadTasks();
  assert.ok(tasks.length >= 8, `expected >=8 tasks, got ${tasks.length}`);
  const ids = new Set();
  for (const t of tasks) {
    assert.ok(t.id, "task missing id");
    assert.ok(!ids.has(t.id), `duplicate task id: ${t.id}`);
    ids.add(t.id);
    assert.ok(t.prompt, `task ${t.id} missing prompt`);
    assert.ok(["fileContains", "fileEquals", "command"].includes(t.grade.type), `task ${t.id} bad grade type`);
  }
});

test("harness: runs all tasks in mock mode and produces a scoreboard", async () => {
  const board = await runEval({ providerName: "mock" });

  // Every task was executed and scored.
  const tasks = await loadTasks();
  assert.equal(board.taskCount, tasks.length);
  assert.equal(board.tasks.length, tasks.length);

  // Scoreboard shape.
  assert.equal(board.suite, "coding-eval-v1");
  assert.equal(board.provider, "mock");
  assert.equal(typeof board.successRate, "number");
  assert.ok(board.successRate >= 0 && board.successRate <= 1);
  assert.equal(board.passed + board.failed, board.taskCount);

  // Success-rate math is internally consistent.
  const passedCount = board.tasks.filter((t) => t.passed).length;
  assert.equal(board.passed, passedCount);
  assert.ok(Math.abs(board.successRate - passedCount / board.taskCount) < 1e-9);

  // Metrics are reported and non-negative.
  assert.ok(board.totalInputTokens >= 0);
  assert.ok(board.totalOutputTokens >= 0);
  assert.ok(board.totalDurationMs >= 0);
  for (const t of board.tasks) {
    assert.equal(typeof t.durationMs, "number");
    assert.ok(t.durationMs >= 0);
    assert.equal(typeof t.toolCalls, "number");
  }

  // In mock mode every task is solved by construction — this validates the
  // full engine -> tool -> grade path end to end.
  assert.equal(board.successRate, 1, `mock suite should solve all tasks; failures: ${JSON.stringify(board.tasks.filter((t) => !t.passed))}`);
});

test("harness: the scoreboard reports FAILURES, not just successes", async () => {
  // Run a single task but strip its scripted solution so the agent does
  // nothing — grading must catch this and the scoreboard must count it as a
  // failure. This proves grading is real, not rubber-stamping.
  const tasks = await loadTasks();
  const one = tasks.find((t) => t.grade.type === "command") ?? tasks[0];

  // A no-op provider that never calls a tool.
  const noopProvider = {
    name: "noop",
    async *stream() {
      yield { type: "text_delta", text: "I'll leave it as-is." };
      yield {
        type: "message_done",
        message: { id: "m", role: "assistant", content: [{ type: "text", text: "no-op" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };

  // Drive one task through the real seam with the no-op provider, then grade.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const ws = await mkdtemp(path.join(tmpdir(), "ares-eval-fail-"));
  try {
    // Seed the task's files so grading has something to inspect.
    const { writeFile, mkdir } = await import("node:fs/promises");
    for (const [rel, content] of Object.entries(one.seedFiles || {})) {
      const target = path.join(ws, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    const run = await runAgentOnTask(one, noopProvider, { model: "noop", workspace: ws });
    assert.equal(run.toolCalls, 0, "no-op provider should make no tool calls");
    const grade = gradeTask(one, ws);
    assert.equal(grade.passed, false, `un-attempted task ${one.id} must fail grading, got: ${grade.detail}`);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("harness: grading discriminates correct vs incorrect solutions", async () => {
  const path = (await import("node:path")).default;
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const ws = await mkdtemp(path.join(tmpdir(), "ares-eval-grade-"));
  try {
    // fileContains
    const containsTask = { id: "t", grade: { type: "fileContains", path: "a.txt", value: "HELLO" } };
    await writeFile(path.join(ws, "a.txt"), "say HELLO world", "utf8");
    assert.equal(gradeTask(containsTask, ws).passed, true);
    await writeFile(path.join(ws, "a.txt"), "say goodbye", "utf8");
    assert.equal(gradeTask(containsTask, ws).passed, false);

    // fileEquals
    const equalsTask = { id: "t", grade: { type: "fileEquals", path: "b.txt", value: "exact\n" } };
    await writeFile(path.join(ws, "b.txt"), "exact\n", "utf8");
    assert.equal(gradeTask(equalsTask, ws).passed, true);
    await writeFile(path.join(ws, "b.txt"), "exact", "utf8");
    assert.equal(gradeTask(equalsTask, ws).passed, false);

    // command
    const cmdTask = { id: "t", grade: { type: "command", command: "node -e \"process.exit(0)\"" } };
    assert.equal(gradeTask(cmdTask, ws).passed, true);
    const cmdFail = { id: "t", grade: { type: "command", command: "node -e \"process.exit(3)\"" } };
    assert.equal(gradeTask(cmdFail, ws).passed, false);

    // missing file
    const missing = { id: "t", grade: { type: "fileContains", path: "nope.txt", value: "x" } };
    assert.equal(gradeTask(missing, ws).passed, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("harness: scoreboard formats to a human-readable string", async () => {
  const board = await runEval({ providerName: "mock" });
  const text = formatScoreboard(board);
  assert.match(text, /SUCCESS RATE:/);
  assert.match(text, /TOKENS:/);
  assert.match(text, /WALL CLOCK:/);
  assert.ok(text.includes(board.tasks[0].id));
});

test("harness: a scripted provider drives the real QueryEngine loop", async () => {
  // Sanity-check the seam directly: makeScriptedProvider + runAgentOnTask must
  // actually produce tool calls and usage through the real engine.
  const tasks = await loadTasks();
  const task = tasks.find((t) => t.id === "implement-clamp");
  const path = (await import("node:path")).default;
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const ws = await mkdtemp(path.join(tmpdir(), "ares-eval-seam-"));
  try {
    const run = await runAgentOnTask(task, makeScriptedProvider(task), { model: "scripted", workspace: ws });
    assert.ok(run.toolCalls >= 1, "expected at least one tool call through the engine");
    assert.ok(run.inputTokens > 0, "expected usage to be reported by the engine");
    assert.equal(gradeTask(task, ws).passed, true);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});
