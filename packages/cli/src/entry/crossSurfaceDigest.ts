// Cross-surface digest — "Elsewhere today".
//
// Telegram, the terminal TUI and the desktop app each hold their own session
// with its own history; only lossy memory bridges them, so the owner who asked
// Ares something on the phone at lunch gets a blank stare from the desktop in
// the evening. This module reads the OTHER sessions of the same tenant that
// were active recently and hands the turn a compact block: surface, title, the
// last thing the owner said and the last thing Ares answered, most recent first.
//
// Two stores are read, because the surfaces persist differently:
//   - <home>/garrison/sessions/<id>.meta.json + <id>.jsonl (Telegram/garrison;
//     surface + tenant live in the meta, packages/garrison/src/sessions.ts)
//   - <workspace>/.ares/sessions/<id>/meta.json + events.jsonl (desktop/TUI
//     Core Sessions; surface + tenant live in the kernel row, read through the
//     optional `metadataFor` lookup — see sessionSurface.ts for why)
// Both rollouts share the {ts, event} JSONL line shape, so one tail reader
// serves both. Rollouts run to hundreds of MB (the Garrison once OOM'd slurping
// a 314MB events file for a 5s poll); only the last TAIL_BYTES are ever read.
//
// Guests never see this block: their sessions are excluded from the owner's
// digest and they receive no digest of their own — "same tenant" for a guest
// would still be a window into a household they were not invited into.
//
// Knobs: ARES_CROSS_SURFACE=0 disables; ARES_CROSS_SURFACE_HOURS (24) is the
// activity window; ARES_CROSS_SURFACE_CHARS (1200) caps the block.

import { promises as fs } from "node:fs";
import path from "node:path";
import { messageText, type Message } from "@ares/protocol";
import { ensureSurfaceStamp } from "./sessionSurface.js";
import type { TurnTenant } from "./turnPipeline.js";
import { openWorkspaceSessionKernel, type JsonValue } from "@ares/core";

const TAIL_BYTES = 64 * 1024;
const SNIPPET_CHARS = 160;
const DEFAULT_HOURS = 24;
const DEFAULT_CHARS = 1_200;
const MAX_SESSIONS = 4;

export interface CrossSurfaceDigestOptions {
  home: string;
  /** Workspace whose Core Session store is scanned alongside the garrison's. */
  workspace?: string;
  currentSessionId: string;
  tenant?: TurnTenant;
  now?: number;
  budgetChars?: number;
  hours?: number;
  maxSessions?: number;
  /** Kernel metadata for a Core Session id (surface/tenant stamps). */
  metadataFor?: (sessionId: string) => Record<string, unknown> | null | undefined;
}

export interface DigestSession {
  id: string;
  surface: string;
  title: string;
  lastActivityAt: number;
  lastUser?: string;
  lastAssistant?: string;
}

export interface CrossSurfaceDigest {
  /** Empty when there is nothing to show. */
  text: string;
  sessions: DigestSession[];
  /** Epoch ms of the newest activity across the included sessions (0 if none). */
  newestActivityAt: number;
}

interface Candidate {
  id: string;
  surface: string;
  title: string;
  tenantRole: "owner" | "guest";
  rollout: string;
}

export function crossSurfaceEnabled(): boolean {
  return process.env.ARES_CROSS_SURFACE !== "0";
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tenantRoleOf(value: unknown): "owner" | "guest" {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { role, chatId } = value as { role?: unknown; chatId?: unknown };
    if (role === "guest" && (typeof chatId === "string" || typeof chatId === "number")) return "guest";
  }
  return "owner";
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function garrisonCandidates(home: string): Promise<Candidate[]> {
  const dir = path.join(home, "garrison", "sessions");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Candidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    const meta = await readJson(path.join(dir, name));
    if (!meta) continue;
    out.push({
      id,
      surface: typeof meta.surface === "string" ? meta.surface : "garrison",
      title: typeof meta.title === "string" ? meta.title : "",
      tenantRole: tenantRoleOf(meta.tenant),
      rollout: path.join(dir, `${id}.jsonl`),
    });
  }
  return out;
}

async function coreCandidates(
  workspace: string,
  metadataFor: CrossSurfaceDigestOptions["metadataFor"],
): Promise<Candidate[]> {
  const root = path.join(workspace, ".ares", "sessions");
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const meta = await readJson(path.join(root, id, "meta.json"));
    const kernelMeta = metadataFor?.(id) ?? null;
    out.push({
      id,
      surface: typeof kernelMeta?.surface === "string"
        ? kernelMeta.surface
        : typeof meta?.surface === "string" ? meta.surface : "unknown",
      title: typeof meta?.label === "string" ? meta.label : typeof kernelMeta?.title === "string" ? kernelMeta.title : "",
      tenantRole: tenantRoleOf(kernelMeta?.tenant ?? meta?.tenant),
      rollout: path.join(root, id, "events.jsonl"),
    });
  }
  return out;
}

interface TailFacts {
  lastActivityAt: number;
  lastUser?: string;
  lastAssistant?: string;
}

/** Read only the last TAIL_BYTES of a rollout and pull the newest user and
 *  assistant messages out of it. A torn first line (we started mid-line) and
 *  a torn last line (a write in progress) are both skipped. */
async function tailFacts(file: string, mtimeMs: number): Promise<TailFacts | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  let text: string;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  const facts: TailFacts = { lastActivityAt: mtimeMs };
  const lines = text.split(/\r?\n/);
  let sawTs = false;
  for (let i = lines.length - 1; i >= 0 && (!facts.lastUser || !facts.lastAssistant); i -= 1) {
    const line = lines[i];
    if (!line) continue;
    let entry: { ts?: unknown; event?: { type?: unknown; userMessage?: Message; message?: Message } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object" || !entry.event) continue;
    if (!sawTs && typeof entry.ts === "string") {
      const at = Date.parse(entry.ts);
      if (Number.isFinite(at)) facts.lastActivityAt = at;
      sawTs = true;
    }
    const { type, userMessage, message } = entry.event;
    if (!facts.lastUser && (type === "turn_start" || type === "input_admitted") && userMessage) {
      facts.lastUser = snippet(textOf(userMessage));
    } else if (!facts.lastAssistant && type === "message_done" && message && message.role === "assistant") {
      facts.lastAssistant = snippet(textOf(message));
    }
  }
  return facts;
}

/** Tolerant of legacy string-content messages a rollout may still hold. */
function textOf(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? messageText(message) : "";
}

function snippet(text: string): string {
  const collapsed = text
    .replace(/data:image\/[a-z0-9.+-]+[^,\r\n]*;base64,[^\s]+/gi, "[image]")
    .replace(/\(System:[^)]*\)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > SNIPPET_CHARS ? `${collapsed.slice(0, SNIPPET_CHARS - 1)}…` : collapsed;
}

function ago(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return hr < 24 ? `${hr}h ago` : `${Math.floor(hr / 24)}d ago`;
}

function renderSession(s: DigestSession, now: number): string {
  const head = `• [${s.surface}] ${s.title || "untitled"} (${ago(now - s.lastActivityAt)})`;
  const lines = [head];
  if (s.lastUser) lines.push(`  you: ${s.lastUser}`);
  if (s.lastAssistant) lines.push(`  ares: ${s.lastAssistant}`);
  return lines.join("\n");
}

const HEADER = "Elsewhere today — other conversations of yours on other surfaces (most recent first). Use them for continuity; do not repeat them back unless asked.";

export async function buildCrossSurfaceDigest(opts: CrossSurfaceDigestOptions): Promise<CrossSurfaceDigest> {
  const empty: CrossSurfaceDigest = { text: "", sessions: [], newestActivityAt: 0 };
  if (opts.tenant && opts.tenant.role !== "owner") return empty;
  const now = opts.now ?? Date.now();
  const hours = opts.hours ?? envNumber("ARES_CROSS_SURFACE_HOURS", DEFAULT_HOURS);
  const budget = opts.budgetChars ?? envNumber("ARES_CROSS_SURFACE_CHARS", DEFAULT_CHARS);
  const maxSessions = opts.maxSessions ?? MAX_SESSIONS;
  const cutoff = now - hours * 3_600_000;

  const seen = new Set<string>([opts.currentSessionId]);
  const candidates: Candidate[] = [];
  for (const c of await garrisonCandidates(opts.home)) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }
  if (opts.workspace) {
    for (const c of await coreCandidates(opts.workspace, opts.metadataFor)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }
  }

  // Cheap pre-filter on mtime before any file is opened: a store holds
  // hundreds of stale sessions and only a handful moved today.
  const recent: Array<{ c: Candidate; mtimeMs: number }> = [];
  for (const c of candidates) {
    if (c.tenantRole !== "owner") continue;
    const stat = await fs.stat(c.rollout).catch(() => null);
    if (!stat || stat.mtimeMs < cutoff) continue;
    recent.push({ c, mtimeMs: stat.mtimeMs });
  }
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: DigestSession[] = [];
  for (const { c, mtimeMs } of recent.slice(0, maxSessions * 2)) {
    const facts = await tailFacts(c.rollout, mtimeMs);
    if (!facts || (!facts.lastUser && !facts.lastAssistant)) continue;
    if (facts.lastActivityAt < cutoff) continue;
    sessions.push({
      id: c.id,
      surface: c.surface,
      title: c.title || facts.lastUser?.slice(0, 48) || "",
      lastActivityAt: facts.lastActivityAt,
      lastUser: facts.lastUser,
      lastAssistant: facts.lastAssistant,
    });
    if (sessions.length >= maxSessions) break;
  }
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (sessions.length === 0) return empty;

  // Fit the budget by dropping the oldest sessions first; a single oversized
  // entry is hard-trimmed so the block can never exceed the cap.
  const kept: DigestSession[] = [];
  let text = HEADER;
  for (const s of sessions) {
    const next = `${text}\n${renderSession(s, now)}`;
    if (next.length > budget && kept.length > 0) break;
    text = next;
    kept.push(s);
    if (text.length > budget) break;
  }
  if (text.length > budget) text = `${text.slice(0, budget - 1)}…`;
  return { text, sessions: kept, newestActivityAt: kept.reduce((m, s) => Math.max(m, s.lastActivityAt), 0) };
}

// ─── per-turn injection ───────────────────────────────────────────────────

interface GateState {
  lastInjectedAt: number;
}

/** Keyed by live session object — no field on LiveSession needed, and a
 *  disposed session takes its gate with it. */
const gates = new WeakMap<object, GateState>();

export interface CrossSurfaceTurnHost {
  session: { meta: { id: string } };
  context: { aresHome: string; workspace: string };
  tenant?: TurnTenant;
  queueSystemReminder(text: string, source?: "memory"): void;
}

/**
 * Inject the digest as a system reminder when (a) this is the first turn of
 * the session in this process, or (b) another surface has activity newer than
 * the last injection. Returns the injected text (null when nothing went in).
 * Also lazily stamps the surface on hosts that never declared one.
 */
export async function crossSurfaceBeforeTurn(
  live: CrossSurfaceTurnHost,
  tenant: TurnTenant,
  opts: { now?: number; digest?: (o: CrossSurfaceDigestOptions) => Promise<CrossSurfaceDigest> } = {},
): Promise<string | null> {
  void ensureSurfaceStamp(live as Parameters<typeof ensureSurfaceStamp>[0]);
  if (!crossSurfaceEnabled() || tenant.role !== "owner") return null;
  const now = opts.now ?? Date.now();
  const gate = gates.get(live);
  const firstTurn = gate === undefined;
  let metadataFor: CrossSurfaceDigestOptions["metadataFor"];
  try {
    const kernel = await openWorkspaceSessionKernel(live.context.workspace);
    metadataFor = (id) => {
      const row = kernel.getSession(id);
      const metadata = row?.metadata;
      return metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, JsonValue>)
        : null;
    };
  } catch {
    metadataFor = undefined;
  }
  let digest: CrossSurfaceDigest;
  try {
    digest = await (opts.digest ?? buildCrossSurfaceDigest)({
      home: live.context.aresHome,
      workspace: live.context.workspace,
      currentSessionId: live.session.meta.id,
      tenant,
      now,
      metadataFor,
    });
  } catch {
    return null; // the digest must never break a turn
  }
  const fresh = firstTurn || digest.newestActivityAt > (gate?.lastInjectedAt ?? 0);
  if (!fresh) return null;
  gates.set(live, { lastInjectedAt: now });
  if (!digest.text) return null;
  live.queueSystemReminder(digest.text, "memory");
  return digest.text;
}

/** Test seam: forget a session's injection gate. */
export function resetCrossSurfaceGate(live: object): void {
  gates.delete(live);
}
