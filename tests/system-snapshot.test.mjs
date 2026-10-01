// The System surface the phone's health screen renders against: snapshot shape,
// status derivation, cache, isolation of a failing collector, and the routes,
// all through the real RemoteAgentServer with the owner bearer.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createSystemApi } from "../packages/cli/dist/phoneSystem.js";
import { createSystemService, deriveProblems, headlineFor } from "../packages/cli/dist/systemSnapshot.js";
import { AlertEngine } from "../packages/cli/dist/systemAlerts.js";
import { ErrorRing, ProviderHealth, scrubErrorText } from "../packages/cli/dist/systemSignals.js";

const auth = { authorization: "Bearer tok", "content-type": "application/json" };

async function tmpHome(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-sys-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function baseDeps(home, over = {}) {
  const startedAt = new Date(Date.now() - 2 * 86_400_000 - 3600_000).toISOString();
  return {
    home,
    workspaces: [home],
    startedAt: () => Date.parse(startedAt),
    statfs: () => ({ total: 1000 * 1_048_576, free: 830 * 1_048_576 }), // 17% used
    loadavg: () => [0.4, 0.3, 0.2],
    version: () => ({ version: "9.9.9", sha: "abcdef12" }),
    sessions: {
      list: () => [{ id: "s1", busy: true }, { id: "s2", busy: false }],
      runningTurns: () => [{ sessionId: "s1", title: "Build the thing", startedAt: new Date(Date.now() - 45_000).toISOString(), currentTool: "Bash" }],
      pendingPermissionList: () => [{}, {}],
    },
    queueDepth: () => 1,
    approvalsPending: () => 3,
    providers: () => [{ provider: "anthropic", state: "closed", consecutiveFailures: 0, failingForMs: 0 }],
    loop: () => ({ meanMs: 1.2, p99Ms: 12, maxMs: 40 }),
    connectors: async () => ({ github: { state: "green", detail: "Live: 14 tools", stale: false }, gmail: { state: "red", detail: "Broken: token expired", stale: false } }),
    scheduler: () => [{ name: "heartbeat", schedule: "every 30m", enabled: true, paused: false, running: false }],
    push: () => ({ configured: true, devices: 1 }),
    tunnel: () => ({ scope: "public", url: "https://x.example.com" }),
    instances: async () => ({ supported: true, items: [{ name: "muse", state: "running", healthy: true }] }),
    processes: () => ({ zombies: 0, orphans: 0 }),
    errors: () => [{ at: new Date().toISOString(), source: "anthropic", message: "overloaded" }],
    ...over,
  };
}

async function serve(t, system) {
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", phoneApi: { system } });
  await server.start();
  t.after(() => server.close());
  return `http://127.0.0.1:${server.port}`;
}

test("GET /gateway/system needs the owner bearer", async (t) => {
  const home = await tmpHome(t);
  const base = await serve(t, createSystemApi({ service: createSystemService(baseDeps(home)) }));
  assert.equal((await fetch(`${base}/gateway/system`)).status, 401);
  assert.equal((await fetch(`${base}/gateway/system`, { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await fetch(`${base}/gateway/system`, { headers: auth })).status, 200);
});

test("the snapshot carries everything the screen draws, and a healthy box reads Healthy", async (t) => {
  const home = await tmpHome(t);
  // No red connector in this one.
  const deps = baseDeps(home, { connectors: async () => ({ github: { state: "green", detail: "Live", stale: false } }) });
  const base = await serve(t, createSystemApi({ service: createSystemService(deps) }));
  const snap = await (await fetch(`${base}/gateway/system`, { headers: auth })).json();
  assert.equal(snap.schema, 1);
  assert.equal(snap.status, "ok");
  assert.match(snap.headline, /^Healthy - up 2d - disk 17%$/);
  assert.equal(snap.garrison.version, "9.9.9");
  assert.equal(snap.garrison.sha, "abcdef12");
  assert.equal(snap.garrison.uptimeSec >= 2 * 86_400, true);
  assert.equal(typeof snap.memory.heapUsedMb, "number");
  assert.equal(typeof snap.memory.rssMb, "number");
  assert.equal(snap.loop.p99Ms, 12);
  assert.equal(snap.cpu.load1, 0.4);
  assert.equal(snap.disk.usedPct, 17);
  assert.deepEqual(snap.disk.dirs.map((d) => d.key), ["home", "logs", "sessions", "blobs", "wal", "worktrees"]);
  assert.equal(snap.sessions.total, 2);
  assert.equal(snap.sessions.running, 1);
  assert.equal(snap.sessions.queueDepth, 1);
  assert.equal(snap.sessions.pendingPermissions, 2);
  assert.equal(snap.sessions.pendingApprovals, 3);
  assert.equal(snap.sessions.turns[0].currentTool, "Bash");
  assert.equal(snap.sessions.turns[0].stuck, false);
  assert.equal(snap.providers[0].provider, "anthropic");
  assert.deepEqual([snap.connectors.total, snap.connectors.green, snap.connectors.red], [1, 1, 0]);
  assert.equal(snap.scheduler.jobs[0].name, "heartbeat");
  assert.deepEqual(snap.push, { configured: true, devices: 1 });
  assert.equal(snap.tunnel.scope, "public");
  assert.equal(snap.instances.running, 1);
  assert.equal(snap.errors[0].message, "overloaded");
  assert.deepEqual(snap.problems, []);
  assert.equal(snap.sources.sessions, "ok");
  assert.equal(snap.sources.housekeeping, "absent", "an unwired source says so instead of lying");
});

test("a standalone garrison with nothing wired still answers", async (t) => {
  const home = await tmpHome(t);
  const base = await serve(t, createSystemApi({ service: createSystemService({ home, statfs: () => ({ total: 100, free: 90 }) }) }));
  const res = await fetch(`${base}/gateway/system`, { headers: auth });
  assert.equal(res.status, 200);
  const snap = await res.json();
  assert.equal(snap.sessions.total, 0);
  assert.equal(snap.sources.sessions, "absent");
  assert.equal(snap.status, "ok");
});

test("a failing or hanging collector becomes a hole, never a failed request", async (t) => {
  const home = await tmpHome(t);
  const deps = baseDeps(home, {
    connectors: async () => { throw new Error("boom"); },
    errors: () => { throw new Error("ring exploded"); },
  });
  const base = await serve(t, createSystemApi({ service: createSystemService(deps) }));
  const res = await fetch(`${base}/gateway/system`, { headers: auth });
  assert.equal(res.status, 200);
  const snap = await res.json();
  assert.equal(snap.sources.connectors, "error");
  assert.equal(snap.sources.errors, "error");
  assert.equal(snap.sources.sessions, "ok", "the other sources are unaffected");
  assert.equal(snap.connectors.total, 0);
});

test("the snapshot is cached for 5 seconds; fresh=1 bypasses it", async (t) => {
  const home = await tmpHome(t);
  let calls = 0;
  let clock = 1_000_000;
  const deps = baseDeps(home, { now: () => clock, queueDepth: () => ++calls });
  const service = createSystemService(deps);
  const a = await service.snapshot();
  const b = await service.snapshot();
  assert.equal(calls, 1, "second call inside 5s is a cache hit");
  assert.equal(b.collectMs, 0);
  assert.equal(a.sessions.queueDepth, b.sessions.queueDepth);
  clock += 4_000;
  await service.snapshot();
  assert.equal(calls, 1);
  clock += 2_000;
  await service.snapshot();
  assert.equal(calls, 2, "after 5s it recollects");
  await service.snapshot({ fresh: true });
  assert.equal(calls, 3);
});

test("concurrent requests share one collection", async (t) => {
  const home = await tmpHome(t);
  let calls = 0;
  const service = createSystemService(baseDeps(home, { queueDepth: async () => { calls++; await new Promise((r) => setTimeout(r, 30)); return 0; } }));
  await Promise.all([service.snapshot(), service.snapshot(), service.snapshot()]);
  assert.equal(calls, 1);
});

test("status derivation: disk, heap, loop lag, stuck turns, open breakers, red connectors, backup", () => {
  const ok = {
    disk: { totalBytes: 100, usedBytes: 10, usedPct: 10, dirs: [] },
    memory: { heapRatio: 0.2, systemRatio: 0.4 },
    loop: { p99Ms: 5 },
    sessions: { turns: [] },
    providers: [],
    connectors: { problems: [] },
    push: { configured: false, devices: 0 },
    instances: { failed: 0 },
    processes: { zombies: 0, orphans: 0 },
  };
  assert.deepEqual(deriveProblems(ok), []);
  const find = (patch, id) => deriveProblems({ ...ok, ...patch }).find((p) => p.id === id);
  assert.equal(find({ disk: { ...ok.disk, usedPct: 81 } }, "disk").level, "warn");
  assert.equal(find({ disk: { ...ok.disk, usedPct: 86 } }, "disk").level, "critical");
  assert.equal(find({ memory: { ...ok.memory, heapRatio: 0.9 } }, "heap").level, "critical");
  assert.equal(find({ loop: { p99Ms: 300 } }, "loop").level, "warn");
  assert.equal(find({ loop: { p99Ms: 1500 } }, "loop").level, "critical");
  assert.ok(find({ sessions: { turns: [{ sessionId: "a", stuck: true, ageSec: 700 }] } }, "turn:a"));
  assert.equal(find({ providers: [{ provider: "x", state: "open", failingForMs: 400_000, consecutiveFailures: 5 }] }, "provider:x").level, "critical");
  assert.ok(find({ connectors: { problems: [{ id: "gmail", state: "red", detail: "token expired" }] } }, "connector:gmail"));
  assert.equal(find({ backup: { ok: false, error: "disk full" } }, "backup").level, "critical");
  assert.equal(find({ backup: { ok: true, stale: true } }, "backup").level, "warn");
  assert.equal(headlineFor("critical", 90, 91, []), "Needs attention - up 1m - disk 91%");
  assert.equal(headlineFor("warn", 3 * 3600, 40, [{}]), "1 warning - up 3h - disk 40%");
});

test("a running turn past 10 minutes is flagged stuck and warns", async (t) => {
  const home = await tmpHome(t);
  const deps = baseDeps(home, {
    sessions: {
      list: () => [{ id: "s1", busy: true }],
      runningTurns: () => [{ sessionId: "s1", title: "Long one", startedAt: new Date(Date.now() - 11 * 60_000).toISOString() }],
      pendingPermissionList: () => [],
    },
  });
  const snap = await createSystemService(deps).snapshot();
  assert.equal(snap.sessions.turns[0].stuck, true);
  assert.equal(snap.sessions.oldestRunningAgeSec >= 660, true);
  assert.equal(snap.status, "warn");
  assert.ok(snap.problems.some((p) => p.id === "turn:s1"));
});

test("disk breakdown measures real directories", async (t) => {
  const home = await tmpHome(t);
  await fsp.mkdir(path.join(home, "sessions"), { recursive: true });
  await fsp.writeFile(path.join(home, "sessions", "a.jsonl"), Buffer.alloc(5000));
  await fsp.mkdir(path.join(home, ".ares"), { recursive: true });
  await fsp.writeFile(path.join(home, ".ares", "session-kernel.sqlite-wal"), Buffer.alloc(7000));
  const snap = await createSystemService(baseDeps(home)).snapshot();
  const by = Object.fromEntries(snap.disk.dirs.map((d) => [d.key, d.bytes]));
  assert.ok(by.sessions >= 5000);
  assert.equal(by.wal, 7000);
  assert.ok(by.home >= 12000);
});

test("events, stop-turn, housekeeping and backup routes", async (t) => {
  const home = await tmpHome(t);
  const alerts = new AlertEngine({ home, push: async () => {}, quiet: "off" });
  await alerts.record({ kind: "housekeeping", title: "Housekeeping freed 12 MB" });
  const stopped = [];
  let backups = 0;
  const api = createSystemApi({
    service: createSystemService(baseDeps(home)),
    alerts,
    stopTurn: (id) => { stopped.push(id); return id === "s1"; },
    runBackup: async () => { backups++; return { ok: true, pruned: [] }; },
    backupStatus: async () => ({ ok: true, count: 2, stale: false }),
    housekeeping: {
      isRunning: false,
      summary: () => ({ acted: 0, bytes: 0, jobs: [], enabled: true }),
      ledgerTail: async () => [],
      run: async ({ dryRun }) => ({ dryRun, ok: true, totals: { acted: 0, bytes: 0 }, jobs: {} }),
    },
  });
  const base = await serve(t, api);
  const events = await (await fetch(`${base}/gateway/system/events`, { headers: auth })).json();
  assert.equal(events.events[0].title, "Housekeeping freed 12 MB");
  assert.equal((await fetch(`${base}/gateway/system/events?before=garbage`, { headers: auth })).status, 400);

  const stop = await fetch(`${base}/gateway/system/turns/stop`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: "s1" }) });
  assert.equal(stop.status, 200);
  assert.equal((await fetch(`${base}/gateway/system/turns/stop`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: "s2" }) })).status, 409);
  assert.equal((await fetch(`${base}/gateway/system/turns/stop`, { method: "POST", headers: auth, body: JSON.stringify({ sessionId: "../etc" }) })).status, 400);
  assert.deepEqual(stopped, ["s1", "s2"]);

  const hk = await (await fetch(`${base}/gateway/system/housekeeping`, { method: "POST", headers: auth, body: JSON.stringify({ dryRun: true }) })).json();
  assert.equal(hk.report.dryRun, true);
  const bk = await fetch(`${base}/gateway/system/backup`, { method: "POST", headers: auth });
  assert.equal(bk.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backups, 1);
  assert.equal((await (await fetch(`${base}/gateway/system/backup`, { headers: auth })).json()).status.count, 2);
  assert.equal((await fetch(`${base}/gateway/system/nope`, { headers: auth })).status, 404);
});

test("provider breaker: closed, degraded after 2, open after 3, closed again on a success", () => {
  let now = 0;
  const h = new ProviderHealth(() => now);
  h.fail("anthropic", "529 overloaded");
  assert.equal(h.states()[0].state, "closed");
  now += 1000;
  h.fail("anthropic", "529 overloaded");
  assert.equal(h.states()[0].state, "degraded");
  now += 1000;
  h.fail("anthropic", "529 overloaded");
  now += 5 * 60_000;
  const open = h.states()[0];
  assert.equal(open.state, "open");
  assert.ok(open.failingForMs >= 5 * 60_000);
  h.ok("anthropic");
  const healed = h.states()[0];
  assert.equal(healed.state, "closed");
  assert.equal(healed.failingForMs, 0);
});

test("recent errors are scrubbed, shortened, deduplicated and bounded", () => {
  const ring = new ErrorRing(3);
  ring.record("tool", `failed with Authorization: Bearer abcdefghijklmnop1234 and key sk-ant-api03-abcdefghijklmnopqrstuvwx in ${os.homedir()}/secret/place`);
  const first = ring.recent(1)[0];
  assert.doesNotMatch(first.message, /abcdefghijklmnop1234|sk-ant/);
  assert.doesNotMatch(first.message, new RegExp(os.homedir().replace(/[\\.]/g, "\\$&")));
  ring.record("a", "same");
  ring.record("a", "same");
  assert.equal(ring.recent(10).filter((e) => e.message === "same").length, 1, "an exact repeat collapses");
  ring.record("b", "two");
  ring.record("c", "three");
  assert.equal(ring.recent(10).length, 3, "bounded by capacity");
  assert.equal(scrubErrorText("x".repeat(1000)).length <= 240, true);
});

test("the antihang deep health is folded in: its breakers, orphans and errors appear, nothing is lost", async (t) => {
  const home = await tmpHome(t);
  const deep = {
    ok: false,
    status: "degraded",
    providers: { open: 1, breakers: [
      { key: "anthropic", state: "open", consecutiveFailures: 4, openForMs: 400_000, lastError: "529 overloaded" },
      { key: "deepseek", state: "half-open", consecutiveFailures: 1, openForMs: 0 },
      { key: "ollama", state: "closed", consecutiveFailures: 0, openForMs: 0 },
    ] },
    processes: { orphans: 2, zombies: 1 },
    errors: [{ at: new Date().toISOString(), kind: "watchdog:nudge", message: "session s1 silent for 90s Authorization: Bearer abcdefghijklmnop1234" }],
  };
  const service = createSystemService(baseDeps(home, { providers: () => [], errors: () => [], deep: async () => deep }));
  const snap = await service.snapshot();
  assert.deepEqual(snap.providers.map((p) => [p.provider, p.state]), [["anthropic", "open"], ["deepseek", "degraded"], ["ollama", "closed"]]);
  assert.equal(snap.providers[0].failingForMs, 400_000);
  assert.equal(snap.processes.orphans, 2);
  assert.equal(snap.processes.zombies, 1);
  assert.equal(snap.errors.length, 1);
  assert.doesNotMatch(snap.errors[0].message, /abcdefghijklmnop1234/);
  assert.equal(snap.deep.status, "degraded", "and the deep payload itself is passed through");
  assert.ok(snap.problems.some((p) => p.id === "provider:anthropic"));
  // Our own tracker wins where both know the provider and ours says open.
  const mine = createSystemService(baseDeps(home, { providers: () => [{ provider: "anthropic", state: "closed", consecutiveFailures: 0, failingForMs: 0 }], deep: async () => deep }));
  assert.equal((await mine.snapshot()).providers.find((p) => p.provider === "anthropic").state, "open", "the worse of the two is reported");
});

test("a deep payload that is not an object, or is half-formed, changes nothing", async (t) => {
  const home = await tmpHome(t);
  for (const deep of [null, "nope", 42, [], { providers: "x", processes: null, errors: 3 }]) {
    const snap = await createSystemService(baseDeps(home, { deep: async () => deep })).snapshot();
    assert.equal(snap.providers.length, 1);
    assert.equal(snap.status, "ok");
  }
});

test("a maintainer status with whole proposals is trimmed to what the screen needs, and a huge deep payload is cut", async (t) => {
  const home = await tmpHome(t);
  const big = "x".repeat(5000);
  const maintainer = { enabled: true, proposals: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, status: "pending", title: "t", diff: big })), deploys: [{ id: "d1", status: "deployed", finishedAt: "2026-10-01T00:00:00Z", log: big }] };
  const snap = await createSystemService(baseDeps(home, { maintainer: async () => maintainer, deep: async () => ({ ok: false, status: "degraded", junk: big.repeat(10) }) })).snapshot();
  assert.equal(snap.maintainer.proposals.length, 5);
  assert.equal(snap.maintainer.proposals[0].diff, undefined);
  assert.equal(snap.maintainer.deploys[0].log, undefined);
  assert.equal(snap.maintainer.enabled, true);
  assert.deepEqual(snap.deep, { truncated: true, status: "degraded", ok: false });
  assert.ok(JSON.stringify(snap).length < 40_000, "the poll stays small");
});
