// /gateway/device/* — what the owner's iPhone shares with Ares.
//
// Muse reads Health, Contacts and Calendar on the phone itself. Ares runs on
// the doingbox, so the app reads them (with iOS permission, per data type,
// opted in from the Apps screen) and syncs a bounded snapshot here; the
// Device tool reads the snapshot. Nothing is fetched from the phone on
// demand, and "Disconnect" on the phone deletes the snapshot here too.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check, so
// every route is owner-only. Shapes (the app is built against these):
//
//   POST /gateway/device/health    {days:[{date, steps?, restingHr?, avgHr?, sleepMinutes?, activeKcal?, workouts?:[{type,start,minutes?,kcal?}]}]}
//   POST /gateway/device/contacts  {contacts:[{name, phones?:string[], emails?:string[]}]}
//   POST /gateway/device/calendar  {events?:[{title,start,end?,location?,calendar?,allDay?}], reminders?:[{title,due?,completed?,list?}]}
//        Calendar and Reminders are separate opt-ins on the phone, so they
//        arrive as separate posts: each list present in the body replaces
//        that list; a missing key leaves the other list untouched.
//        200 {ok:true, stored:<count>}
//   POST /gateway/device/<kind>/forget   200 {ok:true}   (kind: health|contacts|calendar|reminders;
//        calendar forgets only events, reminders only reminders)
//   GET  /gateway/device                 200 {kinds:{health?:{syncedAt,count}, contacts?:…, calendar?:…}}
//
// Stored at <ARES_HOME>/device/<kind>.json, owner-only file mode. Sizes are
// capped so a runaway sync can't balloon the box.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const DEVICE_KINDS = ["health", "contacts", "calendar"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CAPS: Record<DeviceKind, number> = { health: 400, contacts: 5000, calendar: 2000 };

export function deviceDir(home?: string): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "device");
}

export function deviceFile(kind: DeviceKind, home?: string): string {
  return path.join(deviceDir(home), `${kind}.json`);
}

export interface DeviceSnapshot {
  syncedAt: string;
  data: Record<string, unknown>;
}

function str(value: unknown, max = 200): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strList(value: unknown, max = 10): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.map((v) => str(v, 120)).filter((v): v is string => Boolean(v)).slice(0, max);
  return out.length ? out : undefined;
}

function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;
}

/** Validate and trim what the phone sent to exactly the documented shape. */
export function normalizeDevicePayload(kind: DeviceKind, body: Record<string, unknown>): { data: Record<string, unknown>; count: number } {
  const cap = CAPS[kind];
  if (kind === "health") {
    const days = (Array.isArray(body.days) ? body.days : []).slice(-cap).flatMap((d) => {
      if (!d || typeof d !== "object") return [];
      const day = d as Record<string, unknown>;
      const date = str(day.date, 10);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      const workouts = (Array.isArray(day.workouts) ? day.workouts : []).slice(0, 20).flatMap((w) => {
        if (!w || typeof w !== "object") return [];
        const row = w as Record<string, unknown>;
        const type = str(row.type, 60);
        const start = str(row.start, 40);
        return type && start ? [compact({ type, start, minutes: num(row.minutes), kcal: num(row.kcal) })] : [];
      });
      return [compact({
        date,
        steps: num(day.steps),
        restingHr: num(day.restingHr),
        avgHr: num(day.avgHr),
        sleepMinutes: num(day.sleepMinutes),
        activeKcal: num(day.activeKcal),
        ...(workouts.length ? { workouts } : {}),
      })];
    });
    return { data: { days }, count: days.length };
  }
  if (kind === "contacts") {
    const contacts = (Array.isArray(body.contacts) ? body.contacts : []).slice(0, cap).flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const row = c as Record<string, unknown>;
      const name = str(row.name, 120);
      return name ? [compact({ name, phones: strList(row.phones), emails: strList(row.emails) })] : [];
    });
    return { data: { contacts }, count: contacts.length };
  }
  const events = (Array.isArray(body.events) ? body.events : []).slice(0, cap).flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const row = e as Record<string, unknown>;
    const title = str(row.title);
    const start = str(row.start, 40);
    return title && start ? [compact({ title, start, end: str(row.end, 40), location: str(row.location), calendar: str(row.calendar, 80), allDay: row.allDay === true ? true : undefined })] : [];
  });
  const reminders = (Array.isArray(body.reminders) ? body.reminders : []).slice(0, cap).flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const row = r as Record<string, unknown>;
    const title = str(row.title);
    return title ? [compact({ title, due: str(row.due, 40), completed: row.completed === true ? true : undefined, list: str(row.list, 80) })] : [];
  });
  // Only the lists actually sent — the caller merges, so a Reminders-only
  // sync doesn't wipe the calendar events (and vice versa).
  return {
    data: { ...(Array.isArray(body.events) ? { events } : {}), ...(Array.isArray(body.reminders) ? { reminders } : {}) },
    count: events.length + reminders.length,
  };
}

export async function readDeviceSnapshot(kind: DeviceKind, home?: string): Promise<DeviceSnapshot | null> {
  try {
    return JSON.parse(await fs.readFile(deviceFile(kind, home), "utf8")) as DeviceSnapshot;
  } catch {
    return null;
  }
}

async function writeSnapshot(kind: DeviceKind, snapshot: DeviceSnapshot, home?: string): Promise<void> {
  await fs.mkdir(deviceDir(home), { recursive: true, mode: 0o700 });
  const file = deviceFile(kind, home);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export async function handleDeviceApi(req: IncomingMessage, res: ServerResponse, url: URL, opts: { home?: string } = {}): Promise<boolean> {
  if (url.pathname !== "/gateway/device" && !url.pathname.startsWith("/gateway/device/")) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const parts = url.pathname.replace(/\/+$/, "").split("/").slice(3); // after /gateway/device
  try {
    if (parts.length === 0 && req.method === "GET") {
      const kinds: Record<string, { syncedAt: string; count: number }> = {};
      for (const kind of DEVICE_KINDS) {
        const snap = await readDeviceSnapshot(kind, opts.home);
        if (!snap) continue;
        const d = snap.data as Record<string, unknown[]>;
        const count = Object.values(d).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        kinds[kind] = { syncedAt: snap.syncedAt, count };
      }
      json(200, { kinds });
      return true;
    }
    // "reminders" is its own opt-in on the phone but lives in the calendar snapshot.
    const asked = parts[0] ?? "";
    const kind = (asked === "reminders" ? "calendar" : asked) as DeviceKind;
    if (!DEVICE_KINDS.includes(kind) || req.method !== "POST" || parts.length > 2 || (parts.length === 2 && parts[1] !== "forget")) {
      json(404, { error: "unknown device route" });
      return true;
    }
    if (parts[1] === "forget") {
      if (kind === "calendar") {
        const snap = await readDeviceSnapshot("calendar", opts.home);
        const keep = { ...(snap?.data ?? {}) };
        delete keep[asked === "reminders" ? "reminders" : "events"];
        if (Object.keys(keep).length) await writeSnapshot("calendar", { syncedAt: snap!.syncedAt, data: keep }, opts.home);
        else await fs.rm(deviceFile("calendar", opts.home), { force: true });
      } else {
        await fs.rm(deviceFile(kind, opts.home), { force: true });
      }
      json(200, { ok: true });
      return true;
    }
    const body = await readBody(req);
    const { data: sent, count } = normalizeDevicePayload(kind, asked === "reminders" && !Array.isArray(body.reminders) ? { reminders: body.items ?? [] } : body);
    const data = kind === "calendar" ? { ...((await readDeviceSnapshot("calendar", opts.home))?.data ?? {}), ...sent } : sent;
    await writeSnapshot(kind, { syncedAt: new Date().toISOString(), data }, opts.home);
    json(200, { ok: true, stored: count });
    return true;
  } catch (err) {
    json(400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
