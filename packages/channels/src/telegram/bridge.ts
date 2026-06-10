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

/** The api surface the bridge needs — TelegramApi satisfies it; fakes are trivial. */
export interface TelegramApiLike {
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<TgMessage>;
  editMessageText(chatId: number, messageId: number, text: string): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void>;
}

export interface BridgeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TelegramBridgeOptions {
  api: TelegramApiLike;
  gateway: { url: string; token: string };
  allowedChatIds: number[];
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
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const STATUS_EDIT_EVERY_MS = 3_000;
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
  private readonly allowed: Set<number>;
  private readonly WS: WebSocketCtor;
  private readonly timers: BridgeTimers;
  private readonly now: () => number;
  private readonly pollTimeoutS: number;
  private readonly clientName: string;
  private readonly log: (line: string) => void;

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
  /** Accumulated text_delta per session for the in-flight turn. */
  private readonly turnText = new Map<string, string>();
  private readonly status = new Map<number, StatusState>();
  private readonly refused = new Set<number>();
  /** Per-chat outbound chains keep Telegram message order deterministic. */
  private readonly sendChains = new Map<number, Promise<void>>();
  /** Short callback tokens for approval ids too long for callback_data (64 bytes). */
  private readonly approvalTokens = new Map<string, string>();
  private approvalTokenSeq = 0;

  constructor(opts: TelegramBridgeOptions) {
    this.api = opts.api;
    this.gatewayUrl = opts.gateway.url;
    this.gatewayToken = opts.gateway.token;
    this.allowed = new Set(opts.allowedChatIds);
    this.WS = opts.wsImpl ?? (WebSocket as unknown as WebSocketCtor);
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.now = opts.now ?? Date.now;
    this.pollTimeoutS = opts.pollTimeoutS ?? 25;
    this.clientName = opts.clientName ?? "telegram";
    this.log = opts.log ?? (() => undefined);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.backoffMs = RECONNECT_MIN_MS;
    this.connect();
    this.pollPromise = this.pollLoop();
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
    if (message?.text !== undefined && message.chat) {
      const chatId = message.chat.id;
      if (!this.allowed.has(chatId)) {
        this.refuseOnce(chatId);
        return;
      }
      if (message.text.trim().length > 0) this.onChatText(chatId, message.text);
      return;
    }
    if (update.callback_query) this.handleCallback(update.callback_query);
  }

  private refuseOnce(chatId: number): void {
    if (this.refused.has(chatId)) return;
    this.refused.add(chatId);
    this.enqueueSend(chatId, async () => {
      await this.api.sendMessage(chatId, REFUSAL_TEXT);
    });
  }

  private onChatText(chatId: number, text: string): void {
    const sessionId = this.chatToSession.get(chatId);
    if (sessionId !== undefined && this.connected) {
      this.sendFrame({ type: "session.send", sessionId, text });
      return;
    }
    const queue = this.pendingTexts.get(chatId);
    if (queue) queue.push(text);
    else this.pendingTexts.set(chatId, [text]);
    if (this.connected) this.requestSession(chatId);
  }

  private requestSession(chatId: number): void {
    if (this.createQueue.includes(chatId)) return;
    this.createQueue.push(chatId);
    this.sendFrame({ type: "session.create" });
  }

  private handleCallback(cq: TgCallbackQuery): void {
    // Untrusted payload: from/message may be absent despite the declared shape.
    const chatId: number | undefined = cq.message?.chat?.id ?? cq.from?.id;
    const match = cq.data === undefined ? null : /^ares:(approve|deny):(.+)$/.exec(cq.data);
    if (!match || chatId === undefined || !this.allowed.has(chatId)) {
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
    this.createQueue.length = 0;
    for (const chatId of this.pendingTexts.keys()) this.requestSession(chatId);
  }

  private onSessionCreated(sessionId: string): void {
    const chatId = this.createQueue.shift();
    if (chatId === undefined) return; // unsolicited — another client's create
    this.chatToSession.set(chatId, sessionId);
    this.sessionToChat.set(sessionId, chatId);
    const texts = this.pendingTexts.get(chatId) ?? [];
    this.pendingTexts.delete(chatId);
    for (const text of texts) this.sendFrame({ type: "session.send", sessionId, text });
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
      case "turn_end": {
        const text = (this.turnText.get(sessionId) ?? "").trim();
        this.turnText.delete(sessionId);
        this.clearStatus(chatId);
        if (text.length > 0) this.flushTurn(chatId, text);
        break;
      }
      default:
        break;
    }
  }

  private flushTurn(chatId: number, text: string): void {
    const chunks = chunkMessage(text);
    this.enqueueSend(chatId, async () => {
      for (const chunk of chunks) await this.api.sendMessage(chatId, chunk);
    });
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
    for (const chatId of this.allowed) {
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
