// The gauntlet on a schedule — runScheduledGauntlet() is the headless entry
// the Garrison's `gauntlet` hook calls nightly: run the suite, write the
// report + scoreboard row under <home>/gauntlet, judge against history, and
// return the summary + gate result. Runs here in mock mode.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CODING_GAUNTLET } from "../packages/operator/dist/index.js";
import {
  gauntletSchedulePath,
  loadGauntletSchedule,
  nextGauntletRunDelayMs,
  parseGauntletSchedule,
  runScheduledGauntlet,
  saveGauntletSchedule,
} from "../packages/cli/dist/entry/scheduledGauntlet.js";
import { runScheduledGauntlet as viaAgentOps } from "../packages/cli/dist/entry/agentOps.js";

const HOUR = 3_600_000;

test("schedule specs: nightly/weekly/hours/days/limited cron parse; garbage and off do not", () => {
  assert.deepEqual(parseGauntletSchedule("nightly"), { everyMs: 24 * HOUR, atHour: 3, atMinute: 0 });
  assert.deepEqual(parseGauntletSchedule("weekly"), { everyMs: 7 * 24 * HOUR, atHour: 3, atMinute: 0 });
  assert.deepEqual(parseGauntletSchedule("6h"), { everyMs: 6 * HOUR });
  assert.deepEqual(parseGauntletSchedule("12"), { everyMs: 12 * HOUR });
  assert.deepEqual(parseGauntletSchedule("2d"), { everyMs: 48 * HOUR });
  assert.deepEqual(parseGauntletSchedule("30 2 * * *"), { everyMs: 24 * HOUR, atHour: 2, atMinute: 30 });
  assert.deepEqual(parseGauntletSchedule("0 4 * * 0"), { everyMs: 7 * 24 * HOUR, atHour: 4, atMinute: 0 });
  assert.equal(parseGauntletSchedule("off"), null);
  assert.equal(parseGauntletSchedule("*/5 * * * *"), null, "richer cron is rejected rather than misread");
  assert.equal(parseGauntletSchedule("soon"), null);
  assert.equal(parseGauntletSchedule("0h"), null);
  assert.equal(parseGauntletSchedule("0.1h").everyMs, HOUR, "floors at one hour");
});

test("next run aligns to the wall-clock hour when one is named", () => {
  const now = new Date(2026, 8, 1, 10, 0, 0, 0); // 10:00 local
  const nightly = { everyMs: 24 * HOUR, atHour: 3, atMinute: 0 };
  assert.equal(nextGauntletRunDelayMs(nightly, now), 17 * HOUR);
  const later = { everyMs: 24 * HOUR, atHour: 11, atMinute: 30 };
  assert.equal(nextGauntletRunDelayMs(later, now), 1.5 * HOUR);
  assert.equal(nextGauntletRunDelayMs({ everyMs: 6 * HOUR }, now), 6 * HOUR, "no hour → plain cadence");
});

test("schedule persists under <home>/gauntlet/schedule.json and clears with null", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-gauntlet-sched-"));
  assert.equal(await loadGauntletSchedule(home), null);
  const saved = await saveGauntletSchedule(home, { ...parseGauntletSchedule("nightly"), spec: "nightly", suite: "coding-v3", gate: true, updatedAt: "now" });
  assert.equal(saved.suite, "coding-v3");
  assert.ok(existsSync(gauntletSchedulePath(home)));
  const loaded = await loadGauntletSchedule(home);
  assert.equal(loaded.everyMs, 24 * HOUR);
  assert.equal(loaded.atHour, 3);
  assert.equal(loaded.gate, true);
  await saveGauntletSchedule(home, null);
  assert.equal(await loadGauntletSchedule(home), null);
});

test("runScheduledGauntlet (mock): scores, writes the report + scoreboard, gates against its own history", { timeout: 180_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ares-gauntlet-headless-"));
  const tasks = [CODING_GAUNTLET[0]];
  const first = await runScheduledGauntlet({ suite: "coding-v1", provider: "mock", model: "mock-echo", gate: true, home, tasks, trigger: "schedule" });
  assert.equal(first.report.suite, "coding-v1");
  assert.equal(first.report.provider, "mock-echo");
  assert.equal(first.report.complete, true);
  assert.equal(first.report.tasks.length, 1);
  assert.equal(first.report.total, 0, "an echo bot fixes nothing");
  assert.equal(first.recorded, true);
  assert.equal(first.gated, false, "a first run has no history to regress against");
  assert.equal(first.regression?.confidence, "none");
  assert.equal(first.report.harnessManifest.trigger, "schedule");
  assert.ok(existsSync(first.reportFile), "per-run report written");
  assert.equal(first.scoreboardFile, path.join(home, "gauntlet", "scoreboard.jsonl"));
  const rows = readFileSync(first.scoreboardFile, "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).suite, "coding-v1");
  assert.match(first.summary, /^Gauntlet coding-v1: 0% on mock-echo via mock-echo/);
  assert.match(first.summary, /becomes the baseline/);
  assert.deepEqual(first.nightly, { passed: 0, total: 1, gateOk: true, suite: "coding-v1", provider: "mock-echo", model: "mock-echo" }, "the Garrison ledger shape is ready to hand over");

  // Second run judges against the first and appends a second row.
  const second = await viaAgentOps({ suite: "coding-v1", provider: "mock", gate: true, home, tasks });
  assert.ok(second.regression, "history exists now");
  assert.equal(second.regression.baselineRuns, 1);
  assert.equal(second.gated, false, "an identical run is not a regression");
  assert.equal(readFileSync(second.scoreboardFile, "utf8").trim().split("\n").length, 2);
  assert.match(second.summary, /(no regression|advisory|REGRESSION)/);

  await assert.rejects(() => runScheduledGauntlet({ suite: "coding-v99", provider: "mock", home }), /unknown gauntlet suite/);
});
