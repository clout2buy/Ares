// Verifies the mission loop — the autonomy spine:
//   1. Pure engine: create -> plan -> execute -> verify(pass) completes.
//   2. verify(fail) loops (re-opens planning, increments iteration).
//   3. Iteration budget exhaustion abandons instead of spinning forever.
//   4. nextDirective reports the right phase at each stage.
//   5. Mission tool persists across calls and emits lifecycle gains.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MissionTool,
  createMission,
  planMission,
  startNextStep,
  completeStep,
  verifyMission,
  nextDirective,
  loadMission,
  listMissions,
  onLifecycle,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "crix-mission-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const ctx = { workspace: process.cwd(), signal: new AbortController().signal };

test("engine: create -> plan -> execute -> verify(pass) completes", () => {
  let m = createMission({ id: "m1", goal: "ship the thing" });
  assert.equal(m.status, "planning");
  assert.equal(nextDirective(m).phase, "plan");

  m = planMission(m, ["write code", "run tests"]);
  assert.equal(m.status, "executing");
  assert.equal(m.steps.length, 2);

  const started = startNextStep(m);
  assert.equal(started.step.title, "write code");
  m = started.mission;
  assert.equal(nextDirective(m).phase, "execute");

  m = completeStep(m, "code written");
  m = completeStep(m, "tests green");
  assert.equal(m.status, "verifying");
  assert.equal(nextDirective(m).phase, "verify");

  const verified = verifyMission(m, { passed: true, verdict: "goal met" });
  assert.equal(verified.outcome, "completed");
  assert.equal(verified.mission.status, "completed");
  assert.equal(nextDirective(verified.mission).phase, "done");
});

test("engine: verify(fail) loops and re-opens planning with incremented iteration", () => {
  let m = createMission({ id: "m2", goal: "make it pass", steps: ["attempt"] });
  m = completeStep(m, "tried");
  assert.equal(m.status, "verifying");

  const r = verifyMission(m, { passed: false, verdict: "still broken" });
  assert.equal(r.outcome, "looped");
  assert.equal(r.mission.status, "planning");
  assert.equal(r.mission.iterations, 1);
  assert.equal(nextDirective(r.mission).phase, "loop");
});

test("engine: iteration budget exhaustion abandons", () => {
  let m = createMission({ id: "m3", goal: "impossible", steps: ["try"], maxIterations: 2 });
  // iteration 1 -> loop
  let r = verifyMission(completeStep(m, "x"), { passed: false, verdict: "no" });
  assert.equal(r.outcome, "looped");
  // re-plan + iteration 2 -> exhausts budget -> abandoned
  m = planMission(r.mission, ["try harder"]);
  m = completeStep(m, "y");
  r = verifyMission(m, { passed: false, verdict: "still no" });
  assert.equal(r.outcome, "abandoned");
  assert.equal(r.mission.status, "abandoned");
});

test("engine: planMission preserves completed steps", () => {
  let m = createMission({ id: "m4", goal: "g", steps: ["a", "b"] });
  m = completeStep(m, "did a"); // a done, b pending
  m = planMission(m, ["c"]); // replace open tail (b) with c, keep a
  const titles = m.steps.map((s) => s.title);
  assert.deepEqual(titles, ["a", "c"]);
  assert.equal(m.steps[0].status, "done");
});

test("tool: mission persists across calls and emits lifecycle gains", async () => {
  const home = await makeTmp();
  process.env.CRIX_HOME = home;
  const seen = [];
  const off = onLifecycle((e) => {
    if (e.type.startsWith("mission_")) seen.push(e.type);
  });
  try {
    const created = await MissionTool.call({ action: "create", goal: "automate the report", steps: ["fetch", "format"] }, ctx);
    const id = created.output.missionId;
    assert.ok(id, "mission id returned");
    assert.equal(created.output.status, "executing");

    // Persisted to disk
    const onDisk = await loadMission(home, id);
    assert.ok(onDisk, "mission written to ~/.crix/missions");
    assert.equal(onDisk.goal, "automate the report");

    // Advance + complete both steps (defaults to active mission, no id needed)
    await MissionTool.call({ action: "next" }, ctx);
    await MissionTool.call({ action: "step_done", result: "fetched" }, ctx);
    await MissionTool.call({ action: "step_done", result: "formatted" }, ctx);

    const status = await MissionTool.call({ action: "status" }, ctx);
    assert.equal(status.output.status, "verifying");

    const verified = await MissionTool.call({ action: "verify", passed: true, result: "report runs" }, ctx);
    assert.equal(verified.output.status, "completed");

    assert.ok(seen.includes("mission_started"), "emitted mission_started");
    assert.ok(seen.includes("mission_step_completed"), "emitted mission_step_completed");
    assert.ok(seen.includes("mission_completed"), "emitted mission_completed");

    const all = await listMissions(home);
    assert.equal(all.length, 1);
    assert.equal(all[0].status, "completed");
  } finally {
    off();
    delete process.env.CRIX_HOME;
  }
});

test("tool: list is empty with no missions, create requires a goal", async () => {
  const home = await makeTmp();
  process.env.CRIX_HOME = home;
  try {
    const empty = await MissionTool.call({ action: "list" }, ctx);
    assert.equal(empty.output.missions.length, 0);
    await assert.rejects(() => MissionTool.call({ action: "create" }, ctx), /requires a goal/);
  } finally {
    delete process.env.CRIX_HOME;
  }
});
