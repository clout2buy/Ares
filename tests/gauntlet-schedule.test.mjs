// The nightly gauntlet on the Garrison scheduler — fake clock, fake runner.
//
//   1. fires exactly once per local night inside the ARES_GAUNTLET_HOUR window
//   2. skips while a turn is active, then fires on a later check the same night
//   3. a regression writes a triage finding under <home>/triage/findings and
//      emits gauntlet_regression on the scheduler's event stream
//   4. ARES_GAUNTLET_SCHEDULE=0 (or gauntletEnabled:false) wires no timer
//   5. the trend ledger accumulates one line per night; the first night is the baseline

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Scheduler, gauntletFindingId } from "../packages/garrison/dist/index.js";
import { readGauntletTrend, gauntletTrendFile } from "../packages/operator/dist/index.js";

/** Local-time epoch for a given hour on a fixed day — the window is judged in local time. */
const at = (hour, minute = 0, dayOffset = 0) => new Date(2026, 8, 1 + dayOffset, hour, minute, 0, 0).getTime();
const settle = () => new Promise((r) => setTimeout(r, 0));
/** The gauntlet hook persists to disk (real fs I/O), so a 0-ms settle is a race — poll a predicate instead. */
async function waitFor(predicate, label, deadlineMs = 5000) {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > deadlineMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeTimers() {
  const intervals = [];
  return {
    intervals,
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms };
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn: (handle) => {
      intervals.splice(intervals.indexOf(handle), 1);
    },
  };
}

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-gauntlet-sched-"));
}

test("gauntlet schedule: fires once per night inside the window, skips while busy", async () => {
  const home = await tempHome();
  const timers = fakeTimers();
  let now = at(1, 0);
  let busy = 0;
  let runs = 0;
  const events = [];
  const sched = new Scheduler({
    hooks: { gauntlet: async () => { runs++; return { passed: 6, total: 6, gateOk: true, suite: "coding-v5" }; } },
    home,
    gauntletHour: 3,
    gauntletWindowHours: 3,
    gauntletCheckEveryMs: 600_000,
    gauntletEnabled: true,
    activeTurns: () => busy,
    now: () => now,
    ...timers,
  });
  sched.subscribe((e) => events.push(e));
  sched.start();
  const timer = timers.intervals.find((h) => h.ms === 600_000);
  assert.ok(timer, "one gauntlet check timer");
  assert.equal(sched.nextGauntletAt(), at(3, 0), "window opens at 03:00 local");

  timer.fn();
  await settle();
  assert.equal(runs, 0, "01:00 is before the window");

  now = at(3, 10);
  busy = 1;
  timer.fn();
  await settle();
  assert.equal(runs, 0, "a live turn defers the run");

  now = at(3, 20);
  busy = 0;
  timer.fn();
  await waitFor(() => events.length >= 1, "first gauntlet_run");
  assert.equal(runs, 1, "fires once the daemon is idle inside the window");

  now = at(4, 0);
  timer.fn();
  await settle();
  assert.equal(runs, 1, "never twice the same night");
  assert.equal(sched.nextGauntletAt(), at(3, 0, 1), "next window is tomorrow");

  now = at(7, 0);
  timer.fn();
  await settle();
  assert.equal(runs, 1, "outside the window nothing fires");

  now = at(3, 5, 1);
  timer.fn();
  await waitFor(() => events.length >= 2, "second gauntlet_run");
  assert.equal(runs, 2, "fires again the next night");

  assert.deepEqual(events.map((e) => e.kind), ["gauntlet_run", "gauntlet_run"]);
  assert.equal(events[0].regressed, false);
  const trend = await readGauntletTrend(home);
  assert.equal(trend.length, 2, "one ledger line per night");
  assert.equal(trend[0].passed, 6);
  assert.equal(trend[0].suite, "coding-v5");
  assert.equal(trend[0].source, "nightly");

  sched.stop();
  assert.equal(timers.intervals.length, 0);
  await fs.rm(home, { recursive: true, force: true });
});

test("gauntlet schedule: a busy daemon through the whole window skips the night, not deferring to daytime", async () => {
  const timers = fakeTimers();
  let now = at(3, 0);
  let runs = 0;
  const sched = new Scheduler({
    hooks: { gauntlet: async () => { runs++; return { passed: 1, total: 1, gateOk: true }; } },
    gauntletHour: 3,
    gauntletWindowHours: 2,
    gauntletEnabled: true,
    activeTurns: () => 2,
    now: () => now,
    ...timers,
  });
  sched.start();
  const timer = timers.intervals[0];
  for (const h of [3, 4]) {
    now = at(h, 30);
    timer.fn();
    await settle();
  }
  assert.equal(runs, 0, "busy the whole window");
  now = at(9, 0);
  timer.fn();
  await settle();
  assert.equal(runs, 0, "the window closed — no afternoon benchmark");
  sched.stop();
});

test("gauntlet schedule: a regression writes a triage finding and emits gauntlet_regression", async () => {
  const home = await tempHome();
  const timers = fakeTimers();
  let now = at(3, 30);
  const results = [
    { passed: 6, total: 6, gateOk: true, suite: "coding-v5", model: "m", provider: "p" },
    { passed: 4, total: 6, gateOk: true, suite: "coding-v5", model: "m", provider: "p" },
    { passed: 6, total: 6, gateOk: false, suite: "coding-v5", model: "m", provider: "p" },
  ];
  const events = [];
  const errors = [];
  const sched = new Scheduler({
    hooks: { gauntlet: async () => results.shift() },
    home,
    gauntletHour: 3,
    gauntletEnabled: true,
    now: () => now,
    onError: (hook, err) => errors.push([hook, err]),
    ...timers,
  });
  sched.subscribe((e) => events.push(e));
  sched.start();
  const timer = timers.intervals[0];

  // Night 1: the baseline. No finding.
  timer.fn();
  await waitFor(() => events.length >= 1, "night 1");
  const findingsDir = path.join(home, "triage", "findings");
  assert.equal(await fs.readdir(findingsDir).catch(() => []).then((l) => l.length), 0, "first night is the baseline, no finding");
  assert.equal(events.filter((e) => e.kind === "gauntlet_regression").length, 0);

  // Night 2: pass rate fell 100% → 67%.
  now = at(3, 30, 1);
  timer.fn();
  await waitFor(() => events.filter((e) => e.kind === "gauntlet_run").length >= 2, "night 2");
  const regression = events.find((e) => e.kind === "gauntlet_regression");
  assert.ok(regression, "gauntlet_regression emitted");
  assert.equal(regression.summary.passed, 4);
  assert.deepEqual(regression.previous, { at: events[0].at, passed: 6, total: 6 });
  assert.match(regression.reasons.join("; "), /pass rate fell 100% → 67%/);
  const id = gauntletFindingId("coding-v5");
  assert.match(id, /^rel_[a-f0-9]{16}$/, "finding id in the triage loader's accepted shape");
  assert.equal(regression.findingId, id);
  const finding = JSON.parse(await fs.readFile(path.join(findingsDir, `${id}.json`), "utf8"));
  assert.equal(finding.schemaVersion, 1);
  assert.equal(finding.kind, "gauntlet_regression");
  assert.equal(finding.status, "candidate");
  assert.equal(finding.occurrences, 1);
  assert.equal(finding.evidence.length, 1);
  assert.match(finding.evidence[0].summary, /4\/6 \(67%\) vs 6\/6/);
  assert.match(finding.suggestedAction, /--suite coding-v5/);

  // Night 3: same score as night 2's baseline? No — 6/6 but the gate tripped.
  // The stable id means the SAME finding gains an occurrence instead of a twin.
  now = at(3, 30, 2);
  timer.fn();
  await waitFor(() => events.filter((e) => e.kind === "gauntlet_run").length >= 3, "night 3");
  const again = JSON.parse(await fs.readFile(path.join(findingsDir, `${id}.json`), "utf8"));
  assert.equal(again.occurrences, 2);
  assert.equal(again.recurrenceCount, 1);
  assert.equal(again.evidence.length, 2);
  assert.match(again.evidence[1].summary, /regression gate tripped/);
  assert.equal((await fs.readdir(findingsDir)).length, 1, "one finding file per suite");
  assert.equal(events.filter((e) => e.kind === "gauntlet_regression").length, 2);
  assert.deepEqual(errors, []);

  const trend = await readGauntletTrend(home);
  assert.deepEqual(trend.map((t) => [t.passed, t.regressed]), [[6, false], [4, true], [6, true]]);
  assert.equal(gauntletTrendFile(home), path.join(home, "gauntlet", "nightly.jsonl"));
  assert.equal(sched.lastGauntlet().regressed, true);

  sched.stop();
  await fs.rm(home, { recursive: true, force: true });
});

test("gauntlet schedule: a runner that throws is reported via onError and does not wedge the next night", async () => {
  const timers = fakeTimers();
  let now = at(3, 30);
  let calls = 0;
  const errors = [];
  const sched = new Scheduler({
    hooks: { gauntlet: async () => { calls++; if (calls === 1) throw new Error("provider down"); return { passed: 1, total: 1, gateOk: true }; } },
    gauntletHour: 3,
    gauntletEnabled: true,
    now: () => now,
    onError: (hook, err) => errors.push([hook, err.message]),
    ...timers,
  });
  sched.start();
  const timer = timers.intervals[0];
  timer.fn();
  await settle();
  assert.deepEqual(errors, [["gauntlet", "provider down"]]);
  now = at(3, 30, 1);
  timer.fn();
  await settle();
  assert.equal(calls, 2, "next night runs again");
  sched.stop();
});

test("gauntlet schedule: ARES_GAUNTLET_SCHEDULE=0 disables it; heartbeat/dream timers are untouched", async () => {
  const prior = process.env.ARES_GAUNTLET_SCHEDULE;
  process.env.ARES_GAUNTLET_SCHEDULE = "0";
  try {
    const timers = fakeTimers();
    const sched = new Scheduler({
      hooks: { heartbeat: async () => {}, dream: async () => {}, gauntlet: async () => ({ passed: 1, total: 1, gateOk: true }) },
      heartbeatEveryMs: 1000,
      dreamCheckEveryMs: 500,
      now: () => at(3, 30),
      ...timers,
    });
    assert.equal(sched.gauntletEnabled, false);
    sched.start();
    assert.deepEqual(timers.intervals.map((h) => h.ms).sort((a, b) => a - b), [500, 1000], "no gauntlet timer");
    assert.equal(sched.nextGauntletAt(), undefined);
    sched.stop();
  } finally {
    if (prior === undefined) delete process.env.ARES_GAUNTLET_SCHEDULE;
    else process.env.ARES_GAUNTLET_SCHEDULE = prior;
  }

  // The explicit option wins over the env default too.
  const timers = fakeTimers();
  const sched = new Scheduler({ hooks: { gauntlet: async () => ({ passed: 1, total: 1, gateOk: true }) }, gauntletEnabled: false, ...timers });
  sched.start();
  assert.equal(timers.intervals.length, 0);
  sched.stop();
});

test("gauntlet schedule: ARES_GAUNTLET_HOUR sets the default window; a missing home still emits events", async () => {
  const prior = process.env.ARES_GAUNTLET_HOUR;
  process.env.ARES_GAUNTLET_HOUR = "22";
  try {
    const timers = fakeTimers();
    let now = at(22, 15);
    const events = [];
    const sched = new Scheduler({ hooks: { gauntlet: async () => ({ passed: 2, total: 3, gateOk: true }) }, gauntletEnabled: true, now: () => now, ...timers });
    assert.equal(sched.gauntletHour, 22);
    sched.subscribe((e) => events.push(e));
    sched.start();
    timers.intervals[0].fn();
    await settle();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "gauntlet_run");
    assert.equal(events[0].summary.passed, 2);
    sched.stop();
  } finally {
    if (prior === undefined) delete process.env.ARES_GAUNTLET_HOUR;
    else process.env.ARES_GAUNTLET_HOUR = prior;
  }
});
