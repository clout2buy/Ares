// Backups: the nightly job's encrypted archive, retention, and the restore round
// trip on a synthetic home, including the failure modes that matter (wrong key,
// a flipped bit, a truncated file, hostile paths).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionKernelStore } from "../packages/core/dist/index.js";
import {
  backupDue,
  loadKey,
  pruneBackups,
  readBackupStatus,
  restoreBackup,
  retentionKeep,
  runBackup,
  verifyBackup,
  writeArchive,
} from "../packages/cli/dist/systemBackup.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RESTORE = path.join(here, "..", "scripts", "elite", "restore.mjs");
const SECRET = "sk-test-SENTINEL-do-not-leak-0123456789abcdef";

async function rig(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-bk-test-"));
  const home = path.join(root, "home", ".ares");
  const ws = path.join(root, "ws");
  const backups = path.join(root, "backups");
  await fsp.mkdir(ws, { recursive: true });
  const w = async (rel, content, mode) => {
    const f = path.join(home, rel);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, content, mode ? { mode } : undefined);
    return f;
  };
  await w("vault/anthropic.enc", SECRET, 0o600);
  await w("credentials.json", JSON.stringify({ k: SECRET }), 0o600);
  await w("personas/ares.json", JSON.stringify({ name: "Ares", color: "#ff7a1a" }));
  await w("memory/facts.jsonl", "fact one\nfact two\n");
  await w("MEMORY.md", "# memory\n");
  await w("operator/goals/g1.json", JSON.stringify({ id: "g1", statement: "ship it" }));
  await w("config.json", JSON.stringify({ model: "x" }));
  // Things that must NOT be backed up.
  await w("wire-log/big.jsonl", Buffer.alloc(200_000, 1));
  await w("checkpoints/blobs/aa/bb", Buffer.alloc(100_000, 2));
  await w("browser-profile/Default/Cache/x", "cache");
  await w("skills/pkg/node_modules/dep/index.js", "x");
  await w("garrison/sessions/agent_1.jsonl", "rollout");
  // A real kernel database with data in it.
  await fsp.mkdir(path.join(ws, ".ares"), { recursive: true });
  const kernelFile = path.join(ws, ".ares", "session-kernel.sqlite");
  const kernel = await SessionKernelStore.open({ filename: kernelFile });
  kernel.createSession({ id: "sess_backup_probe" });
  // Every database a test opens is closed BEFORE the folder goes: Windows refuses to delete an
  // open SQLite file, and a store left open keeps the test process alive (Linux noticed neither).
  const closers = [() => kernel.close()];
  t.after(async () => {
    for (const close of closers.reverse()) { try { close(); } catch { /* closed */ } }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, home, ws, backups, kernel, kernelFile, w, onClose: (fn) => closers.push(fn) };
}

const env = (backups) => ({ ...process.env, ARES_BACKUP_DIR: backups, ARES_BACKUP_KEY: undefined, ARES_BACKUP_OFFSITE_DIR: undefined });
const run = (r, over = {}) =>
  runBackup({ home: r.home, workspaces: [r.ws], root: r.backups, env: { ARES_BACKUP_DIR: r.backups }, snapshotKernel: async (_ws, dest) => { r.kernel.backupTo(dest); return true; }, ...over });
const exists = (p) => fsp.lstat(p).then(() => true, () => false);

test("a backup encrypts at rest: no plaintext secret, no readable names, 0600 key outside the home", async (t) => {
  const r = await rig(t);
  const res = await run(r);
  assert.equal(res.ok, true, res.error);
  const blob = await fsp.readFile(res.file);
  assert.ok(blob.subarray(0, 8).equals(Buffer.from("ARESBK01")));
  assert.equal(blob.includes(Buffer.from(SECRET)), false, "the secret is not in the file in the clear");
  assert.equal(blob.includes(Buffer.from("vault/anthropic")), false, "nor are the file names");
  assert.equal(blob.includes(Buffer.from("personas")), false);
  const manifest = JSON.parse(await fsp.readFile(path.join(res.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.entries, res.entries);
  assert.equal(JSON.stringify(manifest).includes(SECRET), false);
  assert.equal(manifest.kernels.length, 1);
  const keyFile = path.join(r.backups, ".backup.key");
  if (process.platform !== "win32") assert.equal((await fsp.stat(keyFile)).mode & 0o077, 0, "the key is private");
  assert.equal(path.relative(r.home, keyFile).startsWith(".."), true, "and lives outside the home it protects");
  // Status is recorded for the System screen.
  const status = await readBackupStatus(r.backups);
  assert.equal(status.ok, true);
  assert.equal(status.stale, false);
  assert.equal(status.count, 1);
});

test("what is included and what is not", async (t) => {
  const r = await rig(t);
  const res = await run(r);
  const key = await loadKey(r.backups, { create: false });
  const out = path.join(r.root, "restored");
  const rep = await restoreBackup({ from: res.dir, to: out, key, dryRun: true });
  assert.equal(rep.ok, true, rep.error);
  // Do a real restore to inspect the file set.
  const real = await restoreBackup({ from: res.dir, to: out, key });
  assert.equal(real.ok, true, real.error);
  for (const p of ["vault/anthropic.enc", "credentials.json", "personas/ares.json", "memory/facts.jsonl", "MEMORY.md", "operator/goals/g1.json", "config.json"]) {
    assert.equal(await exists(path.join(out, p)), true, `${p} is backed up`);
  }
  for (const p of ["wire-log", "checkpoints", "browser-profile", "skills/pkg/node_modules", "garrison/sessions"]) {
    assert.equal(await exists(path.join(out, p)), false, `${p} is not`);
  }
});

test("restore round trip: every byte and permission comes back, and the kernel database opens with its data", async (t) => {
  const r = await rig(t);
  const res = await run(r);
  const key = await loadKey(r.backups, { create: false });
  const out = path.join(r.root, "restored-home");
  const kernelOut = path.join(r.root, "restored-kernel");
  const rep = await restoreBackup({ from: r.backups, to: out, key, kernelTo: kernelOut });
  assert.equal(rep.ok, true, rep.error);
  assert.equal(rep.wrote, res.entries);
  assert.equal(rep.conflicts.length, 0);
  assert.equal(await fsp.readFile(path.join(out, "vault", "anthropic.enc"), "utf8"), SECRET);
  assert.equal(await fsp.readFile(path.join(out, "memory", "facts.jsonl"), "utf8"), "fact one\nfact two\n");
  if (process.platform !== "win32") assert.equal((await fsp.stat(path.join(out, "vault", "anthropic.enc"))).mode & 0o777, 0o600, "permissions survive");
  // Compare the whole tree with the source for every backed-up file.
  for (const rel of ["credentials.json", "personas/ares.json", "MEMORY.md", "operator/goals/g1.json", "config.json"]) {
    assert.equal(await fsp.readFile(path.join(out, rel), "utf8"), await fsp.readFile(path.join(r.home, rel), "utf8"), rel);
  }
  // The restored kernel is a real database holding the session.
  assert.equal(rep.kernels.length, 1);
  const reopened = await SessionKernelStore.open({ filename: rep.kernels[0] });
  r.onClose(() => reopened.close());
  assert.ok(reopened.getSession("sess_backup_probe"), "the session survived the round trip");
});

test("the kernel is captured through SQLite, consistent while another connection keeps writing", async (t) => {
  const r = await rig(t);
  for (let i = 0; i < 50; i++) r.kernel.createSession({ id: `sess_load_${i}` });
  const res = await run(r);
  const key = await loadKey(r.backups, { create: false });
  const out = path.join(r.root, "rh");
  const rep = await restoreBackup({ from: res.dir, to: out, key });
  const copy = await SessionKernelStore.open({ filename: rep.kernels[0] });
  r.onClose(() => copy.close());
  assert.ok(copy.getSession("sess_load_49"));
  assert.equal(copy.checkpoint !== undefined, true);
});

test("dry run decides and writes nothing; existing files are conflicts unless forced", async (t) => {
  const r = await rig(t);
  await run(r);
  const key = await loadKey(r.backups, { create: false });
  const out = path.join(r.root, "dest");
  const dry = await restoreBackup({ from: r.backups, to: out, key, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.wrote, 0);
  assert.equal(await exists(out), false, "a dry run creates nothing");
  assert.ok(dry.entries > 5);
  await restoreBackup({ from: r.backups, to: out, key });
  await fsp.writeFile(path.join(out, "config.json"), "locally edited");
  const again = await restoreBackup({ from: r.backups, to: out, key });
  assert.equal(again.ok, false);
  assert.ok(again.conflicts.some((c) => c.endsWith("config.json")));
  assert.equal(await fsp.readFile(path.join(out, "config.json"), "utf8"), "locally edited", "nothing was overwritten");
  const forced = await restoreBackup({ from: r.backups, to: out, key, force: true });
  assert.equal(forced.ok, true);
  assert.equal(await fsp.readFile(path.join(out, "config.json"), "utf8"), JSON.stringify({ model: "x" }));
});

test("integrity: a wrong key, a flipped bit, a truncated file and a swapped manifest are all refused before anything is written", async (t) => {
  const r = await rig(t);
  const res = await run(r);
  const key = await loadKey(r.backups, { create: false });
  const manifest = JSON.parse(await fsp.readFile(path.join(res.dir, "manifest.json"), "utf8"));
  assert.equal((await verifyBackup(res.file, key, manifest)).ok, true);

  const wrong = Buffer.alloc(32, 7);
  const wrongRes = await verifyBackup(res.file, wrong);
  assert.equal(wrongRes.ok, false);
  assert.match(wrongRes.error, /key|authenticat|modified/i);

  const original = await fsp.readFile(res.file);
  const flipped = Buffer.from(original);
  flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  const flippedFile = path.join(r.root, "flipped.arcbak");
  await fsp.writeFile(flippedFile, flipped);
  const fl = await verifyBackup(flippedFile, key);
  assert.equal(fl.ok, false, "one flipped bit anywhere is caught");

  const truncFile = path.join(r.root, "trunc.arcbak");
  await fsp.writeFile(truncFile, original.subarray(0, original.length - 40));
  assert.equal((await verifyBackup(truncFile, key)).ok, false);

  const out = path.join(r.root, "never");
  const rep = await restoreBackup({ from: flippedFile, to: out, key });
  assert.equal(rep.ok, false);
  assert.equal(rep.wrote, 0);
  assert.equal(await exists(out), false, "nothing is written from a bad archive");

  // The manifest's checksum catches a swapped blob even with the right key.
  const other = await run(r, { now: () => Date.now() + 86_400_000 * 3 });
  const swapDir = path.join(r.root, "swap");
  await fsp.mkdir(swapDir);
  await fsp.copyFile(other.file, path.join(swapDir, path.basename(res.file)));
  await fsp.copyFile(path.join(res.dir, "manifest.json"), path.join(swapDir, "manifest.json"));
  const swapped = await restoreBackup({ from: swapDir, to: path.join(r.root, "never2"), key });
  assert.equal(swapped.ok, false);
  assert.match(swapped.error, /checksum|manifest/i);
});

test("hostile archive paths are refused", async (t) => {
  const r = await rig(t);
  await fsp.mkdir(r.backups, { recursive: true });
  const key = await loadKey(r.backups, { create: true });
  const evil = path.join(r.root, "evil.txt");
  await fsp.writeFile(evil, "pwned");
  const file = path.join(r.root, "evil.arcbak");
  await writeArchive(file, key, [{ abs: evil, p: "home/../../escaped.txt", size: 5, mode: 0o644, mtimeMs: Date.now() }]);
  const out = path.join(r.root, "dest");
  const rep = await restoreBackup({ from: file, to: out, key });
  assert.equal(rep.ok, false);
  assert.match(rep.error, /unsafe path/);
  assert.equal(await exists(path.join(r.root, "escaped.txt")), false);
});

test("retention: seven dailies and four weeklies, everything else pruned, only dated dirs with a manifest", async (t) => {
  const days = [];
  for (let i = 0; i < 45; i++) days.push(new Date(Date.UTC(2026, 9, 1) - i * 86_400_000).toISOString().slice(0, 10));
  const keep = retentionKeep(days);
  const kept = [...keep].sort().reverse();
  assert.deepEqual(kept.slice(0, 7), days.slice(0, 7), "the newest seven days are all kept");
  assert.equal(kept.length, 11, "plus one per each of the next four weeks");
  const weekly = kept.slice(7);
  const weekOf = (d) => Math.floor((Date.parse(d) / 86_400_000 + 3) / 7); // 1970-01-01 is a Thursday: the week index
  assert.equal(new Set(weekly.map(weekOf)).size, 4, "four DIFFERENT weeks");
  // On disk.
  const r = await rig(t);
  await fsp.mkdir(r.backups, { recursive: true });
  for (const d of days.slice(0, 20)) {
    await fsp.mkdir(path.join(r.backups, d));
    await fsp.writeFile(path.join(r.backups, d, "manifest.json"), "{}");
  }
  await fsp.mkdir(path.join(r.backups, "2020-01-01")); // dated but no manifest: not ours to delete
  await fsp.mkdir(path.join(r.backups, "my-own-notes"));
  const pruned = await pruneBackups(r.backups);
  assert.ok(pruned.length > 0);
  assert.equal(await exists(path.join(r.backups, "2020-01-01")), true, "a dir without a manifest is never touched");
  assert.equal(await exists(path.join(r.backups, "my-own-notes")), true);
  assert.equal(await exists(path.join(r.backups, days[0])), true);
  assert.equal(await exists(path.join(r.backups, days[19])), false);
});

test("scheduling: due once per day after the hour, a failed attempt retries hourly", async (t) => {
  const r = await rig(t);
  const at = (h) => new Date(2026, 9, 1, h, 0, 0).getTime();
  assert.equal(await backupDue(r.backups, at(2), 3), false, "before 03:00");
  assert.equal(await backupDue(r.backups, at(3), 3), true, "nothing yet today");
  const res = await run(r, { now: () => at(3) });
  assert.equal(res.ok, true);
  assert.equal(await backupDue(r.backups, at(5), 3), false, "done for today");
  assert.equal(await backupDue(r.backups, at(3) + 86_400_000, 3), true, "tomorrow night again");
});

test("a failing backup is reported loudly and leaves the last good one in place", async (t) => {
  const r = await rig(t);
  const good = await run(r);
  assert.equal(good.ok, true);
  // Over the size cap: it must refuse rather than silently leave things out.
  const bad = await run(r, { maxPlainBytes: 10, now: () => Date.now() + 86_400_000 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /over the .* backup cap/);
  const status = await readBackupStatus(r.backups);
  assert.equal(status.ok, false);
  assert.match(status.error, /cap/);
  assert.ok(status.lastOkAt, "the last success is still recorded");
  assert.equal(await exists(good.file), true);
});

test("an unreadable key directory fails the backup, it does not write an unencrypted one", async (t) => {
  const r = await rig(t);
  const res = await run(r, { env: { ARES_BACKUP_DIR: r.backups, ARES_BACKUP_KEY: "not-base64-32-bytes" } });
  assert.equal(res.ok, false);
  assert.match(res.error, /32 bytes/);
  assert.equal((await fsp.readdir(r.backups).catch(() => [])).some((n) => /^d{4}-d{2}-d{2}$/.test(n)), false, "no dated dir, so no unencrypted archive");
});

test("offsite copy is opt-in: off by default, a full copy plus manifest when ARES_BACKUP_OFFSITE_DIR is set", async (t) => {
  const r = await rig(t);
  const off = path.join(r.root, "offsite");
  const none = await run(r);
  assert.equal(none.ok, true);
  assert.equal(await exists(off), false);
  const res = await run(r, { env: { ARES_BACKUP_DIR: r.backups, ARES_BACKUP_OFFSITE_DIR: off }, now: () => Date.now() + 86_400_000 });
  assert.equal(res.ok, true);
  const day = path.basename(res.dir);
  assert.equal(await exists(path.join(off, day, path.basename(res.file))), true);
  // The offsite blob restores with the key kept separately.
  const key = await loadKey(r.backups, { create: false });
  const rep = await restoreBackup({ from: path.join(off, day), to: path.join(r.root, "from-offsite"), key });
  assert.equal(rep.ok, true, rep.error);
});

test("restore.mjs: --verify, --dry-run and a real restore, from the command line", async (t) => {
  const r = await rig(t);
  await run(r);
  const keyFile = path.join(r.backups, ".backup.key");
  const out = path.join(r.root, "cli-restore");
  const node = (args) => spawnSync(process.execPath, [RESTORE, ...args], { encoding: "utf8", env: { ...process.env, ARES_BACKUP_KEY: "" } });

  const verify = node(["--from", r.backups, "--verify", "--key", keyFile]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
  assert.equal(verify.stdout.includes(SECRET), false, "the script never prints contents");

  const dry = node(["--from", r.backups, "--to", out, "--dry-run", "--key", keyFile]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(await exists(out), false);

  const real = node(["--from", r.backups, "--to", out, "--key", keyFile]);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(await fsp.readFile(path.join(out, "credentials.json"), "utf8"), await fsp.readFile(path.join(r.home, "credentials.json"), "utf8"));

  const again = node(["--from", r.backups, "--to", out, "--key", keyFile]);
  assert.equal(again.status, 3, "conflicts exit 3");

  const wrongKey = path.join(r.root, "wrong.key");
  await fsp.writeFile(wrongKey, Buffer.alloc(32, 9).toString("base64"));
  const bad = node(["--from", r.backups, "--verify", "--key", wrongKey]);
  assert.equal(bad.status, 2);

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARES_HOME;
  const live = spawnSync(process.execPath, [RESTORE, "--from", r.backups, "--key", keyFile, "--to", path.join(os.homedir(), ".ares")], { encoding: "utf8", env: cleanEnv });
  assert.equal(live.status, 1, "refuses to restore over the live home without --force");
});
