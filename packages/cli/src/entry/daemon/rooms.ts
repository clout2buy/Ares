// Rooms, daemon-side: the engine behind group chats (see ../../rooms.ts).
//
// Owner, 2026-10-19: "join people / groups... background talks, gotta feel
// like iMessage."
//
// What this does:
//   seats     — every local agent in a room gets ONE daemon session as its
//               seat (bound to the agent, so it runs on the agent's brain and
//               memory, plus the room layer on top). Room messages reach it
//               as turns; what it says comes back out as a room message.
//   dispatch  — rooms.ts decides who answers (mention / round / free, the
//               run cap); this delivers the turns and posts the replies.
//   host      — a room made here is hosted here. Guests reach it through the
//               garrison's /gateway/rooms routes (../../phoneRooms.ts), which
//               append to the same files; a short timer drains what they wrote.
//   guest     — a room joined by invite lives on someone else's Ares. We
//               long-poll it, mirror the thread locally, dispatch to OUR
//               agents only, and post back through the host.
//   nudges    — check-ins for the lead agent and overdue-job pokes, so a team
//               keeps moving while the owner is away.

import { SKILL_NAME_RE, lessonMessage, parseShare, skillFileName, skillMessage } from "./sharing.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RoomFileConflict, listRoomFiles, writeRoomFile, type RoomPresence } from "../../phoneRooms.js";
import {
  ROOM_FILE_MAX,
  isRoomFileName,
  roomFileUrl,
  roomFilesDir,
  DEFAULT_RULES,
  ROOM_BOARD_MAX,
  ROOM_MEMBERS_MAX,
  ROOM_MESSAGE_MAX,
  ROOM_NAME_MAX,
  ROOM_NOTES_MAX,
  ROOM_PURPOSE_MAX,
  RoomStore,
  agentRun,
  boardText,
  dispatchFor,
  leadOf,
  inviteLink,
  isPass,
  memberKey,
  newInviteCode,
  newJobId,
  newMessageId,
  newRoomId,
  normalizeRules,
  overdueJobs,
  ownerMember,
  parseInvite,
  roomTurnText,
  roomsDir,
  sameMember,
  type Room,
  type RoomFrom,
  type RoomJob,
  type RoomJobStatus,
  type RoomMember,
  type RoomMessage,
  type RoomRules,
} from "../../rooms.js";
import { roomLayerBlock } from "../prompt/texting.js";
import { PLAYTEST_UNPROVEN, pageFindings, relayFor, twoClientCheck } from "./roomPlaytest.js";
import type { RoomCard, RoomJobCard, RoomsHost } from "../roomScope.js";
import type { DesktopAgents } from "./agents.js";
import type { Persona } from "../../personas.js";

export class RoomError extends Error {}

/** What the desktop renders for one room (no secrets). */
export interface RoomWire {
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  purpose: string;
  members: RoomMember[];
  rules: RoomRules;
  board: RoomJob[];
  notes: string;
  remote: boolean;
  /** Host only: open invites (codes, so the owner can re-share). */
  invites: Array<{ code: string; label?: string; createdAt: string; usedBy?: string }>;
  guests: Array<{ id: string; name: string; joinedAt: string; lastSeenAt?: string }>;
  threads: Record<string, string>;
  workThreads: Record<string, string>;
  workspaceId?: string;
  seq: number;
  folder: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoomsMe {
  id: string;
  name: string;
}

export interface DesktopRoomsDeps {
  home: string;
  workspace: string;
  agents: DesktopAgents;
  /** Queue a message as a new turn in a session (the daemon's command queue). */
  deliver(sessionId: string, goal: string, inputId: string): void;
  busy(sessionId: string): boolean;
  /** Untagged event to the desktop. */
  emit(payload: Record<string, unknown>): void;
  /** This machine's public gateway origin (https://…), for invites. */
  publicOrigin(): Promise<string | null>;
  /** After a seat's prompt layer changed (room renamed, board moved…). */
  relayer(sessionId: string): void;
  /** Stop a running turn (the room's kill switch). */
  interrupt?(sessionId: string): void;
  /** Cross-owner sharing (daemon/sharing.ts): the owner's two switches, the
   *  inbox a share from another owner's agent lands in, and a local skill's
   *  SKILL.md for teaching. */
  sharing?: {
    give(): boolean;
    take(): boolean;
    receive(item: { kind: "lesson" | "skill"; text: string; skill?: string; file?: string; roomId: string; roomName: string; fromAgent: string; fromOwner?: string }): Promise<unknown>;
    skill(name: string): Promise<{ text: string; description: string } | undefined>;
  };
  now?: () => number;
  fetchImpl?: typeof fetch;
}

const WAIT_IDLE_MS = 5 * 60_000;
const DRAIN_MS = 2_000;
const NUDGE_MS = 60_000;
const POLL_WAIT_S = 25;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
}

function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

export function roomToWire(room: Room, workspace: string): RoomWire {
  return {
    id: room.id,
    name: room.name,
    ...(room.emoji ? { emoji: room.emoji } : {}),
    ...(room.color ? { color: room.color } : {}),
    purpose: room.purpose,
    members: room.members,
    rules: room.rules,
    board: room.board,
    notes: room.notes,
    remote: room.host.kind === "remote",
    invites: room.invites.map(({ code, label, createdAt, usedBy }) => ({ code, ...(label ? { label } : {}), createdAt, ...(usedBy ? { usedBy } : {}) })),
    guests: room.guests.map(({ id, name, joinedAt, lastSeenAt }) => ({ id, name, joinedAt, ...(lastSeenAt ? { lastSeenAt } : {}) })),
    threads: room.threads,
    workThreads: room.workThreads ?? {},
    ...(room.workspaceId ? { workspaceId: room.workspaceId } : {}),
    seq: room.seq,
    folder: path.join(workspace, "rooms", slug(room.name)),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

interface Seat {
  roomId: string;
  agentId: string;
  /** The agent called Rooms say/pass during this turn. */
  spoke: boolean;
  /** The last assistant text seen for the running turn. */
  lastText: string;
  inputId?: string;
}

export class DesktopRooms {
  readonly store: RoomStore;
  private me: RoomsMe = { id: "", name: "" };
  /** sessionId → the seat it is. */
  private readonly seats = new Map<string, Seat>();
  /** roomId → agentId → highest seq that agent has been shown. */
  private readonly seen = new Map<string, Map<string, number>>();
  /** roomId → highest seq this engine has processed (emitted + dispatched). */
  private readonly drained = new Map<string, number>();
  /** roomId → message ids in the local mirror (guest side dedupe). */
  private readonly known = new Map<string, Set<string>>();
  private readonly nudged = new Map<string, Set<string>>();
  private readonly lastCheckin = new Map<string, number>();
  private readonly pollers = new Map<string, AbortController>();
  /** roomId → file name → the rev this install last fetched or shared. */
  private readonly fileRevs = new Map<string, Map<string, number>>();
  /** roomId → who on the OTHER machines is working right now. */
  private readonly remotePresence = new Map<string, RoomPresence[]>();
  private drainTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private stopped = false;

  constructor(private readonly deps: DesktopRoomsDeps) {
    this.store = new RoomStore(deps.home);
    this.now = deps.now ?? Date.now;
    this.fetch = deps.fetchImpl ?? globalThis.fetch;
  }

  // ─── identity ──────────────────────────────────────────────────────────

  private meFile(): string {
    return path.join(roomsDir(this.deps.home), "me.json");
  }

  async loadMe(): Promise<RoomsMe> {
    try {
      const raw = JSON.parse(await fs.readFile(this.meFile(), "utf8")) as Partial<RoomsMe>;
      if (typeof raw.id === "string" && raw.id && typeof raw.name === "string" && raw.name) {
        this.me = { id: raw.id, name: raw.name };
        return this.me;
      }
    } catch {
      // first run
    }
    let name = "";
    try { name = os.userInfo().username; } catch { /* no user info in some sandboxes */ }
    this.me = { id: `me_${randomUUID().replace(/-/g, "").slice(0, 12)}`, name: name || "Owner" };
    await this.saveMe();
    return this.me;
  }

  private async saveMe(): Promise<void> {
    await fs.mkdir(roomsDir(this.deps.home), { recursive: true });
    await fs.writeFile(this.meFile(), JSON.stringify(this.me, null, 2), "utf8");
  }

  whoami(): RoomsMe {
    return this.me;
  }

  async rename(name: string): Promise<RoomsMe> {
    const n = clean(name, 60);
    if (!n) throw new RoomError("name required");
    this.me = { ...this.me, name: n };
    await this.saveMe();
    // The owner's member rows in every local room follow.
    for (const room of this.store.list()) {
      const mine = room.members.find((m) => m.kind === "person" && m.home === "local");
      if (mine && mine.name !== n) {
        mine.name = n;
        await this.store.save({ ...room, updatedAt: this.stamp() });
        if (room.host.kind === "remote") void this.pushMembers(room).catch(() => undefined);
      }
    }
    this.emitList();
    return this.me;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  async load(): Promise<RoomWire[]> {
    await this.loadMe();
    await this.store.load();
    for (const room of this.store.list()) {
      for (const [agentId, sid] of Object.entries(room.threads)) this.seats.set(sid, { roomId: room.id, agentId, spoke: false, lastText: "" });
      // Nothing that is already on disk gets re-dispatched at boot.
      this.drained.set(room.id, await this.store.lastSeq(room.id));
      const ids = new Set<string>();
      for (const m of await this.store.messages(room.id)) ids.add(m.id);
      this.known.set(room.id, ids);
      if (room.host.kind === "remote") {
        this.startPolling(room.id);
        const mine = room.members.find((m) => m.kind === "person" && m.home === "local");
        if (mine && mine.name !== this.me.name) void this.pushMembers(room).catch(() => undefined);
      }
    }
    this.drainTimer ??= setInterval(() => void this.drainAll().catch(() => undefined), DRAIN_MS);
    this.drainTimer.unref?.();
    this.nudgeTimer ??= setInterval(() => void this.nudgeAll().catch(() => undefined), NUDGE_MS);
    this.nudgeTimer.unref?.();
    return this.list();
  }

  stop(): void {
    this.stopped = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.nudgeTimer) clearInterval(this.nudgeTimer);
    for (const c of this.pollers.values()) c.abort();
    this.pollers.clear();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  list(): RoomWire[] {
    return this.store.list().map((r) => roomToWire(r, this.deps.workspace));
  }

  get(id: string): Room | undefined {
    return this.store.get(id);
  }

  wire(room: Room): RoomWire {
    return roomToWire(room, this.deps.workspace);
  }

  private emitList(): void {
    this.deps.emit({ type: "rooms_list", rooms: this.list(), me: this.me });
  }

  private emitRoom(room: Room): void {
    this.deps.emit({ type: "room_changed", room: this.wire(room) });
  }

  /** Name or id → room. */
  resolve(target: string): Room | undefined {
    const t = target.trim();
    return this.store.get(t) ?? this.store.list().find((r) => r.name.toLowerCase() === t.toLowerCase());
  }

  /** Which room (if any) a session is a seat in. */
  seatOf(sessionId: string): Seat | undefined {
    return this.seats.get(sessionId);
  }

  isSeat(sessionId: string): boolean {
    return this.seats.has(sessionId);
  }

  // ─── create / edit ─────────────────────────────────────────────────────

  private ownerRow(): RoomMember {
    return { kind: "person", id: "owner", name: this.me.name, home: "local", joinedAt: this.stamp() };
  }

  private agentRow(p: Persona): RoomMember {
    return {
      kind: "agent",
      id: p.id,
      name: p.name,
      ...(p.emoji ? { emoji: p.emoji } : {}),
      ...(p.color ? { color: p.color } : {}),
      home: "local",
      owner: memberKey({ kind: "person", id: "owner", home: "local" }),
      joinedAt: this.stamp(),
    };
  }

  private async ensureFolder(room: Room): Promise<void> {
    await fs.mkdir(path.join(this.deps.workspace, "rooms", slug(room.name)), { recursive: true }).catch(() => undefined);
  }

  async create(spec: { name?: unknown; emoji?: unknown; color?: unknown; purpose?: unknown; agents?: unknown; rules?: unknown }): Promise<Room> {
    const name = clean(spec.name, ROOM_NAME_MAX);
    if (!name) throw new RoomError("name required");
    const stamp = this.stamp();
    const room: Room = {
      id: newRoomId(),
      name,
      ...(clean(spec.emoji, 16) ? { emoji: clean(spec.emoji, 16) } : {}),
      ...(clean(spec.color, 7) ? { color: clean(spec.color, 7) } : {}),
      purpose: clean(spec.purpose, ROOM_PURPOSE_MAX) ?? "",
      members: [this.ownerRow()],
      rules: normalizeRules(spec.rules, DEFAULT_RULES),
      board: [],
      notes: "",
      host: { kind: "local" },
      invites: [],
      guests: [],
      threads: {},
      seq: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const ids = Array.isArray(spec.agents) ? spec.agents.filter((a): a is string => typeof a === "string") : [];
    for (const id of ids) {
      const p = this.deps.agents.resolve(id);
      if (p && !room.members.some((m) => m.kind === "agent" && m.id === p.id && m.home === "local")) room.members.push(this.agentRow(p));
    }
    await this.store.save(room);
    await this.ensureFolder(room);
    this.drained.set(room.id, 0);
    this.known.set(room.id, new Set());
    await this.system(room, `${this.me.name} opened the room${room.members.length > 1 ? ` with ${room.members.filter((m) => m.kind === "agent").map((m) => m.name).join(", ")}` : ""}.`);
    this.emitList();
    return room;
  }

  async update(id: string, spec: { name?: unknown; emoji?: unknown; color?: unknown; purpose?: unknown; rules?: unknown; notes?: unknown; workspaceId?: unknown }): Promise<Room> {
    const room = this.store.get(id);
    if (!room) throw new RoomError("unknown room");
    const next: Room = { ...room, updatedAt: this.stamp() };
    if (spec.name !== undefined) {
      const n = clean(spec.name, ROOM_NAME_MAX);
      if (!n) throw new RoomError("name required");
      next.name = n;
    }
    if (spec.emoji !== undefined) { const e = clean(spec.emoji, 16); if (e) next.emoji = e; else delete next.emoji; }
    if (spec.color !== undefined) { const c = clean(spec.color, 7); if (c) next.color = c; else delete next.color; }
    if (spec.purpose !== undefined) next.purpose = clean(spec.purpose, ROOM_PURPOSE_MAX) ?? "";
    if (spec.notes !== undefined) next.notes = clean(spec.notes, ROOM_NOTES_MAX) ?? "";
    if (spec.rules !== undefined) next.rules = normalizeRules(spec.rules, room.rules);
    if (spec.workspaceId !== undefined) { const w = clean(spec.workspaceId, 40); if (w) next.workspaceId = w; else delete next.workspaceId; }
    await this.store.save(next);
    await this.ensureFolder(next);
    if (room.rules.paused !== next.rules.paused) await this.system(next, next.rules.paused ? `${this.me.name} paused the agents.` : `${this.me.name} resumed the agents.`);
    if (next.host.kind === "remote") void this.pushRoomPatch(next, { rules: next.rules, notes: next.notes, purpose: next.purpose }).catch(() => undefined);
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  async remove(id: string): Promise<string[]> {
    const room = this.store.get(id);
    if (!room) return [];
    if (room.host.kind === "remote") await this.leaveRemote(room).catch(() => undefined);
    const threads = Object.values(room.threads);
    for (const sid of threads) this.seats.delete(sid);
    this.pollers.get(id)?.abort();
    this.pollers.delete(id);
    await this.store.remove(id);
    this.drained.delete(id);
    this.known.delete(id);
    this.emitList();
    return threads;
  }

  // ─── members ───────────────────────────────────────────────────────────

  async addAgent(roomId: string, agentId: string): Promise<Room> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const p = this.deps.agents.resolve(agentId);
    if (!p) throw new RoomError("unknown agent");
    if (room.members.some((m) => m.kind === "agent" && m.id === p.id && m.home === "local")) return room;
    if (room.members.length >= ROOM_MEMBERS_MAX) throw new RoomError(`a room holds up to ${ROOM_MEMBERS_MAX} members`);
    const row = this.agentRow(p);
    const next: Room = { ...room, members: [...room.members, row], updatedAt: this.stamp() };
    await this.store.save(next);
    if (next.host.kind === "remote") await this.pushMembers(next);
    // A room hosted elsewhere records the change itself (phoneRooms /members);
    // saying it here too printed every join twice.
    if (next.host.kind === "local") await this.system(next, `${this.me.name} added ${p.name}.`);
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  /** Recall: the agent leaves the room; its seat is forgotten. */
  async removeAgent(roomId: string, agentId: string): Promise<Room> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const gone = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local");
    if (!gone) return room;
    const threads = { ...room.threads };
    const sid = threads[agentId];
    delete threads[agentId];
    if (sid) this.seats.delete(sid);
    const next: Room = { ...room, members: room.members.filter((m) => m !== gone), threads, updatedAt: this.stamp() };
    await this.store.save(next);
    if (next.host.kind === "remote") await this.pushMembers(next);
    if (next.host.kind === "local") await this.system(next, `${this.me.name} recalled ${gone.name}.`);
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  async setMuted(roomId: string, agentId: string, muted: boolean): Promise<Room> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const row = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local");
    if (!row) throw new RoomError("not your agent, or not in this room");
    if (Boolean(row.muted) === muted) return room;
    const next: Room = { ...room, members: room.members.map((m) => (m === row ? { ...m, ...(muted ? { muted: true } : {}) } : m)), updatedAt: this.stamp() };
    if (!muted) for (const m of next.members) if (m.kind === "agent" && m.id === agentId && m.home === "local") delete m.muted;
    await this.store.save(next);
    if (next.host.kind === "remote") await this.pushMembers(next);
    if (next.host.kind === "local") await this.system(next, muted ? `${this.me.name} muted ${row.name}.` : `${this.me.name} unmuted ${row.name}.`);
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  // ─── messages ──────────────────────────────────────────────────────────

  private async nextSeq(room: Room): Promise<number> {
    return (await this.store.lastSeq(room.id)) + 1;
  }

  /** Append + number a message in a LOCAL room (host side). */
  private async commit(room: Room, from: RoomFrom, text: string, kind: RoomMessage["kind"]): Promise<RoomMessage> {
    const message: RoomMessage = { seq: await this.nextSeq(room), id: newMessageId(), at: this.stamp(), from, text: text.slice(0, ROOM_MESSAGE_MAX), kind };
    await this.store.append(room.id, message);
    const next = { ...room, seq: message.seq, updatedAt: message.at };
    await this.store.save(next);
    this.known.get(room.id)?.add(message.id);
    await this.drain(room.id);
    return message;
  }

  private async system(room: Room, text: string): Promise<void> {
    const from: RoomFrom = { kind: "system", id: "room", name: "room" };
    if (room.host.kind === "remote") {
      await this.postRemote(room, from, text, "system").catch(() => undefined);
      return;
    }
    await this.commit(room, from, text, "system");
  }

  /** The owner speaks (from the desktop composer). */
  async postAsOwner(roomId: string, text: string): Promise<RoomMessage> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const body = text.trim();
    if (!body) throw new RoomError("say something");
    const from: RoomFrom = { kind: "person", id: "owner", name: this.me.name, home: "local" };
    if (room.host.kind === "remote") return this.postRemote(room, from, body, "text");
    return this.commit(room, from, body, "text");
  }

  /** An agent speaks (the Rooms tool, or its turn's final text). */
  private async postAsAgent(room: Room, agentId: string, text: string): Promise<RoomMessage> {
    const member = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local");
    if (!member) throw new RoomError("you are not in that room");
    if (member.muted) throw new RoomError("your owner muted you in this room");
    if (room.rules.paused) throw new RoomError("the room is paused");
    const from: RoomFrom = { kind: "agent", id: agentId, name: member.name, home: "local" };
    const body = text.trim().slice(0, ROOM_MESSAGE_MAX);
    if (room.host.kind === "remote") return this.postRemote(room, from, body, "text");
    return this.commit(room, from, body, "text");
  }

  /** Process every message past the drained mark: tell the UI, dispatch. */
  /** Rooms with a drain pump running, and those asked to drain again. */
  /** Room id → the last few lines said there, for the agents' PRIVATE chats
   *  (so "what's happening in the room?" needs no tool call). Refreshed at
   *  most every DIGEST_EVERY_MS so a busy room doesn't churn their prompt. */
  private readonly digest = new Map<string, string[]>();
  private readonly digestAt = new Map<string, number>();
  private static readonly DIGEST_EVERY_MS = 10 * 60_000;

  private async refreshDigest(roomId: string): Promise<void> {
    const at = this.digestAt.get(roomId) ?? 0;
    if (this.now() - at < DesktopRooms.DIGEST_EVERY_MS) return;
    this.digestAt.set(roomId, this.now());
    const room = this.store.get(roomId);
    if (!room) return;
    const recent = (await this.store.messages(roomId, 30).catch(() => [])).filter((m) => m.kind === "text" || m.kind === "job").slice(-3);
    const lines = recent.map((m) => `${m.from.name}: ${m.text.replace(/\s+/g, " ").slice(0, 110)}`);
    if (JSON.stringify(lines) === JSON.stringify(this.digest.get(roomId) ?? [])) return;
    this.digest.set(roomId, lines);
    for (const m of room.members) {
      if (m.kind !== "agent" || m.home !== "local") continue;
      for (const sid of this.deps.agents.get(m.id)?.desktopThreads ?? []) this.deps.relayer(sid);
    }
  }

  private readonly draining = new Set<string>();
  private readonly drainAgain = new Set<string>();

  /** Process every message past the drained mark: tell the UI, dispatch.
   *  Re-entrancy safe: dispatch can post (a notice, an agent's reply) and
   *  posting drains — that nested call only flags "again" and returns, and
   *  each message's mark moves BEFORE it is dispatched, so nothing is ever
   *  processed twice. (v0.59: a nested drain re-dispatched the same agent
   *  message and posted the run-cap notice ~50 times in 9 seconds.) */
  /** Room id → was it paused when we last looked (the kill switch fires once
   *  on the flip, whichever side flipped it). */
  private readonly pausedSeen = new Map<string, boolean>();
  /** Room id → highest seq already checked for shares. */
  private readonly shareScanned = new Map<string, number>();
  private readonly bootAt = Date.now();

  /** Stop every turn this install's agents are running for the room. */
  private interruptLocal(room: Room): number {
    const sids = [...Object.values(room.threads), ...Object.values(room.workThreads ?? {})];
    let n = 0;
    for (const sid of sids) {
      if (!this.deps.busy(sid)) continue;
      try { this.deps.interrupt?.(sid); n++; } catch { /* never breaks the room */ }
    }
    return n;
  }

  /** The kill switch: pause the room for everyone and stop every agent turn
   *  running in it now. Other owners' installs see the pause and stop theirs. */
  async stopAgents(id: string): Promise<{ room: Room; stopped: number }> {
    const room = this.store.get(id);
    if (!room) throw new RoomError("unknown room");
    const stopped = this.interruptLocal(room);
    const next = room.rules.paused ? room : await this.update(id, { rules: { ...room.rules, paused: true } });
    this.pausedSeen.set(id, true);
    return { room: next, stopped };
  }

  private async scanShares(roomId: string): Promise<void> {
    const share = this.deps.sharing;
    if (!share || !share.take()) return;
    const room = this.store.get(roomId);
    if (!room) return;
    const since = this.shareScanned.get(roomId);
    const msgs = await this.store.messages(roomId, 40).catch(() => [] as RoomMessage[]);
    const top = msgs.reduce((a, m) => Math.max(a, m.seq), since ?? 0);
    this.shareScanned.set(roomId, top);
    const mine = this.ownerKeyOf(room);
    for (const m of msgs) {
      if (since !== undefined ? m.seq <= since : Date.parse(m.at) < this.bootAt) continue;
      if (m.from.kind !== "agent") continue;
      const member = room.members.find((x) => x.kind === "agent" && x.id === m.from.id && (x.home ?? "local") === (m.from.home ?? "local"));
      if (!member || member.home === "local" || member.owner === mine) continue;
      const parsed = parseShare(m.text);
      if (!parsed) continue;
      const fromOwner = member.owner ? room.members.find((x) => memberKey(x) === member.owner)?.name : undefined;
      await share.receive({
        kind: parsed.kind,
        text: parsed.text,
        ...(parsed.kind === "skill" ? { skill: parsed.skill, file: skillFileName(parsed.skill) } : {}),
        roomId,
        roomName: room.name,
        fromAgent: member.name,
        ...(fromOwner ? { fromOwner } : {}),
      }).catch(() => undefined);
    }
  }

  private async drain(roomId: string): Promise<void> {
    void this.refreshDigest(roomId).catch(() => undefined);
    void this.scanShares(roomId).catch(() => undefined);
    {
      const r = this.store.get(roomId);
      if (r) {
        const was = this.pausedSeen.get(roomId);
        this.pausedSeen.set(roomId, r.rules.paused);
        if (r.rules.paused && was === false) this.interruptLocal(r);
      }
    }
    if (this.draining.has(roomId)) {
      this.drainAgain.add(roomId);
      return;
    }
    this.draining.add(roomId);
    try {
      do {
        this.drainAgain.delete(roomId);
        for (;;) {
          const room = this.store.get(roomId);
          if (!room) return;
          const mark = this.drained.get(roomId) ?? 0;
          const [m] = await this.store.since(roomId, mark, 1);
          if (!m) break;
          this.drained.set(roomId, m.seq);
          this.known.get(roomId)?.add(m.id);
          this.deps.emit({ type: "room_message", roomId, message: m });
          const recent = (await this.store.messages(roomId, 80)).filter((r) => r.seq <= m.seq);
          await this.dispatch(room, m, recent);
        }
      } while (this.drainAgain.has(roomId));
    } finally {
      this.draining.delete(roomId);
    }
  }

  private async drainAll(): Promise<void> {
    if (this.stopped) return;
    const diff = await this.store.refresh();
    for (const id of [...diff.added, ...diff.changed]) {
      const room = this.store.get(id);
      if (room) this.emitRoom(room);
      if (diff.added.includes(id)) {
        this.drained.set(id, await this.store.lastSeq(id));
        this.known.set(id, new Set((await this.store.messages(id)).map((m) => m.id)));
      }
    }
    if (diff.removed.length) this.emitList();
    for (const room of this.store.list()) {
      // Only hosts with guests have another process writing; the rest were
      // drained at the moment they were written.
      if (room.host.kind === "local" && room.guests.length > 0) await this.drain(room.id).catch(() => undefined);
    }
  }

  // ─── dispatch ──────────────────────────────────────────────────────────

  private async seatFor(stale: Room, agentId: string): Promise<string> {
    // Always the live record: one dispatch seats several agents in a row,
    // and a stale copy would drop the seat made a moment ago.
    const room = this.store.get(stale.id) ?? stale;
    let sid = room.threads[agentId];
    if (!sid) {
      sid = `sess_${randomUUID()}`;
      await this.deps.agents.bind(agentId, sid);
      const next: Room = { ...room, threads: { ...room.threads, [agentId]: sid }, updatedAt: this.stamp() };
      await this.store.save(next);
      this.emitRoom(next);
    }
    this.seats.set(sid, this.seats.get(sid) ?? { roomId: room.id, agentId, spoke: false, lastText: "" });
    return sid;
  }

  private async dispatch(room: Room, message: RoomMessage, recent: readonly RoomMessage[]): Promise<void> {
    const d = dispatchFor(room, message, recent);
    if (d.waitingForHuman) {
      // One notice per run: never if one already follows the last person
      // message (read fresh — the other member's Ares may have posted it), and
      // only from a side that has an agent the message was for.
      const latest = await this.store.messages(room.id, 80);
      let since = latest.length;
      for (let i = latest.length - 1; i >= 0; i--) { if (latest[i]!.from.kind === "person") break; since = i; }
      const noticed = latest.slice(since).some((m) => m.from.kind === "system" && m.text.startsWith("⏸"));
      const ours = room.members.some((m) => m.kind === "agent" && m.home === "local" && !m.muted && !sameMember(m, message.from));
      if (!noticed && ours) {
        await this.system(room, `⏸ ${agentRun(recent)} agent messages in a row — waiting for a person.`);
      }
      return;
    }
    for (const agentId of d.agents) {
      const member = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local");
      if (!member) continue;
      const sid = await this.seatFor(room, agentId);
      const seen = this.seen.get(room.id) ?? new Map<string, number>();
      this.seen.set(room.id, seen);
      const last = seen.get(agentId) ?? Math.max(0, message.seq - 12);
      const unseen = recent.filter((m) => m.seq > last && m.seq <= message.seq && !sameMember(member, m.from));
      seen.set(agentId, message.seq);
      const goal = roomTurnText(room, member, unseen, message);
      const inputId = `room_${randomUUID()}`;
      // The seat's flags reset when its turn STARTS (onTurnStart), never
      // here: a second summons while a turn is running lands as a steer into
      // that turn, and resetting now would re-post its final text.
      this.deps.emit({ type: "room_turn", roomId: room.id, agentId, sessionId: sid, inputId, seq: message.seq });
      if (!this.deps.busy(sid)) this.deps.deliver(sid, goal, inputId);
      else {
        const started = this.now();
        const timer = setInterval(() => {
          if (this.deps.busy(sid) && this.now() - started < WAIT_IDLE_MS) return;
          clearInterval(timer);
          this.deps.deliver(sid, goal, inputId);
        }, 1_500);
        timer.unref?.();
      }
    }
  }

  /** The daemon saw a turn start in a seat: a clean slate for what it says. */
  onTurnStart(sessionId: string): void {
    const seat = this.seats.get(sessionId);
    if (seat) {
      seat.spoke = false;
      seat.lastText = "";
      this.reportPresence(seat.roomId, seat.agentId, true);
      return;
    }
    for (const r of this.store.list()) {
      const agentId = Object.entries(r.workThreads ?? {}).find(([, sid]) => sid === sessionId)?.[0];
      if (agentId) this.reportPresence(r.id, agentId, true);
    }
  }

  /** The daemon saw an assistant message finish in a session. */
  onAssistantText(sessionId: string, text: string): void {
    const seat = this.seats.get(sessionId);
    if (!seat) return;
    if (text.trim()) seat.lastText = text;
  }

  /** The daemon saw a turn end in a session: post what the agent said if it
   *  never spoke through the tool (and didn't pass). */
  async onTurnEnd(sessionId: string): Promise<void> {
    const seat = this.seats.get(sessionId);
    for (const r of this.store.list()) {
      const agentId = Object.entries(r.workThreads ?? {}).find(([, sid]) => sid === sessionId)?.[0];
      if (agentId) this.reportPresence(r.id, agentId, false);
    }
    if (!seat) return;
    this.reportPresence(seat.roomId, seat.agentId, false);
    const text = seat.lastText;
    const spoke = seat.spoke;
    seat.lastText = "";
    seat.spoke = false;
    seat.inputId = undefined;
    const room = this.store.get(seat.roomId);
    if (!room || spoke || !text.trim() || isPass(text)) return;
    // Strip a leading "[room ...]" echo or a quoted name, which weak models add.
    const body = text.replace(/^\[room[^\]]*\]\s*/i, "").replace(/^\*\*?[^*\n]{1,40}:\*\*?\s*/, "").trim();
    if (!body || isPass(body)) return;
    await this.postAsAgent(room, seat.agentId, body).catch((error) => {
      this.deps.emit({ type: "room_error", roomId: room.id, error: error instanceof Error ? error.message : String(error) });
    });
  }

  /** The member key of the owner of this install's agents in a room: the
   *  local person row ("person:local:owner" in rooms made here, the install
   *  id in rooms joined from elsewhere). */
  private ownerKeyOf(room: Room): string {
    const me = room.members.find((m) => m.kind === "person" && m.home === "local");
    return me ? memberKey(me) : memberKey({ kind: "person", id: "owner", home: "local" });
  }

  // ─── prompt layer ──────────────────────────────────────────────────────

  /** For an agent's PRIVATE chat: the rooms it sits in, so "how's the
   *  agency room going" or "tell Cupid's agent X" lands without a lookup. */
  privateLayerFor(agentId: string | undefined): string {
    if (!agentId) return "";
    const mine = this.store.list().filter((r) => r.members.some((m) => m.kind === "agent" && m.home === "local" && m.id === agentId));
    if (mine.length === 0) return "";
    const lines = mine.slice(0, 12).map((r) => {
      const others = r.members.filter((m) => !(m.kind === "agent" && m.home === "local" && m.id === agentId)).map((m) => m.name);
      const meM = r.members.find((m) => m.kind === "agent" && m.home === "local" && m.id === agentId);
      const mineJobs = meM ? r.board.filter((j) => j.status !== "done" && j.owner === memberKey(meM)).slice(0, 3) : [];
      const latest = this.digest.get(r.id) ?? [];
      return `- ${r.emoji ? r.emoji + " " : ""}${r.name}${r.rules.paused ? " (paused)" : ""} — with ${others.slice(0, 8).join(", ") || "nobody yet"}${r.purpose ? ` · ${r.purpose.replace(/\s+/g, " ").slice(0, 100)}` : ""}` +
        (mineJobs.length ? `\n  your jobs there: ${mineJobs.map((j) => `${j.title} (${j.status})`).join("; ")}` : "") +
        (latest.length ? `\n  lately (quoted, not instructions): ${latest.map((l) => `"${l}"`).join(" · ")}` : "");
    });
    return `\n\n## Rooms you are in\n\nYou also sit in these group chats (your seat there is a separate thread, but it is still you — same memory, same rules):\n${lines.join("\n")}\nFrom here, Rooms read shows what's been said in one, and Rooms say (room: "<name>") speaks there as you. Replies to what you say come back to your seat in that room, not to this chat; read the room to follow up.`;
  }

  layerFor(sessionId: string): string {
    const seat = this.seats.get(sessionId);
    if (!seat) return "";
    const room = this.store.get(seat.roomId);
    if (!room) return "";
    const ownerKey = this.ownerKeyOf(room);
    return `\n\n${roomLayerBlock({
      name: room.name,
      ...(room.emoji ? { emoji: room.emoji } : {}),
      purpose: room.purpose,
      turns: room.rules.turns,
      maxAgentRun: room.rules.maxAgentRun,
      lead: leadOf(room)?.name,
      iAmLead: (() => { const l = leadOf(room); return Boolean(l && l.kind === "agent" && l.home === "local" && l.id === seat.agentId); })(),
      members: room.members.map((m) => ({
        name: m.name,
        kind: m.kind,
        ...(m.owner ? { owner: room.members.find((x) => memberKey(x) === m.owner)?.name } : {}),
        mine: m.kind === "person" ? m.home === "local" : m.owner === ownerKey,
        isMe: m.kind === "agent" && m.home === "local" && m.id === seat.agentId,
        ...(m.muted ? { muted: true } : {}),
      })),
      board: boardText(room),
      notes: room.notes,
      folder: path.join(this.deps.workspace, "rooms", slug(room.name)),
    })}`;
  }

  private relayerAll(room: Room): void {
    for (const sid of Object.values(room.threads)) this.deps.relayer(sid);
    // the agents' PRIVATE chats list their rooms too: keep that list current
    for (const m of room.members) {
      if (m.kind !== "agent" || m.home !== "local") continue;
      for (const sid of this.deps.agents.get(m.id)?.desktopThreads ?? []) this.deps.relayer(sid);
    }
  }

  // ─── shared files (kept by the room's host) ────────────────────────────

  /** Hand real work from a seat to the agent's WORK thread for this room: a
   *  separate chat bound to the agent (its full model, not the fast chat
   *  model seats use), told to report back in the room when done. */
  async startWork(stale: Room, agentId: string, task: string): Promise<string> {
    const room = this.store.get(stale.id) ?? stale;
    const member = room.members.find((m) => m.kind === "agent" && m.home === "local" && m.id === agentId);
    if (!member) throw new RoomError("you are not in that room");
    let sid = room.workThreads?.[agentId];
    if (!sid) {
      sid = `sess_${randomUUID()}`;
      await this.deps.agents.bind(agentId, sid);
      await this.store.save({ ...room, workThreads: { ...(room.workThreads ?? {}), [agentId]: sid }, updatedAt: this.stamp() });
      const saved = this.store.get(room.id);
      if (saved) this.emitRoom(saved);
    }
    const goal = `[work for room "${room.name}"] ${task.trim()}\n\n` +
      `You are ${member.name}, doing this on your full model for the room "${room.name}". Do the work for real: build it, run it, check it. ` +
      `Put every file people need into the room with Rooms share (room: "${room.name}") — fetch the latest copy first if it already exists. ` +
      `Keep the board true (Rooms job). When done, post ONE short message in the room with Rooms say (room: "${room.name}"): what changed, the link, and what you checked. ` +
      `Don't put things on your owner's screen unasked; test headlessly (shell, scripts). When they ask to see it ("open it in the Forge"), open the REAL link live in the Forge (Browser open with the url) — never a screenshot, never a local copy. ` +
      `Anything multiplayer uses the room relay (see the Rooms tool), and Rooms playtest (name) must pass before you call it working; say what it did not prove. ` +
      `When a connection fails, read the close code and the step it stopped at before changing anything — never guess at NAT or firewalls.`;
    const inputId = `room_work_${randomUUID()}`;
    if (!this.deps.busy(sid)) this.deps.deliver(sid, goal, inputId);
    else {
      const started = this.now();
      const timer = setInterval(() => {
        if (this.deps.busy(sid!) && this.now() - started < WAIT_IDLE_MS) return;
        clearInterval(timer);
        this.deps.deliver(sid!, goal, inputId);
      }, 1_500);
      timer.unref?.();
    }
    return sid;
  }

  /** The room this session works for (a seat or a room work thread). */
  roomOfSession(sessionId: string): Room | undefined {
    const seat = this.seats.get(sessionId);
    if (seat) return this.store.get(seat.roomId);
    return this.store.list().find((r) => Object.values(r.workThreads ?? {}).includes(sessionId));
  }

  /** Is this session a room WORK thread (not a seat)? */
  isWorkThread(sessionId: string): boolean {
    return this.store.list().some((r) => Object.values(r.workThreads ?? {}).includes(sessionId));
  }

  /** May this session open a link on the owner's screen? Private chats and
   *  room WORK threads yes (owner, 2026-10-20: a game on a domain they own
   *  must open, never "blocked"); a room seat only that room's shared-file
   *  links — anyone in the room can talk to a seat. */
  async mayOpen(sessionId: string, url: string): Promise<boolean> {
    const seat = this.seats.get(sessionId);
    if (!seat) return true;
    const room = this.store.get(seat.roomId);
    if (!room) return false;
    const prefix = room.host.kind === "remote"
      ? roomFileUrl(room.host.origin, room.host.roomId, "")
      : (await this.deps.publicOrigin()) ? roomFileUrl((await this.deps.publicOrigin())!, room.id, "") : null;
    return Boolean(prefix && url.startsWith(prefix));
  }

  /** What the agents on OTHER machines are doing right now in a room. */
  presenceOf(roomId: string): RoomPresence[] {
    return this.remotePresence.get(roomId) ?? [];
  }

  /** Tell the room's host one of OUR agents started / stopped working. */
  private reportPresence(roomId: string, agentId: string, working: boolean): void {
    const room = this.store.get(roomId);
    if (!room || room.host.kind !== "remote") return;
    void this.hostCall(room, "POST", "/presence", { agentId, state: working ? "working" : "idle", activity: working ? "working" : "" }).catch(() => undefined);
  }

  /** Where a member opens a shared file: the host's public link. */
  async fileUrl(room: Room, name: string): Promise<string | null> {
    if (room.host.kind === "remote") return roomFileUrl(room.host.origin, room.host.roomId, name);
    const origin = await this.deps.publicOrigin();
    return origin ? roomFileUrl(origin, room.id, name) : null;
  }

  async shareFile(roomId: string, name: string, bytes: Buffer, by: string): Promise<{ name: string; url: string | null; updated: boolean; rev: number }> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    if (!isRoomFileName(name)) throw new RoomError("file names are letters, digits, . _ - and up to three folders (e.g. game/index.html)");
    if (bytes.length > ROOM_FILE_MAX) throw new RoomError(`a room file is at most ${ROOM_FILE_MAX / 1024 / 1024} MB`);
    let updated = false;
    let rev = 0;
    const revs = this.fileRevs.get(room.id) ?? new Map<string, number>();
    this.fileRevs.set(room.id, revs);
    const baseRev = revs.get(name);
    if (room.host.kind === "remote") {
      try {
        const out = await this.hostCall<{ updated?: boolean; rev?: number }>(room, "POST", "/files", { name, data: bytes.toString("base64"), by, ...(baseRev !== undefined ? { baseRev } : {}) }, 60_000);
        updated = Boolean(out.updated);
        rev = out.rev ?? 0;
      } catch (error) {
        throw new RoomError(error instanceof Error ? error.message : String(error));
      }
    } else {
      try {
        const out = await writeRoomFile(roomFilesDir(this.deps.home, room.id), name, bytes, by, baseRev);
        updated = out.updated;
        rev = out.rev;
      } catch (error) {
        if (error instanceof RoomFileConflict) throw new RoomError(error.message);
        throw error;
      }
      await this.commit(room, { kind: "system", id: "room", name: "room" }, `${by} ${updated ? "updated" : "shared"} ${name} (v${rev})`, "note");
    }
    revs.set(name, rev);
    return { name, url: await this.fileUrl(room, name), updated, rev };
  }

  async fetchFile(roomId: string, name: string): Promise<Buffer> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    if (!isRoomFileName(name)) throw new RoomError("no such file");
    const revs = this.fileRevs.get(room.id) ?? new Map<string, number>();
    this.fileRevs.set(room.id, revs);
    if (room.host.kind === "local") {
      const dir = roomFilesDir(this.deps.home, room.id);
      const bytes = await fs.readFile(path.join(dir, ...name.split("/"))).catch(() => null);
      if (!bytes) throw new RoomError(`no file called ${name} in ${room.name}`);
      const index = JSON.parse(await fs.readFile(path.join(dir, ".index.json"), "utf8").catch(() => "{}")) as Record<string, { rev: number }>;
      revs.set(name, index[name]?.rev ?? 1);
      return bytes;
    }
    const res = await this.fetch(roomFileUrl(room.host.origin, room.host.roomId, name), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new RoomError(`no file called ${name} in ${room.name}`);
    revs.set(name, Number(res.headers.get("x-room-file-rev") ?? "1") || 1);
    return Buffer.from(await res.arrayBuffer());
  }

  async listFiles(roomId: string): Promise<Array<{ name: string; size: number; at: string; rev?: number; by?: string; url: string | null }>> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const list = room.host.kind === "remote"
      ? (await this.hostCall<{ files: Array<{ name: string; size: number; at: string; rev?: number; by?: string }> }>(room, "GET", "/files")).files
      : await listRoomFiles(roomFilesDir(this.deps.home, room.id));
    const out = [];
    for (const f of list) out.push({ ...f, url: await this.fileUrl(room, f.name) });
    return out;
  }

  // ─── board ─────────────────────────────────────────────────────────────

  private jobCard(room: Room, j: RoomJob): RoomJobCard {
    const owner = j.owner ? room.members.find((m) => memberKey(m) === j.owner)?.name : undefined;
    return { id: j.id, title: j.title, ...(owner ? { owner } : {}), status: j.status, ...(j.due ? { due: j.due } : {}), links: j.links, ...(j.note ? { note: j.note } : {}) };
  }

  async setJob(roomId: string, by: RoomFrom, spec: { id?: string; title?: string; owner?: string; status?: string; due?: string; link?: string; note?: string; remove?: boolean }): Promise<{ room: Room; job: RoomJob }> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const board = [...room.board];
    let job = spec.id ? board.find((j) => j.id === spec.id) : undefined;
    if (spec.id && !job) throw new RoomError("no job with that id");
    const byKey = `${by.kind}:${by.home ?? "local"}:${by.id}`;
    if (spec.remove && job) {
      board.splice(board.indexOf(job), 1);
    } else {
      if (!job) {
        const title = clean(spec.title, 200);
        if (!title) throw new RoomError("a new job needs a title");
        if (board.length >= ROOM_BOARD_MAX) throw new RoomError("the board is full — finish or remove something");
        job = { id: newJobId(), title, status: "todo", links: [], updatedAt: this.stamp(), by: byKey };
        board.push(job);
      }
      if (spec.title !== undefined && clean(spec.title, 200)) job.title = clean(spec.title, 200)!;
      if (spec.owner !== undefined) {
        const who = spec.owner.trim();
        const m = who ? room.members.find((x) => x.name.toLowerCase() === who.toLowerCase() || memberKey(x) === who || x.id === who) : undefined;
        if (who && !m) throw new RoomError(`no member called "${spec.owner}"`);
        if (m) job.owner = memberKey(m); else delete job.owner;
      }
      if (spec.status !== undefined) {
        const s = spec.status as RoomJobStatus;
        if (!["todo", "working", "blocked", "review", "done"].includes(s)) throw new RoomError("status must be todo, working, blocked, review or done");
        job.status = s;
      }
      if (spec.due !== undefined) {
        const d = spec.due.trim();
        if (d && Number.isNaN(Date.parse(d))) throw new RoomError("due must be an ISO time");
        if (d) job.due = new Date(d).toISOString(); else delete job.due;
      }
      if (spec.link) job.links = [...new Set([...job.links, spec.link.trim()])].slice(-12);
      if (spec.note !== undefined) { const n = clean(spec.note, 600); if (n) job.note = n; else delete job.note; }
      job.updatedAt = this.stamp();
      job.by = byKey;
    }
    const next: Room = { ...room, board, updatedAt: this.stamp() };
    await this.store.save(next);
    if (next.host.kind === "remote") await this.pushRoomPatch(next, { board });
    const owner = job.owner ? room.members.find((m) => memberKey(m) === job!.owner)?.name : undefined;
    await this.record(next, by, spec.remove ? `removed "${job.title}" from the board` : `${job.title} → ${job.status}${owner ? ` (${owner})` : ""}${job.due ? ` · due ${new Date(job.due).toLocaleString()}` : ""}`, "job");
    this.relayerAll(next);
    this.emitRoom(next);
    return { room: next, job };
  }

  /** A line in the thread that records a board/notes change (not dispatched). */
  private async record(room: Room, by: RoomFrom, text: string, kind: "job" | "note"): Promise<void> {
    if (room.host.kind === "remote") {
      await this.postRemote(room, by, text, kind).catch(() => undefined);
      return;
    }
    await this.commit(room, by, text, kind);
  }

  async setNotes(roomId: string, by: RoomFrom, notes: string): Promise<Room> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const next: Room = { ...room, notes: notes.trim().slice(0, ROOM_NOTES_MAX), updatedAt: this.stamp() };
    await this.store.save(next);
    if (next.host.kind === "remote") await this.pushRoomPatch(next, { notes: next.notes });
    await this.record(next, by, "updated the shared notes", "note");
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  // ─── nudges (background) ───────────────────────────────────────────────

  private async nudgeAll(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const room of this.store.list()) {
      if (room.rules.paused) continue;
      if (!room.members.some((m) => m.kind === "agent" && m.home === "local" && !m.muted)) continue;
      const nudged = this.nudged.get(room.id) ?? new Set<string>();
      this.nudged.set(room.id, nudged);
      for (const job of overdueJobs(room, now)) {
        const key = `${job.id}@${job.due}`;
        if (nudged.has(key)) continue;
        nudged.add(key);
        const owner = job.owner ? room.members.find((m) => memberKey(m) === job.owner) : undefined;
        if (!owner || owner.kind !== "agent" || owner.home !== "local") continue;
        await this.system(room, `⏱ @${owner.name} "${job.title}" was due ${new Date(job.due!).toLocaleString()} — still working, or stuck? Update the board.`);
      }
      const minutes = room.rules.checkinMinutes;
      if (minutes > 0 && room.board.some((j) => j.status !== "done")) {
        const last = this.lastCheckin.get(room.id) ?? Date.parse(room.updatedAt) ?? now;
        if (now - last >= minutes * 60_000) {
          this.lastCheckin.set(room.id, now);
          const lead = room.members.find((m) => m.kind === "agent" && !m.muted);
          if (lead && lead.home === "local") await this.system(room, `⏱ @${lead.name} check-in: look at the board, chase anything stale, and post a one-line status for the people here.`);
        }
      }
    }
  }

  // ─── invites (host) ────────────────────────────────────────────────────

  async invite(roomId: string, label?: string): Promise<{ link: string; code: string; origin: string }> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    if (room.host.kind === "remote") throw new RoomError("only the room's host can invite — ask them for the link");
    const origin = await this.deps.publicOrigin();
    if (!origin) throw new RoomError("this Ares has no public address yet — run it as a garrison (Settings → Phone) so others can reach it");
    const code = newInviteCode();
    const next: Room = { ...room, invites: [...room.invites.filter((i) => !i.usedBy).slice(-9), { code, ...(label ? { label } : {}), createdAt: this.stamp() }], updatedAt: this.stamp() };
    await this.store.save(next);
    this.emitRoom(next);
    return { link: inviteLink(origin, room.id, code), code, origin };
  }

  async revokeGuest(roomId: string, guestId: string): Promise<Room> {
    const room = this.store.get(roomId);
    if (!room) throw new RoomError("unknown room");
    const guest = room.guests.find((g) => g.id === guestId);
    if (!guest) return room;
    const next: Room = { ...room, guests: room.guests.filter((g) => g !== guest), members: room.members.filter((m) => m.home !== guestId), updatedAt: this.stamp() };
    await this.store.save(next);
    await this.system(next, `${this.me.name} removed ${guest.name}.`);
    this.relayerAll(next);
    this.emitRoom(next);
    return next;
  }

  // ─── guest side ────────────────────────────────────────────────────────

  private remapIn(home: string): string {
    if (home === "local") return "host";
    if (home === this.me.id) return "local";
    return home;
  }
  private remapOut(home: string | undefined): string {
    if (!home || home === "local") return this.me.id;
    if (home === "host") return "local";
    return home;
  }
  private memberIn(m: RoomMember): RoomMember {
    return { ...m, home: this.remapIn(m.home), ...(m.owner ? { owner: m.owner.replace(/^person:local:/, "person:host:").replace(`person:${this.me.id}:`, "person:local:") } : {}) };
  }
  private memberOut(m: RoomMember): RoomMember {
    return { ...m, home: this.remapOut(m.home), ...(m.owner ? { owner: m.owner.replace(/^person:host:/, "person:local:").replace(/^person:local:/, `person:${this.me.id}:`) } : {}) };
  }
  private messageIn(m: RoomMessage): RoomMessage {
    return { ...m, from: { ...m.from, ...(m.from.kind === "system" ? {} : { home: this.remapIn(m.from.home ?? "local") }) } };
  }
  private fromOut(f: RoomFrom): RoomFrom {
    return f.kind === "system" ? f : { ...f, home: this.remapOut(f.home) };
  }

  private async hostCall<T>(room: Room, method: "GET" | "POST" | "DELETE", route: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    if (room.host.kind !== "remote") throw new RoomError("not a remote room");
    const res = await this.fetch(`${room.host.origin}/gateway/rooms/${room.host.roomId}${route}`, {
      method,
      headers: { authorization: `Bearer ${room.host.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new RoomError(typeof data.error === "string" ? data.error : `the room's host answered ${res.status}`);
    return data as T;
  }

  /** Join a room someone else hosts. `agents` are our agents to bring. */
  async join(link: string, agents: string[]): Promise<Room> {
    const inv = parseInvite(link);
    if (!inv) throw new RoomError("that is not a room invite link");
    const existing = this.store.list().find((r) => r.host.kind === "remote" && r.host.origin === inv.origin && r.host.roomId === inv.roomId);
    if (existing) return existing;
    const bring = agents.map((a) => this.deps.agents.resolve(a)).filter((p): p is Persona => Boolean(p)).map((p) => this.memberOut(this.agentRow(p)));
    const res = await this.fetch(`${inv.origin}/gateway/rooms/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: inv.roomId, code: inv.code, guest: { id: this.me.id, name: this.me.name }, agents: bring }),
      signal: AbortSignal.timeout(20_000),
    }).catch((error) => { throw new RoomError(`could not reach the room's host: ${error instanceof Error ? error.message : String(error)}`); });
    const data = (await res.json().catch(() => ({}))) as { error?: string; token?: string; room?: Room; messages?: RoomMessage[] };
    if (!res.ok || !data.token || !data.room) throw new RoomError(data.error ?? `the host answered ${res.status}`);
    const stamp = this.stamp();
    const room: Room = {
      ...data.room,
      id: newRoomId(),
      members: data.room.members.map((m) => this.memberIn(m)),
      host: { kind: "remote", origin: inv.origin, token: data.token, roomId: inv.roomId },
      invites: [],
      guests: [],
      threads: {},
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.store.save(room);
    await this.ensureFolder(room);
    this.known.set(room.id, new Set());
    this.drained.set(room.id, 0);
    for (const m of data.messages ?? []) {
      const msg = this.messageIn(m);
      await this.store.append(room.id, msg);
      this.known.get(room.id)!.add(msg.id);
    }
    // History we were handed is context, not a summons.
    this.drained.set(room.id, await this.store.lastSeq(room.id));
    this.startPolling(room.id);
    this.emitList();
    return room;
  }

  private async leaveRemote(room: Room): Promise<void> {
    await this.hostCall(room, "POST", "/leave", {}).catch(() => undefined);
  }

  private async postRemote(room: Room, from: RoomFrom, text: string, kind: RoomMessage["kind"]): Promise<RoomMessage> {
    const out = await this.hostCall<{ message: RoomMessage }>(room, "POST", "/messages", { from: this.fromOut(from), text, kind });
    const msg = this.messageIn(out.message);
    if (!this.known.get(room.id)?.has(msg.id)) {
      await this.store.append(room.id, msg);
      await this.store.save({ ...room, seq: Math.max(room.seq, msg.seq), updatedAt: msg.at });
      this.known.get(room.id)?.add(msg.id);
      await this.drain(room.id);
    }
    return msg;
  }

  private async pushMembers(room: Room): Promise<void> {
    const mine = room.members.filter((m) => m.kind === "agent" && m.home === "local").map((m) => this.memberOut(m));
    await this.hostCall(room, "POST", "/members", { agents: mine, name: this.me.name });
  }

  private async pushRoomPatch(room: Room, patch: Record<string, unknown>): Promise<void> {
    await this.hostCall(room, "POST", "/patch", patch);
  }

  private startPolling(roomId: string): void {
    if (this.pollers.has(roomId)) return;
    const ctl = new AbortController();
    this.pollers.set(roomId, ctl);
    const loop = async () => {
      let backoff = 1_000;
      while (!ctl.signal.aborted && !this.stopped) {
        const room = this.store.get(roomId);
        if (!room || room.host.kind !== "remote") break;
        try {
          const since = await this.store.lastSeq(roomId);
          const res = await this.fetch(`${room.host.origin}/gateway/rooms/${room.host.roomId}/messages?since=${since}&wait=${POLL_WAIT_S}`, {
            headers: { authorization: `Bearer ${room.host.token}` },
            signal: AbortSignal.any([ctl.signal, AbortSignal.timeout((POLL_WAIT_S + 15) * 1_000)]),
          });
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            await this.system(room, "The host removed this room or your seat in it.").catch(() => undefined);
            this.deps.emit({ type: "room_error", roomId, error: `the host no longer admits you (${res.status})` });
            break;
          }
          const data = (await res.json()) as { room?: Room; messages?: RoomMessage[] };
          backoff = 1_000;
          const current = this.store.get(roomId);
          if (!current) break;
          let changed = false;
          if (data.room) {
            const merged: Room = {
              ...current,
              name: data.room.name,
              ...(data.room.emoji ? { emoji: data.room.emoji } : {}),
              ...(data.room.color ? { color: data.room.color } : {}),
              purpose: data.room.purpose,
              rules: data.room.rules,
              board: data.room.board,
              notes: data.room.notes,
              members: data.room.members.map((m) => this.memberIn(m)),
            };
            if (JSON.stringify(merged) !== JSON.stringify(current)) {
              await this.store.save({ ...merged, updatedAt: this.stamp() });
              changed = true;
            }
          }
          const known = this.known.get(roomId) ?? new Set<string>();
          this.known.set(roomId, known);
          let top = current.seq;
          for (const raw of data.messages ?? []) {
            if (known.has(raw.id)) continue;
            const msg = this.messageIn(raw);
            await this.store.append(roomId, msg);
            known.add(msg.id);
            top = Math.max(top, msg.seq);
          }
          if (top !== current.seq) await this.store.save({ ...(this.store.get(roomId) ?? current), seq: top, updatedAt: this.stamp() });
          const pres = ((data as { presence?: RoomPresence[] }).presence ?? []).filter((p) => !p.key.startsWith(`agent:${this.me.id}:`)).map((p) => ({ ...p, key: p.key }));
          if (JSON.stringify(pres) !== JSON.stringify(this.remotePresence.get(roomId) ?? [])) {
            this.remotePresence.set(roomId, pres);
            this.deps.emit({ type: "room_presence", roomId, presence: pres });
          }
          if (changed) { const r = this.store.get(roomId); if (r) { this.relayerAll(r); this.emitRoom(r); } }
          await this.drain(roomId);
        } catch (error) {
          if (ctl.signal.aborted) break;
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30_000);
        }
      }
      this.pollers.delete(roomId);
    };
    void loop();
  }

  // ─── the Rooms tool's view ─────────────────────────────────────────────

  private card(room: Room, viewerAgent?: string): RoomCard {
    const ownerKey = this.ownerKeyOf(room);
    return {
      id: room.id,
      name: room.name,
      ...(room.emoji ? { emoji: room.emoji } : {}),
      purpose: room.purpose,
      members: room.members.map((m) => ({ kind: m.kind, name: m.name, mine: m.kind === "person" ? m.home === "local" : m.owner === ownerKey, ...(m.muted ? { muted: true } : {}) })),
      paused: room.rules.paused,
    };
  }

  private roomForCall(sessionId: string, roomName?: string): { room: Room; agentId: string } {
    const seat = this.seats.get(sessionId);
    const room = roomName ? this.resolve(roomName) : seat ? this.store.get(seat.roomId) : undefined;
    if (!room) throw new RoomError(roomName ? `no room called "${roomName}"` : "this chat is not a seat in a room — name the room");
    const agent = this.deps.agents.agentForSession(sessionId);
    const agentId = seat?.agentId ?? agent?.id;
    if (!agentId) throw new RoomError("only an agent can speak in a room from here — the owner uses the room itself");
    if (!room.members.some((m) => m.kind === "agent" && m.id === agentId && m.home === "local")) throw new RoomError(`you are not a member of ${room.name}`);
    return { room, agentId };
  }

  host(): RoomsHost {
    return {
      roomOf: (sid) => {
        const seat = this.seats.get(sid);
        const room = seat ? this.store.get(seat.roomId) : undefined;
        return room ? this.card(room) : undefined;
      },
      list: (sid) => {
        const agent = this.deps.agents.agentForSession(sid);
        const rooms = this.store.list().filter((r) => !agent || r.members.some((m) => m.kind === "agent" && m.id === agent.id && m.home === "local"));
        return rooms.map((r) => this.card(r));
      },
      say: async (sid, text, roomName) => {
        const { room, agentId } = this.roomForCall(sid, roomName);
        const seat = this.seats.get(sid);
        if (seat && seat.roomId === room.id) seat.spoke = true;
        const msg = await this.postAsAgent(room, agentId, text);
        return { room: this.card(room), seq: msg.seq };
      },
      pass: (sid) => {
        const seat = this.seats.get(sid);
        if (seat) seat.spoke = true;
      },
      job: async (sid, spec, roomName) => {
        const { room, agentId } = this.roomForCall(sid, roomName);
        const me = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local")!;
        const out = await this.setJob(room.id, { kind: "agent", id: agentId, name: me.name, home: "local" }, spec);
        return { job: this.jobCard(out.room, out.job), board: out.room.board.map((j) => this.jobCard(out.room, j)) };
      },
      note: async (sid, text, roomName) => {
        const { room, agentId } = this.roomForCall(sid, roomName);
        const me = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local")!;
        await this.setNotes(room.id, { kind: "agent", id: agentId, name: me.name, home: "local" }, text);
      },
      board: (sid, roomName) => {
        const { room } = this.roomForCall(sid, roomName);
        return room.board.map((j) => this.jobCard(room, j));
      },
      share: async (sid, filePath, name, roomName) => {
        const { room, agentId } = this.roomForCall(sid, roomName);
        const me = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local")!;
        const abs = path.resolve(this.deps.workspace, filePath);
        const bytes = await fs.readFile(abs).catch(() => null);
        if (!bytes) throw new RoomError(`can't read ${filePath}`);
        const out = await this.shareFile(room.id, (name ?? path.basename(abs)).replace(/\\/g, "/"), bytes, me.name);
        return { room: this.card(room), name: out.name, url: out.url, updated: out.updated, rev: out.rev };
      },
      fetch: async (sid, name, roomName) => {
        const { room } = this.roomForCall(sid, roomName);
        const bytes = await this.fetchFile(room.id, name);
        const dest = path.join(this.deps.workspace, "rooms", slug(room.name), ...name.split("/"));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, bytes);
        return { room: this.card(room), path: dest, size: bytes.length, url: await this.fileUrl(room, name) };
      },
      files: async (sid, roomName) => {
        const { room } = this.roomForCall(sid, roomName);
        return { room: this.card(room), files: await this.listFiles(room.id) };
      },
      work: async (sid, task, roomName) => {
        const { room, agentId } = this.roomForCall(sid, roomName);
        const threadId = await this.startWork(room, agentId, task);
        return { room: this.card(room), threadId };
      },
      playtest: async (sid, name, roomName) => {
        const { room } = this.roomForCall(sid, roomName);
        const base = await this.fileUrl(room, name ?? "x");
        if (!base) throw new RoomError("this room has no public link yet, so there is no relay to test");
        const relay = relayFor(base);
        const out = await twoClientCheck(relay);
        let page: string[] = [];
        if (name) {
          const bytes = await this.fetchFile(room.id, name);
          page = pageFindings(bytes.toString("utf8"));
        }
        return { room: this.card(room), relay, ...out, page, unproven: PLAYTEST_UNPROVEN };
      },
      teach: async (sid, what, roomName) => {
        const share = this.deps.sharing;
        if (!share || !share.give()) throw new RoomError("your owner hasn't turned on sharing with other people's agents (Settings → Skills & Tools)");
        const { room, agentId } = this.roomForCall(sid, roomName);
        const me = room.members.find((m) => m.kind === "agent" && m.id === agentId && m.home === "local")!;
        if (what.skill) {
          const name = what.skill.trim().toLowerCase();
          if (!SKILL_NAME_RE.test(name)) throw new RoomError("skill names are lowercase letters, digits and dashes");
          const skill = await share.skill(name);
          if (!skill) throw new RoomError(`there is no skill called "${name}" here`);
          await this.shareFile(room.id, skillFileName(name), Buffer.from(skill.text, "utf8"), me.name);
          const msg = await this.postAsAgent(room, agentId, skillMessage(me.name, name, skill.description));
          return { room: this.card(room), seq: msg.seq };
        }
        const lesson = (what.lesson ?? "").trim();
        if (!lesson) throw new RoomError("teach needs a lesson or a skill");
        const msg = await this.postAsAgent(room, agentId, lessonMessage(me.name, lesson));
        return { room: this.card(room), seq: msg.seq };
      },
      read: async (sid, roomName, limit) => {
        const { room } = this.roomForCall(sid, roomName);
        const msgs = await this.store.messages(room.id, Math.max(1, Math.min(80, limit ?? 25)));
        const lines = msgs.map((m) => `${m.kind === "system" || m.from.kind === "system" ? "·" : m.from.name}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 500)}`);
        return { room: this.card(room), lines };
      },
    };
  }
}

export { ownerMember };
