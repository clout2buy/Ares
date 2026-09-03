// Windows 8.3 short paths vs git's long-name toplevel — the CI-runner failure.
//
// CI hands processes TEMP as C:\Users\RUNNER~1\… while git resolves the same
// repo's toplevel to C:\Users\runneradmin\…. Relative math between the two
// forms fabricated an ..\..\ escape chain and cat-file refused the restore
// ("is outside repository"). canonicalDir() in checkpointGit normalizes both
// sides; this test drives the layer through a real short-name alias so the
// regression can never land silently again. Skips where the volume has no
// short names (8.3 generation off) and on non-Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "../packages/core/dist/checkpoints.js";
import { resetGitCheckpointCache } from "../packages/core/dist/checkpointGit.js";

test("git-layer restore works from an 8.3 short-name workspace path", (t) => {
  if (process.platform !== "win32") {
    t.skip("8.3 short names are a Windows condition");
    return;
  }
  const long = mkdtempSync(path.join(tmpdir(), "ares-shortname-"));
  const short = execSync(`for %I in ("${long}") do @echo %~sI`, { shell: "cmd.exe" }).toString().trim();
  if (!short || short.toLowerCase() === long.toLowerCase()) {
    t.skip("volume has no 8.3 short names (fsutil 8dot3name disabled)");
    return;
  }
  return (async () => {
    const git = (...args) => execFileSync("git", args, { cwd: short, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(path.join(short, "a.txt"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    resetGitCheckpointCache();

    writeFileSync(path.join(short, "a.txt"), "checkpointed\n");
    const meta = await createWorkspaceCheckpoint({ workspace: short, sessionId: "sess_short", turnSeq: 1 });
    assert.equal(meta.layer, "git", "short-name path must still resolve the git layer");

    writeFileSync(path.join(short, "a.txt"), "post-checkpoint damage\n");
    const res = await restoreWorkspaceCheckpoint(short, meta.id);
    assert.equal(res.restored, 1);
    assert.equal(readFileSync(path.join(short, "a.txt"), "utf8"), "checkpointed\n");
  })();
});
