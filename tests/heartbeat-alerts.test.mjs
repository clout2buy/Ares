// The heartbeat's alert channel: what earns a word, how often it may speak, and
// that a broken sink cannot silently swallow a finding it never sent.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { heartbeatChecks } from "../packages/agent/dist/heartbeat.js";
import { Scheduler } from "../packages/garrison/dist/index.js";
import {
  HEARTBEAT_ALERT_DAILY_CAP,
  deliverHeartbeatAlerts,
  heartbeatAlertId,
  loadHeartbeatAlertState,
  localDayKey,
  selectHeartbeatAlerts,
} from "../packages/cli/dist/heartbeatAlerts.js";

const AT_NOON = new Date(2026, 9, 1, 12, 0, 0);

test("heartbeatChecks reads bullets and ignores documentation", () => {
  const checks = heartbeatChecks(
    [
      "# Heartbeat checklist",
      "",
      "_prose that used to be parsed as a check_",
      "",
      "## Checks",
      "",
      "- ahead of origin — unpushed work dies with the box",
      "* second bullet form",
      "",
      "## How i respond",
      "",
      "> a blockquote is policy, not a check",
      "",
      "- duplicate bullet",
      "- ahead of origin — unpushed work dies with the box",
    ].join("\n"),
  );
  assert.deepEqual(checks, [
    "ahead of origin — unpushed work dies with the box",
    "second bullet form",
    "duplicate bullet",
  ]);
});

test("a standing finding is said once, not every tick", () => {
  const finding = "git status has changes: M packages/core/src/session.ts";
  const first = selectHeartbeatAlerts([finding], { day: localDayKey(AT_NOON), sent: 0, seen: {} }, AT_NOON);
  assert.deepEqual(first.selected, [finding]);
  assert.equal(first.next.sent, 1);

  // 30 minutes later, same finding -> silence.
  const later = new Date(AT_NOON.getTime() + 30 * 60_000);
  const second = selectHeartbeatAlerts([finding], first.next, later);
  assert.deepEqual(second.selected, []);

  // Past the repeat window it may be said again, budget permitting.
  const tomorrow = new Date(AT_NOON.getTime() + 13 * 60 * 60_000);
  const third = selectHeartbeatAlerts([finding], second.next, tomorrow);
  assert.deepEqual(third.selected, [finding]);
});

test("the day's cap is hard and the counter rolls over at midnight", () => {
  const findings = ["one", "two", "three", "four"];
  const { selected, next } = selectHeartbeatAlerts(findings, { day: localDayKey(AT_NOON), sent: 0, seen: {} }, AT_NOON);
  assert.equal(selected.length, HEARTBEAT_ALERT_DAILY_CAP);
  assert.equal(next.sent, HEARTBEAT_ALERT_DAILY_CAP);

  const sameDay = selectHeartbeatAlerts(["five"], next, new Date(AT_NOON.getTime() + 60 * 60_000));
  assert.deepEqual(sameDay.selected, [], "cap holds for the rest of the day");

  const nextDay = selectHeartbeatAlerts(["five"], sameDay.next, new Date(2026, 9, 2, 12, 0, 0));
  assert.deepEqual(nextDay.selected, ["five"]);
  assert.equal(nextDay.next.sent, 1);
});

test("a finding that failed to send is not counted, but is not retried every tick either", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hb-alerts-"));
  const finding = "unpushed work: 3 commit(s) not on the remote";
  const logged = [];

  const failed = await deliverHeartbeatAlerts({
    home,
    findings: [finding],
    now: AT_NOON,
    sink: { startTurn: async () => false, log: (line) => logged.push(line) },
  });
  assert.equal(failed, 0);

  const state = await loadHeartbeatAlertState(home, AT_NOON);
  assert.equal(state.sent, 0, "a send that never happened must not burn the day's budget");
  assert.ok(state.seen[heartbeatAlertId(finding)], "and must not be retried on the next tick");

  const again = await deliverHeartbeatAlerts({
    home,
    findings: [finding],
    now: new Date(AT_NOON.getTime() + 30 * 60_000),
    sink: { startTurn: async () => true, log: (line) => logged.push(line) },
  });
  assert.equal(again, 0, "still inside the repeat window");

  const retried = await deliverHeartbeatAlerts({
    home,
    findings: [finding],
    now: new Date(AT_NOON.getTime() + 13 * 60 * 60_000),
    sink: { startTurn: async () => true, log: (line) => logged.push(line) },
  });
  assert.equal(retried, 1);
  assert.equal((await loadHeartbeatAlertState(home, AT_NOON)).sent, 1);
});

test("a delivered alert is persisted so the next tick stays quiet", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hb-alerts-"));
  const finding = "Check not implemented yet: is the VPN leak-watch green?";
  const turns = [];
  const sink = {
    startTurn: async (text) => {
      turns.push(text);
      return true;
    },
    log: () => {},
  };

  assert.equal(await deliverHeartbeatAlerts({ home, findings: [finding], now: AT_NOON, sink }), 1);
  assert.equal(await deliverHeartbeatAlerts({ home, findings: [finding], now: AT_NOON, sink }), 0);
  assert.equal(turns.length, 1);

  const raw = JSON.parse(await readFile(path.join(home, "heartbeat-alerts.json"), "utf8"));
  assert.equal(raw.day, localDayKey(AT_NOON));
  assert.equal(raw.sent, 1);
});

test("with no thread to wake an alert still falls back to the phone", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "hb-alerts-"));
  const pushed = [];
  const delivered = await deliverHeartbeatAlerts({
    home,
    findings: ["the tunnel is down"],
    now: AT_NOON,
    sink: { startTurn: async () => false, push: async (text) => pushed.push(text), log: () => {} },
  });
  assert.equal(delivered, 1);
  assert.match(pushed[0], /^the tunnel is down/, "the finding reaches the phone verbatim");
  assert.equal((await loadHeartbeatAlertState(home, AT_NOON)).sent, 1, "a push that landed counts");
});

test("the scheduler records a hook's own result instead of masking it as 'ok'", async () => {
  const results = [];
  const timers = [];
  const sched = new Scheduler({
    hooks: {
      // The shape the garrison's heartbeat hook returns when it finds something.
      heartbeat: async () => ({
        status: "alert",
        text: "unpushed work: 144 commit(s) not on the remote\nsecond line is clipped",
        tasks: [],
        findings: ["unpushed work: 144 commit(s) not on the remote"],
      }),
      goals: async () => "ran 1 check-in",
      dream: async () => ({ consolidated: 3 }),
    },
    heartbeatEveryMs: 1_000,
    goalsCheckEveryMs: 1_000,
    dreamCheckEveryMs: 1_000,
    idleMs: 0,
    now: () => AT_NOON.getTime(),
    setIntervalFn: (fn, ms) => {
      const handle = { fn, ms };
      timers.push(handle);
      return handle;
    },
    clearIntervalFn: () => {},
    onRun: (hook, result) => results.push([hook, result]),
  });
  sched.start();
  for (const timer of timers) timer.fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  sched.stop();

  assert.deepEqual(
    results.find(([hook]) => hook === "heartbeat"),
    ["heartbeat", "alert: unpushed work: 144 commit(s) not on the remote"],
    "a heartbeat alert must reach the audit trail as itself — 378 consecutive 'ok' hid one every 30 minutes",
  );
  assert.deepEqual(results.find(([hook]) => hook === "goals"), ["goals", "ran 1 check-in"]);
  assert.deepEqual(results.find(([hook]) => hook === "dream"), ["dream", "ok"], "an object with no status is still 'ok'");
});
