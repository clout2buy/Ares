// The room's game relay — pair-by-code WebSockets for the multiplayer things
// agents build into a room (/gateway/rooms/<id>/relay/<CODE>).
//
// Owner, 2026-10-20 (room "Doing & Cupid"): FaxWare's stick-fight game took
// five revisions and a human debug pass. PeerJS peer-to-peer hung on
// "connecting"; the hand-rolled relay it then put on the box wanted a token
// the page never sent (every socket closed 4401); and the real bug was that
// it forwarded `ws` Buffers raw, so they went out as BINARY frames — the
// browser got a Blob, `JSON.parse(ev.data)` threw into nothing, and the guest
// sat on a grey screen while the host saw "guest joined". Nobody had run two
// real clients against it.
//
// So the room's own gateway serves the relay and agents stop hand-rolling
// them. A page shared into the room (…/files/game.html) reaches it on the
// same host, so nothing else to deploy, no tunnel, no token: the room id in
// the path is the capability, exactly like the file links (unguessable,
// handed only to members). Rules the stick-fight bug taught:
//   - every frame out is TEXT, verbatim (a page's JSON.parse always works);
//   - a BINARY frame in is refused with close 1003 and a reason that says
//     "send JSON as text", so the mistake is loud on the sender's side;
//   - everything that goes wrong closes with a code AND a reason a page can
//     show (4404 no such room, 4409 game full, 1009 too big, 4429 too fast);
//   - the relay speaks first: {"relay":"hello","you","host","peers"}, then
//     {"relay":"join"|"leave",...} — the page knows it is connected, who the
//     host is (the oldest peer; the next oldest when the host leaves) and
//     when the other side is gone, without inventing a handshake.
// Messages between peers are relayed to every OTHER peer on the code, as-is.
//
// Dependency-free on purpose: the directory runs on doingbox from three dist
// files with no node_modules (docs/DIRECTORY.md), so the directory speaks the
// WebSocket wire format itself (acceptUpgrade below). The garrison already
// has `ws`; its sockets have the same shape (send/close/ping/terminate +
// message/pong/close events) and go straight into accept().
//
// Tuning: ARES_ROOM_RELAY_MAX_BYTES (16384 per message),
// ARES_ROOM_RELAY_PEERS (8 per code), ARES_ROOM_RELAY_CODES (32 live codes per
// room), ARES_ROOM_RELAY_RATE (120 messages per second per peer).

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { RoomStore } from "./rooms.js";

/** /gateway/rooms/<roomId>/relay/<CODE> — a code is 4-12 letters or digits. */
export const ROOM_RELAY_RE = /^\/gateway\/rooms\/(room_[a-z0-9]+)\/relay\/([A-Za-z0-9]{4,12})$/;

/** The relay a room's shared page reaches, from that page's own link (or the
 *  room's file base). ws(s) follows http(s). */
export function roomRelayUrl(fileUrl: string, code: string): string {
  const u = new URL(fileUrl);
  const base = u.pathname.replace(/\/files(?:\/.*)?$/, "");
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}${base}/relay/${code.toUpperCase()}`;
}

/** What the relay needs from a socket — `ws`'s WebSocket and MiniSocket both. */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: "message", fn: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "pong" | "close", fn: () => void): unknown;
}

export interface RoomRelayOptions {
  /** Where rooms live: only rooms THIS server hosts get a relay. */
  home: string;
  log?: (line: string) => void;
  maxBytes?: number;
  maxPeers?: number;
  maxCodes?: number;
  /** Messages per second per peer. */
  rate?: number;
  /** Keep-alive ping cadence (tunnels drop idle sockets around 100 s). */
  pingMs?: number;
}

interface Peer { id: string; socket: RelaySocket; alive: boolean; window: number; count: number; group: Peer[] }

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export interface RoomRelay {
  /** Is this path a relay path (so the server routes it here)? */
  handles(pathname: string): boolean;
  /** Take an upgraded socket for `pathname`. */
  accept(socket: RelaySocket, pathname: string): Promise<void>;
  /** A raw HTTP upgrade (servers without `ws`): handshake, then accept. */
  acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Live codes per room, for tests and logs. */
  stats(): Record<string, Record<string, number>>;
  close(): void;
}

export function createRoomRelay(opts: RoomRelayOptions): RoomRelay {
  const maxBytes = opts.maxBytes ?? envInt("ARES_ROOM_RELAY_MAX_BYTES", 16_384);
  const maxPeers = opts.maxPeers ?? envInt("ARES_ROOM_RELAY_PEERS", 8);
  const maxCodes = opts.maxCodes ?? envInt("ARES_ROOM_RELAY_CODES", 32);
  const rate = opts.rate ?? envInt("ARES_ROOM_RELAY_RATE", 120);
  const store = new RoomStore(opts.home);
  let loaded = false;
  /** roomId → CODE → peers, oldest first (the first is the host). */
  const channels = new Map<string, Map<string, Peer[]>>();
  let nextId = 0;

  const hostedHere = async (roomId: string): Promise<boolean> => {
    if (!loaded) { await store.load(); loaded = true; } else await store.refresh();
    return store.get(roomId)?.host.kind === "local";
  };
  const roster = (peers: Peer[]) => ({ host: peers[0]?.id ?? null, peers: peers.map((p) => p.id) });
  const tell = (peer: Peer, body: Record<string, unknown>) => { try { peer.socket.send(JSON.stringify(body)); } catch { /* closing */ } };

  const timer = setInterval(() => {
    for (const codes of channels.values()) for (const peers of codes.values()) for (const p of peers) {
      if (!p.alive) { p.socket.terminate(); continue; }
      p.alive = false;
      try { p.socket.ping(); } catch { /* gone */ }
    }
  }, opts.pingMs ?? 25_000);
  timer.unref?.();

  const relay: RoomRelay = {
    handles: (pathname) => ROOM_RELAY_RE.test(pathname),

    async accept(socket, pathname) {
      const m = ROOM_RELAY_RE.exec(pathname);
      if (!m) { socket.close(4400, "bad relay path: /gateway/rooms/<room>/relay/<CODE>"); return; }
      const roomId = m[1]!;
      const code = m[2]!.toUpperCase();
      // Hold what arrives while the room is checked, so a page that sends
      // the moment it opens loses nothing.
      const early: Array<[Buffer | ArrayBuffer | Buffer[], boolean]> = [];
      let peer: Peer | undefined;
      let closed = false;
      socket.on("message", (data, isBinary) => { if (peer) onMessage(peer, data, isBinary); else early.push([data, isBinary]); });
      socket.on("pong", () => { if (peer) peer.alive = true; });
      socket.on("close", () => { closed = true; if (peer) leave(roomId, code, peer); });
      const ok = await hostedHere(roomId).catch(() => false);
      if (closed) return;
      if (!ok) { socket.close(4404, "no such room on this server"); return; }
      const codes = channels.get(roomId) ?? new Map<string, Peer[]>();
      const peers = codes.get(code) ?? [];
      if (!peers.length && codes.size >= maxCodes) { socket.close(4409, `this room already has ${maxCodes} games running`); return; }
      if (peers.length >= maxPeers) { socket.close(4409, `game ${code} is full (${maxPeers} players)`); return; }
      peer = { id: `p${++nextId}`, socket, alive: true, window: 0, count: 0, group: peers };
      peers.push(peer);
      codes.set(code, peers);
      channels.set(roomId, codes);
      tell(peer, { relay: "hello", you: peer.id, code, ...roster(peers), maxBytes });
      for (const p of peers) if (p !== peer) tell(p, { relay: "join", id: peer.id, ...roster(peers) });
      for (const [data, isBinary] of early.splice(0)) onMessage(peer, data, isBinary);
    },

    acceptUpgrade(req, socket, head) {
      const pathname = (req.url ?? "/").split("?")[0]!;
      const key = req.headers["sec-websocket-key"];
      if (!ROOM_RELAY_RE.test(pathname) || typeof key !== "string" || String(req.headers.upgrade).toLowerCase() !== "websocket") {
        socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
      const mini = new MiniSocket(socket, maxBytes);
      if (head.length) mini.feed(head);
      void relay.accept(mini, pathname);
    },

    stats() {
      const out: Record<string, Record<string, number>> = {};
      for (const [roomId, codes] of channels) out[roomId] = Object.fromEntries([...codes].map(([c, p]) => [c, p.length]));
      return out;
    },

    close() {
      clearInterval(timer);
      for (const codes of channels.values()) for (const peers of codes.values()) for (const p of peers) p.socket.close(1001, "server going away");
      channels.clear();
    },
  };

  function onMessage(peer: Peer, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) { peer.socket.close(1003, "binary frames are refused: send JSON as text (ws.send(JSON.stringify(msg)))"); return; }
    const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
    if (Buffer.byteLength(text) > maxBytes) { peer.socket.close(1009, `message too big (max ${maxBytes} bytes)`); return; }
    const second = Math.floor(Date.now() / 1000);
    if (second !== peer.window) { peer.window = second; peer.count = 0; }
    if (++peer.count > rate) { peer.socket.close(4429, `too many messages (max ${rate} a second)`); return; }
    for (const p of peer.group) if (p !== peer) { try { p.socket.send(text); } catch { /* closing */ } }
  }

  function leave(roomId: string, code: string, peer: Peer): void {
    const codes = channels.get(roomId);
    const peers = codes?.get(code);
    if (!codes || !peers) return;
    const at = peers.indexOf(peer);
    if (at < 0) return;
    peers.splice(at, 1);
    if (!peers.length) {
      codes.delete(code);
      if (!codes.size) channels.delete(roomId);
      return;
    }
    for (const p of peers) tell(p, { relay: "leave", id: peer.id, ...roster(peers) });
  }

  return relay;
}

/** The server half of RFC 6455 for the relay: text/binary/continuation,
 *  ping/pong, close — over a raw upgraded socket. Server frames are never
 *  masked; client frames always are (RFC 6455 §5.1). */
export class MiniSocket extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private parts: Buffer[] = [];
  private partBinary = false;
  private partSize = 0;
  private closing = false;

  constructor(private readonly raw: Duplex, private readonly maxBytes: number) {
    super();
    raw.on("data", (chunk: Buffer) => this.feed(chunk));
    raw.on("close", () => this.finish());
    raw.on("error", () => this.finish());
  }

  private finished = false;
  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.emit("close");
  }

  feed(chunk: Buffer): void {
    if (this.closing) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if ((b1 & 0x80) === 0) { this.close(1002, "client frames must be masked"); return; }
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) { this.close(1009, `message too big (max ${this.maxBytes} bytes)`); return; }
        len = Number(big);
        at = 10;
      }
      if (op < 8 && this.partSize + len > this.maxBytes) { this.close(1009, `message too big (max ${this.maxBytes} bytes)`); return; }
      if (this.buf.length < at + 4 + len) return;
      const mask = this.buf.subarray(at, at + 4);
      const payload = Buffer.from(this.buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.buf = this.buf.subarray(at + 4 + len);
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        this.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, "");
        return;
      }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) { this.emit("pong"); continue; }
      if (op === 0x1 || op === 0x2) { this.parts = []; this.partSize = 0; this.partBinary = op === 0x2; }
      else if (op !== 0x0) { this.close(1002, "unknown frame type"); return; }
      this.parts.push(payload);
      this.partSize += payload.length;
      if (fin) {
        const whole = Buffer.concat(this.parts);
        this.parts = [];
        this.partSize = 0;
        this.emit("message", whole, this.partBinary);
      }
    }
  }

  private frame(op: number, payload: Buffer): void {
    if (this.raw.destroyed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126 && n < 65536) { head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else if (n >= 65536) { head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    this.raw.write(Buffer.concat([head, payload]));
  }

  send(data: string): void {
    if (!this.closing) this.frame(0x1, Buffer.from(data, "utf8"));
  }

  ping(): void {
    if (!this.closing) this.frame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = ""): void {
    if (this.closing) return;
    this.closing = true;
    const why = Buffer.from(reason, "utf8").subarray(0, 120);
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    this.frame(0x8, body);
    this.raw.end();
    setTimeout(() => this.raw.destroy(), 2_000).unref?.();
  }

  terminate(): void {
    this.closing = true;
    this.raw.destroy();
  }
}
