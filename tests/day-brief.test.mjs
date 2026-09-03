// The morning brief — composeDayBrief over injected sources.
//
//   1. every source present → fixed section order, compact deterministic text
//   2. some sources failing / hanging → one honest line each, never a throw
//   3. no sources at all → every section reads "not connected"
//   4. ordering and formatting details (all-day first, subjects capped, etc.)

import test from "node:test";
import assert from "node:assert/strict";

import { composeDayBrief, rankBriefing } from "../packages/operator/dist/index.js";

const NOW = new Date("2026-09-01T13:00:00.000Z");

const missions = () =>
  rankBriefing({
    now: NOW.toISOString(),
    summary: {
      missionCount: 2,
      empty: false,
      advisory: null,
      recentlySatisfied: [],
      blocked: [
        { id: "b", intent: "Ship the updater", status: "blocked", percent: 50, completedCriteria: 1, totalCriteria: 2, updatedAt: NOW.toISOString(), blockers: ["waiting on signing key"], topEvidence: [] },
      ],
      active: [
        { id: "a", intent: "Finish the morning brief", status: "active", percent: 75, completedCriteria: 3, totalCriteria: 4, updatedAt: NOW.toISOString(), blockers: [], nextAction: "wire telegram", topEvidence: [] },
      ],
    },
  });

const fullSources = () => ({
  weather: async () => "📍 Houston, Texas\nNow: 91°F (feels 99°F), Sunny\nHumidity: 60% · Wind: 8 mph S\n\n2026-09-01: 95°F/78°F — Sunny",
  calendar: async () => [
    { title: "Standup", start: "2026-09-01T14:00:00.000Z", end: "2026-09-01T14:30:00.000Z", location: "Zoom" },
    { title: "Babe's birthday", start: "2026-09-01" },
    { title: "Dentist", start: "2026-09-01T09:30:00.000Z", end: "2026-09-01T10:15:00.000Z" },
  ],
  reminders: async () => [
    { label: "Lunch check-in", hour: 12, minute: 0 },
    { label: "Take out trash", hour: 7, minute: 30, body: "bins to the curb" },
  ],
  email: async () => ({ unread: 5, important: 2, subjects: ["Invoice #1234", "Re: standup notes", "Your order shipped", "Fourth subject must be cut"] }),
  missions: async () => missions(),
});

test("day brief: all sources present → fixed order, compact deterministic text", async () => {
  const a = await composeDayBrief({ sources: fullSources(), now: NOW, timeZone: "UTC" });
  const b = await composeDayBrief({ sources: fullSources(), now: NOW, timeZone: "UTC" });
  assert.equal(a.text, b.text, "deterministic for identical inputs");
  assert.deepEqual(a.sections.map((s) => s.name), ["weather", "calendar", "reminders", "email", "missions"]);
  assert.ok(a.sections.every((s) => s.status === "ok"), JSON.stringify(a.sections.map((s) => [s.name, s.status])));

  const text = a.text;
  const idx = (needle) => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `expected "${needle}" in:\n${text}`);
    return i;
  };
  assert.ok(idx("weather: 📍 Houston") < idx("calendar: 3 events"), "weather before calendar");
  assert.ok(idx("calendar: 3 events") < idx("reminders: 2 due today"), "calendar before reminders");
  assert.ok(idx("reminders: 2 due today") < idx("email: 5 unread (2 important)"), "reminders before email");
  assert.ok(idx("email: 5 unread") < idx("missions: "), "email before missions");

  // Calendar: all-day leads, then chronological with a time range; location kept.
  const calLines = a.sections[1].lines;
  assert.match(calLines[1], /^  all day\s+Babe's birthday$/);
  assert.match(calLines[2], /^  09:30–10:15\s+Dentist$/);
  assert.match(calLines[3], /^  14:00–14:30\s+Standup @ Zoom$/);
  // Reminders: sorted by time, body appended.
  assert.match(a.sections[2].lines[1], /07:30\s+Take out trash — bins to the curb/);
  assert.match(a.sections[2].lines[2], /12:00\s+Lunch check-in/);
  // Email: subjects only, capped at 3, no bodies.
  assert.equal(a.sections[3].lines.length, 4);
  assert.ok(!text.includes("Fourth subject"), "subject list capped at 3");
  // Missions: the rankBriefing headline + focus + blocked decision.
  assert.ok(text.includes("1 in focus, 1 blocked"), text);
  assert.ok(text.includes("• Finish the morning brief [active 75%] → wire telegram"), text);
  assert.ok(text.includes("! Ship the updater — waiting on signing key"), text);
});

test("day brief: failing and hanging sources yield one 'not connected' line each, never a throw", async () => {
  const sources = fullSources();
  sources.calendar = async () => { throw new Error("Google Calendar API 401: token expired"); };
  sources.email = () => new Promise(() => {}); // hangs forever → per-source timeout
  const brief = await composeDayBrief({ sources, now: NOW, timeZone: "UTC", timeoutMs: 50 });

  const cal = brief.sections.find((s) => s.name === "calendar");
  assert.equal(cal.status, "failed");
  assert.equal(cal.lines.length, 1);
  assert.match(cal.lines[0], /^calendar: not connected \(Google Calendar API 401/);

  const mail = brief.sections.find((s) => s.name === "email");
  assert.equal(mail.status, "timeout");
  assert.deepEqual(mail.lines, ["email: not connected (timed out after 0s)"]);

  // The healthy sources still rendered in full — one broken token never costs the weather.
  assert.equal(brief.sections.find((s) => s.name === "weather").status, "ok");
  assert.equal(brief.sections.find((s) => s.name === "missions").status, "ok");
  assert.ok(brief.text.includes("reminders: 2 due today"));
});

test("day brief: no sources at all → every section is 'not connected' in order", async () => {
  const brief = await composeDayBrief({ sources: {}, now: NOW });
  assert.deepEqual(
    brief.sections.map((s) => [s.name, s.status, s.lines]),
    [
      ["weather", "not-connected", ["weather: not connected"]],
      ["calendar", "not-connected", ["calendar: not connected"]],
      ["reminders", "not-connected", ["reminders: not connected"]],
      ["email", "not-connected", ["email: not connected"]],
      ["missions", "not-connected", ["missions: not connected"]],
    ],
  );
  assert.equal(
    brief.text,
    ["weather: not connected", "calendar: not connected", "reminders: not connected", "email: not connected", "missions: not connected"].join("\n\n"),
  );
  assert.equal(brief.at, NOW.toISOString());
});

test("day brief: empty-but-connected sources render honest empties; a malformed payload is a failure line", async () => {
  const brief = await composeDayBrief({
    sources: {
      calendar: async () => [],
      reminders: async () => [],
      email: async () => ({ unread: 0, subjects: [] }),
      // A source that resolves to garbage must not crash rendering.
      missions: async () => null,
    },
    now: NOW,
  });
  assert.deepEqual(brief.sections.find((s) => s.name === "calendar").lines, ["calendar: nothing scheduled"]);
  assert.deepEqual(brief.sections.find((s) => s.name === "reminders").lines, ["reminders: none due"]);
  assert.deepEqual(brief.sections.find((s) => s.name === "email").lines, ["email: 0 unread"]);
  const m = brief.sections.find((s) => s.name === "missions");
  assert.equal(m.status, "failed");
  assert.match(m.lines[0], /^missions: not connected \(/);
});

test("day brief: truncated unread count renders as N+ and the weather block is capped", async () => {
  const brief = await composeDayBrief({
    sources: {
      email: async () => ({ unread: 10, truncated: true, subjects: ["a"] }),
      weather: async () => "l1\nl2\nl3\nl4\nl5\nl6",
    },
    now: NOW,
  });
  assert.equal(brief.sections.find((s) => s.name === "email").lines[0], "email: 10+ unread");
  assert.deepEqual(brief.sections.find((s) => s.name === "weather").lines, ["weather: l1", "  l2", "  l3", "  l4"]);
});
