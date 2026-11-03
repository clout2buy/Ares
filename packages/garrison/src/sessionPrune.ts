// Empty-session prune — clears the registry of sessions nobody ever typed into.
//
// Field evidence (2026-11-02): ~/.ares/garrison/sessions held 1,435
// *.meta.json; of the 739 created Sep 20 – Nov 2, 613 had no transcript
// anywhere and 617 were titled "untitled session". The SessionManager wrote a
// meta.json the moment a session was spawned — on session.create, and on every
// boot for every canonical kernel row (desktop chats included) — so blank
// cards became permanent entries. Creation is lazy now (sessions.ts writes the
// record on the first send); this sweeps up what was left behind.
//
// The rule is "never touch a session with any content". An entry is moved
// ONLY when every one of these holds; any doubt (unreadable meta, a stat error
// other than "missing", a content check that throws) keeps it:
//   * its meta.json parses, has no real title (absent or "untitled session":
//     a first message always titles a session), and is not live right now;
//   * its createdAt AND the file's mtime are both older than the minimum age
//     (default 1 day, ARES_EMPTY_SESSION_MIN_AGE_HOURS);
//   * its garrison rollout <id>.jsonl is missing or holds no event line;
//   * its workspace transcript dir <workspace>/.ares/sessions/<id> is missing
//     or holds only empty files;
//   * the host's content check (the canonical kernel: messages/events) says
//     there is nothing.
// Nothing is deleted: entries move to <home>/garrison/sessions-pruned/ with a
// ledger line each, so a wrong call is one move back. Re-running is a no-op
// for anything already moved, so it is safe at every startup.

import { promises as fs } from "node:fs";
import path from "node:path";
import { garrisonDir } from "./token.js";

export const EMPTY_SESSION_TITLE = "untitled session";
const DAY_MS = 86_400_000;

export interface PruneEmptySessionsOptions {
  home: string;
  now?: () => number;
  /** Minimum age (createdAt and mtime). Default: ARES_EMPTY_SESSION_MIN_AGE_HOURS or 24h. */
  minAgeMs?: number;
  /** Sessions in memory right now — never touched. */
  liveIds?: ReadonlySet<string>;
  /** The host's own content check (the canonical kernel). true or a throw keeps it. */
  hasContent?: (id: string, meta: Record<string, unknown>) => boolean | Promise<boolean>;
  dryRun?: boolean;
}

export interface PruneEmptySessionsReport {
  scanned: number;
  pruned: string[];
  kept: number;
  dir: string;
}

export function emptySessionMinAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.ARES_EMPTY_SESSION_MIN_AGE_HOURS);
  return Number.isFinite(hours) && hours >= 1 ? hours * 3_600_000 : DAY_MS;
}

export function prunedSessionsDir(home: string): string {
  return path.join(garrisonDir(home), "sessions-pruned");
}

/** true = missing; false = present with content; undefined = can't tell (keep). */
async function rolloutIsEmpty(file: string): Promise<boolean | undefined> {
  let text: string;
  try {
    const st = await fs.stat(file);
    if (st.size === 0) return true;
    if (st.size > 4096) return false; // any real event line is far smaller; a big file has content
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? true : undefined;
  }
  return text.split(/\r?\n/).every((line) => line.trim() === "");
}

/** true = no transcript dir or only empty files; false = something in it; undefined = can't tell. */
async function workspaceTranscriptIsEmpty(workspace: unknown, id: string): Promise<boolean | undefined> {
  if (typeof workspace !== "string" || !workspace) return true;
  const dir = path.join(workspace, ".ares", "sessions", id);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? true : undefined;
  }
  for (const name of names) {
    try {
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile() || st.size > 0) return false;
    } catch {
      return undefined;
    }
  }
  return true;
}

export async function pruneEmptySessions(opts: PruneEmptySessionsOptions): Promise<PruneEmptySessionsReport> {
  const dir = path.join(garrisonDir(opts.home), "sessions");
  const outDir = prunedSessionsDir(opts.home);
  const now = (opts.now ?? Date.now)();
  const minAge = opts.minAgeMs ?? emptySessionMinAgeMs();
  const report: PruneEmptySessionsReport = { scanned: 0, pruned: [], kept: 0, dir: outDir };
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    report.scanned++;
    const id = name.slice(0, -".meta.json".length);
    const keep = () => { report.kept++; };
    if (!id || path.basename(id) !== id || opts.liveIds?.has(id)) { keep(); continue; }
    const metaFile = path.join(dir, name);
    let meta: Record<string, unknown>;
    let mtimeMs: number;
    try {
      const st = await fs.stat(metaFile);
      mtimeMs = st.mtimeMs;
      const parsed: unknown = JSON.parse(await fs.readFile(metaFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { keep(); continue; }
      meta = parsed as Record<string, unknown>;
    } catch {
      keep();
      continue;
    }
    const title = typeof meta.title === "string" ? meta.title.trim() : "";
    if (title && title !== EMPTY_SESSION_TITLE) { keep(); continue; }
    const created = typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : NaN;
    if (!Number.isFinite(created) || now - created < minAge || now - mtimeMs < minAge) { keep(); continue; }
    const rollout = path.join(dir, `${id}.jsonl`);
    if ((await rolloutIsEmpty(rollout)) !== true) { keep(); continue; }
    if ((await workspaceTranscriptIsEmpty(meta.workspace, id)) !== true) { keep(); continue; }
    if (opts.hasContent) {
      let content = true;
      try { content = (await opts.hasContent(id, meta)) !== false; } catch { content = true; }
      if (content) { keep(); continue; }
    }
    if (opts.dryRun) { report.pruned.push(id); continue; }
    try {
      await fs.mkdir(outDir, { recursive: true });
      await fs.rename(metaFile, path.join(outDir, name));
      await fs.rename(rollout, path.join(outDir, `${id}.jsonl`)).catch(() => undefined);
      report.pruned.push(id);
    } catch {
      keep();
    }
  }
  if (report.pruned.length > 0 && !opts.dryRun) {
    const at = new Date(now).toISOString();
    const lines = report.pruned.map((id) => JSON.stringify({ at, id, why: "no transcript, no messages, older than the minimum age" })).join("\n") + "\n";
    await fs.appendFile(path.join(outDir, "ledger.jsonl"), lines, "utf8").catch(() => undefined);
  }
  return report;
}
