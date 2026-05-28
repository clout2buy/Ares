// Persistence guarantees.
//
// ~/.crix/ (or $CRIX_HOME) is the agent's immortal home — it lives outside
// any source repo, so `git clean`, `pnpm install`, full rebuilds, even
// nuking and re-cloning the Crix sources cannot touch it. The agent's
// evolution accumulates here forever.
//
// To be extra safe against drift, file corruption, or user accidents, we
// snapshot the brain files into ~/.crix/snapshots/<sessionId>/ at the
// start of every session. Snapshots are cheap (a few KB), keep the last
// 20 by default, and let the agent (or the human) restore.

import path from "node:path";
import { promises as fs } from "node:fs";
import { agentPaths, crixAgentHome } from "./paths.js";
import { exists } from "./files.js";

const SNAPSHOT_LIMIT = 20;

export interface SnapshotInfo {
  id: string;
  dir: string;
  createdAt: string;
  files: string[];
  totalBytes: number;
}

const BRAIN_FILES = ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "CAPABILITIES.md"] as const;

/**
 * Snapshot the agent's brain files into ~/.crix/snapshots/<id>/.
 * Idempotent. Skips if no brain files exist yet (pre-bootstrap).
 */
export async function snapshotBrain(opts: { home?: string; id?: string; now?: Date }): Promise<SnapshotInfo | null> {
  const home = crixAgentHome(opts.home);
  const paths = agentPaths(home);
  const now = opts.now ?? new Date();
  const id = opts.id ?? `snap_${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const snapshotsRoot = path.join(home, "snapshots");
  const dir = path.join(snapshotsRoot, id);

  // Skip if nothing to snapshot (fresh install, pre-bootstrap).
  let anyExists = false;
  for (const name of BRAIN_FILES) {
    if (await exists(path.join(paths.home, name))) {
      anyExists = true;
      break;
    }
  }
  if (!anyExists) return null;

  await fs.mkdir(dir, { recursive: true });
  const copied: string[] = [];
  let totalBytes = 0;
  for (const name of BRAIN_FILES) {
    const src = path.join(paths.home, name);
    if (!(await exists(src))) continue;
    const dest = path.join(dir, name);
    const data = await fs.readFile(src);
    await fs.writeFile(dest, data);
    copied.push(name);
    totalBytes += data.byteLength;
  }
  // Also snapshot the latest 3 daily memory files since they hold raw signals.
  try {
    const memEntries = await fs.readdir(paths.memoryDir, { withFileTypes: true });
    const dailies = memEntries
      .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(-3);
    if (dailies.length > 0) {
      const memDir = path.join(dir, "memory");
      await fs.mkdir(memDir, { recursive: true });
      for (const name of dailies) {
        const data = await fs.readFile(path.join(paths.memoryDir, name));
        await fs.writeFile(path.join(memDir, name), data);
        copied.push(`memory/${name}`);
        totalBytes += data.byteLength;
      }
    }
  } catch {
    // memoryDir may not exist on a fresh install — fine.
  }

  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ id, createdAt: now.toISOString(), files: copied, totalBytes }, null, 2) + "\n",
    "utf8",
  );

  await pruneSnapshots(snapshotsRoot, SNAPSHOT_LIMIT);
  return { id, dir, createdAt: now.toISOString(), files: copied, totalBytes };
}

export async function listSnapshots(home?: string): Promise<SnapshotInfo[]> {
  const dir = path.join(crixAgentHome(home), "snapshots");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SnapshotInfo[] = [];
  for (const id of entries.sort().reverse()) {
    const manifest = path.join(dir, id, "manifest.json");
    try {
      const raw = await fs.readFile(manifest, "utf8");
      const parsed = JSON.parse(raw) as SnapshotInfo;
      out.push({ ...parsed, dir: path.join(dir, id) });
    } catch {
      // Skip orphan / partial dirs silently.
    }
  }
  return out;
}

export async function restoreSnapshot(opts: { home?: string; id: string }): Promise<{ restored: string[]; dest: string }> {
  const home = crixAgentHome(opts.home);
  const dir = path.join(home, "snapshots", opts.id);
  const manifestPath = path.join(dir, "manifest.json");
  if (!(await exists(manifestPath))) throw new Error(`snapshot not found: ${opts.id}`);
  const restored: string[] = [];
  for (const name of BRAIN_FILES) {
    const src = path.join(dir, name);
    if (!(await exists(src))) continue;
    const data = await fs.readFile(src);
    await fs.writeFile(path.join(home, name), data);
    restored.push(name);
  }
  // Restore daily memory files too if the snapshot has them.
  const memDir = path.join(dir, "memory");
  try {
    const memEntries = await fs.readdir(memDir);
    const destMem = path.join(home, "memory");
    await fs.mkdir(destMem, { recursive: true });
    for (const name of memEntries) {
      const data = await fs.readFile(path.join(memDir, name));
      await fs.writeFile(path.join(destMem, name), data);
      restored.push(`memory/${name}`);
    }
  } catch {
    // No memory snapshot — fine.
  }
  return { restored, dest: home };
}

/**
 * Roll an exported tarball-ish bundle. Returns the dest path. Uses plain
 * JSON-of-files so we don't add a dep just for tar; the agent can reverse
 * it on import.
 */
export async function exportHome(opts: { home?: string; dest: string }): Promise<{ dest: string; files: number; bytes: number }> {
  const home = crixAgentHome(opts.home);
  const bundle: Record<string, string> = {};
  let bytes = 0;
  for (const name of BRAIN_FILES) {
    const src = path.join(home, name);
    if (!(await exists(src))) continue;
    const text = await fs.readFile(src, "utf8");
    bundle[name] = text;
    bytes += text.length;
  }
  // memory/* and skills/* — include them too for portability.
  for (const subdir of ["memory", "skills", "transcripts"]) {
    const dir = path.join(home, subdir);
    try {
      await collectInto(bundle, dir, subdir);
    } catch {
      // missing subdir, skip
    }
  }
  await fs.mkdir(path.dirname(opts.dest), { recursive: true });
  await fs.writeFile(opts.dest, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), bundle }, null, 2), "utf8");
  return { dest: opts.dest, files: Object.keys(bundle).length, bytes };
}

export async function importHome(opts: { home?: string; source: string; overwrite?: boolean }): Promise<{ files: number; skipped: number }> {
  const home = crixAgentHome(opts.home);
  const raw = await fs.readFile(opts.source, "utf8");
  const parsed = JSON.parse(raw) as { bundle: Record<string, string> };
  let files = 0;
  let skipped = 0;
  for (const [rel, content] of Object.entries(parsed.bundle)) {
    const dest = path.join(home, rel);
    if (!opts.overwrite && (await exists(dest))) {
      skipped += 1;
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
    files += 1;
  }
  return { files, skipped };
}

async function collectInto(bundle: Record<string, string>, dir: string, prefix: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const key = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      await collectInto(bundle, full, key);
    } else if (e.isFile()) {
      const text = await fs.readFile(full, "utf8").catch(() => null);
      if (text != null) bundle[key] = text;
    }
  }
}

async function pruneSnapshots(dir: string, limit: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const sorted = entries.sort();
  if (sorted.length <= limit) return;
  for (const stale of sorted.slice(0, sorted.length - limit)) {
    await fs.rm(path.join(dir, stale), { recursive: true, force: true }).catch(() => undefined);
  }
}
