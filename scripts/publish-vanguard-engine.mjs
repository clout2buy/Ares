// Publishes the vendored Vanguard engine to the rolling "vanguard-engine"
// release tag, where installed Ares apps auto-update it at daemon boot —
// no app installer required.
//
// Usage: node scripts/publish-vanguard-engine.mjs
// Requires: gh CLI authenticated for the Ares repo, tar on PATH.
// Run scripts/sync-vanguard.mjs first so vendor/vanguard is current.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "vanguard");
const TAG = "vanguard-engine";

// Windows system bsdtar handles drive-letter paths; GNU tar from Git Bash
// treats "C:" as a remote host.
const TAR = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};

const version = JSON.parse(readFileSync(path.join(vendor, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected engine version: ${version}`);

const staging = mkdtempSync(path.join(os.tmpdir(), "vanguard-engine-pub-"));
try {
  const tarballName = `vanguard-engine-${version}.tar.gz`;
  const tarball = path.join(staging, tarballName);
  run(TAR, ["-czf", tarball, "-C", vendor, "."]);
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  const manifest = path.join(staging, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ version, tarball: tarballName, sha256 }, null, 2));

  const exists = spawnSync("gh", ["release", "view", TAG], { encoding: "utf8", windowsHide: true, cwd: root });
  if (exists.status !== 0) {
    run("gh", ["release", "create", TAG,
      "--title", "Vanguard Engine (rolling)",
      "--notes", "Rolling Vanguard engine channel. Installed Ares apps check this release at daemon boot and update the drive engine in place — newest manifest.json wins.",
      "--latest=false",
    ], { cwd: root });
  }
  run("gh", ["release", "upload", TAG, tarball, manifest, "--clobber"], { cwd: root });
  console.log(`Published vanguard engine ${version} (sha256 ${sha256.slice(0, 12)}…) to release '${TAG}'.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
