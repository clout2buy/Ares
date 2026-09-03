// Workspace checkpoints — lightweight DAG snapshots for sessions.
//
// Two storage layers behind one API, chosen per workspace:
//   - GIT (checkpointGit.ts): inside a repository, snapshots are git tree
//     objects built through a shadow index. No per-file size cap, .gitignore
//     semantics, `git gc` reclaims. Anchored under refs/ares/checkpoints/.
//   - BLOB (this file): elsewhere, content blobs under .ares/checkpoints/blobs.
//     VCS-agnostic, can checkpoint untracked files, skips files > 2MB.
// Metadata for both lives under .ares/checkpoints/meta (`layer` says which).
// `ARES_CHECKPOINT_GIT=0` forces the blob layer everywhere.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BlobRef, CheckpointMeta } from "@ares/protocol";
import {
  checkpointRefName,
  gitAnchorTree,
  gitCheckpointRoot,
  gitDeleteRefs,
  gitDiffNames,
  gitDiffUnified,
  gitListCheckpointRefs,
  gitRestoreTree,
  gitSnapshotTree,
  serializedForWorkspace,
} from "./checkpointGit.js";

/**
 * Is this workspace too broad to snapshot? A checkpoint of the user's HOME
 * directory (or a drive root) means hashing their entire digital life before
 * the first Write — minutes of dead time, locked app files (browser profiles),
 * and a restore that could touch everything they own. Real case: workspace
 * C:\Users\Clout hashed for 106s, hit a Chrome-locked cache under a sibling
 * agent home, and the EPERM killed the Write. Such workspaces get NO
 * checkpoints (tools run fine; undo is simply unavailable there).
 */
export function isUnsnapshotableWorkspace(workspace: string): boolean {
  const resolved = path.resolve(workspace);
  const home = path.resolve(os.homedir());
  if (resolved === home) return true;
  // home's parents (C:\Users, C:\) and filesystem roots
  if (home.startsWith(resolved + path.sep)) return true;
  return path.dirname(resolved) === resolved; // drive/fs root
}

const IGNORED_DIRS = new Set([
  ".git",
  ".ares",
  // Legacy pre-rename home left ~43k files (a Python voice-venv + old sessions)
  // that were being read+hashed before every single write/shell call.
  ".crix",
  // Sibling agent homes + Windows app data: browser profiles inside hold
  // LOCKED files (Chrome crx caches) that EPERM any reader while running.
  ".crypt",
  "AppData",
  "browser-profile",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  "coverage",
  // Common heavy state/venv/cache dirs that have no business in a snapshot.
  ".venv",
  "venv",
  "__pycache__",
  ".pnpm-store",
  ".turbo",
  ".cache",
  "out",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Per-process (path → mtime,size → hash) cache so a checkpoint re-hashes only
 * files that actually changed since the last snapshot. On a large workspace the
 * old behavior read+sha256'd every file before every write/shell tool call —
 * seconds of tax on the hottest coding path. With the cache, an unchanged file
 * costs one stat. Keyed by absolute path; the blob for a cached hash is assumed
 * present (verified cheaply on reuse).
 */
const fileHashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

/** Keep at most this many checkpoint metas per session; older ones are GC'd
 *  along with any blobs they solely referenced. Override with ARES_CHECKPOINT_RETENTION. */
function checkpointRetention(): number {
  const env = Number(process.env.ARES_CHECKPOINT_RETENTION);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 200;
}

/** Age cap, in addition to the per-session count. Field finding behind the
 *  1.2GB store: retention was ONLY per-session, and sessions are never
 *  expired — every session ever opened kept its newest 200 metas forever, each
 *  pinning blobs, so the "orphan sweep" had nothing orphaned to sweep. Metas
 *  older than ARES_CHECKPOINT_MAX_AGE_DAYS (default 14; 0 disables) are pruned
 *  regardless of session. Undo/rewind across two weeks is not a real workflow. */
function checkpointMaxAgeMs(): number {
  const env = Number(process.env.ARES_CHECKPOINT_MAX_AGE_DAYS);
  const days = Number.isFinite(env) && env >= 0 ? env : 14;
  return days * 24 * 60 * 60 * 1000;
}

export interface CreateCheckpointOptions {
  workspace: string;
  sessionId: string;
  turnSeq: number;
  parentCheckpointId?: string;
  label?: string;
  /** When the tool declares its exact target file(s) (Edit/Write — the HOT
   *  coding path), the checkpoint is INCREMENTAL: re-snapshot only those files
   *  layered on the parent's manifest, instead of walking the whole workspace.
   *  On a 30k-file repo that turns seconds-per-Edit into milliseconds. Tools
   *  with unknowable side effects (shells) omit this and get the full walk. */
  targetFiles?: readonly string[];
  /** Conversation anchor for /rewind (see CheckpointMeta.messageIndex). */
  messageIndex?: number;
  toolUseId?: string;
}

/** Create a checkpoint. Serialized per workspace in-process: the git layer
 *  shares one shadow index, and the blob GC must never interleave with a
 *  checkpoint that is reusing an old blob hash from the in-memory cache. */
export function createWorkspaceCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointMeta> {
  return serializedForWorkspace(opts.workspace, () => createCheckpointUnserialized(opts));
}

async function createCheckpointUnserialized(opts: CreateCheckpointOptions): Promise<CheckpointMeta> {
  // Git layer first; any failure there (git vanished, corrupt shadow index,
  // lock contention past the retries) degrades to the blob layer for THIS
  // checkpoint rather than leaving the tool without an undo point.
  const gitRoot = await gitCheckpointRoot(opts.workspace);
  const gitTree = gitRoot ? await gitSnapshotTree(opts.workspace, opts.targetFiles).catch(() => undefined) : undefined;
  let manifest: BlobRef[] = [];
  if (!gitTree) {
    manifest = (await incrementalManifest(opts).catch(() => null)) ?? (await fullManifest(opts.workspace));
    manifest.sort((a, b) => a.path.localeCompare(b.path));
  }
  // The session is part of the identity: two sessions snapshotting an identical
  // workspace with no parent used to hash to ONE meta file, so the second
  // silently re-labelled the first's checkpoint as its own (and, with refs per
  // session, GC would then reap the other session's anchor as an orphan).
  const id = sha256(
    JSON.stringify({
      session: opts.sessionId,
      parent: opts.parentCheckpointId ?? "",
      manifest: gitTree ? `git:${gitTree}` : manifest.map((m) => `${m.path}:${m.blobHash}`).join("\n"),
    }),
  ).slice(0, 24);
  const meta: CheckpointMeta = {
    id,
    sessionId: opts.sessionId,
    turnSeq: opts.turnSeq,
    parentCheckpointId: opts.parentCheckpointId,
    label: opts.label,
    createdAt: new Date().toISOString(),
    fileManifest: manifest,
    layer: gitTree ? "git" : "blob",
    gitTree,
    messageIndex: opts.messageIndex,
    toolUseId: opts.toolUseId,
  };
  await writeMeta(opts.workspace, meta);
  if (gitTree) scheduleGitAnchor(opts.workspace, meta);
  // Throttled GC — a full meta+blob sweep on EVERY checkpoint was measurable
  // tax on the hottest coding path; every Nth keeps growth bounded all the same.
  // The counter starts AT the threshold so a process that never reaches 25
  // checkpoints (most CLI/desktop sessions) still sweeps once — deferred a few
  // seconds so the first Edit of a session does not pay for it.
  if (++checkpointsSinceGc >= GC_EVERY) {
    checkpointsSinceGc = 0;
    if (startupGcScheduled.has(opts.workspace)) await gcUnserialized(opts.workspace).catch(() => {});
    else scheduleStartupGc(opts.workspace);
  }
  return meta;
}

let checkpointsSinceGc = 25;
const GC_EVERY = 25;
const startupGcScheduled = new Set<string>();

/** One deferred sweep per workspace per process (ARES_CHECKPOINT_GC_DELAY_MS,
 *  default 5s). Unref'd so a short CLI run never waits on it. */
function scheduleStartupGc(workspace: string): void {
  startupGcScheduled.add(workspace);
  const delay = Number(process.env.ARES_CHECKPOINT_GC_DELAY_MS);
  const timer = setTimeout(() => {
    gcWorkspaceCheckpoints(workspace).catch(() => {});
  }, Number.isFinite(delay) && delay >= 0 ? delay : 5_000);
  timer.unref?.();
}

async function writeMeta(workspace: string, meta: CheckpointMeta): Promise<void> {
  await fs.mkdir(metaDir(workspace), { recursive: true });
  await fs.writeFile(path.join(metaDir(workspace), `${meta.id}.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
}

/** Last anchored commit per session (this process) — the parent link for the
 *  next checkpoint commit without re-reading the parent meta each time. */
const lastAnchoredCommit = new Map<string, string>();
const anchorPending = new Map<string, Promise<void>>();

/** Anchor the tree under refs/ares/checkpoints/… on the workspace chain, off
 *  the pre-tool hot path. Fills `gitCommit` into the meta once done. */
function scheduleGitAnchor(workspace: string, meta: CheckpointMeta): void {
  const job = serializedForWorkspace(workspace, async () => {
    let parent = lastAnchoredCommit.get(meta.sessionId);
    if (!parent && meta.parentCheckpointId) {
      parent = (await loadWorkspaceCheckpoint(workspace, meta.parentCheckpointId).catch(() => null))?.gitCommit;
    }
    const commit = await gitAnchorTree(workspace, meta.sessionId, meta.id, meta.gitTree!, parent);
    lastAnchoredCommit.set(meta.sessionId, commit);
    // Merge into the on-disk meta rather than rewrite our in-memory copy: GC
    // may have evicted it meanwhile (resurrecting it would leak its ref).
    const current = await loadWorkspaceCheckpoint(workspace, meta.id).catch(() => null);
    if (current) await writeMeta(workspace, { ...current, gitCommit: commit });
  }).catch(() => {}); // an unanchored tree survives gc's two-week prune window anyway
  const key = path.resolve(workspace);
  const previous = anchorPending.get(key) ?? Promise.resolve();
  anchorPending.set(key, previous.then(() => job));
}

/** Wait for every deferred ref anchor of this workspace (tests, GC, restore). */
export async function settleGitCheckpointAnchors(workspace: string): Promise<void> {
  await anchorPending.get(path.resolve(workspace));
}

/** Full-walk manifest (parallel-stat; the base checkpoint + shell-tool path). */
async function fullManifest(workspace: string): Promise<BlobRef[]> {
  const files = await listWorkspaceFilesWithStats(workspace);
  const manifest: BlobRef[] = [];
  // Hash with bounded concurrency — unchanged files are one cache hit each.
  const CONC = 16;
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONC, files.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= files.length) return;
        const file = files[i];
        const hash = await hashFileCached(workspace, file.path, file.mtimeMs, file.size);
        if (hash === null) continue; // unreadable (locked/EPERM) — excluded from the snapshot
        manifest.push({ path: path.relative(workspace, file.path).replace(/\\/g, "/"), blobHash: hash, mode: 0o100644 });
      }
    }),
  );
  return manifest;
}

/** Incremental manifest: parent manifest + re-snapshot of ONLY the declared
 *  target files. Returns null (→ full walk) when there's no parent to layer on
 *  or no declared targets. */
async function incrementalManifest(opts: CreateCheckpointOptions): Promise<BlobRef[] | null> {
  if (!opts.targetFiles || opts.targetFiles.length === 0 || !opts.parentCheckpointId) return null;
  const parent = await loadWorkspaceCheckpoint(opts.workspace, opts.parentCheckpointId); // throws → full walk
  const byPath = new Map(parent.fileManifest.map((f) => [f.path, f]));
  for (const raw of opts.targetFiles) {
    const full = path.isAbsolute(raw) ? raw : path.join(opts.workspace, raw);
    const rel = path.relative(opts.workspace, full).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) continue; // outside the workspace — not snapshot territory
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
      byPath.delete(rel); // deleted (or no longer snapshotable) since the parent
      continue;
    }
    const hash = await hashFileCached(opts.workspace, full, stat.mtimeMs, stat.size);
    if (hash === null) continue; // unreadable — keep the parent's view of it
    byPath.set(rel, { path: rel, blobHash: hash, mode: 0o100644 });
  }
  return [...byPath.values()];
}

/** Blob hashes known to exist on disk this process. Replaces the per-file
 *  blob-existence stat on every cache hit (34k stats per checkpoint on a big
 *  repo). GC invalidates by deleting from this set. */
const knownBlobs = new Set<string>();

/** Hash a file, reusing the cached hash when mtime+size are unchanged AND the
 *  blob is known present (in-memory set; one stat only on first sighting).
 *  Re-reads only genuinely-changed files. Returns NULL when the file can't be
 *  read (EPERM/EBUSY — e.g. a browser's locked cache): an unreadable file is
 *  simply excluded from the snapshot. It must NEVER kill the checkpoint — a
 *  real turn died exactly this way (a locked Chrome profile under the
 *  workspace EPERM'd the walk and took the Write tool down with it). */
async function hashFileCached(workspace: string, full: string, mtimeMs: number, size: number): Promise<string | null> {
  const cached = fileHashCache.get(full);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    if (knownBlobs.has(cached.hash)) return cached.hash;
    const exists = await fs.stat(blobPath(workspace, cached.hash)).then(() => true).catch(() => false);
    if (exists) {
      knownBlobs.add(cached.hash);
      return cached.hash;
    }
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(full);
  } catch {
    return null; // locked/permission-denied — skip, never throw
  }
  const hash = sha256(bytes);
  await writeBlob(workspace, hash, bytes);
  fileHashCache.set(full, { mtimeMs, size, hash });
  knownBlobs.add(hash);
  return hash;
}

/** Prune checkpoint metas beyond the retention window (per session, newest
 *  kept), then delete blobs no surviving meta references.
 *
 *  Two field lessons shaped this implementation:
 *  1. It used to load EVERY meta simultaneously (Promise.all) and hold the
 *     survivors — each carrying a full fileManifest — across the whole blob
 *     sweep. On a big workspace that is a ~1GB heap spike every 25th
 *     checkpoint. Metas are now streamed one at a time: pass 1 keeps only
 *     identity rows, pass 2 folds survivor hashes into a Set and drops each
 *     manifest immediately.
 *  2. The orphan sweep was gated behind `doomed.length === 0` — so a store
 *     whose metas vanished by any other route (session cleanup, manual
 *     delete, workspace rename) could NEVER clean itself again. One machine
 *     accumulated 1.2GB of permanently unreferenced blobs exactly this way.
 *     The sweep now always runs. */
export function gcWorkspaceCheckpoints(workspace: string): Promise<void> {
  return serializedForWorkspace(workspace, () => gcUnserialized(workspace));
}

async function gcUnserialized(workspace: string): Promise<void> {
  const gcStartedAt = Date.now();
  const retention = checkpointRetention();
  const maxAge = checkpointMaxAgeMs();
  const dir = metaDir(workspace);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));

  // Pass 1 — rank without retaining manifests.
  const rows: Array<{ name: string; id: string; sessionId: string; createdAt: string }> = [];
  let unreadableMetas = false;
  for (const name of names) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as CheckpointMeta;
      rows.push({ name, id: meta.id, sessionId: meta.sessionId, createdAt: meta.createdAt });
    } catch {
      // An unreadable meta may still reference blobs we cannot see. Leave the
      // file alone and (below) skip the blob sweep entirely — deleting blobs
      // a corrupt-but-recoverable meta points at would break its restore.
      unreadableMetas = true;
    }
  }
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    const arr = bySession.get(row.sessionId) ?? [];
    arr.push(row);
    bySession.set(row.sessionId, arr);
  }
  const survivors: string[] = [];
  const survivingRefs = new Set<string>();
  for (const arr of bySession.values()) {
    arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const [index, row] of arr.entries()) {
      const expired = maxAge > 0 && gcStartedAt - Date.parse(row.createdAt) > maxAge;
      if (index < retention && !expired) {
        survivors.push(row.name);
        survivingRefs.add(checkpointRefName(row.sessionId, row.id));
      } else {
        await fs.rm(path.join(dir, row.name), { force: true }).catch(() => {});
      }
    }
  }
  // Git layer: drop every anchor ref whose meta no longer exists (evicted just
  // now OR vanished out-of-band) so the next `git gc` can reclaim the objects.
  // Knob-independent: refs written while the layer was on still need cleaning.
  if (!unreadableMetas && (await gitCheckpointRoot(workspace, { ignoreKnob: true }))) {
    await settleGitCheckpointAnchors(workspace);
    const refs = await gitListCheckpointRefs(workspace).catch(() => [] as string[]);
    await gitDeleteRefs(workspace, refs.filter((ref) => !survivingRefs.has(ref))).catch(() => {});
  }
  if (unreadableMetas) return;

  // Pass 2 — live hashes from survivors, one manifest in memory at a time.
  const live = new Set<string>();
  for (const name of survivors) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as CheckpointMeta;
      for (const ref of meta.fileManifest) live.add(ref.blobHash);
    } catch {
      return; // survivor became unreadable mid-GC — sweeping now is unsafe
    }
  }

  // Sweep orphaned blobs — unconditionally (see note 2 above). A blob written
  // while this GC is running belongs to a checkpoint whose meta we never read,
  // so anything younger than the GC itself is off-limits (the old code could
  // race a concurrent checkpoint and eat its fresh blobs).
  const blobsRoot = path.join(workspace, ".ares", "checkpoints", "blobs");
  const shards = await fs.readdir(blobsRoot).catch(() => [] as string[]);
  for (const shard of shards) {
    const shardDir = path.join(blobsRoot, shard);
    const blobs = await fs.readdir(shardDir).catch(() => [] as string[]);
    for (const hash of blobs) {
      if (live.has(hash)) continue;
      const blobFile = path.join(shardDir, hash);
      const stat = await fs.stat(blobFile).catch(() => null);
      if (!stat || stat.mtimeMs >= gcStartedAt - 60_000) continue;
      await fs.rm(blobFile, { force: true }).catch(() => {});
      knownBlobs.delete(hash); // keep the in-memory existence set honest
    }
  }
}

export async function listWorkspaceCheckpoints(workspace: string): Promise<CheckpointMeta[]> {
  const entries = await fs.readdir(metaDir(workspace)).catch(() => []);
  const metas = await Promise.all(
    entries
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(metaDir(workspace), name), "utf8")) as CheckpointMeta),
  );
  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function loadWorkspaceCheckpoint(workspace: string, id: string): Promise<CheckpointMeta> {
  return JSON.parse(await fs.readFile(path.join(metaDir(workspace), `${id}.json`), "utf8")) as CheckpointMeta;
}

/** Route a git-backed meta to the git layer. Throws when the meta is git-backed
 *  but the workspace can no longer reach git (moved out of the repo). The knob
 *  is deliberately ignored: a checkpoint taken while the layer was on must
 *  stay restorable after the user flips it off. */
async function gitLayerFor(workspace: string, checkpoint: CheckpointMeta): Promise<{ root: string; tree: string } | null> {
  if (checkpoint.layer !== "git" || !checkpoint.gitTree) return null;
  const root = await gitCheckpointRoot(workspace, { ignoreKnob: true });
  if (!root) throw new Error(`checkpoint ${checkpoint.id} is git-backed but ${workspace} is not inside a git repository`);
  return { root, tree: checkpoint.gitTree };
}

export async function diffWorkspaceCheckpoint(
  workspace: string,
  id: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const git = await gitLayerFor(workspace, checkpoint);
  if (git) return serializedForWorkspace(workspace, () => gitDiffNames(workspace, git.tree));
  const current = new Map((await fullManifest(workspace)).map((file) => [file.path, file.blobHash]));
  const snap = new Map(checkpoint.fileManifest.map((f) => [f.path, f.blobHash]));
  const added = [...current.keys()].filter((p) => !snap.has(p)).sort();
  const deleted = [...snap.keys()].filter((p) => !current.has(p)).sort();
  const modified = [...current.entries()]
    .filter(([p, hash]) => snap.has(p) && snap.get(p) !== hash)
    .map(([p]) => p)
    .sort();
  return { added, modified, deleted };
}

/** Restore the workspace to a checkpoint. `files` lists every workspace-
 *  relative path the restore touched (the git layer rewrites only what
 *  differs; the blob layer rewrites the whole manifest) so hosts can drop
 *  read stamps for them. */
export async function restoreWorkspaceCheckpoint(
  workspace: string,
  id: string,
): Promise<{ restored: number; deleted: number; files: string[] }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const git = await gitLayerFor(workspace, checkpoint);
  if (git) return serializedForWorkspace(workspace, () => gitRestoreTree(workspace, git.root, git.tree));
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  const current = await listWorkspaceFiles(workspace);
  const files: string[] = [];
  let deleted = 0;
  for (const file of current) {
    const rel = path.relative(workspace, file).replace(/\\/g, "/");
    if (!manifest.has(rel)) {
      await fs.rm(file, { force: true });
      files.push(rel);
      deleted++;
    }
  }
  let restored = 0;
  for (const ref of checkpoint.fileManifest) {
    const target = path.join(workspace, ref.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(blobPath(workspace, ref.blobHash), target);
    files.push(ref.path);
    restored++;
  }
  return { restored, deleted, files: files.sort() };
}

export async function diffWorkspaceCheckpointUnified(
  workspace: string,
  id: string,
  files?: readonly string[],
  opts: { maxChars?: number; contextLines?: number } = {},
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const git = await gitLayerFor(workspace, checkpoint);
  if (git) {
    return serializedForWorkspace(workspace, () =>
      gitDiffUnified(workspace, git.tree, files, { maxChars: opts.maxChars ?? 40_000, contextLines: opts.contextLines ?? 3 }),
    );
  }
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  // When the caller names the files (the per-tool touchedFiles diff — the hot
  // path), stat ONLY those instead of walking the whole workspace again.
  const currentStats = new Map<string, { path: string; mtimeMs: number; size: number }>();
  let currentFiles: Set<string>;
  let requested: string[];
  if (files?.length) {
    requested = [...new Set(files.map((file) => normalizeRel(workspace, file)))];
    currentFiles = new Set<string>();
    await Promise.all(
      requested.map(async (rel) => {
        const full = path.join(workspace, rel);
        const fileStat = await fs.stat(full).catch(() => null);
        if (fileStat?.isFile() && fileStat.size <= MAX_FILE_BYTES) {
          currentFiles.add(rel);
          currentStats.set(rel, { path: full, mtimeMs: fileStat.mtimeMs, size: fileStat.size });
        }
      }),
    );
  } else {
    const filesWithStats = await listWorkspaceFilesWithStats(workspace);
    for (const file of filesWithStats) currentStats.set(relPath(workspace, file.path), file);
    currentFiles = new Set(currentStats.keys());
    requested = [...new Set([...manifest.keys(), ...currentFiles])].sort();
  }
  const maxChars = opts.maxChars ?? 40_000;
  const contextLines = opts.contextLines ?? 3;
  const parts: string[] = [];
  const changedFiles: string[] = [];
  let size = 0;
  let truncated = false;

  for (const rel of requested) {
    const ref = manifest.get(rel);
    const currentPath = path.join(workspace, rel);
    const currentStat = currentStats.get(rel);
    if (ref && currentStat) {
      const currentHash = await hashFileCached(workspace, currentStat.path, currentStat.mtimeMs, currentStat.size);
      if (currentHash === ref.blobHash) continue;
    }

    changedFiles.push(rel);
    if (truncated) continue; // keep enumerating file names; only patch text is capped
    const before = ref ? await fs.readFile(blobPath(workspace, ref.blobHash), "utf8").catch(() => "") : "";
    const after = currentFiles.has(rel) ? await fs.readFile(currentPath, "utf8").catch(() => "") : "";
    const patch = unifiedFileDiff(rel, before, after, contextLines);
    if (!patch) continue;
    if (size + patch.length > maxChars) {
      const remaining = Math.max(0, maxChars - size);
      if (remaining > 0) parts.push(patch.slice(0, remaining));
      truncated = true;
      continue;
    }
    parts.push(patch);
    size += patch.length;
  }

  return { diff: parts.join("\n"), files: changedFiles, truncated };
}

async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  return (await listWorkspaceFilesWithStats(workspace)).map((f) => f.path);
}

async function listWorkspaceFilesWithStats(
  workspace: string,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const subdirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) subdirs.push(full);
      else if (entry.isFile()) files.push(full);
    }
    // Stat this directory's files CONCURRENTLY — the old one-await-per-file
    // pattern serialized ~34k round-trips through the fs (and the AV scanner).
    await Promise.all(
      files.map(async (full) => {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.size <= MAX_FILE_BYTES) out.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }),
    );
    await Promise.all(subdirs.map((sub) => walk(sub)));
  }
  await walk(workspace);
  return out;
}

function unifiedFileDiff(rel: string, before: string, after: string, contextLines: number): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const oldStart = Math.max(0, prefix - contextLines);
  const newStart = Math.max(0, prefix - contextLines);
  const oldEnd = Math.min(beforeLines.length, beforeLines.length - suffix + contextLines);
  const newEnd = Math.min(afterLines.length, afterLines.length - suffix + contextLines);
  const oldCount = Math.max(0, oldEnd - oldStart);
  const newCount = Math.max(0, newEnd - newStart);
  const out = [`--- a/${rel}`, `+++ b/${rel}`, `@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`];

  const commonBefore = Math.min(prefix, oldEnd) - oldStart;
  for (let idx = 0; idx < commonBefore; idx++) out.push(` ${beforeLines[oldStart + idx]}`);

  for (let idx = prefix; idx < beforeLines.length - suffix; idx++) {
    if (idx >= oldStart && idx < oldEnd) out.push(`-${beforeLines[idx]}`);
  }
  for (let idx = prefix; idx < afterLines.length - suffix; idx++) {
    if (idx >= newStart && idx < newEnd) out.push(`+${afterLines[idx]}`);
  }

  const oldTailStart = Math.max(prefix, beforeLines.length - suffix);
  for (let idx = oldTailStart; idx < oldEnd; idx++) out.push(` ${beforeLines[idx]}`);
  return out.join("\n") + "\n";
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

function relPath(workspace: string, file: string): string {
  return path.relative(workspace, file).replace(/\\/g, "/");
}

function normalizeRel(workspace: string, file: string): string {
  return path.isAbsolute(file) ? relPath(workspace, file) : file.replace(/\\/g, "/");
}

async function writeBlob(workspace: string, hash: string, bytes: Buffer): Promise<void> {
  const file = blobPath(workspace, hash);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function blobPath(workspace: string, hash: string): string {
  return path.join(workspace, ".ares", "checkpoints", "blobs", hash.slice(0, 2), hash);
}

function metaDir(workspace: string): string {
  return path.join(workspace, ".ares", "checkpoints", "meta");
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}
