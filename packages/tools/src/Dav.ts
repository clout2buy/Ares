// Calendar and Contacts over CalDAV / CardDAV: the owner's iPhone-synced
// iCloud Calendar, Reminders and Contacts (app-specific password, works with
// the phone off), or Fastmail / Nextcloud / Radicale / any DAV server.
//
// Two tools, both deferred (found with ToolSearch):
//   Calendar  calendars, events (recurrence expanded), reminders (VTODO)
//   Contacts  address books, search, get, create, update, delete
//
// Gating, in the existing convention (see GoogleCalendar / Gmail):
//   reads                      free
//   create / update event      asks, with the exact title, time and calendar
//   delete event               asks (owner decision: irreversible)
//   reminders create/complete  free (private to the owner, trivially undone)
//   contact create / update    asks with the fields; delete asks (owner decision)
// cli/policyGateDav.ts puts the same actions into the structured policy
// categories so the phone and the unattended loop hold them too.
//
// Credentials are read from the vault by davCommon and never enter a result.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import {
  DAV_LIMITS,
  DavError,
  NOT_CONNECTED,
  accountSecrets,
  clip,
  loadDavAccount,
  oneLine,
  redact,
  type AccountId,
  type DavAccount,
} from "./davCommon.js";
import {
  calendarBackendFor,
  contactsBackendFor,
  inside,
  type BookInfo,
  type CalendarBackend,
  type CalendarInfo,
  type ContactsBackend,
  type DavObject,
} from "./davClient.js";
import {
  buildEventIcs,
  buildTodoIcs,
  buildVcard,
  completeTodoIcs,
  describeEvent,
  eventUidOf,
  expandEvents,
  isValidTimeZone,
  parseReminders,
  parseVcard,
  parseWhen,
  patchEventIcs,
  patchVcard,
  systemTimeZone,
  type CalendarEventView,
  type ContactView,
  type EventDetail,
  type ReminderView,
} from "./davIcal.js";

// ─── shared ──────────────────────────────────────────────────────────────────

const ACCOUNTS = ["icloud", "caldav", "carddav"] as const;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

function fail<O extends { message: string }>(message: string, extra?: Omit<O, "message">): ToolResult<O> {
  return { output: { ...(extra ?? {}), message } as O, display: message.slice(0, 200), failure: message };
}

function ok<O extends { message: string }>(output: O, display?: string): ToolResult<O> {
  return { output, display: (display ?? output.message).slice(0, 200) };
}

/** Anything thrown becomes a safe sentence: DavErrors already are; the rest
 *  are scrubbed of secrets and clipped. */
function safeMessage(err: unknown, account?: DavAccount): string {
  if (err instanceof DavError) return err.message;
  const text = err instanceof Error ? err.message : String(err);
  return redact(clip(text.replace(/\s+/g, " "), 300), account ? accountSecrets(account) : []);
}

function slug(): string {
  return crypto.randomUUID();
}

function pickCalendar(cals: CalendarInfo[], ref: string | undefined, kind: "VEVENT" | "VTODO", prefer: RegExp): CalendarInfo {
  const usable = cals.filter((c) => c.components.length === 0 || c.components.includes(kind));
  if (!usable.length) throw new DavError("not-found", kind === "VTODO" ? "This account has no reminder lists (calendars that hold reminders)." : "This account has no event calendars.");
  if (ref) {
    const want = ref.trim().toLowerCase();
    const exact = usable.filter((c) => c.url === ref.trim() || c.name.toLowerCase() === want);
    if (exact.length === 1) return exact[0]!;
    const partial = usable.filter((c) => c.name.toLowerCase().includes(want));
    if (partial.length === 1) return partial[0]!;
    throw new DavError("not-found", `${exact.length + partial.length > 1 ? "Several" : "No"} calendars match "${clip(ref, 60)}". Available: ${usable.map((c) => c.name).join(", ")}.`);
  }
  return usable.find((c) => prefer.test(c.name)) ?? usable[0]!;
}

function selectCalendars(cals: CalendarInfo[], ref: string | undefined, kind: "VEVENT" | "VTODO"): CalendarInfo[] {
  const usable = cals.filter((c) => c.components.length === 0 || c.components.includes(kind));
  return ref ? [pickCalendar(cals, ref, kind, /./)] : usable;
}

/** An event/reminder id is an object URL or a UID; URLs must live inside one
 *  of the account's own calendars. */
async function findObject(backend: CalendarBackend, cals: CalendarInfo[], idOrUid: string, kind: "VEVENT" | "VTODO"): Promise<{ obj: DavObject; cal: CalendarInfo }> {
  const id = idOrUid.trim();
  if (/^https?:\/\//i.test(id) || id.startsWith("/")) {
    for (const cal of cals) {
      if (!inside(cal.url, new URL(id, cal.url).href)) continue;
      const obj = await backend.getObject(new URL(id, cal.url).href);
      if (!obj) throw new DavError("not-found", "That item no longer exists on the server. List again to get a fresh id.");
      return { obj, cal };
    }
    throw new DavError("not-found", "That id does not belong to one of this account's calendars. Use an id from a list call.");
  }
  for (const cal of cals.filter((c) => c.components.length === 0 || c.components.includes(kind))) {
    const found = await backend.fetchObjects(cal, { kind, uid: id });
    const hit = found.find((o) => eventUidOf(o.data) === id || new RegExp(`^UID:${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(o.data));
    if (hit) return { obj: hit, cal };
  }
  throw new DavError("not-found", "No item with that id was found. List again to get a fresh id.");
}

function whenText(start: string, end: string, allDay: boolean): string {
  return allDay ? (start === end ? start : `${start} to ${end}`) : `${start} to ${end}`;
}

function eventLine(e: CalendarEventView): string {
  return `${e.start}${e.allDay ? " (all day)" : ` to ${e.end.slice(11, 16)}`} · ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.recurring ? " (repeats)" : ""} [${e.calendar}]`;
}

// ─── Calendar ────────────────────────────────────────────────────────────────

const ACTIONS = [
  "list_calendars", "list_events", "get_event", "create_event", "update_event", "delete_event",
  "list_reminders", "create_reminder", "complete_reminder",
] as const;

const calendarSchema = z.object({
  action: z.enum(ACTIONS).describe(
    "list_calendars: every calendar and reminder list on the account. " +
    "list_events: events in a date range with recurrences expanded (default: the next 7 days). " +
    "get_event: one event in full (rule, attendees, alarms). " +
    "create_event: add an event (title, start; asks the owner). " +
    "update_event: change fields of an event or its whole series (asks the owner). " +
    "delete_event: delete an event or its whole series (asks the owner). " +
    "list_reminders: open reminders (include_completed for done ones). " +
    "create_reminder: add a reminder with an optional due time. " +
    "complete_reminder: tick a reminder off.",
  ),
  account: z.enum(ACCOUNTS).optional().describe("Which connection to use when more than one is set up (default: iCloud, then a generic CalDAV server)."),
  calendar: z.string().optional().describe("Calendar or reminder-list name (or URL) from list_calendars. Reads default to all; create defaults to the account's main calendar/list."),
  event_id: z.string().optional().describe("Event id from list_events / get_event (or the event's UID) for get/update/delete."),
  reminder_id: z.string().optional().describe("Reminder id from list_reminders (or its UID) for complete_reminder."),
  from: z.string().optional().describe("list_events range start: YYYY-MM-DD or YYYY-MM-DDTHH:MM (default: now)."),
  to: z.string().optional().describe("list_events range end (default: from + days)."),
  days: z.number().int().min(1).max(MAX_RANGE_DAYS).optional().describe("list_events: days from `from` (default 7, max 366)."),
  title: z.string().optional().describe("Event or reminder title."),
  start: z.string().optional().describe("Event start: YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:MM[:SS] (wall clock in `timezone`), optionally with Z or an offset."),
  end: z.string().optional().describe("Event end (default start + 1 hour). For all-day events this is the LAST day, inclusive."),
  timezone: z.string().optional().describe("IANA zone for the times, e.g. America/New_York (default: the owner's zone). Recurring events keep their wall-clock time across daylight saving."),
  location: z.string().optional().describe("Event location."),
  description: z.string().optional().describe("Event description or reminder notes."),
  recurrence: z.string().optional().describe('Repeat rule (RRULE body), e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10" or "FREQ=MONTHLY;BYMONTHDAY=1". On update, "none" removes the repeat.'),
  alarm_minutes_before: z.number().int().min(0).max(40320).optional().describe("create_event: pop up an alert this many minutes before."),
  due: z.string().optional().describe("Reminder due date or date-time (same formats as start)."),
  priority: z.number().int().min(0).max(9).optional().describe("Reminder priority 1 (high) to 9 (low); 0 = none."),
  include_completed: z.boolean().optional().describe("list_reminders: include completed reminders."),
  max_results: z.number().int().min(1).max(DAV_LIMITS.maxEvents).optional().describe("Cap on rows returned (default 50)."),
});

type CalendarInput = z.infer<typeof calendarSchema>;

export interface CalendarOutput {
  calendars?: Array<{ name: string; url: string; holds: string[]; description?: string }>;
  events?: CalendarEventView[];
  event?: EventDetail;
  reminders?: ReminderView[];
  created?: { id: string; uid: string; calendar: string };
  updated?: { id: string; uid?: string };
  deleted?: boolean;
  truncated?: boolean;
  note?: string;
  message: string;
}

async function calendarSetup(input: { account?: AccountId }): Promise<{ account: DavAccount; backend: CalendarBackend } | { error: string }> {
  const account = await loadDavAccount("caldav", input.account);
  if (!account) return { error: NOT_CONNECTED("icloud (or caldav)") };
  return { account, backend: calendarBackendFor(account) };
}

function eventPrompt(verb: string, input: CalendarInput, where?: string, current?: EventDetail): string {
  const title = input.title ?? current?.title ?? "(untitled)";
  const parts = [`${verb}: "${oneLine(title, 120)}"`];
  const start = input.start ?? current?.start;
  const end = input.end ?? (input.start ? undefined : current?.end);
  if (start) parts.push(end ? whenText(start, end, !start.includes("T")) : `starting ${start}`);
  if (input.timezone) parts.push(`(${input.timezone})`);
  if (input.recurrence) parts.push(`repeating ${oneLine(input.recurrence, 80)}`);
  if (input.location) parts.push(`at ${oneLine(input.location, 80)}`);
  if (where) parts.push(`in ${where}`);
  return parts.join(" ");
}

/** A best-effort look at an existing event so the ask can name it. */
async function peekEvent(input: CalendarInput): Promise<EventDetail | undefined> {
  if (!input.event_id) return undefined;
  try {
    const setup = await calendarSetup(input);
    if ("error" in setup) return undefined;
    const cals = await setup.backend.listCalendars();
    const { obj, cal } = await findObject(setup.backend, cals, input.event_id, "VEVENT");
    return describeEvent(obj.data, { id: obj.url, calendar: cal.name, tz: input.timezone && isValidTimeZone(input.timezone) ? input.timezone : systemTimeZone() }) ?? undefined;
  } catch {
    return undefined;
  }
}

const CAL_WRITE = new Set(["create_event", "update_event"]);

export const CalendarTool = buildTool<typeof calendarSchema, CalendarOutput>({
  name: "Calendar",
  description:
    "The owner's calendar and reminders over CalDAV: iCloud (iPhone Calendar + Reminders, works with the phone off), Fastmail, Nextcloud, Radicale or any CalDAV server. " +
    "List calendars and events (recurring events expanded), read one event, create/update/delete events (asks the owner first), and list, add or complete reminders. " +
    "Not connected → Connect service \"icloud\" (or \"caldav\" for another server). Use GoogleCalendar instead when the owner connected Google.",
  safety: "external-state",
  dynamicSafety: (input) => {
    if (input.action === "delete_event") return "external-state";
    if (CAL_WRITE.has(input.action) || input.action === "create_reminder" || input.action === "complete_reminder") return "workspace-write";
    return "read-only";
  },
  concurrency: "parallel-safe",
  inputZod: calendarSchema,
  ownerDecisions: true,
  watchdogTimeoutMs: 120_000,
  async checkPermissions(input) {
    if (input.action === "create_event") return { kind: "ask", prompt: eventPrompt("Create calendar event", input, input.calendar), suggestion: "allow_once" };
    if (input.action === "update_event") {
      const current = await peekEvent(input);
      return { kind: "ask", prompt: eventPrompt(`Change calendar event${input.recurrence !== undefined || current?.recurring ? " (whole series)" : ""}`, input, current?.calendar, current), suggestion: "allow_once" };
    }
    if (input.action === "delete_event") {
      const current = await peekEvent(input);
      return {
        kind: "ask",
        prompt: current
          ? `Delete calendar event "${oneLine(current.title, 120)}" (${current.start})${current.recurring ? " and every repeat of it" : ""}. This cannot be undone.`
          : `Delete calendar event ${input.event_id ?? "?"}. This cannot be undone.`,
        suggestion: "deny",
        ownerDecision: true,
      };
    }
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "list_calendars": return "Listing calendars";
      case "list_events": return "Checking the calendar";
      case "get_event": return "Reading an event";
      case "create_event": return `Creating event: ${input.title ?? ""}`;
      case "update_event": return "Updating an event";
      case "delete_event": return "Deleting an event";
      case "list_reminders": return "Checking reminders";
      case "create_reminder": return `Adding reminder: ${input.title ?? ""}`;
      case "complete_reminder": return "Completing a reminder";
      default: return "Calendar";
    }
  },
  async call(input: CalendarInput): Promise<ToolResult<CalendarOutput>> {
    const setup = await calendarSetup(input);
    if ("error" in setup) return fail<CalendarOutput>(setup.error);
    const { account, backend } = setup;
    try {
      return await runCalendar(input, backend);
    } catch (err) {
      return fail<CalendarOutput>(safeMessage(err, account));
    }
  },
});

export async function runCalendar(input: CalendarInput, backend: CalendarBackend): Promise<ToolResult<CalendarOutput>> {
  const tz = input.timezone !== undefined ? (isValidTimeZone(input.timezone) ? input.timezone : undefined) : systemTimeZone();
  if (!tz) return fail<CalendarOutput>(`"${clip(input.timezone, 40)}" is not a known IANA time zone (for example America/New_York).`);
  const limit = Math.min(input.max_results ?? 50, DAV_LIMITS.maxEvents);

  switch (input.action) {
    case "list_calendars": {
      const cals = await backend.listCalendars();
      const calendars = cals.map((c) => ({ name: oneLine(c.name, 80), url: c.url, holds: c.components.length ? c.components.map((x) => (x === "VEVENT" ? "events" : x === "VTODO" ? "reminders" : x.toLowerCase())) : ["events"], ...(c.description ? { description: c.description } : {}) }));
      return ok({ calendars, message: calendars.length ? calendars.map((c) => `${c.name} (${c.holds.join(", ")})`).join("\n") : "No calendars on this account." });
    }

    case "list_events": {
      const fromText = input.from?.trim();
      const start = fromText ? parseWhen(fromText, tz) : undefined;
      const startMs = start ? (start.allDay ? start.ms : start.ms) : Date.now();
      const endMs = input.to ? parseWhen(input.to, tz).ms + (parseWhen(input.to, tz).allDay ? DAY_MS : 0) : startMs + (input.days ?? 7) * DAY_MS;
      if (endMs <= startMs) return fail<CalendarOutput>("The range is empty: `to` must be after `from`.");
      if (endMs - startMs > MAX_RANGE_DAYS * DAY_MS) return fail<CalendarOutput>(`The range is longer than ${MAX_RANGE_DAYS} days. Ask for a shorter window.`);
      const range = { start: new Date(startMs), end: new Date(endMs) };
      const cals = selectCalendars(await backend.listCalendars(), input.calendar, "VEVENT");
      const all: CalendarEventView[] = [];
      let note: string | undefined;
      for (let i = 0; i < cals.length; i += 4) {
        const batch = await Promise.all(
          cals.slice(i, i + 4).map(async (cal) => {
            const objects = await backend.fetchObjects(cal, { kind: "VEVENT", range });
            return objects.flatMap((o) => {
              const r = expandEvents(o.data, range, { id: o.url, calendar: oneLine(cal.name, 60), tz });
              if (r.note) note = r.note;
              return r.events;
            });
          }),
        );
        for (const events of batch) all.push(...events);
      }
      all.sort((a, b) => Date.parse(a.allDay ? `${a.start}T00:00:00Z` : a.start) - Date.parse(b.allDay ? `${b.start}T00:00:00Z` : b.start));
      const truncated = all.length > limit;
      const events = all.slice(0, limit);
      const message = events.length
        ? `${events.length}${truncated ? `+ (showing first ${limit})` : ""} event(s), ${range.start.toISOString().slice(0, 10)} to ${range.end.toISOString().slice(0, 10)}:\n${events.map(eventLine).join("\n")}`
        : "No events in that range.";
      return ok({ events, ...(truncated ? { truncated } : {}), ...(note ? { note } : {}), message });
    }

    case "get_event": {
      if (!input.event_id) return fail<CalendarOutput>("event_id is required (from list_events).");
      const cals = await backend.listCalendars();
      const { obj, cal } = await findObject(backend, cals, input.event_id, "VEVENT");
      const event = describeEvent(obj.data, { id: obj.url, calendar: oneLine(cal.name, 60), tz });
      if (!event) return fail<CalendarOutput>("That item could not be read as an event.");
      return ok({ event, message: `${eventLine(event)}${event.recurrenceRule ? `\nRepeats: ${event.recurrenceRule}` : ""}${event.description ? `\n${clip(event.description, 600)}` : ""}` });
    }

    case "create_event": {
      if (!input.title?.trim() || !input.start?.trim()) return fail<CalendarOutput>("create_event needs title and start.");
      const cals = await backend.listCalendars();
      const cal = pickCalendar(cals, input.calendar, "VEVENT", /^(calendar|home|personal|default|main)$/i);
      const uidBuilt = buildEventIcs({
        title: input.title,
        start: input.start,
        ...(input.end ? { end: input.end } : {}),
        timezone: tz,
        ...(input.location ? { location: input.location } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.recurrence ? { recurrence: input.recurrence } : {}),
        ...(input.alarm_minutes_before !== undefined ? { alarmMinutesBefore: input.alarm_minutes_before } : {}),
      });
      const made = await backend.create(cal, `${slug()}.ics`, uidBuilt.ics);
      return ok({ created: { id: made.url, uid: uidBuilt.uid, calendar: cal.name }, message: `Created "${oneLine(input.title, 120)}" in ${cal.name}.` }, `Created: ${input.title}`);
    }

    case "update_event": {
      if (!input.event_id) return fail<CalendarOutput>("event_id is required (from list_events).");
      const fields = ["title", "start", "end", "location", "description", "recurrence"] as const;
      if (!fields.some((f) => input[f] !== undefined)) return fail<CalendarOutput>("Nothing to change: give at least one of title, start, end, location, description, recurrence.");
      const cals = await backend.listCalendars();
      const { obj } = await findObject(backend, cals, input.event_id, "VEVENT");
      const data = patchEventIcs(
        obj.data,
        {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.start !== undefined ? { start: input.start } : {}),
          ...(input.end !== undefined ? { end: input.end } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.location !== undefined ? { location: input.location } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.recurrence !== undefined ? { recurrence: input.recurrence } : {}),
        },
        systemTimeZone(),
      );
      await backend.update({ url: obj.url, ...(obj.etag ? { etag: obj.etag } : {}), data });
      return ok({ updated: { id: obj.url, uid: eventUidOf(data) }, message: "Event updated." });
    }

    case "delete_event": {
      if (!input.event_id) return fail<CalendarOutput>("event_id is required (from list_events).");
      const cals = await backend.listCalendars();
      const { obj } = await findObject(backend, cals, input.event_id, "VEVENT");
      await backend.remove(obj);
      return ok({ deleted: true, message: "Event deleted." });
    }

    case "list_reminders": {
      const cals = selectCalendars(await backend.listCalendars(), input.calendar, "VTODO");
      if (!cals.length) return ok({ reminders: [], message: "This account has no reminder lists." });
      const all: ReminderView[] = [];
      for (const cal of cals) {
        const objects = await backend.fetchObjects(cal, { kind: "VTODO", pendingOnly: !input.include_completed });
        for (const o of objects) all.push(...parseReminders(o.data, { id: o.url, list: oneLine(cal.name, 60), tz }));
      }
      const wanted = input.include_completed ? all : all.filter((r) => !r.completed);
      wanted.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
      const truncated = wanted.length > limit;
      const reminders = wanted.slice(0, limit);
      return ok({
        reminders,
        ...(truncated ? { truncated } : {}),
        message: reminders.length ? reminders.map((r) => `${r.completed ? "[x]" : "[ ]"} ${r.title}${r.due ? ` (due ${r.due})` : ""} [${r.list}]`).join("\n") : "No open reminders.",
      });
    }

    case "create_reminder": {
      if (!input.title?.trim()) return fail<CalendarOutput>("create_reminder needs a title.");
      const cals = await backend.listCalendars();
      const list = pickCalendar(cals, input.calendar, "VTODO", /^(reminders?|tasks?|to ?dos?)/i);
      const built = buildTodoIcs({
        title: input.title,
        ...(input.due ? { due: input.due } : {}),
        timezone: tz,
        ...(input.description ? { notes: input.description } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
      });
      const made = await backend.create(list, `${slug()}.ics`, built.ics);
      return ok({ created: { id: made.url, uid: built.uid, calendar: list.name }, message: `Reminder added to ${list.name}: ${oneLine(input.title, 120)}${input.due ? ` (due ${input.due})` : ""}.` });
    }

    case "complete_reminder": {
      if (!input.reminder_id) return fail<CalendarOutput>("reminder_id is required (from list_reminders).");
      const cals = await backend.listCalendars();
      const { obj } = await findObject(backend, cals, input.reminder_id, "VTODO");
      await backend.update({ url: obj.url, ...(obj.etag ? { etag: obj.etag } : {}), data: completeTodoIcs(obj.data) });
      return ok({ updated: { id: obj.url }, message: "Reminder completed." });
    }

    default:
      return fail<CalendarOutput>("Unknown action.");
  }
}

// ─── Contacts ────────────────────────────────────────────────────────────────

const CONTACT_ACTIONS = ["list_books", "search", "get", "create", "update", "delete"] as const;

const contactsSchema = z.object({
  action: z.enum(CONTACT_ACTIONS).describe(
    "list_books: the address books. search: find contacts by name, email, phone or company. get: one contact in full. " +
    "create / update: add or change a contact (asks the owner). delete: remove a contact (asks the owner).",
  ),
  account: z.enum(ACCOUNTS).optional().describe("Which connection to use when more than one is set up (default: iCloud, then a generic CardDAV server)."),
  book: z.string().optional().describe("Address book name (or URL) from list_books; default: the main one."),
  query: z.string().optional().describe("search: text to find in a name, email, phone number or company."),
  contact_id: z.string().optional().describe("Contact id from search (or its UID) for get/update/delete."),
  name: z.string().optional().describe("Full name (create needs it; update renames)."),
  email: z.string().optional().describe("Email address (update replaces the stored email)."),
  phone: z.string().optional().describe("Phone number (update replaces the stored number)."),
  org: z.string().optional().describe("Company."),
  job_title: z.string().optional().describe("Job title."),
  address: z.string().optional().describe("Postal address on one line."),
  birthday: z.string().optional().describe("YYYY-MM-DD."),
  url: z.string().optional().describe("Website."),
  note: z.string().optional().describe("Free-text note."),
  max_results: z.number().int().min(1).max(DAV_LIMITS.maxContacts).optional().describe("search: cap on rows (default 10, max 50)."),
});

type ContactsInput = z.infer<typeof contactsSchema>;

export interface ContactsOutput {
  books?: Array<{ name: string; url: string }>;
  contacts?: ContactView[];
  contact?: ContactView;
  created?: { id: string; uid: string; book: string };
  updated?: { id: string };
  deleted?: boolean;
  truncated?: boolean;
  message: string;
}

async function contactsSetup(input: { account?: AccountId }): Promise<{ account: DavAccount; backend: ContactsBackend } | { error: string }> {
  const account = await loadDavAccount("carddav", input.account);
  if (!account) return { error: NOT_CONNECTED("icloud (or carddav)") };
  return { account, backend: contactsBackendFor(account) };
}

function pickBook(books: BookInfo[], ref: string | undefined): BookInfo {
  if (!books.length) throw new DavError("not-found", "This account has no address books.");
  if (ref) {
    const want = ref.trim().toLowerCase();
    const exact = books.filter((b) => b.url === ref.trim() || b.name.toLowerCase() === want);
    if (exact.length === 1) return exact[0]!;
    const partial = books.filter((b) => b.name.toLowerCase().includes(want));
    if (partial.length === 1) return partial[0]!;
    throw new DavError("not-found", `No single address book matches "${clip(ref, 60)}". Available: ${books.map((b) => b.name).join(", ")}.`);
  }
  return books.find((b) => /^(card|contacts?|address ?book|default|personal|all)/i.test(b.name)) ?? books[0]!;
}

async function findCard(backend: ContactsBackend, books: BookInfo[], idOrUid: string): Promise<{ obj: DavObject; book: BookInfo }> {
  const id = idOrUid.trim();
  if (/^https?:\/\//i.test(id) || id.startsWith("/")) {
    for (const book of books) {
      const url = new URL(id, book.url).href;
      if (!inside(book.url, url)) continue;
      const obj = await backend.getObject(url);
      if (!obj) throw new DavError("not-found", "That contact no longer exists. Search again to get a fresh id.");
      return { obj, book };
    }
    throw new DavError("not-found", "That id does not belong to one of this account's address books. Use an id from a search.");
  }
  for (const book of books) {
    const found = await backend.fetchCards(book, { uid: id });
    const hit = found.find((o) => parseVcard(o.data, { id: o.url, book: book.name })?.uid === id);
    if (hit) return { obj: hit, book };
  }
  throw new DavError("not-found", "No contact with that id was found. Search again to get a fresh id.");
}

function contactMatches(c: ContactView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const digits = needle.replace(/\D/g, "");
  const hay = [c.name, c.org, c.title, ...(c.emails ?? []).map((e) => e.value), c.note].filter(Boolean).join(" ").toLowerCase();
  if (hay.includes(needle)) return true;
  if (digits.length >= 3) return (c.phones ?? []).some((p) => p.value.replace(/\D/g, "").includes(digits));
  return false;
}

function contactLine(c: ContactView): string {
  return [c.name, c.org, c.emails?.[0]?.value, c.phones?.[0]?.value].filter(Boolean).join(" · ");
}

function contactFields(input: ContactsInput): Record<string, string> {
  const fields: Record<string, string> = {};
  const map: Array<[string, string | undefined]> = [["name", input.name], ["email", input.email], ["phone", input.phone], ["org", input.org], ["title", input.job_title], ["address", input.address], ["birthday", input.birthday], ["url", input.url], ["note", input.note]];
  for (const [key, value] of map) if (value !== undefined) fields[key] = value;
  return fields;
}

function contactPrompt(verb: string, input: ContactsInput, current?: ContactView): string {
  const fields = contactFields(input);
  const shown = Object.entries(fields).map(([k, v]) => `${k}: ${oneLine(v, 100) || "(cleared)"}`).join("; ");
  return `${verb} ${current ? `contact "${oneLine(current.name, 80)}"` : "a contact"}${shown ? ` (${shown})` : ""}`;
}

async function peekContact(input: ContactsInput): Promise<ContactView | undefined> {
  if (!input.contact_id) return undefined;
  try {
    const setup = await contactsSetup(input);
    if ("error" in setup) return undefined;
    const books = await setup.backend.listBooks();
    const { obj, book } = await findCard(setup.backend, books, input.contact_id);
    return parseVcard(obj.data, { id: obj.url, book: book.name }) ?? undefined;
  } catch {
    return undefined;
  }
}

export const ContactsTool = buildTool<typeof contactsSchema, ContactsOutput>({
  name: "Contacts",
  description:
    "The owner's contacts over CardDAV: iCloud Contacts (iPhone address book, works with the phone off), Fastmail, Nextcloud, Radicale or any CardDAV server. " +
    "Search by name, email, phone or company; read one contact; create, update or delete (asks the owner first). " +
    "Not connected → Connect service \"icloud\" (or \"carddav\"). Use GoogleContacts instead when the owner connected Google.",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "delete" ? "external-state" : input.action === "create" || input.action === "update" ? "workspace-write" : "read-only"),
  concurrency: "parallel-safe",
  inputZod: contactsSchema,
  ownerDecisions: true,
  watchdogTimeoutMs: 120_000,
  async checkPermissions(input) {
    if (input.action === "create") return { kind: "ask", prompt: contactPrompt("Create", input), suggestion: "allow_once" };
    if (input.action === "update") return { kind: "ask", prompt: contactPrompt("Change", input, await peekContact(input)), suggestion: "allow_once" };
    if (input.action === "delete") {
      const current = await peekContact(input);
      return { kind: "ask", prompt: `Delete contact ${current ? `"${oneLine(current.name, 80)}"` : (input.contact_id ?? "?")}. This cannot be undone.`, suggestion: "deny", ownerDecision: true };
    }
    return { kind: "allow" };
  },
  activityDescription: (input) => {
    switch (input.action) {
      case "list_books": return "Listing address books";
      case "search": return `Searching contacts: ${input.query ?? ""}`;
      case "get": return "Reading a contact";
      case "create": return `Creating contact: ${input.name ?? ""}`;
      case "update": return "Updating a contact";
      case "delete": return "Deleting a contact";
      default: return "Contacts";
    }
  },
  async call(input: ContactsInput): Promise<ToolResult<ContactsOutput>> {
    const setup = await contactsSetup(input);
    if ("error" in setup) return fail<ContactsOutput>(setup.error);
    try {
      return await runContacts(input, setup.backend);
    } catch (err) {
      return fail<ContactsOutput>(safeMessage(err, setup.account));
    }
  },
});

export async function runContacts(input: ContactsInput, backend: ContactsBackend): Promise<ToolResult<ContactsOutput>> {
  switch (input.action) {
    case "list_books": {
      const books = (await backend.listBooks()).map((b) => ({ name: oneLine(b.name, 80), url: b.url }));
      return ok({ books, message: books.length ? books.map((b) => b.name).join("\n") : "No address books on this account." });
    }

    case "search": {
      if (!input.query?.trim()) return fail<ContactsOutput>("search needs a query (a name, email, phone number or company).");
      const limit = Math.min(input.max_results ?? 10, DAV_LIMITS.maxContacts);
      const allBooks = await backend.listBooks();
      const books = input.book ? [pickBook(allBooks, input.book)] : allBooks;
      const found: ContactView[] = [];
      for (const book of books) {
        for (const o of await backend.fetchCards(book, { query: input.query.trim() })) {
          const view = parseVcard(o.data, { id: o.url, book: oneLine(book.name, 60) });
          if (view && contactMatches(view, input.query)) found.push(view);
        }
      }
      found.sort((a, b) => a.name.localeCompare(b.name));
      const truncated = found.length > limit;
      const contacts = found.slice(0, limit);
      return ok({ contacts, ...(truncated ? { truncated } : {}), message: contacts.length ? contacts.map(contactLine).join("\n") : `No contacts match "${clip(input.query, 60)}".` });
    }

    case "get": {
      if (!input.contact_id) return fail<ContactsOutput>("contact_id is required (from search).");
      const { obj, book } = await findCard(backend, await backend.listBooks(), input.contact_id);
      const contact = parseVcard(obj.data, { id: obj.url, book: oneLine(book.name, 60) });
      if (!contact) return fail<ContactsOutput>("That item could not be read as a contact.");
      return ok({ contact, message: contactLine(contact) });
    }

    case "create": {
      if (!input.name?.trim()) return fail<ContactsOutput>("create needs a name.");
      const book = pickBook(await backend.listBooks(), input.book);
      const built = buildVcard({ name: input.name, ...(input.email ? { email: input.email } : {}), ...(input.phone ? { phone: input.phone } : {}), ...(input.org ? { org: input.org } : {}), ...(input.job_title ? { title: input.job_title } : {}), ...(input.address ? { address: input.address } : {}), ...(input.birthday ? { birthday: input.birthday } : {}), ...(input.url ? { url: input.url } : {}), ...(input.note ? { note: input.note } : {}) });
      const made = await backend.create(book, `${slug()}.vcf`, built.vcf);
      return ok({ created: { id: made.url, uid: built.uid, book: book.name }, message: `Created contact ${oneLine(input.name, 100)} in ${book.name}.` });
    }

    case "update": {
      if (!input.contact_id) return fail<ContactsOutput>("contact_id is required (from search).");
      const fields = contactFields(input);
      if (!Object.keys(fields).length) return fail<ContactsOutput>("Nothing to change: give at least one field (name, email, phone, org, job_title, address, birthday, url, note).");
      const { obj } = await findCard(backend, await backend.listBooks(), input.contact_id);
      const data = patchVcard(obj.data, { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.email !== undefined ? { email: input.email } : {}), ...(input.phone !== undefined ? { phone: input.phone } : {}), ...(input.org !== undefined ? { org: input.org } : {}), ...(input.job_title !== undefined ? { title: input.job_title } : {}), ...(input.address !== undefined ? { address: input.address } : {}), ...(input.birthday !== undefined ? { birthday: input.birthday } : {}), ...(input.url !== undefined ? { url: input.url } : {}), ...(input.note !== undefined ? { note: input.note } : {}) });
      await backend.update({ url: obj.url, ...(obj.etag ? { etag: obj.etag } : {}), data });
      return ok({ updated: { id: obj.url }, message: "Contact updated." });
    }

    case "delete": {
      if (!input.contact_id) return fail<ContactsOutput>("contact_id is required (from search).");
      const { obj } = await findCard(backend, await backend.listBooks(), input.contact_id);
      await backend.remove(obj);
      return ok({ deleted: true, message: "Contact deleted." });
    }

    default:
      return fail<ContactsOutput>("Unknown action.");
  }
}
