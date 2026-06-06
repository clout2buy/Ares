// Verifies the Proactive Daily Briefing (Nexus Phase 1) — the pure rankBriefing
// transform over a ContinuitySummary: ranking, bucketing, citations, honesty.

import test from "node:test";
import assert from "node:assert/strict";

import { rankBriefing } from "../packages/operator/dist/index.js";

const NOW = "2026-06-06T00:00:00.000Z";
const RECENT = "2026-06-05T12:00:00.000Z"; // ~0.5d ago
const OLD = "2026-05-15T00:00:00.000Z"; // ~22d ago → stale

const view = (id, intent, o = {}) => ({
  id,
  intent,
  status: o.status ?? "active",
  percent: o.percent ?? 0,
  completedCriteria: o.completed ?? 0,
  totalCriteria: o.total ?? 4,
  updatedAt: o.updatedAt ?? RECENT,
  blockers: o.blockers ?? [],
  nextAction: o.nextAction,
  topEvidence: o.topEvidence ?? [],
});
const summary = (o = {}) => ({
  missionCount: o.missionCount ?? 0,
  active: o.active ?? [],
  blocked: o.blocked ?? [],
  recentlySatisfied: o.recentlySatisfied ?? [],
  empty: o.empty ?? false,
  advisory: o.advisory ?? null,
});

test("briefing: near-done outranks far-from-done in focus", () => {
  const b = rankBriefing({
    summary: summary({
      active: [
        view("a", "near done", { percent: 80, completed: 4, total: 5, nextAction: "finish it" }),
        view("b", "just started", { percent: 10, nextAction: "start" }),
      ],
    }),
    now: NOW,
  });
  assert.equal(b.focus[0].missionId, "a");
});

test("briefing: actionable outranks no-next-action", () => {
  const b = rankBriefing({
    summary: summary({
      active: [
        view("c", "has action", { percent: 40, nextAction: "do x" }),
        view("d", "no action", { percent: 40 }),
      ],
    }),
    now: NOW,
  });
  assert.equal(b.focus[0].missionId, "c");
});

test("briefing: blocked goes to Decisions Needed, not Focus", () => {
  const b = rankBriefing({
    summary: summary({ blocked: [view("blk", "blocked thing", { status: "blocked", blockers: ["waiting on dep"] })] }),
    now: NOW,
  });
  assert.equal(b.decisionsNeeded.length, 1);
  assert.equal(b.decisionsNeeded[0].missionId, "blk");
  assert.equal(b.decisionsNeeded[0].kind, "blocked");
  assert.match(b.decisionsNeeded[0].detail, /waiting on dep/);
  assert.equal(b.focus.length, 0);
});

test("briefing: satisfied goes to Recently Shipped", () => {
  const b = rankBriefing({
    summary: summary({ recentlySatisfied: [view("s1", "shipped voice", { status: "satisfied", percent: 100 })] }),
    now: NOW,
  });
  assert.equal(b.recentlyShipped[0].missionId, "s1");
});

test("briefing: stale goes to Revive or Drop, not Focus", () => {
  const b = rankBriefing({
    summary: summary({ active: [view("st", "stale thing", { percent: 30, updatedAt: OLD })] }),
    now: NOW,
  });
  assert.equal(b.reviveOrDrop.length, 1);
  assert.equal(b.reviveOrDrop[0].missionId, "st");
  assert.equal(b.reviveOrDrop[0].kind, "stale");
  assert.equal(b.focus.length, 0);
});

test("briefing: empty state is honest and useful", () => {
  const b = rankBriefing({ summary: summary({ empty: true }), now: NOW });
  assert.equal(b.empty, true);
  assert.match(b.headline, /clean slate/i);
  assert.equal(b.focus.length, 0);
});

test("briefing: every focus item carries cited source signals", () => {
  const b = rankBriefing({
    summary: summary({ active: [view("a", "ship voice input", { percent: 70, completed: 3, total: 4, nextAction: "wire F9" })] }),
    now: NOW,
  });
  assert.ok(b.focus.length > 0);
  for (const f of b.focus) {
    assert.ok(f.reasons.length > 0, "focus item has reasons");
    assert.ok(f.reasons.some((r) => /%/.test(r)), "cites progress");
    assert.ok(f.reasons.some((r) => /next:|needs a plan/.test(r)), "cites action state");
  }
});

test("briefing: no invented urgency or fake deadlines anywhere", () => {
  const b = rankBriefing({
    summary: summary({
      active: [view("a", "ship voice", { percent: 70, nextAction: "wire f9" })],
      blocked: [view("x", "blocked thing", { status: "blocked", blockers: ["dep missing"] })],
      recentlySatisfied: [view("s", "did a thing", { status: "satisfied" })],
    }),
    now: NOW,
  });
  const text = JSON.stringify(b).toLowerCase();
  assert.ok(!/urgent|asap|deadline|overdue|!!!|right now|hurry/.test(text), "no urgency/deadline wording");
});

test("briefing: advisory is surfaced as a labeled suggestion, not fact", () => {
  const b = rankBriefing({
    summary: summary({
      active: [view("a", "x", {})],
      advisory: { goal: "finish voice tests", rationale: "build is green", confidence: 0.6 },
    }),
    now: NOW,
  });
  assert.ok(b.suggestion);
  assert.equal(b.suggestion.goal, "finish voice tests");
});

test("briefing: pure — same input is deterministic and inputs untouched", () => {
  const s = summary({ active: [view("a", "x", {})] });
  const r1 = rankBriefing({ summary: s, now: NOW });
  const r2 = rankBriefing({ summary: s, now: NOW });
  assert.deepEqual(r1, r2);
  assert.equal(s.active.length, 1, "inputs not mutated");
});
