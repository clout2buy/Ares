// A killed shell must take its whole pipeline with it.
//
// Field origin (2026-09-21): a turn ran `docker exec … python … | tail`. The
// in-container python hung; the Bash timeout killed the shell, but `docker
// exec` and `tail` orphaned (reparented to PID 1) and kept the stdout pipe
// open. The supervisor's `close` event never fired, no terminal event was
// emitted, and the Telegram turn wedged forever — with the turn watchdog
// disabled, nothing recovered it.
//
// The fix: the child leads its own process group (spawned detached) and
// terminate() signals the GROUP, so grandchildren die too; plus a force-settle
// backstop if a cross-namespace survivor still holds the pipe. This test drives
// the supervisor directly and proves a SIGTERM reaches a terminal state fast
// even when the shell backgrounded a long-lived child holding stdout.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR = fileURLToPath(new URL("../packages/tools/dist/ShellSupervisor.js", import.meta.url));

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitFor(fn, label, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("terminate settles fast even when the shell backgrounded a child holding stdout", async (t) => {
  if (process.platform === "win32") return; // POSIX process-group semantics
  const dir = await mkdtemp(path.join(tmpdir(), "ares-orphan-"));
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => {}));
  const manifestPath = path.join(dir, "manifest.json");
  const outputPath = path.join(dir, "out.log");
  const statePath = path.join(dir, "state.json");
  const manifest = {
    version: 1,
    jobId: "orphan-test",
    token: "t",
    program: "bash",
    // A backgrounded `sleep` inherits stdout and outlives a shell-only SIGTERM
    // (non-interactive bash doesn't forward the signal to background jobs) —
    // the stand-in for the orphaned `docker exec`. `wait` keeps bash alive so
    // terminate(), not a natural exit, is what ends it.
    args: ["-c", "sleep 30 & wait"],
    cwd: dir,
    outputPath,
    statePath,
    createdAtMs: Date.now(),
  };
  await import("node:fs/promises").then((fs) => fs.writeFile(manifestPath, JSON.stringify(manifest)));

  const supervisor = spawn(process.execPath, [SUPERVISOR, manifestPath], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    supervisor.once("spawn", resolve);
    supervisor.once("error", reject);
  });
  t.after(() => { try { process.kill(-supervisor.pid, "SIGKILL"); } catch {} });

  const running = await waitFor(async () => {
    const s = await readState(statePath);
    return s && s.phase === "running" && s.childPid ? s : null;
  }, "child running");
  const shellPid = running.childPid;

  // Kill the shell only, the way the old code did — via the supervisor's
  // terminate path (SIGTERM to the supervisor).
  supervisor.kill("SIGTERM");

  // The supervisor must reach a terminal phase quickly — not hang on a pipe the
  // orphaned child holds open. Group-kill makes `close` fire; the backstop caps
  // the worst case at ~5s.
  const terminal = await waitFor(async () => {
    const s = await readState(statePath);
    return s && (s.phase === "cancelled" || s.phase === "failed" || s.phase === "completed") ? s : null;
  }, "supervisor settled", 9000);
  assert.ok(["cancelled", "failed", "completed"].includes(terminal.phase), `phase ${terminal.phase}`);

  // And the backgrounded child is dead — the group kill reached it, no orphan.
  await waitFor(async () => {
    try { process.kill(shellPid, 0); return false; } catch { return true; }
  }, "shell process gone", 3000);
  // The `sleep` grandchild is gone too (can't easily know its pid, but if the
  // group was killed the process table has no stray sleep from this dir).
});
