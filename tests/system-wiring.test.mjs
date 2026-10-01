// The composition the garrison uses (systemWiring.ts), driven with fake live
// objects and exposed through the real RemoteAgentServer: the session event tap
// feeds provider breakers and the error ring, the hourly tick runs housekeeping
// and tonight's backup, a failed backup reaches the phone, and the stop button
// reaches the session manager.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createSystemSignals, startSystemSurfaces, instancesSource, connectorsSource } from "../packages/cli/dist/systemWiring.js";
import { SessionKernelStore } from "../packages/core/dist/index.js";

const auth = { authorization: "Bearer tok", "content-type": "application/json" };

async function rig(t, over = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-wire-test-"));
  const home = path.join(root, "home", ".ares");
  const ws = path.join(root, "ws");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(path.join(ws, ".ares"), { recursive: true });
  await fsp.writeFile(path.join(home, "config.json"), JSON.stringify({ a: 1 }));
  await fsp.mkdir(path.join(home, "vault"), { recursive: true });
  await fsp.writeFile(path.join(home, "vault", "k"), "secret-value");
  const prev = { dir: process.env.ARES_BACKUP_DIR, hour: process.env.ARES_BACKUP_HOUR, max: process.env.ARES_BACKUP_MAX_MB, key: process.env.ARES_BACKUP_KEY };
  process.env.ARES_BACKUP_DIR = path.join(root, "backups");
  process.env.ARES_BACKUP_HOUR = "0";
  process.env.ARES_ALERT_QUIET = "off"; // the box's clock may be inside the owner's quiet hours
  delete process.env.ARES_BACKUP_KEY;
  const kernel = await SessionKernelStore.open({ filename: path.join(ws, ".ares", "session-kernel.sqlite") });
  const sent = [];
  const stopped = [];
  const signals = createSystemSignals();
  const sessions = {
    list: () => [{ id: "s1", busy: true }],
    runningTurns: () => [{ sessionId: "s1", title: "Build", startedAt: new Date(Date.now() - 30_000).toISOString(), currentTool: "Bash" }],
    pendingPermissionList: () => [],
    interrupt: (id) => { if (id === "gone") throw new Error("unknown session"); stopped.push(id); return id === "s1"; },
  };
  const surfaces = startSystemSurfaces({
    home,
    workspace: ws,
    signals,
    sessions,
    scheduler: () => ({ jobStatus: () => [{ name: "housekeeping", schedule: "every 1h", enabled: true, paused: false, running: false }] }),
    approvalsPending: () => 0,
    push: () => ({ configured: true, send: async (m) => { sent.push(m); }, list: async () => [{ token: "x" }] }),
    tunnel: () => ({ linkScope: () => "public", linkBaseUrl: () => "https://x.example.com" }),
    connectors: async () => ({}),
    kernel,
    activeTurns: () => 0,
    log: () => {},
    ...over,
  });
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", phoneApi: { system: surfaces.api } });
  await server.start();
  t.after(async () => {
    surfaces.stop();
    await server.close();
    try { kernel.close(); } catch { /* closed */ }
    for (const [k, v] of [["ARES_BACKUP_DIR", prev.dir], ["ARES_BACKUP_HOUR", prev.hour], ["ARES_BACKUP_MAX_MB", prev.max], ["ARES_BACKUP_KEY", prev.key], ["ARES_ALERT_QUIET", undefined]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, home, ws, surfaces, sent, stopped, signals, base: `http://127.0.0.1:${server.port}`, kernel };
}

const get = async (r, p) => (await fetch(`${r.base}${p}`, { headers: auth })).json();

test("the session event tap feeds the error ring and the provider breakers", async (t) => {
  const r = await rig(t);
  const err = (code, message) => ({ type: "error", error: { code, message, retriable: false } });
  for (let i = 0; i < 3; i++) r.signals.onEvent({ sessionId: "s1", provider: "anthropic", event: err("provider_throw", "529 overloaded Authorization: Bearer abcdefghijklmnop1234") });
  r.signals.onEvent({ sessionId: "s1", provider: "deepseek", event: err("loop_detected", "same call again") });
  r.signals.onEvent({ sessionId: "s1", provider: "ollama", event: { type: "turn_end", status: "completed" } });
  const snap = await get(r, "/gateway/system?fresh=1");
  const by = Object.fromEntries(snap.providers.map((p) => [p.provider, p]));
  assert.equal(by.anthropic.state, "open");
  assert.equal(by.anthropic.consecutiveFailures, 3);
  assert.equal(by.deepseek, undefined, "a loop-detected stop says nothing about the provider");
  assert.equal(by.ollama.state, "closed");
  assert.ok(snap.errors.length >= 1);
  assert.doesNotMatch(JSON.stringify(snap.errors), /abcdefghijklmnop1234/, "scrubbed before it ever leaves the box");
  r.signals.onEvent({ sessionId: "s1", provider: "anthropic", event: { type: "turn_end", status: "completed" } });
  assert.equal((await get(r, "/gateway/system?fresh=1")).providers.find((p) => p.provider === "anthropic").state, "closed", "one good turn closes it");
});

test("the hourly tick cleans, backs up tonight's state, and the snapshot shows both", async (t) => {
  const r = await rig(t);
  const line = await r.surfaces.tick();
  assert.match(line, /backup ok/);
  assert.equal(await fsp.stat(path.join(r.home, "housekeeping", "last-report.json")).then(() => true, () => false), true);
  const snap = await get(r, "/gateway/system?fresh=1");
  assert.equal(snap.backup.ok, true);
  assert.equal(snap.backup.count, 1);
  assert.equal(snap.backup.stale, false);
  assert.ok(snap.housekeeping.lastRunAt);
  assert.equal(snap.housekeeping.enabled, true);
  // A second tick the same night does not back up again.
  assert.doesNotMatch(await r.surfaces.tick(), /backup/);
  const events = (await get(r, "/gateway/system/events")).events;
  assert.ok(events.some((e) => e.kind === "backup_ok"));
  // The backup is real: decrypts, and the vault is in it.
  const { loadKey, restoreBackup } = await import("../packages/cli/dist/systemBackup.js");
  const key = await loadKey(process.env.ARES_BACKUP_DIR, { create: false });
  const out = path.join(r.root, "restored");
  const rep = await restoreBackup({ from: process.env.ARES_BACKUP_DIR, to: out, key });
  assert.equal(rep.ok, true, rep.error);
  assert.equal(await fsp.readFile(path.join(out, "vault", "k"), "utf8"), "secret-value");
  assert.equal(rep.kernels.length, 1, "the live session kernel was taken through SQLite");
});

test("a failed backup reaches the phone and the snapshot calls it critical", async (t) => {
  const r = await rig(t);
  process.env.ARES_BACKUP_MAX_MB = "0.0001";
  const line = await r.surfaces.tick();
  assert.match(line, /backup FAILED/);
  const snap = await get(r, "/gateway/system?fresh=1");
  assert.equal(snap.backup.ok, false);
  assert.equal(snap.status, "critical");
  assert.ok(snap.problems.some((p) => p.id === "backup"));
  assert.ok(r.sent.some((m) => /backup failed/i.test(m.title)), "pushed to the phone");
  const before = r.sent.length;
  await r.surfaces.alerts.evaluate(await r.surfaces.service.snapshot({ fresh: true }));
  assert.equal(r.sent.length, before, "and not pushed again on the next evaluation");
});

test("stop-turn reaches the session manager, and an unknown session is a clean 409", async (t) => {
  const r = await rig(t);
  const post = (sessionId) => fetch(`${r.base}/gateway/system/turns/stop`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId }) });
  assert.equal((await post("s1")).status, 200);
  assert.deepEqual(r.stopped, ["s1"]);
  assert.equal((await post("gone")).status, 409);
  assert.equal((await post("idle-one")).status, 409);
});

test("the snapshot carries the wired objects: scheduler job, tunnel, push, uptime", async (t) => {
  const r = await rig(t);
  const snap = await get(r, "/gateway/system");
  assert.equal(snap.scheduler.jobs[0].name, "housekeeping");
  assert.equal(snap.tunnel.scope, "public");
  assert.deepEqual(snap.push, { configured: true, devices: 1 });
  assert.equal(snap.sessions.turns[0].currentTool, "Bash");
  assert.equal(snap.garrison.pid, process.pid);
  assert.equal(typeof snap.loop.p99Ms, "number");
  assert.ok(snap.disk.totalBytes > 0);
});

test("housekeeping can be run now, as a preview, through the route", async (t) => {
  const r = await rig(t);
  const old = path.join(r.ws, ".ares", "wire-log", "ancient.jsonl");
  await fsp.mkdir(path.dirname(old), { recursive: true });
  await fsp.writeFile(old, "x".repeat(2000));
  const when = new Date(Date.now() - 40 * 86_400_000);
  await fsp.utimes(old, when, when);
  const preview = await (await fetch(`${r.base}/gateway/system/housekeeping`, { method: "POST", headers: auth, body: JSON.stringify({ dryRun: true }) })).json();
  assert.equal(preview.report.dryRun, true);
  assert.ok(preview.report.totals.acted >= 1);
  assert.equal(await fsp.stat(old).then(() => true, () => false), true, "a preview deletes nothing");
  const real = await (await fetch(`${r.base}/gateway/system/housekeeping`, { method: "POST", headers: auth, body: JSON.stringify({ dryRun: false }) })).json();
  assert.equal(real.report.dryRun, false);
  assert.equal(await fsp.stat(old).then(() => true, () => false), false);
  const hk = await get(r, "/gateway/system/housekeeping");
  assert.ok(hk.ledger.some((l) => l.action === "delete" && l.target.includes("ancient.jsonl")), "and the ledger says so");
});

test("connector and instance sources read their own stores", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-src-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, "telemetry"), { recursive: true });
  await fsp.writeFile(path.join(root, "telemetry", "connectors-health.json"), JSON.stringify({
    schema: 1, updatedAt: new Date().toISOString(), services: { notconnected: { id: "notconnected", kind: "service", verdict: "broken", reason: "x", checkedAt: new Date().toISOString(), consecutiveFailures: 3 } },
    servers: { gmail: { id: "gmail", kind: "mcp-connected", verdict: "broken", reason: "token expired", checkedAt: new Date().toISOString(), consecutiveFailures: 2 }, github: { id: "github", kind: "mcp-connected", verdict: "working", reason: "", checkedAt: new Date().toISOString(), consecutiveFailures: 0, toolCount: 14 } },
  }));
  const conns = await connectorsSource(root)();
  assert.deepEqual(Object.keys(conns).sort(), ["github", "gmail"], "only what the owner connected, not the catalog");
  assert.equal(conns.gmail.state, "red");
  assert.equal(conns.github.state, "green");
  const inst = await instancesSource({ preflight: async () => {}, list: async () => [{ name: "muse" }, { name: "bad" }], status: async (n) => { if (n === "bad") throw new Error("x"); return { name: n, active: "active", healthy: true }; } })();
  assert.deepEqual(inst, { supported: true, items: [{ name: "muse", state: "running", healthy: true }, { name: "bad", state: "failed", healthy: false }] });
  assert.deepEqual(await instancesSource({ preflight: async () => { throw new Error("no docker"); }, list: async () => [], status: async () => ({}) })(), { supported: false, items: [] });
});
