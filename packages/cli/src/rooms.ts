// Rooms — group chats where people and agents are members.
//
// Owner, 2026-10-19: "group chats through users too. All users can message
// each other, work together. If I made an agent I can invite OhCupid. We can
// have separate agents on Ares and watch them talk / intervene."
//
// A room is one shared thread with any mix of members: the owner, the
// owner's agents, and — once someone joins by invite — another person and
// THEIR agents. Every agent runs on its own owner's machine, with that
// owner's model, keys, memory and permissions; only the messages travel.
// Nobody drives anyone else's agent: each owner can pause, mute or recall
// their own.
//
// This module is the pure part: the records, the on-disk store, and the
// rules that decide who speaks next. The daemon's engine (entry/daemon/
// rooms.ts) delivers turns to agents and syncs with a host; the garrison's
// HTTP side (phoneRooms.ts) lets guests in.
//
// Storage: <home>/rooms/<id>.json (the room) + <home>/rooms/<id>.messages.jsonl
// (append-only messages, one per line, numbered by `seq`). The daemon and the
// garrison are separate processes sharing these files: messages are appended
// a whole line at a time, so readers never see a torn message; the room file
// is rewritten atomically and refreshed by mtime.

import { randomBytes, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type RoomTurns = "mention" | "round" | "free";
export type RoomJobStatus = "todo" | "working" | "blocked" | "review" | "done";

export interface RoomMember {
  kind: "agent" | "person";
  /** Agents: their persona id on their own machine; people: "owner" here or
   *  a guest's install id. Unique within a room together with `home`. */
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  /** Whose machine this member lives on: "local" for this install, else the
   *  guest's install id (host view) or "host" (guest view). */
  home: string;
  /** Agents: the person member who owns them (the one who can mute them). */
  owner?: string;
  /** Their owner paused them in this room: they read, but never speak. */
  muted?: boolean;
  joinedAt: string;
}

export interface RoomJob {
  id: string;
  title: string;
  /** Member key (see memberKey) of who owns it. */
  owner?: string;
  status: RoomJobStatus;
  due?: string;
  links: string[];
  note?: string;
  updatedAt: string;
  /** Who last changed it (member key). */
  by: string;
}

export interface RoomRules {
  /** Who answers a message: only the agents @mentioned (the lead when a
   *  person mentions nobody), the next agent in order, or everyone. */
  turns: RoomTurns;
  /** Agents fall silent after this many agent messages in a row with no
   *  person speaking — the brake on two agents looping on tokens. */
  maxAgentRun: number;
  /** The owner's pause button: nobody's agents speak while set. */
  paused: boolean;
  /** Minutes between the lead agent's board check-ins (0 = off). */
  checkinMinutes: number;
  /** The lead agent (member key): takes requests nobody was named for, splits
   *  work onto the board, assigns and reviews. Unset = the first agent. */
  lead?: string;
}

export interface RoomInvite {
  code: string;
  label?: string;
  createdAt: string;
  /** Once used, who took it. */
  usedBy?: string;
}

export interface RoomGuest {
  /** The guest's install id (their person member id). */
  id: string;
  name: string;
  /** sha256 of the bearer token they present. */
  tokenHash: string;
  joinedAt: string;
  lastSeenAt?: string;
}

export interface Room {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  /** What the room is for — the playbook every agent in it reads. */
  purpose: string;
  members: RoomMember[];
  rules: RoomRules;
  board: RoomJob[];
  /** The room's own memory: what the group agreed, in a few lines. */
  notes: string;
  /** Local rooms are hosted here; a remote one lives on a host we joined. */
  host: { kind: "local" } | { kind: "remote"; origin: string; token: string; roomId: string };
  /** Host only: open invites and the guests who came in. */
  invites: RoomInvite[];
  guests: RoomGuest[];
  /** Local agent id → the daemon session that is that agent's seat here. */
  threads: Record<string, string>;
  /** Local agent id → its WORK thread for this room: real work handed off
   *  from the seat (Rooms work), run on the agent's full model. */
  workThreads?: Record<string, string>;
  /** Highest message seq appended (the host numbers them). */
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoomFrom {
  kind: "agent" | "person" | "system";
  id: string;
  name: string;
  home?: string;
}

export interface RoomMessage {
  seq: number;
  id: string;
  at: string;
  from: RoomFrom;
  text: string;
  kind: "text" | "system" | "job" | "note";
}

export const ROOM_NAME_MAX = 40;
export const ROOM_PURPOSE_MAX = 4_000;
export const ROOM_NOTES_MAX = 8_000;
export const ROOM_MESSAGE_MAX = 8_000;
export const ROOM_MEMBERS_MAX = 24;
export const ROOM_BOARD_MAX = 60;
export const ROOM_HISTORY_TAIL = 400;
const ROOM_ID_RE = /^room_[a-z0-9]{6,32}$/;

export function newRoomId(): string {
  return `room_${randomBytes(6).toString("hex")}`;
}
export function newMessageId(): string {
  return `rm_${randomBytes(8).toString("hex")}`;
}
export function newJobId(): string {
  return `job_${randomBytes(4).toString("hex")}`;
}
export function newInviteCode(): string {
  // Easy to read out over the phone: no 0/O, 1/l.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function isRoomId(value: unknown): value is string {
  return typeof value === "string" && ROOM_ID_RE.test(value);
}
export function roomsDir(home: string): string {
  return path.join(home, "rooms");
}
export function roomFile(home: string, id: string): string {
  return path.join(roomsDir(home), `${id}.json`);
}
/** The room's shared files, kept by whoever HOSTS the room (the directory
 *  for rooms between people). Every member's agents read the same copy. */
export function roomFilesDir(home: string, id: string): string {
  return path.join(roomsDir(home), `${id}.files`);
}
export const ROOM_FILE_MAX = 4 * 1024 * 1024;
export const ROOM_FILES_MAX = 120;
export const ROOM_FILES_TOTAL_MAX = 40 * 1024 * 1024;
/** "neon-brawl.html", "assets/sprite.png" — up to three folders deep, no
 *  dot-segments, no hidden files. */
export function isRoomFileName(name: string): boolean {
  if (typeof name !== "string" || name.length > 200) return false;
  const parts = name.split("/");
  if (parts.length > 4) return false;
  return parts.every((p) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/.test(p) && p !== "." && p !== "..");
}
const ROOM_FILE_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm", glb: "model/gltf-binary", gltf: "model/gltf+json",
  wasm: "application/wasm", pdf: "application/pdf", zip: "application/zip",
};
export function roomFileType(name: string): string {
  return ROOM_FILE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
export function roomFileUrl(origin: string, roomId: string, name: string): string {
  return `${origin.replace(/\/+$/, "")}/gateway/rooms/${roomId}/files/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export function roomMessagesFile(home: string, id: string): string {
  return path.join(roomsDir(home), `${id}.messages.jsonl`);
}

/** The one key a member has inside a room ("agent:local:p_abc", "person:owner"). */
export function memberKey(m: Pick<RoomMember, "kind" | "id" | "home">): string {
  return `${m.kind}:${m.home}:${m.id}`;
}
export function fromKey(f: RoomFrom): string {
  return `${f.kind}:${f.home ?? "local"}:${f.id}`;
}
export function sameMember(a: Pick<RoomMember, "kind" | "id" | "home">, f: RoomFrom): boolean {
  return a.kind === f.kind && a.id === f.id && a.home === (f.home ?? "local");
}

export const DEFAULT_RULES: RoomRules = { turns: "mention", maxAgentRun: 6, paused: false, checkinMinutes: 0 };

// ─── normalisation ───────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const clip = (v: string | undefined, max: number) => (v === undefined ? undefined : v.slice(0, max));

function normalizeMember(raw: unknown): RoomMember | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "agent" || r.kind === "person" ? r.kind : null;
  const id = str(r.id);
  const name = str(r.name);
  if (!kind || !id || !name) return null;
  return {
    kind,
    id,
    name: name.slice(0, 60),
    ...(str(r.emoji) ? { emoji: str(r.emoji)!.slice(0, 16) } : {}),
    ...(str(r.color) ? { color: str(r.color) } : {}),
    home: str(r.home) || "local",
    ...(str(r.owner) ? { owner: str(r.owner) } : {}),
    ...(r.muted === true ? { muted: true } : {}),
    joinedAt: str(r.joinedAt) ?? new Date().toISOString(),
  };
}

const JOB_STATUSES: RoomJobStatus[] = ["todo", "working", "blocked", "review", "done"];

function normalizeJob(raw: unknown): RoomJob | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  if (!id || !title) return null;
  return {
    id,
    title: title.slice(0, 200),
    ...(str(r.owner) ? { owner: str(r.owner) } : {}),
    status: JOB_STATUSES.includes(r.status as RoomJobStatus) ? (r.status as RoomJobStatus) : "todo",
    ...(str(r.due) ? { due: str(r.due) } : {}),
    links: Array.isArray(r.links) ? r.links.filter((l): l is string => typeof l === "string").slice(0, 12) : [],
    ...(str(r.note) ? { note: str(r.note)!.slice(0, 600) } : {}),
    updatedAt: str(r.updatedAt) ?? new Date().toISOString(),
    by: str(r.by) ?? "person:local:owner",
  };
}

export function normalizeRules(raw: unknown, base: RoomRules = DEFAULT_RULES): RoomRules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const turns = r.turns === "round" || r.turns === "free" || r.turns === "mention" ? r.turns : base.turns;
  const run = typeof r.maxAgentRun === "number" && Number.isFinite(r.maxAgentRun) ? Math.max(1, Math.min(200, Math.round(r.maxAgentRun))) : base.maxAgentRun;
  const checkin = typeof r.checkinMinutes === "number" && Number.isFinite(r.checkinMinutes) ? Math.max(0, Math.min(24 * 60, Math.round(r.checkinMinutes))) : base.checkinMinutes;
  const lead = r.lead === null || r.lead === "" ? undefined : typeof r.lead === "string" ? r.lead.slice(0, 200) : base.lead;
  return { turns, maxAgentRun: run, paused: typeof r.paused === "boolean" ? r.paused : base.paused, checkinMinutes: checkin, ...(lead ? { lead } : {}) };
}

export function normalizeRoom(raw: unknown): Room | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const name = str(r.name);
  if (!isRoomId(id) || !name) return null;
  const now = new Date().toISOString();
  const hostRaw = (r.host && typeof r.host === "object" ? r.host : {}) as Record<string, unknown>;
  const host: Room["host"] = hostRaw.kind === "remote" && str(hostRaw.origin) && str(hostRaw.token) && str(hostRaw.roomId)
    ? { kind: "remote", origin: str(hostRaw.origin)!, token: str(hostRaw.token)!, roomId: str(hostRaw.roomId)! }
    : { kind: "local" };
  const threads: Record<string, string> = {};
  if (r.threads && typeof r.threads === "object") {
    for (const [k, v] of Object.entries(r.threads as Record<string, unknown>)) if (typeof v === "string" && v) threads[k] = v;
  }
  const workThreads: Record<string, string> = {};
  if (r.workThreads && typeof r.workThreads === "object") {
    for (const [k, v] of Object.entries(r.workThreads as Record<string, unknown>)) if (typeof v === "string" && v) workThreads[k] = v;
  }
  return {
    id,
    name: name.slice(0, ROOM_NAME_MAX),
    ...(str(r.emoji) ? { emoji: str(r.emoji)!.slice(0, 16) } : {}),
    ...(str(r.color) ? { color: str(r.color) } : {}),
    purpose: clip(str(r.purpose), ROOM_PURPOSE_MAX) ?? "",
    members: (Array.isArray(r.members) ? r.members.map(normalizeMember).filter((m): m is RoomMember => m !== null) : []).slice(0, ROOM_MEMBERS_MAX),
    rules: normalizeRules(r.rules),
    board: (Array.isArray(r.board) ? r.board.map(normalizeJob).filter((j): j is RoomJob => j !== null) : []).slice(0, ROOM_BOARD_MAX),
    notes: clip(str(r.notes), ROOM_NOTES_MAX) ?? "",
    host,
    invites: Array.isArray(r.invites) ? r.invites.filter((i): i is RoomInvite => !!i && typeof i === "object" && typeof (i as RoomInvite).code === "string") : [],
    guests: Array.isArray(r.guests) ? r.guests.filter((g): g is RoomGuest => !!g && typeof g === "object" && typeof (g as RoomGuest).id === "string" && typeof (g as RoomGuest).tokenHash === "string") : [],
    threads,
    ...(Object.keys(workThreads).length ? { workThreads } : {}),
    seq: typeof r.seq === "number" && Number.isFinite(r.seq) ? Math.max(0, Math.floor(r.seq)) : 0,
    createdAt: str(r.createdAt) ?? now,
    updatedAt: str(r.updatedAt) ?? now,
  };
}

export function normalizeMessage(raw: unknown): RoomMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const f = (r.from && typeof r.from === "object" ? r.from : null) as Record<string, unknown> | null;
  if (!f) return null;
  const kind = f.kind === "agent" || f.kind === "person" || f.kind === "system" ? f.kind : null;
  const fid = str(f.id);
  const fname = str(f.name);
  const text = str(r.text);
  if (!kind || !fid || !fname || text === undefined || typeof r.seq !== "number") return null;
  return {
    seq: r.seq,
    id: str(r.id) ?? `rm_${r.seq}`,
    at: str(r.at) ?? new Date().toISOString(),
    from: { kind, id: fid, name: fname.slice(0, 60), ...(str(f.home) ? { home: str(f.home) } : {}) },
    text: text.slice(0, ROOM_MESSAGE_MAX),
    kind: r.kind === "system" || r.kind === "job" || r.kind === "note" ? r.kind : "text",
  };
}

// ─── the store ───────────────────────────────────────────────────────────

/** Rooms and their messages on disk, with an in-memory index that re-reads a
 *  file when its mtime moves (the garrison may have written it). */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly mtimes = new Map<string, number>();
  private readonly tails = new Map<string, { size: number; messages: RoomMessage[] }>();

  constructor(readonly home: string) {}

  async load(): Promise<Room[]> {
    this.rooms.clear();
    this.mtimes.clear();
    const dir = roomsDir(this.home);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".messages.jsonl")) continue;
      await this.readRoom(name.slice(0, -5)).catch(() => undefined);
    }
    return this.list();
  }

  private async readRoom(id: string): Promise<Room | undefined> {
    const file = roomFile(this.home, id);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) {
      this.rooms.delete(id);
      this.mtimes.delete(id);
      return undefined;
    }
    const room = normalizeRoom(JSON.parse(await fs.readFile(file, "utf8")));
    if (room && room.id === id) {
      this.rooms.set(id, room);
      this.mtimes.set(id, stat.mtimeMs);
      return room;
    }
    return undefined;
  }

  /** Re-read any room whose file changed under us; pick up new ones. */
  async refresh(): Promise<{ changed: string[]; added: string[]; removed: string[] }> {
    const out = { changed: [] as string[], added: [] as string[], removed: [] as string[] };
    const dir = roomsDir(this.home);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isRoomId(id)) continue;
      seen.add(id);
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      if (!stat) continue;
      const known = this.mtimes.get(id);
      if (known === stat.mtimeMs) continue;
      const before = this.rooms.has(id);
      await this.readRoom(id).catch(() => undefined);
      (before ? out.changed : out.added).push(id);
    }
    for (const id of [...this.rooms.keys()]) {
      if (!seen.has(id)) {
        this.rooms.delete(id);
        this.mtimes.delete(id);
        this.tails.delete(id);
        out.removed.push(id);
      }
    }
    return out;
  }

  list(): Room[] {
    return [...this.rooms.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  async save(room: Room): Promise<void> {
    const dir = roomsDir(this.home);
    await fs.mkdir(dir, { recursive: true });
    const file = roomFile(this.home, room.id);
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(room, null, 2), "utf8");
    await fs.rename(tmp, file);
    this.rooms.set(room.id, room);
    const stat = await fs.stat(file).catch(() => null);
    if (stat) this.mtimes.set(room.id, stat.mtimeMs);
  }

  async remove(id: string): Promise<void> {
    const dir = path.join(roomsDir(this.home), ".deleted");
    await fs.mkdir(dir, { recursive: true });
    for (const f of [roomFile(this.home, id), roomMessagesFile(this.home, id)]) {
      await fs.rename(f, path.join(dir, path.basename(f))).catch(() => undefined);
    }
    this.rooms.delete(id);
    this.mtimes.delete(id);
    this.tails.delete(id);
  }

  /** Append one message. The caller has already numbered it (hosts number
   *  their own; guests take the host's numbers). One line, one write. */
  async append(roomId: string, message: RoomMessage): Promise<void> {
    await fs.mkdir(roomsDir(this.home), { recursive: true });
    await fs.appendFile(roomMessagesFile(this.home, roomId), JSON.stringify(message) + "\n", "utf8");
    const tail = this.tails.get(roomId);
    if (tail) {
      tail.messages.push(message);
      if (tail.messages.length > ROOM_HISTORY_TAIL) tail.messages.splice(0, tail.messages.length - ROOM_HISTORY_TAIL);
      tail.size = -1; // force a re-stat next read; the file grew
    }
  }

  /** The last `limit` messages (newest last). Re-reads the file when it grew. */
  async messages(roomId: string, limit = ROOM_HISTORY_TAIL): Promise<RoomMessage[]> {
    const file = roomMessagesFile(this.home, roomId);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) return [];
    const cached = this.tails.get(roomId);
    if (cached && cached.size === stat.size) return cached.messages.slice(-limit);
    const text = await fs.readFile(file, "utf8");
    const lines = text.split("\n");
    const out: RoomMessage[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < ROOM_HISTORY_TAIL; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const m = normalizeMessage(JSON.parse(line));
        if (m) out.push(m);
      } catch {
        // a torn last line (another process mid-write) is read next time
      }
    }
    out.reverse();
    this.tails.set(roomId, { size: stat.size, messages: out });
    return out.slice(-limit);
  }

  /** Messages after a seq (for a long-poll or a catch-up digest). */
  async since(roomId: string, seq: number, limit = 200): Promise<RoomMessage[]> {
    const all = await this.messages(roomId);
    return all.filter((m) => m.seq > seq).slice(0, limit);
  }

  /** The highest seq actually on disk — the truth when two processes append. */
  async lastSeq(roomId: string): Promise<number> {
    const all = await this.messages(roomId, 1);
    return Math.max(this.rooms.get(roomId)?.seq ?? 0, all.at(-1)?.seq ?? 0);
  }
}

// ─── who speaks next ─────────────────────────────────────────────────────

/** "@bob", "@audit andy", "@Audit" → member keys. A first name alone matches
 *  ("@andy" finds "audit andy"); "@everyone"/"@all" is everyone. */
export function mentionedMembers(text: string, members: readonly RoomMember[]): RoomMember[] {
  const lower = text.toLowerCase();
  if (/@(everyone|all|here)\b/.test(lower)) return members.filter((m) => m.kind === "agent");
  const hits: RoomMember[] = [];
  for (const m of members) {
    const full = m.name.toLowerCase();
    const words = full.split(/\s+/).filter(Boolean);
    const forms = new Set([full, ...words, words.at(-1) ?? ""]);
    for (const form of forms) {
      if (!form) continue;
      const re = new RegExp(`@${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
      if (re.test(text)) {
        hits.push(m);
        break;
      }
    }
  }
  return hits;
}

/** The agent this message answers: the last agent before it, since the last
 *  person spoke, that is not its own author. */
export function previousAgentSpeaker(message: RoomMessage, recent: readonly RoomMessage[]): RoomFrom | undefined {
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.seq >= message.seq) continue;
    if (m.kind === "system" || m.kind === "job" || m.kind === "note") continue;
    if (m.from.kind === "person") return undefined;
    if (m.from.kind === "agent" && !(m.from.id === message.from.id && (m.from.home ?? "local") === (message.from.home ?? "local"))) return m.from;
  }
  return undefined;
}

/** The room's lead agent: the one the rules name (if still here and not
 *  muted), else the first agent. */
export function leadOf(room: Room, agents: readonly RoomMember[] = room.members.filter((m) => m.kind === "agent" && !m.muted)): RoomMember | undefined {
  return (room.rules.lead ? agents.find((m) => memberKey(m) === room.rules.lead) : undefined) ?? agents[0];
}

/** How many agent messages have run since a person last spoke (newest last). */
export function agentRun(messages: readonly RoomMessage[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === "system") continue;
    if (m.from.kind === "person") break;
    if (m.from.kind === "agent") n++;
  }
  return n;
}

export interface Dispatch {
  /** Local agent member ids that should answer this message. */
  agents: string[];
  /** The run cap hit: agents stop until a person speaks. */
  waitingForHuman: boolean;
  /** Why nobody answers (for the system line). */
  reason?: string;
}

/**
 * Decide which of THIS machine's agents answer `message`, given the room's
 * rules and the recent thread (newest last, `message` included).
 */
export function dispatchFor(room: Room, message: RoomMessage, recent: readonly RoomMessage[]): Dispatch {
  if (message.kind === "system" && !message.text.startsWith("⏱")) return { agents: [], waitingForHuman: false, reason: "system" };
  if (room.rules.paused) return { agents: [], waitingForHuman: false, reason: "paused" };
  const local = room.members.filter((m) => m.kind === "agent" && m.home === "local" && !m.muted && !sameMember(m, message.from));
  if (local.length === 0) return { agents: [], waitingForHuman: false, reason: "no agents here" };
  if (message.from.kind === "agent" && agentRun(recent) >= room.rules.maxAgentRun) {
    return { agents: [], waitingForHuman: true, reason: `${room.rules.maxAgentRun} agent messages in a row` };
  }
  const agents = room.members.filter((m) => m.kind === "agent" && !m.muted);
  // Mentions are read over EVERY agent (muted or remote included): naming a
  // muted agent or someone else's agent is still a hand-off to them, not an
  // invitation for the lead to answer instead.
  const named = mentionedMembers(message.text, room.members.filter((m) => m.kind === "agent")).filter((m) => !sameMember(m, message.from));
  const mentioned = named.filter((m) => m.home === "local" && !m.muted);
  if (room.rules.turns === "free") {
    const picked = named.length ? mentioned : local;
    return { agents: picked.map((m) => m.id), waitingForHuman: false };
  }
  if (room.rules.turns === "round") {
    if (named.length) return { agents: mentioned.map((m) => m.id), waitingForHuman: false };
    const order = agents;
    const at = order.findIndex((m) => sameMember(m, message.from));
    for (let step = 1; step <= order.length; step++) {
      const next = order[(at + step) % order.length]!;
      if (at < 0 && step === 1) {
        // a person spoke: the first agent in the room takes it
        const first = order[0]!;
        return { agents: first.home === "local" ? [first.id] : [], waitingForHuman: false };
      }
      if (sameMember(next, message.from)) continue;
      return { agents: next.home === "local" ? [next.id] : [], waitingForHuman: false };
    }
    return { agents: [], waitingForHuman: false };
  }
  // mention: the people named answer; a person who names nobody gets the
  // lead; an agent who names nobody ends the exchange (the natural brake).
  if (named.length) return { agents: mentioned.map((m) => m.id), waitingForHuman: false };
  if (message.from.kind === "person" || message.kind === "system") {
    const lead = leadOf(room, agents);
    return { agents: lead && lead.home === "local" ? [lead.id] : [], waitingForHuman: false };
  }
  // An agent that names nobody is answering whoever spoke to it: the reply
  // goes back to the last OTHER agent in the exchange (owner, 2026-10-20: "my
  // agent talked to Cupid's, his responded, and it stopped"). Ends when a
  // person speaks, an agent passes, or the run cap trips.
  const replyTo = previousAgentSpeaker(message, recent);
  if (replyTo) {
    const member = agents.find((m) => sameMember(m, replyTo));
    if (member && member.home === "local" && !member.muted) return { agents: [member.id], waitingForHuman: false };
    if (member) return { agents: [], waitingForHuman: false, reason: "reply goes to another machine" };
  }
  return { agents: [], waitingForHuman: false, reason: "nobody mentioned" };
}

// ─── what an agent reads ─────────────────────────────────────────────────

export function describeFrom(f: RoomFrom, room: Room, viewer?: RoomMember): string {
  if (f.kind === "system") return "room";
  const member = room.members.find((m) => sameMember(m, f));
  if (f.kind === "person") {
    const mine = viewer && member && viewer.owner === memberKey(member);
    return mine ? `${f.name} (your owner)` : `${f.name} (a person, not your owner)`;
  }
  const theirs = member?.owner ? room.members.find((m) => memberKey(m) === member.owner)?.name : undefined;
  return `${f.name} (${theirs ? `${theirs}'s agent` : "an agent"})`;
}

/** The turn an agent receives: the thread since it last looked, then the
 *  message that summoned it. Short on purpose — the room's board and notes
 *  ride in the prompt layer, not here. */
export function roomTurnText(room: Room, viewer: RoomMember, unseen: readonly RoomMessage[], trigger: RoomMessage): string {
  const lines: string[] = [];
  const earlier = unseen.filter((m) => m.seq < trigger.seq);
  if (earlier.length) {
    lines.push(`[room "${room.name}" — ${earlier.length} message${earlier.length === 1 ? "" : "s"} since you last looked]`);
    for (const m of earlier.slice(-40)) lines.push(`${describeFrom(m.from, room, viewer)}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 600)}`);
    lines.push("");
  }
  lines.push(`[room "${room.name}"] ${describeFrom(trigger.from, room, viewer)}: ${trigger.text.trim()}`);
  return lines.join("\n");
}

/** A line of text that means "nothing to add" — the agent stayed quiet. */
export function isPass(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!)\]]+$/g, "").replace(/^[(\[]+/, "");
  return t === "pass" || t === "(pass)" || t === "[pass]" || t === "nothing to add" || t === "no comment";
}

/** Jobs whose owner has gone quiet past their due time. */
export function overdueJobs(room: Room, now = Date.now()): RoomJob[] {
  return room.board.filter((j) => j.status !== "done" && j.due && Date.parse(j.due) < now);
}

/** The board as the agents read it in their prompt layer. */
export function boardText(room: Room): string {
  if (room.board.length === 0) return "(empty)";
  const who = (key?: string) => (key ? room.members.find((m) => memberKey(m) === key)?.name ?? "?" : "unassigned");
  return room.board
    .map((j) => `- [${j.status}] ${j.title} — ${who(j.owner)}${j.due ? ` · due ${j.due}` : ""}${j.links.length ? ` · ${j.links.join(" ")}` : ""}${j.note ? ` · ${j.note}` : ""}`)
    .join("\n");
}

/** The person member on this machine (the owner, in their own rooms). */
export function ownerMember(room: Room): RoomMember | undefined {
  return room.members.find((m) => m.kind === "person" && m.home === "local");
}

/** Parse an invite link: ares://room?url=<origin>&room=<id>&code=<code>. */
export function parseInvite(link: string): { origin: string; roomId: string; code: string } | null {
  const t = link.trim();
  let u: URL;
  try {
    u = new URL(t.replace(/^ares:\/\/room/i, "https://ares.invalid/room"));
  } catch {
    return null;
  }
  const origin = u.searchParams.get("url") ?? "";
  const roomId = u.searchParams.get("room") ?? "";
  const code = u.searchParams.get("code") ?? "";
  if (!/^https?:\/\//i.test(origin) || !isRoomId(roomId) || !/^[a-z0-9]{6,16}$/i.test(code)) return null;
  return { origin: origin.replace(/\/+$/, ""), roomId, code };
}

export function inviteLink(origin: string, roomId: string, code: string): string {
  return `ares://room?url=${encodeURIComponent(origin)}&room=${encodeURIComponent(roomId)}&code=${encodeURIComponent(code)}`;
}
