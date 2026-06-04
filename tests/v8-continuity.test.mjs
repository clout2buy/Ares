// Ghost Continue v1 — continuity summarizer (Phase A).
//
// Proves the pure summarizer turns durable mission state into a continuity card:
//   1. a blocked mission surfaces its (unresolved) blockers + next action
//   2. a satisfied mission lands in "recently completed", with its goal statement
//   3. empty state is a friendly clean-slate, not a crash
//   4. missions rank newest-first by updatedAt; lastActiveAt is the freshest
//   5. evidence is newest-first and the summary is plain JSON-serializable
//   6. it never mutates its inputs (sorts a copy)

import test from "node:test";
import assert from "node:assert/strict";

import { summarizeContinuity } from "../packages/operator/dist/index.js";

function contract(over = {}) {
  const at = over.updatedAt ?? "2026-06-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: over.id ?? "mc_1",
    goalId: over.goalId,
    intent: over.intent ?? "Build the launcher",
    acceptanceCriteria: [],
    constraints: [],
    verificationProbes: [],
    verificationProbeResults: [],
    progress: over.progress ?? { status: "active", completedCriteria: 1, totalCriteria: 4, percent: 25, updatedAt: at },
    blockers: over.blockers ?? [],
    nextAction: over.nextAction,
    evidenceLog: over.evidenceLog ?? [],
    createdAt: at,
    updatedAt: at,
  };
}

// ── 1. blocked mission ────────────────────────────────────────────────────────

test("continuity: a blocked mission surfaces unresolved blockers and next action", () => {
  const c = contract({
    id: "mc_b",
    progress: { status: "blocked", completedCriteria: 2, totalCriteria: 5, percent: 40, updatedAt: "2026-06-02T10:00:00.000Z" },
    blockers: [
      { id: "b1", at: "2026-06-02T09:00:00.000Z", reason: "installer signing cert missing" },
      { id: "b2", at: "2026-06-01T09:00:00.000Z", reason: "already handled", resolvedAt: "2026-06-01T12:00:00.000Z" },
    ],
    nextAction: { summary: "obtain a code-signing certificate" },
  });
  const s = summarizeContinuity({ contracts: [c] });

  assert.equal(s.blocked.length, 1);
  assert.equal(s.active.length, 0);
  assert.deepEqual(s.blocked[0].blockers, ["installer signing cert missing"], "resolved blockers are dropped");
  assert.equal(s.blocked[0].nextAction, "obtain a code-signing certificate");
  assert.equal(s.blocked[0].percent, 40);
});

// ── 2. satisfied mission + goal statement ─────────────────────────────────────

test("continuity: a satisfied mission lands in recently-completed with its goal", () => {
  const c = contract({
    id: "mc_s",
    goalId: "g1",
    progress: { status: "satisfied", completedCriteria: 4, totalCriteria: 4, percent: 100, updatedAt: "2026-06-02T00:00:00.000Z" },
  });
  const s = summarizeContinuity({ contracts: [c], goals: [{ id: "g1", statement: "Ship launcher v1" }] });

  assert.equal(s.recentlySatisfied.length, 1);
  assert.equal(s.recentlySatisfied[0].goalStatement, "Ship launcher v1");
  assert.equal(s.active.length, 0);
  assert.equal(s.empty, false);
});

// ── 3. empty state ─────────────────────────────────────────────────────────────

test("continuity: empty state is a clean slate, not a crash", () => {
  const s = summarizeContinuity({ contracts: [] });
  assert.equal(s.empty, true);
  assert.equal(s.missionCount, 0);
  assert.equal(s.lastActiveAt, undefined);
  assert.deepEqual(s.active, []);
  assert.deepEqual(s.blocked, []);
  assert.deepEqual(s.recentlySatisfied, []);
  assert.equal(s.advisory, null);
});

// ── 4. ranking by updatedAt ───────────────────────────────────────────────────

test("continuity: missions rank newest-first and lastActiveAt is the freshest", () => {
  const older = contract({ id: "old", updatedAt: "2026-05-01T00:00:00.000Z", progress: { status: "active", completedCriteria: 0, totalCriteria: 0, percent: 0, updatedAt: "2026-05-01T00:00:00.000Z" } });
  const newer = contract({ id: "new", updatedAt: "2026-06-02T00:00:00.000Z", progress: { status: "active", completedCriteria: 0, totalCriteria: 0, percent: 0, updatedAt: "2026-06-02T00:00:00.000Z" } });
  const s = summarizeContinuity({ contracts: [older, newer] });

  assert.deepEqual(s.active.map((m) => m.id), ["new", "old"]);
  assert.equal(s.lastActiveAt, "2026-06-02T00:00:00.000Z");
});

// ── 5. evidence ordering + JSON shape ─────────────────────────────────────────

test("continuity: evidence is newest-first and the summary is JSON-serializable", () => {
  const c = contract({
    evidenceLog: [
      { id: "e1", at: "2026-06-01T01:00:00.000Z", kind: "observation", summary: "started", criterionIds: [] },
      { id: "e2", at: "2026-06-01T02:00:00.000Z", kind: "verification", summary: "283 tests passed", criterionIds: [] },
    ],
  });
  const s = summarizeContinuity({ contracts: [c], maxEvidence: 1 });

  assert.equal(s.active[0].topEvidence.length, 1);
  assert.match(s.active[0].topEvidence[0], /verification: 283 tests passed/, "newest evidence first");

  // --json safe: serialization is stable (round-trips to identical JSON).
  const round = JSON.parse(JSON.stringify(s));
  assert.equal(JSON.stringify(round), JSON.stringify(s), "summary round-trips through JSON unchanged");
  assert.match(round.active[0].topEvidence[0], /verification: 283 tests passed/);
});

// ── 6. no mutation ─────────────────────────────────────────────────────────────

test("continuity: summarizer never mutates its inputs", () => {
  const contracts = [
    contract({ id: "a", updatedAt: "2026-05-01T00:00:00.000Z", progress: { status: "active", completedCriteria: 0, totalCriteria: 0, percent: 0, updatedAt: "2026-05-01T00:00:00.000Z" }, blockers: [{ id: "b", at: "t", reason: "x" }] }),
    contract({ id: "b", updatedAt: "2026-06-01T00:00:00.000Z", progress: { status: "active", completedCriteria: 0, totalCriteria: 0, percent: 0, updatedAt: "2026-06-01T00:00:00.000Z" } }),
  ];
  const before = JSON.parse(JSON.stringify(contracts));
  summarizeContinuity({ contracts });

  assert.deepEqual(JSON.parse(JSON.stringify(contracts)), before, "inputs untouched");
  assert.equal(contracts[0].id, "a", "original order preserved (a copy was sorted)");
});
