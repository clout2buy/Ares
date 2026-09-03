// Meeting-prep nudges — the day brief turned into action.
//
//   1. planMeetingNudges pure cases: due / not-yet-due / already-started /
//      all-day / duplicate-suppressed / capped at 3 per tick.
//   2. Nudge text is compact and deterministic (time, link line, prep line).
//   3. Fingerprint persistence round-trips through ~home/operator and prunes
//      long-past entries.
//   4. runMeetingNudgeTick end-to-end with a fake sender + fake clock:
//      sends once, never twice, silent on fetch failure, and a failed send
//      retries next tick (fingerprint not burned).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  planMeetingNudges,
  formatMeetingNudge,
  meetingFingerprint,
  loadNudgedFingerprints,
  saveNudgedFingerprints,
  runMeetingNudgeTick,
  MAX_NUDGES_PER_TICK,
} from "../packages/operator/dist/index.js";

const NOW = new Date("2026-09-02T14:05:00.000Z");
const inMinutes = (m) => new Date(NOW.getTime() + m * 60_000).toISOString();

test("planMeetingNudges: due within lead window, not-due outside it", () => {
  const events = [
    { id: "e1", title: "Standup", start: inMinutes(25) }, // due (25 <= 30)
    { id: "e2", title: "Later sync", start: inMinutes(90) }, // not due yet
  ];
  const due = planMeetingNudges({ events, now: NOW, leadMinutes: 30, nudged: new Set(), timeZone: "UTC" });
  assert.equal(due.length, 1);
  assert.equal(due[0].event.id, "e1");
  assert.equal(due[0].minutesUntil, 25);
});

test("planMeetingNudges: skips started, all-day, and already-nudged events", () => {
  const started = { id: "s", title: "Started", start: inMinutes(-5) };
  const allDay = { id: "a", title: "Babe's birthday", start: "2026-09-02" };
  const dupe = { id: "d", title: "Dupe", start: inMinutes(10) };
  const fresh = { id: "f", title: "Fresh", start: inMinutes(12) };
  const nudged = new Set([meetingFingerprint(dupe)]);
  const due = planMeetingNudges({ events: [started, allDay, dupe, fresh], now: NOW, leadMinutes: 30, nudged, timeZone: "UTC" });
  assert.deepEqual(due.map((n) => n.event.id), ["f"]);
});

test("planMeetingNudges: caps at 3 per tick, soonest first", () => {
  const events = [5, 10, 15, 20, 25].map((m, i) => ({ id: `e${i}`, title: `M${i}`, start: inMinutes(m) }));
  // Shuffle input order to prove the sort, not the input, decides who survives the cap.
  const due = planMeetingNudges({ events: [events[3], events[0], events[4], events[2], events[1]], now: NOW, leadMinutes: 30, nudged: new Set(), timeZone: "UTC" });
  assert.equal(due.length, MAX_NUDGES_PER_TICK);
  assert.deepEqual(due.map((n) => n.event.id), ["e0", "e1", "e2"]);
});

test("planMeetingNudges: rescheduled meeting (new start) legitimately re-nudges", () => {
  const original = { id: "mtg", title: "1:1", start: inMinutes(10) };
  const moved = { id: "mtg", title: "1:1", start: inMinutes(20) };
  const nudged = new Set([meetingFingerprint(original)]);
  const due = planMeetingNudges({ events: [moved], now: NOW, leadMinutes: 30, nudged, timeZone: "UTC" });
  assert.equal(due.length, 1, "same id but new start is a new instance");
});

test("nudge text: compact deterministic body with link + prep lines", () => {
  const text = formatMeetingNudge(
    {
      title: "Design review",
      start: inMinutes(25),
      location: "https://meet.google.com/abc-def",
      description: "Bring the Q3 mocks\nsecond line ignored",
    },
    25,
    "UTC",
  );
  assert.equal(text, "⏰ Design review in 25 min (2:30 PM)\nhttps://meet.google.com/abc-def\nprep: Bring the Q3 mocks");
  // No link, no description → single line; a plain room is not a link.
  assert.equal(formatMeetingNudge({ title: "Standup", start: inMinutes(25), location: "Room 4" }, 25, "UTC"), "⏰ Standup in 25 min (2:30 PM)");
});

test("fingerprint persistence: round-trips and prunes long-past entries", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-nudge-"));
  try {
    const entries = new Map([
      ["fresh|x", inMinutes(10)],
      ["old|y", new Date(NOW.getTime() - 48 * 3_600_000).toISOString()], // 2 days past → pruned
    ]);
    await saveNudgedFingerprints(home, entries, NOW);
    const loaded = await loadNudgedFingerprints(home);
    assert.deepEqual([...loaded.keys()], ["fresh|x"]);
    // Missing file → empty map, never a throw.
    const empty = await loadNudgedFingerprints(path.join(home, "nowhere"));
    assert.equal(empty.size, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runMeetingNudgeTick: fake sender + fake clock — sends once, dedupes across ticks and restarts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-nudge-tick-"));
  try {
    const sent = [];
    const opts = {
      home,
      now: NOW,
      timeZone: "UTC",
      leadMinutes: 30,
      fetchEvents: async () => [
        { id: "e1", title: "Standup", start: inMinutes(25), location: "https://zoom.us/j/1" },
        { id: "far", title: "Tomorrow", start: inMinutes(600) },
      ],
      send: (text) => { sent.push(text); },
    };
    const first = await runMeetingNudgeTick(opts);
    assert.equal(first.sent.length, 1);
    assert.match(sent[0], /^⏰ Standup in 25 min \(2:30 PM\)\nhttps:\/\/zoom\.us\/j\/1$/);

    // Same tick 5 minutes later — durable fingerprint suppresses the duplicate,
    // exactly as it would after a daemon restart (state reloaded from disk).
    const later = await runMeetingNudgeTick({ ...opts, now: new Date(NOW.getTime() + 5 * 60_000) });
    assert.equal(later.sent.length, 0);
    assert.equal(sent.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runMeetingNudgeTick: fetch failure is silent; failed send keeps the nudge for next tick", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-nudge-fail-"));
  try {
    // Calendar not reachable → no sends, no throw.
    const down = await runMeetingNudgeTick({
      home,
      now: NOW,
      fetchEvents: async () => { throw new Error("Google Calendar API 401"); },
      send: () => { throw new Error("must not send"); },
    });
    assert.deepEqual(down.sent, []);

    // A hanging fetch is cut by the timeout, not awaited forever.
    const hung = await runMeetingNudgeTick({
      home,
      now: NOW,
      timeoutMs: 50,
      fetchEvents: () => new Promise(() => {}),
      send: () => { throw new Error("must not send"); },
    });
    assert.deepEqual(hung.sent, []);

    // Telegram down on the first try → fingerprint NOT burned; next tick retries.
    const events = [{ id: "e1", title: "Standup", start: inMinutes(20) }];
    let attempts = 0;
    const failing = await runMeetingNudgeTick({
      home, now: NOW, timeZone: "UTC",
      fetchEvents: async () => events,
      send: () => { attempts++; throw new Error("telegram 502"); },
    });
    assert.deepEqual(failing.sent, []);
    const retry = await runMeetingNudgeTick({
      home, now: new Date(NOW.getTime() + 60_000), timeZone: "UTC",
      fetchEvents: async () => events,
      send: () => { attempts++; },
    });
    assert.equal(retry.sent.length, 1);
    assert.equal(attempts, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
