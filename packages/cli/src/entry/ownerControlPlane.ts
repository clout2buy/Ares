// The owner's control plane for the garrison — one object behind the phone's
// kill switch, the Telegram /stopall /pause /resume /log /jobs commands, and
// the jobs list.
//
// The owner's rules, from the security review, each load-bearing here:
//   • The kill switch reaches EVERY execution layer as a signal that
//     preempts: turns in every session, Task/Conductor children, operator job
//     steps, pending permission prompts, staged approvals and the browsers
//     Ares opened. "Please stop" in chat is a suggestion; this is not.
//   • Pause and stop are different. Pause freezes at the next tool boundary
//     (core ownerPause) with state intact; stop terminates.
//   • Every scheduled job is listable and killable, and says who created it
//     and whether its schedule was approved.
//   • Every one of these owner actions lands in the audit trail.
//
// Everything is injected so tests drive it without a garrison.

import {
  appendAudit,
  listStoppables,
  ownerPause,
  readAudit,
  registerStoppable,
  stopAllStoppables,
  type AuditEntry,
} from "@ares/core";
import type { RunningTurn, SchedulerHookName, SchedulerJobStatus } from "@ares/garrison";
import {
  loadStandingOrders,
  loadWatchers,
  removeStandingOrder,
  removeWatcher,
  type DispatchContext,
  type Dispatcher,
  type Goal,
  type StepVerdict,
} from "@ares/operator";

/** One job as GET /gateway/jobs returns it. */
export interface OwnerJobView {
  id: string;
  title: string;
  /** "once at 17:00", a cron expression ("0 9 * * 1,3"), or "every 30m". */
  schedule: string;
  createdBy: "owner" | "ares" | "system";
  approved: boolean;
  /** Predates provenance tracking — approval is assumed, not recorded. */
  legacy?: boolean;
  kind: "system" | "alarm" | "standing-order" | "watcher" | "operator";
  enabled: boolean;
  paused?: boolean;
  running?: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  lastResult?: string;
}

/** The slice of TelegramScheduler the jobs list needs (structural). */
export interface AlarmSchedulerLike {
  listAlarms(): Promise<
    Array<{
      id: string;
      label: string;
      hour: number;
      minute: number;
      days?: number[];
      once?: boolean;
      createdAt: string;
      createdBy?: "owner" | "ares";
      approved?: boolean;
      lastRunAt?: string;
      lastResult?: string;
    }>
  >;
  removeAlarm(id: string): Promise<{ id: string } | undefined>;
}

export interface OwnerControlPlaneDeps {
  home: string;
  sessions: {
    interruptAll(): { turns: number; waiting: number };
    denyAllPendingPermissions(): number;
    runningTurns(): RunningTurn[];
  };
  scheduler?: { jobStatus(): SchedulerJobStatus[]; holdHook(name: SchedulerHookName, held: boolean): boolean };
  /** Staged effects awaiting the owner (ApprovalQueue). Stop denies them all. */
  approvals?: { pending(): Array<{ id: string }>; respond(r: { approvalId: string; verb: "deny"; note?: string }): void };
  /** Telegram alarms — resolved lazily: the bridge may come up after boot. */
  alarms?: () => AlarmSchedulerLike | null;
  /** The operator background loop, when this garrison runs one. */
  operator?: { started: boolean; everyMs: number; stop(): void; start(): void };
  now?: () => number;
}

export interface StopAllResult {
  stopped: {
    turns: number;
    subagents: number;
    jobs: number;
    browsers: number;
    /** Permission prompts and staged approvals answered "deny". */
    prompts: number;
    /** Sends that were waiting out a pause and were dropped. */
    queued: number;
  };
}

export interface ControlStatus {
  paused: boolean;
  pausedAt?: string;
  running: {
    turns: RunningTurn[];
    jobs: Array<{ id: string; title: string; startedAt?: string; kind: string }>;
  };
}

export class OwnerControlPlane {
  private readonly deps: OwnerControlPlaneDeps;
  private readonly now: () => number;

  constructor(deps: OwnerControlPlaneDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  // ─── stop / pause / resume ──────────────────────────────────────────────

  /**
   * The big red button. Order matters: children and jobs are stopped through
   * the registry FIRST (so their count is honest — interrupting the parent
   * turn would take them down too, and they would already be gone), then
   * every turn, then every prompt still waiting on the owner.
   */
  async stopAll(): Promise<StopAllResult> {
    const reason = "stopped by owner";
    const registered = await stopAllStoppables(reason);
    const { turns, waiting } = this.deps.sessions.interruptAll();
    let prompts = this.deps.sessions.denyAllPendingPermissions();
    for (const staged of this.deps.approvals?.pending() ?? []) {
      try {
        this.deps.approvals!.respond({ approvalId: staged.id, verb: "deny", note: reason });
        prompts += 1;
      } catch {
        // already answered — nothing to deny
      }
    }
    const result: StopAllResult = {
      stopped: {
        turns,
        subagents: registered.subagent,
        jobs: registered.job,
        browsers: registered.browser,
        prompts,
        queued: waiting,
      },
    };
    this.audit({ action: "control.stop", params: result.stopped, result: "ok" });
    return result;
  }

  pause(): { paused: true; pausedAt: string; changed: boolean } {
    const changed = ownerPause.pause(this.now());
    if (changed) this.audit({ action: "control.pause", result: "ok" });
    return { paused: true, pausedAt: ownerPause.pausedAt!, changed };
  }

  resume(): { paused: false; changed: boolean } {
    const changed = ownerPause.resume();
    if (changed) this.audit({ action: "control.resume", result: "ok" });
    return { paused: false, changed };
  }

  get paused(): boolean {
    return ownerPause.paused;
  }

  /** The fields GET /gateway/control adds to the settings cockpit. */
  status(): ControlStatus {
    const jobs: ControlStatus["running"]["jobs"] = [];
    for (const job of this.deps.scheduler?.jobStatus() ?? []) {
      if (job.running) jobs.push({ id: `system:${job.name}`, title: job.name, kind: "system" });
    }
    for (const entry of listStoppables()) {
      if (entry.kind === "browser") continue;
      jobs.push({ id: entry.id, title: entry.label ?? entry.id, startedAt: entry.startedAt, kind: entry.kind });
    }
    return {
      paused: ownerPause.paused,
      ...(ownerPause.pausedAt ? { pausedAt: ownerPause.pausedAt } : {}),
      running: { turns: this.deps.sessions.runningTurns(), jobs },
    };
  }

  // ─── jobs ───────────────────────────────────────────────────────────────

  async listJobs(): Promise<{ jobs: OwnerJobView[] }> {
    const jobs: OwnerJobView[] = [];
    const nowMs = this.now();
    for (const job of this.deps.scheduler?.jobStatus() ?? []) {
      jobs.push({
        id: `system:${job.name}`,
        title: SYSTEM_TITLES[job.name] ?? job.name,
        schedule: job.schedule,
        createdBy: "system",
        approved: true,
        kind: "system",
        enabled: job.enabled,
        paused: job.paused,
        running: job.running,
        ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
        ...(job.lastRunAt ? { lastRunAt: job.lastRunAt } : {}),
        ...(job.lastResult ? { lastResult: job.lastResult } : {}),
      });
    }
    const operator = this.deps.operator;
    if (operator) {
      jobs.push({
        id: "system:operator",
        title: "Operator loop (goals, standing orders, watchers)",
        schedule: `every ${formatEvery(operator.everyMs)}`,
        createdBy: "system",
        approved: true,
        kind: "operator",
        enabled: operator.started,
        paused: ownerPause.paused,
      });
    }
    const alarms = await this.deps.alarms?.()?.listAlarms().catch(() => []) ?? [];
    for (const alarm of alarms) {
      const time = `${pad(alarm.hour)}:${pad(alarm.minute)}`;
      jobs.push({
        id: `alarm:${alarm.id}`,
        title: alarm.label,
        schedule: alarm.once ? `once at ${time}` : `${alarm.minute} ${alarm.hour} * * ${alarm.days?.length ? alarm.days.join(",") : "*"}`,
        createdBy: alarm.createdBy ?? "owner",
        approved: alarm.approved ?? true,
        ...(alarm.createdBy === undefined ? { legacy: true } : {}),
        kind: "alarm",
        enabled: alarm.approved !== false,
        paused: ownerPause.paused,
        nextRunAt: nextAlarmAt(alarm.hour, alarm.minute, alarm.days, nowMs),
        ...(alarm.lastRunAt ? { lastRunAt: alarm.lastRunAt } : {}),
        ...(alarm.lastResult ? { lastResult: alarm.lastResult } : {}),
      });
    }
    for (const order of await loadStandingOrders(this.deps.home).catch(() => [])) {
      const last = order.lastRunAt ? Date.parse(order.lastRunAt) : undefined;
      jobs.push({
        id: `standing:${order.id}`,
        title: order.statement.slice(0, 160),
        schedule: `every ${formatEvery(order.cadenceMs)}`,
        createdBy: order.createdBy ?? "owner",
        approved: order.approved ?? true,
        ...(order.createdBy === undefined ? { legacy: true } : {}),
        kind: "standing-order",
        enabled: order.enabled && order.approved !== false,
        paused: ownerPause.paused,
        nextRunAt: new Date(last === undefined ? nowMs : Math.max(nowMs, last + order.cadenceMs)).toISOString(),
        ...(order.lastRunAt ? { lastRunAt: order.lastRunAt, lastResult: `run #${order.runCount}` } : {}),
      });
    }
    for (const watcher of await loadWatchers(this.deps.home).catch(() => [])) {
      const last = watcher.lastCheckedAt ? Date.parse(watcher.lastCheckedAt) : undefined;
      jobs.push({
        id: `watcher:${watcher.id}`,
        title: `${watcher.label} (${watcher.condition.kind} probe, ${watcher.mode ?? "plan"})`,
        schedule: `every ${formatEvery(watcher.cadenceMs)}`,
        // Only the Watcher tool creates watchers; its schedule is approved at
        // creation now. Older ones predate that and are flagged legacy.
        createdBy: "ares",
        approved: true,
        legacy: true,
        kind: "watcher",
        enabled: watcher.enabled,
        paused: ownerPause.paused,
        nextRunAt: new Date(last === undefined ? nowMs : Math.max(nowMs, last + watcher.cadenceMs)).toISOString(),
        ...(watcher.lastCheckedAt ? { lastRunAt: watcher.lastCheckedAt } : {}),
        ...(watcher.lastFiredAt ? { lastResult: `last fired ${watcher.lastFiredAt}` } : {}),
      });
    }
    return { jobs };
  }

  /**
   * Kill one job. Alarms, standing orders and watchers are deleted; a system
   * job (armed by config, not by an approval) is held — it stops starting
   * until resumeJob or a restart; the operator loop is stopped.
   */
  async cancelJob(id: string): Promise<{ ok: boolean; id: string; detail: string }> {
    const [kind, ...rest] = id.split(":");
    const key = rest.join(":");
    let ok = false;
    let detail = "no such job";
    if (kind === "alarm" && key) {
      const scheduler = this.deps.alarms?.();
      ok = Boolean(scheduler && (await scheduler.removeAlarm(key)));
      detail = ok ? "alarm removed" : scheduler ? "no such alarm" : "Telegram alarms are not running";
    } else if (kind === "standing" && key) {
      ok = await removeStandingOrder(this.deps.home, key);
      detail = ok ? "standing order removed" : "no such standing order";
    } else if (kind === "watcher" && key) {
      ok = await removeWatcher(this.deps.home, key);
      detail = ok ? "watcher removed" : "no such watcher";
    } else if (kind === "system" && key === "operator" && this.deps.operator) {
      this.deps.operator.stop();
      ok = true;
      detail = "operator loop stopped until resumed or restarted";
    } else if (kind === "system" && isHookName(key) && this.deps.scheduler) {
      ok = this.deps.scheduler.holdHook(key, true);
      detail = ok ? "system job paused (config re-arms it at restart)" : "that system job is not wired";
    }
    this.audit({ action: "jobs.cancel", target: id, result: ok ? "ok" : `error: ${detail}` });
    return { ok, id, detail };
  }

  /** Re-arm a held system job (or restart the operator loop). */
  resumeJob(id: string): { ok: boolean; id: string } {
    const [kind, key] = id.split(":");
    let ok = false;
    if (kind === "system" && key === "operator" && this.deps.operator) {
      if (!this.deps.operator.started) this.deps.operator.start();
      ok = true;
    } else if (kind === "system" && key && isHookName(key) && this.deps.scheduler) {
      ok = this.deps.scheduler.holdHook(key, false);
    }
    this.audit({ action: "jobs.resume", target: id, result: ok ? "ok" : "error: not a pausable system job" });
    return { ok, id };
  }

  // ─── audit ──────────────────────────────────────────────────────────────

  readAudit(opts: { limit?: number; sessionId?: string } = {}): Promise<AuditEntry[]> {
    return readAudit({ home: this.deps.home, limit: opts.limit ?? 100, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) });
  }

  // ─── Telegram (one message each) ────────────────────────────────────────

  async telegramStopAll(): Promise<string> {
    const { stopped } = await this.stopAll();
    const parts = [
      `${stopped.turns} turn${stopped.turns === 1 ? "" : "s"}`,
      `${stopped.subagents} subagent${stopped.subagents === 1 ? "" : "s"}`,
      `${stopped.jobs} job${stopped.jobs === 1 ? "" : "s"}`,
      `${stopped.browsers} browser${stopped.browsers === 1 ? "" : "s"}`,
    ];
    if (stopped.prompts) parts.push(`${stopped.prompts} prompt${stopped.prompts === 1 ? "" : "s"} denied`);
    if (stopped.queued) parts.push(`${stopped.queued} queued message${stopped.queued === 1 ? "" : "s"} dropped`);
    return `⏹ Stopped everything: ${parts.join(", ")}.${ownerPause.paused ? "\nStill paused — /resume to continue." : ""}`;
  }

  telegramPause(): string {
    const { changed } = this.pause();
    const turns = this.deps.sessions.runningTurns().length;
    return changed
      ? `⏸ Paused. ${turns ? `${turns} running turn${turns === 1 ? "" : "s"} will freeze at the next tool.` : "Nothing is running."} New messages wait. Scheduled jobs hold.\n/resume to continue · /stopall to end it.`
      : "Already paused. /resume to continue.";
  }

  telegramResume(): string {
    const { changed } = this.resume();
    return changed ? "▶ Resumed." : "Not paused.";
  }

  async telegramLog(limit = 15): Promise<string> {
    const entries = await this.readAudit({ limit });
    if (entries.length === 0) return "📜 Nothing in the audit log yet.";
    const lines = entries.map((e) => {
      const time = e.ts.slice(11, 16);
      const who = e.actor === "ares" ? "" : `${e.actor} `;
      const target = e.target ? ` → ${clip(e.target, 48)}` : "";
      return `${time} ${who}${e.action}${target} · ${clip(e.result ?? "", 40)}`;
    });
    return `📜 Last ${entries.length} actions (UTC):\n${lines.join("\n")}`;
  }

  async telegramJobs(): Promise<string> {
    const { jobs } = await this.listJobs();
    if (jobs.length === 0) return "No scheduled jobs.";
    const lines = jobs.map((j) => {
      const flags = [j.createdBy, j.approved ? "" : "UNAPPROVED", j.paused ? "paused" : "", j.enabled ? "" : "off"].filter(Boolean).join(", ");
      return `• ${j.id} — ${clip(j.title, 50)} · ${j.schedule} (${flags})`;
    });
    return `🗓 Jobs:\n${lines.join("\n")}\nCancel from the app, or /cancel_job <id>.`;
  }

  private audit(entry: Omit<AuditEntry, "ts" | "actor">): void {
    void appendAudit({ actor: "owner", ...entry }, this.deps.home);
  }
}

/**
 * Wrap the operator's dispatcher so each unattended step is a stoppable job
 * and never STARTS while the owner has Ares paused. The step still runs under
 * its own signal; stop-all aborts it through the registry.
 */
export function ownerControlledDispatcher(inner: Dispatcher, onAudit?: (entry: Omit<AuditEntry, "ts">) => void): Dispatcher {
  return {
    async runStep(goal: Goal, ctx: DispatchContext): Promise<StepVerdict> {
      if (ownerPause.paused) {
        const waited = await ownerPause.wait({ signal: ctx.signal });
        if (waited !== "clear") return { moved: false, goalMet: false, evidence: "operator step not started: stopped by owner while paused" };
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const unregister = registerStoppable({
        kind: "job",
        id: `operator:${goal.id}`,
        label: `operator step: ${goal.statement.slice(0, 80)}`,
        stop: (reason) => {
          if (controller.signal.aborted) return false;
          controller.abort(new Error(reason));
          return true;
        },
      });
      try {
        const verdict = await inner.runStep(goal, { ...ctx, signal });
        onAudit?.({ actor: "operator", action: "operator.step", target: goal.id, params: { goal: goal.statement }, result: verdict.goalMet ? "ok: goal met" : verdict.moved ? "ok: moved" : `ok: no progress${verdict.evidence ? ` (${clip(verdict.evidence, 80)})` : ""}` });
        return verdict;
      } catch (error) {
        onAudit?.({ actor: "operator", action: "operator.step", target: goal.id, params: { goal: goal.statement }, result: `error: ${clip(error instanceof Error ? error.message : String(error), 120)}` });
        throw error;
      } finally {
        unregister();
      }
    },
  };
}

const SYSTEM_TITLES: Record<string, string> = {
  heartbeat: "Heartbeat + reliability triage",
  dream: "Dreaming (crucible + memory consolidation)",
  gauntlet: "Nightly coding gauntlet",
};

function isHookName(name: string | undefined): name is SchedulerHookName {
  return name === "heartbeat" || name === "dream" || name === "gauntlet";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function formatEvery(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Next local occurrence of hh:mm on the allowed weekdays. */
export function nextAlarmAt(hour: number, minute: number, days: readonly number[] | undefined, nowMs: number): string {
  const now = new Date(nowMs);
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0);
    if (candidate.getTime() <= nowMs) continue;
    if (days?.length && !days.includes(candidate.getDay())) continue;
    return candidate.toISOString();
  }
  return new Date(nowMs).toISOString();
}
