// scripts/elite/coding-bench.mjs - the harness itself must be trustworthy:
//   * scripted mode passes real tasks through the real engine + tools + oracles
//   * a no-op agent FAILS (the oracle never reads the agent's claim)
//   * an out-of-scope diff or an oversized diff fails a task even when tests pass
//   * live mode is OFF unless explicitly enabled AND hard-capped; the cap is shared
//     across tasks and stops the run the moment it is spent
// Deterministic and offline: no live model is ever contacted here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBench, parseArgs, withCallBudget, BudgetExceeded, TASKS, renderTable } from "../scripts/elite/coding-bench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "elite", "coding-bench.mjs");
const baseArgs = (over = {}) => ({ ...parseArgs([]), repo: ROOT, ...over });

test("the suite has 12-20 tasks, each with an oracle, a scripted agent and a diff cap", () => {
  assert.ok(TASKS.length >= 12 && TASKS.length <= 20, `${TASKS.length} tasks`);
  const ids = new Set(TASKS.map((t) => t.id));
  assert.equal(ids.size, TASKS.length, "unique ids");
  for (const t of TASKS) {
    assert.equal(typeof t.oracle, "function", t.id);
    assert.equal(typeof t.script, "function", t.id);
    assert.ok(t.prompt && t.files, t.id);
    assert.ok(Array.isArray(t.allowed) && t.maxDiffLines > 0, `${t.id} needs allowed paths and a diff cap`);
  }
  const categories = new Set(TASKS.map((t) => t.category));
  for (const c of ["bugfix", "feature", "refactor", "build-fix", "flaky", "merge", "tests", "api-migration", "shell", "rename", "performance"]) {
    assert.ok(categories.has(c), `category ${c} is covered`);
  }
});

test("scripted: real tasks pass end-to-end through the real engine, tools and oracles", async () => {
  const report = await runBench(baseArgs({ tasks: ["js-bugfix-offbyone", "js-edit-after-external-change", "git-resolve-merge-conflict"] }));
  assert.equal(report.totals.ran, 3);
  assert.equal(report.totals.passed, 3, renderTable(report));
  for (const row of report.tasks) {
    assert.ok(row.turns >= 3 && row.toolCalls >= 3, `${row.id} actually exercised tools`);
    assert.ok(row.diffLines > 0 && row.diffLines <= 30, `${row.id} diff ${row.diffLines}`);
    assert.deepEqual(row.outOfScope, []);
    assert.ok(row.wallMs > 0 && row.resultBytes > 0);
  }
  assert.equal(report.provider, "scripted");
});

test("negative controls: a no-op agent, an out-of-scope edit and a bloated diff all FAIL the task", async () => {
  const base = TASKS.find((t) => t.id === "js-bugfix-offbyone");
  const noop = { ...base, id: "noop", async *script() { return { text: "Done. Everything works." }; } };
  const scope = {
    ...base,
    id: "scope",
    async *script() {
      yield { name: "Edit", input: { file_path: "src/range.mjs", old_string: "i < end", new_string: "i <= end" } };
      yield { name: "Write", input: { file_path: "src/unrelated.mjs", content: "export const x = 1;\n" } };
      return { text: "Done." };
    },
  };
  const bloat = {
    ...base,
    id: "bloat",
    maxDiffLines: 3,
    async *script() {
      yield { name: "Edit", input: { file_path: "src/range.mjs", old_string: "i < end", new_string: "i <= end" } };
      yield { name: "Write", input: { file_path: "src/range.mjs", content: "export function range(start, end) {\n  const out = [];\n  for (let i = start; i <= end; i++) out.push(i);\n  return out;\n}\n// padding\n// padding\n// padding\n" } };
      return { text: "Done." };
    },
  };
  const report = await runBench(baseArgs(), { tasks: [noop, scope, bloat] });
  const byId = Object.fromEntries(report.tasks.map((r) => [r.id, r]));
  assert.equal(byId.noop.success, false, "claiming done is not passing");
  assert.match(byId.noop.detail, /node --test failed/);
  assert.equal(byId.scope.success, false);
  assert.match(byId.scope.detail, /out-of-scope diff: src\/unrelated\.mjs/);
  assert.equal(byId.bloat.success, false);
  assert.match(byId.bloat.detail, /diff too large/);
});

test("live mode is OFF by default: refuses without ARES_ELITE_LIVE=1 and a --budget, and above 200 calls", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ARES_ELITE_LIVE: "", ...env } });
  const a = run(["--provider", "live", "--budget", "5"]);
  assert.equal(a.status, 2);
  assert.match(a.stderr, /OFF by default/);
  const b = run(["--provider", "live"], { ARES_ELITE_LIVE: "1" });
  assert.equal(b.status, 2);
  const c = run(["--provider", "live", "--budget", "500"], { ARES_ELITE_LIVE: "1" });
  assert.equal(c.status, 2);
  assert.match(c.stderr, /above 200/);
  const d = run(["--provider", "bogus"]);
  assert.equal(d.status, 2);
});

test("withCallBudget: the cap is hard, shared across wrapped providers, and throws BudgetExceeded", async () => {
  const calls = [];
  const inner = { name: "fake-live", async *stream() { calls.push(1); yield { type: "text_delta", text: "x" }; } };
  const shared = { calls: 0 };
  const a = withCallBudget(inner, 3, shared);
  const b = withCallBudget(inner, 3, shared);
  for (const p of [a, b, a]) for await (const _ of p.stream({})) void _;
  assert.equal(shared.calls, 3);
  await assert.rejects(async () => { for await (const _ of b.stream({})) void _; }, BudgetExceeded);
  assert.equal(calls.length, 3, "the 4th call never reached the model");
});

test("live (simulated): the budget stops the whole run; later tasks are skipped; calls never exceed the cap", async () => {
  let modelCalls = 0;
  const live = {
    model: "fake-live",
    provider: {
      name: "fake-live",
      async *stream() {
        modelCalls++;
        yield { type: "text_delta", text: "I give up." };
        yield { type: "message_done", message: { id: `m${modelCalls}`, role: "assistant", content: [{ type: "text", text: "I give up." }], createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      },
    },
  };
  const ids = ["js-bugfix-offbyone", "py-bugfix-empty-average", "js-feature-titlecase", "js-refactor-extract-fmt"];
  const report = await runBench(baseArgs({ provider: "live", budget: 2, tasks: ids }), { live });
  assert.equal(modelCalls, 2, "exactly the budget, never more");
  assert.equal(report.totals.liveModelCalls, 2);
  const skipped = report.tasks.filter((r) => r.skipped);
  assert.ok(skipped.length >= 1 && skipped.every((r) => /budget spent/.test(r.detail)));
  assert.ok(report.tasks.filter((r) => !r.skipped).every((r) => r.success === false), "a model that does nothing fails the oracle");
});

test("report: renderTable carries the per-task columns the doc quotes", async () => {
  const report = await runBench(baseArgs({ tasks: ["js-feature-titlecase"] }));
  const table = renderTable(report);
  for (const col of ["turns", "calls", "errs", "retry", "diff", "bytes"]) assert.match(table, new RegExp(col));
  assert.match(table, /js-feature-titlecase\s+PASS/);
});
