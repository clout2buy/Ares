// Remind — schedule alarms and reminders that fire over Telegram.
//
// The agent calls this when the owner (or anyone) says "remind me at 5pm",
// "set a morning alarm", "cancel alarm X", or "what alarms do I have".
// Alarms persist across restarts in ~/.ares/telegram-schedule.json.
//
// This is a general-purpose tool — not hardcoded to check-ins. Any user who
// downloads this repo gets the same infrastructure for scheduled notifications.

import { z } from "zod";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    action: z.enum(["add", "remove", "list"]).describe(
      "add: create a new alarm/reminder. remove: delete an alarm by id. list: show all alarms.",
    ),
    label: z.string().optional().describe("What the alarm is for (e.g. 'Take a break', 'Morning check-in'). Required for 'add'."),
    hour: z.number().int().min(0).max(23).optional().describe("Hour in 24h format (0–23). Required for 'add'."),
    minute: z.number().int().min(0).max(59).default(0).optional().describe("Minute (0–59). Default 0."),
    days: z.array(z.number().int().min(0).max(6)).optional().describe("Which days to fire: 0=Sun, 1=Mon, ..., 6=Sat. Omit for every day."),
    once: z.boolean().optional().describe("If true, fire once then auto-remove. Default false (recurring)."),
    body: z.string().optional().describe("Extra text to include in the notification body."),
    alarm_id: z.string().optional().describe("Alarm ID to remove. Required for 'remove'."),
  })
  .strict();

export interface RemindOutput {
  action: string;
  ok: boolean;
  alarm?: { id: string; label: string; hour: number; minute: number };
  alarms?: string;
  note?: string;
}

/** The scheduler instance is injected at daemon startup — absent in non-daemon
 *  contexts (tests, standalone sessions), so the tool gracefully degrades. */
let schedulerRef: SchedulerLike | null = null;

export interface SchedulerLike {
  addAlarm(input: { label: string; hour: number; minute: number; days?: number[]; once?: boolean; body?: string }): Promise<{ id: string; label: string; hour: number; minute: number }>;
  removeAlarm(id: string): Promise<{ id: string } | undefined>;
  renderAlarms(): Promise<string>;
}

export function setRemindScheduler(scheduler: SchedulerLike | null): void {
  schedulerRef = scheduler;
}

export const RemindTool = buildTool({
  name: "Remind",
  description:
    "Schedule alarms and reminders that fire as Telegram notifications at specific times. " +
    "Use 'add' when someone says 'remind me', 'set an alarm', 'ping me at X'. " +
    "Use 'list' to show all active alarms. Use 'remove' to cancel one by id. " +
    "Alarms persist across restarts. Supports recurring (daily, specific weekdays) and one-shot.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    if (i.action === "add") return `Setting alarm: ${i.label ?? "reminder"} at ${i.hour ?? "?"}:${String(i.minute ?? 0).padStart(2, "0")}`;
    if (i.action === "remove") return `Removing alarm ${i.alarm_id}`;
    return "Listing alarms";
  },

  async call(i): Promise<{ output: RemindOutput; display: string }> {
    if (!schedulerRef) {
      return {
        output: { action: i.action, ok: false, note: "Scheduler not running — Telegram must be configured and the daemon must be active." },
        display: "Scheduler not available. Telegram needs to be configured first.",
      };
    }

    if (i.action === "list") {
      const text = await schedulerRef.renderAlarms();
      return { output: { action: "list", ok: true, alarms: text }, display: text };
    }

    if (i.action === "remove") {
      if (!i.alarm_id) throw new Error("remove needs alarm_id.");
      const removed = await schedulerRef.removeAlarm(i.alarm_id);
      if (!removed) return { output: { action: "remove", ok: false, note: `No alarm "${i.alarm_id}".` }, display: `No alarm "${i.alarm_id}" to remove.` };
      return {
        output: { action: "remove", ok: true, alarm: { id: removed.id, label: "", hour: 0, minute: 0 } },
        display: `Removed alarm ${removed.id}.`,
      };
    }

    // add
    if (i.label === undefined) throw new Error("add needs a label.");
    if (i.hour === undefined) throw new Error("add needs an hour (0–23).");
    const alarm = await schedulerRef.addAlarm({
      label: i.label,
      hour: i.hour,
      minute: i.minute ?? 0,
      days: i.days,
      once: i.once,
      body: i.body,
    });
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const time = `${String(alarm.hour).padStart(2, "0")}:${String(alarm.minute).padStart(2, "0")}`;
    const when = i.days?.length ? i.days.map((d) => dayNames[d]).join(", ") : "daily";
    const shot = i.once ? " (one-shot)" : "";
    return {
      output: { action: "add", ok: true, alarm: { id: alarm.id, label: alarm.label, hour: alarm.hour, minute: alarm.minute } },
      display: `⏰ Alarm set: "${alarm.label}" at ${time} ${when}${shot} (id: ${alarm.id})`,
    };
  },
});
