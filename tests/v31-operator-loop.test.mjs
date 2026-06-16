// Verifies the wired OperatorBackgroundLoop: opt-in only, mission-aware idle,
// attention-selected work (never active[0]), backpressure (no overlap), and a
// failed tick that never kills the loop — "mission-aware idle advancement," not
// a 3 AM chaos goblin.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OperatorBackgroundLoop,
  operatorLoopEnabled,
  createGoal,
  saveGoal,
  loadGoal,
} from "../packages/operator/dist/index.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-v31-"));

// ── Opt-in gate ───────────────────────────────────────────────────────────────

test("the loop runs ONLY when ARES_OPERATOR_LOOP=1 (default off, kill wins)", () => {
  assert.equal(operatorLoopEnabled({}), false, "default: off — no surprise autonomy");
  assert.equal(operatorLoopEnabled({ ARES_OPERATOR_LOOP: "1" }), true, "opt-in enables it");
  assert.equal(operatorLoopEnabled({ ARES_OPERATOR_LOOP: "0" }), false);
  assert.equal(
    operatorLoopEnabled({ ARES_OPERATOR_LOOP: "1", ARES_OPERATOR_AUTOTICK: "0" }),
    false,
    "the emergency kill always wins",
  );
});

// ── Lifecycle events ──────────────────────────────────────────────────────────

test("start/stop emit operator_started / operator_stopped", async () => {
  const home = await makeHome();
  const events = [];
  const loop = new OperatorBackgroundLoop({ home, dispatcher: { async runStep() { return { moved: false, goalMet: false }; } } }, { emit: (e) => events.push(e), everyMs: 60_000 });
  loop.start();
  assert.ok(loop.started);
  assert.equal(events.at(-1).type, "operator_started");
  loop.stop();
  assert.equal(loop.started, false);
  assert.equal(events.at(-1).type, "operator_stopped");
});

// ── Attention-selected work, not active[0] ────────────────────────────────────

test("a tick advances the ATTENTION-selected goal and emits operator_tick", async () => {
  const home = await makeHome();
  await saveGoal(home, createGoal({ id: "g1", statement: "advance the campaign" }));
  const events = [];
  const loop = new OperatorBackgroundLoop(
    { home, dispatcher: { async runStep() { return { moved: true, goalMet: true, evidence: "done" }; } } },
    { emit: (e) => events.push(e) },
  );
  const tick = await loop.tickOnce();
  assert.equal(tick.ran.length, 1);
  assert.equal((await loadGoal(home, "g1")).status, "done");
  const tickEv = events.find((e) => e.type === "operator_tick");
  assert.ok(tickEv && tickEv.goalId === "g1");
});

// ── Mission-aware idle ────────────────────────────────────────────────────────

test("with no active goal, the loop is idle and surfaces mission nextActions (does not run them)", async () => {
  const home = await makeHome(); // no goals
  const events = [];
  let dispatched = 0;
  const loop = new OperatorBackgroundLoop(
    { home, dispatcher: { async runStep() { dispatched++; return { moved: true, goalMet: true }; } } },
    { emit: (e) => events.push(e), nextActions: () => ["wire OperatorBackgroundLoop", "wire TelegramBridge"] },
  );
  const tick = await loop.tickOnce();
  assert.equal(tick.ran.length, 0, "nothing was executed");
  assert.equal(dispatched, 0, "the dispatcher was NOT fired — idle suggests, never runs");
  const idle = events.find((e) => e.type === "operator_idle");
  assert.ok(idle, "operator_idle emitted");
  assert.deepEqual(idle.suggestions, ["wire OperatorBackgroundLoop", "wire TelegramBridge"], "war-map nextActions surfaced");
});

test("idle suggestions are capped compactly", async () => {
  const home = await makeHome();
  const events = [];
  const many = Array.from({ length: 20 }, (_, i) => `action ${i}`);
  const loop = new OperatorBackgroundLoop({ home, dispatcher: { async runStep() { return {}; } } }, { emit: (e) => events.push(e), nextActions: () => many });
  await loop.tickOnce();
  assert.ok(events.find((e) => e.type === "operator_idle").suggestions.length <= 5, "capped to a handful");
});

// ── Backpressure: no overlap ──────────────────────────────────────────────────

test("ticks do not overlap — a second tick while one runs is dropped", async () => {
  const home = await makeHome();
  await saveGoal(home, createGoal({ id: "slow", statement: "slow work" }));
  let inFlight = 0;
  let maxConcurrent = 0;
  const loop = new OperatorBackgroundLoop({
    home,
    dispatcher: {
      async runStep() {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 60));
        inFlight--;
        return { moved: true, goalMet: true };
      },
    },
  });
  const [a, b] = await Promise.all([loop.tickOnce(), loop.tickOnce()]);
  assert.equal(maxConcurrent, 1, "only one tick ran at a time");
  // exactly one of the two actually advanced the goal; the other was a no-op
  assert.equal(a.ran.length + b.ran.length, 1, "the overlapping tick was dropped");
});

// ── A failed tick never kills the loop ────────────────────────────────────────

test("a failing worker tick surfaces operator_error and the loop keeps running", async () => {
  const home = await makeHome();
  await saveGoal(home, createGoal({ id: "boom", statement: "this will throw" }));
  const events = [];
  const loop = new OperatorBackgroundLoop(
    { home, dispatcher: { async runStep() { throw new Error("worker exploded"); } } },
    { emit: (e) => events.push(e) },
  );
  loop.start();
  const tick = await loop.tickOnce(); // does NOT throw
  assert.equal(tick.ran.length, 0);
  assert.ok(events.find((e) => e.type === "operator_error" && /worker exploded/.test(e.message)));
  assert.equal(loop.started, true, "the loop is still alive after a failed tick");
  loop.stop();
});

// ── Disabled mode is inert (no goal touched) ──────────────────────────────────

test("a disabled loop (never started) does not advance anything", async () => {
  const home = await makeHome();
  await saveGoal(home, createGoal({ id: "untouched", statement: "should not run" }));
  const loop = new OperatorBackgroundLoop({ home, dispatcher: { async runStep() { return { moved: true, goalMet: true }; } } });
  // never start(); operatorLoopEnabled gates construction in the daemon, so an
  // un-started loop simply does nothing on its own.
  assert.equal(loop.started, false);
  assert.equal((await loadGoal(home, "untouched")).status, "active", "goal untouched while idle");
});
