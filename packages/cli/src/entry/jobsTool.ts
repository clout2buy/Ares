// Jobs — an agent schedules its own work (daemon/jobs.ts).
import { z } from "zod";
import { buildTool } from "@ares/tools";

export interface JobCard {
  id: string;
  agent: string;
  title: string;
  when: string;
  status: string;
  next?: string;
  room?: string;
}

export interface JobsHost {
  add(sessionId: string, spec: { agent?: string; title?: string; task: string; when: string; room?: string }): Promise<JobCard>;
  list(sessionId: string): JobCard[];
  change(sessionId: string, id: string, action: "pause" | "resume" | "delete" | "run"): Promise<JobCard | undefined>;
}

let host: JobsHost | undefined;
export function setJobsHost(next: JobsHost | undefined): void {
  host = next;
}

const input = z
  .object({
    action: z.enum(["add", "list", "pause", "resume", "cancel", "run_now"]).describe("schedule a job, list your jobs, pause/resume one, cancel (delete) one, or run one right now"),
    task: z.string().min(1).max(2000).optional().describe("add: what to do each time, with everything you'll need (sources, where results go, what done looks like)"),
    when: z.string().min(1).max(80).optional().describe('add: "every 30m", "every 2h", "hourly", "daily 09:00", "weekly mon 9am", "in 2h", or "once 2026-10-21 09:00" (local time). Shortest repeat: 15 minutes.'),
    title: z.string().min(1).max(80).optional().describe("add: a short name the owner sees in Scheduled"),
    room: z.string().min(1).max(60).optional().describe("add: a room to post each result in (name or id)"),
    agent: z.string().min(1).max(60).optional().describe("add: which agent runs it — only from Ares's main chat; an agent always schedules for itself"),
    id: z.string().min(1).max(40).optional().describe("pause/resume/cancel/run_now: the job's id (from list)"),
  })
  .strict();

const line = (j: JobCard) => `${j.title} (${j.id}) · ${j.agent} · ${j.when}${j.room ? ` → ${j.room}` : ""} · ${j.status}${j.next ? `, next ${j.next}` : ""}`;

export function makeJobsTool() {
  return buildTool({
    name: "Jobs",
    description:
      "Scheduled jobs: work you do on a timer without being asked — a morning news brief, checking a site every hour, posting a weekly recap in a room. " +
      "Each run arrives in your own chat as a message and you do it then. The owner sees every job in Scheduled and can pause or cancel it. " +
      "Use it when the owner asks for anything recurring or for later ('every morning…', 'remind me Friday…', 'check this in 2 hours').",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: input,
    activityDescription: (i) => `Jobs ${i.action}${i.title ? ": " + i.title : i.when ? " " + i.when : ""}`,
    async call(i, ctx): Promise<{ output: unknown; display: string }> {
      if (!host) throw new Error("scheduled jobs are only available in the desktop app");
      const sid = ctx?.sessionId ?? "";
      if (i.action === "list") {
        const jobs = host.list(sid);
        return { output: { jobs }, display: jobs.length ? jobs.map(line).join("\n") : "no scheduled jobs" };
      }
      if (i.action === "add") {
        if (!i.task || !i.when) throw new Error("add needs task and when");
        const job = await host.add(sid, { task: i.task, when: i.when, ...(i.title ? { title: i.title } : {}), ...(i.room ? { room: i.room } : {}), ...(i.agent ? { agent: i.agent } : {}) });
        return { output: { ok: true, job }, display: `scheduled: ${line(job)}` };
      }
      if (!i.id) throw new Error(`${i.action} needs id`);
      const action = i.action === "cancel" ? "delete" : i.action === "run_now" ? "run" : i.action;
      const job = await host.change(sid, i.id, action);
      return { output: { ok: true, ...(job ? { job } : {}) }, display: job ? line(job) : "cancelled" };
    },
  });
}
