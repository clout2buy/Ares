// Housekeeping on a synthetic home: it frees what it should, never touches what
// it must not (a worktree with uncommitted work, the vault, anything outside
// Ares's own directories), counts honestly in a dry run, and ledgers every act.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { Fence, Housekeeping } from "../packages/cli/dist/systemHousekeeping.js";
import { gcWorkspaceCheckpoints } from "../packages/core/dist/index.js";

const DAY = 86_400_000;

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-hk-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home", ".ares");
  const ws = path.join(root, "ws");
  const tmp = path.join(root, "tmp");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(path.join(ws, ".ares"), { recursive: true });
  await fsp.mkdir(tmp, { recursive: true });
  return { root, home, ws, tmp };
}

async function put(file, size, ageDays, now = Date.now()) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(size, 97));
  const t = new Date(now - ageDays * DAY);
  await fsp.utimes(file, t, t);
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function make(f, over = {}) {
  return new Housekeeping({
    home: f.home,
    workspaces: [f.ws],
    tmpDir: f.tmp,
    instancesRoot: path.join(f.root, "instances"),
    diskUsedPct: () => 40,
    docker: async () => null,
    processes: async () => [],
    ...over,
  });
}

async function ledger(hk) {
  return (await fsp.readFile(hk.ledgerFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("wire logs: compress after 2 days, delete after 14, spare the active file, honour the size cap", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.ws, ".ares", "wire-log");
  await put(path.join(dir, "fresh.jsonl"), 200_000, 0);
  await put(path.join(dir, "three-days.jsonl"), 200_000, 3);
  await put(path.join(dir, "tiny-old.jsonl"), 1_000, 5);
  await put(path.join(dir, "ancient.jsonl"), 200_000, 20);
  await put(path.join(dir, "ancient2.jsonl.gz"), 5_000, 30);
  const hk = make(f);
  const report = await hk.run();
  assert.equal(report.ok, true, JSON.stringify(report.jobs.wireLogs));
  assert.equal(await exists(path.join(dir, "fresh.jsonl")), true, "an active file is never touched");
  assert.equal(await exists(path.join(dir, "ancient.jsonl")), false);
  assert.equal(await exists(path.join(dir, "ancient2.jsonl.gz")), false);
  assert.equal(await exists(path.join(dir, "three-days.jsonl")), false, "the original is replaced...");
  const gz = await fsp.readFile(path.join(dir, "three-days.jsonl.gz"));
  assert.equal(gunzipSync(gz).length, 200_000, "...by a gzip that round-trips");
  assert.equal(await exists(path.join(dir, "tiny-old.jsonl")), true, "tiny files are not worth compressing");
  assert.ok(report.jobs.wireLogs.bytes > 200_000);
  const entries = await ledger(hk);
  assert.ok(entries.some((e) => e.action === "gzip" && e.target.includes("three-days")));
  assert.ok(entries.some((e) => e.action === "delete" && e.target.includes("ancient.jsonl")));
});

test("wire-log size cap deletes oldest first", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.ws, ".ares", "wire-log");
  await put(path.join(dir, "a.jsonl.gz"), 600_000, 5);
  await put(path.join(dir, "b.jsonl.gz"), 600_000, 4);
  await put(path.join(dir, "c.jsonl.gz"), 600_000, 3);
  const hk = make(f, { limits: { wireLogCapMb: 1.3 } });
  await hk.run();
  assert.equal(await exists(path.join(dir, "a.jsonl.gz")), false, "the oldest goes");
  assert.equal(await exists(path.join(dir, "c.jsonl.gz")), true);
});

test("a dry run fills the counters and changes nothing", async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.ws, ".ares", "wire-log");
  await put(path.join(dir, "ancient.jsonl"), 100_000, 30);
  await put(path.join(f.home, "crashes", "old.jsonl"), 500, 100);
  for (let i = 0; i < 21; i++) await put(path.join(f.home, "crashes", `n${i}.jsonl`), 500, 1 + i * 0.01);
  await fsp.mkdir(path.join(f.tmp, "ares-login-abc123"));
  const old = new Date(Date.now() - 10 * DAY);
  await fsp.utimes(path.join(f.tmp, "ares-login-abc123"), old, old);
  const hk = make(f);
  const report = await hk.run({ dryRun: true });
  assert.equal(report.dryRun, true);
  assert.ok(report.totals.acted >= 3, `would act on wire log, crash and tmp (got ${report.totals.acted})`);
  assert.ok(report.totals.bytes >= 100_000);
  assert.equal(await exists(path.join(dir, "ancient.jsonl")), true);
  assert.equal(await exists(path.join(f.home, "crashes", "old.jsonl")), true);
  assert.equal(await exists(path.join(f.tmp, "ares-login-abc123")), true);
  assert.deepEqual(await ledger(hk), [], "a dry run writes no ledger");
  assert.equal(await exists(path.join(f.home, "housekeeping", "last-report.json")), false, "and does not replace the last real report");
  // The same data, run for real, acts on the same things.
  const real = await hk.run();
  assert.equal(real.totals.acted, report.totals.acted);
  assert.equal(await exists(path.join(dir, "ancient.jsonl")), false);
});

test("temp dirs: only Ares-prefixed, only stale, only real directories", async (t) => {
  const f = await fixture(t);
  const mk = async (name, ageDays) => {
    const d = path.join(f.tmp, name);
    await fsp.mkdir(d);
    await fsp.writeFile(path.join(d, "x"), "x");
    const when = new Date(Date.now() - ageDays * DAY);
    await fsp.utimes(path.join(d, "x"), when, when);
    await fsp.utimes(d, when, when);
  };
  await mk("ares-login-old111", 10);
  await mk("ares-login-new222", 0.1);
  await mk("not-ares-old", 10);
  await mk("ares-fleet-stale-abc", 4);
  // A fresh file inside an old directory means it is in use.
  await mk("ares-conn-busy", 10);
  await fsp.writeFile(path.join(f.tmp, "ares-conn-busy", "live"), "y");
  await fsp.writeFile(path.join(f.tmp, "ares-loose-file.txt"), "z");
  const hk = make(f);
  await hk.run();
  assert.equal(await exists(path.join(f.tmp, "ares-login-old111")), false);
  assert.equal(await exists(path.join(f.tmp, "ares-fleet-stale-abc")), false);
  assert.equal(await exists(path.join(f.tmp, "ares-login-new222")), true);
  assert.equal(await exists(path.join(f.tmp, "not-ares-old")), true, "somebody else's directory");
  assert.equal(await exists(path.join(f.tmp, "ares-conn-busy")), true, "recent activity inside keeps it");
  assert.equal(await exists(path.join(f.tmp, "ares-loose-file.txt")), true, "files are not scratch dirs");
});

test("worktrees: a clean merged one goes, one with uncommitted changes survives, an unmerged detached one survives", async (t) => {
  const f = await fixture(t);
  git(f.ws, "init", "-q", "-b", "main");
  git(f.ws, "config", "user.email", "t@t");
  git(f.ws, "config", "user.name", "t");
  await fsp.writeFile(path.join(f.ws, "a.txt"), "a");
  git(f.ws, "add", "-A");
  git(f.ws, "commit", "-q", "-m", "init");
  const wtRoot = path.join(f.ws, ".claude", "worktrees");
  await fsp.mkdir(wtRoot, { recursive: true });
  const clean = path.join(wtRoot, "agent-clean");
  const dirty = path.join(wtRoot, "agent-dirty");
  const untracked = path.join(wtRoot, "agent-untracked");
  const detached = path.join(wtRoot, "agent-detached");
  git(f.ws, "worktree", "add", "-q", "-b", "wt-clean", clean);
  git(f.ws, "worktree", "add", "-q", "-b", "wt-dirty", dirty);
  git(f.ws, "worktree", "add", "-q", "-b", "wt-untracked", untracked);
  git(f.ws, "worktree", "add", "-q", "--detach", detached);
  // dirty: modified tracked file; untracked: a brand-new file; detached: an unmerged commit.
  await fsp.writeFile(path.join(dirty, "a.txt"), "changed but not committed");
  await fsp.writeFile(path.join(untracked, "precious.txt"), "do not lose me");
  await fsp.writeFile(path.join(detached, "d.txt"), "d");
  git(detached, "add", "-A");
  git(detached, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "only here");
  const hk = make(f, { now: () => Date.now() + 30 * DAY });
  const report = await hk.run();
  assert.equal(report.jobs.worktrees.error, undefined, report.jobs.worktrees.error);
  assert.equal(await exists(clean), false, "clean and merged: removed");
  assert.equal(await exists(path.join(dirty, "a.txt")), true, "uncommitted change: survives");
  assert.equal((await fsp.readFile(path.join(dirty, "a.txt"), "utf8")), "changed but not committed");
  assert.equal(await exists(path.join(untracked, "precious.txt")), true, "an untracked file counts as work");
  assert.equal(await exists(path.join(detached, "d.txt")), true, "a detached HEAD with a commit nowhere else is kept");
  assert.ok(report.jobs.worktrees.notes.some((n) => /uncommitted/.test(n)));
  assert.ok((await ledger(hk)).some((e) => e.action === "worktree-remove" && e.target.includes("agent-clean")));
  // The branch of the removed worktree is untouched: removing a worktree loses no commits.
  assert.match(git(f.ws, "branch", "--list", "wt-clean"), /wt-clean/);
});

test("worktrees outside Ares's own scratch locations are never candidates", async (t) => {
  const f = await fixture(t);
  git(f.ws, "init", "-q", "-b", "main");
  git(f.ws, "config", "user.email", "t@t");
  git(f.ws, "config", "user.name", "t");
  await fsp.writeFile(path.join(f.ws, "a.txt"), "a");
  git(f.ws, "add", "-A");
  git(f.ws, "commit", "-q", "-m", "init");
  const elsewhere = path.join(f.root, "someone-elses-worktree");
  git(f.ws, "worktree", "add", "-q", "-b", "mine", elsewhere);
  const hk = make(f, { now: () => Date.now() + 90 * DAY });
  await hk.run();
  assert.equal(await exists(path.join(elsewhere, "a.txt")), true);
});

test("checkpoint blobs nobody references are reclaimed through core's GC", async (t) => {
  const f = await fixture(t);
  // Rook's shape: Ares home is <x>/.ares and <x> was a workspace with blobs but no metas left.
  const blobs = path.join(path.dirname(f.home), ".ares", "checkpoints", "blobs");
  for (let i = 0; i < 20; i++) await put(path.join(blobs, `a${i % 3}`, `deadbeef${i}`), 10_000, 30);
  await put(path.join(blobs, "zz", "fresh"), 10_000, 0); // younger than a minute: spared
  const hk = make(f, { workspaces: [f.ws], gcCheckpoints: gcWorkspaceCheckpoints });
  const dry = await hk.run({ dryRun: true });
  assert.equal(dry.jobs.checkpoints.acted, 20, "dry run counts the orphans");
  assert.equal(dry.jobs.checkpoints.bytes, 200_000);
  assert.equal(await exists(path.join(blobs, "a0", "deadbeef0")), true);
  const real = await hk.run();
  assert.equal(real.jobs.checkpoints.error, undefined);
  assert.equal(await exists(path.join(blobs, "a0", "deadbeef0")), false);
  assert.equal(await exists(path.join(blobs, "zz", "fresh")), true);
  assert.ok(real.jobs.checkpoints.bytes >= 200_000);
  assert.ok((await ledger(hk)).some((e) => e.action === "gc"));
});

test("a big WAL is folded through the kernel hook; a small one is left alone", async (t) => {
  const f = await fixture(t);
  const wal = path.join(f.ws, ".ares", "session-kernel.sqlite-wal");
  await put(wal, 3_000_000, 0);
  const calls = [];
  const hk = make(f, {
    limits: { walMaxMb: 1 },
    maintainWal: (mode) => { calls.push(mode); return { busy: 0, log: 10, checkpointed: 10 }; },
    activeTurns: () => 0,
  });
  await hk.run();
  assert.deepEqual(calls, ["TRUNCATE"]);
  const busy = make(f, { limits: { walMaxMb: 1 }, maintainWal: (mode) => { calls.push(mode); return null; }, activeTurns: () => 2 });
  await busy.run();
  assert.equal(calls[1], "PASSIVE", "never TRUNCATE under a running turn");
  const small = make(f, { limits: { walMaxMb: 64 }, maintainWal: () => { throw new Error("should not be called"); } });
  assert.equal((await small.run()).ok, true);
});

test("log rotation: a huge log is copied to a .gz and truncated, old rotations pruned", async (t) => {
  const f = await fixture(t);
  const log = path.join(f.home, "logs", "service.log");
  await put(log, 3_000_000, 0);
  const hk = make(f, { limits: { logRotateMb: 1, logKeepRotations: 1 } });
  await hk.run();
  assert.equal((await fsp.stat(log)).size, 0);
  const gzs = (await fsp.readdir(path.join(f.home, "logs"))).filter((n) => n.endsWith(".gz"));
  assert.equal(gzs.length, 1);
  assert.equal(gunzipSync(await fsp.readFile(path.join(f.home, "logs", gzs[0]))).length, 3_000_000);
});

test("the fence: nothing outside Ares's directories, nothing protected, never a root itself", async (t) => {
  const f = await fixture(t);
  const fence = new Fence([{ dir: f.home }, { dir: f.tmp, childPattern: /^ares-/ }]);
  assert.throws(() => fence.check(path.join(f.root, "elsewhere", "x")), /outside Ares/);
  assert.throws(() => fence.check(f.home), /outside Ares|refused/);
  assert.throws(() => fence.check(path.join(f.home, "..", "x")), /outside Ares/);
  for (const p of ["vault/key", "credentials.json", "auth.json", "personas/ares.json", "memory/m.json", "garrison/token", "session-kernel.sqlite", "secrets/a"]) {
    assert.throws(() => fence.check(path.join(f.home, p)), /protected/, p);
  }
  assert.doesNotThrow(() => fence.check(path.join(f.home, "wire-log", "x.jsonl")));
  assert.throws(() => fence.check(path.join(f.tmp, "other-thing")), /outside Ares/);
  assert.doesNotThrow(() => fence.check(path.join(f.tmp, "ares-x", "deep", "file")));
  assert.throws(() => fence.check(f.tmp), /outside Ares/);
});

test("protected state survives even when it is old and in a swept directory", async (t) => {
  const f = await fixture(t);
  await put(path.join(f.home, "vault", "key.enc"), 100, 400);
  await put(path.join(f.home, "credentials.json"), 100, 400);
  await put(path.join(f.home, "personas", "p.json"), 100, 400);
  await put(path.join(f.home, "tool-results", "old.txt"), 100, 400);
  await put(path.join(f.ws, ".ares", "session-kernel.sqlite"), 100, 400);
  await put(path.join(f.ws, ".ares", "session-kernel.sqlite-wal"), 100, 400);
  const hk = make(f);
  await hk.run();
  assert.equal(await exists(path.join(f.home, "tool-results", "old.txt")), false, "spill older than 30d is swept");
  for (const p of [["vault", "key.enc"], ["credentials.json"], ["personas", "p.json"]]) assert.equal(await exists(path.join(f.home, ...p)), true, p.join("/"));
  assert.equal(await exists(path.join(f.ws, ".ares", "session-kernel.sqlite")), true);
  assert.equal(await exists(path.join(f.ws, ".ares", "session-kernel.sqlite-wal")), true);
});

test("symlinks are never followed or deleted through", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await put(path.join(outside, "keep.txt"), 10, 400);
  await fsp.mkdir(path.join(f.home, "tool-results"), { recursive: true });
  await fsp.symlink(outside, path.join(f.home, "tool-results", "link"), "dir").catch(() => {});
  await fsp.mkdir(path.join(f.tmp, "x"), { recursive: true });
  await fsp.symlink(outside, path.join(f.tmp, "ares-link"), "dir").catch(() => {});
  const hk = make(f);
  await hk.run();
  assert.equal(await exists(path.join(outside, "keep.txt")), true);
});

test("orphaned Ares browser processes are reaped; live children and strangers are not", async (t) => {
  const f = await fixture(t);
  const killed = [];
  const table = [
    { pid: 100, ppid: 1, state: "S", comm: "node", cmd: "node garrison serve", uid: 1000, ageSec: 99999 },
    { pid: 200, ppid: 1, state: "S", comm: "chrome", cmd: `chrome --user-data-dir=${f.home}/browser-profile --headless`, uid: 1000, ageSec: 3600 },
    { pid: 201, ppid: 77, state: "S", comm: "systemd", cmd: "systemd --user", uid: 1000, ageSec: 99999 },
    { pid: 202, ppid: 201, state: "S", comm: "chrome", cmd: "chrome --user-data-dir=/tmp/ares-login-Ab12Cd --headless", uid: 1000, ageSec: 3600 },
    { pid: 203, ppid: 100, state: "S", comm: "chrome", cmd: `chrome --user-data-dir=${f.home}/browser-profile`, uid: 1000, ageSec: 3600 },
    { pid: 204, ppid: 1, state: "S", comm: "chrome", cmd: `chrome --user-data-dir=${f.home}/browser-profile`, uid: 1000, ageSec: 30 },
    { pid: 205, ppid: 1, state: "S", comm: "chrome", cmd: "chrome --user-data-dir=/home/somebody/own-profile", uid: 1000, ageSec: 99999 },
    { pid: 206, ppid: 1, state: "S", comm: "chrome", cmd: `chrome --user-data-dir=${f.home}/browser-profile`, uid: 4242, ageSec: 99999 },
    { pid: 207, ppid: 100, state: "Z", comm: "git", cmd: "", uid: 1000, ageSec: 1 },
  ];
  const hk = make(f, {
    processes: async () => table,
    ownPid: 100,
    uid: 1000,
    kill: (pid, sig) => killed.push([pid, sig]),
    isAlive: () => false,
    sleep: async () => {},
  });
  const report = await hk.run();
  assert.deepEqual(killed.map((k) => k[0]).sort(), [200, 202], "only the two orphaned Ares browsers");
  assert.ok(report.jobs.processes.notes.includes("zombies: 1"));
  assert.ok((await ledger(hk)).filter((e) => e.action === "kill").length === 2);
  killed.length = 0;
  const dry = await make(f, { processes: async () => table, ownPid: 100, uid: 1000, kill: (p) => killed.push(p) }).run({ dryRun: true });
  assert.equal(dry.jobs.processes.acted, 2);
  assert.deepEqual(killed, []);
});

test("ARES_HOUSEKEEPING=0 is a hard kill switch", async (t) => {
  const f = await fixture(t);
  await put(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl"), 1000, 90);
  process.env.ARES_HOUSEKEEPING = "0";
  t.after(() => { delete process.env.ARES_HOUSEKEEPING; });
  const report = await make(f).run();
  assert.equal(report.totals.acted, 0);
  assert.equal(await exists(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl")), true);
});

test("disk pressure halves the age limits", async (t) => {
  const f = await fixture(t);
  await put(path.join(f.ws, ".ares", "wire-log", "eight-days.jsonl.gz"), 1000, 8);
  const calm = await make(f, { diskUsedPct: () => 40 }).run({ dryRun: true });
  assert.equal(calm.jobs.wireLogs.acted, 0, "8 days is inside the 14 day limit");
  const tight = await make(f, { diskUsedPct: () => 88 }).run({ dryRun: true });
  assert.equal(tight.pressure, true);
  assert.equal(tight.jobs.wireLogs.acted, 1, "at 88% full the limit is 7 days");
});

test("one failing job is recorded and the rest still run", async (t) => {
  const f = await fixture(t);
  await put(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl"), 1000, 90);
  await fsp.mkdir(path.join(path.dirname(f.home), ".ares", "checkpoints", "blobs", "aa"), { recursive: true });
  const hk = make(f, { gcCheckpoints: async () => { throw new Error("gc exploded"); } });
  await put(path.join(path.dirname(f.home), ".ares", "checkpoints", "blobs", "aa", "b"), 100, 30);
  const report = await hk.run();
  assert.equal(report.ok, false);
  assert.match(report.lastError, /checkpoints: gc exploded/);
  assert.equal(await exists(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl")), false, "wire logs were still cleaned");
});

test("a second run while one is in flight is refused, not stacked", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  await fsp.mkdir(path.join(path.dirname(f.home), ".ares", "checkpoints", "blobs", "aa"), { recursive: true });
  await put(path.join(path.dirname(f.home), ".ares", "checkpoints", "blobs", "aa", "b"), 100, 30);
  const hk = make(f, { gcCheckpoints: async () => { await gate; } });
  const first = hk.run();
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(hk.run(), /already running/);
  release();
  await first;
});

test("ARES_HOUSEKEEPING_PROCESSES=0 turns the process reaper off alone", async (t) => {
  const f = await fixture(t);
  await put(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl"), 1000, 90);
  const killed = [];
  const table = [{ pid: 200, ppid: 1, state: "S", comm: "chrome", cmd: `chrome --user-data-dir=${f.home}/browser-profile`, uid: 1000, ageSec: 3600 }];
  process.env.ARES_HOUSEKEEPING_PROCESSES = "0";
  t.after(() => { delete process.env.ARES_HOUSEKEEPING_PROCESSES; });
  await make(f, { processes: async () => table, ownPid: 100, uid: 1000, kill: (p) => killed.push(p), isAlive: () => false, sleep: async () => {} }).run();
  assert.deepEqual(killed, []);
  assert.equal(await exists(path.join(f.ws, ".ares", "wire-log", "ancient.jsonl")), false, "everything else still ran");
});
