// Device — what the owner's iPhone shares: Health, Contacts, Calendar.
//
// The phone app syncs opted-in data to <ARES_HOME>/device/<kind>.json
// (packages/cli/src/deviceSync.ts owns the format). This tool only reads
// that snapshot — it never reaches the phone — and says how stale it is, so
// the agent doesn't present yesterday's steps as live.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";

const inputSchema = z
  .object({
    action: z.enum(["health", "contacts", "calendar", "reminders", "status"]).describe(
      "health: daily steps/heart rate/sleep/active energy/workouts. contacts: search the owner's iPhone contacts. " +
        "calendar: events in a date range. reminders: open reminders. status: what the phone shares and when it last synced.",
    ),
    days: z.number().int().positive().max(90).default(7).describe("health: how many recent days."),
    query: z.string().optional().describe("contacts: name, phone or email to find."),
    from: z.string().optional().describe("calendar: ISO start (default now)."),
    to: z.string().optional().describe("calendar: ISO end (default +7 days)."),
    limit: z.number().int().positive().max(200).default(25),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface Snapshot {
  syncedAt: string;
  data: Record<string, Array<Record<string, unknown>>>;
}

function deviceFile(kind: string): string {
  return path.join(process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "device", `${kind}.json`);
}

async function snapshot(kind: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await fs.readFile(deviceFile(kind), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

function age(syncedAt: string): string {
  const minutes = Math.round((Date.now() - Date.parse(syncedAt)) / 60_000);
  if (!Number.isFinite(minutes)) return "unknown time ago";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const NOT_SHARED = (what: string) =>
  `The owner's iPhone isn't sharing ${what} with Ares. Tell them to open the Ares app → Apps → ${what[0]!.toUpperCase()}${what.slice(1)} → Connect (it needs the latest app build).`;

export interface DeviceOutput {
  syncedAt?: string;
  items?: unknown[];
  message: string;
}

export const DeviceTool = buildTool<typeof inputSchema, DeviceOutput>({
  name: "Device",
  description:
    "Read what the owner's iPhone shares with Ares (opted in from the app): Apple Health daily summaries (steps, heart rate, sleep, active energy, workouts), iPhone contacts, calendar events and reminders. Data is a synced snapshot — the result says when it last synced.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => `Reading iPhone ${input.action === "status" ? "sharing status" : input.action}`,
  async call(input: Input): Promise<ToolResult<DeviceOutput>> {
    const fail = (message: string): ToolResult<DeviceOutput> => ({ output: { message }, display: message, failure: message });
    if (input.action === "status") {
      const lines: string[] = [];
      for (const kind of ["health", "contacts", "calendar"]) {
        const snap = await snapshot(kind);
        lines.push(`${kind}: ${snap ? `synced ${age(snap.syncedAt)}` : "not shared"}`);
      }
      const message = lines.join("; ");
      return { output: { message }, display: message };
    }
    const kind = input.action === "reminders" ? "calendar" : input.action;
    const snap = await snapshot(kind);
    if (!snap) return fail(NOT_SHARED(kind === "calendar" ? "calendar" : kind));
    const stale = `synced ${age(snap.syncedAt)}`;
    switch (input.action) {
      case "health": {
        const items = (snap.data.days ?? []).slice(-input.days);
        return { output: { syncedAt: snap.syncedAt, items, message: `${items.length} day(s) of Health data, ${stale}.` }, display: `Health: ${items.length} days (${stale})` };
      }
      case "contacts": {
        const q = (input.query ?? "").toLowerCase().trim();
        const all = snap.data.contacts ?? [];
        const items = (q ? all.filter((c) => JSON.stringify(c).toLowerCase().includes(q)) : all).slice(0, input.limit);
        return { output: { syncedAt: snap.syncedAt, items, message: `${items.length} contact(s)${q ? ` matching "${input.query}"` : ""}, ${stale}.` }, display: `${items.length} contacts` };
      }
      case "calendar": {
        const from = Date.parse(input.from ?? "") || Date.now();
        const to = Date.parse(input.to ?? "") || from + 7 * 86_400_000;
        const items = (snap.data.events ?? [])
          .filter((e) => {
            const start = Date.parse(String(e.start));
            return Number.isFinite(start) && start >= from && start <= to;
          })
          .sort((a, b) => Date.parse(String(a.start)) - Date.parse(String(b.start)))
          .slice(0, input.limit);
        return { output: { syncedAt: snap.syncedAt, items, message: `${items.length} event(s), ${stale}.` }, display: `${items.length} events` };
      }
      case "reminders": {
        const items = (snap.data.reminders ?? []).filter((r) => r.completed !== true).slice(0, input.limit);
        return { output: { syncedAt: snap.syncedAt, items, message: `${items.length} open reminder(s), ${stale}.` }, display: `${items.length} reminders` };
      }
    }
  },
});
