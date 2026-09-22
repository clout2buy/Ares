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

export interface PushMessage {
  title: string;
  body: string;
  /** Rides along so a tap can open the right instance/session. */
  data?: Record<string, unknown>;
  /** Collapse key: a newer prompt replaces an older one rather than stacking. */
  collapseId?: string;
}

export class PhonePush {
  private devices = new Map<string, PhonePushDevice>();
  private keyPem?: string;
  private jwt?: { token: string; mintedAt: number };
  private loaded = false;

  constructor(
    private readonly storePath: string,
    private readonly cfg: ApnsConfig | null,
    private readonly log: (line: string) => void = () => {},
  ) {}

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
    await this.load();
    if (!this.cfg || this.devices.size === 0) return { sent: 0, failed: 0 };
    const jwt = await this.token();
    let sent = 0;
    let failed = 0;
    for (const device of [...this.devices.values()]) {
      try {
        const status = await this.sendOne(device.token, jwt, message);
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

  private sendOne(deviceToken: string, jwt: string, message: PushMessage): Promise<number> {
    const cfg = this.cfg!;
    return new Promise<number>((resolve, reject) => {
      const client = http2Connect(APNS_HOST(cfg.production !== false));
      const settle = (fn: () => void) => {
        try { client.close(); } catch { /* already closing */ }
        fn();
      };
      client.on("error", (err) => settle(() => reject(err)));
      const headers: Record<string, string> = {
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": cfg.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
      };
      if (message.collapseId) headers["apns-collapse-id"] = message.collapseId.slice(0, 64);
      const req = client.request(headers);
      let status = 0;
      req.on("response", (h) => { status = Number(h[":status"] ?? 0); });
      req.setTimeout(15_000, () => settle(() => reject(new Error("apns timeout"))));
      req.on("error", (err) => settle(() => reject(err)));
      req.on("end", () => settle(() => resolve(status)));
      req.end(JSON.stringify({
        aps: { alert: { title: message.title, body: message.body }, sound: "default" },
        ...(message.data ?? {}),
      }));
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

export interface NotifierOptions {
  gatewayUrl: string;
  token: string;
  push: PhonePush;
  log?: (line: string) => void;
  /** A turn shorter than this finished while they were still looking at it. */
  longTurnMs?: number;
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
      let frame: { type?: string; sessions?: Array<{ id: string }>; session?: { id: string }; sessionId?: string; event?: Record<string, unknown> };
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (frame.type === "welcome") {
        this.backoff = 1_000;
        for (const s of frame.sessions ?? []) this.attach(s.id);
        return;
      }
      if (frame.type === "session.created" && frame.session) return this.attach(frame.session.id);
      if (frame.type === "event" && frame.sessionId && frame.event) this.onEvent(frame.sessionId, frame.event);
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

  private onEvent(sessionId: string, event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    if (type === "turn_start") {
      this.turnStartedAt.set(sessionId, Date.now());
      return;
    }
    if (type === "permission_request") {
      const tool = String(event.toolName ?? "a tool");
      const detail = describeInput(event.input);
      void this.opts.push.send({
        title: "Ares needs permission",
        body: detail ? `${tool} — ${detail}` : tool,
        data: { kind: "permission", sessionId, requestId: String(event.id ?? "") },
        // A newer prompt replaces the older banner instead of stacking.
        collapseId: `perm-${sessionId}`,
      });
      return;
    }
    if (type === "turn_end") {
      const startedAt = this.turnStartedAt.get(sessionId);
      this.turnStartedAt.delete(sessionId);
      const failed = String(event.status ?? "") === "failed";
      const elapsed = startedAt ? Date.now() - startedAt : 0;
      // A short turn finished while they were watching it; say nothing.
      if (!failed && elapsed < this.longTurnMs) return;
      void this.opts.push.send({
        title: failed ? "Ares hit a problem" : "Ares finished",
        body: failed ? "The turn ended without a reply." : `Done after ${Math.round(elapsed / 1000)}s.`,
        data: { kind: "turn_end", sessionId },
        collapseId: `turn-${sessionId}`,
      });
    }
  }
}

/** One short line of what a tool is about to do, for the banner. */
function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const r = input as Record<string, unknown>;
  for (const key of ["command", "url", "file_path", "path", "to", "query"]) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
    }
  }
  return "";
}
