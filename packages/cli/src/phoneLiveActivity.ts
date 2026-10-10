// Live Activity / Dynamic Island — the server half.
//
//   POST /gateway/liveactivity/register   {deviceId, activityId, pushToken, kind, sessionId?}
//        kind "update": the per-activity token ActivityKit hands the app for one running activity
//        kind "start":  the app-wide push-to-start token (iOS 17.2+); activityId is ignored
//   POST /gateway/liveactivity/unregister {deviceId, activityId?, kind?}
//   GET  /gateway/liveactivity            { configured, devices:[{deviceId, hasStartToken, activities}] }  (no tokens)
//
// The garrison drives the activity from its own turn lifecycle, over APNs
// (apns-push-type liveactivity), so it keeps moving while the app is suspended:
//
//   turn runs past 8 s ........ start (push-to-start) or update the activity
//   a tool starts / todos move . rate-limited progress update
//   a permission prompt ....... "needs approval" state, immediately
//   the prompt is answered .... back to working
//   the turn ends ............. end, with a one-line result, left on the lock screen a few minutes
//
// Apple budgets Live Activity pushes, so progress updates are spaced out and
// capped per hour; state changes (approval needed, finished) always go through.
// Dead tokens (410 / 400) are dropped, and a 429 backs everything off a minute.
//
// Nothing here reads a secret: the line on the lock screen is the same
// redacted summary the notification banner uses.

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LiveActivityPush } from "./phonePush.js";
import { LIVE_ACTIVITY_ATTRIBUTES_TYPE } from "./phonePush.js";
import { approvalLine, approvalSummary, classifyApproval, redactSecrets } from "./phoneApprovals.js";

export const LIVE_ACTIVITY_START_AFTER_MS = 8_000;
const ACTIVITY_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_DEVICES = 8;
const MAX_ACTIVITIES_PER_DEVICE = 12;
const ID_RE = /^[\w.:-]{1,128}$/;
const TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;

// ─── Token registry ──────────────────────────────────────────────────────

interface ActivityRecord {
  token: string;
  sessionId?: string;
  at: number;
}

interface DeviceRecord {
  deviceId: string;
  startToken?: { token: string; at: number };
  activities: Record<string, ActivityRecord>;
  updatedAt: number;
}

export interface Registration {
  deviceId: string;
  activityId: string;
  pushToken: string;
  kind: "update" | "start";
  sessionId?: string;
}

/** Validate a register body. Never trusts a field's shape. PURE. */
export function parseRegistration(body: Record<string, unknown>): { ok: true; value: Registration } | { ok: false; error: string } {
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (!ID_RE.test(deviceId)) return { ok: false, error: "deviceId is required (letters, digits, . _ : -)" };
  const kind = body.kind === "start" ? "start" : body.kind === "update" ? "update" : null;
  if (!kind) return { ok: false, error: 'kind must be "update" or "start"' };
  const pushToken = typeof body.pushToken === "string" ? body.pushToken.trim() : "";
  if (!TOKEN_RE.test(pushToken) || pushToken.length % 2 !== 0) return { ok: false, error: "pushToken must be a hex string" };
  let activityId = typeof body.activityId === "string" ? body.activityId.trim() : "";
  if (kind === "start") activityId = "push-to-start";
  else if (!ID_RE.test(activityId)) return { ok: false, error: "activityId is required for an update token" };
  const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : undefined;
  if (sessionId !== undefined && !ID_RE.test(sessionId)) return { ok: false, error: "sessionId has unexpected characters" };
  return { ok: true, value: { deviceId, activityId, pushToken: pushToken.toLowerCase(), kind, ...(sessionId ? { sessionId } : {}) } };
}

export class LiveActivityRegistry {
  private devices = new Map<string, DeviceRecord>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly storePath: string, private readonly now: () => number = Date.now) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.storePath, "utf8")) as { devices?: DeviceRecord[] };
      for (const d of raw.devices ?? []) {
        if (d && typeof d.deviceId === "string" && ID_RE.test(d.deviceId)) {
          this.devices.set(d.deviceId, { ...d, activities: d.activities && typeof d.activities === "object" ? d.activities : {}, updatedAt: Number(d.updatedAt) || 0 });
        }
      }
      this.prune();
    } catch {
      // First run — nothing registered yet.
    }
  }

  private prune(): void {
    const cutoff = this.now() - ACTIVITY_TTL_MS;
    for (const device of this.devices.values()) {
      for (const [id, a] of Object.entries(device.activities)) if (a.at < cutoff) delete device.activities[id];
      const ids = Object.keys(device.activities);
      if (ids.length > MAX_ACTIVITIES_PER_DEVICE) {
        ids.sort((a, b) => device.activities[a].at - device.activities[b].at);
        for (const id of ids.slice(0, ids.length - MAX_ACTIVITIES_PER_DEVICE)) delete device.activities[id];
      }
    }
    if (this.devices.size > MAX_DEVICES) {
      const sorted = [...this.devices.values()].sort((a, b) => a.updatedAt - b.updatedAt);
      for (const d of sorted.slice(0, this.devices.size - MAX_DEVICES)) this.devices.delete(d.deviceId);
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ devices: [...this.devices.values()] }, null, 2) + "\n";
    // Serialised, and written beside the file then renamed, so a crash mid-write never leaves half a registry.
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(path.dirname(this.storePath), { recursive: true });
        const tmp = `${this.storePath}.tmp`;
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.storePath);
      } catch {
        // Best effort: the tokens re-register on the next app launch.
      }
    });
    return this.writing;
  }

  async register(r: Registration): Promise<void> {
    await this.load();
    const at = this.now();
    const device = this.devices.get(r.deviceId) ?? { deviceId: r.deviceId, activities: {}, updatedAt: at };
    device.updatedAt = at;
    if (r.kind === "start") {
      device.startToken = { token: r.pushToken, at };
    } else {
      // A token is a handle to one activity: the same token under another id is a re-register.
      for (const [id, a] of Object.entries(device.activities)) if (a.token === r.pushToken && id !== r.activityId) delete device.activities[id];
      device.activities[r.activityId] = { token: r.pushToken, at, ...(r.sessionId ? { sessionId: r.sessionId } : {}) };
    }
    this.devices.set(r.deviceId, device);
    this.prune();
    await this.persist();
  }

  async unregister(q: { deviceId: string; activityId?: string; kind?: "update" | "start" }): Promise<number> {
    await this.load();
    const device = this.devices.get(q.deviceId);
    if (!device) return 0;
    let removed = 0;
    if (q.kind === "start") {
      if (device.startToken) { device.startToken = undefined; removed++; }
    } else if (q.activityId) {
      if (device.activities[q.activityId]) { delete device.activities[q.activityId]; removed++; }
    } else {
      removed += Object.keys(device.activities).length + (device.startToken ? 1 : 0);
      this.devices.delete(q.deviceId);
    }
    if (removed) await this.persist();
    return removed;
  }

  /** Forget a token Apple said is dead. */
  async removeToken(token: string): Promise<boolean> {
    await this.load();
    let hit = false;
    for (const device of this.devices.values()) {
      if (device.startToken?.token === token) { device.startToken = undefined; hit = true; }
      for (const [id, a] of Object.entries(device.activities)) if (a.token === token) { delete device.activities[id]; hit = true; }
    }
    if (hit) await this.persist();
    return hit;
  }

  /** The activities currently running for one session, across devices. */
  forSession(sessionId: string): Array<{ deviceId: string; activityId: string; token: string }> {
    const out: Array<{ deviceId: string; activityId: string; token: string }> = [];
    for (const d of this.devices.values()) {
      for (const [activityId, a] of Object.entries(d.activities)) if (a.sessionId === sessionId) out.push({ deviceId: d.deviceId, activityId, token: a.token });
    }
    return out;
  }

  /** Push-to-start tokens: one per device that can start an activity remotely. */
  startTokens(): Array<{ deviceId: string; token: string }> {
    return [...this.devices.values()].filter((d) => d.startToken).map((d) => ({ deviceId: d.deviceId, token: d.startToken!.token }));
  }

  /** What the diagnostics route may say: counts, never tokens. */
  summary(): Array<{ deviceId: string; hasStartToken: boolean; activities: number }> {
    return [...this.devices.values()].map((d) => ({ deviceId: d.deviceId, hasStartToken: !!d.startToken, activities: Object.keys(d.activities).length }));
  }
}

// ─── The driver ──────────────────────────────────────────────────────────

export type ActivityPhase = "working" | "needsApproval" | "done" | "failed";

/** Mirrors AresActivityAttributes.ContentState in the widget extension. */
export interface ActivityContentState {
  phase: ActivityPhase;
  headline: string;
  detail: string;
  /** Epoch seconds the turn began: the widget draws its own ticking timer from it. */
  startedAt: number;
  /** Epoch seconds the turn finished; freezes the timer. */
  endedAt?: number;
  /** 0...1 when the agent keeps a todo list. */
  progress?: number;
  pendingCount: number;
}

export interface ActivitySender {
  sendLiveActivity(deviceToken: string, push: LiveActivityPush): Promise<number>;
}

export interface DriverTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LiveActivityDriverOptions {
  registry: LiveActivityRegistry;
  sender: ActivitySender;
  agentName?: (sessionId: string) => string;
  /** A short name for what the turn is about (the session's title). */
  taskLabel?: (sessionId: string) => string | undefined;
  /** Only the owner's phone threads get an activity. */
  isMobileSession?: (sessionId: string) => boolean;
  /** Called when the set of pending approvals changes (nudges the widgets). */
  onApprovalsChanged?: () => void;
  now?: () => number;
  timers?: DriverTimers;
  startAfterMs?: number;
  /** Minimum gap between progress updates. */
  workingGapMs?: number;
  /** Minimum gap between state-change updates. */
  stateGapMs?: number;
  maxPerHour?: number;
  /** How long a finished activity stays on the lock screen. */
  lingerMs?: number;
  log?: (line: string) => void;
}

interface Run {
  sessionId: string;
  startedAtMs: number;
  headline: string;
  detail: string;
  progress?: number;
  pending: Map<string, string>;
  phase: "working" | "needsApproval";
  active: boolean;
  startPushedAt?: number;
  lastPushAt: number;
  lastKey: string;
  sent: number[];
  startTimer?: unknown;
  flushTimer?: unknown;
  reply: string;
  ended: boolean;
}

const realTimers: DriverTimers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// eslint-disable-next-line no-control-regex
const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
const safeLine = (s: unknown, n: number): string => clip(oneLine(redactSecrets(typeof s === "string" ? s : "")), n);

/** The first sentence of a reply, short, for the line the activity ends on. PURE. */
export function resultLine(reply: string | undefined, failed: boolean, elapsedMs: number): string {
  if (failed) return "Hit a problem";
  const text = safeLine(reply ?? "", 400);
  if (text) {
    const sentence = /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text;
    return clip(sentence, 90);
  }
  const s = Math.max(1, Math.round(elapsedMs / 1000));
  return s >= 60 ? `Done in ${Math.floor(s / 60)}m ${s % 60}s` : `Done in ${s}s`;
}

export class LiveActivityDriver {
  private readonly runs = new Map<string, Run>();
  private backoffUntil = 0;
  private readonly now: () => number;
  private readonly timers: DriverTimers;
  private readonly startAfterMs: number;
  private readonly workingGapMs: number;
  private readonly stateGapMs: number;
  private readonly maxPerHour: number;
  private readonly lingerMs: number;
  private readonly log: (line: string) => void;
  /** Sends in flight, so tests (and shutdown) can wait for them. */
  private inflight = new Set<Promise<void>>();

  constructor(private readonly opts: LiveActivityDriverOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.startAfterMs = opts.startAfterMs ?? LIVE_ACTIVITY_START_AFTER_MS;
    this.workingGapMs = opts.workingGapMs ?? 20_000;
    this.stateGapMs = opts.stateGapMs ?? 1_500;
    this.maxPerHour = opts.maxPerHour ?? 90;
    this.lingerMs = opts.lingerMs ?? 5 * 60_000;
    this.log = opts.log ?? (() => {});
    // Read the registry now, so the first turn after a restart already knows its activities.
    void opts.registry.load().catch(() => undefined);
  }

  /** The notifier's observer hook: every gateway event for every attached session. */
  onSessionEvent(sessionId: string, event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    if (type === "permission_request" || type === "permission_response") this.opts.onApprovalsChanged?.();
    const mobile = this.opts.isMobileSession?.(sessionId) ?? true;
    if (type === "turn_start") {
      if (!mobile) return;
      this.beginRun(sessionId);
      return;
    }
    const run = this.runs.get(sessionId);
    if (!run || run.ended) return;
    switch (type) {
      case "text_delta":
        run.reply = (run.reply + String(event.text ?? "")).slice(-400);
        return;
      case "tool_start": {
        const line = safeLine(event.activityDescription || event.name, 60);
        if (line && line !== run.detail && run.phase === "working") {
          run.detail = line;
          if (run.active) this.request(run, "progress");
        }
        return;
      }
      case "todo_updated": {
        const todos = Array.isArray(event.todos) ? (event.todos as Array<{ status?: string }>) : [];
        const live = todos.filter((t) => t && t.status !== "cancelled");
        run.progress = live.length ? Math.min(1, live.filter((t) => t.status === "completed").length / live.length) : undefined;
        if (run.active) this.request(run, "progress");
        return;
      }
      case "permission_request": {
        const cls = classifyApproval({ toolName: String(event.toolName ?? ""), input: event.input, reason: String(event.reason ?? ""), ownerDecision: event.ownerDecision === true });
        const line = approvalLine(approvalSummary(String(event.toolName ?? "a tool"), event.input, cls));
        run.pending.set(String(event.id ?? ""), clip(line, 80));
        run.phase = "needsApproval";
        run.detail = clip(line, 80);
        // An approval cannot wait out the eight seconds: it is the reason to look.
        if (!run.active) this.activate(run);
        else this.request(run, "state");
        return;
      }
      case "permission_response": {
        run.pending.delete(String(event.id ?? ""));
        if (run.pending.size === 0 && run.phase === "needsApproval") {
          run.phase = "working";
          run.detail = "Working";
          if (run.active) this.request(run, "state");
        }
        return;
      }
      case "turn_end":
        this.finish(run, String(event.status ?? "") === "failed");
        return;
      default:
        return;
    }
  }

  /** The app just registered an update token for a running activity: show it the present, not the past. */
  onActivityRegistered(sessionId: string | undefined): void {
    if (!sessionId) return;
    const run = this.runs.get(sessionId);
    if (!run || run.ended || !run.active) return;
    this.track(this.push(run, "state"));
  }

  /** Wait for every in-flight push (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      if (run.startTimer) this.timers.clear(run.startTimer);
      if (run.flushTimer) this.timers.clear(run.flushTimer);
    }
    this.runs.clear();
  }

  // ── internals ──

  private beginRun(sessionId: string): void {
    const previous = this.runs.get(sessionId);
    if (previous) {
      if (previous.startTimer) this.timers.clear(previous.startTimer);
      if (previous.flushTimer) this.timers.clear(previous.flushTimer);
    }
    const run: Run = {
      sessionId,
      startedAtMs: this.now(),
      headline: this.headlineFor(sessionId),
      detail: "Working",
      pending: new Map(),
      phase: "working",
      active: false,
      lastPushAt: 0,
      lastKey: "",
      sent: [],
      reply: "",
      ended: false,
    };
    // A turn that carried an activity from before (rapid follow-ups) keeps showing it.
    if (this.opts.registry.forSession(sessionId).length > 0) run.active = true;
    run.startTimer = this.timers.set(() => { run.startTimer = undefined; this.activate(run); }, this.startAfterMs);
    this.runs.set(sessionId, run);
    if (run.active) this.track(this.push(run, "state"));
  }

  private headlineFor(sessionId: string): string {
    const label = safeLine(this.opts.taskLabel?.(sessionId) ?? "", 60);
    return label && !/^(untitled session|voice)$/i.test(label) ? label : "your request";
  }

  private activate(run: Run): void {
    if (run.ended || this.runs.get(run.sessionId) !== run) return;
    run.active = true;
    run.headline = this.headlineFor(run.sessionId);
    this.track(this.push(run, "state"));
  }

  private stateOf(run: Run, over?: Partial<ActivityContentState>): ActivityContentState {
    return {
      phase: run.phase,
      headline: run.headline,
      detail: run.detail,
      startedAt: Math.floor(run.startedAtMs / 1000),
      ...(run.progress !== undefined ? { progress: Math.round(run.progress * 100) / 100 } : {}),
      pendingCount: run.pending.size,
      ...over,
    };
  }

  /** Ask for a push, spaced: state changes soon, progress rarely. Trailing edge wins. */
  private request(run: Run, kind: "progress" | "state"): void {
    const gap = kind === "state" ? this.stateGapMs : this.workingGapMs;
    const wait = run.lastPushAt + gap - this.now();
    if (wait <= 0) return this.track(this.push(run, kind));
    if (run.flushTimer) {
      // A state change must not be held to the slower progress cadence.
      if (kind === "progress") return;
      this.timers.clear(run.flushTimer);
    }
    run.flushTimer = this.timers.set(() => { run.flushTimer = undefined; this.track(this.push(run, kind)); }, wait);
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async push(run: Run, kind: "progress" | "state"): Promise<void> {
    if (run.ended || !run.active) return;
    try {
      await this.opts.registry.load();
      const t = this.now();
      if (t < this.backoffUntil) return;
      const state = this.stateOf(run);
      const key = JSON.stringify([state.phase, state.headline, state.detail, state.progress ?? null, state.pendingCount]);
      if (key === run.lastKey) return;
      run.sent = run.sent.filter((x) => t - x < 3_600_000);
      if (kind === "progress" && run.sent.length >= this.maxPerHour) return;
      const targets = this.opts.registry.forSession(run.sessionId);
      const priority = kind === "state" ? 10 : 5;
      if (targets.length > 0) {
        run.lastKey = key;
        run.lastPushAt = t;
        run.sent.push(t);
        await Promise.all(targets.map((x) => this.send(x.token, { event: "update", contentState: { ...state }, priority })));
        return;
      }
      // No activity on any phone yet: ask each one that can start remotely — ONCE per turn.
      // The start carries an alert; if the owner turned Live Activities off, asking again
      // on every progress tick would just be a stream of banners.
      if (run.startPushedAt !== undefined) return;
      const starters = this.opts.registry.startTokens();
      if (starters.length === 0) return;
      run.startPushedAt = t;
      run.lastKey = key;
      run.lastPushAt = t;
      run.sent.push(t);
      const agent = safeLine(this.opts.agentName?.(run.sessionId) ?? "Ares", 40) || "Ares";
      await Promise.all(starters.map((x) => this.send(x.token, {
        event: "start",
        contentState: { ...state },
        attributesType: LIVE_ACTIVITY_ATTRIBUTES_TYPE,
        attributes: { sessionId: run.sessionId, agentName: agent },
        alert: { title: agent, body: state.phase === "needsApproval" ? "Needs your approval" : `Working on ${state.headline}` },
        priority: 10,
      })));
    } catch (err) {
      this.log(`live activity: push failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private async send(token: string, push: LiveActivityPush): Promise<void> {
    try {
      const status = await this.opts.sender.sendLiveActivity(token, push);
      if (status === 200 || status === 0) return;
      if (status === 410 || status === 400) {
        await this.opts.registry.removeToken(token);
        this.log(`live activity: dropped a dead token (${status})`);
      } else if (status === 429) {
        this.backoffUntil = this.now() + 60_000;
        this.log("live activity: Apple asked us to slow down; pausing a minute");
      } else {
        this.log(`live activity: apns returned ${status}`);
      }
    } catch (err) {
      this.log(`live activity: send failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private finish(run: Run, failed: boolean): void {
    run.ended = true;
    if (run.startTimer) this.timers.clear(run.startTimer);
    if (run.flushTimer) this.timers.clear(run.flushTimer);
    this.runs.delete(run.sessionId);
    if (!run.active) return; // finished inside the eight seconds: nothing was ever shown
    const t = this.now();
    const line = resultLine(run.reply, failed, t - run.startedAtMs);
    const state: ActivityContentState = {
      phase: failed ? "failed" : "done",
      headline: run.headline,
      detail: line,
      startedAt: Math.floor(run.startedAtMs / 1000),
      endedAt: Math.floor(t / 1000),
      ...(failed || run.progress === undefined ? {} : { progress: 1 }),
      pendingCount: 0,
    };
    this.track((async () => {
      try {
        await this.opts.registry.load();
        const targets = this.opts.registry.forSession(run.sessionId);
        const dismissalDate = Math.floor((t + this.lingerMs) / 1000);
        await Promise.all(targets.map((x) => this.send(x.token, { event: "end", contentState: { ...state }, dismissalDate, priority: 10 })));
        // The activity is over: forget its token so a later turn starts a fresh one.
        for (const x of targets) await this.opts.registry.removeToken(x.token);
      } catch (err) {
        this.log(`live activity: end failed (${err instanceof Error ? err.message : String(err)})`);
      }
    })());
  }
}

// ─── Widgets: a silent push, rarely ─────────────────────────────────────

/**
 * Tell the phone its widgets are stale. A silent push is low priority and Apple
 * throttles it hard, so this coalesces: at most one per `minGapMs`, and the last
 * call inside the gap is the one that goes.
 */
export function createWidgetNudger(
  sendBackground: (data: Record<string, unknown>) => Promise<unknown>,
  opts: { minGapMs?: number; now?: () => number; timers?: DriverTimers; log?: (line: string) => void } = {},
): () => void {
  const minGap = opts.minGapMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? realTimers;
  let last = 0;
  let timer: unknown;
  const fire = () => {
    timer = undefined;
    last = now();
    // deviceWake:false so the phone does not also go and poll for Phone Hands requests.
    void sendBackground({ kind: "widget_refresh", deviceWake: false }).catch((err) => opts.log?.(`widget nudge failed (${err instanceof Error ? err.message : String(err)})`));
  };
  return () => {
    if (timer) return;
    const wait = last + minGap - now();
    if (wait <= 0) return fire();
    timer = timers.set(fire, wait);
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────

const BODY_LIMIT = 4 * 1024;

export interface LiveActivityApiDeps {
  registry: LiveActivityRegistry;
  driver?: Pick<LiveActivityDriver, "onActivityRegistered">;
  /** Is APNs configured on this garrison? The app shows the truth instead of assuming. */
  configured: () => boolean;
  log?: (line: string) => void;
}

export function createLiveActivityApi(deps: LiveActivityApiDeps) {
  const send = (res: ServerResponse, status: number, body: unknown): true => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
    return true;
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > BODY_LIMIT) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (total === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/liveactivity" && !url.pathname.startsWith("/gateway/liveactivity/")) return false;
    const sub = url.pathname.slice("/gateway/liveactivity".length).replace(/^\/|\/$/g, "");
    try {
      if (sub === "" && req.method === "GET") {
        await deps.registry.load();
        return send(res, 200, { configured: deps.configured(), devices: deps.registry.summary() });
      }
      if (sub === "register" && req.method === "POST") {
        const parsed = parseRegistration(await readJson(req));
        if (!parsed.ok) return send(res, 400, { error: parsed.error });
        await deps.registry.register(parsed.value);
        deps.log?.(`liveactivity: registered a ${parsed.value.kind} token`);
        if (parsed.value.kind === "update") deps.driver?.onActivityRegistered(parsed.value.sessionId);
        return send(res, 200, { ok: true, kind: parsed.value.kind, configured: deps.configured() });
      }
      if (sub === "unregister" && req.method === "POST") {
        const body = await readJson(req);
        const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
        if (!ID_RE.test(deviceId)) return send(res, 400, { error: "deviceId is required" });
        const activityId = typeof body.activityId === "string" && ID_RE.test(body.activityId.trim()) ? body.activityId.trim() : undefined;
        const kind = body.kind === "start" ? "start" : body.kind === "update" ? "update" : undefined;
        const removed = await deps.registry.unregister({ deviceId, ...(activityId ? { activityId } : {}), ...(kind ? { kind } : {}) });
        return send(res, 200, { ok: true, removed });
      }
      const known = sub === "" || sub === "register" || sub === "unregister";
      return send(res, known ? 405 : 404, { error: known ? "method not allowed" : "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/too large/.test(message)) return send(res, 413, { error: message });
      if (err instanceof SyntaxError) return send(res, 400, { error: "invalid JSON" });
      deps.log?.(`liveactivity: ${req.method} ${url.pathname} failed: ${message}`);
      return send(res, 500, { error: "internal error" });
    }
  };
}
