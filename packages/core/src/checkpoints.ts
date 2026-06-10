// Workspace checkpoints — lightweight DAG snapshots for sessions.
//
// Stores content blobs under .ares/checkpoints/blobs and checkpoint
// metadata under .ares/checkpoints/meta. This is intentionally local and
// VCS-agnostic: it can checkpoint untracked files too.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BlobRef, CheckpointMeta } from "@ares/protocol";

const IGNORED_DIRS = new Set([".git", ".ares", "node_modules", "dist", "build", "target", ".next", "coverage"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface CreateCheckpointOptions {
  workspace: string;
  sessionId: string;
  turnSeq: number;
  parentCheckpointId?: string;
  label?: string;
}

export async function createWorkspaceCheckpoint(opts: CreateCheckpointOptions): Promise<CheckpointMeta> {
  const files = await listWorkspaceFiles(opts.workspace);
  const manifest: BlobRef[] = [];
  for (const file of files) {
    const bytes = await fs.readFile(file);
    const hash = sha256(bytes);
    await writeBlob(opts.workspace, hash, bytes);
    const rel = path.relative(opts.workspace, file).replace(/\\/g, "/");
    manifest.push({ path: rel, blobHash: hash, mode: 0o100644 });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const id = sha256(
    JSON.stringify({
      parent: opts.parentCheckpointId ?? "",
      manifest: manifest.map((m) => `${m.path}:${m.blobHash}`).join("\n"),
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
  };
  await fs.mkdir(metaDir(opts.workspace), { recursive: true });
  await fs.writeFile(path.join(metaDir(opts.workspace), `${id}.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
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

export async function diffWorkspaceCheckpoint(
  workspace: string,
  id: string,
): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const currentFiles = await listWorkspaceFiles(workspace);
  const current = new Map<string, string>();
  for (const file of currentFiles) {
    current.set(path.relative(workspace, file).replace(/\\/g, "/"), sha256(await fs.readFile(file)));
  }
  const snap = new Map(checkpoint.fileManifest.map((f) => [f.path, f.blobHash]));
  const added = [...current.keys()].filter((p) => !snap.has(p)).sort();
  const deleted = [...snap.keys()].filter((p) => !current.has(p)).sort();
  const modified = [...current.entries()]
    .filter(([p, hash]) => snap.has(p) && snap.get(p) !== hash)
    .map(([p]) => p)
    .sort();
  return { added, modified, deleted };
}

export async function restoreWorkspaceCheckpoint(workspace: string, id: string): Promise<{ restored: number; deleted: number }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  const current = await listWorkspaceFiles(workspace);
  let deleted = 0;
  for (const file of current) {
    const rel = path.relative(workspace, file).replace(/\\/g, "/");
    if (!manifest.has(rel)) {
      await fs.rm(file, { force: true });
      deleted++;
    }
  }
  let restored = 0;
  for (const ref of checkpoint.fileManifest) {
    const target = path.join(workspace, ref.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(blobPath(workspace, ref.blobHash), target);
    restored++;
  }
  return { restored, deleted };
}

export async function diffWorkspaceCheckpointUnified(
  workspace: string,
  id: string,
  files?: readonly string[],
  opts: { maxChars?: number; contextLines?: number } = {},
): Promise<{ diff: string; files: string[]; truncated: boolean }> {
  const checkpoint = await loadWorkspaceCheckpoint(workspace, id);
  const manifest = new Map(checkpoint.fileManifest.map((f) => [f.path, f]));
  const currentFiles = new Set((await listWorkspaceFiles(workspace)).map((file) => relPath(workspace, file)));
  const requested = files?.length
    ? files.map((file) => normalizeRel(workspace, file))
    : [...new Set([...manifest.keys(), ...currentFiles])].sort();
  const maxChars = opts.maxChars ?? 40_000;
  const contextLines = opts.contextLines ?? 3;
  const parts: string[] = [];
  const changedFiles: string[] = [];
  let size = 0;
  let truncated = false;

  for (const rel of requested) {
    const ref = manifest.get(rel);
    const currentPath = path.join(workspace, rel);
    const before = ref ? await fs.readFile(blobPath(workspace, ref.blobHash), "utf8").catch(() => "") : "";
    const after = currentFiles.has(rel) ? await fs.readFile(currentPath, "utf8").catch(() => "") : "";
    if (before === after) continue;

    const patch = unifiedFileDiff(rel, before, after, contextLines);
    if (!patch) continue;
    changedFiles.push(rel);
    if (size + patch.length > maxChars) {
      const remaining = Math.max(0, maxChars - size);
      if (remaining > 0) parts.push(patch.slice(0, remaining));
      truncated = true;
      break;
    }
    parts.push(patch);
    size += patch.length;
  }

  return { diff: parts.join("\n"), files: changedFiles, truncated };
}

async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat && stat.size <= MAX_FILE_BYTES) out.push(full);
      }
    }
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
