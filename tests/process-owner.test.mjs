// Every process an agent starts is owned by its session.
//
// Field origin (2026-10-26): Rust services ran for days on a coworker's
// machine, launched by agent shell commands that had long since exited —
// invisible (only run_in_background jobs were registered) and never stopped
// (closing a session cleaned up nothing). Contract under test:
//   (1) pickSurvivors finds what a finished command left behind — children of
//       the dead shell, grandchildren through other new processes, and the
//       `cmd /c start` case (a wrapper that died) — and nothing the user
//       launched themselves or the OS spawned on its own;
//   (2) mayDetachProcesses gates the listing on commands that could detach;
//   (3) ShellRegistry.adopt makes a found tree a real job: listed with the
//       launching command, stoppable, stopped by Stop all and by the host's
//       suspend sweep, never offered back as "resumable";
//   (4) the real thing: a wrapper that detaches a child and exits leaves a
//       survivor that findSurvivors/adoptLeftovers pick up on this platform.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ShellRegistry,
  adoptLeftovers,
  findSurvivors,
  mayDetachProcesses,
  parsePsRows,
  parseWindowsRows,
  pickSurvivors,
} from "../packages/tools/dist/index.js";
import { openWorkspaceSessionKernel } from "../packages/core/dist/index.js";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 10_000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── (1) selection ──────────────────────────────────────────────────────

test("pickSurvivors: the dead shell's children, grandchildren through new processes, and dead-wrapper launches are ours; user and OS processes are not", () => {
  const T0 = 1_000_000;
  const row = (pid, ppid, name, createdAtMs = T0 + 100, commandLine = name) => ({ pid, ppid, name, commandLine, createdAtMs });
  const rows = [
    row(50, 1, "explorer.exe", T0 - 99_999),          // old, alive: the user's desktop
    row(100, 50, "bash.exe", T0 - 10),                // the command's shell (dead by now)
    row(200, 100, "node.exe"),                        // `npx electron . &` — npx, child of the shell
    row(201, 200, "electron.exe"),                    // electron under npx
    row(202, 201, "electron.exe", T0 + 120, "electron --type=renderer"), // a renderer: descendant, not a root
    row(300, 999, "cargo-backend.exe"),               // `cmd /c start backend` — cmd (999) already died
    row(301, 300, "conhost.exe"),                     // console host under the backend
    row(400, 50, "chrome.exe", T0 + 150),             // the user opened a browser meanwhile: parent alive and old
    row(500, 999, "conhost.exe"),                     // noise with a dead parent
    row(600, 100, "old-thing.exe", T0 - 60_000),      // created long before the command
  ];
  const aliveSet = new Set([50, 200, 201, 202, 300, 301, 400, 500, 600]);
  const picked = pickSurvivors(rows, { rootPid: 100, startedAtMs: T0, selfPid: 1, alive: (pid) => aliveSet.has(pid) });
  assert.deepEqual(picked.map((t) => t.pid).sort((a, b) => a - b), [200, 300], JSON.stringify(picked));
  assert.equal(picked.find((t) => t.pid === 200).descendants, 2, "electron and its renderer die with npx");
  assert.equal(picked.find((t) => t.pid === 300).descendants, 1, "conhost dies with the backend");
});

test("pickSurvivors: nothing when the command left nothing; a dead candidate is skipped", () => {
  const rows = [{ pid: 7, ppid: 1, name: "x", commandLine: "x", createdAtMs: 5_000 }];
  assert.deepEqual(pickSurvivors(rows, { rootPid: 1, startedAtMs: 4_000, selfPid: 2, alive: () => false }), []);
  assert.deepEqual(pickSurvivors([], { rootPid: 1, startedAtMs: 4_000, selfPid: 2, alive: () => true }), []);
});

// ─── (2) the gate ───────────────────────────────────────────────────────

test("mayDetachProcesses: detaching and server-ish commands yes, ordinary commands no", () => {
  for (const cmd of [
    "Start-Process npx.cmd -ArgumentList electron,. -WindowStyle Hidden",
    "cmd /c start \"\" backend.exe",
    "nohup ./target/release/netgraph > out.log 2>&1 &",
    "(npx electron . &)",
    "cargo run --release",
    "go run ./cmd/server",
    "java -jar app.jar",
    "npm run dev",
    "python -m http.server 8080",
    "docker compose up -d",
  ]) assert.equal(mayDetachProcesses(cmd), true, cmd);
  for (const cmd of [
    "git status",
    "ls -la",
    "cat package.json",
    "pnpm build",
    "node --test tests/x.test.mjs",
    "grep -rn foo src && echo ok",
  ]) assert.equal(mayDetachProcesses(cmd), false, cmd);
});

// ─── parsers ────────────────────────────────────────────────────────────

test("parsers: Windows JSON (object or array) and ps etime rows", () => {
  const one = parseWindowsRows('{"ProcessId":12,"ParentProcessId":3,"Name":"a.exe","CommandLine":"a.exe --x","Created":1700000000000}');
  assert.deepEqual(one, [{ pid: 12, ppid: 3, name: "a.exe", commandLine: "a.exe --x", createdAtMs: 1700000000000 }]);
  assert.equal(parseWindowsRows("[]").length, 0);
  assert.equal(parseWindowsRows("not json").length, 0);
  const now = 10_000_000;
  const ps = parsePsRows("  12   3 01:02:03 node node server.js\n  13  12 2-00:00:10 java java -jar x.jar\n 14 1 05 sleep sleep 60\n", now);
  assert.equal(ps[0].createdAtMs, now - (3600 + 120 + 3) * 1000);
  assert.equal(ps[1].createdAtMs, now - (2 * 86400 + 10) * 1000);
  assert.equal(ps[1].commandLine, "java -jar x.jar");
  assert.equal(ps[2].createdAtMs, now - 5_000);
});

// ─── (3) the registry owns adopted trees ───────────────────────────────

function sleeperDetached(spawned) {
  // A detached, unref'd sleeper: exactly the orphan shape — nobody waits on it.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true, detached: true });
  child.unref();
  spawned.push(child);
  return child;
}

test("legacy registry: an adopted process is listed as running with its launcher, Stop all kills it, and it is never resumable", async (t) => {
  const spawned = [];
  t.after(() => { for (const c of spawned) { try { process.kill(c.pid); } catch { /* gone */ } } });
  const registry = new ShellRegistry();
  const victim = sleeperDetached(spawned);
  await sleep(100);
  const snap = await registry.adopt({ pid: victim.pid, name: "node.exe", commandLine: "node -e setTimeout", cwd: process.cwd(), launchedBy: "cmd /c start node server.js" });
  assert.equal(snap.status, "running");
  assert.equal(snap.adopted, true);
  assert.equal(snap.pid, victim.pid);
  assert.match(snap.description, /^node — left running by: cmd \/c start node server\.js$/);
  assert.equal(registry.list().filter((j) => j.status === "running").length, 1);
  const stopped = await registry.stopAllForSession("");
  assert.equal(stopped, 1);
  await waitFor(() => !alive(victim.pid), 10_000, "the adopted process to die");
  assert.equal(registry.get(snap.id).status, "killed");
  // a second adopted process that exits on its own reads as exited, not running
  const quick = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore", windowsHide: true });
  spawned.push(quick);
  const q = await registry.adopt({ pid: quick.pid, name: "node", cwd: process.cwd(), launchedBy: "x" });
  await waitFor(() => !alive(quick.pid), 10_000, "the quick process to exit");
  assert.equal(registry.get(q.id).status, "exited");
  await assert.rejects(() => registry.adopt({ pid: quick.pid, name: "node", cwd: process.cwd(), launchedBy: "x" }), /not running/);
});

test("durable registry: an adopted tree survives as a record, suspends as NOT resumable, and shows up in the session's list", async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ares-adopt-"));
  const kernel = await openWorkspaceSessionKernel(workspace);
  const spawned = [];
  t.after(async () => {
    for (const c of spawned) { try { process.kill(c.pid); } catch { /* gone */ } }
    try { kernel.close(); } catch { /* closed */ }
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });
  const sessionId = `sess_adopt_${Math.random().toString(36).slice(2, 10)}`;
  kernel.createSession({ id: sessionId, workspaceKey: workspace });
  const registry = new ShellRegistry();
  registry.configureDurability({ kernel, workspace });
  registry.registerSession(sessionId);
  const victim = sleeperDetached(spawned);
  await sleep(100);
  const snap = await registry.adopt({ pid: victim.pid, name: "netgraph.exe", commandLine: "netgraph.exe --port 8477", cwd: workspace, launchedBy: "Start-Process netgraph.exe", sessionId, invocationKey: "tool_1" });
  assert.equal(snap.status, "running");
  assert.equal(snap.adopted, true);
  assert.equal(snap.launchedBy, "Start-Process netgraph.exe");
  assert.equal(snap.command, "netgraph.exe --port 8477");
  // idempotent per (tool call, pid)
  const again = await registry.adopt({ pid: victim.pid, name: "netgraph.exe", cwd: workspace, launchedBy: "Start-Process netgraph.exe", sessionId, invocationKey: "tool_1" });
  assert.equal(again.id, snap.id);
  assert.equal(registry.list(sessionId).filter((j) => j.status === "running").length, 1);
  // a fresh registry (restart) still sees it
  const reborn = new ShellRegistry();
  reborn.configureDurability({ kernel, workspace });
  const seen = reborn.list(sessionId).find((j) => j.id === snap.id);
  assert.equal(seen?.status, "running");
  assert.equal(seen?.adopted, true);
  // the host closing stops it for good
  const suspended = await reborn.suspendForSession(sessionId, { reason: "Ares closed" });
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0].resumable, undefined, "an adopted process is stopped, never offered back");
  assert.equal(suspended[0].stoppedReason, "Ares closed");
  await waitFor(() => !alive(victim.pid), 10_000, "the adopted process to die with the host");
  await assert.rejects(() => reborn.resume(snap.id, sessionId), /adopted, not launched/);
  assert.equal(reborn.list(sessionId).filter((j) => j.status === "running").length, 0);
});

// ─── (4) the real thing on this platform ───────────────────────────────

const detachingWrapper = () => [
  "-e",
  "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{detached:true,stdio:'ignore',windowsHide:true});c.unref();console.log(c.pid)",
];

test("a wrapper that detaches a child and exits leaves a survivor that is found, adopted, and stopped", { timeout: 60_000 }, async (t) => {
  const startedAtMs = Date.now();
  const wrapper = spawn(process.execPath, detachingWrapper(), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  wrapper.stdout.on("data", (d) => { out += d; });
  const wrapperPid = wrapper.pid;
  await new Promise((resolve) => wrapper.once("close", resolve));
  const orphanPid = Number(out.trim());
  t.after(() => { try { process.kill(orphanPid); } catch { /* gone */ } });
  assert.ok(orphanPid > 0 && alive(orphanPid), "the wrapper left a live orphan");
  assert.ok(!alive(wrapperPid), "the wrapper itself is gone");

  const trees = await findSurvivors({ rootPid: wrapperPid, startedAtMs });
  const found = trees.find((tree) => tree.pid === orphanPid);
  assert.ok(found, `the orphan is among the survivors: ${JSON.stringify(trees)}`);

  const registry = new ShellRegistry();
  const adopted = await adoptLeftovers({ registry, rootPid: wrapperPid, startedAtMs, command: "node wrapper.js", cwd: process.cwd() });
  const mine = adopted.find((job) => job.pid === orphanPid);
  assert.ok(mine, "the orphan was adopted");
  assert.equal(mine.adopted, true);
  assert.equal(mine.launchedBy, "node wrapper.js");
  assert.equal(await registry.stopAllForSession(""), adopted.length);
  await waitFor(() => !alive(orphanPid), 10_000, "Stop all to kill the orphan");
});
