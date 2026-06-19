// TelegramBridge — a channel that is a pure Garrison gateway client.
// Telegram DMs in, sessions out: one session per allowed chat (created lazily,
// recreated after reconnect), text deltas buffered per turn and flushed on
// turn_end in 4000-char chunks (hard cap + truncation marker until sideQuery
// summarization lands), tool_start throttled to one status edit per 3s, and
// approval.pending rendered as the Gate over inline keyboards. Everything is
// injectable — api, websocket ctor, timers, clock — so tests run hermetic.

import WebSocket from "ws";

import type { TurnEvent } from "@ares/protocol";
import type {
  ApprovalVerb,
  ClientFrame,
  ServerFrame,
  StagedApprovalFrame,
  WebSocketCtor,
  WebSocketLike,
} from "../types.js";
import type { InlineKeyboardMarkup, SendMessageOptions, TgCallbackQuery, TgMessage, TgUpdate } from "./api.js";
import { voiceToText } from "./stt.js";
import { textToVoice } from "./edgeTts.js";
import { parseTelegramCommand, handleTelegramCommand, type TelegramCommandDeps } from "./commands.js";
import { sendConnectMenu, handleConnectCallback, parseConnectCallback, type ConnectFlowDeps } from "./connect.js";
import {
  allowedChatIds as rosterAllowed,
  emptyRoster,
  findByChat,
  markSeen,
  ownerChatIds as rosterOwners,
  removeParticipant,
  renderWho,
  seedOwners,
  upsertParticipant,
  type RosterData,
} from "./roster.js";

/** The api surface the bridge needs — TelegramApi satisfies it; fakes are trivial. */
export interface TelegramApiLike {
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<TgMessage>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void>;
  /** Optional "typing…" hint. Absent on old fakes → the bridge skips it. */
  sendChatAction?(chatId: number, action?: "typing", signal?: AbortSignal): Promise<void>;
  /** Download a file by file_id. Absent on old fakes → voice messages are skipped. */
  getFile?(fileId: string, signal?: AbortSignal): Promise<{ file_id: string; file_path?: string }>;
  downloadFile?(filePath: string, signal?: AbortSignal): Promise<Buffer>;
  sendVoice?(chatId: number, voice: Buffer, opts?: { caption?: string; signal?: AbortSignal }): Promise<TgMessage>;
}

/**
 * Flatten Ares's markdown into clean Telegram plain text. Telegram shows raw
 * `**bold**`, backticks and `#` headers as literal noise (and MarkdownV2 with
 * unbalanced entities throws 400, dropping the whole reply). Stripping to tidy
 * plain text is the robust choice: readable, and it never fails to send.
 */
export function toTelegramText(md: string): string {
  return md
    .replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_m, code) => String(code).trim()) // fenced code → bare
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2") // italic *…*
    .replace(/(^|[^_])__([^_]+)__/g, "$1$2") // bold __…__
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // links → text (url)
    .replace(/^\s*[-*]\s+/gm, "• ") // bullets
    .replace(/\n{3,}/g, "\n\n") // collapse big gaps
    .trim();
}

export interface BridgeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TelegramBridgeOptions {
  api: TelegramApiLike;
  gateway: { url: string; token: string };
  allowedChatIds: number[];
  /** Chats that get the approval Gate + admin commands. Default: all allowed
   *  (back-compat — a single-owner setup is unchanged). */
  ownerChatIds?: number[];
  /** Loaded roster (names + roles). Absent → synthesized from allowed/owner ids. */
  initialRoster?: RosterData;
  /** Persist the roster after /allow|/revoke. Absent → changes are in-memory only. */
  persistRoster?: (data: RosterData) => void | Promise<void>;
  /** Re-read the roster from its source before each inbound message, so a grant
   *  made elsewhere (the agent's TelegramRoster tool — "authorize my friend")
   *  goes LIVE with no restart. Absent → roster is fixed for the process. */
  reloadRoster?: () => RosterData | Promise<RosterData>;
  /** Injectable WebSocket constructor; defaults to `ws`. */
  wsImpl?: WebSocketCtor;
  /** Injectable scheduling (reconnect backoff, status throttle). */
  timers?: BridgeTimers;
  now?: () => number;
  /** Telegram long-poll hold in seconds. Default 25. */
  pollTimeoutS?: number;
  /** hello.client identifier. Default "telegram". */
  clientName?: string;
  log?: (line: string) => void;
  /**
   * Remote-command deps (state/control/dry-run). When set, recognized slash /
   * one-word commands are handled locally; everything else still routes to a
   * garrison chat session. Absent → all text is chat (the original behavior).
   */
  commands?: TelegramCommandDeps;
  /** OAuth connect flow deps. When set, /connect shows the service menu and
   *  connect callbacks trigger OAuth flows. */
  connectDeps?: Omit<ConnectFlowDeps, "api" | "log">;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const STATUS_EDIT_EVERY_MS = 3_000;
/** Telegram clears "typing…" after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_000;
const CHUNK_LIMIT = 4_000;
const MAX_CHUNKS = 8;
const TRUNCATION_MARKER = "…[truncated]";
const REFUSAL_TEXT =
  "This Ares garrison is private. Your chat is not on the allowlist, so I can't help here.";

/**
 * Split a turn's text into Telegram-sized chunks. Outputs longer than
 * limit*maxChunks are hard-capped with a truncation marker — the honest
 * stopgap until sideQuery summarization is wired.
 */
export function chunkMessage(text: string, limit = CHUNK_LIMIT, maxChunks = MAX_CHUNKS): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length && chunks.length < maxChunks; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  if (text.length > limit * maxChunks && limit > TRUNCATION_MARKER.length) {
    const last = chunks[maxChunks - 1];
    chunks[maxChunks - 1] = last.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return chunks;
}

interface StatusState {
  messageId?: number;
  sending: boolean;
  lastEditAt: number;
  pendingText?: string;
  timer?: unknown;
}

export class TelegramBridge {
  private readonly api: TelegramApiLike;
  private readonly gatewayUrl: string;
  private readonly gatewayToken: string;
  private allowed: Set<number>;
  private owners: Set<number>;
  private roster: RosterData;
  private readonly persistRoster?: (data: RosterData) => void | Promise<void>;
  private readonly reloadRoster?: () => RosterData | Promise<RosterData>;
  /** Owner ids seeded at construction — re-applied after every reload so a
   *  reload from an empty/partial file can never lock the owner out. */
  private readonly ownerSeed: number[];
  private readonly WS: WebSocketCtor;
  private readonly timers: BridgeTimers;
  private readonly now: () => number;
  private readonly pollTimeoutS: number;
  private readonly clientName: string;
  private readonly log: (line: string) => void;
  private readonly commands?: TelegramCommandDeps;
  private readonly connectDeps?: Omit<ConnectFlowDeps, "api" | "log">;

  private running = false;
  private abort = new AbortController();
  private ws?: WebSocketLike;
  private connected = false;
  private backoffMs = RECONNECT_MIN_MS;
  private reconnectTimer?: unknown;
  private pollPromise?: Promise<void>;

  private readonly chatToSession = new Map<number, string>();
  private readonly sessionToChat = new Map<string, number>();
  /** FIFO of chats awaiting session.created — the wire has no correlation id. */
  private readonly createQueue: number[] = [];
  /** Texts buffered while a chat has no session (or the gateway is down). */
  private readonly pendingTexts = new Map<number, string[]>();
  /** Chats with one user turn currently in flight through the Garrison. */
  private readonly turnInFlight = new Set<number>();
  /** Accumulated text_delta per session for the in-flight turn. */
  private readonly turnText = new Map<string, string>();
  /** Last error reported by the engine this turn — surfaced on a failed turn_end
   *  so a provider failure (bad/missing key, rate limit, network) is never a
   *  silent "typing… then nothing". */
  private readonly turnError = new Map<string, string>();
  private readonly status = new Map<number, StatusState>();
  private readonly refused = new Set<number>();
  /** Per-chat "typing…" refreshers, live while a turn is in flight. */
  private readonly typingTimers = new Map<number, unknown>();
  /** Guest sessions that have already received their identity preamble. */
  private readonly guestIntroSent = new Set<number>();
  /** Unknown chats already surfaced to owners, so we notify once per stranger. */
  private readonly unknownNotified = new Set<number>();
  /** Per-chat activity for the owner's /activity view: how much each person is
   *  talking and what about (their latest message, truncated). Owner-only. */
  private readonly activity = new Map<number, { count: number; lastAt: number; lastMessage: string }>();
  /** Per-chat outbound chains keep Telegram message order deterministic. */
  private readonly sendChains = new Map<number, Promise<void>>();
  /** Short callback tokens for approval ids too long for callback_data (64 bytes). */
  private readonly approvalTokens = new Map<string, string>();
  private approvalTokenSeq = 0;
  /** Tool-permission prompts routed to Telegram: token → {sessionId, requestId}. */
  private readonly permTokens = new Map<string, { sessionId: string; requestId: string }>();
  private permTokenSeq = 0;
  /** Chats whose last inbound was a voice message — reply with a voice note. */
  private readonly voiceReplyExpected = new Set<number>();

  constructor(opts: TelegramBridgeOptions) {
    this.api = opts.api;
    this.gatewayUrl = opts.gateway.url;
    this.gatewayToken = opts.gateway.token;

    // Build the roster: an explicit one wins; otherwise synthesize from the
    // legacy id lists. Back-compat: when no ownerChatIds are given, every allowed
    // chat is an owner (the single-owner behavior that existed before roles).
    const ownerSeed = opts.ownerChatIds ?? opts.allowedChatIds;
    let roster = opts.initialRoster ?? emptyRoster();
    roster = seedOwners(roster, ownerSeed);
    for (const id of opts.allowedChatIds) {
      if (!findByChat(roster, id)) roster = upsertParticipant(roster, { chatId: id, name: `chat ${id}`, role: "guest" });
    }
    this.roster = roster;
    this.allowed = new Set(rosterAllowed(roster));
    this.owners = new Set(rosterOwners(roster));
    this.persistRoster = opts.persistRoster;
    this.reloadRoster = opts.reloadRoster;
    this.ownerSeed = [...ownerSeed];

    this.WS = opts.wsImpl ?? (WebSocket as unknown as WebSocketCtor);
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.now = opts.now ?? Date.now;
    this.pollTimeoutS = opts.pollTimeoutS ?? 25;
    this.clientName = opts.clientName ?? "telegram";
    this.log = opts.log ?? (() => undefined);
    this.commands = opts.commands;
    this.connectDeps = opts.connectDeps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.backoffMs = RECONNECT_MIN_MS;
    // Persist the seeded roster once so the on-disk file exists with the owner(s)
    // — otherwise a reload from a missing file would read empty and lock them out.
    void this.savePersisted();
    this.connect();
    this.pollPromise = this.pollLoop();
  }

  /** Re-read the roster from its source and re-apply owners. Lets a grant made
   *  by the agent's TelegramRoster tool take effect without a restart. */
  private async refreshRoster(): Promise<void> {
    if (!this.reloadRoster) return;
    try {
      const loaded = await this.reloadRoster();
      if (!loaded || !Array.isArray(loaded.participants)) return;
      const reseeded = seedOwners(loaded, this.ownerSeed);
      this.roster = reseeded;
      this.allowed = new Set(rosterAllowed(reseeded));
      this.owners = new Set(rosterOwners(reseeded));
    } catch (err) {
      this.log(`roster reload failed: ${errText(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    if (this.reconnectTimer !== undefined) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const state of this.status.values()) {
      if (state.timer !== undefined) this.timers.clearTimeout(state.timer);
    }
    this.status.clear();
    for (const timer of this.typingTimers.values()) this.timers.clearTimeout(timer);
    this.typingTimers.clear();
    const socket = this.ws;
    this.ws = undefined;
    this.connected = false;
    if (socket) {
      try {
        socket.close();
      } catch {
        // already dead — nothing to release
      }
    }
    await (this.pollPromise ?? Promise.resolve());
    this.pollPromise = undefined;
  }

  // ─── Telegram side ─────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let offset = 0;
    while (this.running) {
      let updates: TgUpdate[];
      try {
        updates = await this.api.getUpdates(offset, this.pollTimeoutS, this.abort.signal);
      } catch (err) {
        if (!this.running) return;
        this.log(`getUpdates failed: ${errText(err)}`);
        await this.sleepMs(1_000);
        continue;
      }
      // Pick up any out-of-band roster change (the agent authorized someone via
      // the TelegramRoster tool) before deciding who's allowed this batch.
      if (updates.length > 0) await this.refreshRoster();
      for (const update of updates) {
        if (update.update_id >= offset) offset = update.update_id + 1;
        try {
          this.handleUpdate(update);
        } catch (err) {
          this.log(`update ${update.update_id} dropped: ${errText(err)}`);
        }
      }
    }
  }

  private handleUpdate(update: TgUpdate): void {
    const message = update.message;
    if (message?.chat) {
      const chatId = message.chat.id;
      const senderName = message.from?.first_name ?? message.from?.username ?? `chat ${chatId}`;
      if (!this.allowed.has(chatId)) {
        this.refuseOnce(chatId, senderName);
        return;
      }
      this.roster = markSeen(this.roster, chatId);

      // Voice/audio message → download, transcribe, feed as text
      const voiceFileId = message.voice?.file_id ?? message.audio?.file_id;
      if (voiceFileId && this.api.getFile && this.api.downloadFile) {
        this.handleVoiceMessage(chatId, voiceFileId);
        return;
      }

      if (message.text !== undefined && message.text.trim().length > 0) {
        this.voiceReplyExpected.delete(chatId);
        this.onChatText(chatId, message.text);
      }
      return;
    }
    if (update.callback_query) this.handleCallback(update.callback_query);
  }

  private handleVoiceMessage(chatId: number, fileId: string): void {
    this.voiceReplyExpected.add(chatId);
    this.enqueueSend(chatId, async () => {
      try {
        const fileMeta = await this.api.getFile!(fileId);
        if (!fileMeta.file_path) throw new Error("no file_path in getFile response");
        const audio = await this.api.downloadFile!(fileMeta.file_path);
        const text = await voiceToText(audio);
        if (!text || text.trim().length === 0) {
          await this.api.sendMessage(chatId, "(Couldn't make out what you said — try again or type it out.)");
          this.voiceReplyExpected.delete(chatId);
          return;
        }
        this.log(`voice transcription (chat ${chatId}): ${text.slice(0, 100)}`);
        this.onChatText(chatId, text);
      } catch (err) {
        this.log(`voice message failed: ${errText(err)}`);
        this.voiceReplyExpected.delete(chatId);
        await this.api.sendMessage(chatId, "(Voice processing failed — please type your message instead.)").catch(() => {});
      }
    });
  }

  private refuseOnce(chatId: number, senderName = `chat ${chatId}`): void {
    if (this.refused.has(chatId)) return;
    this.refused.add(chatId);
    this.enqueueSend(chatId, async () => {
      await this.api.sendMessage(chatId, REFUSAL_TEXT);
    });
    // Tell the owner(s) a stranger knocked, so they can /allow them — the flow
    // behind "let my girlfriend talk to you": she DMs, you approve her in.
    if (!this.unknownNotified.has(chatId)) {
      this.unknownNotified.add(chatId);
      const note = `👤 ${senderName} (id ${chatId}) tried to message me but isn't on the allowlist.\nReply "/allow ${chatId} <name>" to let them in.`;
      for (const ownerId of this.owners) this.enqueueSend(ownerId, async () => { await this.api.sendMessage(ownerId, note); });
    }
  }

  private onChatText(chatId: number, text: string): void {
    // Owner-only roster admin (/who, /allow, /revoke) is handled before anything
    // else. A guest typing these just falls through to chat — never an admin path.
    if (this.owners.has(chatId) && this.handleAdminCommand(chatId, text)) return;

    // Remote commands are handled locally; everything else falls through to a
    // garrison chat session (the original behavior, unchanged when no deps set).
    if (this.commands) {
      const command = parseTelegramCommand(text);
      if (command) {
        this.runCommand(chatId, command.kind, command.arg);
        return;
      }
    }
    // Record real conversation activity (not commands) for the owner's /activity.
    const prior = this.activity.get(chatId);
    this.activity.set(chatId, {
      count: (prior?.count ?? 0) + 1,
      lastAt: this.now(),
      lastMessage: text.replace(/\s+/g, " ").trim().slice(0, 120),
    });

    const queue = this.pendingTexts.get(chatId);
    if (queue) queue.push(text);
    else this.pendingTexts.set(chatId, [text]);
    this.pumpChat(chatId);
  }

  private runCommand(chatId: number, kind: NonNullable<ReturnType<typeof parseTelegramCommand>>["kind"], arg?: string): void {
    // /connect is special — it needs inline buttons and the connect flow deps.
    if (kind === "connect" && this.connectDeps) {
      this.enqueueSend(chatId, async () => {
        await sendConnectMenu({ ...this.connectDeps!, api: this.api, log: this.log }, chatId);
      });
      return;
    }

    this.enqueueSend(chatId, async () => {
      let result;
      try {
        result = await handleTelegramCommand(kind, this.commands, arg);
      } catch (err) {
        this.log(`command ${kind} failed: ${errText(err)}`);
        await this.api.sendMessage(chatId, "Command failed.");
        return;
      }
      if (result.control && this.commands?.control) {
        try {
          await this.commands.control(result.control);
        } catch (err) {
          this.log(`control ${result.control} failed: ${errText(err)}`);
        }
      }
      if (result.resetSession) this.resetChatSession(chatId);
      await this.api.sendMessage(chatId, result.text);
    });
  }

  /** Owner-only roster admin. Returns true if the text was an admin command. */
  private handleAdminCommand(chatId: number, text: string): boolean {
    const m = /^\/(who|allow|revoke|activity)(?:@\w+)?(?:\s+([\s\S]+))?$/i.exec(text.trim());
    if (!m) return false;
    const kind = m[1].toLowerCase();
    const arg = m[2]?.trim();

    if (kind === "activity") {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, this.renderActivity()); });
      return true;
    }

    if (kind === "who") {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, renderWho(this.roster)); });
      return true;
    }

    if (kind === "allow") {
      const parts = (arg ?? "").split(/\s+/).filter(Boolean);
      const targetId = Number(parts[0]);
      const name = parts.slice(1).join(" ") || `chat ${parts[0]}`;
      if (!Number.isInteger(targetId)) {
        this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, 'Usage: /allow <chatId> <name> — e.g. "/allow 12345 Sarah".'); });
        return true;
      }
      this.roster = upsertParticipant(this.roster, { chatId: targetId, name, role: "guest", addedBy: chatId });
      this.allowed.add(targetId);
      this.refused.delete(targetId);
      this.unknownNotified.delete(targetId);
      void this.savePersisted();
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, `✅ ${name} (id ${targetId}) can now talk to me.`); });
      this.enqueueSend(targetId, async () => { await this.api.sendMessage(targetId, "👋 You've been added — message me anytime."); });
      return true;
    }

    // revoke
    if (!arg) {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, "Usage: /revoke <chatId|name>."); });
      return true;
    }
    const targetNum = Number(arg);
    const target = Number.isInteger(targetNum) ? targetNum : arg;
    if (typeof target === "number" && this.owners.has(target)) {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, "Can't revoke an owner."); });
      return true;
    }
    const { data, removed } = removeParticipant(this.roster, target);
    if (!removed || removed.role === "owner") {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, `No guest "${arg}" to revoke.`); });
      return true;
    }
    this.roster = data;
    this.allowed.delete(removed.chatId);
    void this.savePersisted();
    this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, `⛔ ${removed.name} (id ${removed.chatId}) can no longer talk to me.`); });
    return true;
  }

  private async savePersisted(): Promise<void> {
    try {
      await this.persistRoster?.(this.roster);
    } catch (err) {
      this.log(`roster persist failed: ${errText(err)}`);
    }
  }

  /** The owner's /activity view: who's talking, how much, and about what. */
  private renderActivity(): string {
    const rows = [...this.activity.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt);
    if (rows.length === 0) return "💬 No conversations yet.";
    const lines = ["💬 Who's talking to me, and about what:"];
    for (const [id, a] of rows) {
      const p = findByChat(this.roster, id);
      const name = p?.name ?? `chat ${id}`;
      const badge = p?.role === "owner" ? "👑" : "👤";
      lines.push(`${badge} ${name} — ${a.count} msg${a.count === 1 ? "" : "s"}, ${this.ago(a.lastAt)}\n   ↳ "${a.lastMessage}"`);
    }
    return lines.join("\n");
  }

  private ago(at: number): string {
    const min = Math.floor((this.now() - at) / 60_000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }

  /** Forget a chat's garrison session so the next message creates a fresh one
   *  (used after a model switch so the new model takes effect immediately). */
  private resetChatSession(chatId: number): void {
    const sessionId = this.chatToSession.get(chatId);
    if (sessionId !== undefined) {
      this.sessionToChat.delete(sessionId);
      this.turnText.delete(sessionId);
    }
    this.chatToSession.delete(chatId);
    this.guestIntroSent.delete(chatId);
  }

  private requestSession(chatId: number): void {
    if (this.createQueue.includes(chatId)) return;
    this.createQueue.push(chatId);
    this.sendFrame({ type: "session.create" });
  }

  private handleCallback(cq: TgCallbackQuery): void {
    const chatId: number | undefined = cq.message?.chat?.id ?? cq.from?.id;

    // Connect callback: ares:connect:<provider>
    if (cq.data && chatId !== undefined && this.owners.has(chatId)) {
      const providerId = parseConnectCallback(cq.data);
      if (providerId && this.connectDeps) {
        void this.api.answerCallbackQuery(cq.id, { text: "Starting connection..." }).catch(() => undefined);
        this.enqueueSend(chatId, async () => {
          await handleConnectCallback({ ...this.connectDeps!, api: this.api, log: this.log }, chatId, providerId);
        });
        return;
      }
    }

    // Tool-permission callback: ares:perm:<allow|deny>:<token>
    const permMatch = cq.data === undefined ? null : /^ares:perm:(allow|deny):(.+)$/.exec(cq.data);
    if (permMatch && chatId !== undefined && this.owners.has(chatId)) {
      if (!this.connected) {
        void this.api.answerCallbackQuery(cq.id, { text: "Gateway offline — try again shortly." }).catch(() => undefined);
        return;
      }
      const entry = this.permTokens.get(permMatch[2]);
      if (!entry) {
        void this.api.answerCallbackQuery(cq.id, { text: "Expired — already decided." }).catch(() => undefined);
        return;
      }
      this.permTokens.delete(permMatch[2]);
      const decision = permMatch[1] === "allow" ? "allow_once" : "deny";
      this.sendFrame({ type: "permission.respond", sessionId: entry.sessionId, requestId: entry.requestId, decision });
      void this.api.answerCallbackQuery(cq.id, { text: permMatch[1] === "allow" ? "Allowed" : "Denied" }).catch(() => undefined);
      return;
    }

    // Approval callback: ares:approve|deny:<token>
    const match = cq.data === undefined ? null : /^ares:(approve|deny):(.+)$/.exec(cq.data);
    if (!match || chatId === undefined || !this.owners.has(chatId)) {
      void this.api.answerCallbackQuery(cq.id).catch(() => undefined);
      return;
    }
    if (!this.connected) {
      void this.api
        .answerCallbackQuery(cq.id, { text: "Gateway offline — try again shortly." })
        .catch(() => undefined);
      return;
    }
    const action = match[1];
    const approvalId = this.approvalTokens.get(match[2]) ?? match[2];
    const verb: ApprovalVerb = action === "approve" ? "allow_once" : "deny";
    this.sendFrame({ type: "approval.respond", approvalId, verb });
    void this.api
      .answerCallbackQuery(cq.id, { text: action === "approve" ? "Approved" : "Denied" })
      .catch(() => undefined);
  }

  // ─── Gateway side ──────────────────────────────────────────────────────

  private connect(): void {
    if (!this.running) return;
    let socket: WebSocketLike;
    try {
      socket = new this.WS(this.gatewayUrl);
    } catch (err) {
      this.log(`gateway connect failed: ${errText(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    socket.on("open", () => {
      if (this.ws !== socket) return;
      this.sendFrame({ type: "hello", token: this.gatewayToken, client: this.clientName, proto: 1 });
    });
    socket.on("message", (data) => {
      if (this.ws !== socket) return;
      this.handleFrame(data);
    });
    socket.on("close", () => {
      if (this.ws !== socket) return;
      this.ws = undefined;
      this.connected = false;
      this.scheduleReconnect();
    });
    socket.on("error", (err) => {
      // close always follows error on ws; reconnect is scheduled there.
      this.log(`gateway socket error: ${errText(err)}`);
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== undefined) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private handleFrame(raw: unknown): void {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (raw instanceof Uint8Array) text = Buffer.from(raw).toString("utf8");
    else if (Array.isArray(raw)) text = Buffer.concat(raw as readonly Uint8Array[]).toString("utf8");
    else return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log("gateway sent non-JSON frame; ignored");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const frame = parsed as ServerFrame;
    if (typeof frame.type !== "string") return;

    switch (frame.type) {
      case "welcome":
        this.onWelcome();
        break;
      case "session.created": {
        const id = frame.session?.id;
        if (typeof id === "string") this.onSessionCreated(id);
        break;
      }
      case "event":
        if (typeof frame.sessionId === "string" && frame.event && typeof frame.event === "object") {
          this.onEvent(frame.sessionId, frame.event);
        }
        break;
      case "approval.pending":
        this.onApprovalPending(frame.staged);
        break;
      case "error":
        this.log(`gateway error: ${frame.message}`);
        break;
      default:
        // sessions / status — nothing for a Telegram surface to render.
        break;
    }
  }

  private onWelcome(): void {
    this.connected = true;
    this.backoffMs = RECONNECT_MIN_MS;
    // Reconnect semantics: sessions are recreated, never assumed to survive.
    this.chatToSession.clear();
    this.sessionToChat.clear();
    this.turnText.clear();
    this.turnError.clear();
    this.turnInFlight.clear();
    // New sessions after a reconnect → re-introduce guests to the fresh session.
    this.guestIntroSent.clear();
    this.createQueue.length = 0;
    for (const chatId of this.pendingTexts.keys()) this.requestSession(chatId);
  }

  private onSessionCreated(sessionId: string): void {
    const chatId = this.createQueue.shift();
    if (chatId === undefined) return; // unsolicited — another client's create
    this.chatToSession.set(chatId, sessionId);
    this.sessionToChat.set(sessionId, chatId);
    this.pumpChat(chatId);
  }

  private pumpChat(chatId: number): void {
    if (!this.connected || this.turnInFlight.has(chatId)) return;
    const queue = this.pendingTexts.get(chatId);
    if (!queue || queue.length === 0) {
      this.pendingTexts.delete(chatId);
      return;
    }

    const sessionId = this.chatToSession.get(chatId);
    if (sessionId === undefined) {
      this.requestSession(chatId);
      return;
    }

    const text = queue.shift();
    if (queue.length === 0) this.pendingTexts.delete(chatId);
    if (text === undefined) return;
    this.turnInFlight.add(chatId);
    this.startTyping(chatId);
    this.sendFrame({ type: "session.send", sessionId, text: this.withIdentity(chatId, text) });
  }

  /** For a guest's FIRST turn, prepend a one-time note so Ares knows it is not
   *  talking to the owner — address them by name, keep the owner's life private. */
  private withIdentity(chatId: number, text: string): string {
    const who = findByChat(this.roster, chatId);
    if (!who || who.role === "owner" || this.guestIntroSent.has(chatId)) return text;
    this.guestIntroSent.add(chatId);
    const ownerName = this.roster.participants.find((p) => p.role === "owner")?.name ?? "the owner";
    return (
      `(System: You are messaging with ${who.name}, a guest ${ownerName} authorized — NOT ${ownerName}. ` +
      `Be warm and address them by name. Do not reveal ${ownerName}'s private projects, plans, finances, or data.)\n\n` +
      text
    );
  }

  // ─── "typing…" while a turn is in flight ───────────────────────────────
  private startTyping(chatId: number): void {
    if (!this.api.sendChatAction || this.typingTimers.has(chatId)) return;
    const tick = (): void => {
      void this.api.sendChatAction?.(chatId, "typing").catch(() => undefined);
      this.typingTimers.set(chatId, this.timers.setTimeout(tick, TYPING_REFRESH_MS));
    };
    tick();
  }

  private stopTyping(chatId: number): void {
    const timer = this.typingTimers.get(chatId);
    if (timer !== undefined) this.timers.clearTimeout(timer);
    this.typingTimers.delete(chatId);
  }

  private onEvent(sessionId: string, event: TurnEvent): void {
    const chatId = this.sessionToChat.get(sessionId);
    if (chatId === undefined) return;
    switch (event.type) {
      case "text_delta":
        this.turnText.set(sessionId, (this.turnText.get(sessionId) ?? "") + event.text);
        break;
      case "tool_start":
        this.pushStatus(chatId, `⚙ ${event.activityDescription}`);
        break;
      case "permission_request":
        this.onPermissionRequest(sessionId, event);
        break;
      case "error":
        // Remember the failure; turn_end decides whether to surface it (a turn
        // can recover after a retriable error and still produce text).
        this.turnError.set(sessionId, errorEventText(event));
        break;
      case "turn_end": {
        const text = (this.turnText.get(sessionId) ?? "").trim();
        const err = this.turnError.get(sessionId);
        this.turnText.delete(sessionId);
        this.turnError.delete(sessionId);
        this.clearStatus(chatId);
        this.stopTyping(chatId);
        this.turnInFlight.delete(chatId);
        if (text.length > 0) {
          this.flushTurn(chatId, text);
        } else if (event.status === "failed") {
          // No text produced and the turn failed — tell the owner what broke
          // instead of leaving them staring at a stopped "typing…".
          const reason = err ?? "the model didn't return a reply";
          this.voiceReplyExpected.delete(chatId);
          this.enqueueSend(chatId, async () => {
            await this.api.sendMessage(chatId, `⚠️ I couldn't reply: ${reason}`);
          });
        }
        this.pumpChat(chatId);
        break;
      }
      default:
        break;
    }
  }

  private flushTurn(chatId: number, text: string): void {
    const plain = toTelegramText(text);
    const wantVoice = this.voiceReplyExpected.has(chatId);
    this.voiceReplyExpected.delete(chatId);
    if (wantVoice && this.api.sendVoice) {
      this.enqueueSend(chatId, async () => {
        try {
          const audio = await textToVoice(plain);
          await this.api.sendVoice!(chatId, audio);
        } catch (err) {
          this.log(`voice reply failed, falling back to text: ${errText(err)}`);
          const chunks = chunkMessage(plain);
          for (const chunk of chunks) await this.api.sendMessage(chatId, chunk);
        }
      });
    } else {
      const chunks = chunkMessage(plain);
      this.enqueueSend(chatId, async () => {
        for (const chunk of chunks) await this.api.sendMessage(chatId, chunk);
      });
    }
  }

  // ─── Status throttle (one ⚙ message per turn, ≤1 edit per 3s) ──────────

  private pushStatus(chatId: number, text: string): void {
    let state = this.status.get(chatId);
    if (!state) {
      state = { sending: false, lastEditAt: 0 };
      this.status.set(chatId, state);
    }
    const st = state;

    if (st.messageId === undefined) {
      if (st.sending) {
        st.pendingText = text;
        return;
      }
      st.sending = true;
      st.lastEditAt = this.now();
      void this.api
        .sendMessage(chatId, text)
        .then((msg) => {
          st.sending = false;
          st.messageId = msg.message_id;
          if (st.pendingText !== undefined) this.scheduleStatusFlush(chatId, st);
        })
        .catch((err) => {
          st.sending = false;
          this.log(`status message failed: ${errText(err)}`);
        });
      return;
    }

    const elapsed = this.now() - st.lastEditAt;
    if (elapsed >= STATUS_EDIT_EVERY_MS) {
      st.lastEditAt = this.now();
      st.pendingText = undefined;
      void this.api
        .editMessageText(chatId, st.messageId, text)
        .catch((err) => this.log(`status edit failed: ${errText(err)}`));
    } else {
      st.pendingText = text;
      this.scheduleStatusFlush(chatId, st, STATUS_EDIT_EVERY_MS - elapsed);
    }
  }

  private scheduleStatusFlush(chatId: number, st: StatusState, delayMs = STATUS_EDIT_EVERY_MS): void {
    if (st.timer !== undefined) return;
    st.timer = this.timers.setTimeout(() => {
      st.timer = undefined;
      if (st.messageId === undefined || st.pendingText === undefined) return;
      const text = st.pendingText;
      st.pendingText = undefined;
      st.lastEditAt = this.now();
      void this.api
        .editMessageText(chatId, st.messageId, text)
        .catch((err) => this.log(`status edit failed: ${errText(err)}`));
    }, delayMs);
  }

  private clearStatus(chatId: number): void {
    const st = this.status.get(chatId);
    if (!st) return;
    if (st.timer !== undefined) this.timers.clearTimeout(st.timer);
    this.status.delete(chatId);
  }

  // ─── The Gate over Telegram ────────────────────────────────────────────

  private onApprovalPending(staged: StagedApprovalFrame): void {
    if (!staged || typeof staged.id !== "string" || staged.id.length === 0) return;
    const lines = ["🛡 Approval required"];
    const what = [staged.kind, staged.domain ? `(${staged.domain})` : ""].filter(Boolean).join(" ");
    if (what) lines.push(what);
    if (typeof staged.reason === "string" && staged.reason.length > 0) lines.push(staged.reason);
    const text = lines.join("\n");
    const token = this.callbackToken(staged.id);
    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `ares:approve:${token}` },
          { text: "Deny", callback_data: `ares:deny:${token}` },
        ],
      ],
    };
    // The Gate goes to OWNERS only — a guest must never see (or tap) the owner's
    // approve/deny on money, deploys, or credentials.
    for (const chatId of this.owners) {
      this.enqueueSend(chatId, async () => {
        await this.api.sendMessage(chatId, text, { replyMarkup });
      });
    }
  }

  /** A tool asked for permission (money, mail, publish, credentials, a wipe) on
   *  a remote session. Surface Allow/Deny to the owner's phone. The window is the
   *  tool's watchdog (~20s) — miss it and it auto-denies, the safe failure. */
  private onPermissionRequest(
    sessionId: string,
    event: { id: string; toolName: string; reason: string },
  ): void {
    if (!sessionId || typeof event.id !== "string" || event.id.length === 0) return;
    const token = `p${++this.permTokenSeq}`;
    this.permTokens.set(token, { sessionId, requestId: event.id });
    // Bound the token map so a long-running daemon never leaks entries.
    if (this.permTokens.size > 200) {
      const oldest = this.permTokens.keys().next().value;
      if (oldest !== undefined) this.permTokens.delete(oldest);
    }
    const lines = ["🛡 Permission needed", event.toolName];
    if (typeof event.reason === "string" && event.reason.length > 0) lines.push(event.reason);
    lines.push("Tap within ~20s or it auto-denies.");
    const text = lines.join("\n");
    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: `ares:perm:allow:${token}` },
          { text: "🚫 Deny", callback_data: `ares:perm:deny:${token}` },
        ],
      ],
    };
    for (const chatId of this.owners) {
      this.enqueueSend(chatId, async () => {
        await this.api.sendMessage(chatId, text, { replyMarkup });
      });
    }
  }

  /** Telegram caps callback_data at 64 bytes; oversized ids get a short token. */
  private callbackToken(approvalId: string): string {
    if (Buffer.byteLength(`ares:approve:${approvalId}`, "utf8") <= 64) return approvalId;
    for (const [token, id] of this.approvalTokens) {
      if (id === approvalId) return token;
    }
    const token = `t${++this.approvalTokenSeq}`;
    this.approvalTokens.set(token, approvalId);
    return token;
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────

  private sendFrame(frame: ClientFrame): void {
    const socket = this.ws;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch (err) {
      this.log(`gateway send failed: ${errText(err)}`);
    }
  }

  private enqueueSend(chatId: number, task: () => Promise<void>): void {
    const prev = this.sendChains.get(chatId) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => this.log(`telegram send to ${chatId} failed: ${errText(err)}`));
    this.sendChains.set(chatId, next);
  }

  /** Abort-aware sleep on the injectable timer — stop() never hangs in it. */
  private sleepMs(ms: number): Promise<void> {
    const signal = this.abort.signal;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let handle: unknown;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", onAbort);
        if (handle !== undefined) this.timers.clearTimeout(handle);
        resolve();
      };
      const onAbort = (): void => finish();
      signal.addEventListener("abort", onAbort, { once: true });
      handle = this.timers.setTimeout(finish, ms);
    });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A human-readable line for an engine error event, surfaced to the chat. */
function errorEventText(event: { error?: { code?: string; message?: string } }): string {
  const message = event.error?.message?.trim();
  if (message) return message;
  const code = event.error?.code;
  return code ? `error (${code})` : "the model returned an error";
}
