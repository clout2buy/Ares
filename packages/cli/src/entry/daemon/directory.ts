// The people directory, daemon-side (see ../../directoryServer.ts).
//
// Owner, 2026-10-19: "search people as a sort of discovery in Ares… create a
// username, look other people up, message them or group chat, or users'
// agents can talk to each other."
//
// This Ares has one identity in the directory: a username, bound to this
// install (rooms/me.json's id). What this does:
//   claim     — take a username; keep the directory token in <home>/directory.json
//   presence  — every minute, tell the directory where this Ares answers
//               (the garrison's public origin) and which agents it shows
//   search    — look people up
//   invite    — hand someone an invite to one of our rooms (the directory
//               only relays the link; the room itself is ours)
//   dm        — "message them": a two-person room, made here, invite relayed
//   inbox     — long-poll for invites to us; the desktop shows them as cards
//               and joining is the ordinary room_join

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DirectoryAgent, DirectoryProfile, InboxItem } from "../../directoryServer.js";
import type { DesktopAgents } from "./agents.js";
import type { DesktopRooms } from "./rooms.js";

export const DEFAULT_DIRECTORY_URL = "https://people.mistiqueai.com";
const PRESENCE_MS = 60_000;
const POLL_WAIT_S = 25;

export interface DirectoryState {
  url: string;
  username?: string;
  displayName?: string;
  token?: string;
  /** Which of our agents are shown on our profile (persona ids). */
  shownAgents: string[];
  bio?: string;
  /** Highest inbox seq we have seen. */
  inboxSeq: number;
  /** username → the local mirror of our DM room with them (hosted on the directory). */
  dms: Record<string, string>;
  /** Inbox ids the owner dismissed or accepted. */
  handled: string[];
}

export interface DirectoryWire {
  url: string;
  username?: string;
  displayName?: string;
  shownAgents: string[];
  bio?: string;
  connected: boolean;
  online: boolean;
  error?: string;
  inbox: InboxItem[];
}

export interface DesktopDirectoryDeps {
  home: string;
  agents: DesktopAgents;
  rooms: DesktopRooms;
  publicOrigin(): Promise<string | null>;
  emit(payload: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class DirectoryError extends Error {}

export class DesktopDirectory {
  private state: DirectoryState = { url: process.env.ARES_DIRECTORY_URL?.trim() || DEFAULT_DIRECTORY_URL, shownAgents: [], inboxSeq: 0, dms: {}, handled: [] };
  private inbox: InboxItem[] = [];
  private online = false;
  private lastError: string | undefined;
  private poller?: AbortController;
  private presenceTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: DesktopDirectoryDeps) {
    this.fetch = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
  }

  private file(): string {
    return path.join(this.deps.home, "directory.json");
  }

  async load(): Promise<DirectoryWire> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(), "utf8")) as Partial<DirectoryState>;
      this.state = {
        url: (typeof raw.url === "string" && raw.url ? raw.url : this.state.url).replace(/\/+$/, ""),
        ...(typeof raw.username === "string" ? { username: raw.username } : {}),
        ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
        ...(typeof raw.token === "string" ? { token: raw.token } : {}),
        shownAgents: Array.isArray(raw.shownAgents) ? raw.shownAgents.filter((a): a is string => typeof a === "string") : [],
        ...(typeof raw.bio === "string" ? { bio: raw.bio } : {}),
        inboxSeq: typeof raw.inboxSeq === "number" ? raw.inboxSeq : 0,
        dms: raw.dms && typeof raw.dms === "object" ? Object.fromEntries(Object.entries(raw.dms).filter(([, v]) => typeof v === "string")) as Record<string, string> : {},
        handled: Array.isArray(raw.handled) ? raw.handled.filter((a): a is string => typeof a === "string").slice(-500) : [],
      };
    } catch {
      // not claimed yet
    }
    if (this.state.token) this.start();
    return this.wire();
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.deps.home, { recursive: true });
    await fs.writeFile(this.file(), JSON.stringify(this.state, null, 2), "utf8");
  }

  stop(): void {
    this.stopped = true;
    this.poller?.abort();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
  }

  wire(): DirectoryWire {
    return {
      url: this.state.url,
      ...(this.state.username ? { username: this.state.username } : {}),
      ...(this.state.displayName ? { displayName: this.state.displayName } : {}),
      shownAgents: this.state.shownAgents,
      ...(this.state.bio ? { bio: this.state.bio } : {}),
      connected: Boolean(this.state.token),
      online: this.online,
      ...(this.lastError ? { error: this.lastError } : {}),
      inbox: this.inbox.filter((i) => !i.acked && !this.state.handled.includes(i.id)),
    };
  }

  private emitState(): void {
    this.deps.emit({ type: "directory_state", directory: this.wire() });
  }

  private async call<T>(method: "GET" | "POST" | "PUT", route: string, body?: unknown, opts: { auth?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.auth !== false && this.state.token) headers.authorization = `Bearer ${this.state.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(`${this.state.url}${route}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new DirectoryError(`the directory at ${this.state.url} did not answer (${error instanceof Error ? error.message : String(error)})`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new DirectoryError(typeof data.error === "string" ? data.error : `the directory answered ${res.status}`);
    return data as T;
  }

  /** Our agents as the profile shows them. */
  private shownAgentCards(): DirectoryAgent[] {
    const out: DirectoryAgent[] = [];
    for (const id of this.state.shownAgents) {
      const p = this.deps.agents.get(id);
      if (!p) continue;
      out.push({ name: p.name, ...(p.emoji ? { emoji: p.emoji } : {}), ...(p.color ? { color: p.color } : {}), ...(p.instructions ? { role: p.instructions.replace(/\s+/g, " ").trim().slice(0, 120) } : {}) });
    }
    return out;
  }

  async setUrl(url: string): Promise<DirectoryWire> {
    const u = url.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/i.test(u)) throw new DirectoryError("the directory address must be an http(s) origin");
    if (u !== this.state.url) {
      this.stop();
      this.stopped = false;
      this.state = { url: u, shownAgents: this.state.shownAgents, inboxSeq: 0, dms: {}, handled: [] };
      this.inbox = [];
      this.online = false;
      await this.save();
    }
    this.emitState();
    return this.wire();
  }

  async claim(username: string, displayName?: string): Promise<DirectoryWire> {
    const me = this.deps.rooms.whoami();
    const origin = await this.deps.publicOrigin();
    const out = await this.call<{ token: string; user: DirectoryProfile }>("POST", "/v1/claim", {
      username: username.trim().toLowerCase(),
      // Never the OS account name by default (owner: "as long as they can't dox
      // me"): shown as what they typed, else the username itself.
      displayName: (displayName ?? "").trim() || username.trim().toLowerCase(),
      installId: me.id,
      ...(origin ? { origin } : {}),
      agents: this.shownAgentCards(),
      ...(this.state.bio ? { bio: this.state.bio } : {}),
    }, { auth: false });
    this.state = { ...this.state, username: out.user.username, displayName: out.user.displayName, token: out.token, inboxSeq: 0, handled: [] };
    this.state.dms ??= {};
    this.lastError = undefined;
    this.online = true;
    await this.save();
    if (displayName && displayName.trim() && displayName.trim() !== me.name) await this.deps.rooms.rename(displayName.trim()).catch(() => undefined);
    this.stopped = false;
    this.start();
    this.emitState();
    return this.wire();
  }

  async updateProfile(patch: { displayName?: string; bio?: string; shownAgents?: string[] }): Promise<DirectoryWire> {
    if (patch.shownAgents) this.state.shownAgents = patch.shownAgents.filter((id) => this.deps.agents.get(id)).slice(0, 12);
    if (patch.bio !== undefined) { const b = patch.bio.trim().slice(0, 160); if (b) this.state.bio = b; else delete this.state.bio; }
    if (patch.displayName && patch.displayName.trim()) this.state.displayName = patch.displayName.trim().slice(0, 40);
    await this.save();
    if (this.state.token) await this.presence().catch(() => undefined);
    this.emitState();
    return this.wire();
  }

  async search(q: string): Promise<DirectoryProfile[]> {
    const out = await this.call<{ users: DirectoryProfile[] }>("GET", `/v1/users?q=${encodeURIComponent(q.trim())}`, undefined, { auth: false });
    this.online = true;
    this.lastError = undefined;
    return (out.users ?? []).filter((u) => u.username !== this.state.username);
  }

  async profile(username: string): Promise<DirectoryProfile> {
    const out = await this.call<{ user: DirectoryProfile }>("GET", `/v1/users/${encodeURIComponent(username.replace(/^@/, ""))}`, undefined, { auth: false });
    return out.user;
  }

  /** Invite a person into a room. A room hosted on the directory invites
   *  through the directory (they get an inbox card); a room hosted here
   *  needs this Ares to be reachable (a garrison with a public address). */
  async invite(username: string, roomId: string, text?: string): Promise<InboxItem> {
    if (!this.state.token) throw new DirectoryError("claim a username first");
    const who = username.replace(/^@/, "").toLowerCase();
    const room = this.deps.rooms.get(roomId);
    if (!room) throw new DirectoryError("unknown room");
    if (room.host.kind === "remote" && room.host.origin === this.state.url) {
      const out = await this.call<{ item: InboxItem }>("POST", `/v1/rooms/${encodeURIComponent(room.host.roomId)}/invite`, { username: who, ...(text ? { text } : {}) });
      return out.item;
    }
    if (room.host.kind === "remote") throw new DirectoryError("only the room's host can invite — ask them");
    const origin = await this.deps.publicOrigin();
    if (!origin) throw new DirectoryError("this room lives on your machine and nobody can reach it from outside — use Message to open a room on the directory instead, or run Ares as a garrison");
    const inv = await this.deps.rooms.invite(roomId, `@${who}`);
    const out = await this.call<{ item: InboxItem }>("POST", `/v1/users/${encodeURIComponent(who)}/invite`, {
      kind: "room",
      link: inv.link,
      roomName: room.name,
      ...(text ? { text } : {}),
    });
    return out.item;
  }

  /** "Message them": a two-person room on the directory (nobody needs a
   *  server), joined here at once; they get the invite. Agents can be
   *  added by either side afterwards. */
  async dm(username: string, text?: string): Promise<{ roomId: string; item?: InboxItem }> {
    if (!this.state.token) throw new DirectoryError("claim a username first");
    const who = username.replace(/^@/, "").toLowerCase();
    const known = this.state.dms[who];
    if (known && this.deps.rooms.get(known)) {
      const item = text ? await this.invite(who, known, text) : undefined;
      return { roomId: known, ...(item ? { item } : {}) };
    }
    const them = await this.profile(who);
    const me = this.state.displayName ?? this.deps.rooms.whoami().name;
    const made = await this.call<{ roomId: string; link: string; invited: string[] }>("POST", "/v1/rooms", {
      name: `${me} & ${them.displayName}`,
      emoji: "💬",
      kind: "dm",
      purpose: `A direct chat between ${me} (@${this.state.username}) and ${them.displayName} (@${them.username}). Either side may add their agents.`,
      invite: [who],
      ...(text ? { text } : {}),
    });
    const mirror = await this.deps.rooms.join(made.link, []);
    this.state.dms = { ...this.state.dms, [who]: mirror.id };
    await this.save();
    return { roomId: mirror.id };
  }

  /** A group on the directory: open it, join it, invite the names. */
  async group(name: string, usernames: string[], purpose?: string, text?: string): Promise<{ roomId: string; invited: string[] }> {
    if (!this.state.token) throw new DirectoryError("claim a username first");
    const made = await this.call<{ roomId: string; link: string; invited: string[] }>("POST", "/v1/rooms", {
      name: name.trim().slice(0, 40) || "Room",
      ...(purpose ? { purpose } : {}),
      invite: usernames.map((u) => u.replace(/^@/, "").toLowerCase()),
      ...(text ? { text } : {}),
    });
    const mirror = await this.deps.rooms.join(made.link, []);
    return { roomId: mirror.id, invited: made.invited };
  }

  async ack(id: string): Promise<DirectoryWire> {
    if (!this.state.handled.includes(id)) this.state.handled = [...this.state.handled, id].slice(-500);
    await this.save();
    if (this.state.token) await this.call("POST", `/v1/inbox/${encodeURIComponent(id)}/ack`, {}).catch(() => undefined);
    this.emitState();
    return this.wire();
  }

  // ─── background: presence + inbox ──────────────────────────────────────

  private async presence(): Promise<void> {
    const origin = await this.deps.publicOrigin();
    await this.call("PUT", "/v1/me", { ...(origin ? { origin } : {}), agents: this.shownAgentCards(), ...(this.state.displayName ? { displayName: this.state.displayName } : {}), ...(this.state.bio ? { bio: this.state.bio } : {}) });
    this.online = true;
    this.lastError = undefined;
  }

  private start(): void {
    if (!this.state.token || this.stopped) return;
    if (!this.presenceTimer) {
      this.presenceTimer = setInterval(() => void this.presence().catch((e) => { this.online = false; this.lastError = e instanceof Error ? e.message : String(e); this.emitState(); }), PRESENCE_MS);
      this.presenceTimer.unref?.();
      void this.presence().catch((e) => { this.online = false; this.lastError = e instanceof Error ? e.message : String(e); this.emitState(); });
    }
    if (this.poller) return;
    const ctl = new AbortController();
    this.poller = ctl;
    const loop = async () => {
      let backoff = 2_000;
      while (!ctl.signal.aborted && !this.stopped && this.state.token) {
        try {
          const out = await this.call<{ items: InboxItem[]; seq: number }>("GET", `/v1/inbox?since=${this.state.inboxSeq}&wait=${POLL_WAIT_S}`, undefined, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout((POLL_WAIT_S + 15) * 1_000)]) });
          backoff = 2_000;
          if (out.items.length) {
            for (const item of out.items) if (!this.inbox.some((i) => i.id === item.id)) this.inbox.push(item);
            this.inbox = this.inbox.slice(-100);
            this.state.inboxSeq = Math.max(this.state.inboxSeq, ...out.items.map((i) => i.seq));
            await this.save();
            for (const item of out.items) if (!item.acked && !this.state.handled.includes(item.id)) this.deps.emit({ type: "directory_invite", item });
            this.emitState();
          } else if (typeof out.seq === "number" && out.seq > this.state.inboxSeq) {
            this.state.inboxSeq = out.seq;
            await this.save();
          }
        } catch (error) {
          if (ctl.signal.aborted) break;
          const msg = error instanceof Error ? error.message : String(error);
          if (/claim a username|401/.test(msg)) {
            // our token died (the username moved to another install): drop it
            delete this.state.token;
            await this.save();
            this.emitState();
            break;
          }
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
      if (this.poller === ctl) this.poller = undefined;
    };
    void loop();
  }
}
