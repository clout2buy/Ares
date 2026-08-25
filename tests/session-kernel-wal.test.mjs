// WAL hygiene: the 411MB file nobody ever asked to shrink.
//
// Field origin: a workspace session-kernel sat beside a 411MB -wal (4× the
// database). wal_autocheckpoint only folds frames opportunistically on
// commit, and the WAL file only RESETS when a checkpoint completes with no
// concurrent reader — with the daemon, the garrison, and agent runtimes all
// holding the store open, that moment never arrives by chance. maintainWal is
// the deliberate ask, called at store open and from the daemon's idle sweep.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { SessionKernelStore } from "../packages/core/dist/index.js";

// Resolve better-sqlite3 through @ares/core's own dependency tree — pnpm's
// strict layout hides it from the repo root.
const require = createRequire(new URL("../packages/core/dist/index.js", import.meta.url));
const BetterSqlite3 = require("better-sqlite3");

test("maintainWal(TRUNCATE) folds and resets the WAL file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-wal-"));
  const filename = path.join(dir, "session-kernel.sqlite");
  try {
    const store = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    // Generate WAL frames.
    for (let i = 0; i < 50; i++) store.createSession({ id: `sess_wal_${i}` });
    const walPath = `${filename}-wal`;
    assert.ok(existsSync(walPath), "writes produce a WAL file");
    assert.ok(statSync(walPath).size > 0, "the WAL holds frames before maintenance");

    const result = store.maintainWal("TRUNCATE");
    assert.ok(result, "maintenance reports its result");
    assert.equal(result.busy, 0, "no reader blocks a single-connection truncate");
    assert.equal(statSync(walPath).size, 0, "TRUNCATE resets the WAL file to zero bytes");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintainWal never throws — even on a closed store", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-wal-"));
  const filename = path.join(dir, "session-kernel.sqlite");
  try {
    const store = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    store.close();
    assert.equal(store.maintainWal("TRUNCATE"), null, "closed store reports null instead of throwing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("open folds a WAL left behind by a previous generation", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ares-wal-"));
  const filename = path.join(dir, "session-kernel.sqlite");
  try {
    const first = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    for (let i = 0; i < 50; i++) first.createSession({ id: `sess_gen_${i}` });
    first.close();

    const reopened = await SessionKernelStore.open({ filename, Database: BetterSqlite3 });
    const walPath = `${filename}-wal`;
    // The open-time TRUNCATE ran; whatever WAL exists now is only the open's
    // own bookkeeping, not the previous generation's backlog.
    if (existsSync(walPath)) {
      assert.ok(statSync(walPath).size < 64 * 1024, "reopen folds the inherited WAL");
    }
    assert.equal(reopened.getSession("sess_gen_0")?.id, "sess_gen_0", "data survives the fold");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
