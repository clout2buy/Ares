// Shortcuts as skills — the owner's iPhone Shortcuts, given names a person says
// and a line about when to use them, so "run my bedtime routine" resolves to the
// right Shortcut by itself.
//
// iOS will not tell an app which Shortcuts exist, so the library is whatever the
// owner listed in the Ares app (name, alias, a one-line "when to use", whether it
// takes input, and whether it is SENSITIVE). The app keeps that on the phone and
// syncs it here (POST /gateway/shortcuts). This file is the pure half: the shapes,
// the sanitizer, the resolver that turns spoken words into an exact Shortcut name,
// the risk rule, and the small file-backed directory the iPhone tool and the HTTP
// routes share. Nothing in here runs a Shortcut; running stays the phone's job,
// behind the same gate as every other iPhone capability.
//
// Sensitivity is OPT-OUT: a Shortcut is sensitive unless the owner explicitly set
// `sensitive: false`. Sensitive Shortcuts are a per-call owner decision no standing
// grant can answer; only a Shortcut the owner marked routine can ride the lighter
// "write" class. A Shortcut that is unknown here is sensitive too.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const SHORTCUT_NAME_MAX = 100;
export const SHORTCUT_ALIAS_MAX = 60;
export const SHORTCUT_WHEN_MAX = 200;
export const SHORTCUT_DESC_MAX = 300;
export const SHORTCUT_LIST_MAX = 200;
export const SHORTCUT_HISTORY_MAX = 60;
export const SHORTCUT_PROPOSALS_MAX = 20;
export const SHORTCUT_SUMMARY_MAX = 200;

export type ShortcutOutcome = "ok" | "error" | "declined" | "timeout" | "unavailable";
const OUTCOMES: readonly ShortcutOutcome[] = ["ok", "error", "declined", "timeout", "unavailable"];

export interface ShortcutRun {
  /** ISO time. */
  at: string;
  outcome: ShortcutOutcome;
  ms?: number;
  /** What came back, clipped. Never a secret: it is shown in the app and to Ares. */
  summary?: string;
  /** Who started it: "ares" (a tool call) or "owner" (their own tap in the app). */
  actor: "ares" | "owner";
}

export interface ShortcutMeta {
  /** Exact name in the Shortcuts app. */
  name: string;
  /** What the owner calls it out loud ("bedtime routine"). Unique across the library. */
  alias?: string;
  /** One line: when Ares should reach for it. */
  whenToUse?: string;
  description?: string;
  acceptsInput?: boolean;
  /** false = the owner marked it routine. Anything else = sensitive (always asks). */
  sensitive?: boolean;
  lastRun?: ShortcutRun;
}

export class ShortcutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShortcutValidationError";
  }
}

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x200b)}-${String.fromCharCode(0x200f)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}${String.fromCharCode(0xfeff)}]`, "g");

function line(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/** What makes two aliases "the same": case, punctuation and spacing do not count. */
export function aliasKey(alias: string): string {
  return alias.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function isSensitiveShortcut(meta: Pick<ShortcutMeta, "sensitive"> | undefined | null): boolean {
  return meta?.sensitive !== false;
}

function sanitizeRun(raw: unknown): ShortcutRun | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const at = typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) ? new Date(Date.parse(r.at)).toISOString() : undefined;
  const outcome = OUTCOMES.find((o) => o === r.outcome);
  if (!at || !outcome) return undefined;
  const summary = line(r.summary, SHORTCUT_SUMMARY_MAX);
  return {
    at,
    outcome,
    ...(typeof r.ms === "number" && Number.isFinite(r.ms) && r.ms >= 0 ? { ms: Math.min(Math.round(r.ms), 3_600_000) } : {}),
    ...(summary ? { summary } : {}),
    actor: r.actor === "owner" ? "owner" : "ares",
  };
}

/** One entry, or undefined when it is not a usable Shortcut. */
export function sanitizeShortcut(raw: unknown): ShortcutMeta | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const name = line(s.name, SHORTCUT_NAME_MAX * 4);
  // A name is the exact text Shortcuts runs by; one that has to be cut is not that name.
  if (!name || name.length > SHORTCUT_NAME_MAX) return undefined;
  const alias = line(s.alias, SHORTCUT_ALIAS_MAX);
  const whenToUse = line(s.whenToUse, SHORTCUT_WHEN_MAX);
  const description = line(s.description, SHORTCUT_DESC_MAX);
  const lastRun = sanitizeRun(s.lastRun);
  return {
    name,
    ...(alias && aliasKey(alias) ? { alias } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    ...(description ? { description } : {}),
    ...(typeof s.acceptsInput === "boolean" ? { acceptsInput: s.acceptsInput } : {}),
    ...(typeof s.sensitive === "boolean" ? { sensitive: s.sensitive } : {}),
    ...(lastRun ? { lastRun } : {}),
  };
}

/**
 * A whole library. Lenient (the live socket path): bad entries and repeated
 * names or aliases are dropped quietly. Strict (the HTTP route the owner's
 * phone calls): they are errors the app can show.
 */
export function sanitizeShortcutList(raw: unknown, opts: { strict?: boolean } = {}): ShortcutMeta[] {
  if (!Array.isArray(raw)) {
    if (opts.strict) throw new ShortcutValidationError("shortcuts must be an array");
    return [];
  }
  if (opts.strict && raw.length > SHORTCUT_LIST_MAX) throw new ShortcutValidationError(`a library holds at most ${SHORTCUT_LIST_MAX} Shortcuts`);
  const out: ShortcutMeta[] = [];
  const names = new Set<string>();
  const aliases = new Map<string, string>();
  for (const item of raw.slice(0, SHORTCUT_LIST_MAX)) {
    const s = sanitizeShortcut(item);
    if (!s) {
      if (opts.strict) throw new ShortcutValidationError("each Shortcut needs a name of at most 100 characters");
      continue;
    }
    const nameKey = s.name.toLowerCase();
    if (names.has(nameKey)) {
      if (opts.strict) throw new ShortcutValidationError(`two Shortcuts are named "${s.name}"`);
      continue;
    }
    if (s.alias) {
      const key = aliasKey(s.alias);
      const owner = aliases.get(key);
      if (owner) {
        if (opts.strict) throw new ShortcutValidationError(`the alias "${s.alias}" is used by both "${owner}" and "${s.name}"`);
        delete s.alias;
      } else aliases.set(key, s.name);
    }
    names.add(nameKey);
    out.push(s);
  }
  return out;
}

// ─── resolving what the owner said ────────────────────────────────────────

const FILLER = new Set(["run", "start", "open", "launch", "do", "execute", "trigger", "fire", "my", "the", "a", "an", "please", "shortcut", "shortcuts", "now", "called", "named", "for", "me", "that", "this", "ares", "to"]);

function tokens(text: string): string[] {
  return aliasKey(text).split(" ").filter((t) => t && !FILLER.has(t));
}

export type ShortcutVia = "name" | "alias" | "words";

export type Resolution =
  | { kind: "match"; shortcut: ShortcutMeta; via: ShortcutVia }
  | { kind: "ambiguous"; candidates: ShortcutMeta[] }
  | { kind: "none"; suggestions: ShortcutMeta[] };

const subset = (small: string[], big: string[]): boolean => small.length > 0 && small.every((t) => big.includes(t));

/**
 * Turn "bedtime routine", "my bedtime routine" or "Good night" into one
 * Shortcut. Exact names and aliases win outright; word matches (every word of
 * one inside the other) only match when exactly one Shortcut fits, otherwise
 * the caller gets the candidates to ask about. Never guesses between two.
 */
export function resolveShortcut(list: readonly ShortcutMeta[], spoken: string): Resolution {
  const said = typeof spoken === "string" ? spoken.trim() : "";
  if (!said) return { kind: "none", suggestions: list.slice(0, 3) };
  const lower = said.toLowerCase();
  const saidKey = aliasKey(said);
  const saidTokens = tokens(said);

  const exactName = list.find((s) => s.name.toLowerCase() === lower);
  if (exactName) return { kind: "match", shortcut: exactName, via: "name" };
  const exactAlias = list.find((s) => s.alias && aliasKey(s.alias) === saidKey);
  if (exactAlias) return { kind: "match", shortcut: exactAlias, via: "alias" };
  const looseName = list.find((s) => aliasKey(s.name) === saidKey);
  if (looseName) return { kind: "match", shortcut: looseName, via: "name" };

  const scored: Array<{ s: ShortcutMeta; score: number; via: ShortcutVia }> = [];
  for (const s of list) {
    const nameT = tokens(s.name);
    const aliasT = s.alias ? tokens(s.alias) : [];
    let score = 0;
    let via: ShortcutVia = "words";
    if (saidTokens.length > 0) {
      if (aliasT.length > 0 && saidTokens.join(" ") === aliasT.join(" ")) { score = 90; via = "alias"; }
      else if (nameT.length > 0 && saidTokens.join(" ") === nameT.join(" ")) { score = 88; via = "name"; }
      else if (aliasT.length > 0 && subset(aliasT, saidTokens)) { score = 70 + Math.min(10, aliasT.length); via = "alias"; }
      else if (nameT.length > 0 && subset(nameT, saidTokens)) { score = 66 + Math.min(10, nameT.length); via = "name"; }
      else if (saidTokens.join("").length >= 3 && aliasT.length > 0 && subset(saidTokens, aliasT)) { score = 60; via = "alias"; }
      else if (saidTokens.join("").length >= 3 && nameT.length > 0 && subset(saidTokens, nameT)) { score = 56; via = "name"; }
      else if (saidTokens.length >= 2 && subset(saidTokens, tokens(`${s.whenToUse ?? ""} ${s.description ?? ""}`))) { score = 30; via = "words"; }
    }
    if (score > 0) scored.push({ s, score, via });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < 50) return { kind: "none", suggestions: scored.slice(0, 3).map((x) => x.s) };
  const close = scored.filter((x) => x.score >= top.score - 4);
  if (close.length > 1) return { kind: "ambiguous", candidates: close.slice(0, 5).map((x) => x.s) };
  return { kind: "match", shortcut: top.s, via: top.via };
}

// ─── what Ares reads ──────────────────────────────────────────────────────

/** One line per Shortcut for the model: alias first (what a person says), the exact name to run, when to use it. */
export function describeShortcut(s: ShortcutMeta): string {
  const head = s.alias ? `"${s.alias}" -> ${s.name}` : s.name;
  const bits = [s.acceptsInput ? "takes input" : "", s.whenToUse ? `use when: ${s.whenToUse}` : s.description ? s.description : "", isSensitiveShortcut(s) ? "asks the owner every time" : "routine"];
  return `${head}${bits.filter(Boolean).length ? ` (${bits.filter(Boolean).join("; ")})` : ""}`;
}

/** The slice of the library worth pinning to the tool description: aliased Shortcuts first, capped. */
export function shortcutsPromptLine(list: readonly ShortcutMeta[], maxChars = 1100): string {
  if (list.length === 0) return "";
  const ordered = [...list].sort((a, b) => Number(Boolean(b.alias)) - Number(Boolean(a.alias)));
  const lines: string[] = [];
  let used = 0;
  for (const s of ordered) {
    const l = describeShortcut(s);
    if (used + l.length + 3 > maxChars) {
      lines.push(`...and ${ordered.length - lines.length} more (iPhone action shortcuts lists them all)`);
      break;
    }
    lines.push(l);
    used += l.length + 3;
  }
  return ` The owner's Shortcuts (say the alias, or the name; run with invoke shortcut.run {name}): ${lines.join("; ")}.`;
}

// ─── proposals: Shortcuts Ares suggests, inert until the owner adds them ──

export interface StoredProposal {
  id: string;
  name: string;
  description?: string;
  /** The steps exactly as proposed (validated by shortcutBuilder.ts). */
  steps: unknown[];
  createdAt: string;
  /** The tap-by-tap recipe, always present. */
  recipe: string[];
  /** Whether an importable file can be built, and why not. */
  file: { available: boolean; reason?: string };
}

// ─── the file-backed directory ────────────────────────────────────────────

export interface HistoryEntry {
  at: string;
  device: string;
  name: string;
  outcome: ShortcutOutcome;
  actor: "ares" | "owner";
  ms?: number;
  summary?: string;
}

interface DeviceLibrary {
  updatedAt: string;
  shortcuts: ShortcutMeta[];
}

interface DirectoryFile {
  version: 1;
  devices: Record<string, DeviceLibrary>;
  history: HistoryEntry[];
  proposals: StoredProposal[];
}

export interface ShortcutDirectoryOptions {
  now?: () => number;
  /** The audit sink (garrison wires recordAudit). A no-op by default. */
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => void;
  log?: (line: string) => void;
}

const DEVICE_ID_RE = /^[\w.:-]{1,128}$/;

export function validDeviceKey(id: unknown): id is string {
  return typeof id === "string" && DEVICE_ID_RE.test(id);
}

export class ShortcutDirectory {
  private data: DirectoryFile = { version: 1, devices: {}, history: [], proposals: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly now: () => number;

  constructor(readonly file: string, private readonly opts: ShortcutDirectoryOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<DirectoryFile>;
      const devices: Record<string, DeviceLibrary> = {};
      for (const [id, lib] of Object.entries(raw.devices ?? {})) {
        if (!validDeviceKey(id) || !lib || typeof lib !== "object") continue;
        devices[id] = { updatedAt: typeof lib.updatedAt === "string" ? lib.updatedAt : new Date(0).toISOString(), shortcuts: sanitizeShortcutList(lib.shortcuts) };
      }
      const history = (Array.isArray(raw.history) ? raw.history : []).flatMap((h): HistoryEntry[] => {
        const run = sanitizeRun({ ...h, at: (h as HistoryEntry)?.at });
        const name = line((h as HistoryEntry)?.name, SHORTCUT_NAME_MAX);
        const device = (h as HistoryEntry)?.device;
        return run && name && validDeviceKey(device) ? [{ at: run.at, device, name, outcome: run.outcome, actor: run.actor, ...(run.ms !== undefined ? { ms: run.ms } : {}), ...(run.summary ? { summary: run.summary } : {}) }] : [];
      });
      const proposals = (Array.isArray(raw.proposals) ? raw.proposals : []).filter((p): p is StoredProposal => Boolean(p) && typeof p.id === "string" && /^scp_[0-9a-f]{8}$/.test(p.id) && typeof p.name === "string" && Array.isArray(p.steps) && Array.isArray(p.recipe));
      this.data = { version: 1, devices, history: history.slice(-SHORTCUT_HISTORY_MAX), proposals: proposals.slice(-SHORTCUT_PROPOSALS_MAX) };
    } catch {
      // first run, or a damaged file: start empty rather than refuse to boot
    }
  }

  private persist(): Promise<void> {
    const run = this.chain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** The library of one phone, or of the one synced most recently when none is named. */
  get(device?: string): { device: string; updatedAt: string; shortcuts: ShortcutMeta[] } | undefined {
    if (device && device !== "default") {
      const lib = this.data.devices[device];
      return lib ? { device, updatedAt: lib.updatedAt, shortcuts: lib.shortcuts.map((s) => ({ ...s })) } : undefined;
    }
    const newest = Object.entries(this.data.devices).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))[0];
    return newest ? { device: newest[0], updatedAt: newest[1].updatedAt, shortcuts: newest[1].shortcuts.map((s) => ({ ...s })) } : undefined;
  }

  devices(): string[] {
    return Object.keys(this.data.devices);
  }

  /** Replace one phone's library (the phone is the source of truth). Returns what was stored. */
  async put(device: string, shortcuts: ShortcutMeta[]): Promise<{ device: string; updatedAt: string; shortcuts: ShortcutMeta[] }> {
    if (!validDeviceKey(device)) throw new ShortcutValidationError("device must be 1-128 of letters, digits, _ . : -");
    const prior = new Map((this.data.devices[device]?.shortcuts ?? []).map((s) => [s.name.toLowerCase(), s]));
    // A sync that did not carry a run keeps the one we already know.
    const merged = shortcuts.map((s) => (s.lastRun ? s : prior.get(s.name.toLowerCase())?.lastRun ? { ...s, lastRun: prior.get(s.name.toLowerCase())!.lastRun } : s));
    const updatedAt = new Date(this.now()).toISOString();
    this.data.devices[device] = { updatedAt, shortcuts: merged };
    await this.persist();
    return { device, updatedAt, shortcuts: merged.map((s) => ({ ...s })) };
  }

  /** The library the iPhone tool resolves against: the directory, plus any live-socket Shortcut it has not seen. */
  merged(device: string | undefined, live: readonly ShortcutMeta[] = []): ShortcutMeta[] {
    const lib = this.get(device)?.shortcuts ?? [];
    const known = new Set(lib.map((s) => s.name.toLowerCase()));
    return [...lib, ...live.filter((s) => !known.has(s.name.toLowerCase()))];
  }

  /** One run, from the owner's tap or a tool call: audited, kept in the history, stamped on the Shortcut. */
  async recordRun(device: string, run: { name: string; outcome: ShortcutOutcome; ms?: number; summary?: string; actor: "ares" | "owner" }): Promise<void> {
    const dev = validDeviceKey(device) ? device : "default";
    const name = line(run.name, SHORTCUT_NAME_MAX);
    if (!name) return;
    const summary = line(run.summary, SHORTCUT_SUMMARY_MAX);
    const at = new Date(this.now()).toISOString();
    const entry: HistoryEntry = { at, device: dev, name, outcome: run.outcome, actor: run.actor, ...(typeof run.ms === "number" ? { ms: Math.round(run.ms) } : {}), ...(summary ? { summary } : {}) };
    this.data.history = [...this.data.history, entry].slice(-SHORTCUT_HISTORY_MAX);
    const lib = this.data.devices[dev];
    const hit = lib?.shortcuts.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (hit) hit.lastRun = { at, outcome: run.outcome, actor: run.actor, ...(entry.ms !== undefined ? { ms: entry.ms } : {}), ...(summary ? { summary } : {}) };
    try {
      this.opts.audit?.({ actor: run.actor, action: "iPhone.shortcut.run", target: name, params: { device: dev, ...(entry.ms !== undefined ? { durationMs: entry.ms } : {}) }, result: run.outcome === "ok" ? "ok" : `error: ${run.outcome}` });
    } catch {
      // the audit trail never breaks the action it records
    }
    await this.persist();
  }

  history(limit = 30): HistoryEntry[] {
    return this.data.history.slice(-Math.max(1, Math.min(limit, SHORTCUT_HISTORY_MAX))).reverse();
  }

  // ── proposals ───────────────────────────────────────────────────────────

  proposals(): StoredProposal[] {
    return [...this.data.proposals].reverse();
  }

  proposal(id: string): StoredProposal | undefined {
    return this.data.proposals.find((p) => p.id === id);
  }

  async addProposal(p: Omit<StoredProposal, "id" | "createdAt">): Promise<StoredProposal> {
    const stored: StoredProposal = { ...p, id: `scp_${randomBytes(4).toString("hex")}`, createdAt: new Date(this.now()).toISOString() };
    // A new proposal for the same name replaces the old one rather than piling up.
    this.data.proposals = [...this.data.proposals.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase()), stored].slice(-SHORTCUT_PROPOSALS_MAX);
    await this.persist();
    return stored;
  }

  async removeProposal(id: string): Promise<boolean> {
    const before = this.data.proposals.length;
    this.data.proposals = this.data.proposals.filter((p) => p.id !== id);
    if (this.data.proposals.length === before) return false;
    await this.persist();
    return true;
  }
}

// ─── the process-wide reference (the garrison installs it, like the device bridge) ─

let directoryRef: ShortcutDirectory | null = null;

export function setShortcutDirectory(dir: ShortcutDirectory | null): void {
  directoryRef = dir;
}

export function getShortcutDirectory(): ShortcutDirectory | null {
  return directoryRef;
}
