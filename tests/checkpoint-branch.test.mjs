// Branch-per-task, the cheap half: a checkpoint chain is already commits, so
// naming one hands the task to ordinary git (merge/diff/discard — no bespoke
// merge machinery for Ares to maintain).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { branchWorkspaceCheckpoint, createWorkspaceCheckpoint } from "../packages/core/dist/checkpoints.js";
import { resetGitCheckpointCache } from "../packages/core/dist/checkpointGit.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

async function tempRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-cp-branch-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  await writeFile(path.join(dir, "a.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  resetGitCheckpointCache();
  return dir;
}

test("a git-layer checkpoint becomes a real branch; HEAD and index untouched", async () => {
  const dir = await tempRepo();
  await writeFile(path.join(dir, "a.txt"), "task work\n");
  const meta = await createWorkspaceCheckpoint({ workspace: dir, sessionId: "sess_t", turnSeq: 1 });
  const before = git(dir, "status", "--porcelain");
  const { branch, commit } = await branchWorkspaceCheckpoint(dir, meta.id, "ares/task-demo");
  assert.equal(branch, "ares/task-demo");
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.equal(git(dir, "rev-parse", "ares/task-demo"), commit);
  assert.equal(git(dir, "status", "--porcelain"), before, "creating the branch must not touch the working tree");
  const blob = git(dir, "show", "ares/task-demo:a.txt");
  assert.equal(blob, "task work");
  // Existing branches are never force-moved.
  await assert.rejects(() => branchWorkspaceCheckpoint(dir, meta.id, "ares/task-demo"), /already exists/);
  // Garbage names are refused before git sees them as refs.
  await assert.rejects(() => branchWorkspaceCheckpoint(dir, meta.id, "bad name"), /invalid branch name/);
});

test("a blob-layer checkpoint (non-git workspace) says so instead of guessing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-cp-nogit-"));
  await writeFile(path.join(dir, "a.txt"), "x\n");
  resetGitCheckpointCache();
  const meta = await createWorkspaceCheckpoint({ workspace: dir, sessionId: "sess_t", turnSeq: 1 });
  await assert.rejects(() => branchWorkspaceCheckpoint(dir, meta.id, "nope"), /blob-layer/);
});
