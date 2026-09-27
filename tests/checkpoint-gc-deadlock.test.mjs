// Regression: the git checkpoint layer used to deadlock the whole workspace
// chain on the 26th checkpoint of a process. createCheckpointUnserialized ran
// inside its serialized slot, queued its own ref anchor BEHIND that slot, and
// then (every 25th checkpoint) awaited gc inline — gc waited for pending
// anchors, the anchor waited for the slot, and every later pre-tool checkpoint
// on that workspace hung until the process restarted. On the garrison that
// looked like "Ares stuck on thinking for 8 hours".

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkspaceCheckpoint,
  settleGitCheckpointAnchors,
  resetGitCheckpointCache,
} from "../packages/core/dist/index.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, windowsHide: true, encoding: "utf8" });

function makeRepo() {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-gcdeadlock-"));
  git(ws, "init", "-q");
  writeFileSync(path.join(ws, ".gitignore"), ".ares/\n", "utf8");
  writeFileSync(path.join(ws, "a.txt"), "alpha", "utf8");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  resetGitCheckpointCache();
  return ws;
}

function bounded(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} hung for ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test("git layer: 60 consecutive checkpoints (crossing the inline-gc threshold twice) all settle", async () => {
  delete process.env.ARES_CHECKPOINT_GIT;
  process.env.ARES_CHECKPOINT_GC_DELAY_MS = "0";
  const ws = makeRepo();
  try {
    let parent;
    for (let i = 0; i < 60; i++) {
      writeFileSync(path.join(ws, "a.txt"), `rev-${i}`, "utf8");
      const meta = await bounded(
        createWorkspaceCheckpoint({ workspace: ws, sessionId: "s1", turnSeq: i, parentCheckpointId: parent }),
        15_000,
        `checkpoint ${i}`,
      );
      assert.equal(meta.layer, "git");
      parent = meta.id;
    }
    await bounded(settleGitCheckpointAnchors(ws), 15_000, "anchor settle");
  } finally {
    delete process.env.ARES_CHECKPOINT_GC_DELAY_MS;
    rmSync(ws, { recursive: true, force: true });
  }
});
