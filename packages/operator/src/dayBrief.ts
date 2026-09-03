// The morning brief — "what does today look like?" in one compact block.
//
// rankBriefing() already answers "what should I work on?"; this composes the
// REST of a morning: weather, today's calendar, reminders due today, unread
// mail, then the mission ranking. Every source is optional and injected
// (calendar/mail/weather live behind credentials in @ares/tools, which the
// operator deliberately does not depend on — the CLI wires the real fetchers,
// tests wire fakes). Sources run in PARALLEL with a per-source timeout, and a
// source that is missing, slow, or throws yields exactly one honest line
// ("calendar: not connected") instead of an error — a broken Gmail token must
// never cost the owner their weather.
//
// Deterministic only — no LLM, no invented urgency. Section order is fixed:
// weather → calendar → reminders → email → missions.

import type { DailyBriefing } from "./briefing.js";

export interface DayBriefEvent {
  title: string;
  /** ISO datetime, or YYYY-MM-DD for an all-day event. */
  start: string;
  end?: string;
  location?: string;
}

export interface DayBriefEmail {
  unread: number;
  /** Unread AND flagged important, when the source can tell. */
  important?: number;
  /** Subjects only — never bodies. */
  subjects: string[];
  /** True when `unread` hit the source's page cap (render as "10+"). */
  truncated?: boolean;
}

export interface DayBriefReminder {
  label: string;
  hour: number;
  minute: number;
  body?: string;
}

/** Each fetcher is optional: absent = "not connected"; throws/times out = one failure line. */
export interface DayBriefSources {
  weather?: () => Promise<string>;
  calendar?: () => Promise<DayBriefEvent[]>;
  reminders?: () => Promise<DayBriefReminder[]>;
  email?: () => Promise<DayBriefEmail>;
  missions?: () => Promise<DailyBriefing>;
}

export type DayBriefSectionName = "weather" | "calendar" | "reminders" | "email" | "missions";
export type DayBriefSourceStatus = "ok" | "not-connected" | "failed" | "timeout";

export interface DayBriefSection {
  name: DayBriefSectionName;
  status: DayBriefSourceStatus;
  lines: string[];
}

export interface DayBrief {
  at: string;
  sections: DayBriefSection[];
  /** The rendered block — the sections joined, one blank line between them. */
  text: string;
}

export interface ComposeDayBriefOptions {
  sources: DayBriefSources;
  /** Injected clock so tests are deterministic. */
  now?: Date;
  /** Per-source deadline. Default ARES_BRIEF_SOURCE_TIMEOUT_MS or 8000. */
  timeoutMs?: number;
  /** IANA zone for rendering event/reminder times; default = process local. */
  timeZone?: string;
  /** Max calendar events / subjects / focus items rendered. Default 8 / 3 / 3. */
  maxEvents?: number;
  maxSubjects?: number;
  maxFocus?: number;
}

export const DEFAULT_BRIEF_SOURCE_TIMEOUT_MS = 8_000;
const SECTION_ORDER: DayBriefSectionName[] = ["weather", "calendar", "reminders", "email", "missions"];

/** Env-tunable default so a slow wttr.in/Gmail morning can be shortened without a rebuild. */
export function briefSourceTimeoutMs(): number {
  const raw = Number(process.env.ARES_BRIEF_SOURCE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BRIEF_SOURCE_TIMEOUT_MS;
}

type Fetched<T> = { status: "ok"; value: T } | { status: "not-connected" } | { status: "failed"; reason: string } | { status: "timeout" };

async function fetchSource<T>(fn: (() => Promise<T>) | undefined, timeoutMs: number): Promise<Fetched<T>> {
  if (!fn) return { status: "not-connected" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Fetched<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  try {
    const attempt: Promise<Fetched<T>> = Promise.resolve()
      .then(fn)
      .then((value) => ({ status: "ok", value }) as Fetched<T>)
      .catch((err) => ({ status: "failed", reason: clip(err instanceof Error ? err.message : String(err), 80) }) as Fetched<T>);
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unavailableLine(name: DayBriefSectionName, fetched: Fetched<unknown>, timeoutMs: number): string {
  if (fetched.status === "timeout") return `${name}: not connected (timed out after ${Math.round(timeoutMs / 1000)}s)`;
  if (fetched.status === "failed") return `${name}: not connected (${fetched.reason})`;
  return `${name}: not connected`;
}

/** Gather every source in parallel and render the fixed-order block. Never throws. */
export async function composeDayBrief(opts: ComposeDayBriefOptions): Promise<DayBrief> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? briefSourceTimeoutMs();
  const { sources } = opts;
  const [weather, calendar, reminders, email, missions] = await Promise.all([
    fetchSource(sources.weather, timeoutMs),
    fetchSource(sources.calendar, timeoutMs),
    fetchSource(sources.reminders, timeoutMs),
    fetchSource(sources.email, timeoutMs),
    fetchSource(sources.missions, timeoutMs),
  ]);

  const fmt = {
    timeZone: opts.timeZone,
    now,
    maxEvents: opts.maxEvents ?? 8,
    maxSubjects: opts.maxSubjects ?? 3,
    maxFocus: opts.maxFocus ?? 3,
  };
  const byName: Record<DayBriefSectionName, DayBriefSection> = {
    weather: section("weather", weather, timeoutMs, (text) => renderWeather(text)),
    calendar: section("calendar", calendar, timeoutMs, (events) => renderCalendar(events, fmt)),
    reminders: section("reminders", reminders, timeoutMs, (items) => renderReminders(items, fmt)),
    email: section("email", email, timeoutMs, (mail) => renderEmail(mail, fmt)),
    missions: section("missions", missions, timeoutMs, (briefing) => renderMissions(briefing, fmt)),
  };
  const sections = SECTION_ORDER.map((name) => byName[name]);
  return {
    at: now.toISOString(),
    sections,
    text: sections.map((s) => s.lines.join("\n")).join("\n\n"),
  };
}

function section<T>(
  name: DayBriefSectionName,
  fetched: Fetched<T>,
  timeoutMs: number,
  render: (value: T) => string[],
): DayBriefSection {
  if (fetched.status !== "ok") return { name, status: fetched.status, lines: [unavailableLine(name, fetched, timeoutMs)] };
  try {
    return { name, status: "ok", lines: render(fetched.value) };
  } catch (err) {
    // A malformed payload is a source failure too — never a thrown brief.
    return { name, status: "failed", lines: [`${name}: not connected (${clip(err instanceof Error ? err.message : String(err), 80)})`] };
  }
}

interface RenderContext {
  timeZone?: string;
  now: Date;
  maxEvents: number;
  maxSubjects: number;
  maxFocus: number;
}

function renderWeather(text: string): string[] {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return ["weather: no data"];
  // Keep it to the location + now + a short forecast — the full wttr block is
  // a phone-screen of text.
  return [`weather: ${lines[0]}`, ...lines.slice(1, 4).map((l) => `  ${l}`)];
}

function renderCalendar(events: DayBriefEvent[], ctx: RenderContext): string[] {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e.title === "string") : [];
  if (list.length === 0) return ["calendar: nothing scheduled"];
  const sorted = [...list].sort((a, b) => sortKey(a.start) - sortKey(b.start));
  const lines = [`calendar: ${sorted.length} event${sorted.length === 1 ? "" : "s"}`];
  for (const e of sorted.slice(0, ctx.maxEvents)) {
    const when = isAllDay(e.start) ? "all day" : `${formatTime(e.start, ctx.timeZone)}${e.end && !isAllDay(e.end) ? `–${formatTime(e.end, ctx.timeZone)}` : ""}`;
    lines.push(`  ${when.padEnd(11)} ${clip(e.title, 60)}${e.location ? ` @ ${clip(e.location, 30)}` : ""}`);
  }
  if (sorted.length > ctx.maxEvents) lines.push(`  … ${sorted.length - ctx.maxEvents} more`);
  return lines;
}

function renderReminders(items: DayBriefReminder[], ctx: RenderContext): string[] {
  const list = Array.isArray(items) ? items.filter((r) => r && typeof r.label === "string") : [];
  if (list.length === 0) return ["reminders: none due"];
  const sorted = [...list].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  const lines = [`reminders: ${sorted.length} due today`];
  for (const r of sorted) {
    const hh = String(Math.max(0, Math.min(23, r.hour | 0))).padStart(2, "0");
    const mm = String(Math.max(0, Math.min(59, r.minute | 0))).padStart(2, "0");
    lines.push(`  ${hh}:${mm}       ${clip(r.label, 60)}${r.body ? ` — ${clip(r.body, 60)}` : ""}`);
  }
  void ctx;
  return lines;
}

function renderEmail(mail: DayBriefEmail, ctx: RenderContext): string[] {
  const unread = Math.max(0, Number(mail?.unread) || 0);
  const count = `${unread}${mail?.truncated ? "+" : ""}`;
  const important = typeof mail?.important === "number" && mail.important > 0 ? ` (${mail.important} important)` : "";
  const lines = [`email: ${count} unread${important}`];
  for (const subject of (mail?.subjects ?? []).slice(0, ctx.maxSubjects)) lines.push(`  · ${clip(subject, 70)}`);
  return lines;
}

function renderMissions(b: DailyBriefing, ctx: RenderContext): string[] {
  const lines = [`missions: ${b.headline}`];
  for (const f of b.focus.slice(0, ctx.maxFocus)) {
    lines.push(`  • ${clip(f.intent, 60)} [${f.status} ${f.percent}%]${f.nextAction ? ` → ${clip(f.nextAction, 50)}` : ""}`);
  }
  for (const d of b.decisionsNeeded.slice(0, 3)) lines.push(`  ! ${clip(d.intent, 60)} — ${clip(d.detail, 50)}`);
  if (b.reviveOrDrop.length) lines.push(`  · ${b.reviveOrDrop.length} stale mission${b.reviveOrDrop.length === 1 ? "" : "s"} to revive or drop`);
  if (b.suggestion) lines.push(`  suggested (advisory): ${clip(b.suggestion.goal, 70)}`);
  return lines;
}

function isAllDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function sortKey(start: string): number {
  if (isAllDay(start)) return -1; // all-day events lead the list
  const t = Date.parse(start);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "??:??";
  try {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(d);
  } catch {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

function clip(text: string, max: number): string {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
