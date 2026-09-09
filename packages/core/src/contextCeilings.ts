// Learned context ceilings, persisted per provider+model.
//
// The engine learns a provider's REAL serving limit the hard way: a rung of
// the shrink ladder gets rejected as too large, and the next rung becomes the
// ceiling for the rest of the session. It used to live only in memory, so
// every new session, every resume after a daemon restart, and every provider
// failover re-walked the same rejected rung — and on a slow endpoint each
// re-walk cost a rejection round trip plus 90s×N stall watchdogs before a
// rung that fit was even tried (field report 2026-09-09: a verify subagent on
// ollama-cloud glm-5.2 spent six minutes rediscovering an 85k ceiling it had
// learned two hours earlier).
//
// This store makes the lesson durable: ~/.ares/telemetry/context-ceilings.json,
// keyed by provider+model, with an expiry so a provider that later raises its
// window gets re-probed instead of being capped forever. Payload-size (413)
// rejections are never stored here — they are evidence about request bytes,
// not the token window — the engine filters those before calling remember.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONTEXT_CEILING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Below this nothing real rejects; a stored value this low would be a bug. */
export const CONTEXT_CEILING_FLOOR = 16_000;

export interface ContextCeilingEntry {
  ceilingTokens: number;
  learnedAt: string;
  /** Free text for the human reading the file: what rejected what. */
  evidence?: string;
}

interface CeilingFile {
  version: 1;
  entries: Record<string, ContextCeilingEntry>;
}

export function contextCeilingKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}::${model.trim().toLowerCase()}`;
}

export function contextCeilingsFile(home = process.env.ARES_HOME ?? path.join(os.homedir(), ".ares")): string {
  return path.join(home, "telemetry", "context-ceilings.json");
}

async function readFileSafe(file: string): Promise<CeilingFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CeilingFile>;
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") return parsed as CeilingFile;
  } catch {
    // missing or corrupt → empty; a bad telemetry file must never block a turn
  }
  return { version: 1, entries: {} };
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch {
    // Windows: rename over a file another process holds open can fail once.
    await fs.rm(file, { force: true }).catch(() => undefined);
    await fs.rename(tmp, file).catch(async () => {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    });
  }
}

/** The remembered ceiling for this provider+model, or null when none / expired. */
export async function loadContextCeiling(provider: string, model: string, opts: { home?: string; now?: number } = {}): Promise<number | null> {
  const file = contextCeilingsFile(opts.home);
  const data = await readFileSafe(file);
  const entry = data.entries[contextCeilingKey(provider, model)];
  if (!entry || !Number.isFinite(entry.ceilingTokens) || entry.ceilingTokens < CONTEXT_CEILING_FLOOR) return null;
  const learnedAt = Date.parse(entry.learnedAt);
  const now = opts.now ?? Date.now();
  if (!Number.isFinite(learnedAt) || now - learnedAt > CONTEXT_CEILING_TTL_MS) return null;
  return Math.floor(entry.ceilingTokens);
}

/** Remember a ceiling. Keeps the LOWER of stored and new (evidence only ever tightens within the TTL). */
export async function rememberContextCeiling(
  provider: string,
  model: string,
  ceilingTokens: number,
  opts: { home?: string; now?: number; evidence?: string } = {},
): Promise<number> {
  const tokens = Math.floor(ceilingTokens);
  if (!Number.isFinite(tokens) || tokens < CONTEXT_CEILING_FLOOR) return tokens;
  const file = contextCeilingsFile(opts.home);
  const data = await readFileSafe(file);
  const key = contextCeilingKey(provider, model);
  const now = opts.now ?? Date.now();
  const existing = data.entries[key];
  const existingFresh = existing && Number.isFinite(Date.parse(existing.learnedAt)) && now - Date.parse(existing.learnedAt) <= CONTEXT_CEILING_TTL_MS;
  const next = existingFresh && existing.ceilingTokens <= tokens ? existing.ceilingTokens : tokens;
  const entry: ContextCeilingEntry = { ceilingTokens: next, learnedAt: new Date(now).toISOString() };
  if (opts.evidence) entry.evidence = opts.evidence;
  data.entries[key] = entry;
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  return next;
}

/** Drop a remembered ceiling (the owner fixed the provider, or wants a re-probe). */
export async function forgetContextCeiling(provider: string, model: string, opts: { home?: string } = {}): Promise<boolean> {
  const file = contextCeilingsFile(opts.home);
  const data = await readFileSafe(file);
  const key = contextCeilingKey(provider, model);
  if (!(key in data.entries)) return false;
  delete data.entries[key];
  await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  return true;
}
