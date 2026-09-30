// iCalendar (RFC 5545) and vCard (RFC 6350 / 2426) handling for the Calendar
// and Contacts tools: parse, expand recurrences, build, patch.
//
// Library: ical.js (Mozilla Calendar's parser, MPL-2.0). It owns the RRULE
// engine, so recurrence expansion (EXDATE, RDATE, RECURRENCE-ID overrides,
// COUNT/UNTIL, BYDAY/BYSETPOS…) is the one the Thunderbird calendar uses.
// What ical.js does NOT have is a timezone database. A server that sends
// TZID=America/New_York without a VTIMEZONE (Google does it) would otherwise
// expand as "floating" time; here every such TZID is backed by a VTIMEZONE
// generated from the platform's Intl data, and events we WRITE in a named
// zone carry one too, so a recurring 9 am stays 9 am across daylight saving.

import ICAL from "ical.js";
import { DAV_LIMITS, clip, oneLine } from "./davCommon.js";

// ─── time zones ──────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  const fromEnv = process.env.ARES_OWNER_TIMEZONE?.trim();
  if (isValidTimeZone(fromEnv)) return fromEnv;
  const sys = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(sys) ? sys : "UTC";
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", hour12: false });
    formatters.set(tz, f);
  }
  return f;
}

/** UTC offset of `tz` at instant `ms`, in minutes east of UTC. */
export function offsetMinutes(tz: string, ms: number): number {
  const name = formatter(tz).formatToParts(ms).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT(?:([+\-\u2212])(\d{1,2})(?::?(\d{2}))?)?/.exec(name);
  if (!m || !m[1]) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant (ms since epoch) whose wall clock in `tz` reads as given. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive - offsetMinutes(tz, naive) * 60_000;
  guess = naive - offsetMinutes(tz, guess) * 60_000;
  return guess;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

/** ISO-8601 with the zone's own offset: 2026-11-01T09:00:00-05:00. */
export function toOffsetIso(ms: number, tz: string): string {
  const off = offsetMinutes(tz, ms);
  const t = new Date(ms + off * 60_000);
  const offText = off === 0 ? "Z" : `${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}${offText}`;
}

function wallText(ms: number, offMin: number): string {
  const t = new Date(ms + offMin * 60_000);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}`;
}

const zoneCache = new Map<string, ICAL.Component>();

/** A VTIMEZONE for an IANA zone, built from Intl over roughly 12 years back
 *  and 15 forward (older/newer instants use the nearest known offset). */
export function buildVtimezone(tz: string): ICAL.Component {
  const cached = zoneCache.get(tz);
  if (cached) return new ICAL.Component(cached.toJSON());
  const nowYear = new Date().getUTCFullYear();
  const startMs = Date.UTC(nowYear - 12, 0, 1);
  const endMs = Date.UTC(nowYear + 15, 0, 1);
  const DAY = 86_400_000;
  const lines: string[] = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  let prevOffset = offsetMinutes(tz, startMs);
  const base = fmtOffset(prevOffset);
  lines.push("BEGIN:STANDARD", "DTSTART:19000101T000000", `TZOFFSETFROM:${base}`, `TZOFFSETTO:${base}`, "END:STANDARD");
  let lastDayOffset = prevOffset;
  for (let t = startMs; t < endMs; t += DAY) {
    const next = offsetMinutes(tz, t + DAY);
    if (next === lastDayOffset) continue;
    // Bisect the day for the transition instant (minute precision).
    let lo = t;
    let hi = t + DAY;
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetMinutes(tz, mid) === lastDayOffset) lo = mid;
      else hi = mid;
    }
    const after = offsetMinutes(tz, hi);
    const kind = after > lastDayOffset ? "DAYLIGHT" : "STANDARD";
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${wallText(hi, lastDayOffset)}`,
      `TZOFFSETFROM:${fmtOffset(lastDayOffset)}`,
      `TZOFFSETTO:${fmtOffset(after)}`,
      `END:${kind}`,
    );
    lastDayOffset = after;
  }
  lines.push("END:VTIMEZONE");
  const comp = new ICAL.Component(ICAL.parse(lines.join("\r\n")));
  zoneCache.set(tz, comp);
  return new ICAL.Component(comp.toJSON());
}

/** Make every TZID in `root` resolvable: register its own VTIMEZONEs, and
 *  synthesise a registered one for any IANA zone that has none. */
function registerZones(root: ICAL.Component): void {
  const defined = new Set<string>();
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    const tzid = String(vtz.getFirstPropertyValue("tzid") ?? "");
    if (!tzid) continue;
    defined.add(tzid);
    try {
      ICAL.TimezoneService.register(vtz);
    } catch {
      // a malformed VTIMEZONE: fall through to the generated one below
      defined.delete(tzid);
    }
  }
  const used = new Set<string>();
  const scan = (c: ICAL.Component): void => {
    for (const prop of c.getAllProperties()) {
      const tzid = prop.getParameter("tzid");
      if (typeof tzid === "string") used.add(tzid.replace(/^\/?[^/]*\/(?=[A-Za-z_]+\/[A-Za-z_]+$)/, ""));
    }
    for (const sub of c.getAllSubcomponents()) if (sub.name !== "vtimezone") scan(sub);
  };
  scan(root);
  for (const tzid of used) {
    if (defined.has(tzid) || ICAL.TimezoneService.has(tzid)) continue;
    if (isValidTimeZone(tzid)) ICAL.TimezoneService.register(buildVtimezone(tzid));
  }
}

// ─── text helpers ────────────────────────────────────────────────────────────

/** RFC 5545 TEXT escaping. */
export function escText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function crlf(lines: string[]): string {
  return lines.join("\r\n");
}

export function newUid(): string {
  return `${crypto.randomUUID()}@ares`;
}

/** 20260930T215303Z */
function dtstampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// ─── input times ─────────────────────────────────────────────────────────────

export interface ParsedWhen {
  allDay: boolean;
  /** Wall clock components (date only for all-day). */
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** Named zone to write; undefined = UTC. */
  tz?: string;
  /** The instant (all-day: local midnight in `tz ?? system`). */
  ms: number;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** Parse "2026-11-01" (all-day) or "2026-11-01T09:00[:00][Z|+01:00]".
 *  A wall-clock time with no offset is read in `defaultTz`; an instant with an
 *  offset/Z is written in `defaultTz` when that is a real zone, else in UTC. */
export function parseWhen(text: string, defaultTz?: string): ParsedWhen {
  const value = text.trim();
  const tz = isValidTimeZone(defaultTz) ? defaultTz : undefined;
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const [y, mo, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    assertDate(y, mo, d, 0, 0, 0, text);
    return { allDay: true, y, mo, d, h: 0, mi: 0, s: 0, ms: zonedToUtc(y, mo, d, 0, 0, 0, tz ?? systemTimeZone()) };
  }
  const m = DATE_TIME.exec(value);
  if (!m) throw new Error(`"${clip(text, 40)}" is not a date. Use YYYY-MM-DD (all day) or YYYY-MM-DDTHH:MM (optionally with Z or an offset like -05:00).`);
  const [y, mo, d, h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  assertDate(y, mo, d, h, mi, s, text);
  const zoneText = m[7];
  if (zoneText) {
    const off = zoneText.toUpperCase() === "Z" ? 0 : (zoneText.startsWith("-") ? -1 : 1) * (Number(zoneText.replace(/[^\d]/g, "").slice(0, 2)) * 60 + Number(zoneText.replace(/[^\d]/g, "").slice(2, 4)));
    const ms = Date.UTC(y, mo - 1, d, h, mi, s) - off * 60_000;
    if (tz) {
      const w = new Date(ms + offsetMinutes(tz, ms) * 60_000);
      return { allDay: false, y: w.getUTCFullYear(), mo: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), s: w.getUTCSeconds(), tz, ms };
    }
    const w = new Date(ms);
    return { allDay: false, y: w.getUTCFullYear(), mo: w.getUTCMonth() + 1, d: w.getUTCDate(), h: w.getUTCHours(), mi: w.getUTCMinutes(), s: w.getUTCSeconds(), ms };
  }
  const zone = tz ?? systemTimeZone();
  return { allDay: false, y, mo, d, h, mi, s, tz: zone === "UTC" ? undefined : zone, ms: zonedToUtc(y, mo, d, h, mi, s, zone) };
}

function assertDate(y: number, mo: number, d: number, h: number, mi: number, s: number, original: string): void {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new Error(`"${clip(original, 40)}" is not a real date/time.`);
  }
}

function dtLine(name: "DTSTART" | "DTEND" | "DUE", when: ParsedWhen): string {
  if (when.allDay) return `${name};VALUE=DATE:${when.y}${pad(when.mo)}${pad(when.d)}`;
  const wall = `${when.y}${pad(when.mo, 2)}${pad(when.d)}T${pad(when.h)}${pad(when.mi)}${pad(when.s)}`;
  return when.tz ? `${name};TZID=${when.tz}:${wall}` : `${name}:${wall}Z`;
}

/** Wall-clock `when` moved by `deltaMs` of real time, staying in its zone. */
function shiftWhen(when: ParsedWhen, deltaMs: number): ParsedWhen {
  if (when.allDay) {
    const t = new Date(Date.UTC(when.y, when.mo - 1, when.d) + deltaMs);
    return { ...when, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), ms: when.ms + deltaMs };
  }
  const ms = when.ms + deltaMs;
  const zone = when.tz;
  const off = zone ? offsetMinutes(zone, ms) : 0;
  const t = new Date(ms + off * 60_000);
  return { allDay: false, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds(), ...(zone ? { tz: zone } : {}), ms };
}

// ─── events: model ───────────────────────────────────────────────────────────

export interface CalendarEventView {
  /** Opaque id to pass back (the calendar object's URL). */
  id: string;
  uid: string;
  calendar: string;
  title: string;
  /** ISO-8601 with offset, or YYYY-MM-DD for all-day. */
  start: string;
  end: string;
  allDay: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  recurring: boolean;
  /** Recurrence instance this row is (ISO), when recurring. */
  instance?: string;
  status?: string;
  attendees?: number;
  organizer?: string;
}

export interface ExpandMeta {
  id: string;
  calendar: string;
  /** Owner's zone: all-day events sit at local midnight in it. */
  tz: string;
}

function timeToMs(t: ICAL.Time, ownerTz: string): { ms: number; tz?: string } {
  if (t.isDate) return { ms: zonedToUtc(t.year, t.month, t.day, 0, 0, 0, ownerTz) };
  const tzid = t.zone && t.zone !== ICAL.Timezone.localTimezone && t.zone !== ICAL.Timezone.utcTimezone ? t.zone.tzid : undefined;
  if (t.zone === ICAL.Timezone.localTimezone || (t.zone as ICAL.Timezone).tzid === "floating") {
    // Floating time: the wall clock in the owner's zone.
    return { ms: zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, ownerTz), tz: ownerTz };
  }
  return { ms: t.toUnixTime() * 1000, ...(tzid ? { tz: tzid } : {}) };
}

function viewOf(item: ICAL.Event, startT: ICAL.Time, endT: ICAL.Time, meta: ExpandMeta, recurring: boolean, instance?: ICAL.Time): CalendarEventView | null {
  const allDay = startT.isDate;
  const s = timeToMs(startT, meta.tz);
  const e = timeToMs(endT, meta.tz);
  const zone = s.tz && isValidTimeZone(s.tz) ? s.tz : undefined;
  const status = String(item.component.getFirstPropertyValue("status") ?? "").toUpperCase();
  const organizer = String(item.component.getFirstPropertyValue("organizer") ?? "").replace(/^mailto:/i, "");
  const out: CalendarEventView = {
    id: meta.id,
    uid: String(item.uid ?? ""),
    calendar: meta.calendar,
    title: oneLine(item.summary || "(no title)", 200),
    start: allDay ? `${startT.year}-${pad(startT.month)}-${pad(startT.day)}` : toOffsetIso(s.ms, zone ?? "UTC"),
    end: allDay ? isoDateMinusDay(endT) : toOffsetIso(e.ms, (e.tz && isValidTimeZone(e.tz) ? e.tz : zone) ?? "UTC"),
    allDay,
    ...(zone ? { timezone: zone } : {}),
    recurring,
  };
  const location = oneLine(item.location ?? "", 200);
  if (location) out.location = location;
  const description = clip(String(item.description ?? "").trim(), DAV_LIMITS.maxNoteChars);
  if (description) out.description = description;
  if (instance) out.instance = instance.isDate ? `${instance.year}-${pad(instance.month)}-${pad(instance.day)}` : toOffsetIso(timeToMs(instance, meta.tz).ms, zone ?? "UTC");
  if (status) out.status = status;
  const attendees = item.component.getAllProperties("attendee").length;
  if (attendees) out.attendees = attendees;
  if (organizer) out.organizer = oneLine(organizer, 120);
  return out;
}

/** DTEND of an all-day event is exclusive; show the last day. */
function isoDateMinusDay(t: ICAL.Time): string {
  const c = t.clone();
  c.adjust(-1, 0, 0, 0);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

function eventEnd(ev: ICAL.Event, start: ICAL.Time): ICAL.Time {
  try {
    const end = ev.endDate;
    if (end) return end;
  } catch {
    // no DTEND / DURATION: fall through
  }
  const e = start.clone();
  if (start.isDate) e.adjust(1, 0, 0, 0);
  return e;
}

/**
 * Every instance of every event in `data` that overlaps [range.start,
 * range.end), recurrences expanded (RRULE/RDATE/EXDATE, detached overrides,
 * cancellations honoured), sorted by start. Never throws on a bad object:
 * returns what it could read and a note.
 */
export function expandEvents(data: string, range: { start: Date; end: Date }, meta: ExpandMeta): { events: CalendarEventView[]; note?: string } {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(data));
  } catch {
    return { events: [], note: "one calendar object could not be parsed and was skipped" };
  }
  registerZones(root);
  const vevents = root.getAllSubcomponents("vevent");
  const byUid = new Map<string, ICAL.Component[]>();
  for (const v of vevents) {
    const uid = String(v.getFirstPropertyValue("uid") ?? "");
    byUid.set(uid, [...(byUid.get(uid) ?? []), v]);
  }
  const out: Array<{ view: CalendarEventView; ms: number }> = [];
  let note: string | undefined;
  const rs = range.start.getTime();
  const re = range.end.getTime();
  const overlaps = (s: number, e: number): boolean => s < re && (e > rs || (e === s && s >= rs));

  for (const group of byUid.values()) {
    const master = group.find((v) => !v.hasProperty("recurrence-id"));
    const overrides = group.filter((v) => v !== master);
    try {
      if (!master) {
        for (const v of overrides) {
          const ev = new ICAL.Event(v);
          const end = eventEnd(ev, ev.startDate);
          const { ms } = timeToMs(ev.startDate, meta.tz);
          if (String(v.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
          if (overlaps(ms, timeToMs(end, meta.tz).ms)) out.push({ view: viewOf(ev, ev.startDate, end, meta, true, ev.recurrenceId)!, ms });
        }
        continue;
      }
      const ev = new ICAL.Event(master);
      for (const o of overrides) ev.relateException(new ICAL.Event(o));
      if (!ev.isRecurring()) {
        if (String(master.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
        const end = eventEnd(ev, ev.startDate);
        const { ms } = timeToMs(ev.startDate, meta.tz);
        if (overlaps(ms, timeToMs(end, meta.tz).ms)) out.push({ view: viewOf(ev, ev.startDate, end, meta, false)!, ms });
        continue;
      }
      const it = ev.iterator();
      let steps = 0;
      for (let next = it.next(); next; next = it.next()) {
        if (++steps > DAV_LIMITS.maxOccurrences) {
          note = `a recurring event ("${oneLine(ev.summary, 40)}") has more than ${DAV_LIMITS.maxOccurrences} occurrences before the range; later ones were not expanded`;
          break;
        }
        const details = ev.getOccurrenceDetails(next);
        const startMs = timeToMs(details.startDate, meta.tz).ms;
        if (startMs >= re) break;
        const item = details.item;
        if (String(item.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
        const endMs = timeToMs(details.endDate, meta.tz).ms;
        if (!overlaps(startMs, endMs)) continue;
        out.push({ view: viewOf(item, details.startDate, details.endDate, meta, true, details.recurrenceId)!, ms: startMs });
        if (out.length > DAV_LIMITS.maxEvents * 5) break;
      }
    } catch {
      note = "some events could not be read and were skipped";
    }
  }
  out.sort((a, b) => a.ms - b.ms);
  return { events: out.map((o) => o.view), ...(note ? { note } : {}) };
}

// ─── events: build and patch ─────────────────────────────────────────────────

export interface EventInput {
  title: string;
  start: string;
  end?: string;
  timezone?: string;
  location?: string;
  description?: string;
  /** RRULE body, e.g. FREQ=WEEKLY;BYDAY=MO;COUNT=8 */
  recurrence?: string;
  alarmMinutesBefore?: number;
}

export function normalizeRrule(text: string): string {
  const body = text.trim().replace(/^RRULE:/i, "").trim();
  if (!/^FREQ=/i.test(body)) throw new Error('A recurrence must start with FREQ=, for example "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10".');
  try {
    ICAL.Recur.fromString(body);
  } catch (err) {
    throw new Error(`Invalid recurrence rule: ${err instanceof Error ? clip(err.message, 120) : "unparseable"}`);
  }
  return body.toUpperCase();
}

function resolveRange(input: { start: string; end?: string; timezone?: string }): { start: ParsedWhen; end: ParsedWhen } {
  const tz = isValidTimeZone(input.timezone) ? input.timezone : input.timezone ? (() => { throw new Error(`"${clip(input.timezone, 40)}" is not a known IANA time zone (for example America/New_York).`); })() : undefined;
  const start = parseWhen(input.start, tz);
  let end: ParsedWhen;
  if (input.end) {
    end = parseWhen(input.end, start.tz ?? tz);
    if (start.allDay !== end.allDay) throw new Error("start and end must both be dates (all-day) or both be date-times.");
    if (start.allDay) end = shiftWhen(end, 86_400_000); // the tool's end is the last day, inclusive
  } else {
    end = shiftWhen(start, start.allDay ? 86_400_000 : 3_600_000);
  }
  if (end.ms < start.ms) throw new Error("The end is before the start.");
  return { start, end };
}

function alarmLines(title: string, minutes: number): string[] {
  const m = Math.max(0, Math.min(Math.round(minutes), 60 * 24 * 28));
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escText(title)}`, `TRIGGER:-PT${m}M`, "END:VALARM"];
}

function withZone(root: ICAL.Component, tz: string | undefined): void {
  if (!tz || !isValidTimeZone(tz)) return;
  const have = root.getAllSubcomponents("vtimezone").some((v) => String(v.getFirstPropertyValue("tzid")) === tz);
  if (!have) root.addSubcomponent(buildVtimezone(tz));
}

export function buildEventIcs(input: EventInput, uid: string = newUid()): { uid: string; ics: string } {
  const title = oneLine(input.title, 200);
  if (!title) throw new Error("An event needs a title.");
  const { start, end } = resolveRange(input);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ares//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstampNow()}`,
    dtLine("DTSTART", start),
    dtLine("DTEND", end),
    `SUMMARY:${escText(title)}`,
  ];
  if (input.location?.trim()) lines.push(`LOCATION:${escText(oneLine(input.location, 300))}`);
  if (input.description?.trim()) lines.push(`DESCRIPTION:${escText(clip(input.description.trim(), 8000))}`);
  if (input.recurrence?.trim()) lines.push(`RRULE:${normalizeRrule(input.recurrence)}`);
  if (input.alarmMinutesBefore !== undefined) lines.push(...alarmLines(title, input.alarmMinutesBefore));
  lines.push("END:VEVENT", "END:VCALENDAR");
  const root = new ICAL.Component(ICAL.parse(crlf(lines)));
  withZone(root, start.tz);
  return { uid, ics: root.toString() };
}

export interface EventPatch {
  title?: string;
  start?: string;
  end?: string;
  timezone?: string;
  location?: string;
  description?: string;
  /** "none" removes the rule. */
  recurrence?: string;
}

/** Patch the series (master event) in `ics`; overrides and every property not
 *  named are left exactly as the server gave them. */
export function patchEventIcs(ics: string, patch: EventPatch, ownerTz: string): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerZones(root);
  const master = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id"));
  if (!master) throw new Error("That calendar object has no main event to change.");
  if (patch.title !== undefined) {
    const t = oneLine(patch.title, 200);
    if (!t) throw new Error("The title can't be empty.");
    master.updatePropertyWithValue("summary", t);
  }
  if (patch.location !== undefined) {
    if (patch.location.trim()) master.updatePropertyWithValue("location", oneLine(patch.location, 300));
    else master.removeProperty("location");
  }
  if (patch.description !== undefined) {
    if (patch.description.trim()) master.updatePropertyWithValue("description", clip(patch.description.trim(), 8000));
    else master.removeProperty("description");
  }
  if (patch.recurrence !== undefined) {
    master.removeProperty("rrule");
    if (patch.recurrence.trim() && patch.recurrence.trim().toLowerCase() !== "none") {
      master.addProperty(ICAL.Property.fromString(`RRULE:${normalizeRrule(patch.recurrence)}`));
    }
  }
  if (patch.start !== undefined || patch.end !== undefined || patch.timezone !== undefined) {
    const ev = new ICAL.Event(master);
    const curStart = ev.startDate;
    const curEnd = eventEnd(ev, curStart);
    const curZone = !curStart.isDate && curStart.zone && curStart.zone !== ICAL.Timezone.utcTimezone && curStart.zone !== ICAL.Timezone.localTimezone ? curStart.zone.tzid : undefined;
    const tz = patch.timezone ?? (isValidTimeZone(curZone) ? curZone : undefined);
    const durationMs = timeToMs(curEnd, ownerTz).ms - timeToMs(curStart, ownerTz).ms;
    const curStartText = curStart.isDate ? `${curStart.year}-${pad(curStart.month)}-${pad(curStart.day)}` : `${curStart.year}-${pad(curStart.month)}-${pad(curStart.day)}T${pad(curStart.hour)}:${pad(curStart.minute)}:${pad(curStart.second)}${curStart.zone === ICAL.Timezone.utcTimezone ? "Z" : ""}`;
    const start = parseWhen(patch.start ?? curStartText, tz ?? (curStart.zone === ICAL.Timezone.utcTimezone ? undefined : ownerTz));
    let end: ParsedWhen;
    if (patch.end !== undefined) {
      end = parseWhen(patch.end, start.tz ?? tz);
      if (start.allDay !== end.allDay) throw new Error("start and end must both be dates (all-day) or both be date-times.");
      if (start.allDay) end = shiftWhen(end, 86_400_000);
    } else {
      end = shiftWhen(start, durationMs > 0 ? durationMs : start.allDay ? 86_400_000 : 3_600_000);
    }
    if (end.ms < start.ms) throw new Error("The end is before the start.");
    master.removeProperty("dtstart");
    master.removeProperty("dtend");
    master.removeProperty("duration");
    master.addProperty(ICAL.Property.fromString(dtLine("DTSTART", start)));
    master.addProperty(ICAL.Property.fromString(dtLine("DTEND", end)));
    withZone(root, start.tz);
  }
  const seq = Number(master.getFirstPropertyValue("sequence") ?? 0);
  master.updatePropertyWithValue("sequence", (Number.isFinite(seq) ? seq : 0) + 1);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  return root.toString();
}

export function eventUidOf(ics: string): string {
  try {
    const root = new ICAL.Component(ICAL.parse(ics));
    return String(root.getAllSubcomponents("vevent")[0]?.getFirstPropertyValue("uid") ?? "");
  } catch {
    return "";
  }
}

// ─── reminders (VTODO) ───────────────────────────────────────────────────────

export interface ReminderView {
  id: string;
  uid: string;
  list: string;
  title: string;
  due?: string;
  completed: boolean;
  completedAt?: string;
  priority?: number;
  notes?: string;
}

export function parseReminders(data: string, meta: { id: string; list: string; tz: string }): ReminderView[] {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(data));
  } catch {
    return [];
  }
  registerZones(root);
  const out: ReminderView[] = [];
  for (const todo of root.getAllSubcomponents("vtodo")) {
    try {
      const status = String(todo.getFirstPropertyValue("status") ?? "").toUpperCase();
      const completedProp = todo.getFirstPropertyValue("completed") as ICAL.Time | null;
      const percent = Number(todo.getFirstPropertyValue("percent-complete") ?? 0);
      const completed = status === "COMPLETED" || Boolean(completedProp) || percent >= 100;
      const due = todo.getFirstPropertyValue("due") as ICAL.Time | null;
      const view: ReminderView = {
        id: meta.id,
        uid: String(todo.getFirstPropertyValue("uid") ?? ""),
        list: meta.list,
        title: oneLine(String(todo.getFirstPropertyValue("summary") ?? "(no title)"), 200),
        completed,
      };
      if (due) {
        const { ms, tz } = timeToMs(due, meta.tz);
        view.due = due.isDate ? `${due.year}-${pad(due.month)}-${pad(due.day)}` : toOffsetIso(ms, tz && isValidTimeZone(tz) ? tz : "UTC");
      }
      if (completedProp) view.completedAt = completedProp.toJSDate().toISOString();
      const priority = Number(todo.getFirstPropertyValue("priority") ?? 0);
      if (priority > 0) view.priority = priority;
      const notes = clip(String(todo.getFirstPropertyValue("description") ?? "").trim(), DAV_LIMITS.maxNoteChars);
      if (notes) view.notes = notes;
      out.push(view);
    } catch {
      // skip an unreadable todo
    }
  }
  return out;
}

export function buildTodoIcs(input: { title: string; due?: string; timezone?: string; notes?: string; priority?: number }, uid: string = newUid()): { uid: string; ics: string } {
  const title = oneLine(input.title, 200);
  if (!title) throw new Error("A reminder needs a title.");
  const tz = input.timezone !== undefined && !isValidTimeZone(input.timezone) ? (() => { throw new Error(`"${clip(input.timezone, 40)}" is not a known IANA time zone.`); })() : input.timezone;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ares//Reminders//EN",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `DTSTAMP:${dtstampNow()}`,
    `CREATED:${dtstampNow()}`,
    `SUMMARY:${escText(title)}`,
    "STATUS:NEEDS-ACTION",
  ];
  let zone: string | undefined;
  if (input.due) {
    const due = parseWhen(input.due, tz);
    lines.push(dtLine("DUE", due));
    zone = due.tz;
  }
  if (input.notes?.trim()) lines.push(`DESCRIPTION:${escText(clip(input.notes.trim(), 8000))}`);
  if (input.priority !== undefined) lines.push(`PRIORITY:${Math.max(0, Math.min(9, Math.round(input.priority)))}`);
  lines.push("END:VTODO", "END:VCALENDAR");
  const root = new ICAL.Component(ICAL.parse(crlf(lines)));
  withZone(root, zone);
  return { uid, ics: root.toString() };
}

export function completeTodoIcs(ics: string): string {
  const root = new ICAL.Component(ICAL.parse(ics));
  const todo = root.getAllSubcomponents("vtodo").find((v) => !v.hasProperty("recurrence-id")) ?? root.getAllSubcomponents("vtodo")[0];
  if (!todo) throw new Error("That object is not a reminder.");
  const now = ICAL.Time.fromJSDate(new Date(), true);
  todo.updatePropertyWithValue("status", "COMPLETED");
  todo.updatePropertyWithValue("completed", now);
  todo.updatePropertyWithValue("percent-complete", 100);
  todo.updatePropertyWithValue("dtstamp", now);
  const seq = Number(todo.getFirstPropertyValue("sequence") ?? 0);
  todo.updatePropertyWithValue("sequence", (Number.isFinite(seq) ? seq : 0) + 1);
  return root.toString();
}

// ─── vCards ──────────────────────────────────────────────────────────────────

export interface ContactView {
  id: string;
  uid: string;
  book: string;
  name: string;
  emails?: Array<{ value: string; type?: string }>;
  phones?: Array<{ value: string; type?: string }>;
  org?: string;
  title?: string;
  addresses?: string[];
  birthday?: string;
  url?: string;
  note?: string;
}

function typeOf(prop: ICAL.Property): string | undefined {
  const raw = prop.getParameter("type");
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((t) => String(t).toLowerCase()).filter((t) => t !== "internet" && t !== "pref");
  return list.length ? list.slice(0, 3).join(",") : undefined;
}

export function parseVcard(data: string, meta: { id: string; book: string }): ContactView | null {
  let card: ICAL.Component;
  try {
    const parsed = ICAL.parse(data);
    card = Array.isArray(parsed) && typeof parsed[0] === "string" ? new ICAL.Component(parsed as never) : new ICAL.Component((parsed as unknown[])[0] as never);
  } catch {
    return null;
  }
  if (card.name !== "vcard") return null;
  const str = (n: string): string => {
    const v = card.getFirstPropertyValue(n);
    return Array.isArray(v) ? v.join(" ") : String(v ?? "");
  };
  let name = oneLine(str("fn"), 200);
  if (!name) {
    const n = card.getFirstPropertyValue("n");
    if (Array.isArray(n)) name = oneLine([n[3], n[1], n[2], n[0]].flat().filter(Boolean).join(" "), 200);
  }
  const view: ContactView = { id: meta.id, uid: oneLine(str("uid"), 200), book: meta.book, name: name || "(no name)" };
  const emails = card.getAllProperties("email").map((p) => ({ value: oneLine(String(p.getFirstValue() ?? ""), 200), type: typeOf(p) })).filter((e) => e.value).slice(0, 10);
  if (emails.length) view.emails = emails.map((e) => (e.type ? e : { value: e.value }));
  const phones = card.getAllProperties("tel").map((p) => ({ value: oneLine(String(p.getFirstValue() ?? "").replace(/^tel:/i, ""), 60), type: typeOf(p) })).filter((e) => e.value).slice(0, 10);
  if (phones.length) view.phones = phones.map((e) => (e.type ? e : { value: e.value }));
  const org = card.getFirstPropertyValue("org");
  const orgText = oneLine(Array.isArray(org) ? org.flat().join(", ") : String(org ?? ""), 200);
  if (orgText) view.org = orgText;
  const title = oneLine(str("title"), 120);
  if (title) view.title = title;
  const addresses = card.getAllProperties("adr").map((p) => {
    const v = p.getFirstValue();
    return oneLine(Array.isArray(v) ? v.flat().filter(Boolean).join(", ") : String(v ?? ""), 250);
  }).filter(Boolean).slice(0, 5);
  if (addresses.length) view.addresses = addresses;
  const bday = oneLine(str("bday"), 30);
  if (bday) view.birthday = bday;
  const url = oneLine(str("url"), 200);
  if (url) view.url = url;
  const note = clip(str("note").trim(), DAV_LIMITS.maxNoteChars);
  if (note) view.note = note;
  return view;
}

export interface ContactInput {
  name?: string;
  email?: string;
  phone?: string;
  org?: string;
  title?: string;
  note?: string;
  address?: string;
  birthday?: string;
  url?: string;
}

function splitName(full: string): { family: string; given: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { family: "", given: parts[0]! };
  return { given: parts.slice(0, -1).join(" "), family: parts[parts.length - 1]! };
}

const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]+$/;

function checkContact(input: ContactInput): void {
  if (input.email !== undefined && input.email.trim() && !EMAIL_RE.test(input.email.trim())) throw new Error(`"${clip(input.email, 60)}" is not an email address.`);
  if (input.birthday !== undefined && input.birthday.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(input.birthday.trim())) throw new Error("birthday must be YYYY-MM-DD.");
}

export function buildVcard(input: ContactInput, uid: string = newUid()): { uid: string; vcf: string } {
  checkContact(input);
  const name = oneLine(input.name ?? "", 200);
  if (!name) throw new Error("A contact needs a name.");
  const { family, given } = splitName(name);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//Ares//Contacts//EN",
    `UID:${uid}`,
    `FN:${escText(name)}`,
    `N:${escText(family)};${escText(given)};;;`,
  ];
  if (input.email?.trim()) lines.push(`EMAIL;TYPE=INTERNET:${escText(input.email.trim())}`);
  if (input.phone?.trim()) lines.push(`TEL;TYPE=VOICE:${escText(oneLine(input.phone, 40))}`);
  if (input.org?.trim()) lines.push(`ORG:${escText(oneLine(input.org.replace(/;/g, ","), 200))}`);
  if (input.title?.trim()) lines.push(`TITLE:${escText(oneLine(input.title, 120))}`);
  if (input.address?.trim()) lines.push(`ADR;TYPE=HOME:;;${escText(oneLine(input.address, 300))};;;;`);
  if (input.birthday?.trim()) lines.push(`BDAY:${input.birthday.trim()}`);
  if (input.url?.trim()) lines.push(`URL:${escText(oneLine(input.url, 300))}`);
  if (input.note?.trim()) lines.push(`NOTE:${escText(clip(input.note.trim(), 8000))}`);
  lines.push(`REV:${dtstampNow()}`, "END:VCARD");
  const card = new ICAL.Component(ICAL.parse(crlf(lines)));
  return { uid, vcf: card.toString() + "\r\n" };
}

/** Patch a stored vCard: only the fields named change; photos, groups,
 *  extra numbers and vendor properties are preserved. */
export function patchVcard(vcf: string, patch: ContactInput): string {
  checkContact(patch);
  const parsed = ICAL.parse(vcf);
  const card = new ICAL.Component(Array.isArray(parsed) && typeof parsed[0] === "string" ? (parsed as never) : ((parsed as unknown[])[0] as never));
  const setText = (prop: string, value: string | undefined): void => {
    if (value === undefined) return;
    card.removeAllProperties(prop);
    if (value.trim()) card.addProperty(ICAL.Property.fromString(`${prop.toUpperCase()}:${escText(clip(oneLine(value, 8000), 8000))}`));
  };
  if (patch.name !== undefined) {
    const name = oneLine(patch.name, 200);
    if (!name) throw new Error("The name can't be empty.");
    const { family, given } = splitName(name);
    card.removeAllProperties("fn");
    card.removeAllProperties("n");
    card.addProperty(ICAL.Property.fromString(`FN:${escText(name)}`));
    card.addProperty(ICAL.Property.fromString(`N:${escText(family)};${escText(given)};;;`));
  }
  if (patch.email !== undefined) {
    card.removeAllProperties("email");
    if (patch.email.trim()) card.addProperty(ICAL.Property.fromString(`EMAIL;TYPE=INTERNET:${escText(patch.email.trim())}`));
  }
  if (patch.phone !== undefined) {
    card.removeAllProperties("tel");
    if (patch.phone.trim()) card.addProperty(ICAL.Property.fromString(`TEL;TYPE=VOICE:${escText(oneLine(patch.phone, 40))}`));
  }
  setText("org", patch.org?.replace(/;/g, ","));
  setText("title", patch.title);
  setText("url", patch.url);
  if (patch.note !== undefined) {
    card.removeAllProperties("note");
    if (patch.note.trim()) card.addProperty(ICAL.Property.fromString(`NOTE:${escText(clip(patch.note.trim(), 8000))}`));
  }
  if (patch.address !== undefined) {
    card.removeAllProperties("adr");
    if (patch.address.trim()) card.addProperty(ICAL.Property.fromString(`ADR;TYPE=HOME:;;${escText(oneLine(patch.address, 300))};;;;`));
  }
  if (patch.birthday !== undefined) {
    card.removeAllProperties("bday");
    if (patch.birthday.trim()) card.addProperty(ICAL.Property.fromString(`BDAY:${patch.birthday.trim()}`));
  }
  card.removeAllProperties("rev");
  card.addProperty(ICAL.Property.fromString(`REV:${dtstampNow()}`));
  return card.toString() + "\r\n";
}

// ─── one event in detail ─────────────────────────────────────────────────────

export interface EventDetail extends CalendarEventView {
  recurrenceRule?: string;
  attendeeList?: string[];
  alarms?: string[];
}

/** The main event of an object, with its rule, attendees and alarms. */
export function describeEvent(data: string, meta: ExpandMeta): EventDetail | null {
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(data));
  } catch {
    return null;
  }
  registerZones(root);
  const master = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id")) ?? root.getAllSubcomponents("vevent")[0];
  if (!master) return null;
  try {
    const ev = new ICAL.Event(master);
    const view = viewOf(ev, ev.startDate, eventEnd(ev, ev.startDate), meta, ev.isRecurring());
    if (!view) return null;
    const detail: EventDetail = { ...view };
    const rule = master.getFirstPropertyValue("rrule");
    if (rule) detail.recurrenceRule = String(rule).slice(0, 200);
    const attendees = master.getAllProperties("attendee").map((p) => oneLine(String(p.getFirstValue() ?? "").replace(/^mailto:/i, ""), 120)).filter(Boolean).slice(0, 20);
    if (attendees.length) detail.attendeeList = attendees;
    const alarms = master.getAllSubcomponents("valarm").map((a) => oneLine(String(a.getFirstPropertyValue("trigger") ?? ""), 40)).filter(Boolean).slice(0, 5);
    if (alarms.length) detail.alarms = alarms;
    return detail;
  } catch {
    return null;
  }
}
