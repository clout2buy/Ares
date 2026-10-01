// Push notifications to the owner's phone, straight to Apple.
//
// Not Expo's push service: the garrison holds the APNs key and speaks to
// api.push.apple.com itself, so a permission prompt — which names the command
// about to run — never passes through anyone else's servers.
//
// Registration arrives on the phone API (/gateway/push/register) and is kept
// next to the other device state so a restart does not lose it.

import { connect as http2Connect } from "node:http2";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StagedApproval } from "@ares/effects";
import { approvalLine, approvalSummary, classifyApproval, classifyStaged, permissionApprovalId, stagedApprovalId, redactSecrets } from "./phoneApprovals.js";

/** Banner actions: Allow once / Deny / Open. */
export const APPROVAL_CATEGORY = "ARES_APPROVAL";
/** Banner actions for a decision that must be made in the app: Deny / Open. */
export const APPROVAL_STRICT_CATEGORY = "ARES_APPROVAL_STRICT";

export interface PhonePushDevice {
  /** Hex APNs device token. */
  token: string;
  platform: string;
  label?: string;
  registeredAt: number;
  /** Cleared on a successful send; Apple's reason when it last failed. */
  lastError?: string;
}

export interface ApnsConfig {
  /** APNs auth key (.p8) — Keys section of the Apple developer portal. */
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  /** Apple's sandbox host is used by development builds. */
  production?: boolean;
}

const APNS_HOST = (production: boolean) => (production ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com");

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** APNs provider token. Apple accepts one for an hour; refresh well inside that. */
export function apnsJwt(cfg: ApnsConfig, keyPem: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: issuedAt }));
  const input = `${header}.${payload}`;
  const signature = cryptoSign("sha256", Buffer.from(input), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${b64url(signature)}`;
}

/** Who a push is from. Lets the phone's Notification Service Extension draw the
 *  agent's picture and name (a communication notification) instead of the app icon. */
export interface PushAgent {
  id: string;
  name: string;
  /** #hex persona colour: the fallback disc when the agent has no picture. */
  accent?: string;
  /** The picture's version (its ETag), the phone's cache key. Absent = no picture. */
  avatarVersion?: string;
}
/** Resolves an agent id to what a push needs to attribute it (sync; the store is in memory). */
export type PushAgentDirectory = (agentId: string) => PushAgent | undefined;

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The small, secret-free fields the extension reads, plus the per-agent thread id. */
export function agentPayload(agent: PushAgent): Record<string, string> {
  const out: Record<string, string> = { agentId: agent.id, agentName: agent.name.replace(/\s+/g, " ").trim().slice(0, 60) || "Ares" };
  if (agent.avatarVersion && /^[A-Za-z0-9._-]{1,64}$/.test(agent.avatarVersion)) out.avatarVersion = agent.avatarVersion;
  if (agent.accent && HEX_RE.test(agent.accent)) out.accent = agent.accent;
  return out;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Rides along so a tap can open the right instance/session. */
  data?: Record<string, unknown>;
  /** Collapse key: a newer prompt replaces an older one rather than stacking. */
  collapseId?: string;
  /** Attribute the banner to an agent (picture + name on the phone). Resolved
   *  from data.agentId when a directory is set and this is absent. */
  agent?: PushAgent;
}

/** The ActivityKit attributes type the app's widget extension declares. */
export const LIVE_ACTIVITY_ATTRIBUTES_TYPE = "AresActivityAttributes";

export interface LiveActivityPush {
  event: "start" | "update" | "end";
  /** Must decode as AresActivityAttributes.ContentState on the phone. */
  contentState: Record<string, unknown>;
  /** start only. */
  attributesType?: string;
  attributes?: Record<string, unknown>;
  /** start requires one; update/end may carry one (it wakes the screen). */
  alert?: { title: string; body: string };
  /** Epoch seconds. */
  staleDate?: number;
  /** end only, epoch seconds; omitted = the system default (about four hours). */
  dismissalDate?: number;
  /** 10 immediate (counts against the budget), 5 may be delayed. Default 10. */
  priority?: 5 | 10;
  timestamp?: number;
}

/** One APNs request, as handed to the transport (and to tests). */
export interface ApnsRequest {
  deviceToken: string;
  headers: Record<string, string>;
  body: string;
}
/** Sends one APNs request and resolves with Apple's HTTP status. */
export type ApnsTransport = (cfg: ApnsConfig, request: ApnsRequest) => Promise<number>;

export class PhonePush {
  private devices = new Map<string, PhonePushDevice>();
  private keyPem?: string;
  private jwt?: { token: string; mintedAt: number };
  private loaded = false;
  private agents?: PushAgentDirectory;

  constructor(
    private readonly storePath: string,
    private readonly cfg: ApnsConfig | null,
    private readonly log: (line: string) => void = () => {},
    /** Test seam: replaces the HTTP/2 call to Apple. */
    private readonly transport?: ApnsTransport,
  ) {}

  /** Lets pushes that only carry data.agentId (goals, briefings, inbox) pick up the agent's picture. */
  setAgentDirectory(directory: PushAgentDirectory | undefined): void {
    this.agents = directory;
  }

  private attribute(message: PushMessage): PushMessage {
    if (message.agent) return message;
    const id = message.data?.agentId;
    if (typeof id !== "string" || !AGENT_ID_RE.test(id)) return message;
    try {
      const agent = this.agents?.(id);
      return agent ? { ...message, agent } : message;
    } catch {
      return message;
    }
  }

  get configured(): boolean {
    return this.cfg !== null;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as { devices?: PhonePushDevice[] };
      for (const d of raw.devices ?? []) if (d?.token) this.devices.set(d.token, d);
    } catch {
      // First run — no devices registered yet.
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify({ devices: [...this.devices.values()] }, null, 2) + "\n", "utf8");
  }

  async register(device: Omit<PhonePushDevice, "registeredAt">): Promise<void> {
    await this.load();
    this.devices.set(device.token, { ...device, registeredAt: Date.now() });
    await this.persist();
    this.log(`push: registered ${device.platform} device${device.label ? ` (${device.label})` : ""}`);
  }

  async unregister(token: string): Promise<void> {
    await this.load();
    if (this.devices.delete(token)) {
      await this.persist();
      this.log("push: device unregistered");
    }
  }

  async list(): Promise<PhonePushDevice[]> {
    await this.load();
    return [...this.devices.values()];
  }

  private async token(): Promise<string> {
    if (!this.cfg) throw new Error("APNs is not configured");
    if (!this.keyPem) this.keyPem = await readFile(this.cfg.keyPath, "utf8");
    // Apple rejects a token older than an hour; mint a fresh one every 45 min.
    if (!this.jwt || Date.now() - this.jwt.mintedAt > 45 * 60_000) {
      this.jwt = { token: apnsJwt(this.cfg, this.keyPem), mintedAt: Date.now() };
    }
    return this.jwt.token;
  }

  /** Send to every registered device. Apple's "this token is dead" answers
   *  prune the device rather than being retried forever. */
  async send(message: PushMessage): Promise<{ sent: number; failed: number }> {
    return this.fanout(message, "alert");
  }

  /**
   * A silent wake-up: apns-push-type background, priority 5, content-available
   * and no alert. It lets the app run briefly (and pull a pending Phone Hands
   * request over HTTP) without showing the owner anything. Apple may throttle
   * or drop these; callers follow up with a visible alert when it matters.
   */
  async sendBackground(data: Record<string, unknown> = {}): Promise<{ sent: number; failed: number }> {
    return this.fanout({ title: "", body: "", data }, "background");
  }

  private async fanout(message: PushMessage, mode: "alert" | "background"): Promise<{ sent: number; failed: number }> {
    await this.load();
    if (!this.cfg || this.devices.size === 0) return { sent: 0, failed: 0 };
    const jwt = await this.token();
    let sent = 0;
    let failed = 0;
    for (const device of [...this.devices.values()]) {
      try {
        const status = await this.sendOne(device.token, jwt, mode === "alert" ? this.attribute(message) : message, mode);
        if (status === 200) {
          sent++;
          if (device.lastError) {
            device.lastError = undefined;
            await this.persist();
          }
        } else if (status === 410 || status === 400) {
          // Gone / bad token: the app was deleted or the token rotated.
          this.devices.delete(device.token);
          await this.persist();
          this.log(`push: dropped a dead device token (${status})`);
          failed++;
        } else {
          failed++;
          device.lastError = `apns ${status}`;
          this.log(`push: apns returned ${status}`);
        }
      } catch (err) {
        failed++;
        this.log(`push: send failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return { sent, failed };
  }

  /** The exact APNs headers + body for one message. Pure; exported via the class for tests. */
  static buildRequest(cfg: ApnsConfig, deviceToken: string, jwt: string, message: PushMessage, mode: "alert" | "background"): ApnsRequest {
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": cfg.bundleId,
      "apns-push-type": mode,
      "apns-priority": mode === "background" ? "5" : "10",
    };
    if (mode === "background") {
      // Apple requires a background push to carry content-available and no alert.
      headers["apns-expiration"] = String(Math.floor(Date.now() / 1000) + 60);
      return { deviceToken, headers, body: JSON.stringify({ aps: { "content-available": 1 }, deviceWake: true, ...(message.data ?? {}) }) };
    }
    if (message.collapseId) headers["apns-collapse-id"] = message.collapseId.slice(0, 64);
    const replyable = ["persona_message", "family_message"].includes(String(message.data?.kind));
    const wake = message.data?.kind === "device_wake";
    // An approval gets Allow/Deny/Open only when the server classified it quick;
    // anything else (strict, or a payload that predates the classifier) gets the
    // category that cannot approve from the banner.
    const approval = message.data?.kind === "permission" || message.data?.kind === "approval";
    const category = replyable ? "ARES_TEXT_REPLY" : wake ? "ARES_DEVICE_WAKE" : approval ? (message.data?.gate === "quick" ? APPROVAL_CATEGORY : APPROVAL_STRICT_CATEGORY) : undefined;
    // Agent-attributed: mutable-content wakes the app's Notification Service
    // Extension, which draws the agent's picture and name. Payload stays tiny
    // and secret-free (ids, a name, a version, a colour); the extension fetches
    // the picture itself with the owner token it already holds.
    const agentFields = message.agent ? agentPayload(message.agent) : undefined;
    const thread = agentFields ? `agent-${agentFields.agentId}` : message.data?.sessionId || message.data?.threadId ? String(message.data?.sessionId ?? message.data?.threadId) : undefined;
    return {
      deviceToken,
      headers,
      body: JSON.stringify({
        aps: {
          alert: { title: message.title, body: message.body },
          sound: "default",
          ...(category ? { category } : {}),
          ...(wake ? { "interruption-level": "time-sensitive" } : {}),
          ...(agentFields ? { "mutable-content": 1 } : {}),
          ...(thread ? { "thread-id": thread } : {}),
        },
        ...(message.data ?? {}),
        ...(agentFields ?? {}),
      }),
    };
  }

  /**
   * One Live Activity push (start / update / end) to a specific activity or
   * push-to-start token. Resolves with Apple's HTTP status; 0 when push is not
   * configured. Pruning dead tokens is the caller's job: only it knows which
   * registry the token came from.
   */
  async sendLiveActivity(deviceToken: string, push: LiveActivityPush): Promise<number> {
    if (!this.cfg) return 0;
    const jwt = await this.token();
    return this.deliver(PhonePush.buildLiveActivityRequest(this.cfg, deviceToken, jwt, push));
  }

  /** The exact APNs headers + body for a Live Activity push. Pure. */
  static buildLiveActivityRequest(cfg: ApnsConfig, deviceToken: string, jwt: string, push: LiveActivityPush, nowMs = Date.now()): ApnsRequest {
    const nowSec = Math.floor(nowMs / 1000);
    const headers: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      authorization: `bearer ${jwt}`,
      "apns-topic": `${cfg.bundleId}.push-type.liveactivity`,
      "apns-push-type": "liveactivity",
      "apns-priority": String(push.priority ?? 10),
      // A progress update is worthless a couple of minutes late; the end is not.
      "apns-expiration": String(nowSec + (push.event === "end" ? 3600 : push.event === "start" ? 120 : 180)),
    };
    const aps: Record<string, unknown> = {
      timestamp: push.timestamp ?? nowSec,
      event: push.event,
      "content-state": push.contentState,
    };
    if (push.staleDate !== undefined) aps["stale-date"] = push.staleDate;
    if (push.event === "end" && push.dismissalDate !== undefined) aps["dismissal-date"] = push.dismissalDate;
    if (push.event === "start") {
      aps["attributes-type"] = push.attributesType ?? LIVE_ACTIVITY_ATTRIBUTES_TYPE;
      aps.attributes = push.attributes ?? {};
    }
    if (push.alert) aps.alert = push.alert;
    return { deviceToken, headers, body: JSON.stringify({ aps }) };
  }

  private sendOne(deviceToken: string, jwt: string, message: PushMessage, mode: "alert" | "background" = "alert"): Promise<number> {
    return this.deliver(PhonePush.buildRequest(this.cfg!, deviceToken, jwt, message, mode));
  }

  private deliver(prepared: ApnsRequest): Promise<number> {
    const cfg = this.cfg!;
    if (this.transport) return this.transport(cfg, prepared);
    return new Promise<number>((resolve, reject) => {
      const client = http2Connect(APNS_HOST(cfg.production !== false));
      const settle = (fn: () => void) => {
        try { client.close(); } catch { /* already closing */ }
        fn();
      };
      client.on("error", (err) => settle(() => reject(err)));
      const req = client.request(prepared.headers);
      let status = 0;
      req.on("response", (h) => { status = Number(h[":status"] ?? 0); });
      req.setTimeout(15_000, () => settle(() => reject(new Error("apns timeout"))));
      req.on("error", (err) => settle(() => reject(err)));
      req.on("end", () => settle(() => resolve(status)));
      req.end(prepared.body);
      req.resume();
    });
  }
}

/** Read APNs settings from the environment; null when push is not set up. */
export function apnsFromEnv(bundleId: string): ApnsConfig | null {
  const keyPath = process.env.ARES_APNS_KEY_PATH;
  const keyId = process.env.ARES_APNS_KEY_ID;
  const teamId = process.env.ARES_APNS_TEAM_ID;
  if (!keyPath || !keyId || !teamId) return null;
  return { keyPath, keyId, teamId, bundleId, production: process.env.ARES_APNS_SANDBOX !== "1" };
}

// ─── What is worth waking the owner for ──────────────────────────────────

import WebSocket from "ws";

/** Anything that wants to follow the same stream the notifier reads (the Live Activity, the widgets). */
export interface NotifierObserver {
  onSessionEvent?(sessionId: string, event: Record<string, unknown>): void;
  onStagedApproval?(staged: StagedApproval): void;
}

export interface NotifierOptions {
  gatewayUrl: string;
  token: string;
  push: Pick<PhonePush, "send">;
  agentName?: (sessionId: string) => string;
  /** The agent behind a session, for the picture/name on the banner. Falls back to agentName. */
  agentOf?: (sessionId: string) => PushAgent | undefined;
  /** Who a staged (session-less) approval belongs to; default is the default persona. */
  stagedAgent?: (staged: StagedApproval) => PushAgent | undefined;
  isMobileSession?: (sessionId: string) => boolean;
  log?: (line: string) => void;
  /** A turn shorter than this finished while they were still looking at it. */
  longTurnMs?: number;
  observers?: NotifierObserver[];
  /** This garrison's public origin, so a phone paired to several can tell whose approval a banner is. */
  originOf?: () => string | undefined;
}

/**
 * Watches the garrison the way a channel does and pushes the two things that
 * genuinely cannot wait: a permission prompt (it auto-denies in five minutes,
 * so an unseen one is a dead task) and the end of a turn long enough that the
 * owner has certainly put the phone down.
 */
export class PhoneNotifier {
  private ws?: WebSocket;
  private running = false;
  private backoff = 1_000;
  private timer?: NodeJS.Timeout;
  private readonly attached = new Set<string>();
  private readonly turnStartedAt = new Map<string, number>();
  private readonly replyText = new Map<string, string>();
  private readonly notifiedStaged = new Set<string>();
  private readonly log: (line: string) => void;
  private readonly longTurnMs: number;

  constructor(private readonly opts: NotifierOptions) {
    this.log = opts.log ?? (() => {});
    this.longTurnMs = opts.longTurnMs ?? 90_000;
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = undefined;
  }

  private connect(): void {
    if (!this.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.gatewayUrl);
    } catch (err) {
      return this.retry(err instanceof Error ? err.message : String(err));
    }
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: this.opts.token, client: "phone-push", proto: 1 })));
    ws.on("message", (raw) => {
      let frame: { type?: string; sessions?: Array<{ id: string }>; session?: { id: string }; sessionId?: string; event?: Record<string, unknown>; staged?: StagedApproval };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "welcome") {
        this.backoff = 1_000;
        for (const s of frame.sessions ?? []) this.attach(s.id);
        return;
      }
      if (frame.type === "session.created" && frame.session) return this.attach(frame.session.id);
      if (frame.type === "event" && frame.sessionId && frame.event) this.handleEvent(frame.sessionId, frame.event);
      if (frame.type === "approval.pending" && frame.staged) this.handleStaged(frame.staged);
    });
    ws.on("close", () => { if (this.ws === ws) this.retry("closed"); });
    ws.on("error", () => { /* close follows */ });
  }

  private attach(sessionId: string): void {
    if (this.attached.has(sessionId)) return;
    this.attached.add(sessionId);
    try { this.ws?.send(JSON.stringify({ type: "session.attach", sessionId })); } catch { /* reconnect will redo it */ }
  }

  private retry(why: string): void {
    this.ws = undefined;
    this.attached.clear();
    if (!this.running) return;
    const wait = this.backoff;
    this.backoff = Math.min(30_000, this.backoff * 2);
    this.log(`push notifier: ${why}; reconnecting in ${Math.round(wait / 1000)}s`);
    this.timer = setTimeout(() => this.connect(), wait);
    this.timer.unref?.();
  }

  /** A staged effect (browser submit, connector effect) waiting on the owner. The
   *  gateway replays outstanding ones on every reconnect, so each id pushes once. */
  handleStaged(staged: StagedApproval): void {
    for (const o of this.opts.observers ?? []) {
      try { o.onStagedApproval?.(staged); } catch { /* an observer must never break the push */ }
    }
    if (!staged || typeof staged.id !== "string" || this.notifiedStaged.has(staged.id)) return;
    this.notifiedStaged.add(staged.id);
    while (this.notifiedStaged.size > 200) {
      const oldest = this.notifiedStaged.values().next().value;
      if (oldest === undefined) break;
      this.notifiedStaged.delete(oldest);
    }
    const cls = classifyStaged(staged);
    const tool = String(staged.kind || "action").slice(0, 40);
    const target = redactSecrets(String(staged.reason ?? "")).replace(/\s+/g, " ").trim().slice(0, 80);
    let stagedAgent: PushAgent | undefined;
    try { stagedAgent = this.opts.stagedAgent?.(staged); } catch { /* the banner still goes out */ }
    void this.opts.push.send({
      title: `${stagedAgent?.name ?? "Ares"} needs approval`,
      ...(stagedAgent ? { agent: stagedAgent } : {}),
      body: target ? `${tool} — ${target}` : tool,
      data: { kind: "approval", approvalId: stagedApprovalId(staged.id), gate: cls.gate, tool, target, ...this.originField() },
      collapseId: `approval-${staged.id}`.slice(0, 64),
    });
  }

  private agentFor(sessionId: string): { agent?: PushAgent } {
    try {
      const agent = this.opts.agentOf?.(sessionId);
      return agent ? { agent } : {};
    } catch {
      return {};
    }
  }

  private originField(): { origin?: string } {
    try {
      const origin = this.opts.originOf?.();
      return origin ? { origin } : {};
    } catch {
      return {};
    }
  }

  /** One event off the gateway stream. Public so tests can drive it without a socket. */
  handleEvent(sessionId: string, event: Record<string, unknown>): void {
    for (const o of this.opts.observers ?? []) {
      try { o.onSessionEvent?.(sessionId, event); } catch { /* an observer must never break the push */ }
    }
    const type = String(event.type ?? "");
    if (type === "turn_start") {
      this.turnStartedAt.set(sessionId, Date.now());
      this.replyText.delete(sessionId);
      return;
    }
    if (type === "text_delta" && this.opts.isMobileSession?.(sessionId)) {
      this.replyText.set(sessionId, ((this.replyText.get(sessionId) ?? "") + String(event.text ?? "")).slice(-500));
      return;
    }
    if (type === "permission_request") {
      const agent = this.opts.agentOf?.(sessionId)?.name ?? this.opts.agentName?.(sessionId) ?? "Ares";
      const cls = classifyApproval({ toolName: String(event.toolName ?? ""), input: event.input, reason: String(event.reason ?? ""), ownerDecision: event.ownerDecision === true });
      const sum = approvalSummary(String(event.toolName ?? "a tool"), event.input, cls);
      const requestId = String(event.id ?? "");
      void this.opts.push.send({
        title: `${agent} needs permission`,
        body: approvalLine(sum),
        // gate decides which actions the banner carries (see APPROVAL_CATEGORY);
        // tool/target are the same redacted line the banner shows, for the app.
        data: { kind: "permission", sessionId, requestId, approvalId: permissionApprovalId(sessionId, requestId), gate: cls.gate, tool: sum.tool, target: sum.target, ...this.originField() },
        // A newer prompt replaces the older banner instead of stacking.
        collapseId: `perm-${sessionId}`,
        ...this.agentFor(sessionId),
      });
      return;
    }
    if (type === "turn_end") {
      const startedAt = this.turnStartedAt.get(sessionId);
      this.turnStartedAt.delete(sessionId);
      const reply = this.replyText.get(sessionId)?.trim();
      this.replyText.delete(sessionId);
      if (!this.opts.isMobileSession?.(sessionId)) return;
      const agent = this.opts.agentOf?.(sessionId)?.name ?? this.opts.agentName?.(sessionId) ?? "Ares";
      const failed = String(event.status ?? "") === "failed";
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      if (!failed && !reply && elapsed < this.longTurnMs) return;
      void this.opts.push.send({
        title: failed ? `${agent} hit a problem` : agent,
        body: failed ? "The turn ended without a reply." : reply ? reply.slice(0, 180) : `Done after ${Math.round(elapsed / 1000)}s.`,
        data: { kind: !failed && reply ? "persona_message" : "turn_end", sessionId },
        collapseId: `turn-${sessionId}`,
        ...this.agentFor(sessionId),
      });
    }
  }
}
