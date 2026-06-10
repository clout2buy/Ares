// Mission Learning Cards — Phase B v1 (pure distiller, option 1).
//
// Proves Ares turns mission logs into durable lessons:
//   1. a satisfied mission distills a SUCCESS card (worked / procedure / confidence)
//   2. a failed/blocked mission distills what-FAILED from criteria + blockers
//   3. saving is idempotent — re-distilling the same mission yields one card
//   4. the memory feed writes exactly once per card
//   5. lessons list newest-first and load by id
//   6. Ghost Continue surfaces a relevant lesson by tag overlap

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  distillMissionCard,
  learningCardId,
  learningCardMemoryText,
  selectRelevantLessons,
  saveLearningCard,
  loadLearningCard,
  listLearningCards,
  learningCardExists,
  summarizeContinuity,
} from "../packages/operator/dist/index.js";
import { MemoryStore } from "../packages/mind/dist/index.js";
import { recordCardMemoryOnce } from "../packages/agent/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-lesson-"));
const NOW = new Date("2026-06-02T00:00:00.000Z");

function contract(over = {}) {
  const at = over.updatedAt ?? "2026-06-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: over.id ?? "mc_x",
    goalId: over.goalId,
    intent: over.intent ?? "Build the Windows installer for the launcher",
    acceptanceCriteria: over.acceptanceCriteria ?? [],
    constraints: [],
    verificationProbes: [],
    verificationProbeResults: over.verificationProbeResults ?? [],
    progress: over.progress ?? { status: "satisfied", completedCriteria: 2, totalCriteria: 2, percent: 100, updatedAt: at },
    blockers: over.blockers ?? [],
    nextAction: over.nextAction,
    evidenceLog: over.evidenceLog ?? [],
    createdAt: at,
    updatedAt: at,
  };
}

// ── 1. success card ────────────────────────────────────────────────────────

test("learning card: a satisfied mission distills a success card", () => {
  const c = contract({
    acceptanceCriteria: [
      { id: "a1", description: "installer.exe is produced", status: "met", evidenceIds: [] },
      { id: "a2", description: "the test suite passes", status: "met", evidenceIds: [] },
    ],
    verificationProbeResults: [
      { id: "p1", spec: { kind: "command", cmd: "npm", args: ["test"] }, status: "passed", summary: "283 tests passed" },
    ],
    evidenceLog: [
      { id: "e1", at: "2026-06-01T01:00:00.000Z", kind: "decision", summary: "switch to Inno Setup", criterionIds: [] },
      { id: "e2", at: "2026-06-01T02:00:00.000Z", kind: "decision", summary: "add a portable bootstrapper", criterionIds: [] },
    ],
  });
  const card = distillMissionCard(c, { goal: { id: "g", statement: "Ship launcher v1" }, now: NOW });

  assert.equal(card.result, "success");
  assert.equal(card.id, learningCardId(c.id));
  assert.equal(card.goalStatement, "Ship launcher v1");
  assert.ok(card.whatWorked.includes("installer.exe is produced"));
  assert.ok(card.whatWorked.includes("283 tests passed"));
  assert.deepEqual(card.reusableProcedure, ["switch to Inno Setup", "add a portable bootstrapper"]);
  assert.equal(card.whatFailed.length, 0);
  assert.ok(card.confidence > 0.9);
  assert.ok(card.tags.includes("installer"));
});

// ── 2. failed / blocked cards ──────────────────────────────────────────────

test("learning card: a failed mission distills what-failed from criteria + blockers", () => {
  const c = contract({
    id: "mc_fail",
    progress: { status: "blocked", completedCriteria: 1, totalCriteria: 3, percent: 33, updatedAt: "2026-06-01T00:00:00.000Z" },
    acceptanceCriteria: [
      { id: "a1", description: "the installer is code-signed", status: "failed", evidenceIds: [] },
      { id: "a2", description: "it builds", status: "met", evidenceIds: [] },
    ],
    blockers: [
      { id: "b1", at: "t", reason: "signing certificate missing" },
      { id: "b2", at: "t", reason: "already handled", resolvedAt: "t2" },
    ],
  });
  const card = distillMissionCard(c, { now: NOW });

  assert.equal(card.result, "failed", "a failed criterion makes the result failed");
  assert.ok(card.whatFailed.includes("the installer is code-signed"));
  assert.ok(card.whatFailed.includes("signing certificate missing"));
  assert.ok(!card.whatFailed.includes("already handled"), "resolved blockers are not failures");
  assert.ok(card.whatWorked.includes("it builds"));
  assert.ok(card.confidence <= 0.4);
});

test("learning card: a blocked mission with no failures distills as blocked", () => {
  const c = contract({
    id: "mc_blk",
    progress: { status: "blocked", completedCriteria: 0, totalCriteria: 2, percent: 0, updatedAt: "2026-06-01T00:00:00.000Z" },
    blockers: [{ id: "b", at: "t", reason: "waiting on an upstream dependency" }],
  });
  const card = distillMissionCard(c, { now: NOW });
  assert.equal(card.result, "blocked");
  assert.ok(card.whatFailed.includes("waiting on an upstream dependency"));
  assert.ok(card.confidence <= 0.5);
});

// ── 3. idempotent creation ──────────────────────────────────────────────────

test("learning card: re-distilling the same mission overwrites, never duplicates", async () => {
  const home = await makeHome();
  await saveLearningCard(home, distillMissionCard(contract({ id: "mc_idem" }), { now: NOW }));
  await saveLearningCard(home, distillMissionCard(contract({ id: "mc_idem" }), { now: NOW }));

  const cards = await listLearningCards(home);
  assert.equal(cards.length, 1, "one mission → one card");
  assert.equal(await learningCardExists(home, learningCardId("mc_idem")), true);
  const loaded = await loadLearningCard(home, learningCardId("mc_idem"));
  assert.equal(loaded.missionContractId, "mc_idem");
});

// ── 4. memory feed writes once ───────────────────────────────────────────────

test("learning card: the memory feed writes exactly once per card", async () => {
  const store = MemoryStore.memory();
  const card = distillMissionCard(contract({ id: "mc_mem" }), { now: NOW });
  const text = learningCardMemoryText(card);

  const first = await recordCardMemoryOnce(store, { id: card.id, summary: text, tags: card.tags });
  const second = await recordCardMemoryOnce(store, { id: card.id, summary: text, tags: card.tags });

  assert.equal(first, true, "first write lands");
  assert.equal(second, false, "second is a no-op");
  const lessonNodes = store.all().filter((n) => n.source === card.id);
  assert.equal(lessonNodes.length, 1, "exactly one lesson memory");
  assert.equal(lessonNodes[0].kind, "procedural");
  assert.ok(lessonNodes[0].tags.includes("lesson"));
});

// ── 5. listing / status ──────────────────────────────────────────────────────

test("learning card: lessons list newest-first and load by id", async () => {
  const home = await makeHome();
  await saveLearningCard(home, distillMissionCard(contract({ id: "mc_a", intent: "alpha task" }), { now: new Date("2026-06-01T00:00:00.000Z") }));
  await saveLearningCard(home, distillMissionCard(contract({ id: "mc_b", intent: "beta task" }), { now: new Date("2026-06-02T00:00:00.000Z") }));

  const cards = await listLearningCards(home);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].missionContractId, "mc_b", "newest first");
});

// ── 6. Ghost Continue surfaces a relevant lesson ─────────────────────────────

test("learning card: Ghost Continue surfaces a relevant lesson by tag overlap", () => {
  const installer = distillMissionCard(contract({ id: "mc_inst", intent: "Build the Windows installer" }), { now: NOW });
  const blog = distillMissionCard(contract({ id: "mc_blog", intent: "Write a marketing blog post" }), { now: NOW });

  const relevant = selectRelevantLessons([installer, blog], ["fix the installer signing flow"], 3);
  assert.ok(relevant.length >= 1);
  assert.equal(relevant[0].missionContractId, "mc_inst", "the installer lesson matched, not the blog");

  const summary = summarizeContinuity({ contracts: [], lessons: relevant.map((c) => `[${c.result}] ${c.intent}`) });
  assert.ok(summary.lessons.length >= 1);
  assert.match(summary.lessons[0], /installer/i);
});
