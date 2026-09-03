// Meeting-prep nudges — the day brief turned into ACTION.
//
// The daily brief tells the owner what's on the calendar once, in the morning.
// This module closes the gap between "knew about it at 8am" and "walked in
// prepared": ARES_MEETING_PREP_MIN minutes before each meeting, one compact
// Telegram nudge with the time, the link, and the first line of prep notes.
//
// Design constraints (why this file looks the way it does):
//   - planMeetingNudges is PURE and deterministic: (events, now, lead, nudged)
//     → nudges due right now. No clock reads, no I/O, no LLM. The caller owns
//     the tick cadence (it piggybacks the Telegram briefing timer — this module
//     never starts a timer of its own; setInterval owners are the schedulers).
//   - Dedupe is a durable fingerprint set (event id + start), persisted under
//     ~/.ares/operator/ the same way watcher fingerprints persist, so a daemon
//     restart mid-lead-window never re-pings the owner about the same meeting.
//   - Never for all-day events (no meaningful "30 min before"), never for
//     events already started (the nudge would be noise, not prep), at most 3
//     per tick (a busy back-to-back block must not turn into a spam burst).

import path from "node:path";
import { promises as fs } from "node:fs";
import { writeFileAtomic } from "@ares/agent";
import { operatorPaths } from "./paths.js";

/** Calendar event shape as the day-brief calendar source yields it (title/
 *  start/end/location) plus optional richer fields when a source has them. */
export interface MeetingEvent {
  id?: string;
  title: string;
  /** ISO-8601 datetime, or YYYY-MM-DD for all-day events. */
  start: string;
  end?: string;
  location?: string;
  /** Explicit meeting link; when absent, an http(s) location doubles as one. */
  link?: string;
  description?: string;
  attendees?: string[];
}

export interface MeetingNudge {
  /** Stable dedupe key: event id (or title) + start. */
  fingerprint: string;
  text: string;
  event: MeetingEvent;
  minutesUntil: number;
}

export interface PlanMeetingNudgesInput {
  events: readonly MeetingEvent[];
  now: Date;
  /** Nudge fires within this many minutes before start. Default 30. */
  leadMinutes?: number;
  /** Fingerprints already nudged — mutated NEVER; the caller persists additions. */
  nudged: ReadonlySet<string>;
  /** Per-tick cap. Default 3. */
  maxPerTick?: number;
  /** Render times in this zone (tests pin "UTC"; default = process zone). */
  timeZone?: string;
}

export const DEFAULT_MEETING_LEAD_MINUTES = 30;
export const MAX_NUDGES_PER_TICK = 3;

/** id+start, so a rescheduled meeting (new start) legitimately re-nudges while
 *  the same instance never does — even across process restarts. */
export function meetingFingerprint(event: Pick<MeetingEvent, "id" | "title" | "start">): string {
  return `${event.id ?? event.title}|${event.start}`;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function meetingLink(event: MeetingEvent): string | undefined {
  if (event.link && /^https?:\/\//i.test(event.link)) return event.link;
  if (event.location && /^https?:\/\//i.test(event.location)) return event.location;
  return undefined;
}

/** Compact, deterministic nudge body: "⏰ Standup in 25 min (2:30 PM)" plus a
 *  link line and a one-line prep hint when the event carries them. */
export function formatMeetingNudge(event: MeetingEvent, minutesUntil: number, timeZone?: string): string {
  const at = new Date(event.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  const lines = [`⏰ ${event.title} in ${minutesUntil} min (${at})`];
  const link = meetingLink(event);
  if (link) lines.push(link);
  const prep = firstLine(event.description);
  if (prep) lines.push(`prep: ${prep}`);
  return lines.join("\n");
}

/** The pure core: which nudges are due on THIS tick. Soonest meetings win the
 *  per-tick cap so the imminent one is never crowded out by later ones. */
export function planMeetingNudges(input: PlanMeetingNudgesInput): MeetingNudge[] {
  const lead = Math.max(1, input.leadMinutes ?? DEFAULT_MEETING_LEAD_MINUTES);
  const cap = Math.max(1, input.maxPerTick ?? MAX_NUDGES_PER_TICK);
  const nowMs = input.now.getTime();

  const due: MeetingNudge[] = [];
  const candidates = [...input.events]
    .filter((e) => typeof e.start === "string" && e.start.includes("T")) // all-day events carry a bare date
    .map((e) => ({ event: e, startMs: Date.parse(e.start) }))
    .filter((c) => Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  for (const { event, startMs } of candidates) {
    if (startMs <= nowMs) continue; // already started — prep time is gone
    const msUntil = startMs - nowMs;
    if (msUntil > lead * 60_000) continue; // not yet in the lead window
    const fingerprint = meetingFingerprint(event);
    if (input.nudged.has(fingerprint)) continue; // already nudged this instance
    const minutesUntil = Math.max(1, Math.round(msUntil / 60_000));
    due.push({ fingerprint, event, minutesUntil, text: formatMeetingNudge(event, minutesUntil, input.timeZone) });
    if (due.length >= cap) break;
  }
  return due;
}

// ─── Fingerprint persistence (~/.ares/operator/meeting-nudges.json) ─────────
//
// Same discipline as watcher fingerprints: durable, tolerant reads, atomic
// writes, self-pruning. Entries carry the event start so old fingerprints age
// out on their own — the file stays a handful of lines, never a log.

interface NudgedEntry {
  fp: string;
  /** Event start ISO — the prune key (a fingerprint is useless once the meeting is well past). */
  start: string;
}

const PRUNE_AFTER_MS = 24 * 3_600_000;

export function meetingNudgeStateFile(home?: string): string {
  return path.join(operatorPaths(home).operatorDir, "meeting-nudges.json");
}

export async function loadNudgedFingerprints(home?: string): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(meetingNudgeStateFile(home), "utf8");
    const parsed = JSON.parse(raw) as { entries?: NudgedEntry[] };
    const map = new Map<string, string>();
    for (const e of parsed.entries ?? []) {
      if (typeof e?.fp === "string" && typeof e?.start === "string") map.set(e.fp, e.start);
    }
    return map;
  } catch {
    return new Map(); // missing / corrupt → clean slate (worst case: one duplicate nudge)
  }
}

export async function saveNudgedFingerprints(home: string | undefined, entries: ReadonlyMap<string, string>, now = new Date()): Promise<void> {
  const cutoff = now.getTime() - PRUNE_AFTER_MS;
  const kept: NudgedEntry[] = [];
  for (const [fp, start] of entries) {
    const t = Date.parse(start);
    if (Number.isFinite(t) && t < cutoff) continue; // meeting long over — forget it
    kept.push({ fp, start });
  }
  await writeFileAtomic(meetingNudgeStateFile(home), JSON.stringify({ entries: kept }, null, 2) + "\n");
}

// ─── One tick, end-to-end (fetch → plan → send → persist) ───────────────────

export interface MeetingNudgeTickOptions {
  home?: string;
  now?: Date;
  /** The SAME calendar source the day brief uses (injected — no credentials here). */
  fetchEvents: () => Promise<readonly MeetingEvent[]>;
  send: (text: string) => Promise<void> | void;
  leadMinutes?: number;
  /** Fetch budget — a slow calendar API must never pin the briefing timer. Default 8s. */
  timeoutMs?: number;
  timeZone?: string;
}

/** Run one nudge tick. Best-effort by construction: a failed fetch or send is
 *  swallowed (silent when the calendar isn't connected), and only nudges whose
 *  send actually resolved get their fingerprint persisted — a Telegram outage
 *  retries naturally next tick instead of losing the nudge forever. */
export async function runMeetingNudgeTick(opts: MeetingNudgeTickOptions): Promise<{ sent: MeetingNudge[] }> {
  const now = opts.now ?? new Date();
  let events: readonly MeetingEvent[];
  try {
    events = await withTimeout(opts.fetchEvents(), opts.timeoutMs ?? 8_000);
  } catch {
    return { sent: [] };
  }
  if (!Array.isArray(events) || events.length === 0) return { sent: [] };

  const persisted = await loadNudgedFingerprints(opts.home);
  const due = planMeetingNudges({
    events,
    now,
    leadMinutes: opts.leadMinutes,
    nudged: new Set(persisted.keys()),
    timeZone: opts.timeZone,
  });
  const sent: MeetingNudge[] = [];
  for (const nudge of due) {
    try {
      await opts.send(nudge.text);
      persisted.set(nudge.fingerprint, nudge.event.start);
      sent.push(nudge);
    } catch {
      // send failed — leave the fingerprint unrecorded so the next tick retries
    }
  }
  if (sent.length > 0) await saveNudgedFingerprints(opts.home, persisted, now).catch(() => undefined);
  return { sent };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // NOT unref'd: this timer is the only thing guaranteed to settle the await
    // when the fetch hangs, and it is cleared the moment the fetch settles.
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
