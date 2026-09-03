// The Garrison's clock — interval ticks that call injected entity hooks.
// V1 keeps the hooks opaque (() => Promise): the daemon composition wires
// runHeartbeatTick / dream cycles in here; tests wire counters.
//
// Heartbeat: every heartbeatEveryMs (default 30 min).
// Dream: checked every dreamCheckEveryMs (default 10 min); fires only when no
// session.send happened for idleMs (default 2 h), and the idle clock restarts
// after each dream so an idle night doesn't dream every check.
// Gauntlet: checked every gauntletCheckEveryMs (default 10 min); fires ONCE per
// local calendar day, inside the window [ARES_GAUNTLET_HOUR, +ARES_GAUNTLET_
// WINDOW_HOURS) (default 03:00–06:00), and only while no turn is active — a
// benchmark must never steal the box from a live coding session. If the daemon
// stays busy through the whole window the night is skipped, not deferred to
// the afternoon. ARES_GAUNTLET_SCHEDULE=0 disables it outright.
//
// Hooks never overlap themselves. The gauntlet hook's result is recorded by
// gauntletNightly (trend ledger + triage finding on regression) and the outcome
// is published on the scheduler's event stream, which the GarrisonServer
// forwards to every attached client as a `garrison.event` frame.
//
// now()/setInterval/clearInterval are injectable so tests use fake timers and
// never wait. Real timers are unref()'d — the scheduler alone never holds the
// process open.

import { recordNightlyGauntlet, type GauntletRunSummary, type NightlyGauntletOutcome } from "./gauntletNightly.js";

export interface SchedulerHooks {
  heartbeat?: () => Promise<unknown> | unknown;
  dream?: () => Promise<unknown> | unknown;
  /** Host-injected gauntlet runner (the CLI's runScheduledGauntlet). */
  gauntlet?: () => Promise<GauntletRunSummary> | GauntletRunSummary;
}

export type SchedulerHookName = keyof SchedulerHooks;

/** Events the scheduler publishes — the UI/Telegram surface these. */
export type SchedulerEvent =
  | {
      kind: "gauntlet_run";
      at: string;
      summary: GauntletRunSummary;
      regressed: boolean;
    }
  | {
      kind: "gauntlet_regression";
      at: string;
      summary: GauntletRunSummary;
      reasons: string[];
      previous: { at: string; passed: number; total: number } | null;
      findingId?: string;
      findingFile?: string;
    };

export interface SchedulerOptions {
  hooks: SchedulerHooks;
  /** Heartbeat cadence; default 30 minutes. */
  heartbeatEveryMs?: number;
  /** Dream after this much send-silence; default 2 hours. */
  idleMs?: number;
  /** How often the idle check runs; default 10 minutes. */
  dreamCheckEveryMs?: number;
  /** Epoch ms of the last session.send (SessionManager.lastActivityAt). */
  lastActivityAt?: () => number;
  /** Live turns right now (SessionManager busy count). The gauntlet waits for 0. */
  activeTurns?: () => number;
  /** Local hour the nightly gauntlet window opens; default ARES_GAUNTLET_HOUR or 3. */
  gauntletHour?: number;
  /** Hours the window stays open; default ARES_GAUNTLET_WINDOW_HOURS or 3. */
  gauntletWindowHours?: number;
  /** How often the gauntlet window is checked; default 10 minutes. */
  gauntletCheckEveryMs?: number;
  /** Master switch; default true unless ARES_GAUNTLET_SCHEDULE=0. */
  gauntletEnabled?: boolean;
  /** Ares home for the nightly ledger + triage finding. Absent = record nothing. */
  home?: string;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  onError?: (hook: SchedulerHookName, err: unknown) => void;
}

const DEFAULT_HEARTBEAT_MS = 30 * 60_000;
const DEFAULT_IDLE_MS = 2 * 60 * 60_000;
const DEFAULT_DREAM_CHECK_MS = 10 * 60_000;
const DEFAULT_GAUNTLET_CHECK_MS = 10 * 60_000;
const DEFAULT_GAUNTLET_HOUR = 3;
const DEFAULT_GAUNTLET_WINDOW_HOURS = 3;

function envHour(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(23, Math.max(0, Math.floor(n))) : fallback;
}

/** The env-derived defaults, exported so the daemon's status line can echo them. */
export function gauntletScheduleDefaults(): { enabled: boolean; hour: number; windowHours: number } {
  const windowRaw = Number(process.env.ARES_GAUNTLET_WINDOW_HOURS);
  return {
    enabled: process.env.ARES_GAUNTLET_SCHEDULE !== "0",
    hour: envHour(process.env.ARES_GAUNTLET_HOUR, DEFAULT_GAUNTLET_HOUR),
    windowHours: Number.isFinite(windowRaw) && windowRaw > 0 ? Math.min(24, windowRaw) : DEFAULT_GAUNTLET_WINDOW_HOURS,
  };
}

function defaultSetInterval(fn: () => void, ms: number): unknown {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return timer;
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as Parameters<typeof clearInterval>[0]);
}

/** Local calendar day key — the "once per night" latch is per LOCAL day. */
function localDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class Scheduler {
  readonly heartbeatEveryMs: number;
  readonly idleMs: number;
  readonly dreamCheckEveryMs: number;
  readonly gauntletCheckEveryMs: number;
  readonly gauntletHour: number;
  readonly gauntletWindowHours: number;
  readonly gauntletEnabled: boolean;

  private readonly opts: SchedulerOptions;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly nowFn: () => number;
  private handles: unknown[] = [];
  private startedAtMs: number | undefined;
  private lastDreamAt: number | undefined;
  private lastGauntletDay: string | undefined;
  private lastGauntletOutcome: NightlyGauntletOutcome | undefined;
  private readonly running: Record<SchedulerHookName, boolean> = { heartbeat: false, dream: false, gauntlet: false };
  private readonly listeners = new Set<(event: SchedulerEvent) => void>();

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    const defaults = gauntletScheduleDefaults();
    this.heartbeatEveryMs = opts.heartbeatEveryMs ?? DEFAULT_HEARTBEAT_MS;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.dreamCheckEveryMs = opts.dreamCheckEveryMs ?? DEFAULT_DREAM_CHECK_MS;
    this.gauntletCheckEveryMs = opts.gauntletCheckEveryMs ?? DEFAULT_GAUNTLET_CHECK_MS;
    this.gauntletHour = opts.gauntletHour ?? defaults.hour;
    this.gauntletWindowHours = opts.gauntletWindowHours ?? defaults.windowHours;
    this.gauntletEnabled = opts.gauntletEnabled ?? defaults.enabled;
    this.setIntervalFn = opts.setIntervalFn ?? defaultSetInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? defaultClearInterval;
    this.nowFn = opts.now ?? Date.now;
  }

  start(): void {
    if (this.handles.length > 0) return;
    this.startedAtMs = this.nowFn();
    if (this.opts.hooks.heartbeat) {
      this.handles.push(this.setIntervalFn(() => void this.runHook("heartbeat"), this.heartbeatEveryMs));
    }
    if (this.opts.hooks.dream) {
      this.handles.push(this.setIntervalFn(() => this.dreamCheck(), this.dreamCheckEveryMs));
    }
    if (this.opts.hooks.gauntlet && this.gauntletEnabled) {
      this.handles.push(this.setIntervalFn(() => this.gauntletCheck(), this.gauntletCheckEveryMs));
    }
  }

  stop(): void {
    for (const handle of this.handles.splice(0)) this.clearIntervalFn(handle);
  }

  get started(): boolean {
    return this.handles.length > 0;
  }

  /** Subscribe to scheduler events (gauntlet outcomes). Returns unsubscribe. */
  subscribe(listener: (event: SchedulerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Epoch ms when a dream becomes eligible; undefined without a dream hook. */
  nextDreamAt(): number | undefined {
    if (!this.opts.hooks.dream) return undefined;
    return this.idleBaseline() + this.idleMs;
  }

  /** Epoch ms when the next nightly window opens; undefined when disabled. */
  nextGauntletAt(): number | undefined {
    if (!this.opts.hooks.gauntlet || !this.gauntletEnabled) return undefined;
    const nowMs = this.nowFn();
    const now = new Date(nowMs);
    const opensToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), this.gauntletHour, 0, 0, 0).getTime();
    const closesToday = opensToday + this.gauntletWindowHours * 3_600_000;
    const doneToday = this.lastGauntletDay === localDayKey(nowMs);
    // Inside (or ahead of) tonight's window and not yet run → the next check
    // inside the window fires it; otherwise tomorrow's opening.
    if (!doneToday && nowMs < closesToday) return Math.max(opensToday, nowMs);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, this.gauntletHour, 0, 0, 0).getTime();
  }

  /** Last nightly outcome this process recorded, for status surfaces. */
  lastGauntlet(): NightlyGauntletOutcome | undefined {
    return this.lastGauntletOutcome;
  }

  private idleBaseline(): number {
    return Math.max(
      this.opts.lastActivityAt?.() ?? 0,
      this.lastDreamAt ?? 0,
      this.startedAtMs ?? this.nowFn(),
    );
  }

  private dreamCheck(): void {
    if (this.nowFn() - this.idleBaseline() < this.idleMs) return;
    this.lastDreamAt = this.nowFn();
    void this.runHook("dream");
  }

  private gauntletCheck(): void {
    if (!this.opts.hooks.gauntlet || !this.gauntletEnabled || this.running.gauntlet) return;
    const nowMs = this.nowFn();
    const day = localDayKey(nowMs);
    if (this.lastGauntletDay === day) return;
    const hour = new Date(nowMs).getHours();
    if (hour < this.gauntletHour || hour >= this.gauntletHour + this.gauntletWindowHours) return;
    if ((this.opts.activeTurns?.() ?? 0) > 0) return; // busy: try again next check, same night
    this.lastGauntletDay = day;
    void this.runGauntlet();
  }

  private async runGauntlet(): Promise<void> {
    this.running.gauntlet = true;
    try {
      const summary = await this.opts.hooks.gauntlet!();
      const at = new Date(this.nowFn()).toISOString();
      if (!this.opts.home) {
        this.emit({ kind: "gauntlet_run", at, summary, regressed: false });
        return;
      }
      const outcome = await recordNightlyGauntlet({ home: this.opts.home, summary, now: new Date(this.nowFn()) });
      this.lastGauntletOutcome = outcome;
      this.emit({ kind: "gauntlet_run", at, summary, regressed: outcome.regressed });
      if (outcome.regressed) {
        this.emit({
          kind: "gauntlet_regression",
          at,
          summary,
          reasons: outcome.reasons,
          previous: outcome.previous ? { at: outcome.previous.at, passed: outcome.previous.passed, total: outcome.previous.total } : null,
          ...(outcome.findingId ? { findingId: outcome.findingId } : {}),
          ...(outcome.findingFile ? { findingFile: outcome.findingFile } : {}),
        });
      }
    } catch (err) {
      this.opts.onError?.("gauntlet", err);
    } finally {
      this.running.gauntlet = false;
    }
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a broken listener never breaks the clock
      }
    }
  }

  private async runHook(name: "heartbeat" | "dream"): Promise<void> {
    if (this.running[name]) return; // never overlap a slow hook with itself
    this.running[name] = true;
    try {
      await this.opts.hooks[name]?.();
    } catch (err) {
      this.opts.onError?.(name, err);
    } finally {
      this.running[name] = false;
    }
  }
}
