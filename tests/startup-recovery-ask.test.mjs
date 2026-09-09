// Unfinished work from a previous run is FOUND and OFFERED, never run behind
// the owner's back. Field complaint (2026-09-09): "old projects auto open and
// you can't stop it." The daemon now emits startup_recovery_available when a
// session with pending durable inputs is opened; Resume runs it, Discard
// retires it (cancelled in SQLite), a new message replaces it; mode "auto"
// restores the old behavior and "never" retires without asking.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cli = path.join(root, "packages", "cli", "dist", "entry.js");
const coreUrl = pathToFileURL(path.join(root, "packages", "core", "dist", "index.js")).href;
const { startupRecoveryMode } = await import(pathToFileURL(path.join(root, "packages", "cli", "dist", "uiSettings.js")).href);

test("startupRecoveryMode: env pins, setting next, default ask", () => {
  const prev = process.env.ARES_STARTUP_RECOVERY;
  delete process.env.ARES_STARTUP_RECOVERY;
  try {
    assert.equal(startupRecoveryMode(null), "ask");
    assert.equal(startupRecoveryMode({ startupRecovery: "auto" }), "auto");
    assert.equal(startupRecoveryMode({ startupRecovery: "bogus" }), "ask");
    process.env.ARES_STARTUP_RECOVERY = "never";
    assert.equal(startupRecoveryMode({ startupRecovery: "auto" }), "never");
  } finally {
    if (prev === undefined) delete process.env.ARES_STARTUP_RECOVERY;
    else process.env.ARES_STARTUP_RECOVERY = prev;
  }
});

async function seedPending(workspace, sessionId, inputId, goal) {
  const core = await import(`${coreUrl}?seed=${Date.now()}-${Math.random()}`);
  const seed = await core.SessionKernelStore.open({ filename: core.workspaceSessionKernelPath(workspace) });
  try {
    seed.createSession({ id: sessionId, workspaceKey: workspace, metadata: { provider: "mock-echo", model: "mock-echo", createdAt: new Date().toISOString() } });
    seed.admitInput({ id: inputId, sessionId, idempotencyKey: inputId, delivery: "queue", payload: { content: [{ type: "text", text: goal }] } });
  } finally {
    seed.close();
  }
  return core;
}

function runDaemon(workspace, mode, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "daemon", "--json", "--workspace", workspace, "--provider", "mock", "--model", "mock-echo"], {
      env: { ...process.env, ARES_AGENT_ENABLED: "0", ARES_CODING_PROOF_GATE: "0", ARES_HOME: path.join(workspace, "home"), ARES_OPERATOR_AUTOTICK: "0", ARES_REPO_MAP: "0", ARES_ORICLE: "0", ARES_STARTUP_RECOVERY: mode },
    });
    const events = [];
    let stdout = "";
    let stderr = "";
    let settled = false;
    const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const done = () => (error ? reject(error) : resolve(events));
      if (child.exitCode === null) {
        child.once("close", done);
        child.kill();
      } else done();
    };
    const deadline = setTimeout(() => finish(new Error(`timed out\nstderr=${stderr.slice(-1500)}\nevents=${JSON.stringify(events.slice(-40))}`)), 60_000);
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("error", finish);
    child.on("exit", (code) => { if (!settled && code !== null) finish(new Error(`daemon exited ${code}\n${stderr.slice(-1500)}`)); });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      let nl;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        events.push(event);
        try {
          const verdict = script(event, send, events);
          if (verdict === "done") finish();
        } catch (err) {
          finish(err);
        }
      }
    });
  });
}

test("ask (default): opening the session offers the pending request; Discard retires it; nothing ran", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-recovery-ask-"));
  const sessionId = "ask-session";
  const inputId = "ask-input";
  try {
    const core = await seedPending(workspace, sessionId, inputId, "FINISH THE MIGRATION please");
    let discarded = false;
    const events = await runDaemon(workspace, "ask", (e, send) => {
      if (e.type === "daemon_ready") send({ type: "session_open", sessionId });
      if (e.type === "startup_recovery_available" && e.sessionId === sessionId) {
        assert.deepEqual(e.inputIds, [inputId]);
        assert.equal(e.count, 1);
        assert.match(e.previews[0].goal, /FINISH THE MIGRATION/);
        send({ type: "startup_recovery_discard", sessionId });
      }
      if (e.type === "startup_recovery_discarded" && e.sessionId === sessionId) {
        discarded = true;
        assert.deepEqual(e.inputIds, [inputId]);
        return "done";
      }
      return undefined;
    });
    assert.ok(discarded);
    assert.ok(!events.some((e) => e.type === "turn_start" && e.sessionId === sessionId), "no model turn ran");
    assert.ok(!events.some((e) => e.type === "startup_recovery_preparing" || e.type === "startup_recovery_queued"), "never claimed for execution");
    const store = await core.SessionKernelStore.open({ filename: core.workspaceSessionKernelPath(workspace) });
    try {
      assert.equal(store.getInput(inputId).state, "cancelled", "retired durably");
    } finally {
      store.close();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ask: Resume runs exactly the offered request", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-recovery-resume-"));
  const sessionId = "resume-session";
  const inputId = "resume-input";
  try {
    await seedPending(workspace, sessionId, inputId, "RESUME-MARKER continue");
    const events = await runDaemon(workspace, "ask", (e, send) => {
      if (e.type === "daemon_ready") send({ type: "session_open", sessionId });
      if (e.type === "startup_recovery_available" && e.sessionId === sessionId) send({ type: "startup_recovery_resume", sessionId });
      if (e.type === "turn_end" && e.sessionId === sessionId) return "done";
      return undefined;
    });
    assert.ok(events.some((e) => e.type === "startup_recovery_queued" && e.sessionId === sessionId));
    const turn = events.find((e) => e.type === "turn_start" && e.sessionId === sessionId);
    assert.ok(turn, "the offered request ran after Resume");
    assert.match(JSON.stringify(turn), /RESUME-MARKER/);
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("never: pending work is retired on open without asking", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-recovery-never-"));
  const sessionId = "never-session";
  const inputId = "never-input";
  try {
    await seedPending(workspace, sessionId, inputId, "should not run");
    const events = await runDaemon(workspace, "never", (e, send) => {
      if (e.type === "daemon_ready") send({ type: "session_open", sessionId });
      if (e.type === "startup_recovery_discarded" && e.sessionId === sessionId) return "done";
      return undefined;
    });
    assert.ok(!events.some((e) => e.type === "startup_recovery_available"));
    assert.ok(!events.some((e) => e.type === "turn_start" && e.sessionId === sessionId));
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
