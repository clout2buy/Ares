// DeviceBridge — Phone Hands, server side.
//
// The owner's phone keeps an authenticated gateway socket (device.hello) and
// answers device.request frames; when it has no socket it can instead pull
// queued requests over HTTP (pollPending / httpRespond) after a silent push.
// This class owns the correlation table, the safety rails and the audit trail
// for every one of those calls, and nothing else: the agent's permission
// mapping lives in the iPhone tool, the transport plumbing in server.ts.
//
// Rules this file is the single enforcement point for:
//   * one result per request id; late/duplicate/unknown responses are ignored
//   * a response is only honoured from the connection (or the HTTP poller of
//     the device) that holds the request — never from another client
//   * a capability the phone did not advertise, or has disabled, is refused
//     BEFORE anything is sent
//   * paused owner control refuses; guests never reach the phone
//   * payloads are bounded both ways; every call is audited, secret-free

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownerPause, recordAudit, registerStoppable, type AuditDraft } from "@ares/core";
import {
  effectiveDeviceRisk,
  type DeviceBridgeLike,
  type DeviceCapability,
  type DeviceErrorCode,
  type DeviceIdentity,
  type DeviceInvokeOptions,
  type DeviceInvokeResult,
  type DeviceShortcut,
  type DeviceStatusEntry,
} from "@ares/tools";
import type { GatewayServerFrame } from "./protocol.js";

export const DEVICE_DEFAULT_TIMEOUT_MS = 25_000;
export const DEVICE_MAX_TIMEOUT_MS = 120_000;
export const DEVICE_MAX_RESULT_BYTES = 256 * 1024;
export const DEVICE_MAX_ARGS_BYTES = 64 * 1024;
const MAX_DEVICES = 16;
const MAX_CAPABILITIES = 128;
const MAX_SHORTCUTS = 200;
const MAX_PENDING = 64;
const MAX_EVENTS = 50;
const SETTLED_MEMORY = 500;

/** How the bridge reaches a sleeping phone. All methods are best-effort. */
export interface DeviceWake {
  /** Is there any registered phone to push to at all? */
  available(): Promise<boolean>;
  /** Silent background push (content-available). True when Apple took it. */
  silent(info: DeviceWakeInfo): Promise<boolean>;
  /** Visible, actionable alert ("Ares needs your phone: …"). */
  visible(info: DeviceWakeInfo): Promise<boolean>;
}

export interface DeviceWakeInfo {
  deviceId?: string;
  deviceName?: string;
  capability: string;
  reason: string;
}

export interface DeviceBridgeOptions {
  /** Where known devices persist (so a restart remembers capabilities). Omit in tests. */
  statePath?: string;
  wake?: DeviceWake;
  /** Silent-push grace before the visible alert is sent (default 12s). */
  silentGraceMs?: number;
  /** Total time a sleeping phone gets to pick the request up (default 45s). */
  wakeWaitMs?: number;
  /** Minimum gap between wake pushes per device (default 20s silent / 120s visible). */
  silentMinIntervalMs?: number;
  visibleMinIntervalMs?: number;
  /** Is this garrison session the owner's? Guests must never reach the phone. */
  isOwnerSession?: (sessionId: string) => boolean;
  /** Owner pause (kill switch). Defaults to the process-wide owner pause gate. */
  isPaused?: () => boolean;
  /** Audit sink. Defaults to the garrison's process-wide recordAudit. */
  audit?: (entry: AuditDraft) => void;
  onEvent?: (deviceId: string, event: { kind: string; data?: unknown; at: string }) => void;
  now?: () => number;
  log?: (line: string) => void;
}

interface KnownDevice extends DeviceIdentity {
  lastSeenAt: number;
  helloAt: number;
  capabilities: DeviceCapability[];
  shortcuts: DeviceShortcut[];
  connKey?: string;
}

interface Conn {
  key: string;
  send(frame: GatewayServerFrame): void;
  deviceId: string;
}

interface Pending {
  id: string;
  /** Specific device, or undefined for "default" (whichever phone shows up). */
  deviceId?: string;
  anyDevice: boolean;
  capability: string;
  args: Record<string, unknown>;
  reason: string;
  timeoutMs: number;
  actor: string;
  sessionId?: string;
  startedAt: number;
  state: "queued" | "sent";
  claimedVia?: "ws" | "http";
  connKey?: string;
  queuedUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  dispatchWaiters: Array<() => void>;
  done: boolean;
  resolve(result: DeviceInvokeResult): void;
  release?: () => void;
  deviceName?: string;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface DevicePendingRequest {
  id: string;
  capability: string;
  args: Record<string, unknown>;
  deadlineMs: number;
  reason?: string;
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  "not_connected",
  "capability_unavailable",
  "permission_denied",
  "disabled_by_owner",
  "timeout",
  "device_error",
]);

const TEXT_ARG_KEYS = /^(text|body|notes?|input|message|content|data)$/i;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A secret-free, bounded view of a call's args for the audit trail. */
export function summarizeDeviceArgs(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>).slice(0, 12)) {
    if (typeof value === "string") {
      if (TEXT_ARG_KEYS.test(key)) out[key] = `[${value.length} chars]`;
      else out[key] = clip(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value.replace(/[?#].*$/, "") : value, 160);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else {
      out[key] = Array.isArray(value) ? `[${value.length} items]` : "[object]";
    }
  }
  return out;
}

function sizeOf(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function sanitizeCapabilities(raw: unknown): DeviceCapability[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceCapability[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_CAPABILITIES)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    const permission = c.permission === "granted" || c.permission === "denied" || c.permission === "unavailable" ? c.permission : "undetermined";
    // An unparseable risk is the strictest one.
    const risk = c.risk === "read" || c.risk === "write" || c.risk === "sensitive" ? c.risk : "sensitive";
    out.push({
      id: c.id,
      enabled: c.enabled === true,
      permission,
      risk,
      description: typeof c.description === "string" ? clip(c.description, 300) : "",
    });
  }
  return out;
}

function sanitizeShortcuts(raw: unknown): DeviceShortcut[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceShortcut[] = [];
  for (const item of raw.slice(0, MAX_SHORTCUTS)) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 100) continue;
    out.push({
      name: s.name,
      ...(typeof s.description === "string" ? { description: clip(s.description, 300) } : {}),
      ...(typeof s.acceptsInput === "boolean" ? { acceptsInput: s.acceptsInput } : {}),
    });
  }
  return out;
}

function sanitizeIdentity(raw: unknown): DeviceIdentity | string {
  if (!raw || typeof raw !== "object") return "device.hello requires a device object";
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !/^[\w.:-]{1,128}$/.test(d.id)) return "device.id must be 1-128 of letters, digits, _ . : -";
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? clip(v.trim(), max) : undefined);
  return {
    id: d.id,
    name: str(d.name, 128) ?? "iPhone",
    ...(str(d.model, 64) ? { model: str(d.model, 64) } : {}),
    ...(str(d.os, 64) ? { os: str(d.os, 64) } : {}),
    ...(str(d.appVersion, 32) ? { appVersion: str(d.appVersion, 32) } : {}),
  };
}

export class DeviceBridge implements DeviceBridgeLike {
  private readonly devices = new Map<string, KnownDevice>();
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();
  private readonly settled: string[] = [];
  private readonly settledSet = new Set<string>();
  private readonly events = new Map<string, Array<{ kind: string; data?: unknown; at: string }>>();
  private readonly wakeSent = new Map<string, number>();
  private saveChain: Promise<unknown> = Promise.resolve();
  private readonly o: DeviceBridgeOptions;
  private readonly now: () => number;

  constructor(opts: DeviceBridgeOptions = {}) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.load();
  }

  // ─── Status ────────────────────────────────────────────────────────────

  list(): DeviceStatusEntry[] {
    return [...this.devices.values()]
      .sort((a, b) => Number(Boolean(b.connKey)) - Number(Boolean(a.connKey)) || b.helloAt - a.helloAt)
      .map((d) => this.entry(d));
  }

  get(deviceIdOrName: string): DeviceStatusEntry | undefined {
    const d = this.find(deviceIdOrName);
    return d ? this.entry(d) : undefined;
  }

  recentEvents(deviceId: string): Array<{ kind: string; data?: unknown; at: string }> {
    return [...(this.events.get(deviceId) ?? [])];
  }

  pendingCount(): number {
    return this.pending.size;
  }

  isOwnerSession(sessionId: string | undefined): boolean {
    if (!sessionId || !this.o.isOwnerSession) return true;
    try {
      return this.o.isOwnerSession(sessionId);
    } catch {
      return false;
    }
  }

  private entry(d: KnownDevice): DeviceStatusEntry {
    return {
      id: d.id,
      name: d.name,
      ...(d.model ? { model: d.model } : {}),
      ...(d.os ? { os: d.os } : {}),
      ...(d.appVersion ? { appVersion: d.appVersion } : {}),
      connected: Boolean(d.connKey),
      lastSeenAt: new Date(d.lastSeenAt).toISOString(),
      capabilities: d.capabilities.map((c) => ({ ...c })),
      shortcuts: d.shortcuts.map((s) => ({ ...s })),
    };
  }

  private find(idOrName: string): KnownDevice | undefined {
    const direct = this.devices.get(idOrName);
    if (direct) return direct;
    const lower = idOrName.toLowerCase();
    return [...this.devices.values()].find((d) => d.name.toLowerCase() === lower);
  }

  private defaultDevice(): KnownDevice | undefined {
    const all = [...this.devices.values()];
    return all.filter((d) => d.connKey).sort((a, b) => b.helloAt - a.helloAt)[0] ?? all.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
  }

  // ─── Phone → garrison frames (called by server.ts) ─────────────────────

  /** device.hello. Returns an error string to send back, or null. */
  hello(connKey: string, send: (frame: GatewayServerFrame) => void, frame: { device?: unknown; capabilities?: unknown; shortcuts?: unknown }): string | null {
    const identity = sanitizeIdentity(frame.device);
    if (typeof identity === "string") return identity;
    if (!this.devices.has(identity.id) && this.devices.size >= MAX_DEVICES) return "too many registered devices";
    const at = this.now();
    // This socket may have been another device a moment ago.
    const prev = this.conns.get(connKey);
    if (prev && prev.deviceId !== identity.id) this.detach(connKey, "re-registered as another device");
    // Newest hello wins per id: an older socket for this id stops being the device.
    const existing = this.devices.get(identity.id);
    if (existing?.connKey && existing.connKey !== connKey) {
      const old = existing.connKey;
      this.conns.delete(old);
      this.failWhere((p) => p.connKey === old && p.state === "sent" && p.claimedVia === "ws", "not_connected", "The phone reconnected on a new socket before answering; try again.");
    }
    const rec: KnownDevice = {
      ...(existing ?? { capabilities: [], shortcuts: [] }),
      ...identity,
      capabilities: sanitizeCapabilities(frame.capabilities),
      shortcuts: sanitizeShortcuts(frame.shortcuts),
      lastSeenAt: at,
      helloAt: at,
      connKey,
    };
    this.devices.set(rec.id, rec);
    this.conns.set(connKey, { key: connKey, send, deviceId: rec.id });
    this.save();
    this.flushQueued(rec);
    return null;
  }

  /** device.capabilities — a live update from a registered socket. */
  capabilities(connKey: string, frame: { capabilities?: unknown; shortcuts?: unknown }): string | null {
    const rec = this.recOf(connKey);
    if (!rec) return "device.capabilities before device.hello";
    rec.capabilities = sanitizeCapabilities(frame.capabilities);
    if (frame.shortcuts !== undefined) rec.shortcuts = sanitizeShortcuts(frame.shortcuts);
    rec.lastSeenAt = this.now();
    this.save();
    this.flushQueued(rec);
    return null;
  }

  event(connKey: string, frame: { kind?: unknown; data?: unknown }): string | null {
    const rec = this.recOf(connKey);
    if (!rec) return "device.event before device.hello";
    if (typeof frame.kind !== "string" || !frame.kind || frame.kind.length > 64) return "device.event requires a kind";
    rec.lastSeenAt = this.now();
    const list = this.events.get(rec.id) ?? [];
    const data = sizeOf(frame.data) > 8 * 1024 ? "[dropped: over 8KB]" : frame.data;
    const e = { kind: frame.kind, ...(data !== undefined ? { data } : {}), at: new Date(rec.lastSeenAt).toISOString() };
    list.push(e);
    while (list.length > MAX_EVENTS) list.shift();
    this.events.set(rec.id, list);
    try {
      this.o.onEvent?.(rec.id, e);
    } catch {
      // a listener never breaks the socket
    }
    return null;
  }

  /** device.response over the socket. Always silent; ignored answers are normal. */
  response(connKey: string, frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): boolean {
    const rec = this.recOf(connKey);
    if (rec) rec.lastSeenAt = this.now();
    return this.accept(frame, { connKey, deviceId: rec?.id });
  }

  /** The socket closed: the device is offline and its in-flight calls fail fast. */
  closed(connKey: string): void {
    this.detach(connKey, "The phone disconnected before it answered.");
  }

  private detach(connKey: string, why: string): void {
    const conn = this.conns.get(connKey);
    this.conns.delete(connKey);
    if (conn) {
      const rec = this.devices.get(conn.deviceId);
      if (rec && rec.connKey === connKey) {
        rec.connKey = undefined;
        rec.lastSeenAt = this.now();
        this.save();
      }
    }
    this.failWhere((p) => p.connKey === connKey && p.state === "sent" && p.claimedVia === "ws", "not_connected", why);
  }

  private recOf(connKey: string): KnownDevice | undefined {
    const conn = this.conns.get(connKey);
    const rec = conn ? this.devices.get(conn.deviceId) : undefined;
    return rec && rec.connKey === connKey ? rec : undefined;
  }

  // ─── HTTP fallback (the phone has no socket) ───────────────────────────

  /**
   * The unexpired requests waiting for this device, claimed as they are
   * returned: delivery is at-most-once by default so a slow poll cannot make
   * the phone run "create event" twice. `includeClaimed` re-lists requests a
   * previous poll already handed out and nobody has answered yet.
   */
  pollPending(deviceId: string, opts: { includeClaimed?: boolean } = {}): DevicePendingRequest[] {
    const rec = this.devices.get(deviceId);
    if (rec) rec.lastSeenAt = this.now();
    const out: DevicePendingRequest[] = [];
    const t = this.now();
    for (const p of [...this.pending.values()]) {
      if (p.done) continue;
      const mine = p.anyDevice || p.deviceId === deviceId;
      if (!mine) continue;
      if (p.state === "sent") {
        if (opts.includeClaimed && p.claimedVia === "http" && p.deviceId === deviceId) out.push(this.wire(p));
        continue;
      }
      if (t >= p.queuedUntil) continue;
      if (this.paused()) {
        this.finish(p, { ok: false, error: { code: "paused", message: "Ares is paused by the owner." }, durationMs: t - p.startedAt });
        continue;
      }
      if (rec) {
        const bad = this.validate(rec, p.capability);
        if (bad) {
          this.finish(p, { ok: false, device: rec.id, error: bad, durationMs: t - p.startedAt });
          continue;
        }
      }
      p.deviceId = deviceId;
      p.deviceName = rec?.name;
      this.markSent(p, "http");
      out.push(this.wire(p));
    }
    return out;
  }

  /** POST /gateway/device/respond. Idempotent: unknown / late ids are ignored. */
  httpRespond(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }): { accepted: boolean } {
    return { accepted: this.accept(frame, { http: true }) };
  }

  private wire(p: Pending): DevicePendingRequest {
    return { id: p.id, capability: p.capability, args: p.args, deadlineMs: p.timeoutMs, ...(p.reason ? { reason: p.reason } : {}) };
  }

  // ─── Correlation ───────────────────────────────────────────────────────

  private accept(frame: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown }, from: { connKey?: string; deviceId?: string; http?: boolean }): boolean {
    if (typeof frame.id !== "string" || typeof frame.ok !== "boolean") return false;
    const p = this.pending.get(frame.id);
    if (!p || p.done) return false; // unknown, late or duplicate: ignored
    if (!from.http) {
      // Only the socket (or the registered device) that holds the request may answer it.
      if (p.state !== "sent") return false;
      if (p.claimedVia === "ws" ? p.connKey !== from.connKey : p.deviceId !== from.deviceId) return false;
    }
    const took = this.now() - p.startedAt;
    if (frame.ok) {
      if (sizeOf(frame.result) > DEVICE_MAX_RESULT_BYTES) {
        this.finish(p, { ok: false, device: p.deviceId, error: { code: "device_error", message: `The phone's answer was larger than ${DEVICE_MAX_RESULT_BYTES / 1024}KB; ask for less.` }, durationMs: took });
      } else {
        this.finish(p, { ok: true, device: p.deviceId ?? "", result: frame.result ?? null, durationMs: took });
      }
      return true;
    }
    const e = (frame.error && typeof frame.error === "object" ? frame.error : {}) as { code?: unknown; message?: unknown };
    const phoneCode = typeof e.code === "string" ? e.code : "device_error";
    const message = typeof e.message === "string" && e.message ? clip(e.message, 500) : "The phone reported an error.";
    const code: DeviceErrorCode = ERROR_CODES.has(phoneCode) ? (phoneCode as DeviceErrorCode) : "device_error";
    this.finish(p, { ok: false, device: p.deviceId, error: { code, message: code === phoneCode ? message : `${phoneCode}: ${message}` }, durationMs: took });
    return true;
  }

  private finish(p: Pending, result: DeviceInvokeResult): void {
    if (p.done) return;
    p.done = true;
    if (p.timer) clearTimeout(p.timer);
    p.release?.();
    if (p.signal && p.onAbort) p.signal.removeEventListener("abort", p.onAbort);
    this.pending.delete(p.id);
    this.settledSet.add(p.id);
    this.settled.push(p.id);
    while (this.settled.length > SETTLED_MEMORY) this.settledSet.delete(this.settled.shift()!);
    for (const wake of p.dispatchWaiters.splice(0)) wake();
    this.audit(p, result);
    p.resolve(result);
  }

  private failWhere(match: (p: Pending) => boolean, code: DeviceErrorCode, message: string): void {
    for (const p of [...this.pending.values()]) {
      if (match(p)) this.finish(p, { ok: false, device: p.deviceId, error: { code, message }, durationMs: this.now() - p.startedAt });
    }
  }

  private markSent(p: Pending, via: "ws" | "http", connKey?: string): void {
    p.state = "sent";
    p.claimedVia = via;
    p.connKey = connKey;
    if (p.timer) clearTimeout(p.timer);
    // The phone's clock for this request starts now.
    p.timer = setTimeout(
      () => this.finish(p, { ok: false, device: p.deviceId, error: { code: "timeout", message: `The phone did not answer within ${Math.round(p.timeoutMs / 1000)}s.` }, durationMs: this.now() - p.startedAt }),
      p.timeoutMs,
    );
    p.timer.unref?.();
    for (const wake of p.dispatchWaiters.splice(0)) wake();
  }

  // ─── Audit ─────────────────────────────────────────────────────────────

  private audit(p: Pick<Pending, "actor" | "sessionId" | "capability" | "reason" | "args" | "deviceId" | "deviceName" | "id">, result: DeviceInvokeResult): void {
    const sink = this.o.audit ?? recordAudit;
    try {
      sink({
        actor: p.actor,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        action: `iPhone.${p.capability}`,
        target: p.deviceName ?? p.deviceId ?? "iPhone",
        params: {
          reason: clip(p.reason, 200),
          args: summarizeDeviceArgs(p.args),
          durationMs: result.durationMs,
          ...(result.ok ? { resultBytes: sizeOf(result.result) } : {}),
        },
        result: result.ok ? "ok" : `error: ${result.error.code}`,
      });
    } catch {
      // the audit trail never breaks the action it records
    }
  }

  // ─── Invoke ────────────────────────────────────────────────────────────

  async invoke(
    device: string | "default",
    capability: string,
    args: Record<string, unknown>,
    opts: DeviceInvokeOptions = {},
  ): Promise<DeviceInvokeResult> {
    const startedAt = this.now();
    const reason = (opts.reason ?? "").trim() || `Ares wants to use ${capability}`;
    const timeoutMs = Math.min(Math.max(Math.floor(opts.timeoutMs ?? DEVICE_DEFAULT_TIMEOUT_MS), 1_000), DEVICE_MAX_TIMEOUT_MS);
    const ctx = { id: "", actor: opts.actor ?? "ares", sessionId: opts.sessionId, capability, reason, args: args ?? {}, deviceId: undefined as string | undefined, deviceName: undefined as string | undefined };
    const refuse = (code: DeviceErrorCode, message: string, rec?: KnownDevice): DeviceInvokeResult => {
      const result: DeviceInvokeResult = { ok: false, error: { code, message }, ...(rec ? { device: rec.id } : {}), durationMs: this.now() - startedAt };
      this.audit({ ...ctx, deviceId: rec?.id, deviceName: rec?.name }, result);
      return result;
    };

    if (!this.isOwnerSession(opts.sessionId)) return refuse("forbidden", "The owner's phone is not available to guest chats.");
    if (this.paused()) return refuse("paused", "Ares is paused by the owner; phone actions are refused until they resume.");
    if (typeof capability !== "string" || !/^[a-z0-9_.-]{1,64}$/.test(capability)) return refuse("invalid_args", "capability must be an id like calendar.list_events.");
    if (!args || typeof args !== "object" || Array.isArray(args)) return refuse("invalid_args", "args must be an object.");
    if (sizeOf(args) > DEVICE_MAX_ARGS_BYTES) return refuse("invalid_args", `args are larger than ${DEVICE_MAX_ARGS_BYTES / 1024}KB.`);
    if (this.pending.size >= MAX_PENDING) return refuse("device_error", "Too many phone requests are already in flight.");

    const explicit = device && device !== "default" ? this.find(device) : undefined;
    if (device && device !== "default" && !explicit) {
      const known = [...this.devices.values()].map((d) => d.name).join(", ");
      return refuse("not_connected", `No phone named "${device}" has registered${known ? ` (known: ${known})` : ""}. Open the Ares app on your phone.`);
    }
    const rec = explicit ?? this.defaultDevice();

    const p: Pending = {
      id: `dq_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      deviceId: rec?.id,
      anyDevice: device === "default" || !device,
      capability,
      args,
      reason,
      timeoutMs,
      actor: ctx.actor,
      sessionId: opts.sessionId,
      startedAt,
      state: "queued",
      queuedUntil: startedAt,
      dispatchWaiters: [],
      done: false,
      deviceName: rec?.name,
      resolve: () => {},
    };
    ctx.id = p.id;
    if (opts.signal?.aborted) return refuse("cancelled", "Cancelled.", rec);

    const promise = new Promise<DeviceInvokeResult>((resolve) => {
      p.resolve = resolve;
    });
    this.pending.set(p.id, p);
    p.release = registerStoppable({
      kind: "job",
      id: p.id,
      label: `iPhone ${capability}`,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      stop: () => {
        if (p.done) return false;
        this.finish(p, { ok: false, device: p.deviceId, error: { code: "cancelled", message: "Stopped by the owner." }, durationMs: this.now() - p.startedAt });
        return true;
      },
    });
    if (opts.signal) {
      p.signal = opts.signal;
      p.onAbort = () => this.finish(p, { ok: false, device: p.deviceId, error: { code: "cancelled", message: "Cancelled." }, durationMs: this.now() - p.startedAt });
      opts.signal.addEventListener("abort", p.onAbort, { once: true });
    }

    // A live phone: validate against what it advertised and send.
    if (rec?.connKey) {
      this.dispatchWs(p, rec);
      return promise;
    }

    // No live socket: wake it (silent push first, then a visible alert) and
    // wait for it to connect or pull the request over HTTP.
    const wake = this.o.wake;
    const canWake = wake ? await wake.available().catch(() => false) : false;
    if (!canWake) {
      this.finish(p, { ok: false, device: rec?.id, error: { code: "not_connected", message: notConnectedMessage(rec?.name, false) }, durationMs: this.now() - startedAt });
      return promise;
    }
    if (p.done) return promise;
    const wakeWait = this.o.wakeWaitMs ?? 45_000;
    p.queuedUntil = this.now() + wakeWait;
    void this.wakeSequence(p, rec, reason);
    return promise;
  }

  private async wakeSequence(p: Pending, rec: KnownDevice | undefined, reason: string): Promise<void> {
    const wake = this.o.wake!;
    const key = rec?.id ?? "any";
    const info: DeviceWakeInfo = { deviceId: rec?.id, deviceName: rec?.name, capability: p.capability, reason };
    const gate = (kind: string, minMs: number): boolean => {
      const k = `${kind}:${key}`;
      const last = this.wakeSent.get(k) ?? 0;
      if (this.now() - last < minMs) return false;
      this.wakeSent.set(k, this.now());
      return true;
    };
    try {
      if (gate("silent", this.o.silentMinIntervalMs ?? 20_000)) await wake.silent(info).catch(() => false);
      const grace = Math.min(this.o.silentGraceMs ?? 12_000, Math.max(0, p.queuedUntil - this.now()));
      if (!(await this.waitDispatched(p, grace))) {
        if (gate("visible", this.o.visibleMinIntervalMs ?? 120_000)) await wake.visible(info).catch(() => false);
        await this.waitDispatched(p, Math.max(0, p.queuedUntil - this.now()));
      }
    } finally {
      if (!p.done && p.state === "queued") {
        this.finish(p, { ok: false, device: rec?.id, error: { code: "not_connected", message: notConnectedMessage(rec?.name, true) }, durationMs: this.now() - p.startedAt });
      }
    }
  }

  /** Resolves true once the request has been handed to the phone (or finished). */
  private waitDispatched(p: Pending, ms: number): Promise<boolean> {
    if (p.done || p.state === "sent") return Promise.resolve(true);
    if (ms <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const i = p.dispatchWaiters.indexOf(wake);
        if (i >= 0) p.dispatchWaiters.splice(i, 1);
        resolve(false);
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      p.dispatchWaiters.push(wake);
    });
  }

  private flushQueued(rec: KnownDevice): void {
    for (const p of [...this.pending.values()]) {
      if (p.done || p.state !== "queued") continue;
      if (!(p.anyDevice || p.deviceId === rec.id)) continue;
      if (this.now() >= p.queuedUntil && p.queuedUntil > p.startedAt) continue;
      this.dispatchWs(p, rec);
    }
  }

  private dispatchWs(p: Pending, rec: KnownDevice): void {
    const conn = rec.connKey ? this.conns.get(rec.connKey) : undefined;
    p.deviceId = rec.id;
    p.deviceName = rec.name;
    if (!conn) {
      this.finish(p, { ok: false, device: rec.id, error: { code: "not_connected", message: notConnectedMessage(rec.name, false) }, durationMs: this.now() - p.startedAt });
      return;
    }
    if (this.paused()) {
      this.finish(p, { ok: false, device: rec.id, error: { code: "paused", message: "Ares is paused by the owner." }, durationMs: this.now() - p.startedAt });
      return;
    }
    const bad = this.validate(rec, p.capability);
    if (bad) {
      this.finish(p, { ok: false, device: rec.id, error: bad, durationMs: this.now() - p.startedAt });
      return;
    }
    try {
      conn.send({ type: "device.request", id: p.id, capability: p.capability, args: p.args, deadlineMs: p.timeoutMs, reason: p.reason });
    } catch {
      this.finish(p, { ok: false, device: rec.id, error: { code: "not_connected", message: notConnectedMessage(rec.name, false) }, durationMs: this.now() - p.startedAt });
      return;
    }
    this.markSent(p, "ws", conn.key);
  }

  /** Refuse, before sending, what the phone did not advertise or has switched off. */
  private validate(rec: KnownDevice, capability: string): { code: DeviceErrorCode; message: string } | null {
    const cap = rec.capabilities.find((c) => c.id === capability);
    if (!cap) {
      const have = rec.capabilities.filter((c) => c.enabled).map((c) => c.id).join(", ");
      return { code: "capability_unavailable", message: `${rec.name} does not offer ${capability}.${have ? ` Available: ${have}.` : ""}` };
    }
    if (!cap.enabled) return { code: "disabled_by_owner", message: `${capability} is switched off in the Ares app on ${rec.name}. The owner can enable it there.` };
    if (cap.permission === "denied") return { code: "permission_denied", message: `iOS permission for ${capability} is denied on ${rec.name}. The owner can allow it in Settings > Ares.` };
    if (cap.permission === "unavailable") return { code: "capability_unavailable", message: `${capability} is not available on ${rec.name}'s hardware or OS.` };
    return null;
  }

  private paused(): boolean {
    try {
      return this.o.isPaused ? this.o.isPaused() : ownerPause.paused;
    } catch {
      return false;
    }
  }

  /** The gating risk for a capability on a device (phone-declared, floored). */
  riskOf(device: string | undefined, capability: string): "read" | "write" | "sensitive" {
    const rec = (device && device !== "default" ? this.find(device) : undefined) ?? this.defaultDevice();
    return effectiveDeviceRisk(capability, rec?.capabilities.find((c) => c.id === capability)?.risk);
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  private load(): void {
    const file = this.o.statePath;
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { devices?: Array<DeviceIdentity & { lastSeenAt?: string; capabilities?: unknown; shortcuts?: unknown }> };
      for (const d of raw.devices ?? []) {
        const identity = sanitizeIdentity(d);
        if (typeof identity === "string") continue;
        const at = Date.parse(d.lastSeenAt ?? "") || 0;
        this.devices.set(identity.id, { ...identity, capabilities: sanitizeCapabilities(d.capabilities), shortcuts: sanitizeShortcuts(d.shortcuts), lastSeenAt: at, helloAt: at });
      }
    } catch {
      // first run
    }
  }

  private save(): void {
    const file = this.o.statePath;
    if (!file) return;
    const body = JSON.stringify({ devices: this.list().map(({ connected: _c, ...d }) => d) }, null, 2) + "\n";
    this.saveChain = this.saveChain
      .then(async () => {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, file);
      })
      .catch((err) => this.o.log?.(`device: could not save state (${err instanceof Error ? err.message : String(err)})`));
  }

  /** Flush pending state writes (tests, shutdown). */
  async flush(): Promise<void> {
    await this.saveChain;
  }

  /** Fail everything in flight (daemon shutdown). */
  shutdown(): void {
    this.failWhere(() => true, "cancelled", "The garrison is shutting down.");
  }
}

function notConnectedMessage(name: string | undefined, pushed: boolean): string {
  const who = name ? `${name}` : "your phone";
  return pushed
    ? `${who} did not answer the wake-up notification in time. Open the Ares app on your phone and try again.`
    : `${who} is not connected. Open the Ares app on your phone.`;
}
