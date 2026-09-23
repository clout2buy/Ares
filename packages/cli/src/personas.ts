// Personas — the owner's personal agents ("Bob — you're my finance guy, keep me
// posted when I get charged…").
//
// A persona is a name, a look (emoji/colour), a brain (provider/model/effort),
// the owner's own rundown of the role, and exactly ONE dedicated garrison
// thread. Every turn in that thread carries the persona layer
// (prompt/texting.ts); nothing about a persona leaks into the default "Ares"
// thread, which is implicit (id "ares", never stored).
//
// Storage: <ARES_HOME>/personas/<id>.json, one file per persona, written
// atomically (tmp + rename). Delete moves the file to personas/.deleted/ and
// archives the thread — rollouts are never removed.
//
// The store keeps an in-memory index so the garrison's SYNCHRONOUS session
// factory can ask "which persona owns this session?" without touching disk.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface Persona {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  provider: string;
  model: string;
  reasoningLevel?: string;
  instructions: string;
  /** The persona's one dedicated garrison thread. */
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

/** The implicit default persona id — the normal assistant. */
export const DEFAULT_PERSONA_ID = "ares";
export const PERSONA_INSTRUCTIONS_MAX = 4_000;
export const PERSONA_NAME_MAX = 40;
const PERSONA_ID_RE = /^p_[a-z0-9]{6,32}$/;

export function newPersonaId(): string {
  return `p_${randomBytes(6).toString("hex")}`;
}

export function isPersonaId(value: unknown): value is string {
  return typeof value === "string" && PERSONA_ID_RE.test(value);
}

export function personasDir(home: string): string {
  return path.join(home, "personas");
}

function normalize(raw: unknown): Persona | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const id = str(r.id);
  const name = str(r.name);
  const provider = str(r.provider);
  const model = str(r.model);
  const instructions = str(r.instructions);
  if (!isPersonaId(id) || !name || !provider || !model || instructions === undefined) return null;
  const now = new Date().toISOString();
  return {
    id,
    name,
    ...(str(r.emoji) ? { emoji: str(r.emoji) } : {}),
    ...(str(r.color) ? { color: str(r.color) } : {}),
    provider,
    model,
    ...(str(r.reasoningLevel) ? { reasoningLevel: str(r.reasoningLevel) } : {}),
    instructions,
    sessionId: str(r.sessionId) ?? "",
    createdAt: str(r.createdAt) ?? now,
    updatedAt: str(r.updatedAt) ?? now,
  };
}

export class PersonaStore {
  private readonly byId = new Map<string, Persona>();
  private loaded = false;

  constructor(readonly home: string) {}

  /** Read every persona file into the index. Corrupt files are skipped. */
  async load(): Promise<Persona[]> {
    this.byId.clear();
    const dir = personasDir(this.home);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const persona = normalize(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
        if (persona && `${persona.id}.json` === name) this.byId.set(persona.id, persona);
      } catch {
        // a damaged file never blocks boot
      }
    }
    this.loaded = true;
    return this.list();
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** Oldest first — the order the owner made them. */
  list(): Persona[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Persona | undefined {
    return this.byId.get(id);
  }

  /** Which persona owns this session (sync; the factory's lookup). */
  bySession(sessionId: string): Persona | undefined {
    if (!sessionId) return undefined;
    for (const p of this.byId.values()) if (p.sessionId === sessionId) return p;
    return undefined;
  }

  /** Index a persona without persisting it (creation in progress). */
  stage(persona: Persona): void {
    this.byId.set(persona.id, { ...persona });
  }

  unstage(id: string): void {
    this.byId.delete(id);
  }

  async save(persona: Persona): Promise<Persona> {
    const dir = personasDir(this.home);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${persona.id}.json`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(persona, null, 2) + "\n", "utf8");
    await fs.rename(tmp, file);
    this.byId.set(persona.id, { ...persona });
    return persona;
  }

  /** Remove from the index; the file moves to personas/.deleted/. */
  async remove(id: string): Promise<boolean> {
    const persona = this.byId.get(id);
    if (!persona) return false;
    this.byId.delete(id);
    const dir = personasDir(this.home);
    const graveyard = path.join(dir, ".deleted");
    await fs.mkdir(graveyard, { recursive: true }).catch(() => undefined);
    await fs
      .rename(path.join(dir, `${id}.json`), path.join(graveyard, `${id}.${Date.now()}.json`))
      .catch(() => fs.rm(path.join(dir, `${id}.json`), { force: true }).catch(() => undefined));
    return true;
  }
}

/**
 * Does the owner's rundown imply the persona should watch something on its own
 * ("keep me posted", "tell me when", "every morning")? Then creation kicks off
 * a setup turn so the persona schedules its own checks instead of waiting to
 * be spoken to.
 */
export function impliesMonitoring(instructions: string): boolean {
  return /\b(keep (me|us) (posted|updated|in the loop)|tell me (when|if|whenever)|let me know (when|if|whenever)|notify me|alert me|ping me|text me (when|if)|heads[- ]up|(every|each) (morning|day|night|evening|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|weekly|monthly|keep an eye|keep track|watch (for|my|out)|monitor|when(ever)? i (get|am|'m) (charged|billed|paid))\b/i.test(
    instructions,
  );
}

export const PERSONA_SETUP_PROMPT =
  "Set yourself up: read your role, connect what you need (Connect), and schedule any recurring checks your role implies " +
  "(Remind with a prompt — they need the owner's approval). Then text the owner a short hello saying what you'll watch and when.";

// ─── The last line of a thread (the conversation list's preview) ─────────

const TAIL_BYTES = 512 * 1024;
export const LAST_MESSAGE_MAX = 140;

/** Strip leading "(System: …)" notes, parenthesis-balanced like the garrison's
 *  title healer, so a note containing "(9:00 AM)" doesn't leak its tail. */
export function stripPreamble(text: string): string {
  let rest = text.trim();
  while (/^\(\s*system\s*:/i.test(rest)) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") depth++;
      else if (rest[i] === ")" && --depth === 0) { end = i; break; }
    }
    if (end < 0) return rest;
    rest = rest.slice(end + 1).trim();
  }
  return rest;
}

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

function clip(text: string, max = LAST_MESSAGE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The newest assistant reply or owner message in a garrison rollout, read from
 * the file's tail only (rollouts reach hundreds of MB). Scheduled-check
 * preambles are stripped so the preview reads like the conversation.
 */
export async function lastThreadMessage(
  rolloutFile: string,
  max = LAST_MESSAGE_MAX,
): Promise<{ text: string; at?: string; role: "assistant" | "user" } | undefined> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(rolloutFile, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // a partial first line
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let entry: { ts?: string; event?: { type?: string; message?: unknown; userMessage?: unknown } };
      try { entry = JSON.parse(line); } catch { continue; }
      const ev = entry.event;
      if (!ev) continue;
      if (ev.type === "message_done") {
        const role = (ev.message as { role?: string } | undefined)?.role;
        const text = clip(textOf(ev.message), max);
        if (role === "assistant" && text) return { text, ...(entry.ts ? { at: entry.ts } : {}), role: "assistant" };
      } else if (ev.type === "turn_start") {
        const text = clip(stripPreamble(textOf(ev.userMessage)), max);
        if (text) return { text, ...(entry.ts ? { at: entry.ts } : {}), role: "user" };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The first non-empty line of a reply — a push banner's body. */
export function firstLine(text: string, max = 178): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const plain = line.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "");
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
