// Rooms over HTTP — the door guests come in by (/gateway/rooms/…).
//
// Runs in the garrison (the process with the public origin). A room's host
// is the daemon on this machine; the two share <home>/rooms on disk. Guests
// never hold the owner's gateway token: an invite code gets them a room
// token of their own, scoped to that one room, hashed at rest. Everything a
// guest sends is stamped with THEIR install id, so a guest can only ever
// speak as themselves or as agents they brought.
//
//   POST /gateway/rooms/join                      {room, code, guest, agents}
//   GET  /gateway/rooms/<id>/messages?since&wait  long-poll
//   POST /gateway/rooms/<id>/messages             {from, text, kind}
//   POST /gateway/rooms/<id>/members              {agents}  (replace theirs)
//   POST /gateway/rooms/<id>/patch                {board?, notes?}
//   POST /gateway/rooms/<id>/leave

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ROOM_BOARD_MAX,
  ROOM_MEMBERS_MAX,
  ROOM_MESSAGE_MAX,
  ROOM_NOTES_MAX,
  RoomStore,
  isRoomId,
  newMessageId,
  newToken,
  normalizeRoom,
  tokenHash,
  type Room,
  type RoomFrom,
  type RoomGuest,
  type RoomMember,
  type RoomMessage,
} from "./rooms.js";

export interface RoomsApiOptions {
  home: string;
  log?: (line: string) => void;
  now?: () => number;
}

const MAX_WAIT_S = 30;

function guestView(room: Room): Record<string, unknown> {
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
    seq: room.seq,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
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

export function createRoomsApi(opts: RoomsApiOptions): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const store = new RoomStore(opts.home);
  const now = opts.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  let loaded = false;
  const fresh = async (id: string): Promise<Room | undefined> => {
    if (!loaded) { await store.load(); loaded = true; } else await store.refresh();
    return store.get(id);
  };
  const append = async (room: Room, from: RoomFrom, text: string, kind: RoomMessage["kind"]): Promise<RoomMessage> => {
    const message: RoomMessage = { seq: (await store.lastSeq(room.id)) + 1, id: newMessageId(), at: stamp(), from, text: text.slice(0, ROOM_MESSAGE_MAX), kind };
    await store.append(room.id, message);
    await store.save({ ...room, seq: message.seq, updatedAt: message.at });
    return message;
  };
  const system = (room: Room, text: string) => append(room, { kind: "system", id: "room", name: "room" }, text, "system");

  return async (req, res, url) => {
    if (!url.pathname.startsWith("/gateway/rooms")) return false;
    const json = (status: number, body: unknown): true => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return true;
    };
    try {
      // ── join ──
      if (url.pathname === "/gateway/rooms/join" && req.method === "POST") {
        const body = await readJson(req, 64 * 1024);
        const roomId = typeof body.room === "string" ? body.room : "";
        const code = typeof body.code === "string" ? body.code.trim() : "";
        const guestRaw = (body.guest && typeof body.guest === "object" ? body.guest : {}) as Record<string, unknown>;
        const guestId = typeof guestRaw.id === "string" && /^me_[a-z0-9]{6,32}$/.test(guestRaw.id) ? guestRaw.id : "";
        const guestName = typeof guestRaw.name === "string" ? guestRaw.name.trim().slice(0, 60) : "";
        if (!isRoomId(roomId) || !code || !guestId || !guestName) return json(400, { error: "room, code and guest {id, name} required" });
        const room = await fresh(roomId);
        if (!room || room.host.kind !== "local") return json(404, { error: "no such room" });
        const invite = room.invites.find((i) => i.code === code && !i.usedBy);
        const already = room.guests.find((g) => g.id === guestId);
        if (!invite && !already) return json(403, { error: "that invite is not open" });
        const token = newToken();
        const guest: RoomGuest = { id: guestId, name: guestName, tokenHash: tokenHash(token), joinedAt: already?.joinedAt ?? stamp(), lastSeenAt: stamp() };
        const theirs = Array.isArray(body.agents) ? body.agents : [];
        const agents: RoomMember[] = [];
        for (const raw of theirs.slice(0, 8)) {
          const m = normalizeRoom({ id: "room_000000000000", name: "x", members: [raw] })?.members[0];
          if (m && m.kind === "agent") agents.push({ ...m, home: guestId, owner: `person:${guestId}:${guestId}`, joinedAt: stamp() });
        }
        const person: RoomMember = { kind: "person", id: guestId, name: guestName, home: guestId, joinedAt: guest.joinedAt };
        const members = [...room.members.filter((m) => m.home !== guestId), person, ...agents];
        if (members.length > ROOM_MEMBERS_MAX) return json(409, { error: `the room is full (${ROOM_MEMBERS_MAX})` });
        const next: Room = {
          ...room,
          members,
          guests: [...room.guests.filter((g) => g.id !== guestId), guest],
          invites: room.invites.map((i) => (i === invite ? { ...i, usedBy: guestId } : i)),
          updatedAt: stamp(),
        };
        await store.save(next);
        await system(next, `${guestName} joined${agents.length ? ` with ${agents.map((a) => a.name).join(", ")}` : ""}.`);
        opts.log?.(`rooms: ${guestName} (${guestId}) joined ${room.name}`);
        const latest = (await fresh(roomId)) ?? next;
        return json(200, { token, room: guestView(latest), messages: await store.messages(roomId, 80) });
      }

      // ── everything else: /gateway/rooms/<id>/<verb>, room-token bearer ──
      const m = /^\/gateway\/rooms\/(room_[a-z0-9]+)\/(messages|members|patch|leave)\/?$/.exec(url.pathname);
      if (!m) return json(404, { error: "not found" });
      const roomId = m[1]!;
      const verb = m[2]!;
      const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      const room = await fresh(roomId);
      if (!room || room.host.kind !== "local") return json(404, { error: "no such room" });
      const guest = presented ? room.guests.find((g) => g.tokenHash === tokenHash(presented)) : undefined;
      if (!guest) return json(401, { error: "unauthorized" });

      if (verb === "messages" && req.method === "GET") {
        const since = Math.max(0, Number(url.searchParams.get("since") ?? "0") || 0);
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get("wait") ?? "0") || 0));
        const deadline = now() + wait * 1_000;
        let messages = await store.since(roomId, since, 200);
        let current = room;
        // A guest that hangs up (or a host shutting down) ends the wait at
        // once — a sleeping long-poll must never keep the process alive.
        let gone = req.destroyed;
        let wake: (() => void) | undefined;
        req.once("close", () => { gone = true; wake?.(); });
        while (messages.length === 0 && now() < deadline && !gone) {
          await new Promise<void>((r) => { wake = r; const t = setTimeout(r, 1_000); t.unref?.(); });
          wake = undefined;
          if (gone || req.destroyed) return true;
          current = (await fresh(roomId)) ?? current;
          if (!current.guests.some((g) => g.id === guest.id)) return json(403, { error: "you were removed from this room" });
          messages = await store.since(roomId, since, 200);
        }
        const latest = store.get(roomId) ?? current;
        const seen = { ...guest, lastSeenAt: stamp() };
        void store.save({ ...latest, guests: latest.guests.map((g) => (g.id === guest.id ? seen : g)) }).catch(() => undefined);
        return json(200, { room: guestView(latest), messages });
      }

      if (verb === "messages" && req.method === "POST") {
        const body = await readJson(req, 64 * 1024);
        const f = (body.from && typeof body.from === "object" ? body.from : {}) as Record<string, unknown>;
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return json(400, { error: "text required" });
        const kind = body.kind === "system" || body.kind === "job" || body.kind === "note" ? body.kind : "text";
        let from: RoomFrom;
        if (f.kind === "system") {
          from = { kind: "system", id: "room", name: "room" };
        } else if (f.kind === "person") {
          from = { kind: "person", id: guest.id, name: guest.name, home: guest.id };
        } else {
          const id = typeof f.id === "string" ? f.id : "";
          const member = room.members.find((x) => x.kind === "agent" && x.home === guest.id && x.id === id);
          if (!member) return json(403, { error: "that agent is not yours in this room" });
          if (member.muted) return json(403, { error: "that agent is muted" });
          from = { kind: "agent", id: member.id, name: member.name, home: guest.id };
        }
        if (room.rules.paused && from.kind === "agent") return json(409, { error: "the room is paused" });
        const message = await append(room, from, text, kind);
        return json(200, { message });
      }

      if (verb === "members" && req.method === "POST") {
        const body = await readJson(req, 64 * 1024);
        const theirs = Array.isArray(body.agents) ? body.agents : [];
        const agents: RoomMember[] = [];
        for (const raw of theirs.slice(0, 8)) {
          const mm = normalizeRoom({ id: "room_000000000000", name: "x", members: [raw] })?.members[0];
          if (mm && mm.kind === "agent") agents.push({ ...mm, home: guest.id, owner: `person:${guest.id}:${guest.id}` });
        }
        const before = room.members.filter((x) => x.kind === "agent" && x.home === guest.id);
        const keep = room.members.filter((x) => !(x.kind === "agent" && x.home === guest.id));
        const next: Room = { ...room, members: [...keep, ...agents].slice(0, ROOM_MEMBERS_MAX), updatedAt: stamp() };
        await store.save(next);
        const added = agents.filter((a) => !before.some((b) => b.id === a.id)).map((a) => a.name);
        const removed = before.filter((b) => !agents.some((a) => a.id === b.id)).map((b) => b.name);
        const muted = agents.filter((a) => a.muted && !before.find((b) => b.id === a.id)?.muted).map((a) => a.name);
        const unmuted = agents.filter((a) => !a.muted && before.find((b) => b.id === a.id)?.muted).map((a) => a.name);
        const notes = [
          added.length ? `added ${added.join(", ")}` : "",
          removed.length ? `recalled ${removed.join(", ")}` : "",
          muted.length ? `muted ${muted.join(", ")}` : "",
          unmuted.length ? `unmuted ${unmuted.join(", ")}` : "",
        ].filter(Boolean);
        if (notes.length) await system(next, `${guest.name} ${notes.join("; ")}.`);
        return json(200, { room: guestView(store.get(roomId) ?? next) });
      }

      if (verb === "patch" && req.method === "POST") {
        const body = await readJson(req, 256 * 1024);
        const next: Room = { ...room, updatedAt: stamp() };
        if (Array.isArray(body.board)) {
          const parsed = normalizeRoom({ id: roomId, name: room.name, board: body.board })?.board ?? [];
          next.board = parsed.slice(0, ROOM_BOARD_MAX);
        }
        if (typeof body.notes === "string") next.notes = body.notes.slice(0, ROOM_NOTES_MAX);
        await store.save(next);
        return json(200, { room: guestView(next) });
      }

      if (verb === "leave" && req.method === "POST") {
        const gone = room.members.filter((x) => x.home === guest.id);
        const next: Room = { ...room, members: room.members.filter((x) => x.home !== guest.id), guests: room.guests.filter((g) => g.id !== guest.id), updatedAt: stamp() };
        await store.save(next);
        if (gone.length) await system(next, `${guest.name} left.`);
        return json(200, { ok: true });
      }
      return json(405, { error: "method not allowed" });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      opts.log?.(`rooms api error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(status, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };
}
