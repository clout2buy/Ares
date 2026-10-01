// CodingBackend hardening - run identity, result card, isolation, model/effort
// passthrough, graceful stop, and "never double-run a retried call".
// A fake spawn stands in for the CLI; its router may edit the workspace to
// simulate what the harness did. No real CLI is installed or run.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { makeCodingBackendTool, BACKENDS } from "../packages/tools/dist/index.js";
import { summarizeBackendLine, extractSessionId, classifyPriorRun, runKeyFor, thinkingBudgetFor } from "../packages/tools/dist/codingBackendRun.js";

const BASE = "https://www.doingteam.com";
const TOKEN = "ares_acct_tok_test";
const SESSION = "sess-abc123def";

const stream = (extra = []) =>
  [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.txt" } }] } }),
    ...extra,
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Changed a.txt." }),
  ].join("\n") + "\n";

/** router(cmd,args,opts) -> {code?, stdout?, hold?:true} ; sync side effects allowed. */
function fakeSpawn(router) {
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.pid = 4242;
    child.kills = [];
    const rec = { cmd, args, cwd: opts?.cwd, env: opts?.env ?? {}, child };
    fn.calls.push(rec);
    const res = router(cmd, args, opts, child) ?? { code: 0 };
    child.kill = (sig) => {
      child.kills.push(sig);
      if (res.hold && res.dieOn === sig) queueMicrotask(() => child.emit("close", null));
    };
    if (!res.hold) {
      queueMicrotask(() => {
        if (res.error) return void child.emit("error", new Error(res.error));
        if (res.stdout) child.stdout.emit("data", Buffer.from(res.stdout));
        child.emit("close", res.code ?? 0);
      });
    }
    return child;
  };
  fn.calls = [];
  fn.runs = () => fn.calls.filter((c) => c.cmd === "claude" && c.args.includes("-p"));
  return fn;
}

const okRouter = (edit) => (cmd, args, opts) => {
  if (args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
  if (args.includes("--help")) return { code: 0, stdout: "Usage: claude\n" };
  if (args.includes("-p")) {
    edit?.(opts);
    return { code: 0, stdout: stream() };
  }
  return { code: 0 };
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
async function repo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-elite-cb-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  await fs.writeFile(path.join(dir, "a.txt"), "one\n");
  await fs.writeFile(path.join(dir, ".gitignore"), ".ares/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

async function until(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const ctx = (workspace, extra = {}) => ({
  workspace,
  sessionId: "sess_cb",
  signal: new AbortController().signal,
  permissionMode: "bypass",
  fileReadStamps: new Map(),
  emitProgress: () => {},
  ...extra,
});
const input = (over = {}) => ({ task: "change a.txt", backend: "claude", allow_install: false, offer: false, isolate: false, verify: true, ...over });
const tool = (spawnImpl, extra = {}) => makeCodingBackendTool({ gatewayBase: BASE, gatewayToken: TOKEN, defaultModel: "ares-internal", spawnImpl, ...extra });

// ----------------------------------------------------------------- result card

test("card: records what the run changed and re-runs the tests; green tests => tests-passed", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "one\ntwo\n")));
  const res = await tool(spawn).call(input({ verify_command: 'node -e "process.exit(0)"' }), ctx(dir));
  const card = res.output.card;
  assert.equal(card.status, "completed");
  assert.equal(card.git.filesChanged, 1);
  assert.deepEqual(card.git.files.map((f) => f.path), ["a.txt"]);
  assert.equal(card.git.added, 1);
  assert.equal(card.tests.exitCode, 0);
  assert.equal(card.verification, "tests-passed");
  assert.equal(card.sessionId, SESSION);
  assert.match(res.output.summary, /Result card/);
  assert.match(res.output.summary, /re-ran the project tests/);
});

test("card: red tests after the run are reported honestly (tests-failed), not buried", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "broken\n")));
  const res = await tool(spawn).call(input({ verify_command: 'node -e "console.log(\'not ok 1 - boom\');process.exit(1)"' }), ctx(dir));
  assert.equal(res.output.card.verification, "tests-failed");
  assert.match(res.output.summary, /FAILED - the project tests do not pass/);
  assert.match(res.display, /TESTS FAIL/);
});

test("card: no test command => UNVERIFIED wording; an untouched tree => no-changes; verify:false skips the re-run", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "new.txt"), "n\n")));
  const none = await tool(spawn).call(input(), ctx(dir));
  assert.equal(none.output.card.verification, "no-test-command");
  assert.match(none.output.summary, /UNVERIFIED/);

  const dir2 = await repo();
  const noop = await tool(fakeSpawn(okRouter())).call(input(), ctx(dir2));
  assert.equal(noop.output.card.verification, "no-changes");

  const dir3 = await repo();
  const skipped = await tool(fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "x\n")))).call(input({ verify: false }), ctx(dir3));
  assert.equal(skipped.output.card.verification, "not-run");
  assert.equal(skipped.output.card.tests, undefined);
});

test("card: files that were already dirty before the run are not attributed to it", async () => {
  const dir = await repo();
  await fs.writeFile(path.join(dir, "preexisting.txt"), "mine\n");
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "two\n")));
  const res = await tool(spawn).call(input({ verify: false }), ctx(dir));
  assert.deepEqual(res.output.card.git.untracked, []);
  assert.deepEqual(res.output.card.git.files.map((f) => f.path), ["a.txt"]);
});

// ----------------------------------------------------------------- never double-run

test("a retried call (same toolUseId) replays the completed run; the CLI is NOT started again", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "two\n")));
  const t = tool(spawn);
  const first = await t.call(input({ verify: false }), ctx(dir, { toolUseId: "toolu_RETRY1" }));
  assert.equal(first.output.replayed, undefined);
  assert.equal(spawn.runs().length, 1);
  const second = await t.call(input({ verify: false }), ctx(dir, { toolUseId: "toolu_RETRY1" }));
  assert.equal(second.output.replayed, true);
  assert.equal(spawn.runs().length, 1, "no second CLI process");
  assert.match(second.output.summary, /already completed earlier/);
  // A different tool call id is a new run.
  await t.call(input({ verify: false }), ctx(dir, { toolUseId: "toolu_OTHER" }));
  assert.equal(spawn.runs().length, 2);
});

test("a run record whose CLI is still alive blocks a second start (a restart never double-runs)", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter());
  const key = runKeyFor({ toolUseId: "toolu_LIVE", workspace: dir, backend: "claude", model: "ares-internal", task: "change a.txt" }).key;
  await fs.mkdir(path.join(dir, ".ares", "backend-runs"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".ares", "backend-runs", `${key}.json`),
    JSON.stringify({ key, backend: "claude", task: "t", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerPid: process.pid + 1, childPid: process.pid }),
  );
  await assert.rejects(() => tool(spawn).call(input(), ctx(dir, { toolUseId: "toolu_LIVE" })), /still active/);
  assert.equal(spawn.runs().length, 0);
});

test("an interrupted run resumes the harness session instead of starting from scratch", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "two\n")));
  const key = runKeyFor({ toolUseId: "toolu_DEAD", workspace: dir, backend: "claude", model: "ares-internal", task: "change a.txt" }).key;
  await fs.mkdir(path.join(dir, ".ares", "backend-runs"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".ares", "backend-runs", `${key}.json`),
    JSON.stringify({ key, backend: "claude", task: "t", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerPid: 2147483000, childPid: 2147483001, sessionId: "sess-previous-1" }),
  );
  const res = await tool(spawn).call(input({ verify: false }), ctx(dir, { toolUseId: "toolu_DEAD" }));
  const run = spawn.runs()[0];
  assert.ok(run.args.includes("--resume"));
  assert.equal(run.args[run.args.indexOf("--resume") + 1], "sess-previous-1");
  assert.equal(res.output.card.resumed, true);
});

test("two concurrent runs in one workspace: the second is refused", async () => {
  const dir = await repo();
  let release;
  const gate = new Promise((r) => (release = r));
  const spawn = fakeSpawn((cmd, args, opts, child) => {
    if (args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
    if (args.includes("--help")) return { code: 0, stdout: "Usage: claude\n" };
    if (args.includes("-p")) {
      gate.then(() => {
        child.stdout.emit("data", Buffer.from(stream()));
        child.emit("close", 0);
      });
      return { hold: true };
    }
    return { code: 0 };
  });
  const t = tool(spawn);
  const first = t.call(input({ verify: false }), ctx(dir, { toolUseId: "toolu_A" }));
  await until(() => spawn.runs().length > 0);
  await assert.rejects(() => t.call(input({ task: "other", verify: false }), ctx(dir, { toolUseId: "toolu_B" })), /Another CodingBackend run/);
  release();
  assert.equal((await first).output.status, "completed");
});

test("classifyPriorRun: completed replays only for a tool-call key; failed/timed-out runs resume", () => {
  const card = { summary: "x" };
  assert.equal(classifyPriorRun({ key: "k", status: "completed", card }, true).kind, "replay");
  assert.equal(classifyPriorRun({ key: "k", status: "completed", card }, false).kind, "fresh");
  assert.equal(classifyPriorRun({ key: "k", status: "timed_out", ownerPid: 1 }, true).kind, "resume");
  assert.equal(classifyPriorRun(null, true).kind, "fresh");
});

// ----------------------------------------------------------------- isolation, model, effort

test("isolate: the harness runs in its own worktree + branch; the live checkout is untouched", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter((o) => writeFileSync(path.join(o.cwd, "a.txt"), "isolated\n")));
  const res = await tool(spawn).call(input({ isolate: true, verify: false }), ctx(dir));
  const run = spawn.runs()[0];
  assert.notEqual(path.resolve(run.cwd), path.resolve(dir));
  assert.match(run.cwd.replace(/\\/g, "/"), /\.ares\/backend-runs\/.+\/wt$/);
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "one\n", "live checkout untouched");
  assert.equal(await fs.readFile(path.join(run.cwd, "a.txt"), "utf8"), "isolated\n");
  assert.match(res.output.card.isolation.branch, /^ares\/backend-/);
  assert.match(res.output.summary, /review and merge it yourself/);
  assert.equal(res.output.card.git.filesChanged, 1);
});

test("isolate: refuses cleanly outside a git repo", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-elite-nogit-"));
  await assert.rejects(() => tool(fakeSpawn(okRouter())).call(input({ isolate: true }), ctx(dir)), /isolate needs a git repository/);
});

test("model and effort are passed through (claude --model + thinking budget; codex reasoning effort)", async () => {
  const dir = await repo();
  const spawn = fakeSpawn(okRouter());
  await tool(spawn).call(input({ model: "claude-sonnet-5-5", effort: "high", verify: false }), ctx(dir));
  const run = spawn.runs()[0];
  assert.equal(run.args[run.args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(run.env.MAX_THINKING_TOKENS, String(thinkingBudgetFor("high")));
  assert.equal(run.env.ANTHROPIC_MODEL, "claude-sonnet-5-5");

  const args = BACKENDS.codex.runArgs(BASE, "m", { effort: "low" });
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.equal(args[args.length - 1], "-");
  assert.ok(!BACKENDS.codex.runArgs(BASE, "m").some((a) => a.includes("model_reasoning_effort")));
  // A malformed model string is not smuggled onto argv.
  assert.ok(!BACKENDS.claude.runArgs(BASE, "m", { model: "x; rm -rf /" }).includes("--model"));
});

// ----------------------------------------------------------------- graceful stop / timeout

test("abort: SIGTERM first, SIGKILL only after the grace window; the run is reported stopped and resumable", async () => {
  const dir = await repo();
  const prev = process.env.ARES_BACKEND_STOP_GRACE_MS;
  process.env.ARES_BACKEND_STOP_GRACE_MS = "120";
  try {
    const ac = new AbortController();
    const spawn = fakeSpawn((cmd, args) => {
      if (args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
      if (args.includes("--help")) return { code: 0, stdout: "Usage: claude\n" };
      if (args.includes("-p")) return { hold: true, dieOn: "SIGKILL" };
      return { code: 0 };
    });
    const p = tool(spawn).call(input({ verify: false }), ctx(dir, { signal: ac.signal, toolUseId: "toolu_ABORT" }));
    await until(() => spawn.runs().length > 0);
    const child = spawn.runs()[0].child;
    child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }) + "\n"));
    ac.abort();
    await assert.rejects(() => p, /was stopped[\s\S]*resumes the harness session/);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
    const rec = JSON.parse(await fs.readFile(path.join(dir, ".ares", "backend-runs", `${runKeyFor({ toolUseId: "toolu_ABORT", workspace: dir, backend: "claude", model: "ares-internal", task: "change a.txt" }).key}.json`), "utf8"));
    assert.equal(rec.status, "interrupted");
    assert.equal(rec.sessionId, SESSION);
  } finally {
    if (prev === undefined) delete process.env.ARES_BACKEND_STOP_GRACE_MS;
    else process.env.ARES_BACKEND_STOP_GRACE_MS = prev;
  }
});

test("timeout: a hung harness is stopped gracefully; the failure carries the result card", async () => {
  const dir = await repo();
  const prev = process.env.ARES_BACKEND_STOP_GRACE_MS;
  process.env.ARES_BACKEND_STOP_GRACE_MS = "60";
  try {
    const spawn = fakeSpawn((cmd, args, opts) => {
      if (args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
      if (args.includes("--help")) return { code: 0, stdout: "Usage: claude\n" };
      if (args.includes("-p")) {
        writeFileSync(path.join(opts.cwd, "a.txt"), "partial\n");
        return { hold: true, dieOn: "SIGKILL" };
      }
      return { code: 0 };
    });
    await assert.rejects(
      () => tool(spawn, { runTimeoutMs: 80 }).call(input({ verify: false }), ctx(dir)),
      (err) => /timed out/.test(err.message) && /Result card/.test(err.message) && /a\.txt/.test(err.message),
    );
    assert.deepEqual(spawn.runs()[0].child.kills, ["SIGTERM", "SIGKILL"]);
  } finally {
    if (prev === undefined) delete process.env.ARES_BACKEND_STOP_GRACE_MS;
    else process.env.ARES_BACKEND_STOP_GRACE_MS = prev;
  }
});

// ----------------------------------------------------------------- progress

test("progress: stream-json becomes short human summaries; JSON split across chunks is reassembled", async () => {
  const dir = await repo();
  const events = [];
  const full = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }] } });
  const spawn = fakeSpawn((cmd, args, opts, child) => {
    if (args.includes("--version")) return { code: 0, stdout: "1.0.0\n" };
    if (args.includes("--help")) return { code: 0, stdout: "Usage: claude\n" };
    if (args.includes("-p")) {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(full.slice(0, 40)));
        child.stdout.emit("data", Buffer.from(`${full.slice(40)}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" })}\n`));
        child.emit("close", 0);
      });
      return { hold: true };
    }
    return { code: 0 };
  });
  await tool(spawn).call(input({ verify: false }), ctx(dir, { emitProgress: (e) => events.push(e) }));
  const lines = events.filter((e) => e.phase === "running" && e.line).map((e) => e.summary);
  assert.ok(lines.includes("Edit src/a.ts"), JSON.stringify(lines));
  assert.equal(summarizeBackendLine("claude", JSON.stringify({ type: "result", subtype: "success" })), "finished (success)");
  assert.equal(extractSessionId(JSON.stringify({ type: "system", session_id: "abcdef123456" })), "abcdef123456");
  assert.equal(extractSessionId('{"session_id":"bad id!"}'), undefined);
});
