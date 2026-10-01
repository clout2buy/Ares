// System alerts: the box tells the owner's phone when something needs them, once.
//
// Rules over the System snapshot (plus a few signals the snapshot does not
// carry) become CANDIDATES, keyed (`disk`, `provider:anthropic`, `stuck:<id>`).
// The engine de-dupes by key against a small state file so a condition that
// stays true pushes ONCE, reminds rarely, and says "resolved" in the feed when
// it clears. Quiet hours hold non-critical pushes until the window ends (a held
// alert still shows in the feed and is sent as soon as quiet hours close, if it
// is still true). Every transition is an event in /gateway/system/events.
//
// Push goes through the existing phonePush (APNs straight to the owner); this
// module never talks to a network itself.

import { promises as fs } from "node:fs";
import path from "node:path";
import { minutesOfDay, parseClock, resolveTimeZone } from "./phoneCommon.js";
import { scrubErrorText } from "./systemSignals.js";
import type { SystemSnapshot } from "./systemSnapshot.js";

export type AlertKind =
  | "disk"
  | "memory"
  | "crash_loop"
  | "provider_outage"
  | "stuck_turn"
  | "connector_expired"
  | "backup_failed"
  | "deploy_rolled_back"
  | "housekeeping_failed";

export interface AlertCandidate {
  key: string;
  kind: AlertKind;
  title: string;
  body: string;
  /** Pierces quiet hours. Reserved for "the box is about to fall over". */
  critical?: boolean;
  /** Feed only, never pushed (the 80% disk heads-up). */
  feedOnly?: boolean;
}

export interface SystemEvent {
  at: string;
  /** raised, resolved, held, reminder, push_failed, or a free-form kind from housekeeping/backup. */
  kind: string;
  alert?: AlertKind;
  key?: string;
  title: string;
  body?: string;
  pushed?: boolean;
}

interface ActiveAlert {
  kind: AlertKind;
  firstAt: number;
  lastSentAt?: number;
  lastAttemptAt?: number;
  sends: number;
  held?: boolean;
  /** Consecutive evaluations where the condition was false. */
  misses: number;
}

interface AlertState {
  active: Record<string, ActiveAlert>;
}

export interface Signals {
  /** Process starts in the last 30 minutes (this one included). */
  recentBoots?: number;
  /** Crash artifacts written in the last hour. */
  recentCrashes?: number;
  /** A deploy was rolled back; `id` makes it a one-shot. */
  deployRolledBack?: { id: string; reason?: string };
}

export interface AlertEngineOptions {
  home: string;
  push?: (message: { title: string; body: string; collapseId?: string; data?: Record<string, unknown> }) => Promise<unknown>;
  pushReady?: () => boolean;
  now?: () => number;
  /** "23:00-07:00", or "off". Default ARES_ALERT_QUIET or 23:00-07:00. */
  quiet?: string;
  timeZone?: string;
  reminderMs?: number;
  maxReminders?: number;
  retryMs?: number;
  log?: (line: string) => void;
}

const EVENT_FILE_MAX_LINES = 1_000;
const CONNECTOR_AUTH_RE = /sign.?in|token|expired|reconnect|unauthori[sz]ed|\b40[13]\b|re-?auth|login/i;

export const DISK_PUSH_PCT = 85;
export const DISK_CRITICAL_PCT = 95;

/** Pure: which alert conditions hold right now. */
export function candidatesFrom(snapshot: SystemSnapshot, signals: Signals = {}, backup: { ok?: boolean; error?: string } | undefined = snapshot.backup as { ok?: boolean; error?: string } | undefined): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const pct = snapshot.disk.usedPct;
  if (snapshot.disk.totalBytes > 0 && pct >= 80) {
    out.push({
      key: "disk",
      kind: "disk",
      title: pct >= DISK_PUSH_PCT ? "Ares box disk is nearly full" : "Ares box disk is filling up",
      body: `The disk is ${pct}% full. Open System to see what is using it.`,
      critical: pct >= DISK_CRITICAL_PCT,
      feedOnly: pct < DISK_PUSH_PCT,
    });
  }
  const heap = snapshot.memory.heapRatio;
  if (heap >= 0.86 || snapshot.memory.systemRatio >= 0.95) {
    out.push({
      key: "memory",
      kind: "memory",
      title: "Ares is under memory pressure",
      body: heap >= 0.86 ? `The garrison heap is at ${Math.round(heap * 100)}% of its limit.` : `System memory is ${Math.round(snapshot.memory.systemRatio * 100)}% used.`,
      critical: heap >= 0.93,
    });
  }
  if ((signals.recentBoots ?? 0) >= 3 || (signals.recentCrashes ?? 0) >= 3) {
    out.push({
      key: "crash_loop",
      kind: "crash_loop",
      title: "Ares keeps restarting",
      body: `${signals.recentBoots ?? 0} starts and ${signals.recentCrashes ?? 0} crash reports recently.`,
      critical: true,
    });
  }
  for (const b of snapshot.providers) {
    if (b.state === "open" && b.failingForMs >= 5 * 60_000) {
      out.push({
        key: `provider:${b.provider}`,
        kind: "provider_outage",
        title: `${b.provider} has been failing for ${Math.round(b.failingForMs / 60_000)} minutes`,
        body: b.lastError ? scrubErrorText(b.lastError, 140) : "Turns on this provider are failing.",
      });
    }
  }
  for (const t of snapshot.sessions.turns) {
    if (t.stuck) {
      out.push({
        key: `stuck:${t.sessionId}`,
        kind: "stuck_turn",
        title: "A turn looks stuck",
        body: `"${scrubErrorText(t.title, 60)}" has run ${Math.round(t.ageSec / 60)} minutes${t.currentTool ? ` in ${t.currentTool}` : ""}. Open System to stop it.`,
      });
    }
  }
  for (const c of snapshot.connectors.problems) {
    if (c.state === "red" && CONNECTOR_AUTH_RE.test(c.detail)) {
      out.push({ key: `connector:${c.id}`, kind: "connector_expired", title: `${c.id} needs to be reconnected`, body: scrubErrorText(c.detail, 140) });
    }
  }
  if (backup && backup.ok === false) {
    out.push({ key: "backup", kind: "backup_failed", title: "Ares backup failed", body: backup.error ? scrubErrorText(backup.error, 140) : "The last nightly backup did not complete." });
  }
  if (signals.deployRolledBack) {
    out.push({
      key: `deploy:${signals.deployRolledBack.id}`,
      kind: "deploy_rolled_back",
      title: "A deploy was rolled back",
      body: signals.deployRolledBack.reason ? scrubErrorText(signals.deployRolledBack.reason, 140) : "The last deploy failed its checks and was reverted.",
    });
  }
  const hk = snapshot.housekeeping as { lastError?: string } | undefined;
  if (hk?.lastError) {
    out.push({ key: "housekeeping", kind: "housekeeping_failed", title: "Housekeeping hit an error", body: scrubErrorText(hk.lastError, 140), feedOnly: true });
  }
  return out;
}

/** True when `nowMs` falls inside a "HH:MM-HH:MM" window (which may wrap midnight). */
export function inQuietHours(spec: string | undefined, nowMs: number, timeZone: string): boolean {
  if (!spec || spec.trim().toLowerCase() === "off") return false;
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(spec.trim());
  if (!m) return false;
  const start = parseClock(m[1]);
  const end = parseClock(m[2]);
  if (start === undefined || end === undefined || start === end) return false;
  const minute = minutesOfDay(nowMs, timeZone);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export class AlertEngine {
  private readonly o: AlertEngineOptions;
  private readonly now: () => number;
  private state: AlertState | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  readonly stateFile: string;
  readonly eventsFile: string;

  constructor(opts: AlertEngineOptions) {
    this.o = opts;
    this.now = opts.now ?? Date.now;
    this.stateFile = path.join(opts.home, "system", "alerts.json");
    this.eventsFile = path.join(opts.home, "system", "events.jsonl");
  }

  /** Evaluate the rules over a snapshot; serialised so overlapping callers cannot double-send. */
  evaluate(snapshot: SystemSnapshot, signals: Signals = {}): Promise<SystemEvent[]> {
    const run = this.chain.then(() => this.evaluateNow(snapshot, signals));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Raise or refresh a one-off alert from elsewhere (backup runner, deploy gate). */
  raise(candidate: AlertCandidate): Promise<SystemEvent[]> {
    const run = this.chain.then(() => this.apply([candidate], false));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Write a plain event into the feed (housekeeping summaries, backup success, boot). */
  async record(event: Omit<SystemEvent, "at">): Promise<void> {
    await this.appendEvent({ at: new Date(this.now()).toISOString(), ...event });
  }

  async events(opts: { limit?: number; before?: string } = {}): Promise<SystemEvent[]> {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
    const before = opts.before ? Date.parse(opts.before) : Infinity;
    try {
      const lines = (await fs.readFile(this.eventsFile, "utf8")).split("\n").filter(Boolean);
      const out: SystemEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          const e = JSON.parse(lines[i]!) as SystemEvent;
          if (Date.parse(e.at) < before) out.push(e);
        } catch {
          // torn line
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Currently active alerts, for the snapshot. */
  async active(): Promise<Array<{ key: string; kind: AlertKind; since: string; held: boolean }>> {
    const s = await this.load();
    return Object.entries(s.active).map(([key, a]) => ({ key, kind: a.kind, since: new Date(a.firstAt).toISOString(), held: a.held === true }));
  }

  // ── internals ──

  private async evaluateNow(snapshot: SystemSnapshot, signals: Signals): Promise<SystemEvent[]> {
    return this.apply(candidatesFrom(snapshot, signals), true);
  }

  private quiet(): boolean {
    const spec = this.o.quiet ?? process.env.ARES_ALERT_QUIET ?? "23:00-07:00";
    return inQuietHours(spec, this.now(), resolveTimeZone(this.o.timeZone));
  }

  /** `full` = this is a complete evaluation, so keys absent from `cands` count as cleared. */
  private async apply(cands: AlertCandidate[], full: boolean): Promise<SystemEvent[]> {
    const state = await this.load();
    const events: SystemEvent[] = [];
    const now = this.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const quiet = this.quiet();
    const reminderMs = this.o.reminderMs ?? 6 * 3_600_000;
    const maxReminders = this.o.maxReminders ?? 3;
    const retryMs = this.o.retryMs ?? 10 * 60_000;
    const seen = new Set<string>();

    for (const cand of cands) {
      seen.add(cand.key);
      let a = state.active[cand.key];
      const isNew = !a;
      if (!a) {
        a = { kind: cand.kind, firstAt: now, sends: 0, misses: 0 };
        state.active[cand.key] = a;
      }
      a.misses = 0;
      const wantPush = !cand.feedOnly && this.o.push !== undefined && (this.o.pushReady?.() ?? true);
      const blockedByQuiet = quiet && !cand.critical;
      let due = false;
      let kind = "raised";
      if (a.sends === 0) {
        due = true;
      } else if (a.lastSentAt !== undefined && now - a.lastSentAt >= reminderMs && a.sends <= maxReminders) {
        due = true;
        kind = "reminder";
      }
      if (isNew) events.push({ at: iso(now), kind: cand.feedOnly ? "raised" : blockedByQuiet ? "held" : "raised", alert: cand.kind, key: cand.key, title: cand.title, body: cand.body });
      if (!due || !wantPush) {
        if (cand.feedOnly) a.sends = Math.max(a.sends, 1); // feed-only: nothing is ever "owed"
        continue;
      }
      if (blockedByQuiet) {
        a.held = true;
        continue;
      }
      if (a.lastAttemptAt !== undefined && now - a.lastAttemptAt < retryMs && a.sends === 0 && !isNew) continue;
      a.lastAttemptAt = now;
      try {
        await this.o.push!({ title: cand.title, body: cand.body, collapseId: `ares-system-${cand.key}`, data: { kind: "system", alert: cand.kind, key: cand.key } });
        a.sends += 1;
        a.lastSentAt = now;
        a.held = false;
        events.push({ at: iso(now), kind: kind === "reminder" ? "reminder" : "pushed", alert: cand.kind, key: cand.key, title: cand.title, body: cand.body, pushed: true });
      } catch (err) {
        events.push({ at: iso(now), kind: "push_failed", alert: cand.kind, key: cand.key, title: cand.title, body: scrubErrorText(err instanceof Error ? err.message : String(err), 120), pushed: false });
      }
    }

    if (full) {
      for (const [key, a] of Object.entries(state.active)) {
        if (seen.has(key)) continue;
        a.misses += 1;
        // Two clean evaluations in a row before "resolved": a flapping condition must not ping-pong the feed.
        if (a.misses >= 2) {
          delete state.active[key];
          events.push({ at: iso(now), kind: "resolved", alert: a.kind, key, title: `${alertLabel(a.kind)} cleared` });
        }
      }
    }

    await this.save(state);
    for (const e of events) await this.appendEvent(e);
    return events;
  }

  private async load(): Promise<AlertState> {
    if (this.state) return this.state;
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as AlertState;
      this.state = raw && typeof raw.active === "object" && raw.active ? raw : { active: {} };
    } catch {
      this.state = { active: {} };
    }
    return this.state;
  }

  private async save(state: AlertState): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
      await fs.rename(tmp, this.stateFile);
    } catch (err) {
      this.o.log?.(`system alerts: state not saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async appendEvent(e: SystemEvent): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.eventsFile), { recursive: true });
      await fs.appendFile(this.eventsFile, JSON.stringify(e) + "\n", "utf8");
      const st = await fs.stat(this.eventsFile);
      if (st.size > 512 * 1024) {
        const lines = (await fs.readFile(this.eventsFile, "utf8")).split("\n").filter(Boolean).slice(-EVENT_FILE_MAX_LINES);
        await fs.writeFile(this.eventsFile, lines.join("\n") + "\n", "utf8");
      }
    } catch {
      // the feed is a convenience
    }
  }
}

function alertLabel(kind: AlertKind): string {
  switch (kind) {
    case "disk": return "Disk alert";
    case "memory": return "Memory alert";
    case "crash_loop": return "Restart loop";
    case "provider_outage": return "Provider outage";
    case "stuck_turn": return "Stuck turn";
    case "connector_expired": return "Connector problem";
    case "backup_failed": return "Backup problem";
    case "deploy_rolled_back": return "Deploy rollback";
    default: return "Housekeeping problem";
  }
}
