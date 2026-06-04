// Auto-emit Mission Learning Cards on completion (Phase B follow-up).
//
// Proves the reflex fires correctly and exactly once:
//   1. a terminal (satisfied) contract auto-emits a card + one memory, idempotently
//   2. a non-terminal contract emits nothing (no I/O)
//   3. an abandoned contract emits an abandoned card
//   4. completing a real mission via recordGoalProbeResult auto-emits once,
//      and repeated completion never duplicates the card or the memory

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  autoEmitLearningCard,
  listLearningCards,
  createMissionContract,
  saveMissionContract,
  recordGoalProbeResult,
} from "../packages/operator/dist/index.js";
import { MemoryStore, mindPaths } from "../packages/mind/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "crix-emit-"));
const NOW = new Date("2026-06-02T00:00:00.000Z");

function fullContract(over = {}) {
  const at = "2026-06-01T00:00:00.000Z";
  const status = over.progressStatus ?? "satisfied";
  const met = status === "satisfied";
  return {
    schemaVersion: 1,
    id: over.id ?? "mc_x",
    goalId: over.goalId,
    intent: over.intent ?? "Build the installer",
    acceptanceCriteria: [{ id: "a1", description: "it works", status: met ? "met" : "pending", evidenceIds: [] }],
    constraints: [],
    verificationProbes: [],
    verificationProbeResults: [],
    progress: { status, completedCriteria: met ? 1 : 0, totalCriteria: 1, percent: met ? 100 : 0, updatedAt: at },
    blockers: [],
    evidenceLog: [],
    createdAt: at,
    updatedAt: at,
  };
}

const lessonNodes = async (file, source) => (await MemoryStore.open(file)).all().filter((n) => n.source === source);

// ── 1. terminal → emits once, idempotent ──────────────────────────────────────

test("auto-emit: a satisfied contract emits a card + one memory, idempotently", async () => {
  const home = await makeHome();
  const memoryFile = path.join(home, "memory.jsonl");
  const contract = fullContract({ id: "mc_sat" });

  const card = await autoEmitLearningCard(home, contract, { now: NOW, memoryFile });
  assert.ok(card, "a card was emitted");
  assert.equal(card.result, "success");
  assert.equal((await listLearningCards(home)).length, 1);
  assert.equal((await lessonNodes(memoryFile, card.id)).length, 1);

  // Completing again (e.g. another probe) must not duplicate.
  await autoEmitLearningCard(home, contract, { now: NOW, memoryFile });
  assert.equal((await listLearningCards(home)).length, 1, "card not duplicated");
  assert.equal((await lessonNodes(memoryFile, card.id)).length, 1, "memory not duplicated");
});

// ── 2. non-terminal → nothing ─────────────────────────────────────────────────

test("auto-emit: a non-terminal contract emits nothing", async () => {
  const home = await makeHome();
  const memoryFile = path.join(home, "memory.jsonl");
  const card = await autoEmitLearningCard(home, fullContract({ id: "mc_active", progressStatus: "active" }), { now: NOW, memoryFile });
  assert.equal(card, null);
  assert.equal((await listLearningCards(home)).length, 0);
});

// ── 3. abandoned → abandoned card ─────────────────────────────────────────────

test("auto-emit: an abandoned contract emits an abandoned card", async () => {
  const home = await makeHome();
  const memoryFile = path.join(home, "memory.jsonl");
  const card = await autoEmitLearningCard(home, fullContract({ id: "mc_aband", progressStatus: "abandoned" }), { now: NOW, memoryFile });
  assert.ok(card);
  assert.equal(card.result, "abandoned");
  assert.equal((await listLearningCards(home)).length, 1);
});

// ── 4. real completion path through recordGoalProbeResult ─────────────────────

test("auto-emit: completing a mission auto-emits once and never duplicates", async () => {
  const home = await makeHome();
  const probe = { kind: "always", met: true };
  const contract = createMissionContract({ id: "mc_int", intent: "ship the thing", acceptanceCriteria: ["it works"], verificationProbes: [probe] });
  await saveMissionContract(home, contract);

  const next = await recordGoalProbeResult(home, contract, probe, { met: true, summary: "verified" }, NOW);
  assert.equal(next.progress.status, "satisfied", "the mission completed");

  const cards = await listLearningCards(home);
  assert.equal(cards.length, 1, "completion auto-emitted the lesson");
  assert.equal(cards[0].result, "success");
  const memoryFile = mindPaths(home).memoryFile;
  assert.equal((await lessonNodes(memoryFile, cards[0].id)).length, 1);

  // Recording another probe result on the already-satisfied contract → no dupe.
  await recordGoalProbeResult(home, next, probe, { met: true, summary: "verified again" }, NOW);
  assert.equal((await listLearningCards(home)).length, 1, "repeated completion does not duplicate the card");
  assert.equal((await lessonNodes(memoryFile, cards[0].id)).length, 1, "nor the memory");
});
