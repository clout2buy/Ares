// Verifies the World Graph seed (Nexus Phase 1) — the pure entity-graph
// assembler that links Crix's universe: itself, the project, subsystems,
// missions, goals, lessons, and crystallized memories.

import test from "node:test";
import assert from "node:assert/strict";

import { assembleWorldGraph, CRIX_SUBSYSTEMS } from "../packages/operator/dist/index.js";

const mission = (id, intent, extra = {}) => ({
  id,
  intent,
  goalId: extra.goalId,
  progress: { status: extra.status ?? "active", percent: extra.percent ?? 0, completedCriteria: 0, totalCriteria: 3 },
  updatedAt: extra.updatedAt ?? "2026-06-05T00:00:00.000Z",
});
const goal = (id, statement) => ({ id, statement, status: "active" });
const lesson = (contractId, intent) => ({ id: `lc_${contractId}`, intent, result: "success", confidence: 0.7, tags: [] });
const memNode = (id, content, tags = []) => ({ id, kind: "semantic", content, tags, source: "synthesis" });

const findEntity = (g, kind, ref) => g.entities.find((e) => e.kind === kind && e.ref === ref);
const hasRel = (g, from, to, kind) => g.relations.some((r) => r.from === from && r.to === to && r.kind === kind);

test("world graph: crix embodies the project; every subsystem is part-of it", () => {
  const g = assembleWorldGraph({ contracts: [], goals: [], lessons: [], memory: [], subsystems: CRIX_SUBSYSTEMS });
  assert.ok(findEntity(g, "crix", "self"));
  const project = g.entities.find((e) => e.kind === "project");
  assert.ok(project, "a project entity exists");
  assert.ok(hasRel(g, "crix:self", project.id, "embodies"));
  assert.equal(g.counts.subsystem, CRIX_SUBSYSTEMS.length);
  for (const s of g.entities.filter((e) => e.kind === "subsystem")) {
    assert.ok(hasRel(g, s.id, project.id, "part-of"), `${s.ref} is part-of the project`);
  }
});

test("world graph: missions serve goals, lessons distil from their mission", () => {
  const g = assembleWorldGraph({
    contracts: [mission("m1", "ship the thing", { goalId: "g1" })],
    goals: [goal("g1", "Ship Crix Nexus")],
    lessons: [lesson("m1", "ship the thing")],
    memory: [],
    subsystems: CRIX_SUBSYSTEMS,
  });
  assert.ok(hasRel(g, "mission:m1", "goal:g1", "serves"));
  assert.ok(hasRel(g, "lesson:lc_m1", "mission:m1", "distilled-from"));
  assert.equal(g.counts.mission, 1);
  assert.equal(g.counts.goal, 1);
  assert.equal(g.counts.lesson, 1);
});

test("world graph: a voice mission links to the voice subsystem", () => {
  const g = assembleWorldGraph({
    contracts: [mission("m2", "build push-to-talk voice input")],
    goals: [],
    lessons: [],
    memory: [],
    subsystems: CRIX_SUBSYSTEMS,
  });
  assert.ok(hasRel(g, "mission:m2", "subsystem:voice", "relates-to"), "voice mission relates to the voice subsystem");
});

test("world graph: crystallized memory becomes an entity and links by domain", () => {
  const g = assembleWorldGraph({
    contracts: [mission("m3", "fix the memory recall ranking")],
    goals: [],
    lessons: [],
    memory: [memNode("mem1", "Recurring failure mode (recall, memory): verify before claiming done", ["belief:recall+memory"])],
    subsystems: CRIX_SUBSYSTEMS,
  });
  assert.ok(findEntity(g, "memory", "mem1"), "memory entity created");
  assert.ok(hasRel(g, "memory:mem1", "subsystem:mind", "relates-to"), "memory links to the mind subsystem");
  assert.ok(hasRel(g, "memory:mem1", "mission:m3", "about"), "memory is about the recall mission");
});

test("world graph: empty world still maps crix + project + subsystems", () => {
  const g = assembleWorldGraph({ contracts: [], goals: [], lessons: [], memory: [], subsystems: CRIX_SUBSYSTEMS });
  assert.equal(g.counts.mission, 0);
  assert.equal(g.counts.lesson, 0);
  assert.equal(g.counts.crix, 1);
  assert.equal(g.counts.project, 1);
  assert.ok(g.counts.subsystem > 0);
});

test("world graph: pure — same input yields identical output, inputs untouched", () => {
  const contracts = [mission("m1", "voice input")];
  const input = { contracts, goals: [], lessons: [], memory: [], subsystems: CRIX_SUBSYSTEMS };
  const a = assembleWorldGraph(input);
  const b = assembleWorldGraph(input);
  assert.deepEqual(a, b);
  assert.equal(contracts.length, 1, "inputs not mutated");
});
