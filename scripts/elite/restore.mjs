#!/usr/bin/env node
// Restore (or just verify) an Ares backup made by the garrison's nightly job.
//
//   node scripts/elite/restore.mjs --from ~/backups/ares --dry-run
//   node scripts/elite/restore.mjs --from ~/backups/ares/2026-10-01 --to ~/.ares-restored
//   node scripts/elite/restore.mjs --from <file.arcbak> --key ~/keys/ares-backup.key --verify
//
//   --from <path>    a dated backup dir, an .arcbak file, or the backup root (newest wins)
//   --to <dir>       destination Ares home (default ~/.ares-restored; NEVER defaults to the live ~/.ares)
//   --key <file>     base64 key file (default <backup root>/.backup.key, or ARES_BACKUP_KEY)
//   --dry-run        authenticate + checksum everything, list what would be written, write nothing
//   --verify         integrity check only (same as --dry-run without the file plan)
//   --force          overwrite files that already exist in --to
//   --kernel-to <d>  where session-kernel databases go (default <to>/restored-kernel)
//
// Exit codes: 0 ok, 1 usage, 2 integrity/authentication failure, 3 conflicts (re-run with --force).
// Prints one JSON summary; never prints key material or file contents.
// Stop the garrison before restoring over a live home; the safest flow is to
// restore into a fresh directory and swap it in.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { restoreBackup, resolveArchive, verifyBackup, loadKey, backupRoot } = await import(path.join(here, "..", "..", "packages", "cli", "dist", "systemBackup.js"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

const from = expand(value("from")) ?? backupRoot();
const toArg = expand(value("to"));
const to = path.resolve(toArg ?? path.join(os.homedir(), ".ares-restored"));
const live = path.resolve(process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"));
if (flag("help") || flag("h")) {
  console.log(String(await fs.readFile(fileURLToPath(import.meta.url), "utf8")).split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (to === live && !flag("verify") && !flag("dry-run") && !flag("force")) {
  console.error(`refusing to restore over the live home ${live} without --force (stop the garrison first, or restore into a fresh directory)`);
  process.exit(1);
}

let key;
try {
  const keyFile = expand(value("key"));
  if (keyFile) {
    key = Buffer.from((await fs.readFile(keyFile, "utf8")).trim(), "base64");
    if (key.length !== 32) throw new Error("key file must hold 32 bytes, base64 encoded");
  } else {
    const resolved = await resolveArchive(from);
    key = await loadKey(path.dirname(path.dirname(resolved.file)), { create: false }).catch(() => loadKey(path.dirname(resolved.file), { create: false }));
  }
} catch (err) {
  console.error(`cannot load the backup key: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

if (flag("verify")) {
  const { file, manifest } = await resolveArchive(from);
  const result = await verifyBackup(file, key, manifest);
  console.log(JSON.stringify({ archive: file, ...result }, null, 2));
  process.exit(result.ok ? 0 : 2);
}

const report = await restoreBackup({ from, to, key, dryRun: flag("dry-run"), force: flag("force"), kernelTo: expand(value("kernel-to")) });
console.log(JSON.stringify({ ...report, to, conflicts: report.conflicts.length, conflictSample: report.conflicts.slice(0, 5) }, null, 2));
if (report.error && report.conflicts.length === 0) process.exit(2);
process.exit(report.conflicts.length > 0 && !flag("force") && !flag("dry-run") ? 3 : report.ok ? 0 : 2);
