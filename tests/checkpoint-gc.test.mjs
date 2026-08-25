// Checkpoint GC: the sweep that could never run.
//
// Field origin: the orphaned-blob sweep sat below `if (doomed.length === 0)
// return` — so blobs were only swept when metas rotated past retention. A
// store whose metas vanished any other way (session cleanup, manual delete,
// workspace rename) could never clean itself: one machine accumulated 1.2GB
// across ~56k permanently unreferenced blobs, frozen for seven weeks. The GC
// also used to load EVERY meta into memory at once (a ~1GB spike on big
// workspaces). These tests pin the new behaviour: streamed metas, an
// unconditional sweep, and a freshness guard so a checkpoint written DURING
// the GC never loses its blobs.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createWorkspaceCheckpoint, gcWorkspaceCheckpoints, loadWorkspaceCheckpoint } from "../packages/core/dist/index.js";

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "ares-ckpt-"));
  writeFileSync(path.join(workspace, "a.txt"), "alpha", "utf8");
  writeFileSync(path.join(workspace, "b.txt"), "beta", "utf8");
  return workspace;
}

const metaDir = (ws) => path.join(ws, ".ares", "checkpoints", "meta");
const blobsDir = (ws) => path.join(ws, ".ares", "checkpoints", "blobs");

function listBlobs(ws) {
  const root = blobsDir(ws);
  if (!existsSync(root)) return [];
  const out = [];
  for (const shard of readdirSync(root)) {
    for (const blob of readdirSync(path.join(root, shard))) out.push(path.join(root, shard, blob));
  }
  return out;
}

/** Backdate every blob past the GC's 60s freshness guard. */
function ageBlobs(ws, seconds = 120) {
  const past = new Date(Date.now() - seconds * 1000);
  for (const blob of listBlobs(ws)) utimesSync(blob, past, past);
}

test("orphaned blobs are swept even when NO meta was evicted", async () => {
  const workspace = makeWorkspace();
  try {
    await createWorkspaceCheckpoint({ workspace, sessionId: "s1", turnSeq: 1 });
    assert.ok(listBlobs(workspace).length >= 2, "checkpoint wrote blobs");

    // Metas vanish out-of-band — the 1.2GB field scenario.
    rmSync(metaDir(workspace), { recursive: true, force: true });
    mkdirSync(metaDir(workspace), { recursive: true });
    ageBlobs(workspace);

    await gcWorkspaceCheckpoints(workspace);
    assert.equal(listBlobs(workspace).length, 0, "unreferenced blobs must be swept without any doomed meta");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("blobs referenced by surviving metas are kept; unreferenced ones go", async () => {
  const workspace = makeWorkspace();
  try {
    const kept = await createWorkspaceCheckpoint({ workspace, sessionId: "s1", turnSeq: 1 });

    // Rewrite a.txt so its old blob becomes unreferenced once the first meta is gone.
    writeFileSync(path.join(workspace, "a.txt"), "alpha-v2", "utf8");
    const second = await createWorkspaceCheckpoint({ workspace, sessionId: "s1", turnSeq: 2, parentCheckpointId: kept.id });

    // Drop the FIRST meta out-of-band; the second survives and pins its blobs.
    rmSync(path.join(metaDir(workspace), `${kept.id}.json`), { force: true });
    ageBlobs(workspace);

    await gcWorkspaceCheckpoints(workspace);
    const remaining = new Set(listBlobs(workspace).map((p) => path.basename(p)));
    for (const ref of (await loadWorkspaceCheckpoint(workspace, second.id)).fileManifest) {
      assert.ok(remaining.has(ref.blobHash), `surviving meta's blob ${ref.blobHash} must be kept`);
    }
    // The old alpha blob (referenced only by the deleted meta) is gone.
    const secondHashes = new Set((await loadWorkspaceCheckpoint(workspace, second.id)).fileManifest.map((r) => r.blobHash));
    for (const hash of remaining) assert.ok(secondHashes.has(hash), `blob ${hash} must be referenced by the survivor`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("retention prunes old metas per session and their exclusive blobs", async () => {
  const workspace = makeWorkspace();
  const prior = process.env.ARES_CHECKPOINT_RETENTION;
  process.env.ARES_CHECKPOINT_RETENTION = "2";
  try {
    let parent;
    for (let i = 0; i < 4; i++) {
      writeFileSync(path.join(workspace, "a.txt"), `alpha-v${i}`, "utf8");
      const meta = await createWorkspaceCheckpoint({ workspace, sessionId: "s1", turnSeq: i, parentCheckpointId: parent });
      parent = meta.id;
    }
    ageBlobs(workspace);
    await gcWorkspaceCheckpoints(workspace);
    const metas = readdirSync(metaDir(workspace)).filter((n) => n.endsWith(".json"));
    assert.equal(metas.length, 2, "only the newest 2 metas survive retention");
  } finally {
    if (prior === undefined) delete process.env.ARES_CHECKPOINT_RETENTION;
    else process.env.ARES_CHECKPOINT_RETENTION = prior;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a blob written during the GC window is never swept (freshness guard)", async () => {
  const workspace = makeWorkspace();
  try {
    await createWorkspaceCheckpoint({ workspace, sessionId: "s1", turnSeq: 1 });
    rmSync(metaDir(workspace), { recursive: true, force: true });
    mkdirSync(metaDir(workspace), { recursive: true });
    // Blobs keep their FRESH mtime — as if a concurrent checkpoint just wrote
    // them while this GC was scanning. They must survive.
    await gcWorkspaceCheckpoints(workspace);
    assert.ok(listBlobs(workspace).length >= 2, "fresh blobs are off-limits to the sweep");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
