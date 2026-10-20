// Scheduled jobs — an agent's own alarms (owner, 2026-10-20: "agent should be
// able to schedule jobs, like the iOS app, see scheduled").
//
// A job is: which agent, what to do, when ("every 30m", "daily 09:00",
// "weekly mon 09:00", "once 2026-10-21 09:00", "in 2h"), and optionally a
// room to post the result in. The daemon ticks; a due job becomes an ordinary
// turn in the agent's own desktop chat — same model, tools, rules, lessons and
// permission gate as anything the owner sends. Discipline mirrors the goal
// runner: the next run is claimed BEFORE the turn starts (a crash can't run
// it twice), a busy agent is skipped and retried next tick, never stacked.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";

export type JobSchedule =
  | { kind: "once"; at: string }
  | { kind: "every"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; day: number; time: string };

export interface AgentJob {
  id: string;
  agentId: string;
  title: string;
  task: string;
  roomId?: string;
  schedule: JobSchedule;
  status: "active" | "paused" | "done";
  nextRunAt?: string;
  lastRun?: { at: string; ok: boolean; note?: string; threadId?: string };
  runs: number;
  createdAt: string;
  createdBy: "owner" | "agent";
}

export class JobError extends Error {}

export const JOBS_MAX = 100;
export const JOBS_PER_AGENT_MAX = 20;
export const EVERY_MIN_MINUTES = 15;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const two = (n: number) => String(n).padStart(2, "0");

function parseTime(t: string): { h: number; m: number } {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t.trim());
  if (!m) throw new JobError(`"${t}" is not a time — use 09:00 or 9pm`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) throw new JobError(`"${t}" is not a time`);
  return { h, m: min };
}

/** "every 30m" | "every 2h" | "hourly" | "daily 09:00" | "weekly mon 9am" |
 *  "once 2026-10-21 09:00" | "in 2h" | "in 45m" → a schedule. */
export function parseWhen(when: string, now: Date): JobSchedule {
  const w = when.trim().toLowerCase().replace(/\s+/g, " ");
  if (w === "hourly") return { kind: "every", minutes: 60 };
  let m = /^every (\d{1,4}) ?(m|min|mins|minutes|h|hr|hrs|hours|d|days?)$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const minutes = unit.startsWith("h") ? n * 60 : unit.startsWith("d") ? n * 1440 : n;
    if (minutes < EVERY_MIN_MINUTES) throw new JobError(`the shortest repeat is every ${EVERY_MIN_MINUTES} minutes`);
    return { kind: "every", minutes: Math.min(minutes, 60 * 24 * 31) };
  }
  m = /^(?:daily|every day)(?: at)? (.+)$/.exec(w);
  if (m) {
    const t = parseTime(m[1]!);
    return { kind: "daily", time: `${two(t.h)}:${two(t.m)}` };
  }
  m = /^(?:weekly|every) (sun|mon|tue|wed|thu|fri|sat)[a-z]*(?: at)? (.+)$/.exec(w);
  if (m) {
    const t = parseTime(m[2]!);
    return { kind: "weekly", day: DAYS.indexOf(m[1]!), time: `${two(t.h)}:${two(t.m)}` };
  }
  m = /^in (\d{1,4}) ?(m|min|mins|minutes|h|hr|hrs|hours|d|days?)$/.exec(w);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!;
    const ms = n * (unit.startsWith("h") ? 3_600_000 : unit.startsWith("d") ? 86_400_000 : 60_000);
    return { kind: "once", at: new Date(now.getTime() + ms).toISOString() };
  }
  m = /^(?:once|at|on)? ?(.+)$/.exec(w);
  const at = Date.parse(m![1]!.replace(" ", "T"));
  if (Number.isFinite(at)) {
    if (at < now.getTime() - 60_000) throw new JobError("that time has already passed");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  throw new JobError(`couldn't read "${when}" — try "every 30m", "daily 09:00", "weekly mon 9am", "in 2h" or "once 2026-10-21 09:00"`);
}

/** When it runs next, strictly after `after`. undefined: never again. */
export function nextRun(s: JobSchedule, after: Date): Date | undefined {
  if (s.kind === "once") {
    const at = new Date(s.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  if (s.kind === "every") return new Date(after.getTime() + s.minutes * 60_000);
  const { h, m } = parseTime(s.time);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(h, m);
  if (s.kind === "daily") {
    if (d.getTime() <= after.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  let add = (s.day - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= after.getTime()) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

export function describeSchedule(s: JobSchedule): string {
  if (s.kind === "once") return `once, ${new Date(s.at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`;
  if (s.kind === "every") return s.minutes % 1440 === 0 ? `every ${s.minutes / 1440} day${s.minutes === 1440 ? "" : "s"}` : s.minutes % 60 === 0 ? (s.minutes === 60 ? "every hour" : `every ${s.minutes / 60} hours`) : `every ${s.minutes} minutes`;
  if (s.kind === "daily") return `daily at ${s.time}`;
  return `every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][s.day]} at ${s.time}`;
}

/** What the agent's chat receives when its job comes due. */
export function jobTurnText(job: AgentJob, roomName: string | undefined): string {
  return `(Scheduled job "${job.title}" — ${describeSchedule(job.schedule)}. Your owner set this up for you; it's time now. ` +
    `Do it without asking first. Nothing irreversible and no spending; if you need the owner's go-ahead, say so. ` +
    (roomName
      ? `When it's done, post the result in the room "${roomName}" with Rooms say (room: "${roomName}") — one or two lines, a link if you made something — and reply here in one line.`
      : `Then tell your owner the result in one or two lines.`) +
    `)\n\nThe job:\n"""${job.task}"""`;
}

function asSchedule(v: unknown): JobSchedule | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  if (r.kind === "once" && typeof r.at === "string") return { kind: "once", at: r.at };
  if (r.kind === "every" && typeof r.minutes === "number" && r.minutes >= EVERY_MIN_MINUTES) return { kind: "every", minutes: r.minutes };
  if (r.kind === "daily" && typeof r.time === "string") return { kind: "daily", time: r.time };
  if (r.kind === "weekly" && typeof r.day === "number" && typeof r.time === "string") return { kind: "weekly", day: r.day, time: r.time };
  return undefined;
}

export interface DesktopJobsDeps {
  home: string;
  emit(payload: Record<string, unknown>): void;
  /** Hand a due job to its agent. Resolves the thread it went to, or
   *  undefined when the agent is busy (retried next tick). */
  wake(job: AgentJob, text: string): Promise<string | undefined>;
  agentExists(agentId: string): boolean;
  roomName(roomId: string): string | undefined;
  now?: () => number;
}

export class DesktopJobs {
  private jobs: AgentJob[] = [];
  private loaded = false;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly now: () => number;

  constructor(private readonly deps: DesktopJobsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get file(): string {
    return path.join(this.deps.home, "agent-jobs.json");
  }

  async load(): Promise<AgentJob[]> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as { jobs?: unknown[] };
        this.jobs = (raw.jobs ?? []).flatMap((x) => {
          const r = x as Record<string, unknown>;
          const schedule = asSchedule(r.schedule);
          if (!schedule || typeof r.id !== "string" || typeof r.agentId !== "string" || typeof r.title !== "string" || typeof r.task !== "string") return [];
          return [{ ...(r as unknown as AgentJob), schedule }];
        });
      } catch {
        /* first run */
      }
    }
    return this.list();
  }

  list(): AgentJob[] {
    return [...this.jobs].sort((a, b) => (a.status === b.status ? (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~") : a.status === "active" ? -1 : b.status === "active" ? 1 : a.status === "paused" ? -1 : 1));
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.deps.home, { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ jobs: this.jobs }, null, 2));
    await fs.rename(tmp, this.file);
    this.deps.emit({ type: "jobs_list", jobs: this.list() });
  }

  async add(spec: { agentId: string; title?: string; task: string; when: string; roomId?: string; createdBy: "owner" | "agent" }): Promise<AgentJob> {
    await this.load();
    if (!this.deps.agentExists(spec.agentId)) throw new JobError("unknown agent");
    const task = spec.task.trim().slice(0, 2000);
    if (!task) throw new JobError("say what the job is");
    if (this.jobs.filter((j) => j.status !== "done").length >= JOBS_MAX) throw new JobError(`there are already ${JOBS_MAX} jobs — cancel some first`);
    if (this.jobs.filter((j) => j.agentId === spec.agentId && j.status !== "done").length >= JOBS_PER_AGENT_MAX) throw new JobError(`that agent already has ${JOBS_PER_AGENT_MAX} jobs`);
    if (spec.roomId && !this.deps.roomName(spec.roomId)) throw new JobError("unknown room");
    const now = new Date(this.now());
    const schedule = parseWhen(spec.when, now);
    const first = schedule.kind === "once" ? new Date(schedule.at) : nextRun(schedule, now);
    const job: AgentJob = {
      id: `aj_${randomBytes(5).toString("hex")}`,
      agentId: spec.agentId,
      title: (spec.title?.trim() || task.split(/[.\n]/)[0]!).slice(0, 80),
      task,
      ...(spec.roomId ? { roomId: spec.roomId } : {}),
      schedule,
      status: "active",
      ...(first ? { nextRunAt: first.toISOString() } : {}),
      runs: 0,
      createdAt: now.toISOString(),
      createdBy: spec.createdBy,
    };
    this.jobs.push(job);
    await this.save();
    return job;
  }

  get(id: string): AgentJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  async change(id: string, action: "pause" | "resume" | "delete" | "run"): Promise<AgentJob | undefined> {
    await this.load();
    const job = this.get(id);
    if (!job) throw new JobError("unknown job");
    if (action === "delete") {
      this.jobs = this.jobs.filter((j) => j.id !== id);
      await this.save();
      return undefined;
    }
    if (action === "pause") job.status = "paused";
    if (action === "resume") {
      job.status = "active";
      const next = job.schedule.kind === "once" ? new Date(Math.max(Date.parse(job.schedule.at), this.now())) : nextRun(job.schedule, new Date(this.now()));
      if (next) job.nextRunAt = next.toISOString();
    }
    if (action === "run") {
      if (job.status === "done") job.status = "active";
      job.nextRunAt = new Date(this.now()).toISOString();
    }
    await this.save();
    if (action === "run") void this.tick();
    return job;
  }

  /** An agent was deleted: its jobs go too. */
  async dropAgent(agentId: string): Promise<void> {
    await this.load();
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.agentId !== agentId);
    if (this.jobs.length !== before) await this.save();
  }

  start(everyMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let fired = 0;
    let dirty = false;
    try {
      await this.load();
      const nowMs = this.now();
      for (const job of this.jobs) {
        if (job.status !== "active" || !job.nextRunAt || Date.parse(job.nextRunAt) > nowMs) continue;
        if (!this.deps.agentExists(job.agentId)) { job.status = "paused"; dirty = true; continue; }
        const roomName = job.roomId ? this.deps.roomName(job.roomId) : undefined;
        let thread: string | undefined;
        try {
          thread = await this.deps.wake(job, jobTurnText(job, roomName));
        } catch (error) {
          job.lastRun = { at: new Date(nowMs).toISOString(), ok: false, note: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
          job.nextRunAt = new Date(nowMs + 60 * 60_000).toISOString();
          dirty = true;
          continue;
        }
        if (!thread) continue; // busy: next tick
        // claimed: move the clock before anything else can see it due
        const next = nextRun(job.schedule, new Date(nowMs));
        job.runs += 1;
        job.lastRun = { at: new Date(nowMs).toISOString(), ok: true, threadId: thread };
        if (next && job.schedule.kind !== "once") job.nextRunAt = next.toISOString();
        else { job.status = "done"; delete job.nextRunAt; }
        fired++;
      }
      if (fired || dirty) await this.save();
    } finally {
      this.ticking = false;
    }
    return fired;
  }
}
