// Live Activity / Dynamic Island, server half: the APNs payloads, the token
// registry, the turn-lifecycle driver (with a fake clock and a fake APNs
// transport), and the register/unregister routes through the real server.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { PhonePush, LIVE_ACTIVITY_ATTRIBUTES_TYPE } from "../packages/cli/dist/phonePush.js";
import {
  LiveActivityRegistry,
  LiveActivityDriver,
  LIVE_ACTIVITY_START_AFTER_MS,
  createLiveActivityApi,
  createWidgetNudger,
  parseRegistration,
  resultLine,
} from "../packages/cli/dist/phoneLiveActivity.js";

const HEX_A = "a1".repeat(32);
const HEX_B = "b2".repeat(32);
const HEX_C = "c3".repeat(32);

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-la-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A clock whose timers only fire when told to. */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  const timers = [];
  let seq = 0;
  return {
    now: () => t,
    timers: {
      set: (fn, ms) => { const h = { id: ++seq, at: t + ms, fn }; timers.push(h); return h; },
      clear: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    },
    pending: () => timers.length,
    async advance(ms, driver) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.fn();
        await driver?.idle();
      }
      t = end;
      await driver?.idle();
    },
  };
}

function fakeSender(statusFor = () => 200) {
  const calls = [];
  return {
    calls,
    sendLiveActivity: async (token, push) => { calls.push({ token, push }); return statusFor(token, push); },
  };
}

async function rig(t, over = {}) {
  const dir = await tempDir(t);
  const clock = makeClock();
  const registry = new LiveActivityRegistry(path.join(dir, "la.json"), clock.now);
  const sender = over.sender ?? fakeSender();
  const logs = [];
  const driver = new LiveActivityDriver({
    registry,
    sender,
    agentName: () => "Bob",
    taskLabel: () => "Fix the login bug",
    isMobileSession: () => true,
    now: clock.now,
    timers: clock.timers,
    log: (l) => logs.push(l),
    ...over.driver,
  });
  t.after(() => driver.dispose());
  return { dir, clock, registry, sender, driver, logs };
}

const ev = (type, extra = {}) => ({ type, ...extra });

// ── the payloads ──────────────────────────────────────────────────────────

const CFG = { keyPath: "", keyId: "K", teamId: "T", bundleId: "com.doingteam.ares" };

test("payload: update goes to the liveactivity topic with a content-state Apple can decode", () => {
  const req = PhonePush.buildLiveActivityRequest(CFG, HEX_A, "jwt", { event: "update", contentState: { phase: "working", headline: "x" }, priority: 5, staleDate: 1_700_000_900 }, 1_700_000_000_000);
  assert.equal(req.headers["apns-push-type"], "liveactivity");
  assert.equal(req.headers["apns-topic"], "com.doingteam.ares.push-type.liveactivity");
  assert.equal(req.headers["apns-priority"], "5");
  assert.equal(req.headers[":path"], `/3/device/${HEX_A}`);
  assert.equal(req.headers.authorization, "bearer jwt");
  assert.equal(req.headers["apns-expiration"], String(1_700_000_000 + 180));
  const body = JSON.parse(req.body);
  assert.deepEqual(body, { aps: { timestamp: 1_700_000_000, event: "update", "content-state": { phase: "working", headline: "x" }, "stale-date": 1_700_000_900 } });
});

test("payload: push-to-start names the attributes type and carries the attributes and an alert", () => {
  const req = PhonePush.buildLiveActivityRequest(CFG, HEX_A, "jwt", {
    event: "start",
    contentState: { phase: "working" },
    attributes: { sessionId: "s1", agentName: "Bob" },
    alert: { title: "Bob", body: "Working on it" },
  }, 1_700_000_000_000);
  const body = JSON.parse(req.body);
  assert.equal(body.aps.event, "start");
  assert.equal(body.aps["attributes-type"], "AresActivityAttributes");
  assert.equal(LIVE_ACTIVITY_ATTRIBUTES_TYPE, "AresActivityAttributes");
  assert.deepEqual(body.aps.attributes, { sessionId: "s1", agentName: "Bob" });
  assert.deepEqual(body.aps.alert, { title: "Bob", body: "Working on it" });
  assert.equal(req.headers["apns-priority"], "10", "a start is immediate by default");
});

test("payload: end carries the dismissal date and lives longer than a progress update", () => {
  const req = PhonePush.buildLiveActivityRequest(CFG, HEX_A, "jwt", { event: "end", contentState: { phase: "done" }, dismissalDate: 1_700_000_300 }, 1_700_000_000_000);
  const body = JSON.parse(req.body);
  assert.equal(body.aps.event, "end");
  assert.equal(body.aps["dismissal-date"], 1_700_000_300);
  assert.equal(req.headers["apns-expiration"], String(1_700_000_000 + 3600));
  // dismissal-date means nothing on an update.
  const upd = JSON.parse(PhonePush.buildLiveActivityRequest(CFG, HEX_A, "jwt", { event: "update", contentState: {}, dismissalDate: 5 }).body);
  assert.equal(upd.aps["dismissal-date"], undefined);
});

test("PhonePush.sendLiveActivity goes through the transport with a real provider token; unconfigured is a quiet 0", async () => {
  const unconfigured = new PhonePush("/dev/null", null);
  assert.equal(await unconfigured.sendLiveActivity(HEX_A, { event: "update", contentState: {} }), 0);
  const { generateKeyPairSync } = await import("node:crypto");
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-la-key-"));
  try {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyPath = path.join(dir, "k.p8");
    await fsp.writeFile(keyPath, pem);
    const seen = [];
    const push = new PhonePush(path.join(dir, "p.json"), { ...CFG, keyPath }, () => {}, async (_cfg, req) => { seen.push(req); return 200; });
    assert.equal(await push.sendLiveActivity(HEX_A, { event: "update", contentState: { phase: "working" } }), 200);
    assert.equal(seen.length, 1);
    assert.match(seen[0].headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(seen[0].headers["apns-push-type"], "liveactivity");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ── registration ──────────────────────────────────────────────────────────

test("parseRegistration: what is accepted and what is refused", () => {
  const ok = parseRegistration({ deviceId: "dev_1", activityId: "act-1", pushToken: HEX_A.toUpperCase(), kind: "update", sessionId: "sess_1" });
  assert.deepEqual(ok, { ok: true, value: { deviceId: "dev_1", activityId: "act-1", pushToken: HEX_A, kind: "update", sessionId: "sess_1" } });
  const start = parseRegistration({ deviceId: "dev_1", pushToken: HEX_B, kind: "start" });
  assert.deepEqual(start, { ok: true, value: { deviceId: "dev_1", activityId: "push-to-start", pushToken: HEX_B, kind: "start" } });
  for (const bad of [
    {},
    { deviceId: "d", kind: "update", pushToken: HEX_A },
    { deviceId: "d", kind: "update", activityId: "a", pushToken: "nothex!!" },
    { deviceId: "d", kind: "update", activityId: "a", pushToken: "abcd" },
    { deviceId: "d", kind: "update", activityId: "a", pushToken: HEX_A + "a" },
    { deviceId: "d", kind: "weird", activityId: "a", pushToken: HEX_A },
    { deviceId: "bad id with spaces", kind: "start", pushToken: HEX_A },
    { deviceId: "d", kind: "update", activityId: "../x", pushToken: HEX_A },
    { deviceId: "d", kind: "update", activityId: "a", pushToken: HEX_A, sessionId: "a b" },
    { deviceId: 5, kind: "start", pushToken: HEX_A },
  ]) {
    assert.equal(parseRegistration(bad).ok, false, JSON.stringify(bad));
  }
});

test("registry: stores, finds by session, survives a restart, forgets", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "la.json");
  const reg = new LiveActivityRegistry(file);
  await reg.register({ deviceId: "d1", activityId: "start", pushToken: HEX_A, kind: "start" });
  await reg.register({ deviceId: "d1", activityId: "a1", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  await reg.register({ deviceId: "d2", activityId: "a9", pushToken: HEX_C, kind: "update", sessionId: "s2" });
  assert.deepEqual(reg.forSession("s1"), [{ deviceId: "d1", activityId: "a1", token: HEX_B }]);
  assert.deepEqual(reg.startTokens(), [{ deviceId: "d1", token: HEX_A }]);
  assert.deepEqual(reg.summary().find((d) => d.deviceId === "d1"), { deviceId: "d1", hasStartToken: true, activities: 1 });
  assert.ok(!JSON.stringify(reg.summary()).includes(HEX_B), "diagnostics never include a token");

  const again = new LiveActivityRegistry(file);
  await again.load();
  assert.deepEqual(again.forSession("s2"), [{ deviceId: "d2", activityId: "a9", token: HEX_C }]);

  assert.equal(await again.unregister({ deviceId: "d2", activityId: "a9" }), 1);
  assert.equal(again.forSession("s2").length, 0);
  assert.equal(await again.unregister({ deviceId: "d1", kind: "start" }), 1);
  assert.equal(again.startTokens().length, 0);
  assert.equal(await again.unregister({ deviceId: "nobody" }), 0);
  assert.equal(await again.removeToken(HEX_B), true);
  assert.equal(await again.removeToken(HEX_B), false);
  const fresh = new LiveActivityRegistry(file);
  await fresh.load();
  assert.deepEqual(fresh.summary().find((d) => d.deviceId === "d1"), { deviceId: "d1", hasStartToken: false, activities: 0 });
});

test("registry: the same token under a new activity id replaces the old row; old activities age out; the table is capped", async (t) => {
  const dir = await tempDir(t);
  let now = 1_700_000_000_000;
  const reg = new LiveActivityRegistry(path.join(dir, "la.json"), () => now);
  await reg.register({ deviceId: "d1", activityId: "old", pushToken: HEX_A, kind: "update", sessionId: "s1" });
  await reg.register({ deviceId: "d1", activityId: "new", pushToken: HEX_A, kind: "update", sessionId: "s1" });
  assert.deepEqual(reg.forSession("s1").map((x) => x.activityId), ["new"]);

  now += 13 * 60 * 60 * 1000;
  await reg.register({ deviceId: "d1", activityId: "fresh", pushToken: HEX_B, kind: "update", sessionId: "s2" });
  assert.equal(reg.forSession("s1").length, 0, "a twelve-hour-old activity is gone: the system ends them long before");
  assert.equal(reg.forSession("s2").length, 1);

  for (let i = 0; i < 20; i++) {
    now += 1000;
    await reg.register({ deviceId: "d1", activityId: `x${i}`, pushToken: (i.toString(16).padStart(2, "0")).repeat(32), kind: "update", sessionId: `sx${i}` });
  }
  assert.ok(reg.summary()[0].activities <= 12);
  for (let i = 0; i < 12; i++) await reg.register({ deviceId: `dev${i}`, activityId: "a", pushToken: HEX_C, kind: "start" });
  assert.ok(reg.summary().length <= 8);
});

test("registry: a corrupt file starts empty instead of throwing", async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, "la.json");
  await fsp.writeFile(file, "{not json");
  const reg = new LiveActivityRegistry(file);
  await reg.load();
  assert.deepEqual(reg.summary(), []);
  await reg.register({ deviceId: "d", activityId: "a", pushToken: HEX_A, kind: "update" });
  assert.equal(reg.summary().length, 1);
});

// ── the driver ────────────────────────────────────────────────────────────

test("driver: a long turn starts the activity on the phone, follows the work, asks for approval, and ends with a result line", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  const t0 = clock.now();

  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(LIVE_ACTIVITY_START_AFTER_MS - 1000, driver);
  assert.equal(sender.calls.length, 0, "a turn under eight seconds shows nothing");

  await clock.advance(1000, driver);
  assert.equal(sender.calls.length, 1);
  const start = sender.calls[0];
  assert.equal(start.token, HEX_A, "push-to-start goes to the start token");
  assert.equal(start.push.event, "start");
  assert.deepEqual(start.push.attributes, { sessionId: "s1", agentName: "Bob" });
  assert.equal(start.push.priority, 10);
  assert.deepEqual(start.push.contentState, { phase: "working", headline: "Fix the login bug", detail: "Working", startedAt: Math.floor(t0 / 1000), pendingCount: 0 });
  assert.ok(start.push.alert.body.includes("Fix the login bug"));

  // The tool changes before the activity has registered: nothing to update yet, and no second start.
  driver.onSessionEvent("s1", ev("tool_start", { name: "Bash", activityDescription: "Running the tests" }));
  await clock.advance(500, driver);
  assert.equal(sender.calls.length, 1);

  // The phone registers the new activity's token: it is shown the present.
  await registry.register({ deviceId: "d1", activityId: "act1", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onActivityRegistered("s1");
  await driver.idle();
  assert.equal(sender.calls.length, 2);
  assert.equal(sender.calls[1].token, HEX_B);
  assert.equal(sender.calls[1].push.event, "update");
  assert.equal(sender.calls[1].push.contentState.detail, "Running the tests");

  // A burst of tool changes inside the progress gap collapses to one trailing update with the latest.
  driver.onSessionEvent("s1", ev("tool_start", { name: "Read", activityDescription: "Reading files" }));
  driver.onSessionEvent("s1", ev("tool_start", { name: "Edit", activityDescription: "Editing auth.ts" }));
  driver.onSessionEvent("s1", ev("tool_start", { name: "Bash", activityDescription: "Running lint" }));
  await clock.advance(5_000, driver);
  assert.equal(sender.calls.length, 2, "still inside the 20 s progress gap");
  await clock.advance(16_000, driver);
  assert.equal(sender.calls.length, 3);
  assert.equal(sender.calls[2].push.contentState.detail, "Running lint");
  assert.equal(sender.calls[2].push.priority, 5, "progress is low priority");

  // A permission prompt is a state change: it goes out within the state gap, at full priority.
  driver.onSessionEvent("s1", ev("permission_request", { id: "p1", toolName: "Bash", input: { command: "npm test" }, reason: "" }));
  await clock.advance(1_600, driver);
  assert.equal(sender.calls.length, 4);
  const approval = sender.calls[3].push;
  assert.equal(approval.contentState.phase, "needsApproval");
  assert.equal(approval.contentState.detail, "Bash — npm test");
  assert.equal(approval.contentState.pendingCount, 1);
  assert.equal(approval.priority, 10);

  // Answered: back to working.
  driver.onSessionEvent("s1", ev("permission_response", { id: "p1", decision: "allow_once" }));
  await clock.advance(1_600, driver);
  assert.equal(sender.calls.length, 5);
  assert.equal(sender.calls[4].push.contentState.phase, "working");
  assert.equal(sender.calls[4].push.contentState.pendingCount, 0);

  // Progress follows the agent's todo list.
  driver.onSessionEvent("s1", ev("todo_updated", { todos: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }, { status: "cancelled" }] }));
  await clock.advance(21_000, driver);
  assert.equal(sender.calls.at(-1).push.contentState.progress, 0.33);

  // Done: one end push with the first sentence of the reply, left on the lock screen five minutes.
  driver.onSessionEvent("s1", ev("text_delta", { text: "All green. I pushed the fix to a branch." }));
  const before = sender.calls.length;
  driver.onSessionEvent("s1", ev("turn_end", { status: "completed" }));
  await driver.idle();
  assert.equal(sender.calls.length, before + 1);
  const end = sender.calls.at(-1);
  assert.equal(end.token, HEX_B);
  assert.equal(end.push.event, "end");
  assert.equal(end.push.contentState.phase, "done");
  assert.equal(end.push.contentState.detail, "All green.");
  assert.equal(end.push.contentState.progress, 1);
  assert.equal(end.push.contentState.endedAt, Math.floor(clock.now() / 1000));
  assert.equal(end.push.dismissalDate, Math.floor((clock.now() + 5 * 60_000) / 1000));
  assert.equal(registry.forSession("s1").length, 0, "the finished activity's token is forgotten");
  assert.equal(clock.pending(), 0, "no timer outlives the turn");
});

test("driver: a turn that ends inside eight seconds never shows an activity", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(3000, driver);
  driver.onSessionEvent("s1", ev("turn_end", { status: "completed" }));
  await clock.advance(30_000, driver);
  assert.equal(sender.calls.length, 0);
  assert.equal(clock.pending(), 0);
});

test("driver: a permission prompt does not wait out the eight seconds", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(2000, driver);
  driver.onSessionEvent("s1", ev("permission_request", { id: "p", toolName: "Write", input: { file_path: "/w/a.ts" }, reason: "" }));
  await driver.idle();
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].push.event, "start");
  assert.equal(sender.calls[0].push.contentState.phase, "needsApproval");
  assert.equal(sender.calls[0].push.contentState.detail, "Write — /w/a.ts");
});

test("driver: a purchase shows the tool and nothing else on the lock screen", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  driver.onSessionEvent("s1", ev("turn_start"));
  driver.onSessionEvent("s1", ev("permission_request", { id: "p", toolName: "Checkout", input: { merchant: "acme", total: 300 }, reason: "", ownerDecision: true }));
  await driver.idle();
  assert.equal(sender.calls[0].push.contentState.detail, "Checkout");
  assert.ok(!JSON.stringify(sender.calls[0].push).includes("acme"));
});

test("driver: sessions that are not the owner's phone threads get nothing", async (t) => {
  const { clock, registry, sender, driver } = await rig(t, { driver: { isMobileSession: (id) => id === "mine" } });
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  driver.onSessionEvent("theirs", ev("turn_start"));
  await clock.advance(20_000, driver);
  assert.equal(sender.calls.length, 0);
  driver.onSessionEvent("mine", ev("turn_start"));
  await clock.advance(9_000, driver);
  assert.equal(sender.calls.length, 1);
});

test("driver: no start token and no activity is quiet, and a failed turn ends as failed", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(20_000, driver);
  assert.equal(sender.calls.length, 0);
  await registry.register({ deviceId: "d1", activityId: "a", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onActivityRegistered("s1");
  await driver.idle();
  assert.equal(sender.calls.length, 1, "an activity the phone started itself still gets updated");
  driver.onSessionEvent("s1", ev("turn_end", { status: "failed" }));
  await driver.idle();
  const end = sender.calls.at(-1).push;
  assert.equal(end.event, "end");
  assert.equal(end.contentState.phase, "failed");
  assert.equal(end.contentState.detail, "Hit a problem");
});

test("driver: the start is asked for once per turn, not on every tick", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "s", pushToken: HEX_A, kind: "start" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(9_000, driver);
  for (let i = 0; i < 6; i++) {
    driver.onSessionEvent("s1", ev("tool_start", { name: "Bash", activityDescription: `step ${i}` }));
    await clock.advance(25_000, driver);
  }
  assert.equal(sender.calls.filter((c) => c.push.event === "start").length, 1, "a phone with Live Activities off must not get a banner per tick");
});

test("driver: a dead token is dropped; a 429 pauses everything for a minute", async (t) => {
  const status = { value: 410 };
  const { clock, registry, sender, driver, logs } = await rig(t, { sender: fakeSender(() => status.value) });
  await registry.register({ deviceId: "d1", activityId: "a", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(9_000, driver);
  assert.equal(sender.calls.length, 1);
  assert.equal(registry.forSession("s1").length, 0, "410 forgets the token");
  assert.ok(logs.some((l) => /dead token/.test(l)));

  status.value = 429;
  await registry.register({ deviceId: "d1", activityId: "b", pushToken: HEX_C, kind: "update", sessionId: "s1" });
  driver.onSessionEvent("s1", ev("tool_start", { name: "x", activityDescription: "one" }));
  await clock.advance(21_000, driver);
  const afterThrottle = sender.calls.length;
  assert.ok(logs.some((l) => /slow down/.test(l)));
  driver.onSessionEvent("s1", ev("tool_start", { name: "x", activityDescription: "two" }));
  await clock.advance(21_000, driver);
  assert.equal(sender.calls.length, afterThrottle, "backing off");
  status.value = 200;
  await clock.advance(60_000, driver);
  driver.onSessionEvent("s1", ev("tool_start", { name: "x", activityDescription: "three" }));
  await clock.advance(21_000, driver);
  assert.ok(sender.calls.length > afterThrottle, "and back again after the minute");
});

test("driver: progress is capped per hour but a state change still goes through", async (t) => {
  const { clock, registry, sender, driver } = await rig(t, { driver: { maxPerHour: 3, workingGapMs: 1000, stateGapMs: 100 } });
  await registry.register({ deviceId: "d1", activityId: "a", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(9_000, driver);
  for (let i = 0; i < 8; i++) {
    driver.onSessionEvent("s1", ev("tool_start", { name: "x", activityDescription: `step ${i}` }));
    await clock.advance(2_000, driver);
  }
  assert.equal(sender.calls.length, 3, "three pushes in the hour, then progress stops");
  driver.onSessionEvent("s1", ev("permission_request", { id: "p", toolName: "Bash", input: { command: "ls" }, reason: "" }));
  await clock.advance(500, driver);
  assert.equal(sender.calls.length, 4);
  assert.equal(sender.calls.at(-1).push.contentState.phase, "needsApproval");
  driver.onSessionEvent("s1", ev("turn_end", { status: "completed" }));
  await driver.idle();
  assert.equal(sender.calls.at(-1).push.event, "end", "the end is never withheld");
});

test("driver: a secret in a tool description never reaches the activity", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "a", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await clock.advance(9_000, driver);
  driver.onSessionEvent("s1", ev("tool_start", { name: "Bash", activityDescription: "Running curl -H 'Authorization: Bearer abcdefgh12345678' https://x.example/?key=zzzzzzzzzz" }));
  await clock.advance(21_000, driver);
  const text = JSON.stringify(sender.calls);
  assert.ok(!text.includes("abcdefgh12345678"));
  assert.ok(!text.includes("zzzzzzzzzz"));
});

test("driver: a follow-up message while the activity is up updates it straight away", async (t) => {
  const { clock, registry, sender, driver } = await rig(t);
  await registry.register({ deviceId: "d1", activityId: "a", pushToken: HEX_B, kind: "update", sessionId: "s1" });
  driver.onSessionEvent("s1", ev("turn_start"));
  await driver.idle();
  assert.equal(sender.calls.length, 1, "no eight-second wait when it is already on the lock screen");
  assert.equal(sender.calls[0].push.event, "update");
  driver.onSessionEvent("s1", ev("turn_end", { status: "completed" }));
  await driver.idle();
});

test("resultLine: first sentence, short, redacted; a failure is plain", () => {
  assert.equal(resultLine("All done. Next I will...", false, 5000), "All done.");
  assert.equal(resultLine("", false, 134_000), "Done in 2m 14s");
  assert.equal(resultLine(undefined, false, 4000), "Done in 4s");
  assert.equal(resultLine("anything", true, 1), "Hit a problem");
  assert.ok(resultLine("x".repeat(500), false, 1).length <= 90);
  assert.ok(!resultLine("The key is sk-abcdefghijklmnopqrstuv. Done.", false, 1).includes("sk-abcdefghijkl"));
});

// ── widgets: a silent push, rarely ────────────────────────────────────────

test("widget nudger: coalesces a burst into one silent push per window, the last call wins the slot", async () => {
  const clock = makeClock();
  const sent = [];
  const nudge = createWidgetNudger(async (d) => { sent.push(d); }, { minGapMs: 60_000, now: clock.now, timers: clock.timers });
  nudge();
  nudge();
  nudge();
  assert.equal(sent.length, 1, "the first goes straight away");
  assert.deepEqual(sent[0], { kind: "widget_refresh", deviceWake: false });
  await clock.advance(10_000);
  nudge();
  nudge();
  assert.equal(sent.length, 1, "inside the window: held");
  await clock.advance(50_000);
  assert.equal(sent.length, 2, "one trailing push");
  await clock.advance(120_000);
  nudge();
  assert.equal(sent.length, 3);
});

test("widget nudger: a failing push never throws", async () => {
  const clock = makeClock();
  const logs = [];
  const nudge = createWidgetNudger(async () => { throw new Error("apns down"); }, { now: clock.now, timers: clock.timers, log: (l) => logs.push(l) });
  nudge();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(logs.some((l) => /apns down/.test(l)));
});

// ── the routes ────────────────────────────────────────────────────────────

test("routes: register, list without tokens, unregister, validation, and the bearer gate (real server)", async (t) => {
  const dir = await tempDir(t);
  const registry = new LiveActivityRegistry(path.join(dir, "la.json"));
  const registered = [];
  const api = createLiveActivityApi({ registry, driver: { onActivityRegistered: (s) => registered.push(s) }, configured: () => true, log: () => {} });
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", phoneApi: { notify: api } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  assert.equal((await call("GET", "/gateway/liveactivity", undefined, null)).status, 401);
  assert.equal((await call("POST", "/gateway/liveactivity/register", { deviceId: "d", kind: "start", pushToken: HEX_A }, "guest")).status, 401);

  const start = await call("POST", "/gateway/liveactivity/register", { deviceId: "dev_1", kind: "start", pushToken: HEX_A });
  assert.equal(start.status, 200);
  assert.deepEqual(start.body, { ok: true, kind: "start", configured: true });
  const upd = await call("POST", "/gateway/liveactivity/register", { deviceId: "dev_1", activityId: "act_1", kind: "update", pushToken: HEX_B, sessionId: "sess_1" });
  assert.equal(upd.status, 200);
  assert.deepEqual(registered, ["sess_1"], "the driver is told a running activity has a token");

  const listed = await call("GET", "/gateway/liveactivity");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, { configured: true, devices: [{ deviceId: "dev_1", hasStartToken: true, activities: 1 }] });
  assert.ok(!JSON.stringify(listed.body).includes(HEX_B));

  for (const body of [{}, { deviceId: "d", kind: "update", pushToken: HEX_A }, { deviceId: "d", kind: "start", pushToken: "zz" }, "bad{"]) {
    assert.equal((await call("POST", "/gateway/liveactivity/register", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("POST", "/gateway/liveactivity/register", { deviceId: "d", kind: "start", pushToken: "a".repeat(5000) })).status, 413);
  assert.equal((await call("GET", "/gateway/liveactivity/register")).status, 405);
  assert.equal((await call("GET", "/gateway/liveactivity/else")).status, 404);

  const un = await call("POST", "/gateway/liveactivity/unregister", { deviceId: "dev_1", activityId: "act_1" });
  assert.deepEqual(un.body, { ok: true, removed: 1 });
  assert.equal((await call("POST", "/gateway/liveactivity/unregister", { deviceId: "dev_1" })).body.removed, 1, "no activity id: the whole device goes");
  assert.equal((await call("POST", "/gateway/liveactivity/unregister", {})).status, 400);
  assert.deepEqual((await call("GET", "/gateway/liveactivity")).body.devices, []);
});

test("routes: an unconfigured garrison says so, so the app does not assume pushes will arrive", async (t) => {
  const dir = await tempDir(t);
  const api = createLiveActivityApi({ registry: new LiveActivityRegistry(path.join(dir, "la.json")), configured: () => false });
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", phoneApi: { notify: api } });
  await server.start();
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.port}/gateway/liveactivity`, { headers: { authorization: "Bearer owner-tok" } });
  assert.equal((await res.json()).configured, false);
});
