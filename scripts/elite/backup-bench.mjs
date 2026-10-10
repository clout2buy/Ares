#!/usr/bin/env node
// Time and size a REAL backup of a real Ares home, then restore it into a scratch
// directory and compare, without writing anything to the live home or the live
// backup root: everything lands under a throwaway directory that is removed at
// the end.
//   node scripts/elite/backup-bench.mjs [~/.ares] [workspace]
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { runBackup, restoreBackup, loadKey, pickHomeFiles } = await import(path.join(root, "packages/cli/dist/systemBackup.js"));

const home = path.resolve(process.argv[2] ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"));
const workspace = path.resolve(process.argv[3] ?? path.join(os.homedir(), "Ares"));
const scratch = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "ares-backup-bench-"));
const mb = (n) => Math.round((n / 1_048_576) * 10) / 10;
try {
  const picked = await pickHomeFiles(home);
  const t0 = performance.now();
  const res = await runBackup({ home, workspaces: [workspace], root: path.join(scratch, "backups"), env: { ARES_BACKUP_DIR: path.join(scratch, "backups") } });
  const backupMs = performance.now() - t0;
  if (!res.ok) throw new Error(res.error);
  const key = await loadKey(path.join(scratch, "backups"), { create: false });
  const t1 = performance.now();
  const rep = await restoreBackup({ from: path.join(scratch, "backups"), to: path.join(scratch, "restored"), key });
  const restoreMs = performance.now() - t1;
  console.log(JSON.stringify({
    home: home.replace(os.homedir(), "~"),
    selected: { files: picked.files.length, plainMb: mb(picked.files.reduce((n, f) => n + f.size, 0)), skipped: picked.skipped.length },
    backup: { ms: Math.round(backupMs), encryptedMb: mb(res.size), entries: res.entries, verifiedOnWrite: true },
    restore: { ms: Math.round(restoreMs), ok: rep.ok, wrote: rep.wrote, conflicts: rep.conflicts.length, error: rep.error },
  }, null, 2));
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
