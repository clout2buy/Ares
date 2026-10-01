// Garrison wiring for the phone's briefings and location triggers. Kept out of
// garrisonCmd.ts so that file only gains a few lines: build the services, hand
// the handlers to the phone API, hand the clock's check to the scheduler.
//
// The facts a briefing is written from are read here, with the same credentialed
// helpers the agent's own tools use (so a briefing and a chat turn agree about
// what is connected). Every source is optional: not connected is a status, not
// an error, and a source that throws or stalls costs the owner that one section
// and nothing else.

import { appendAudit, readAudit } from "@ares/core";
import type { SessionManager } from "@ares/garrison";
import { rolloutPath } from "@ares/garrison";
import { loadSchedule, listAlarms } from "@ares/channels";
import { CalendarTool, GmailTool, GoalsStore, GoogleCalendarTool, MailTool, TrackingStore, davCommon, getWeatherText, type RichToolContext } from "@ares/tools";
import { connectedProviders, OAUTH_PROVIDERS } from "@ares/core";
import { lastThreadMessage, type Persona } from "../personas.js";
import {
  BriefingService,
  SourceNotConnected,
  askBriefingLookup,
  createBriefingsApi,
  type BriefingSources,
  type CalendarWindow,
  type FactAgent,
  type FactEvent,
  type FactMail,
  type FactReminder,
} from "../phoneBriefings.js";
import { LocationService, createLocationApi, makeLocationFirer, type LocationSessionHost } from "../phoneLocation.js";
import { localDayKey, resolveTimeZone, zonedParts } from "../phoneCommon.js";

/** The tools read only `input`; the rich context is for permissions and streams a briefing never needs. */
const TOOL_CONTEXT = {} as unknown as RichToolContext;

// ─── Sources ──────────────────────────────────────────────────────────────

/** What the real sources call out to. Tests replace these; production uses the defaults below. */
export interface BriefingToolSeams {
  weather(location: string): Promise<string>;
  googleConnected(): Promise<boolean>;
  davConnected(): Promise<boolean>;
  googleEvents(days: number): Promise<Array<{ title: string; start: string; end?: string; location?: string }>>;
  davEvents(input: { from: string; days: number; timezone: string }): Promise<Array<{ title: string; start: string; end?: string; location?: string; allDay?: boolean }>>;
  gmailUnread(): Promise<{ unread: number; important: number; truncated: boolean; subjects: string[] }>;
  imapUnread(): Promise<{ unread: number; subjects: string[] }>;
}

export function realToolSeams(home: string): BriefingToolSeams {
  return {
    weather: async (location) => {
      const text = await getWeatherText(location);
      // getWeatherText swallows its own errors into prose; a briefing must not quote that as the weather.
      if (/^Weather unavailable/i.test(text)) throw new Error(text);
      return text;
    },
    googleConnected: async () => Boolean((await connectedProviders(OAUTH_PROVIDERS, home).catch(() => ({}) as Record<string, boolean>)).google),
    davConnected: async () => Boolean(await davCommon.loadDavAccount("caldav").catch(() => undefined)),
    googleEvents: async (days) => {
      const r = await GoogleCalendarTool.call({ action: "list_events", days }, TOOL_CONTEXT);
      return (r.output.events ?? []).map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location }));
    },
    davEvents: async ({ from, days, timezone }) => {
      const r = await CalendarTool.call({ action: "list_events", from, days, timezone, max_results: 25 }, TOOL_CONTEXT);
      if (r.failure) throw new Error(r.failure);
      return (r.output.events ?? []).map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location, allDay: e.allDay }));
    },
    gmailUnread: async () => {
      const [unread, important] = await Promise.all([
        GmailTool.call({ action: "search", query: "is:unread newer_than:2d", max_results: 10 }, TOOL_CONTEXT),
        GmailTool.call({ action: "search", query: "is:unread is:important newer_than:2d", max_results: 10 }, TOOL_CONTEXT),
      ]);
      const messages = unread.output.messages ?? [];
      return { unread: messages.length, truncated: messages.length >= 10, important: (important.output.messages ?? []).length, subjects: messages.slice(0, 5).map((m) => m.subject || "(no subject)") };
    },
    imapUnread: async () => {
      const r = await MailTool.call({ action: "list_messages", unread_only: true, limit: 8 }, TOOL_CONTEXT);
      if (r.failure) throw new Error(r.failure);
      const messages = r.output.messages ?? [];
      return { unread: r.output.total ?? messages.length, subjects: messages.slice(0, 5).map((m) => m.subject || "(no subject)") };
    },
  };
}

export interface BriefingSourceDeps {
  /** The garrison's home (personas, goals, tracking, alarms live under it). */
  home: string;
  approvals: { pending(): Array<{ id: string; reason: string; kind?: string }> };
  personas: { store: { list(): Persona[] }; defaultThread(): Promise<string | undefined> };
  sessions: { list(): Array<{ id: string; busy: boolean }> };
  seams?: BriefingToolSeams;
  now?: () => number;
}

const inWindow = (startIso: string, window: CalendarWindow): boolean => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(startIso)) return true; // all-day: the tool already scoped it to the day
  const t = Date.parse(startIso);
  return Number.isFinite(t) && t >= window.from && t < window.to;
};

export function buildBriefingSources(deps: BriefingSourceDeps): BriefingSources {
  const seams = deps.seams ?? realToolSeams(deps.home);
  const now = deps.now ?? Date.now;
  const location = () => process.env.ARES_OWNER_LOCATION?.trim();

  return {
    weather: async () => {
      const where = location();
      if (!where) throw new SourceNotConnected("no home location is set (ARES_OWNER_LOCATION)");
      return seams.weather(where);
    },

    calendar: async (window) => {
      const [google, dav] = await Promise.all([seams.googleConnected(), seams.davConnected()]);
      if (!google && !dav) throw new SourceNotConnected("no calendar is connected");
      const tz = resolveTimeZone();
      const events: FactEvent[] = [];
      let answered = false;
      const failures: unknown[] = [];
      if (dav) {
        await seams
          .davEvents({ from: localDayKey(window.from, tz), days: Math.max(1, Math.round((window.to - window.from) / 86_400_000)), timezone: tz })
          .then((rows) => { answered = true; events.push(...rows.filter((e) => inWindow(e.start, window))); })
          .catch((err: unknown) => { failures.push(err); });
      }
      if (google) {
        const days = Math.max(1, Math.ceil((window.to - now()) / 86_400_000));
        await seams
          .googleEvents(days)
          .then((rows) => { answered = true; events.push(...rows.filter((e) => inWindow(e.start, window))); })
          .catch((err: unknown) => { failures.push(err); });
      }
      if (!answered) throw failures[0] instanceof Error ? failures[0] : new Error("calendar did not answer");
      // The same event on two calendars (a Google calendar synced to iCloud) is one event.
      const seen = new Set<string>();
      return events.filter((e) => {
        const key = `${e.title.toLowerCase()}|${e.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    },

    mail: async (): Promise<FactMail> => {
      const [google, dav] = await Promise.all([seams.googleConnected(), seams.davConnected()]);
      if (google) {
        const m = await seams.gmailUnread();
        return { unread: m.unread, important: m.important, truncated: m.truncated, subjects: m.subjects };
      }
      // Mail rides the same iCloud/IMAP credentials as the calendar; an account with no mailbox fails loudly and becomes "failed".
      if (dav) return seams.imapUnread();
      throw new SourceNotConnected("no mail account is connected");
    },

    reminders: async (window): Promise<FactReminder[]> => {
      const tz = resolveTimeZone();
      const out: FactReminder[] = [];
      const weekday = zonedParts(window.from, tz).weekday;
      // Reminders: the alarms Ares keeps (Telegram schedule file) that fall on that day.
      for (const a of listAlarms(await loadSchedule(deps.home))) {
        if (a.days?.length && !a.days.includes(weekday)) continue;
        out.push({ label: a.label, at: `${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}`, ...(a.body ? { body: a.body } : {}) });
      }
      out.sort((x, y) => (x.at ?? "").localeCompare(y.at ?? ""));
      // Commitments Ares is tracking that come due that day, or already slipped.
      for (const item of await new TrackingStore(deps.home).forPhone(new Date(now()))) {
        if (item.status !== "open" || !item.dueAt) continue;
        const due = Date.parse(item.dueAt);
        if (!Number.isFinite(due)) continue;
        if (due < window.from) out.push({ label: item.title, at: item.dueAt, overdue: true });
        else if (due < window.to) out.push({ label: item.title, at: `${String(zonedParts(due, tz).hour).padStart(2, "0")}:${String(zonedParts(due, tz).minute).padStart(2, "0")}` });
      }
      return out;
    },

    goals: async () => {
      const goals = (await new GoalsStore(deps.home).list()).filter((g) => g.status === "active");
      return goals.map((g) => ({
        id: g.id,
        title: g.title,
        ...(g.progress !== undefined ? { progress: g.progress } : {}),
        ...(g.target ? { target: g.target } : {}),
        ...(g.note ? { note: g.note } : {}),
        ...(g.nextCheckIn && Date.parse(g.nextCheckIn) <= now() + 86_400_000 ? { nextCheckIn: g.nextCheckIn } : {}),
      }));
    },

    agents: async (sinceMs) => {
      const live = new Map(deps.sessions.list().map((s) => [s.id, s]));
      const threads: Array<{ id: string; name: string; sessionId?: string }> = [{ id: "ares", name: "Ares", sessionId: await deps.personas.defaultThread() }];
      for (const p of deps.personas.store.list()) threads.push({ id: p.id, name: p.name, sessionId: p.sessionId });
      const agents: FactAgent[] = [];
      for (const t of threads) {
        if (!t.sessionId) continue;
        const last = await lastThreadMessage(rolloutPath(deps.home, t.sessionId), 200);
        const at = last?.at ? Date.parse(last.at) : NaN;
        const busy = live.get(t.sessionId)?.busy === true;
        if (!busy && !(Number.isFinite(at) && at >= sinceMs)) continue;
        agents.push({ id: t.id, name: t.name, ...(busy ? { busy: true } : {}), ...(last?.at ? { lastAt: last.at } : {}), ...(last?.role === "assistant" ? { last: last.text } : {}) });
      }
      const entries = (await readAudit({ home: deps.home, days: 2, limit: 600 }).catch(() => [])).filter((e) => Date.parse(e.ts) >= sinceMs && e.actor !== "owner" && e.actor !== "you");
      const actions = entries.length
        ? { total: entries.length, failed: entries.filter((e) => /^error/i.test(e.result ?? "")).length, denied: entries.filter((e) => e.result === "denied").length }
        : undefined;
      return { agents, ...(actions ? { actions } : {}) };
    },

    approvals: async () => deps.approvals.pending().map((a) => ({ id: a.id, summary: a.reason, ...(a.kind ? { kind: a.kind } : {}) })),
  };
}

// ─── The turn ─────────────────────────────────────────────────────────────

/** The slice of SessionManager one briefing turn drives. */
export interface BriefingSessionHost {
  create(opts: { surface?: "headless"; tenant?: { role: "owner" }; title?: string }): { id: string };
  attach(sessionId: string, subscriber: (event: { type: string; text?: string }) => void): () => void;
  send(sessionId: string, text: string, options?: { inputId?: string }): Promise<void>;
  interrupt(sessionId: string): unknown;
  archive(sessionId: string): Promise<boolean>;
}

/**
 * One briefing on a fresh owner session that is archived when it ends: the
 * turn needs no memory of yesterday's (that is how a stale fact leaks in), and
 * a session per run would otherwise pile up in the owner's list. Text before a
 * tool call is narration, so the buffer restarts at each tool_start — what is
 * left is the answer.
 */
export async function runBriefingTurn(sessions: BriefingSessionHost, text: string, timeoutMs: number): Promise<string> {
  const id = sessions.create({ surface: "headless", tenant: { role: "owner" }, title: "Briefing" }).id;
  let buffer = "";
  const detach = sessions.attach(id, (event) => {
    if (event.type === "text_delta") buffer += event.text ?? "";
    else if (event.type === "tool_start") buffer = "";
  });
  const timer = setTimeout(() => {
    try {
      sessions.interrupt(id);
    } catch {
      // already gone
    }
  }, timeoutMs);
  timer.unref?.();
  try {
    await sessions.send(id, text, { inputId: `briefing_${Date.now().toString(36)}` });
  } finally {
    clearTimeout(timer);
    detach();
    void sessions.archive(id).catch(() => undefined);
  }
  return buffer;
}

// ─── Assembly ─────────────────────────────────────────────────────────────

export interface BriefingWiringDeps extends BriefingSourceDeps {
  sessions: SessionManager;
  personas: { store: { list(): Persona[]; get(id: string): Persona | undefined }; defaultThread(): Promise<string | undefined> };
  push?: (message: { title: string; body: string; data?: Record<string, unknown>; collapseId?: string }) => Promise<unknown>;
  isPaused: () => boolean;
  available?: () => boolean | string;
  log: (line: string) => void;
}

export interface PhoneBriefingsAndLocation {
  briefings: BriefingService;
  briefingsApi: ReturnType<typeof createBriefingsApi>;
  askBriefing: ReturnType<typeof askBriefingLookup>;
  location: LocationService;
  locationApi: ReturnType<typeof createLocationApi>;
}

export function startBriefingsAndLocation(deps: BriefingWiringDeps): PhoneBriefingsAndLocation {
  const audit = (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => appendAudit(entry, deps.home);
  const timeoutMs = Number(process.env.ARES_BRIEFING_TIMEOUT_MS) > 0 ? Number(process.env.ARES_BRIEFING_TIMEOUT_MS) : 8 * 60_000;
  const briefings = new BriefingService({
    home: deps.home,
    sources: buildBriefingSources(deps),
    runTurn: (prompt) => runBriefingTurn(deps.sessions as unknown as BriefingSessionHost, prompt, timeoutMs),
    agents: { get: (id) => deps.personas.store.get(id) },
    push: deps.push,
    isPaused: deps.isPaused,
    available: deps.available,
    audit,
    log: deps.log,
    turnTimeoutMs: timeoutMs + 30_000,
  });
  const location = new LocationService({
    home: deps.home,
    fire: makeLocationFirer({ sessions: deps.sessions as unknown as LocationSessionHost, personas: deps.personas }),
    agents: { get: (id) => deps.personas.store.get(id) },
    isPaused: deps.isPaused,
    audit,
    log: deps.log,
  });
  return {
    briefings,
    briefingsApi: createBriefingsApi(briefings, deps.log),
    askBriefing: askBriefingLookup(briefings),
    location,
    locationApi: createLocationApi(location, deps.log),
  };
}
