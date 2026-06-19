// Standing orders — durable recurring missions. Storage CRUD, due-selection,
// cadence clamping, and materialization into goals.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  addStandingOrder,
  loadStandingOrders,
  removeStandingOrder,
  setStandingOrderEnabled,
  dueStandingOrders,
  materializeDueStandingOrders,
  normalizeStandingOrder,
  MIN_CADENCE_MS,
} from "../packages/operator/dist/index.js";
import { activeGoals } from "../packages/operator/dist/index.js";

async function tmpHome() {
  return mkdtemp(path.join(tmpdir(), "ares-standing-"));
}

test("normalizeStandingOrder clamps cadence to the floor", () => {
  const o = normalizeStandingOrder({ statement: "do a thing", cadenceMs: 1000 });
  assert.equal(o.cadenceMs, MIN_CADENCE_MS);
  assert.equal(o.enabled, true);
  assert.equal(o.runCount, 0);
});

test("add / load / remove round-trips through disk", async () => {
  const home = await tmpHome();
  try {
    const o = await addStandingOrder(home, { statement: "Summarize new important email", cadenceMs: 2 * 3_600_000 });
    let all = await loadStandingOrders(home);
    assert.equal(all.length, 1);
    assert.equal(all[0].statement, "Summarize new important email");
    assert.equal(all[0].cadenceMs, 2 * 3_600_000);

    const removed = await removeStandingOrder(home, o.id);
    assert.equal(removed, true);
    all = await loadStandingOrders(home);
    assert.equal(all.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dueStandingOrders: never-run is due; recently-run is not; disabled never", () => {
  const now = new Date("2026-06-17T12:00:00Z");
  const base = { schemaVersion: 1, cadenceMs: 3_600_000, runCount: 0, createdAt: now.toISOString() };
  const orders = [
    { ...base, id: "a", statement: "never run", enabled: true },
    { ...base, id: "b", statement: "ran 2h ago", enabled: true, lastRunAt: new Date(now.getTime() - 2 * 3_600_000).toISOString() },
    { ...base, id: "c", statement: "ran 5m ago", enabled: true, lastRunAt: new Date(now.getTime() - 5 * 60_000).toISOString() },
    { ...base, id: "d", statement: "disabled", enabled: false },
  ];
  const due = dueStandingOrders(orders, now).map((o) => o.id);
  assert.deepEqual(due.sort(), ["a", "b"]);
});

test("setStandingOrderEnabled toggles persistence", async () => {
  const home = await tmpHome();
  try {
    const o = await addStandingOrder(home, { statement: "watch the repo", cadenceMs: 3_600_000 });
    assert.equal(await setStandingOrderEnabled(home, o.id, false), true);
    const all = await loadStandingOrders(home);
    assert.equal(all[0].enabled, false);
    assert.equal(await setStandingOrderEnabled(home, "nope", true), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("materializeDueStandingOrders creates goals and stamps lastRunAt", async () => {
  const home = await tmpHome();
  try {
    await addStandingOrder(home, { statement: "Research AI news and brief me", cadenceMs: 3_600_000 });
    const now = new Date();
    const { goals, fired } = await materializeDueStandingOrders(home, now);
    assert.equal(goals.length, 1);
    assert.equal(fired.length, 1);
    assert.equal(goals[0].statement, "Research AI news and brief me");
    assert.equal(goals[0].status, "active");

    // The goal is now an active operator goal.
    const active = await activeGoals(home);
    assert.equal(active.length, 1);

    // Re-running immediately should NOT re-fire (cadence not elapsed).
    const second = await materializeDueStandingOrders(home, new Date(now.getTime() + 1000));
    assert.equal(second.fired.length, 0);

    // The order recorded its run.
    const orders = await loadStandingOrders(home);
    assert.equal(orders[0].runCount, 1);
    assert.ok(orders[0].lastRunAt);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
