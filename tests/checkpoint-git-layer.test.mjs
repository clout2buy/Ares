// Git-backed checkpoint layer.
//
// Inside a repository, checkpoints are git tree objects built through a
// SHADOW index — the user's real index/HEAD/branches are never touched, big
// files are no longer skipped (the blob layer's silent 2MB hole), and every
// tree is anchored under refs/ares/checkpoints/<session>/<id> so `git gc`
// keeps it until retention GC deletes the ref. ARES_CHECKPOINT_GIT=0 forces
// the legacy blob layer.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  diffWorkspaceCheckpointUnified,
  loadWorkspaceCheckpoint,
  gcWorkspaceCheckpoints,
  settleGitCheckpointAnchors,
  resetGitCheckpointCache,
  checkpointRefName,
} from "../packages/core/dist/index.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, windowsHide: true, encoding: "utf8" });

function makeRepo() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-gitckpt-"));
  git(ws, "init", "-q");
  writeFileSync(path.join(ws, ".gitignore"), ".ares/\nignored.log\n", "utf8");
  writeFileSync(path.join(ws, "a.txt"), "alpha", "utf8");
  mkdirSync(path.join(ws, "src"));
  writeFileSync(path.join(ws, "src", "b.txt"), "beta", "utf8");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  // A dirty working tree + an untracked file: exactly what a real workspace looks like.
  writeFileSync(path.join(ws, "a.txt"), "alpha-dirty", "utf8");
  writeFileSync(path.join(ws, "untracked.txt"), "loose", "utf8");
  writeFileSync(path.join(ws, "ignored.log"), "noise", "utf8");
  resetGitCheckpointCache();
  return ws;
}

const status = (ws) => git(ws, "status", "--porcelain=v1", "--untracked-files=all");
const head = (ws) => git(ws, "rev-parse", "HEAD").trim();
const refs = (ws) => git(ws, "for-each-ref", "--format=%(refname)", "refs/ares/checkpoints/").split(/\r?\n/).filter(Boolean);

test("git layer: checkpoint → edit/add/delete (incl. a 3MB file) → restore returns all three, user's git untouched", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  const ws = makeRepo();
  try {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
    writeFileSync(path.join(ws, "big.bin"), big);
    const statusBefore = status(ws);
    const headBefore = head(ws);

    const cp = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_git_1", turnSeq: 1, label: "before" });
    assert.equal(cp.layer, "git");
    assert.match(cp.gitTree, /^[0-9a-f]{40}$/);
    assert.equal(cp.fileManifest.length, 0, "git metas carry no blob manifest");
    assert.equal(status(ws), statusBefore, "checkpointing never touches the user's index");

    // Mutate: edit, add, delete — and clobber the big file too.
    writeFileSync(path.join(ws, "a.txt"), "alpha-CHANGED", "utf8");
    writeFileSync(path.join(ws, "new.txt"), "new", "utf8");
    rmSync(path.join(ws, "src", "b.txt"));
    writeFileSync(path.join(ws, "big.bin"), "tiny now", "utf8");
    writeFileSync(path.join(ws, "ignored.log"), "noise-changed", "utf8");

    const diff = await diffWorkspaceCheckpoint(ws, cp.id);
    assert.deepEqual(diff, { added: ["new.txt"], modified: ["a.txt", "big.bin"], deleted: ["src/b.txt"] });
    const unified = await diffWorkspaceCheckpointUnified(ws, cp.id, ["a.txt"]);
    assert.deepEqual(unified.files, ["a.txt"]);
    assert.match(unified.diff, /-alpha-dirty/);
    assert.match(unified.diff, /\+alpha-CHANGED/);

    const result = await restoreWorkspaceCheckpoint(ws, cp.id);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "alpha-dirty", "edit reverted");
    assert.equal(existsSync(path.join(ws, "new.txt")), false, "added file removed");
    assert.equal(readFileSync(path.join(ws, "src", "b.txt"), "utf8"), "beta", "deleted file recreated");
    assert.ok(readFileSync(path.join(ws, "big.bin")).equals(big), "3MB file restored byte-for-byte (no 2MB hole)");
    assert.equal(readFileSync(path.join(ws, "ignored.log"), "utf8"), "noise-changed", "gitignored files are outside the snapshot");
    assert.deepEqual(result.files, ["a.txt", "big.bin", "new.txt", "src/b.txt"]);
    assert.equal(result.deleted, 1);
    assert.equal(result.restored, 3);

    assert.equal(head(ws), headBefore, "HEAD never moved");
    assert.equal(status(ws), statusBefore, "restore leaves the user's index/HEAD/branches exactly as they were");

    await settleGitCheckpointAnchors(ws);
    assert.deepEqual(refs(ws), [checkpointRefName("sess_git_1", cp.id)], "tree anchored by a ref so git gc keeps it");
    const anchored = await loadWorkspaceCheckpoint(ws, cp.id);
    assert.match(anchored.gitCommit, /^[0-9a-f]{40}$/);
    assert.equal(git(ws, "rev-parse", `${anchored.gitCommit}^{tree}`).trim(), cp.gitTree);
    assert.equal(git(ws, "rev-parse", "HEAD").trim(), headBefore);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("git layer: incremental (declared-target) checkpoints see the parent's world plus the target", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  const ws = makeRepo();
  try {
    const base = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_git_inc", turnSeq: 1 });
    writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    const inc = await createWorkspaceCheckpoint({
      workspace: ws, sessionId: "sess_git_inc", turnSeq: 2, parentCheckpointId: base.id, targetFiles: [path.join(ws, "a.txt")],
    });
    assert.notEqual(inc.gitTree, base.gitTree);
    writeFileSync(path.join(ws, "a.txt"), "v3", "utf8");
    await restoreWorkspaceCheckpoint(ws, inc.id);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "v2");
    assert.equal(readFileSync(path.join(ws, "untracked.txt"), "utf8"), "loose", "untracked files travel with the snapshot");
    await settleGitCheckpointAnchors(ws);
    const parentCommit = (await loadWorkspaceCheckpoint(ws, base.id)).gitCommit;
    const childCommit = (await loadWorkspaceCheckpoint(ws, inc.id)).gitCommit;
    assert.equal(git(ws, "rev-parse", `${childCommit}^`).trim(), parentCommit, "session checkpoints chain as commits");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("git layer: retention GC deletes the refs of evicted checkpoints", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  const priorRetention = process.env.ARES_CHECKPOINT_RETENTION;
  process.env.ARES_CHECKPOINT_RETENTION = "2";
  const ws = makeRepo();
  try {
    const ids = [];
    let parent;
    for (let i = 0; i < 4; i++) {
      writeFileSync(path.join(ws, "a.txt"), `v${i}`, "utf8");
      const cp = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_git_gc", turnSeq: i, parentCheckpointId: parent });
      ids.push(cp.id);
      parent = cp.id;
      await new Promise((r) => setTimeout(r, 5)); // distinct createdAt ordering
    }
    await settleGitCheckpointAnchors(ws);
    assert.equal(refs(ws).length, 4);
    // Simulate one meta vanishing out-of-band as well.
    rmSync(path.join(ws, ".ares", "checkpoints", "meta", `${ids[3]}.json`));
    await gcWorkspaceCheckpoints(ws);
    const remaining = readdirSync(path.join(ws, ".ares", "checkpoints", "meta")).filter((n) => n.endsWith(".json"));
    assert.deepEqual(remaining.sort(), [ids[1], ids[2]].map((id) => `${id}.json`).sort(), "newest 2 surviving metas");
    assert.deepEqual(refs(ws).sort(), [ids[1], ids[2]].map((id) => checkpointRefName("sess_git_gc", id)).sort(), "refs follow the metas");
  } finally {
    if (priorRetention === undefined) delete process.env.ARES_CHECKPOINT_RETENTION;
    else process.env.ARES_CHECKPOINT_RETENTION = priorRetention;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("git layer: age cap prunes stale metas regardless of session (the 1.2GB leak)", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  const priorAge = process.env.ARES_CHECKPOINT_MAX_AGE_DAYS;
  process.env.ARES_CHECKPOINT_MAX_AGE_DAYS = "1";
  const ws = makeRepo();
  try {
    const old = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_old", turnSeq: 1 });
    const metaPath = path.join(ws, ".ares", "checkpoints", "meta", `${old.id}.json`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta), "utf8");
    // Same tree, no parent, different session: must NOT collide with `old`'s meta.
    const fresh = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_new", turnSeq: 1 });
    assert.notEqual(fresh.id, old.id, "checkpoint identity includes the session");
    await gcWorkspaceCheckpoints(ws);
    assert.equal(existsSync(metaPath), false, "a 3-day-old meta is gone under a 1-day cap");
    assert.equal(existsSync(path.join(ws, ".ares", "checkpoints", "meta", `${fresh.id}.json`)), true);
  } finally {
    if (priorAge === undefined) delete process.env.ARES_CHECKPOINT_MAX_AGE_DAYS;
    else process.env.ARES_CHECKPOINT_MAX_AGE_DAYS = priorAge;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ARES_CHECKPOINT_GIT=0 forces the blob layer even inside a repo", async () => {
  process.env.ARES_CHECKPOINT_GIT = "0";
  const ws = makeRepo();
  try {
    const cp = await createWorkspaceCheckpoint({ workspace: ws, sessionId: "sess_blob", turnSeq: 1 });
    assert.equal(cp.layer, "blob");
    assert.equal(cp.gitTree, undefined);
    assert.ok(cp.fileManifest.some((ref) => ref.path === "a.txt"));
    assert.equal(existsSync(path.join(ws, ".ares", "checkpoints", "blobs")), true);
    writeFileSync(path.join(ws, "a.txt"), "changed", "utf8");
    const result = await restoreWorkspaceCheckpoint(ws, cp.id);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "alpha-dirty");
    assert.ok(result.files.includes("a.txt"), "blob restore reports touched files too");
    assert.equal(refs(ws).length, 0, "no refs when the layer is off");
  } finally {
    delete process.env.ARES_CHECKPOINT_GIT;
    rmSync(ws, { recursive: true, force: true });
  }
});
