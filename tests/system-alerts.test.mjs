// Alerts: each condition pushes once, de-dupes, respects quiet hours, resolves
// quietly, retries a failed push, and everything lands in the events feed.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AlertEngine, candidatesFrom, inQuietHours } from "../packages/cli/dist/systemAlerts.js";
import { readSignals, recordBoot } from "../packages/cli/dist/systemWiring.js";

async function home(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-alert-test-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function snap(over = {}) {
  return {
    disk: { totalBytes: 100, usedBytes: 17, usedPct: 17, dirs: [] },
    memory: { heapRatio: 0.2, systemRatio: 0.4 },
    sessions: { turns: [] },
    providers: [],
    connectors: { problems: [] },
    ...over,
  };
}

function rig(t, over = {}) {
  const sent = [];
  let now = Date.parse("2026-10-01T15:00:00Z");
  const state = {
    sent,
    get now() { return now; },
    advance: (ms) => { now += ms; },
    push: async (m) => { if (state.failPush) throw new Error("APNs 410"); sent.push(m); },
    failPush: false,
  };
  return state;
}

async function engine(t, r, over = {}) {
  const dir = await home(t);
  return { dir, engine: new AlertEngine({ home: dir, push: (m) => r.push(m), now: () => r.now, quiet: "off", timeZone: "UTC", ...over }) };
}

test("disk: 80-84% is feed-only, 85%+ pushes once and does not repeat", async (t) => {
  const r = rig(t);
  const { engine: e } = await engine(t, r);
  await e.evaluate(snap({ disk: { totalBytes: 100, usedBytes: 82, usedPct: 82, dirs: [] } }));
  assert.equal(r.sent.length, 0, "a heads-up in the feed, not a buzz");
  r.advance(60_000);
  await e.evaluate(snap({ disk: { totalBytes: 100, usedBytes: 87, usedPct: 87, dirs: [] } }));
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].title, /disk/i);
  assert.equal(r.sent[0].collapseId, "ares-system-disk");
  for (let i = 0; i < 10; i++) {
    r.advance(60_000);
    await e.evaluate(snap({ disk: { totalBytes: 100, usedBytes: 88, usedPct: 88, dirs: [] } }));
  }
  assert.equal(r.sent.length, 1, "the same condition does not push again");
});

test("a reminder follows after six hours, at most three times", async (t) => {
  const r = rig(t);
  const { engine: e } = await engine(t, r);
  const bad = snap({ disk: { totalBytes: 100, usedBytes: 90, usedPct: 90, dirs: [] } });
  await e.evaluate(bad);
  for (let i = 0; i < 6; i++) {
    r.advance(6 * 3600_000 + 1000);
    await e.evaluate(bad);
  }
  assert.equal(r.sent.length, 4, "the first push and three reminders, then silence");
});

test("a condition that clears is resolved after two clean evaluations and can alert again", async (t) => {
  const r = rig(t);
  const { engine: e } = await engine(t, r);
  const bad = snap({ disk: { totalBytes: 100, usedBytes: 90, usedPct: 90, dirs: [] } });
  await e.evaluate(bad);
  r.advance(60_000);
  const one = await e.evaluate(snap());
  assert.equal(one.some((x) => x.kind === "resolved"), false, "one clean pass could be a flap");
  r.advance(60_000);
  const two = await e.evaluate(snap());
  assert.equal(two.some((x) => x.kind === "resolved"), true);
  r.advance(60_000);
  await e.evaluate(bad);
  assert.equal(r.sent.length, 2, "a fresh occurrence pushes again");
});

test("quiet hours hold a non-critical push until they end; critical ones pierce them", async (t) => {
  const r = rig(t);
  // 03:00 UTC is inside 23:00-07:00.
  r.advance(12 * 3600_000);
  assert.equal(inQuietHours("23:00-07:00", r.now, "UTC"), true);
  const { engine: e } = await engine(t, r, { quiet: "23:00-07:00" });
  const stuck = snap({ sessions: { turns: [{ sessionId: "s1", title: "Build", stuck: true, ageSec: 900, currentTool: "Bash" }] } });
  const held = await e.evaluate(stuck);
  assert.equal(r.sent.length, 0);
  assert.ok(held.some((x) => x.kind === "held"), "the feed still shows it");
  r.advance(60_000);
  await e.evaluate(stuck);
  assert.equal(r.sent.length, 0, "still quiet");
  // Critical: the disk is about to fill.
  await e.evaluate(snap({ ...stuck, disk: { totalBytes: 100, usedBytes: 96, usedPct: 96, dirs: [] } }));
  assert.equal(r.sent.length, 1, "disk 96% pierces quiet hours");
  assert.match(r.sent[0].title, /disk/i);
  // Morning: the held one is delivered, once.
  r.advance(5 * 3600_000);
  assert.equal(inQuietHours("23:00-07:00", r.now, "UTC"), false);
  await e.evaluate(snap({ ...stuck, disk: { totalBytes: 100, usedBytes: 96, usedPct: 96, dirs: [] } }));
  assert.equal(r.sent.length, 2);
  assert.match(r.sent[1].title, /stuck/i);
});

test("quiet-hours window arithmetic, including the midnight wrap and 'off'", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(inQuietHours("23:00-07:00", at("2026-10-01T23:30:00Z"), "UTC"), true);
  assert.equal(inQuietHours("23:00-07:00", at("2026-10-01T06:59:00Z"), "UTC"), true);
  assert.equal(inQuietHours("23:00-07:00", at("2026-10-01T07:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("13:00-14:00", at("2026-10-01T13:30:00Z"), "UTC"), true);
  assert.equal(inQuietHours("off", at("2026-10-01T03:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("garbage", at("2026-10-01T03:00:00Z"), "UTC"), false);
  assert.equal(inQuietHours("23:00-07:00", at("2026-10-01T23:30:00Z"), "America/New_York"), false, "evaluated in the owner's zone");
});

test("a failed push is retried later, not spammed, and shows as push_failed", async (t) => {
  const r = rig(t);
  const { engine: e, dir } = await engine(t, r);
  const bad = snap({ disk: { totalBytes: 100, usedBytes: 90, usedPct: 90, dirs: [] } });
  r.failPush = true;
  const first = await e.evaluate(bad);
  assert.ok(first.some((x) => x.kind === "push_failed"));
  r.advance(60_000);
  await e.evaluate(bad);
  assert.equal(r.sent.length, 0);
  r.failPush = false;
  r.advance(11 * 60_000);
  await e.evaluate(bad);
  assert.equal(r.sent.length, 1, "delivered once it works and the retry window opened");
  const feed = await e.events();
  assert.ok(feed.some((x) => x.kind === "push_failed"));
  assert.ok(feed.some((x) => x.kind === "pushed"));
  void dir;
});

test("every alert kind has a rule: provider outage, stuck turn, connector expired, backup failed, deploy rollback, crash loop, memory", () => {
  const kinds = (s, signals) => candidatesFrom(s, signals).map((c) => c.kind);
  assert.deepEqual(kinds(snap({ providers: [{ provider: "anthropic", state: "open", failingForMs: 6 * 60_000, consecutiveFailures: 4, lastError: "529" }] })), ["provider_outage"]);
  assert.deepEqual(kinds(snap({ providers: [{ provider: "anthropic", state: "open", failingForMs: 4 * 60_000, consecutiveFailures: 4 }] })), [], "an outage must last over 5 minutes");
  assert.deepEqual(kinds(snap({ sessions: { turns: [{ sessionId: "a", title: "t", stuck: true, ageSec: 700 }] } })), ["stuck_turn"]);
  assert.deepEqual(kinds(snap({ connectors: { problems: [{ id: "gmail", state: "red", detail: "Broken: token expired", stale: false }] } })), ["connector_expired"]);
  assert.deepEqual(kinds(snap({ connectors: { problems: [{ id: "x", state: "red", detail: "Broken: timeout", stale: false }] } })), [], "only auth failures count as expired");
  assert.deepEqual(kinds(snap({ backup: { ok: false, error: "disk full" } })), ["backup_failed"]);
  assert.deepEqual(kinds(snap(), { deployRolledBack: { id: "1", reason: "tests failed" } }), ["deploy_rolled_back"]);
  assert.deepEqual(kinds(snap(), { recentBoots: 3 }), ["crash_loop"]);
  assert.deepEqual(kinds(snap(), { recentBoots: 2, recentCrashes: 1 }), []);
  assert.deepEqual(kinds(snap({ memory: { heapRatio: 0.9, systemRatio: 0.4 } })), ["memory"]);
  assert.deepEqual(kinds(snap()), []);
});

test("the events feed is newest-first, paged, and survives a restart", async (t) => {
  const r = rig(t);
  const { engine: e, dir } = await engine(t, r);
  for (let i = 0; i < 5; i++) {
    r.advance(1000);
    await e.record({ kind: "housekeeping", title: `run ${i}` });
  }
  const feed = await e.events({ limit: 3 });
  assert.deepEqual(feed.map((x) => x.title), ["run 4", "run 3", "run 2"]);
  const older = await e.events({ limit: 10, before: feed[2].at });
  assert.deepEqual(older.map((x) => x.title), ["run 1", "run 0"]);
  const reborn = new AlertEngine({ home: dir, quiet: "off" });
  assert.equal((await reborn.events({ limit: 1 }))[0].title, "run 4");
});

test("alert state persists: a restarted garrison does not re-push a known alert", async (t) => {
  const r = rig(t);
  const { engine: e, dir } = await engine(t, r);
  const bad = snap({ disk: { totalBytes: 100, usedBytes: 90, usedPct: 90, dirs: [] } });
  await e.evaluate(bad);
  assert.equal(r.sent.length, 1);
  const reborn = new AlertEngine({ home: dir, push: (m) => r.push(m), now: () => r.now, quiet: "off", timeZone: "UTC" });
  r.advance(60_000);
  await reborn.evaluate(bad);
  assert.equal(r.sent.length, 1);
});

test("overlapping evaluations cannot double-send", async (t) => {
  const r = rig(t);
  let slow = true;
  const { engine: e } = await engine(t, r, { push: async (m) => { if (slow) await new Promise((x) => setTimeout(x, 30)); r.sent.push(m); } });
  const bad = snap({ disk: { totalBytes: 100, usedBytes: 90, usedPct: 90, dirs: [] } });
  await Promise.all([e.evaluate(bad), e.evaluate(bad), e.evaluate(bad)]);
  slow = false;
  assert.equal(r.sent.length, 1);
});

test("external signals: boot ledger counts starts, crash files count, the rollback marker is a one-shot", async (t) => {
  const dir = await home(t);
  const now = Date.now();
  await recordBoot(dir, now - 10 * 60_000);
  await recordBoot(dir, now - 5 * 60_000);
  assert.equal(await recordBoot(dir, now), 3);
  await fsp.mkdir(path.join(dir, "crashes"), { recursive: true });
  for (let i = 0; i < 3; i++) await fsp.writeFile(path.join(dir, "crashes", `c${i}.jsonl`), "{}");
  await fsp.mkdir(path.join(dir, "system", "signals"), { recursive: true });
  await fsp.writeFile(path.join(dir, "system", "signals", "deploy-rolled-back.json"), JSON.stringify({ at: new Date(now - 3600_000).toISOString(), reason: "smoke test failed" }));
  const s = await readSignals(dir, now);
  assert.equal(s.recentBoots, 3);
  assert.equal(s.recentCrashes, 3);
  assert.equal(s.deployRolledBack.reason, "smoke test failed");
  await fsp.writeFile(path.join(dir, "system", "signals", "deploy-rolled-back.json"), JSON.stringify({ at: new Date(now - 3 * 86_400_000).toISOString() }));
  assert.equal((await readSignals(dir, now)).deployRolledBack, undefined, "an old rollback is history, not an alert");
});
