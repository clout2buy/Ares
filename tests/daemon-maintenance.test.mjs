// The maintenance tenant: the plugin kernel's first production resident.
//
// Field origin: the 2026-08-25 OOM night — the heap climbed 3015→4006MB over
// five idle minutes and the crash artifacts could not say which maintenance
// job was running, because every job was an anonymous setInterval. These
// tests pin the properties that make the plugin version better than the raw
// timers it replaced: a ledger that keeps only noteworthy runs, a re-entry
// guard so slow ticks never stack, error containment that RECORDS instead of
// swallowing, and teardown that provably stops the clock.
//
// Deliberately event-driven, not timing-bound: assertions wait for
// conditions, never for exact tick counts — the release gate's standing
// weakness is timing tests under load, and this suite must not add to it.

import test from "node:test";
import assert from "node:assert/strict";

import { PluginHost } from "../packages/plugins/dist/index.js";
import {
  MAINTENANCE_LEDGER_SERVICE,
  MaintenanceLedger,
  maintenanceLedgerPlugin,
  maintenanceTimerPlugin,
} from "../packages/cli/dist/entry/daemonMaintenance.js";

const until = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition never became true");
};

test("ledger: bounded ring, newest first", () => {
  const ledger = new MaintenanceLedger(3);
  for (let i = 1; i <= 5; i++) ledger.record({ job: `j${i}`, at: i, durationMs: 1 });
  const snap = ledger.snapshot(10);
  assert.deepEqual(snap.map((r) => r.job), ["j5", "j4", "j3"], "oldest two fell off, newest leads");
});

test("a run that returns a note lands on the ledger; a quiet fast run stays off", async () => {
  const host = new PluginHost();
  await host.mount(maintenanceLedgerPlugin());
  let runs = 0;
  await host.mount(maintenanceTimerPlugin({
    name: "selective",
    everyMs: 25,
    noteworthyMs: 60_000, // duration alone can never qualify in this test
    task: () => {
      runs++;
      return runs === 2 ? "did something" : undefined;
    },
  }));
  const ledger = host.service(MAINTENANCE_LEDGER_SERVICE);
  await until(() => runs >= 3);
  await until(() => ledger.snapshot().length === 1);
  const [only] = ledger.snapshot();
  assert.equal(only.job, "selective");
  assert.equal(only.note, "did something");
  await host.dispose();
});

test("a throwing task is contained AND recorded — better than the swallow it replaced", async () => {
  const host = new PluginHost();
  await host.mount(maintenanceLedgerPlugin());
  await host.mount(maintenanceTimerPlugin({
    name: "faulty",
    everyMs: 25,
    task: () => {
      throw new Error("sweep exploded");
    },
  }));
  const ledger = host.service(MAINTENANCE_LEDGER_SERVICE);
  await until(() => ledger.snapshot().some((run) => /error: sweep exploded/.test(run.note ?? "")));
  await host.dispose();
});

test("re-entry guard: a slow tick never stacks a second run on itself", async () => {
  const host = new PluginHost();
  await host.mount(maintenanceLedgerPlugin());
  let inFlight = 0;
  let maxInFlight = 0;
  let completed = 0;
  await host.mount(maintenanceTimerPlugin({
    name: "slow",
    everyMs: 25,
    task: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 80));
      inFlight--;
      completed++;
    },
  }));
  await until(() => completed >= 2);
  assert.equal(maxInFlight, 1, "overlapping ticks are the 630MB-of-concurrent-churn bug; never again");
  await host.dispose();
});

test("initialDelayMs fires one early run before the interval comes due", async () => {
  const host = new PluginHost();
  await host.mount(maintenanceLedgerPlugin());
  let runs = 0;
  await host.mount(maintenanceTimerPlugin({
    name: "boot-check",
    everyMs: 60 * 60 * 1000, // the interval alone would never fire in this test
    initialDelayMs: 25,
    task: () => {
      runs++;
      return "boot run";
    },
  }));
  await until(() => runs >= 1);
  await host.dispose();
});

test("unmount stops the clock — nothing runs after teardown", async () => {
  const host = new PluginHost();
  await host.mount(maintenanceLedgerPlugin());
  let runs = 0;
  await host.mount(maintenanceTimerPlugin({ name: "stoppable", everyMs: 25, task: () => void runs++ }));
  await until(() => runs >= 1);
  await host.unmount("maintenance:stoppable");
  const after = runs;
  // clearInterval is synchronous in unmount's cleanup: once unmount resolves,
  // no further firing is POSSIBLE — this wait only proves it, generously.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(runs, after, "the timer died with its plugin");
  await host.dispose();
});

test("the timer plugin parks pending until the ledger exists — spatial dependency, not load order", async () => {
  const host = new PluginHost();
  let runs = 0;
  const status = await host.mount(maintenanceTimerPlugin({ name: "early", everyMs: 25, task: () => void runs++ }));
  assert.equal(status.state, "pending");
  assert.deepEqual(status.waitingOn, [MAINTENANCE_LEDGER_SERVICE]);
  await host.mount(maintenanceLedgerPlugin());
  assert.equal(host.statusOf("maintenance:early").state, "active");
  await until(() => runs >= 1);
  await host.dispose();
});
