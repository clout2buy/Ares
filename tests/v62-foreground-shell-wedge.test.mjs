// A foreground command must always settle, however badly it behaves.
//
// 2026-09-22, in production: `docker exec -i doingbot python3 - <<'PY'` hung in
// the container. runShell spawned without a process group and killed only the
// shell, so the exec orphaned to PID 1 still holding our stdout pipe. `close`
// never fired, the promise never resolved, and the turn sat wedged for
// 18 minutes until the turn watchdog interrupted it — with a queued message
// stuck behind it the whole time. The background supervisor had been fixed for
// exactly this the day before; the foreground path had not.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { runShell } from "../packages/tools/dist/Bash.js";

const posix = process.platform !== "win32";
const never = () => new AbortController().signal;
const running = (pat) => execFileSync("bash", ["-lc", `pgrep -f '${pat}' || true`], { encoding: "utf8" }).trim();

/** Wait for a process tree to actually be reaped. killTree escalates SIGTERM →
 *  SIGKILL over a couple of seconds, so "gone" is a promise about the tree, not
 *  about the first 300ms. */
async function gone(pattern, budgetMs = 8_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const left = running(pattern);
    if (!left) return;
    if (Date.now() > deadline) assert.fail(`still running after ${budgetMs}ms: ${left}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("a timed-out pipeline settles, and takes its grandchildren with it", { skip: !posix }, async () => {
  const started = Date.now();
  // `sleep | cat`: bash does not forward signals to a pipeline with job
  // control off, so killing only the shell leaves both alive on our pipe.
  const out = await runShell("bash", ["-lc", "sleep 45 | cat"], process.cwd(), 400, never());
  const took = Date.now() - started;
  assert.equal(out.timedOut, true);
  assert.ok(took < 8_000, `settled in ${took}ms, not wedged`);
  // The turn is only safe if the tree is actually gone, not just abandoned.
  await gone("sleep 4[5]");  // no sleep survives the group kill
});

test("a backgrounded grandchild holding the pipe cannot outlive the kill", { skip: !posix }, async () => {
  const out = await runShell("bash", ["-lc", "sleep 46 & sleep 46"], process.cwd(), 400, never());
  assert.equal(out.timedOut, true);
  await gone("sleep 4[6]");  // the backgrounded child dies with the group
});

test("a survivor outside the process group settles the turn anyway", { skip: !posix }, async () => {
  // setsid puts the child in its OWN session, so our group kill cannot reach
  // it — the same shape as a process inside a container reached via
  // `docker exec`. It keeps stdout open; without the backstop this hangs
  // forever, which is precisely what happened in production.
  const started = Date.now();
  const out = await runShell("bash", ["-lc", "setsid sleep 47 & sleep 47"], process.cwd(), 300, never());
  const took = Date.now() - started;
  assert.equal(out.timedOut, true, "still reported as a timeout");
  assert.ok(took < 12_000, `force-settled in ${took}ms instead of hanging`);
  assert.match(out.hint ?? "", /held the output pipe open/, "and says why the output is partial");
  try { execFileSync("bash", ["-lc", "pkill -f 'sleep 4[7]' || true"]); } catch { /* cleanup */ }
});

test("a command that reads stdin gets EOF instead of blocking forever", { skip: !posix }, async () => {
  const started = Date.now();
  // Nothing ever writes to this command's stdin. Leaving it open meant `cat`
  // waited for input that could never come, burning the whole timeout.
  const out = await runShell("bash", ["-lc", "cat"], process.cwd(), 20_000, never());
  const took = Date.now() - started;
  assert.equal(out.timedOut, false, "it ended on its own, not on the timeout");
  assert.equal(out.exitCode, 0);
  assert.ok(took < 5_000, `returned in ${took}ms`);
});

test("abort kills the group too, not just the shell", { skip: !posix }, async () => {
  const controller = new AbortController();
  const run = runShell("bash", ["-lc", "sleep 48 | cat"], process.cwd(), 60_000, controller.signal);
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  await run;
  assert.ok(Date.now() - started < 9_000, "interrupt settles promptly");
  await gone("sleep 4[8]");  // stopping a turn actually stops the work
});

test("an ordinary command is unaffected", async () => {
  const out = await runShell(process.platform === "win32" ? "cmd" : "bash",
    process.platform === "win32" ? ["/c", "echo hi"] : ["-lc", "echo hi"], process.cwd(), 10_000, never());
  assert.equal(out.exitCode, 0);
  assert.equal(out.timedOut, false);
  assert.match(out.stdout, /hi/);
});
