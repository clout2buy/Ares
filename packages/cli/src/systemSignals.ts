// Live signals the System snapshot needs that nothing else keeps: a scrubbed
// ring of recent errors, per-provider breaker state, and the event loop's lag.
// Fed from the garrison's session event tap (see SessionManagerOptions.onEvent)
// and read, never written, by the snapshot service. Pure and clock-injectable
// so the thresholds are tested without waiting.

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import os from "node:os";
import { redactSecrets } from "./phoneApprovals.js";

// ─── Recent errors ──────────────────────────────────────────────────────

export interface ErrorEntry {
  at: string;
  source: string;
  message: string;
}

const HOME_RE = (): RegExp | null => {
  const home = os.homedir();
  return home && home.length > 2 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : null;
};

/** One line, credentials redacted, the owner's home directory shortened, clipped. */
export function scrubErrorText(text: unknown, limit = 240): string {
  let out = redactSecrets(String(text ?? ""));
  const home = HOME_RE();
  if (home) out = out.replace(home, "~");
  out = out.replace(/\s+/g, " ").trim();
  return out.length > limit ? `${out.slice(0, limit - 1).trimEnd()}...` : out;
}

export class ErrorRing {
  private readonly ring: ErrorEntry[] = [];
  constructor(private readonly capacity = 50, private readonly now: () => number = Date.now) {}

  record(source: string, message: unknown): void {
    const text = scrubErrorText(message);
    if (!text) return;
    const last = this.ring[this.ring.length - 1];
    // A hot loop must not push everything else out: collapse an exact repeat.
    if (last && last.source === source && last.message === text) {
      last.at = new Date(this.now()).toISOString();
      return;
    }
    this.ring.push({ at: new Date(this.now()).toISOString(), source: scrubErrorText(source, 40), message: text });
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  /** Newest first. */
  recent(limit = 10): ErrorEntry[] {
    return this.ring.slice(-Math.max(1, limit)).reverse().map((e) => ({ ...e }));
  }
}

// ─── Provider breaker state ─────────────────────────────────────────────

export type BreakerState = "closed" | "degraded" | "open";

export interface ProviderBreaker {
  provider: string;
  state: BreakerState;
  consecutiveFailures: number;
  lastOkAt?: string;
  lastFailureAt?: string;
  lastError?: string;
  /** How long this provider has been failing without a success (ms); 0 when healthy. */
  failingForMs: number;
}

interface ProviderRecord {
  consecutiveFailures: number;
  firstFailureAt?: number;
  lastOkAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

/** An outage is declared after this many failures in a row with no success between. */
export const BREAKER_OPEN_AFTER = 3;
export const BREAKER_DEGRADED_AFTER = 2;
/** With no new failure for this long the provider is shown closed again: no traffic is not an outage. */
export const BREAKER_FORGET_MS = 15 * 60_000;

export class ProviderHealth {
  private readonly records = new Map<string, ProviderRecord>();
  constructor(private readonly now: () => number = Date.now) {}

  ok(provider: string): void {
    if (!provider) return;
    const r = this.records.get(provider) ?? { consecutiveFailures: 0 };
    r.consecutiveFailures = 0;
    r.firstFailureAt = undefined;
    r.lastOkAt = this.now();
    this.records.set(provider, r);
  }

  fail(provider: string, error?: unknown): void {
    if (!provider) return;
    const r = this.records.get(provider) ?? { consecutiveFailures: 0 };
    if (r.lastFailureAt !== undefined && this.now() - r.lastFailureAt > BREAKER_FORGET_MS) r.consecutiveFailures = 0;
    if (r.consecutiveFailures === 0) r.firstFailureAt = this.now();
    r.consecutiveFailures += 1;
    r.lastFailureAt = this.now();
    if (error !== undefined) r.lastError = scrubErrorText(error, 160);
    this.records.set(provider, r);
  }

  states(): ProviderBreaker[] {
    const now = this.now();
    const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
    return [...this.records.entries()]
      .map(([provider, r]): ProviderBreaker => {
        const forgotten = r.lastFailureAt !== undefined && now - r.lastFailureAt > BREAKER_FORGET_MS;
        const failures = forgotten ? 0 : r.consecutiveFailures;
        return {
        provider,
        state: failures >= BREAKER_OPEN_AFTER ? "open" : failures >= BREAKER_DEGRADED_AFTER ? "degraded" : "closed",
        consecutiveFailures: failures,
        ...(r.lastOkAt !== undefined ? { lastOkAt: iso(r.lastOkAt) } : {}),
        ...(r.lastFailureAt !== undefined ? { lastFailureAt: iso(r.lastFailureAt) } : {}),
        ...(r.lastError && failures > 0 ? { lastError: r.lastError } : {}),
        failingForMs: failures > 0 && r.firstFailureAt !== undefined ? Math.max(0, now - r.firstFailureAt) : 0,
        };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

// ─── Event loop lag ─────────────────────────────────────────────────────

export interface LoopLag {
  meanMs: number;
  p99Ms: number;
  maxMs: number;
}

export class LoopMonitor {
  private histogram: IntervalHistogram | null = null;
  private last: LoopLag = { meanMs: 0, p99Ms: 0, maxMs: 0 };
  private lastSampleAt = 0;

  constructor(private readonly now: () => number = Date.now, private readonly windowMs = 60_000) {}

  start(): void {
    if (this.histogram) return;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.lastSampleAt = this.now();
    } catch {
      this.histogram = null;
    }
  }

  stop(): void {
    try {
      this.histogram?.disable();
    } catch {
      // nothing to release
    }
    this.histogram = null;
  }

  /** Lag over roughly the last window; the histogram is reset when the window rolls. */
  read(): LoopLag {
    const h = this.histogram;
    if (!h) return this.last;
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.round((ns / 1e6) * 10) / 10 : 0);
    if (h.count > 0) this.last = { meanMs: ms(h.mean), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) };
    if (this.now() - this.lastSampleAt >= this.windowMs) {
      h.reset();
      this.lastSampleAt = this.now();
    }
    return this.last;
  }
}
