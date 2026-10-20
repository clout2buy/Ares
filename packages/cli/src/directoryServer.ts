// The Ares people directory — "search people as a sort of discovery".
//
// Owner, 2026-10-19: "create a username, and you can look other people up,
// message them or group chat, or users' agents can talk to each other."
//
// A small, dependency-free HTTP service meant to run on the owner's box
// (doingbox, behind the cloudflared tunnel). It knows three things about a
// person: a username, where their Ares answers (their gateway origin, if
// they have one), and which agents they chose to show — and it HOSTS the
// rooms people open with each other, so nobody needs a tunnel, a server or
// a sign-up beyond a username (owner: "people shouldn't have to do anything
// else… we run our own system where people can message each other, our
// bots, agents, anything"). A room here is the same Room record every Ares
// uses (rooms.ts), served through the same guest door (phoneRooms.ts); every
// member is a guest of the server, and every agent still runs on its own
// owner's machine — the server keeps the thread, never a model.
//
//   POST /v1/claim                      {username, displayName, installId, origin?, agents?}
//                                       → {token, user}   (a username belongs to one installId)
//   PUT  /v1/me                Bearer   {displayName?, origin?, agents?, bio?} → {user}   (also presence)
//   GET  /v1/users?q=                   → {users}   (username / display name prefix + contains)
//   GET  /v1/users/:username            → {user}
//   POST /v1/users/:username/invite Bearer {kind:"room"|"dm", link, roomName, text?} → {item}
//   GET  /v1/inbox?since=<seq>&wait=<s> Bearer → {items, seq}   (long-poll)
//   POST /v1/inbox/:id/ack     Bearer   → {ok}
//   POST /v1/rooms             Bearer   {name, emoji?, purpose?, kind?, invite:[usernames], text?}
//                                       → {roomId, link}  (the room lives here; invitees get inbox items)
//   POST /v1/rooms/:id/invite  Bearer   {username, text?} → {item}   (a member invites one more)
//   /gateway/rooms/*                    the guest door (phoneRooms.ts): join, messages, members, patch, leave
//   GET  /v1/health
//
// Storage: <data>/users.json (atomic rewrite) + <data>/inbox/<username>.jsonl.
// Run: ARES_DIRECTORY_DATA=~/ares-directory ARES_DIRECTORY_PORT=7431 node dist/directoryServer.js

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRoomsApi } from "./phoneRooms.js";
import { DEFAULT_RULES, RoomStore, inviteLink, isRoomId, newInviteCode, newRoomId, type Room } from "./rooms.js";

export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const DISPLAY_MAX = 40;
export const BIO_MAX = 160;
export const AGENTS_MAX = 12;
export const SEARCH_MAX = 20;
export const INBOX_KEEP = 200;
const ONLINE_MS = 3 * 60_000;
const MAX_WAIT_S = 30;

export interface DirectoryAgent {
  name: string;
  emoji?: string;
  color?: string;
  role?: string;
}

export interface DirectoryUser {
  username: string;
  displayName: string;
  installId: string;
  tokenHash: string;
  origin?: string;
  bio?: string;
  /** Their face: one emoji on a colour (no photos — nothing identifying). */
  emoji?: string;
  color?: string;
  agents: DirectoryAgent[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

/** What a lookup returns — no install id, no token, no raw origin. */
export interface DirectoryProfile {
  username: string;
  displayName: string;
  bio?: string;
  emoji?: string;
  color?: string;
  agents: DirectoryAgent[];
  online: boolean;
  /** They have somewhere a room can be hosted (a public gateway). */
  reachable: boolean;
  lastSeenAt: string;
}

export interface InboxItem {
  seq: number;
  id: string;
  at: string;
  from: { username: string; displayName: string };
  kind: "room" | "dm";
  link: string;
  roomName: string;
  text?: string;
  acked?: boolean;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function toProfile(u: DirectoryUser, now = Date.now()): DirectoryProfile {
  return {
    username: u.username,
    displayName: u.displayName,
    ...(u.bio ? { bio: u.bio } : {}),
    ...(u.emoji ? { emoji: u.emoji } : {}),
    ...(u.color ? { color: u.color } : {}),
    agents: u.agents,
    online: now - Date.parse(u.lastSeenAt) < ONLINE_MS,
    reachable: Boolean(u.origin),
    lastSeenAt: u.lastSeenAt,
  };
}

function cleanAgents(raw: unknown): DirectoryAgent[] {
  if (!Array.isArray(raw)) return [];
  const out: DirectoryAgent[] = [];
  for (const a of raw.slice(0, AGENTS_MAX)) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 40) : "";
    if (!name) continue;
    out.push({
      name,
      ...(typeof r.emoji === "string" && r.emoji ? { emoji: r.emoji.slice(0, 16) } : {}),
      ...(typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? { color: r.color } : {}),
      ...(typeof r.role === "string" && r.role.trim() ? { role: r.role.trim().slice(0, 120) } : {}),
    });
  }
  return out;
}

function cleanOrigin(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/i.test(t)) return undefined;
  return t.slice(0, 200);
}

export class DirectoryStore {
  private users = new Map<string, DirectoryUser>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {}

  private usersFile(): string {
    return path.join(this.dataDir, "users.json");
  }
  private inboxFile(username: string): string {
    return path.join(this.dataDir, "inbox", `${username}.jsonl`);
  }

  async load(): Promise<void> {
    this.users.clear();
    try {
      const raw = JSON.parse(await fs.readFile(this.usersFile(), "utf8")) as Record<string, DirectoryUser>;
      for (const [k, v] of Object.entries(raw)) if (v && typeof v === "object" && USERNAME_RE.test(k)) this.users.set(k, v);
    } catch {
      // first run
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot = Object.fromEntries(this.users);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.usersFile()}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      await fs.rename(tmp, this.usersFile());
    });
    await this.writing;
  }

  get(username: string): DirectoryUser | undefined {
    return this.users.get(username);
  }

  byToken(token: string): DirectoryUser | undefined {
    const h = tokenHash(token);
    for (const u of this.users.values()) if (u.tokenHash === h) return u;
    return undefined;
  }

  /** Claim (or re-claim from the same install) a username. */
  async claim(spec: { username: string; displayName: string; installId: string; origin?: unknown; agents?: unknown; bio?: unknown }): Promise<{ token: string; user: DirectoryUser } | { error: string; status: number }> {
    if (!this.loaded) await this.load();
    const username = spec.username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return { error: "a username is 3–24 letters, digits or _", status: 400 };
    const displayName = spec.displayName.trim().slice(0, DISPLAY_MAX) || username;
    if (!/^me_[a-z0-9]{6,32}$/.test(spec.installId)) return { error: "installId required", status: 400 };
    const existing = this.users.get(username);
    if (existing && existing.installId !== spec.installId) return { error: "that username is taken", status: 409 };
    // One username per install: claiming a new one releases the old.
    for (const [k, u] of this.users) if (u.installId === spec.installId && k !== username) this.users.delete(k);
    const token = randomBytes(24).toString("base64url");
    const now = new Date().toISOString();
    const user: DirectoryUser = {
      username,
      displayName,
      installId: spec.installId,
      tokenHash: tokenHash(token),
      ...(cleanOrigin(spec.origin) ? { origin: cleanOrigin(spec.origin) } : existing?.origin ? { origin: existing.origin } : {}),
      ...(typeof spec.bio === "string" && spec.bio.trim() ? { bio: spec.bio.trim().slice(0, BIO_MAX) } : existing?.bio ? { bio: existing.bio } : {}),
      agents: spec.agents !== undefined ? cleanAgents(spec.agents) : existing?.agents ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.users.set(username, user);
    await this.persist();
    return { token, user };
  }

  async update(user: DirectoryUser, patch: { displayName?: unknown; origin?: unknown; agents?: unknown; bio?: unknown; emoji?: unknown; color?: unknown }): Promise<DirectoryUser> {
    const now = new Date().toISOString();
    const next: DirectoryUser = { ...user, updatedAt: now, lastSeenAt: now };
    if (typeof patch.displayName === "string" && patch.displayName.trim()) next.displayName = patch.displayName.trim().slice(0, DISPLAY_MAX);
    if (patch.origin !== undefined) { const o = cleanOrigin(patch.origin); if (o) next.origin = o; else delete next.origin; }
    if (patch.agents !== undefined) next.agents = cleanAgents(patch.agents);
    if (patch.bio !== undefined) { const b = typeof patch.bio === "string" ? patch.bio.trim().slice(0, BIO_MAX) : ""; if (b) next.bio = b; else delete next.bio; }
    if (patch.emoji !== undefined) { const e = typeof patch.emoji === "string" ? [...patch.emoji.trim()].slice(0, 4).join("") : ""; if (e && !/[<>"'&]/.test(e)) next.emoji = e; else delete next.emoji; }
    if (patch.color !== undefined) { if (typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color)) next.color = patch.color; else delete next.color; }
    this.users.set(user.username, next);
    await this.persist();
    return next;
  }

  async touch(user: DirectoryUser): Promise<void> {
    user.lastSeenAt = new Date().toISOString();
    this.users.set(user.username, user);
    await this.persist();
  }

  search(q: string, now = Date.now()): DirectoryProfile[] {
    const needle = q.trim().toLowerCase().replace(/^@/, "");
    const all = [...this.users.values()];
    const scored = all
      .map((u) => {
        const un = u.username;
        const dn = u.displayName.toLowerCase();
        let score = 0;
        if (!needle) score = 1;
        else if (un === needle) score = 100;
        else if (un.startsWith(needle)) score = 80;
        else if (dn.startsWith(needle)) score = 70;
        else if (un.includes(needle) || dn.includes(needle)) score = 40;
        else if (u.agents.some((a) => a.name.toLowerCase().includes(needle))) score = 20;
        return { u, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.u.username.length - b.u.username.length || Date.parse(b.u.lastSeenAt) - Date.parse(a.u.lastSeenAt));
    return scored.slice(0, SEARCH_MAX).map((x) => toProfile(x.u, now));
  }

  async inbox(username: string): Promise<InboxItem[]> {
    const text = await fs.readFile(this.inboxFile(username), "utf8").catch(() => "");
    const out: InboxItem[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as InboxItem); } catch { /* torn line */ }
    }
    // acks are appended as {ack:id}; fold them
    const acked = new Set(out.filter((i) => (i as unknown as { ack?: string }).ack).map((i) => (i as unknown as { ack: string }).ack));
    return out.filter((i) => i.id && !(i as unknown as { ack?: string }).ack).map((i) => (acked.has(i.id) ? { ...i, acked: true } : i)).slice(-INBOX_KEEP);
  }

  async deliver(to: string, item: Omit<InboxItem, "seq" | "id" | "at">): Promise<InboxItem> {
    const existing = await this.inbox(to);
    const full: InboxItem = { seq: (existing.at(-1)?.seq ?? 0) + 1, id: `inv_${randomBytes(6).toString("hex")}`, at: new Date().toISOString(), ...item };
    await fs.mkdir(path.join(this.dataDir, "inbox"), { recursive: true });
    await fs.appendFile(this.inboxFile(to), JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  async ack(username: string, id: string): Promise<void> {
    await fs.appendFile(this.inboxFile(username), JSON.stringify({ ack: id }) + "\n", "utf8");
  }
}

async function readJson(req: IncomingMessage, max = 32 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** A tiny per-IP token bucket so one install cannot hammer claims/search. */
class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  admit(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export function createDirectoryHandler(store: DirectoryStore, opts: { log?: (line: string) => void; now?: () => number; publicUrl?: string } = {}) {
  const now = opts.now ?? Date.now;
  const limiter = new Limiter(120, 60_000);
  const claims = new Limiter(10, 10 * 60_000);
  // Rooms hosted here: the same store + guest door every Ares runs.
  const rooms = new RoomStore(store.dataDir);
  let roomsLoaded = false;
  const roomsApi = createRoomsApi({ home: store.dataDir, log: opts.log, now });
  const stamp = () => new Date(now()).toISOString();
  /** Where guests reach this server, for the links it mints. */
  const selfOrigin = (req: IncomingMessage): string => {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
    const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host || "localhost";
    return `${proto}://${host}`;
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://directory");
    if (url.pathname.startsWith("/gateway/rooms")) {
      if (await roomsApi(req, res, url)) return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const ip = (req.headers["cf-connecting-ip"] as string | undefined) ?? req.socket.remoteAddress ?? "?";
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET,POST,PUT,OPTIONS" }); res.end(); return; }
      if (url.pathname === "/v1/health") return json(200, { ok: true, users: store.search("").length });
      if (!limiter.admit(ip, now())) return json(429, { error: "slow down" });
      const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const me = presented ? store.byToken(presented) : undefined;

      if (url.pathname === "/v1/claim" && req.method === "POST") {
        if (!claims.admit(ip, now())) return json(429, { error: "too many claims — try later" });
        const b = await readJson(req);
        const out = await store.claim({
          username: typeof b.username === "string" ? b.username : "",
          displayName: typeof b.displayName === "string" ? b.displayName : "",
          installId: typeof b.installId === "string" ? b.installId : "",
          origin: b.origin,
          agents: b.agents,
          bio: b.bio,
        });
        if ("error" in out) return json(out.status, { error: out.error });
        opts.log?.(`claim @${out.user.username} (${out.user.installId})`);
        return json(200, { token: out.token, user: toProfile(out.user, now()) });
      }
      if (url.pathname === "/v1/users" && req.method === "GET") {
        return json(200, { users: store.search(url.searchParams.get("q") ?? "", now()) });
      }
      const userMatch = /^\/v1\/users\/([a-z0-9_]{3,24})(\/invite)?$/.exec(url.pathname);
      if (userMatch && !userMatch[2] && req.method === "GET") {
        const u = store.get(userMatch[1]!);
        return u ? json(200, { user: toProfile(u, now()) }) : json(404, { error: "no such user" });
      }
      // ── everything below needs a claimed username ──
      if (!me) return json(401, { error: "claim a username first" });
      if (url.pathname === "/v1/me" && req.method === "PUT") {
        const b = await readJson(req);
        const next = await store.update(me, { displayName: b.displayName, origin: b.origin, agents: b.agents, bio: b.bio, emoji: b.emoji, color: b.color });
        return json(200, { user: toProfile(next, now()), username: next.username });
      }
      if (url.pathname === "/v1/me" && req.method === "GET") {
        await store.touch(me);
        return json(200, { user: toProfile(me, now()), username: me.username });
      }
      if (userMatch && userMatch[2] && req.method === "POST") {
        const target = store.get(userMatch[1]!);
        if (!target) return json(404, { error: "no such user" });
        if (target.username === me.username) return json(400, { error: "that is you" });
        const b = await readJson(req);
        const link = typeof b.link === "string" ? b.link.trim() : "";
        if (!/^ares:\/\/room\?/.test(link) || link.length > 600) return json(400, { error: "a room invite link is required" });
        const kind = b.kind === "dm" ? "dm" : "room";
        const item = await store.deliver(target.username, {
          from: { username: me.username, displayName: me.displayName },
          kind,
          link,
          roomName: typeof b.roomName === "string" ? b.roomName.trim().slice(0, 40) || "a room" : "a room",
          ...(typeof b.text === "string" && b.text.trim() ? { text: b.text.trim().slice(0, 300) } : {}),
        });
        opts.log?.(`invite @${me.username} → @${target.username} (${kind})`);
        return json(200, { item: { ...item, from: item.from } });
      }
      if (url.pathname === "/v1/inbox" && req.method === "GET") {
        const since = Math.max(0, Number(url.searchParams.get("since") ?? "0") || 0);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
        const deadline = now() + wait * 1_000;
        let gone = req.destroyed;
        let wake: (() => void) | undefined;
        req.once("close", () => { gone = true; wake?.(); });
        let items = (await store.inbox(me.username)).filter((i) => i.seq > since);
        while (items.length === 0 && now() < deadline && !gone) {
          await new Promise<void>((r) => { wake = r; const t = setTimeout(r, 1_500); t.unref?.(); });
          wake = undefined;
          if (gone) return;
          items = (await store.inbox(me.username)).filter((i) => i.seq > since);
        }
        await store.touch(me);
        const all = await store.inbox(me.username);
        return json(200, { items, seq: all.at(-1)?.seq ?? 0 });
      }
      const ackMatch = /^\/v1\/inbox\/(inv_[a-f0-9]+)\/ack$/.exec(url.pathname);
      if (ackMatch && req.method === "POST") {
        await store.ack(me.username, ackMatch[1]!);
        return json(200, { ok: true });
      }
      // ── rooms hosted here ──
      if (!roomsLoaded) { await rooms.load(); roomsLoaded = true; } else await rooms.refresh();
      const inviteTo = async (room: Room, target: DirectoryUser, text?: string, kind: "room" | "dm" = "room"): Promise<{ room: Room; item: InboxItem }> => {
        const code = newInviteCode();
        const next: Room = { ...room, invites: [...room.invites.filter((i) => !i.usedBy).slice(-40), { code, label: `@${target.username}`, createdAt: stamp() }], updatedAt: stamp() };
        await rooms.save(next);
        const item = await store.deliver(target.username, {
          from: { username: me.username, displayName: me.displayName },
          kind,
          link: inviteLink(selfOrigin(req), room.id, code),
          roomName: room.name,
          ...(text ? { text } : {}),
        });
        return { room: next, item };
      };
      if (url.pathname === "/v1/rooms" && req.method === "POST") {
        const b = await readJson(req);
        const name = typeof b.name === "string" ? b.name.trim().slice(0, 40) : "";
        if (!name) return json(400, { error: "name required" });
        const kind = b.kind === "dm" ? "dm" : "room";
        const names = Array.isArray(b.invite) ? b.invite.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^@/, "").toLowerCase()).slice(0, 23) : [];
        const targets = names.map((n) => store.get(n)).filter((u): u is DirectoryUser => Boolean(u) && u!.username !== me.username);
        if (names.length && targets.length === 0) return json(404, { error: "nobody by that name" });
        let room: Room = {
          id: newRoomId(),
          name,
          ...(typeof b.emoji === "string" && b.emoji.trim() ? { emoji: b.emoji.trim().slice(0, 16) } : {}),
          purpose: typeof b.purpose === "string" ? b.purpose.trim().slice(0, 4000) : "",
          members: [],
          rules: { ...DEFAULT_RULES },
          board: [],
          notes: "",
          host: { kind: "local" },
          invites: [],
          guests: [],
          threads: {},
          seq: 0,
          createdAt: stamp(),
          updatedAt: stamp(),
        };
        await rooms.save(room);
        for (const t of targets) room = (await inviteTo(room, t, typeof b.text === "string" ? b.text.trim().slice(0, 300) : undefined, kind)).room;
        // the creator's own way in
        const code = newInviteCode();
        room = { ...room, invites: [...room.invites, { code, label: `@${me.username}`, createdAt: stamp() }] };
        await rooms.save(room);
        opts.log?.(`room ${room.id} "${room.name}" by @${me.username} → ${targets.map((t) => "@" + t.username).join(", ") || "(nobody yet)"}`);
        return json(200, { roomId: room.id, link: inviteLink(selfOrigin(req), room.id, code), invited: targets.map((t) => t.username) });
      }
      const roomInvite = /^\/v1\/rooms\/(room_[a-z0-9]+)\/invite$/.exec(url.pathname);
      if (roomInvite && req.method === "POST") {
        const room = rooms.get(roomInvite[1]!);
        if (!room || !isRoomId(room.id)) return json(404, { error: "no such room" });
        const mine = room.guests.some((g) => g.id === me.installId) || room.invites.some((i) => i.label === `@${me.username}`);
        if (!mine) return json(403, { error: "you are not in that room" });
        const b = await readJson(req);
        const target = typeof b.username === "string" ? store.get(b.username.replace(/^@/, "").toLowerCase()) : undefined;
        if (!target) return json(404, { error: "no such user" });
        if (target.username === me.username) return json(400, { error: "that is you" });
        const out = await inviteTo(room, target, typeof b.text === "string" ? b.text.trim().slice(0, 300) : undefined);
        return json(200, { item: out.item });
      }
      return json(404, { error: "not found" });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      opts.log?.(`directory error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(status, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

export async function serveDirectory(opts: { dataDir: string; port: number; host?: string; publicUrl?: string; log?: (line: string) => void }): Promise<{ close: () => Promise<void>; port: number }> {
  const store = new DirectoryStore(opts.dataDir);
  await store.load();
  const handler = createDirectoryHandler(store, { log: opts.log, publicUrl: opts.publicUrl });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  opts.log?.(`ares directory listening on ${opts.host ?? "127.0.0.1"}:${port} (data ${opts.dataDir})`);
  return {
    port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// `node dist/directoryServer.js` — the deployable entry (docs/DIRECTORY.md).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = process.env.ARES_DIRECTORY_DATA ? path.resolve(process.env.ARES_DIRECTORY_DATA.replace(/^~(?=$|\/)/, os.homedir())) : path.join(os.homedir(), "ares-directory");
  const port = Number(process.env.ARES_DIRECTORY_PORT ?? 7431);
  const host = process.env.ARES_DIRECTORY_HOST ?? "127.0.0.1";
  const publicUrl = process.env.ARES_DIRECTORY_PUBLIC_URL;
  void serveDirectory({ dataDir, port, host, ...(publicUrl ? { publicUrl } : {}), log: (line) => process.stdout.write(`[directory] ${line}\n`) }).catch((error) => {
    process.stderr.write(`[directory] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
