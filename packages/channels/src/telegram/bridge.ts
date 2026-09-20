// TelegramBridge — a channel that is a pure Garrison gateway client.
// Telegram DMs in, sessions out: one session per allowed chat (created lazily,
// recreated after reconnect).
//
// The surface is built around one rule: a turn costs the owner ONE notification.
//   • The reply streams into a single message that is EDITED in place. Telegram
//     pushes on a new message, not on an edit, so a long answer arrives as one
//     growing bubble instead of a paragraph (and a buzz) every three seconds.
//     Only a reply too long to read as bubbles splits — into a preview plus the
//     full .md as a document.
//   • Tool calls accumulate on one activity card (activity.ts): every step with
//     its duration, failures included, collapsing at turn_end into a receipt.
//   • Permission prompts (prompts.ts) show the actual command/path/URL, collapse
//     duplicate questions onto one card, go to the owner who is in the
//     conversation, and close out into a record once answered.
//   • A tool that trips over an unconnected service gets its sign-in offered
//     in-thread rather than failing with an OAUTH error nobody sees.
//   • A message typed mid-turn STEERS the live turn; /stop interrupts it.
//
// Everything is injectable — api, websocket ctor, timers, clock — so tests run
// hermetic.

import WebSocket from "ws";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PermissionPromptDecision, TurnEvent } from "@ares/protocol";
import type {
  ApprovalVerb,
  ClientFrame,
  GarrisonEventFrame,
  GatewayAttachment,
  ServerFrame,
  StagedApprovalFrame,
  WebSocketCtor,
  WebSocketLike,
} from "../types.js";
import type { InlineKeyboardMarkup, SendMediaOptions, SendMessageOptions, TgCallbackQuery, TgMessage, TgUpdate } from "./api.js";
import { isVisionImageType, mediaTypeForName, TelegramApiError } from "./api.js";
import { voiceToText } from "./stt.js";
import { textToVoice } from "./edgeTts.js";
import { parseTelegramCommand, handleTelegramCommand, type TelegramCommandDeps } from "./commands.js";
import { sendConnectMenu, sendConnectOffer, handleConnectCallback, parseConnectCallback, type ConnectFlowDeps } from "./connect.js";
import {
  newActivityCard,
  renderActivityCard,
  renderActivitySummary,
  shortFailureDetail,
  type ActivityCardState,
} from "./activity.js";
import {
  describePermissionInput,
  oauthProviderFromError,
  permissionKey,
  renderPermissionOutcome,
  renderPermissionPrompt,
} from "./prompts.js";
import {
  detectRemotePcIntent,
  parseRemotePcCallback,
  buildLinkMessage,
  buildPcConnectedMessage,
  buildPcContextPrefix,
  type RemotePcBridgeDeps,
} from "./remotePC.js";
import {
  allowedChatIds as rosterAllowed,
  emptyRoster,
  findByChat,
  markSeen,
  ownerChatIds as rosterOwners,
  removeParticipant,
  renderWho,
  seedOwners,
  tenantForChat,
  upsertParticipant,
  type RosterData,
} from "./roster.js";

/** The api surface the bridge needs — TelegramApi satisfies it; fakes are trivial. */
export interface TelegramApiLike {
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, opts?: SendMessageOptions): Promise<TgMessage>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: { replyMarkup?: InlineKeyboardMarkup; parseMode?: "HTML" },
  ): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void>;
  /** Optional "typing…" hint. Absent on old fakes → the bridge skips it. */
  sendChatAction?(chatId: number, action?: "typing", signal?: AbortSignal): Promise<void>;
  /** Download a file by file_id. Absent on old fakes → voice messages are skipped. */
  getFile?(fileId: string, signal?: AbortSignal): Promise<{ file_id: string; file_path?: string; file_size?: number }>;
  downloadFile?(filePath: string, signal?: AbortSignal): Promise<Buffer>;
  sendVoice?(chatId: number, voice: Buffer, opts?: { caption?: string; signal?: AbortSignal }): Promise<TgMessage>;
  /** Media out. Absent on old fakes → screenshots/files fall back to text. */
  sendPhoto?(chatId: number, image: Buffer, opts?: SendMediaOptions): Promise<TgMessage>;
  sendDocument?(chatId: number, file: Buffer, opts?: SendMediaOptions): Promise<TgMessage>;
}

/** One queued input for a chat: what they typed plus any photos they attached. */
export interface PendingInput {
  text: string;
  attachments?: GatewayAttachment[];
}

/** Escape the three characters Telegram's HTML mode reserves (plus quotes for hrefs). */
/** Telegram answers a status edit with 400 "message is not modified" when the
 *  target already shows exactly the requested text. That is a no-op SUCCESS:
 *  the status the user sees is already correct. Logging it as a failure made
 *  healthy turns read as stuck ones in the log. */
function isNoopStatusEditError(err: unknown): boolean {
  return /message is not modified/i.test(errText(err));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render Ares's markdown as Telegram HTML: bold, code, pre blocks, links and
 * bullets survive; everything else is escaped text. HTML mode is far more
 * forgiving than MarkdownV2 (only <, > and & need escaping), and the bridge
 * still falls back to `toTelegramText` if Telegram rejects the entities.
 */
export function toTelegramHtml(md: string): string {
  const fences: string[] = [];
  // Pull fenced blocks out first so nothing inside them gets bold/italic'd.
  let text = md.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) => {
    fences.push(`<pre>${escapeHtml(String(code).replace(/\n+$/, ""))}</pre>`);
    return `${fences.length - 1}`;
  });
  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^_\w])__([^_\n]+)__(?!\w)/g, "$1<b>$2</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.replace(/(\d+)/g, (_m, i) => fences[Number(i)] ?? "");
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
  /** Remote PC deps. When set, Ares can connect to a coworker's PC on the fly
   *  via a one-time download link sent over Telegram. */
  remotePcDeps?: RemotePcBridgeDeps;
  /** Ares home; non-image documents the user sends land in
   *  <home>/telegram/inbox/<chatId>/ so the agent can Read them. Default: tmpdir. */
  home?: string;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Force-release a chat whose turn has been silent this long, so a genuinely
 *  lost turn_end can't block the chat forever. OFF by default — a turn may
 *  legitimately go quiet for a long tool call, and releasing early lets a
 *  second turn start underneath the first. Keyed off the LAST event received,
 *  not dispatch time. Set ARES_BRIDGE_TURN_SILENCE_MS>0 to re-enable. */
const BRIDGE_TURN_SILENCE_MS =
  Math.max(0, Number(process.env.ARES_BRIDGE_TURN_SILENCE_MS) || 0);
const STATUS_EDIT_EVERY_MS = 3_000;
/** Telegram clears "typing…" after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_000;
const CHUNK_LIMIT = 4_000;
const MAX_CHUNKS = 8;
const TRUNCATION_MARKER = "…[truncated]";
/** How often the live reply bubble is re-edited mid-turn. Telegram pushes a
 *  notification for a NEW message but not for an edit, so streaming in place
 *  costs one buzz per turn instead of one per paragraph. */
const STREAM_FLUSH_MS = 3_000;
const STREAM_FLUSH_MIN_CHARS = 80;
/** How long an answered permission prompt stays deduplicated. A tool that
 *  re-asks the identical question inside this window reuses the live prompt
 *  instead of posting a second one. */
const PERM_DEDUPE_MS = 10 * 60_000;
/** Don't offer the same connector twice in a row inside this window — a tool
 *  retrying against an unconnected service must not paper the chat. */
const CONNECT_OFFER_COOLDOWN_MS = 5 * 60_000;
/** Replies longer than this go out as a short preview plus a .md document —
 *  a wall of eight 4k bubbles is unreadable on a phone. */
const FILE_FALLBACK_CHARS = CHUNK_LIMIT * 2;
/** Telegram's inbound photo/document ceiling for bots (20MB); we stop lower. */
const MAX_INBOUND_BYTES = 15 * 1024 * 1024;
/** Photos in an album arrive as separate updates ~ms apart; hold this long. */
const ALBUM_HOLD_MS = 800;
/** Telegram caps sendPhoto at 10MB. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
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

/**
 * Where to seal a bubble that has grown past Telegram's limit: the last
 * paragraph break, else the last line break, else the last space. Splitting on
 * a boundary keeps the continuation from starting mid-word.
 */
export function splitPoint(slice: string): number {
  for (const sep of ["\n\n", "\n", " "]) {
    const at = slice.lastIndexOf(sep);
    // Refuse a boundary so early that the bubble would be mostly empty.
    if (at > slice.length / 2) return at + sep.length;
  }
  return slice.length;
}

/**
 * The longest prefix of `markdown` whose Telegram rendering fits `limit`,
 * ending on a paragraph/line/word boundary. Rendering is not length-preserving
 * (markers are stripped, entities escaped), so the fit is found by search over
 * the rendered length rather than assumed from the source.
 */
export function fitMarkdown(markdown: string, limit: number): string {
  if (toTelegramText(markdown).length <= limit) return markdown;
  let lo = 0;
  let hi = markdown.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (toTelegramText(markdown.slice(0, mid)).length <= limit) lo = mid;
    else hi = mid - 1;
  }
  return markdown.slice(0, splitPoint(markdown.slice(0, lo))).trimEnd();
}

/** The live activity card for one chat's in-flight turn (see activity.ts). */
interface CardState extends ActivityCardState {
  messageId?: number;
  lastEditAt: number;
  /** An edit is wanted but the throttle hasn't let it through yet. */
  dirty: boolean;
  timer?: unknown;
}

/**
 * One reply being streamed into Telegram in place: the message it lives in,
 * what was last written there, and the edit throttle's bookkeeping.
 */
interface ReplyStream {
  chatId: number;
  messageId?: number;
  lastEditAt: number;
  /** Markdown last written to the bubble — skips no-op edits. */
  lastSent: string;
  dirty: boolean;
  timer?: unknown;
}

/** A permission question on the owner's phone, and every request it answers. */
interface PermPrompt {
  token: string;
  key: string;
  sessionId: string;
  toolName: string;
  detail?: string;
  requestIds: string[];
  messages: Array<{ chatId: number; messageId: number }>;
  askedAt: number;
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
  private staleTurnTimer?: unknown;
  private reconnectTimer?: unknown;
  private pollPromise?: Promise<void>;

  private readonly chatToSession = new Map<number, string>();
  private readonly sessionToChat = new Map<string, number>();
  /** FIFO of chats awaiting session.created — the wire has no correlation id. */
  private readonly createQueue: number[] = [];
  /** Inputs buffered while a chat has no session (or the gateway is down). */
  private readonly pendingInputs = new Map<number, PendingInput[]>();
  /** Albums (media_group_id) being coalesced into one input. */
  private readonly albums = new Map<string, { chatId: number; texts: string[]; attachments: GatewayAttachment[]; timer: unknown }>();
  /** Last screenshot a tool wrote this turn (ComputerUse / RemotePC), by session —
   *  forwarded as a photo at turn_end so the phone sees what Ares saw. */
  private readonly turnScreenshot = new Map<string, string>();
  /** Screenshot paths already forwarded — never spam the same frame twice. */
  private readonly forwardedScreenshots = new Set<string>();
  /** Sessions that already got the "you're on Telegram" preamble. */
  private readonly surfaceIntroSent = new Set<number>();
  private readonly home: string;
  /** Chats with one user turn currently in flight through the Garrison.
   *  Value is the epoch-ms of the last event received (or dispatch time if
   *  no events yet).  A turn silent for BRIDGE_TURN_SILENCE_MS is
   *  force-released so the chat is not blocked forever. */
  private readonly turnInFlight = new Map<number, number>();
  /** All text_delta accumulated this turn, per session. Never truncated
   *  mid-turn: the live bubble is re-rendered from it on every edit. */
  private readonly turnText = new Map<string, string>();
  /** The reply message each session is currently streaming into. */
  private readonly replyStreams = new Map<string, ReplyStream>();
  /** Per-session timer that re-renders the live bubble on the throttle. */
  private readonly streamFlushTimers = new Map<string, unknown>();
  /** Last error reported by the engine this turn — surfaced on a failed turn_end
   *  so a provider failure (bad/missing key, rate limit, network) is never a
   *  silent "typing… then nothing". */
  private readonly turnError = new Map<string, string>();
  /** Live activity card per chat — replaces the old single-line ⚙ status. */
  private readonly cards = new Map<number, CardState>();
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
  /** Live tool-permission prompts by callback token. */
  private readonly permPrompts = new Map<string, PermPrompt>();
  /** tool+input identity → the token already asking it, so a retrying tool
   *  reuses one prompt instead of posting the same question again. */
  private readonly permByKey = new Map<string, string>();
  private permTokenSeq = 0;
  /** chat|provider → when we last offered that connector, for the cooldown. */
  private readonly connectOffers = new Map<string, number>();
  /** Chats whose last inbound was a voice message — reply with a voice note. */
  private readonly voiceReplyExpected = new Set<number>();

  // ─── Remote PC state ────────────────────────────────────────────────────
  private readonly remotePcDeps?: RemotePcBridgeDeps;
  /** chatId → active PC id for chats that have an established remote connection. */
  private readonly chatActivePc = new Map<number, { id: string; hostname: string; os: string; ip: string; label: string }>();
  /** Cleanup fns returned by remotePcDeps event subscriptions. */
  private unsubRemotePcConnected?: () => void;
  private unsubRemotePcDisconnected?: () => void;

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
    this.remotePcDeps = opts.remotePcDeps;
    this.home = opts.home ?? path.join(os.tmpdir(), "ares-telegram");
    if (opts.remotePcDeps) this.subscribeRemotePcEvents(opts.remotePcDeps);
  }

  // ─── Public send surface (the agent's Telegram tool + outbound helpers) ──

  /** Which chat a garrison session belongs to, if it is one of ours. */
  chatForSession(sessionId: string): number | undefined {
    return this.sessionToChat.get(sessionId);
  }

  /** Owner chat ids (the phones that get proactive sends). */
  ownerChats(): number[] {
    return [...this.owners];
  }

  /** Send text to a chat, ordered behind anything already queued for it. */
  sendTextTo(chatId: number, text: string): Promise<void> {
    return this.enqueueSendAwait(chatId, async () => {
      await this.deliverText(chatId, text);
    });
  }

  /** Send an image to a chat as an inline photo (falls back to a document over 10MB). */
  sendPhotoTo(chatId: number, image: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<void> {
    return this.enqueueSendAwait(chatId, async () => {
      if (!this.api.sendPhoto) throw new Error("this Telegram client cannot send photos");
      if (image.byteLength > MAX_PHOTO_BYTES && this.api.sendDocument) {
        await this.api.sendDocument(chatId, image, { caption: opts.caption, filename: opts.filename ?? "image.png" });
        return;
      }
      await this.api.sendPhoto(chatId, image, { caption: opts.caption, filename: opts.filename });
    });
  }

  /** Send any file to a chat as a document. */
  sendDocumentTo(chatId: number, file: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<void> {
    return this.enqueueSendAwait(chatId, async () => {
      if (!this.api.sendDocument) throw new Error("this Telegram client cannot send documents");
      await this.api.sendDocument(chatId, file, { caption: opts.caption, filename: opts.filename, contentType: opts.filename ? mediaTypeForName(opts.filename) : undefined });
    });
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
    this.scheduleStaleTurnCheck();
  }

  /** Wire up remote-PC connect/disconnect notifications so the bridge can push
   *  "I see HOSTNAME, want me to connect?" to the owner automatically. */
  private subscribeRemotePcEvents(deps: RemotePcBridgeDeps): void {
    // The owner asked for the link and the token was one-time, so a PC dialing
    // in IS the confirmation. Connect immediately for every owner chat.
    this.unsubRemotePcConnected = deps.onPcConnected((pc) => {
      const { text, keyboard } = buildPcConnectedMessage(pc);
      for (const ownerId of this.owners) {
        this.chatActivePc.set(ownerId, pc);
        this.enqueueSend(ownerId, async () => {
          await this.api.sendMessage(ownerId, text, {
            replyMarkup: { inline_keyboard: keyboard },
          });
        });
      }
      try { deps.notify(pc.id, "Ares Connected"); } catch { /* PC already gone — close follows */ }
    });
    this.unsubRemotePcDisconnected = deps.onPcDisconnected((pc) => {
      let wasActive = false;
      for (const [chatId, active] of this.chatActivePc) {
        if (active.id === pc.id) {
          this.chatActivePc.delete(chatId);
          wasActive = true;
        }
      }
      if (!wasActive) return;
      const note = `🔴 ${pc.hostname} went offline. If they're still around, send them a fresh link and I'll pick back up.`;
      for (const ownerId of this.owners) {
        this.enqueueSend(ownerId, async () => {
          await this.api.sendMessage(ownerId, note);
        });
      }
    });
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
    if (this.staleTurnTimer !== undefined) {
      this.timers.clearTimeout(this.staleTurnTimer);
      this.staleTurnTimer = undefined;
    }
    for (const card of this.cards.values()) {
      if (card.timer !== undefined) this.timers.clearTimeout(card.timer);
    }
    this.cards.clear();
    for (const timer of this.typingTimers.values()) this.timers.clearTimeout(timer);
    this.typingTimers.clear();
    for (const timer of this.streamFlushTimers.values()) this.timers.clearTimeout(timer);
    this.streamFlushTimers.clear();
    for (const album of this.albums.values()) if (album.timer !== undefined) this.timers.clearTimeout(album.timer);
    this.albums.clear();
    this.unsubRemotePcConnected?.();
    this.unsubRemotePcDisconnected?.();
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
    let conflictBackoff = 0;
    while (this.running) {
      let updates: TgUpdate[];
      try {
        updates = await this.api.getUpdates(offset, this.pollTimeoutS, this.abort.signal);
        conflictBackoff = 0;
      } catch (err) {
        if (!this.running) return;
        if (err instanceof TelegramApiError && err.code === 409) {
          conflictBackoff = Math.min((conflictBackoff || 5_000) * 2, 60_000);
          this.log(
            `409 Conflict — another bot instance is polling this token. ` +
            `Retrying in ${Math.round(conflictBackoff / 1000)}s`,
          );
          await this.sleepMs(conflictBackoff);
          continue;
        }
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

      // Photo → the model SEES it (image block beside the caption). A document
      // that is an image is treated the same; any other file lands in the
      // inbox folder and the agent gets its path.
      if ((message.photo?.length || message.document) && this.api.getFile && this.api.downloadFile) {
        this.voiceReplyExpected.delete(chatId);
        this.handleMediaMessage(chatId, message);
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

  /** Download a photo/document, then queue it as one input (coalescing albums). */
  private handleMediaMessage(chatId: number, message: TgMessage): void {
    const caption = message.caption?.trim() ?? "";
    const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined;
    const doc = message.document;
    const fileId = photo?.file_id ?? doc?.file_id;
    if (!fileId) return;
    const declaredSize = photo?.file_size ?? doc?.file_size ?? 0;
    if (declaredSize > MAX_INBOUND_BYTES) {
      this.enqueueSend(chatId, async () => {
        await this.api.sendMessage(chatId, "(That file is over 15 MB — too big for me to pull down. Send a smaller one.)");
      });
      return;
    }
    const docMime = doc ? (doc.mime_type ?? mediaTypeForName(doc.file_name ?? "")) : undefined;
    const isImage = Boolean(photo) || isVisionImageType(docMime);
    const albumKey = message.media_group_id ? `${chatId}:${message.media_group_id}` : undefined;

    this.enqueueSend(chatId, async () => {
      try {
        const meta = await this.api.getFile!(fileId);
        if (!meta.file_path) throw new Error("no file_path in getFile response");
        const bytes = await this.api.downloadFile!(meta.file_path);
        if (bytes.byteLength > MAX_INBOUND_BYTES) throw new Error("file exceeds the inbound limit");
        if (isImage) {
          const mediaType = photo ? "image/jpeg" : (docMime as GatewayAttachment["mediaType"]);
          const attachment: GatewayAttachment = { kind: "image", mediaType, data: bytes.toString("base64") };
          this.log(`photo received (chat ${chatId}, ${Math.round(bytes.byteLength / 1024)}KB)`);
          if (albumKey) this.addToAlbum(albumKey, chatId, caption, attachment);
          else this.onChatInput(chatId, caption || "(The user sent this photo without a caption. Look at it and respond to what it shows.)", [attachment]);
          return;
        }
        // Non-image document: persist to the inbox and hand the agent the path.
        const dir = path.join(this.home, "telegram", "inbox", String(chatId));
        await fs.mkdir(dir, { recursive: true });
        const safeName = (doc?.file_name ?? `file-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
        const target = path.join(dir, `${Date.now()}-${safeName}`);
        await fs.writeFile(target, bytes);
        this.log(`document received (chat ${chatId}): ${target}`);
        const note = `(The user sent a file: ${target} — ${docMime ?? "unknown type"}, ${Math.round(bytes.byteLength / 1024)}KB. Read it with your file tools if the request needs its contents.)`;
        const text = caption ? `${caption}\n\n${note}` : note;
        if (albumKey) this.addToAlbum(albumKey, chatId, text);
        else this.onChatInput(chatId, text);
      } catch (err) {
        this.log(`media message failed: ${errText(err)}`);
        await this.api.sendMessage(chatId, "(I couldn't download that attachment — try sending it again.)").catch(() => {});
      }
    });
  }

  /** Photos sent together share a media_group_id and arrive as separate
   *  updates; hold briefly and ship them as ONE input with every image. */
  private addToAlbum(key: string, chatId: number, text: string, attachment?: GatewayAttachment): void {
    let album = this.albums.get(key);
    if (!album) {
      album = { chatId, texts: [], attachments: [], timer: undefined };
      this.albums.set(key, album);
    }
    if (text) album.texts.push(text);
    if (attachment) album.attachments.push(attachment);
    if (album.timer !== undefined) this.timers.clearTimeout(album.timer);
    const flush = album;
    album.timer = this.timers.setTimeout(() => {
      this.albums.delete(key);
      const caption = flush.texts.join("\n").trim();
      const count = flush.attachments.length;
      const fallback = count > 0 ? `(The user sent ${count} photos without a caption. Look at them and respond to what they show.)` : "";
      this.onChatInput(flush.chatId, caption || fallback, flush.attachments.length > 0 ? flush.attachments : undefined);
    }, ALBUM_HOLD_MS);
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
    // /stop while a turn is running means "stop what you're doing" — that has
    // to beat the operator's mission-level /stop, which is what it meant when
    // nothing was in flight.
    if (this.turnInFlight.has(chatId) && /^\/(stop|cancel|abort)(?:@\w+)?$/i.test(text.trim())) {
      this.interruptTurn(chatId);
      return;
    }

    // /new — drop this chat's session so the next message starts clean. Any
    // allowed chat may reset its OWN thread; it touches nobody else's.
    if (/^\/(new|reset)(?:@\w+)?$/i.test(text.trim())) {
      this.resetChatSession(chatId);
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, "🜂 Fresh thread. What's next?"); });
      return;
    }

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

    // Remote PC fast path — /pcs lists what's connected; an unmistakable
    // "I'm at Sarah's PC" / /pc generates a link. Anything vaguer goes to the
    // agent, which has the RemotePC tool.
    if (this.remotePcDeps && this.owners.has(chatId)) {
      if (/^\/pcs$/i.test(text.trim())) {
        this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, this.renderRemotePcs(chatId)); });
        return;
      }
      const intent = detectRemotePcIntent(text);
      if (intent) {
        void this.handleRemotePcLinkRequest(chatId, intent.label);
        return;
      }
    }

    this.onChatInput(chatId, text);
  }

  /** Queue one conversational input (text, optionally with photos) for a chat. */
  private onChatInput(chatId: number, text: string, attachments?: GatewayAttachment[]): void {
    // Record real conversation activity (not commands) for the owner's /activity.
    const prior = this.activity.get(chatId);
    this.activity.set(chatId, {
      count: (prior?.count ?? 0) + 1,
      lastAt: this.now(),
      lastMessage: (text.replace(/\s+/g, " ").trim() || `[${attachments?.length ?? 0} photo(s)]`).slice(0, 120),
    });

    // If there's an active remote PC for this chat, inject context so the agent
    // knows it can use the RemotePC tool on this session.
    let routedText = text;
    const activePc = this.chatActivePc.get(chatId);
    if (activePc) routedText = buildPcContextPrefix(activePc) + text;

    const input: PendingInput = attachments?.length ? { text: routedText, attachments } : { text: routedText };
    // Steering: a message typed while Ares is mid-turn is a CORRECTION, not the
    // next conversation. It used to sit in the queue until the turn it was
    // meant to change had already finished; now it goes into the live turn at
    // the engine's next safe boundary.
    if (this.steerInput(chatId, input)) return;
    const queue = this.pendingInputs.get(chatId);
    if (queue) queue.push(input);
    else this.pendingInputs.set(chatId, [input]);
    this.pumpChat(chatId);
  }

  /** Route one input into the turn already running for this chat. Returns false
   *  when there's nothing live to steer, so the caller queues it normally. */
  private steerInput(chatId: number, input: PendingInput): boolean {
    if (!this.connected) return false;
    if (!this.turnInFlight.has(chatId)) return false;
    const sessionId = this.chatToSession.get(chatId);
    if (sessionId === undefined) return false;
    // Keep the silence watchdog honest: the turn just received work.
    this.turnInFlight.set(chatId, Date.now());
    this.sendFrame({
      type: "session.send",
      sessionId,
      text: this.withIdentity(chatId, input.text),
      delivery: "steer",
      tenant: tenantForChat(this.roster, chatId),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    // Show it landed immediately; steer_routed upgrades the card when the
    // engine confirms the boundary it took effect at.
    const card = this.card(chatId);
    card.steering = true;
    this.touchCard(chatId);
    return true;
  }

  /** Stop the turn this chat has in flight. */
  private interruptTurn(chatId: number): void {
    const sessionId = this.chatToSession.get(chatId);
    if (sessionId === undefined || !this.connected) {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, "Nothing running right now."); });
      return;
    }
    this.sendFrame({ type: "session.interrupt", sessionId });
    this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, "⏹ Stopping."); });
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

  /** Owner triggered the remote-PC flow ("I'm at Sarah's PC"). Generate a link. */
  private async handleRemotePcLinkRequest(chatId: number, label: string): Promise<void> {
    if (!this.remotePcDeps) return;
    // The tunnel can take a few seconds on a cold start — keep the owner posted.
    void this.api.sendChatAction?.(chatId, "typing").catch(() => undefined);
    let msg: string;
    try {
      const { url, scope } = await this.remotePcDeps.generateToken(label);
      msg = buildLinkMessage(label, url, scope);
    } catch (err) {
      this.log(`remote-pc link failed: ${errText(err)}`);
      msg = "I couldn't create a connect link right now — the remote-PC server isn't up. Try again in a moment.";
    }
    this.enqueueSend(chatId, async () => {
      await this.api.sendMessage(chatId, msg);
    });
  }

  /** The owner's /pcs view: what's connected right now, and which one this chat is driving. */
  private renderRemotePcs(chatId: number): string {
    const pcs = this.remotePcDeps?.listPcs() ?? [];
    if (pcs.length === 0) return "No remote PCs connected. Tell me who needs help and I'll make a link.";
    const active = this.chatActivePc.get(chatId);
    return [
      "🖥 Remote PCs:",
      ...pcs.map((p) => `${active?.id === p.id ? "🟢" : "⚪"} ${p.label} — ${p.hostname} (${p.os})`),
    ].join("\n");
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
    this.surfaceIntroSent.delete(chatId);
  }

  /** Every Telegram session is stamped at creation with its surface and the
   *  sender's tenant, and every send restates the tenant: the garrison keys
   *  guest memory isolation and the cross-surface digest on these stamps. */
  private requestSession(chatId: number): void {
    if (this.createQueue.includes(chatId)) return;
    this.createQueue.push(chatId);
    this.sendFrame({ type: "session.create", surface: "telegram", tenant: tenantForChat(this.roster, chatId) });
  }

  private handleCallback(cq: TgCallbackQuery): void {
    const chatId: number | undefined = cq.message?.chat?.id ?? cq.from?.id;

    // Remote PC callback: ares:remotepc:disconnect:<pcId>
    if (cq.data && chatId !== undefined && this.owners.has(chatId) && this.remotePcDeps) {
      const rpcb = parseRemotePcCallback(cq.data);
      if (rpcb) {
        void this.api.answerCallbackQuery(cq.id, { text: "Disconnected" }).catch(() => undefined);
        const pc = this.remotePcDeps.listPcs().find((p) => p.id === rpcb.pcId);
        for (const [cid, active] of this.chatActivePc) {
          if (active.id === rpcb.pcId) this.chatActivePc.delete(cid);
        }
        if (pc) {
          try { this.remotePcDeps.notify(pc.id, "Ares disconnected — you can close the connector window"); } catch { /* gone */ }
          this.remotePcDeps.disconnect?.(pc.id);
        }
        this.enqueueSend(chatId, async () => {
          await this.api.sendMessage(chatId, pc ? `Disconnected from ${pc.label}.` : "That PC was already gone.");
        });
        return;
      }
    }

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

    // Tool-permission callback: ares:perm:<allow|always|deny>:<token>
    const permMatch = cq.data === undefined ? null : /^ares:perm:(allow|always|deny):(.+)$/.exec(cq.data);
    if (permMatch && chatId !== undefined && this.owners.has(chatId)) {
      if (!this.connected) {
        void this.api.answerCallbackQuery(cq.id, { text: "Gateway offline — try again shortly." }).catch(() => undefined);
        return;
      }
      const decision: PermissionPromptDecision =
        permMatch[1] === "allow" ? "allow_once" : permMatch[1] === "always" ? "allow_always" : "deny";
      if (!this.resolvePermission(permMatch[2], decision)) {
        void this.api.answerCallbackQuery(cq.id, { text: "Expired — already decided." }).catch(() => undefined);
        return;
      }
      const ack = decision === "allow_once" ? "Allowed" : decision === "allow_always" ? "Allowed — no more prompts for this tool" : "Denied";
      void this.api.answerCallbackQuery(cq.id, { text: ack }).catch(() => undefined);
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
      case "garrison.event":
        this.onGarrisonEvent(frame.event);
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
    for (const timer of this.streamFlushTimers.values()) this.timers.clearTimeout(timer);
    this.streamFlushTimers.clear();
    // New sessions after a reconnect → re-introduce guests to the fresh session.
    this.guestIntroSent.clear();
    this.surfaceIntroSent.clear();
    this.turnScreenshot.clear();
    this.createQueue.length = 0;
    for (const chatId of this.pendingInputs.keys()) this.requestSession(chatId);
  }

  private onSessionCreated(sessionId: string): void {
    const chatId = this.createQueue.shift();
    if (chatId === undefined) return; // unsolicited — another client's create
    this.chatToSession.set(chatId, sessionId);
    this.sessionToChat.set(sessionId, chatId);
    this.pumpChat(chatId);
  }

  private pumpChat(chatId: number): void {
    if (!this.connected) return;
    const lastActivityAt = this.turnInFlight.get(chatId);
    if (lastActivityAt !== undefined) {
      const silent = Date.now() - lastActivityAt;
      if (BRIDGE_TURN_SILENCE_MS > 0 && silent >= BRIDGE_TURN_SILENCE_MS) {
        this.log(`turn for chat ${chatId} silent for ${Math.round(silent / 1000)}s — force-releasing`);
        this.turnInFlight.delete(chatId);
        this.stopTyping(chatId);
      } else {
        return;
      }
    }
    const queue = this.pendingInputs.get(chatId);
    if (!queue || queue.length === 0) {
      this.pendingInputs.delete(chatId);
      return;
    }

    const sessionId = this.chatToSession.get(chatId);
    if (sessionId === undefined) {
      this.requestSession(chatId);
      return;
    }

    const input = queue.shift();
    if (queue.length === 0) this.pendingInputs.delete(chatId);
    if (input === undefined) return;
    this.turnInFlight.set(chatId, Date.now());
    this.startTyping(chatId);
    this.sendFrame({
      type: "session.send",
      sessionId,
      text: this.withIdentity(chatId, input.text),
      tenant: tenantForChat(this.roster, chatId),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
  }

  /** Periodically pump chats that have in-flight turns so the stale-turn
   *  timeout in pumpChat fires even when no new Telegram messages arrive. */
  private scheduleStaleTurnCheck(): void {
    if (!this.running || BRIDGE_TURN_SILENCE_MS <= 0) return;
    this.staleTurnTimer = this.timers.setTimeout(() => {
      if (!this.running) return;
      for (const chatId of this.turnInFlight.keys()) this.pumpChat(chatId);
      this.scheduleStaleTurnCheck();
    }, 30_000);
  }

  /** The FIRST turn of every Telegram session gets a one-time preamble: Ares is
   *  on a phone, so it can't assume the user sees its screen or files — it must
   *  SEND them (the Telegram tool), keep replies phone-sized, and knows it has
   *  full hands (browser via ComputerUse on this machine, paired PCs, alarms).
   *  A guest additionally gets the identity note that keeps the owner private. */
  private withIdentity(chatId: number, text: string): string {
    const notes: string[] = [];
    if (!this.surfaceIntroSent.has(chatId)) {
      this.surfaceIntroSent.add(chatId);
      notes.push(
        "(System: This conversation is over Telegram on the user's phone; they are away from the computer. " +
        "They cannot see your screen, tool output, or files — if something is worth showing (a screenshot, a listing, a photo, a document), " +
        "SEND it with the Telegram tool (photo/file) instead of describing it. The last screenshot you take in a turn is forwarded automatically. " +
        "Keep replies short and phone-readable. You still have your full hands: ComputerUse drives this machine's desktop and browser (log-in sites, marketplaces, shopping, bookings), " +
        "RemotePC drives the user's paired PCs, Remind sets alarms, GoogleCalendar/Gmail when connected, Bash/PowerShell for anything scripted. " +
        "Photos the user sends arrive as images you can see. Do the task end-to-end and report the result; ask only when genuinely blocked.)",
      );
    }
    const who = findByChat(this.roster, chatId);
    if (who && who.role !== "owner" && !this.guestIntroSent.has(chatId)) {
      this.guestIntroSent.add(chatId);
      const ownerName = this.roster.participants.find((p) => p.role === "owner")?.name ?? "the owner";
      notes.push(
        `(System: You are messaging with ${who.name}, a guest ${ownerName} authorized — NOT ${ownerName}. ` +
        `Be warm and address them by name. Do not reveal ${ownerName}'s private projects, plans, finances, or data.)`,
      );
    }
    return notes.length > 0 ? `${notes.join("\n\n")}\n\n${text}` : text;
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
    if (this.turnInFlight.has(chatId)) this.turnInFlight.set(chatId, Date.now());
    switch (event.type) {
      case "text_delta":
        this.turnText.set(sessionId, (this.turnText.get(sessionId) ?? "") + event.text);
        this.scheduleStreamFlush(sessionId, chatId);
        break;
      case "tool_start": {
        // The reply is NOT flushed into a new bubble here any more: a tool call
        // mid-sentence used to split the answer across messages, which is what
        // made a single reply arrive as four paragraphs and four buzzes.
        const card = this.card(chatId);
        card.steps.push({ id: event.id, label: event.activityDescription, startedAt: this.now(), state: "running" });
        this.touchCard(chatId);
        break;
      }
      case "tool_end": {
        this.finishStep(chatId, event.id, "ok");
        // ComputerUse / RemotePC write their screenshot to disk and report the
        // path; remember the latest so turn_end can forward it as a photo.
        const shot = screenshotPathOf(event.output);
        if (shot) this.turnScreenshot.set(sessionId, shot);
        // A tool can report a service it can't reach as a completed failure
        // rather than a throw — catch the connector offer on both paths.
        this.offerConnectorFor(chatId, event.output);
        break;
      }
      case "tool_error":
        // Before this, tool_error had no renderer at all: a failed tool call
        // was invisible on the phone, which is most of "it went quiet on me".
        this.finishStep(chatId, event.id, "failed", shortFailureDetail(event.error));
        this.offerConnectorFor(chatId, event.error);
        break;
      case "permission_request":
        this.onPermissionRequest(sessionId, event);
        break;
      case "steer_routed": {
        // The correction landed in the live turn — say so on the card rather
        // than in a message of its own.
        const card = this.card(chatId);
        card.steering = true;
        this.touchCard(chatId);
        break;
      }
      case "error":
        // Remember the failure; turn_end decides whether to surface it (a turn
        // can recover after a retriable error and still produce text).
        this.turnError.set(sessionId, errorEventText(event));
        this.offerConnectorFor(chatId, errorEventText(event));
        break;
      case "turn_end": {
        const text = (this.turnText.get(sessionId) ?? "").trim();
        const err = this.turnError.get(sessionId);
        const shot = this.turnScreenshot.get(sessionId);
        this.finalizeCard(chatId);
        this.stopTyping(chatId);
        this.turnInFlight.delete(chatId);
        if (text.length > 0) {
          this.flushTurn(sessionId, chatId, text);
        }
        this.cancelStreamFlush(sessionId);
        this.turnText.delete(sessionId);
        this.turnError.delete(sessionId);
        this.turnScreenshot.delete(sessionId);
        this.replyStreams.delete(sessionId);
        if (shot) this.forwardScreenshot(chatId, shot);
        if (text.length === 0 && event.status === "failed") {
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

  // ─── Mid-turn streaming ────────────────────────────────────────────────

  private scheduleStreamFlush(sessionId: string, chatId: number, delayMs = STREAM_FLUSH_MS): void {
    if (this.streamFlushTimers.has(sessionId)) return;
    this.streamFlushTimers.set(
      sessionId,
      this.timers.setTimeout(() => {
        this.streamFlushTimers.delete(sessionId);
        this.doStreamFlush(sessionId, chatId);
      }, delayMs),
    );
  }

  private cancelStreamFlush(sessionId: string): void {
    const timer = this.streamFlushTimers.get(sessionId);
    if (timer !== undefined) {
      this.timers.clearTimeout(timer);
      this.streamFlushTimers.delete(sessionId);
    }
  }

  /**
   * Re-render the live reply bubble from everything said so far. The bubble is
   * EDITED, not re-sent: a normal reply is one message that grows, instead of
   * a new message every three seconds. Only when the current bubble would pass
   * Telegram's size limit is it sealed and a fresh one opened.
   */
  private doStreamFlush(sessionId: string, chatId: number): void {
    this.cancelStreamFlush(sessionId);
    // A voice reply is spoken whole at turn_end — streaming text under it would
    // say everything twice.
    if (this.voiceReplyExpected.has(chatId)) return;
    const full = this.turnText.get(sessionId) ?? "";
    if (full.trim().length < STREAM_FLUSH_MIN_CHARS) return;
    const stream = this.stream(sessionId, chatId);
    const since = this.now() - stream.lastEditAt;
    if (stream.lastEditAt > 0 && since < STREAM_FLUSH_MS) {
      stream.dirty = true;
      this.scheduleStreamFlush(sessionId, chatId, STREAM_FLUSH_MS - since);
      return;
    }
    stream.dirty = false;
    stream.lastEditAt = this.now();
    // Mid-turn the bubble carries as much as fits; a reply that outgrows one
    // message is finished as a preview plus the .md at turn_end, never as a
    // run of bubbles.
    this.writeBubble(stream, fitMarkdown(full, CHUNK_LIMIT));
  }

  private stream(sessionId: string, chatId: number): ReplyStream {
    let stream = this.replyStreams.get(sessionId);
    if (!stream) {
      stream = { chatId, lastEditAt: 0, lastSent: "", dirty: false };
      this.replyStreams.set(sessionId, stream);
    }
    return stream;
  }

  /** Send-or-edit the live bubble, ordered behind the chat's other sends so a
   *  screenshot can't overtake the text it belongs to. */
  private writeBubble(stream: ReplyStream, markdown: string): void {
    const trimmed = markdown.trim();
    if (trimmed.length === 0 || trimmed === stream.lastSent) return;
    stream.lastSent = trimmed;
    const chatId = stream.chatId;
    this.enqueueSend(chatId, async () => {
      const plain = toTelegramText(trimmed);
      const html = toTelegramHtml(trimmed);
      // Markup can outgrow the limit even when the text fits — then send plain.
      const body = html.length <= CHUNK_LIMIT ? html : plain;
      const asHtml = body === html;
      if (stream.messageId === undefined) {
        const msg = await this.sendFormatted(chatId, body, plain);
        if (msg) stream.messageId = msg.message_id;
        return;
      }
      try {
        await this.api.editMessageText(chatId, stream.messageId, body, asHtml ? { parseMode: "HTML" } : {});
      } catch (err) {
        if (isNoopStatusEditError(err)) return;
        // A partial stream can carry half an entity; plain text always lands.
        try {
          await this.api.editMessageText(chatId, stream.messageId, plain);
        } catch (plainErr) {
          if (!isNoopStatusEditError(plainErr)) this.log(`reply edit failed: ${errText(plainErr)}`);
        }
      }
    });
  }

  /** Close out a turn's reply: a voice note when one was asked for, the final
   *  edit of the live bubble otherwise — plus the .md when it ran long. */
  private flushTurn(sessionId: string, chatId: number, text: string): void {
    const wantVoice = this.voiceReplyExpected.has(chatId);
    this.voiceReplyExpected.delete(chatId);
    if (wantVoice && this.api.sendVoice) {
      this.enqueueSend(chatId, async () => {
        try {
          const audio = await textToVoice(toTelegramText(text));
          await this.api.sendVoice!(chatId, audio);
        } catch (err) {
          this.log(`voice reply failed, falling back to text: ${errText(err)}`);
          await this.deliverText(chatId, text);
        }
      });
      return;
    }
    this.cancelStreamFlush(sessionId);
    const stream = this.stream(sessionId, chatId);
    const plain = toTelegramText(text);
    if (plain.length <= CHUNK_LIMIT) {
      this.writeBubble(stream, text);
      return;
    }
    // Too long to read as bubbles on a phone: the live bubble becomes the
    // preview, and the whole answer rides along as a document.
    if (this.api.sendDocument) {
      const preview = `${fitMarkdown(text, CHUNK_LIMIT - 200)}\n\n…full reply attached.`;
      this.writeBubble(stream, preview);
      this.enqueueSend(chatId, async () => {
        try {
          await this.api.sendDocument!(chatId, Buffer.from(text, "utf8"), {
            filename: `ares-reply-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
            contentType: "text/markdown",
          });
        } catch (err) {
          this.log(`long reply as document failed, chunking instead: ${errText(err)}`);
          for (const chunk of chunkMessage(plain).slice(1)) {
            await this.api.sendMessage(chatId, chunk).catch(() => undefined);
          }
        }
      });
      return;
    }
    // No document support (an older host): the historical chunked fallback.
    const chunks = chunkMessage(plain);
    this.writeBubble(stream, chunks[0]);
    for (const chunk of chunks.slice(1)) {
      this.enqueueSend(chatId, async () => { await this.api.sendMessage(chatId, chunk); });
    }
  }

  /** Deliver one reply: formatted HTML bubbles, a plain-text fallback if
   *  Telegram rejects the markup, and a preview + .md document when the reply
   *  is too long to read as bubbles. Never throws on a formatting problem. */
  private async deliverText(chatId: number, markdown: string): Promise<void> {
    const plain = toTelegramText(markdown);
    if (plain.length > FILE_FALLBACK_CHARS && this.api.sendDocument) {
      const preview = plain.slice(0, CHUNK_LIMIT - 200).replace(/\s+\S*$/, "") + "\n\n…full reply attached.";
      await this.sendFormatted(chatId, preview, preview);
      try {
        await this.api.sendDocument(chatId, Buffer.from(markdown, "utf8"), {
          filename: `ares-reply-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`,
          contentType: "text/markdown",
        });
        return;
      } catch (err) {
        this.log(`long reply as document failed, chunking instead: ${errText(err)}`);
      }
    }
    if (plain.length <= CHUNK_LIMIT) {
      await this.sendFormatted(chatId, toTelegramHtml(markdown), plain);
      return;
    }
    for (const chunk of chunkMessage(plain)) await this.api.sendMessage(chatId, chunk);
  }

  /** Try HTML mode once; on any rejection send the plain rendering. Returns the
   *  message when exactly one went out, so a streamed reply can keep editing it. */
  private async sendFormatted(chatId: number, html: string, plain: string): Promise<TgMessage | undefined> {
    if (html.length <= CHUNK_LIMIT) {
      try {
        return await this.api.sendMessage(chatId, html, { parseMode: "HTML" });
      } catch (err) {
        this.log(`HTML reply rejected, sending plain: ${errText(err)}`);
      }
    }
    const chunks = chunkMessage(plain);
    let last: TgMessage | undefined;
    for (const chunk of chunks) last = await this.api.sendMessage(chatId, chunk);
    return chunks.length === 1 ? last : undefined;
  }

  /** Forward the turn's last screenshot as a photo so the phone sees what
   *  Ares saw. Best-effort: a missing/oversized file is skipped silently. */
  private forwardScreenshot(chatId: number, file: string): void {
    if (!this.api.sendPhoto || this.forwardedScreenshots.has(file)) return;
    this.forwardedScreenshots.add(file);
    if (this.forwardedScreenshots.size > 500) {
      const oldest = this.forwardedScreenshots.values().next().value;
      if (oldest !== undefined) this.forwardedScreenshots.delete(oldest);
    }
    this.enqueueSend(chatId, async () => {
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(file);
      } catch {
        return; // already cleaned up — nothing to show
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) return;
      try {
        await this.api.sendPhoto!(chatId, bytes, { filename: path.basename(file), contentType: mediaTypeForName(file) });
      } catch (err) {
        this.log(`screenshot forward failed: ${errText(err)}`);
      }
    });
  }

  // ─── The activity card (one message per turn, ≤1 edit per 3s) ──────────

  /** This chat's live card, created on first use. */
  private card(chatId: number): CardState {
    let card = this.cards.get(chatId);
    if (!card) {
      card = { ...newActivityCard(this.now()), lastEditAt: 0, dirty: false };
      this.cards.set(chatId, card);
    }
    return card;
  }

  private finishStep(chatId: number, id: string, state: "ok" | "failed", detail?: string): void {
    const card = this.cards.get(chatId);
    if (!card) return;
    // Last match wins: a retried tool_use id should close its newest attempt.
    for (let i = card.steps.length - 1; i >= 0; i--) {
      const step = card.steps[i];
      if (step.id !== id || step.state !== "running") continue;
      step.state = state;
      step.endedAt = this.now();
      if (detail) step.detail = detail;
      this.touchCard(chatId);
      return;
    }
  }

  /** Re-render the card, throttled. The first render creates the message. */
  private touchCard(chatId: number): void {
    const card = this.cards.get(chatId);
    if (!card) return;
    const elapsed = this.now() - card.lastEditAt;
    if (card.lastEditAt > 0 && elapsed < STATUS_EDIT_EVERY_MS) {
      card.dirty = true;
      if (card.timer === undefined) {
        card.timer = this.timers.setTimeout(() => {
          card.timer = undefined;
          if (!card.dirty) return;
          card.dirty = false;
          card.lastEditAt = this.now();
          this.writeCard(chatId, card, renderActivityCard(card, this.now()));
        }, STATUS_EDIT_EVERY_MS - elapsed);
      }
      return;
    }
    card.dirty = false;
    card.lastEditAt = this.now();
    this.writeCard(chatId, card, renderActivityCard(card, this.now()));
  }

  private writeCard(chatId: number, card: CardState, text: string): void {
    this.enqueueSend(chatId, async () => {
      if (card.messageId === undefined) {
        const msg = await this.api.sendMessage(chatId, text);
        card.messageId = msg.message_id;
        return;
      }
      try {
        await this.api.editMessageText(chatId, card.messageId, text);
      } catch (err) {
        if (!isNoopStatusEditError(err)) this.log(`activity card edit failed: ${errText(err)}`);
      }
    });
  }

  /**
   * Collapse the card into its receipt at turn_end. The old status line was
   * simply abandoned, leaving a stale "⚙ Reading foo.ts" in the chat forever;
   * this leaves "✓ 6 steps · 41s" — or what failed, and why.
   */
  private finalizeCard(chatId: number): void {
    const card = this.cards.get(chatId);
    this.cards.delete(chatId);
    if (!card) return;
    if (card.timer !== undefined) this.timers.clearTimeout(card.timer);
    if (card.messageId === undefined && card.steps.length === 0) return;
    const now = this.now();
    for (const step of card.steps) {
      // A turn can end with a tool still open (interrupt, steer, crash) —
      // don't leave it spinning in the receipt.
      if (step.state === "running") {
        step.state = "failed";
        step.endedAt = now;
        step.detail ??= "never finished";
      }
    }
    this.writeCard(chatId, card, renderActivitySummary(card, now));
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

  /** Daemon-level events. Today: the nightly gauntlet regressed — owners get one
   *  line with the numbers and the triage id, never a guest. Everything else on
   *  this frame is ignored here (the desktop UI renders the full stream). */
  private onGarrisonEvent(event: GarrisonEventFrame | undefined): void {
    if (!event || event.kind !== "gauntlet_regression") return;
    const s = event.summary ?? {};
    const score = typeof s.passed === "number" && typeof s.total === "number" ? `${s.passed}/${s.total}` : "?";
    const prev = event.previous ? ` (was ${event.previous.passed}/${event.previous.total})` : "";
    const lines = [`🜂 Nightly gauntlet regressed${s.suite ? ` — ${s.suite}` : ""}: ${score}${prev}`];
    for (const reason of (event.reasons ?? []).slice(0, 3)) lines.push(`• ${reason}`);
    if (event.findingId) lines.push(`triage: ${event.findingId}`);
    const text = lines.join("\n");
    for (const chatId of this.owners) {
      this.enqueueSend(chatId, async () => {
        await this.api.sendMessage(chatId, text);
      });
    }
  }

  /** A tool asked for permission (money, mail, publish, credentials, a wipe) on
   *  a remote session. Surface Allow/Deny to the owner's phone. The window is the
   *  tool's watchdog (~20s) — miss it and it auto-denies, the safe failure. */
  private onPermissionRequest(
    sessionId: string,
    event: { id: string; toolName: string; reason: string; input?: unknown },
  ): void {
    if (!sessionId || typeof event.id !== "string" || event.id.length === 0) return;

    // Same tool, same input, same session = the same question. A retrying tool
    // used to post it again every time; now the live prompt absorbs the repeat
    // and one tap answers all of them.
    const key = permissionKey(sessionId, event.toolName, event.input);
    const existingToken = this.permByKey.get(key);
    const existing = existingToken ? this.permPrompts.get(existingToken) : undefined;
    if (existing && this.now() - existing.askedAt < PERM_DEDUPE_MS) {
      if (!existing.requestIds.includes(event.id)) existing.requestIds.push(event.id);
      return;
    }

    const token = `p${++this.permTokenSeq}`;
    const detail = describePermissionInput(event.input);
    const prompt: PermPrompt = {
      token,
      key,
      sessionId,
      toolName: event.toolName,
      detail,
      requestIds: [event.id],
      messages: [],
      askedAt: this.now(),
    };
    this.permPrompts.set(token, prompt);
    this.permByKey.set(key, token);
    // Bound both maps so a long-running daemon never leaks entries.
    while (this.permPrompts.size > 200) {
      const oldest = this.permPrompts.keys().next().value;
      if (oldest === undefined) break;
      const dropped = this.permPrompts.get(oldest);
      this.permPrompts.delete(oldest);
      if (dropped && this.permByKey.get(dropped.key) === oldest) this.permByKey.delete(dropped.key);
    }

    const text = renderPermissionPrompt({ toolName: event.toolName, reason: event.reason, detail });
    // "Always" is what makes a phone-driven browser/PC run bearable: the first
    // click asks once, and the other forty clicks of the task never ping.
    const replyMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: `ares:perm:allow:${token}` },
          { text: "✅ Always", callback_data: `ares:perm:always:${token}` },
          { text: "🚫 Deny", callback_data: `ares:perm:deny:${token}` },
        ],
      ],
    };
    // Ask the owner who is actually in this conversation. Fanning every prompt
    // to every owner chat meant two owners saw two copies of everything, and
    // only the first tap ever mattered.
    for (const chatId of this.permissionAudience(sessionId)) {
      this.enqueueSend(chatId, async () => {
        const msg = await this.api.sendMessage(chatId, text, { replyMarkup });
        prompt.messages.push({ chatId, messageId: msg.message_id });
      });
    }
  }

  /**
   * A tool just tripped over a service that isn't connected. Offer the sign-in
   * right here, in the thread, instead of failing with an OAUTH_NOT_AUTHORIZED
   * the owner never sees and a "run /connect" they have to go find.
   */
  private offerConnectorFor(chatId: number, source: unknown): void {
    if (!this.connectDeps || !this.owners.has(chatId)) return;
    const hit = oauthProviderFromError(source);
    if (!hit) return;
    const key = `${chatId}|${hit.provider}`;
    const last = this.connectOffers.get(key);
    if (last !== undefined && this.now() - last < CONNECT_OFFER_COOLDOWN_MS) return;
    this.connectOffers.set(key, this.now());
    this.enqueueSend(chatId, async () => {
      try {
        const offered = await sendConnectOffer(
          { ...this.connectDeps!, api: this.api, log: this.log },
          chatId,
          hit.provider,
          { expired: hit.expired },
        );
        if (!offered) this.connectOffers.delete(key);
      } catch (err) {
        this.connectOffers.delete(key);
        this.log(`connect offer failed: ${errText(err)}`);
      }
    });
  }

  /** The owner chat a permission question belongs to: the one driving this
   *  session when it's an owner's, otherwise every owner. */
  private permissionAudience(sessionId: string): number[] {
    const chatId = this.sessionToChat.get(sessionId);
    if (chatId !== undefined && this.owners.has(chatId)) return [chatId];
    return [...this.owners];
  }

  /** Answer a prompt: respond for every request it collapsed, then close the
   *  message out so it stops being a live button in the owner's history. */
  private resolvePermission(token: string, decision: PermissionPromptDecision): boolean {
    const prompt = this.permPrompts.get(token);
    if (!prompt) return false;
    this.permPrompts.delete(token);
    if (this.permByKey.get(prompt.key) === token) this.permByKey.delete(prompt.key);
    for (const requestId of prompt.requestIds) {
      this.sendFrame({ type: "permission.respond", sessionId: prompt.sessionId, requestId, decision });
    }
    const outcome = renderPermissionOutcome(decision, { toolName: prompt.toolName, detail: prompt.detail });
    for (const { chatId, messageId } of prompt.messages) {
      this.enqueueSend(chatId, async () => {
        try {
          await this.api.editMessageText(chatId, messageId, outcome);
        } catch (err) {
          if (!isNoopStatusEditError(err)) this.log(`permission prompt close failed: ${errText(err)}`);
        }
      });
    }
    return true;
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

  /** Like enqueueSend, but the caller (the agent's tool) learns whether it
   *  landed — the chain itself never breaks on a failure. */
  private enqueueSendAwait(chatId: number, task: () => Promise<void>): Promise<void> {
    const prev = this.sendChains.get(chatId) ?? Promise.resolve();
    const result = prev.then(task);
    this.sendChains.set(chatId, result.catch((err) => this.log(`telegram send to ${chatId} failed: ${errText(err)}`)));
    return result;
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

/** A screenshot file path reported by a tool result (ComputerUse / RemotePC
 *  both expose `screenshotPath`), or undefined. Only image extensions count. */
export function screenshotPathOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const candidate = (output as { screenshotPath?: unknown }).screenshotPath;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return /\.(png|jpe?g|webp|gif)$/i.test(candidate) ? candidate : undefined;
}

/** A human-readable line for an engine error event, surfaced to the chat. */
function errorEventText(event: { error?: { code?: string; message?: string } }): string {
  const message = event.error?.message?.trim();
  if (message) return message;
  const code = event.error?.code;
  return code ? `error (${code})` : "the model returned an error";
}
