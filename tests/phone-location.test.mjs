// Location triggers: places, rules, and what a crossing does. The rules engine is
// driven with a fake clock and a fake "start the turn" door across the whole
// matrix (transition, weekdays, windows, quiet hours, one-shot, dedupe, rate
// limit, pause, stale events, failure); the routes go through a real
// RemoteAgentServer; and one test uses a real SessionManager to show a rule
// never pre-approves anything dangerous.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../packages/garrison/dist/index.js";
import { ownerPause } from "../packages/core/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { stripPreamble } from "../packages/cli/dist/personas.js";
import { zonedTimeToMs } from "../packages/cli/dist/phoneCommon.js";
import {
  DEDUPE_MS,
  IOS_REGION_CAP,
  LocationService,
  MAX_PLACES,
  MAX_RULES,
  createLocationApi,
  makeLocationFirer,
  ruleTurnText,
  validatePlaceInput,
} from "../packages/cli/dist/phoneLocation.js";

const NY = "America/New_York";
const min = 60_000;
const at = (y, m, d, h, mi, zone = NY) => zonedTimeToMs(y, m, d, h, mi, zone);
// 2026-09-30 is a Wednesday.
const WED_NOON = at(2026, 9, 30, 12, 0);
const SAT_NOON = at(2026, 10, 3, 12, 0);

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-loc-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }));
  return home;
}

test.afterEach(() => {
  ownerPause.resume();
  delete process.env.ARES_LOCATION_RULES;
});

const AGENTS = { get: (id) => (id === "p_bob" ? { id } : undefined) };

function make(home, over = {}) {
  const env = { fired: [], audits: [], logs: [], nowMs: over.nowMs ?? WED_NOON };
  const svc = new LocationService({
    home,
    fire: over.fire ?? (async (rule, place, text, inputId) => { env.fired.push({ rule, place, text, inputId }); }),
    agents: AGENTS,
    isPaused: () => ownerPause.paused,
    audit: (e) => { env.audits.push(e); },
    now: () => env.nowMs,
    log: (l) => env.logs.push(l),
    ...(over.options ?? {}),
  });
  env.svc = svc;
  env.setNow = (v) => { env.nowMs = v; };
  return env;
}

async function withPlace(env, name = "Home", extra = {}) {
  return (await env.svc.upsertPlace({ name, lat: 30.2672, lon: -97.7431, radiusM: 150, ...extra })).place;
}

async function withRule(env, place, extra = {}) {
  return (await env.svc.upsertRule({ placeId: place.id, transition: "enter", instruction: "Turn on the lights and read me my day.", ...extra })).rule;
}

const event = (place, transition, extra = {}) => ({ placeId: place.id, transition, timeZone: NY, ...extra });

// ── validation ────────────────────────────────────────────────────────────

test("places: names, coordinates and radius are checked; two places cannot share a name", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env, "Home");
  assert.match(home.id, /^pl_[a-f0-9]{10}$/);
  assert.equal(home.radiusM, 150);
  assert.equal(home.lat, 30.2672);
  for (const bad of [
    { name: "", lat: 1, lon: 1 }, { name: "x".repeat(41), lat: 1, lon: 1 }, { name: "A", lat: 91, lon: 1 }, { name: "A", lat: -91, lon: 1 }, { name: "A", lat: 1, lon: 181 },
    { name: "A", lat: "1", lon: 1 }, { name: "A", lat: NaN, lon: 1 }, { name: "A", lat: 1, lon: 1, radiusM: 99 }, { name: "A", lat: 1, lon: 1, radiusM: 5001 }, { name: "A", lat: 1, lon: 1, radiusM: "big" },
  ]) {
    await assert.rejects(env.svc.upsertPlace(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
  await assert.rejects(env.svc.upsertPlace({ name: "home", lat: 1, lon: 1 }), (e) => e.status === 409, "names are unique, ignoring case");
  const moved = await env.svc.upsertPlace({ id: home.id, name: "Home", lat: 30.3, lon: -97.8, radiusM: 300 });
  assert.equal(moved.created, false);
  assert.deepEqual([moved.place.lat, moved.place.radiusM, moved.place.id], [30.3, 300, home.id]);
  await assert.rejects(env.svc.upsertPlace({ id: "pl_0000000000", name: "Ghost", lat: 1, lon: 1 }), (e) => e.status === 404);
  await assert.rejects(env.svc.upsertPlace({ id: "../x", name: "Ghost", lat: 1, lon: 1 }), (e) => e.status === 400);
  assert.deepEqual(validatePlaceInput({ name: "Edge", lat: 90, lon: -180, radiusM: 5000 }), { name: "Edge", lat: 90, lon: -180, radiusM: 5000 });
  assert.equal((await env.svc.places()).length, 1);
});

test("rules: the place, agent, windows and days are checked; defaults and edits behave", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  const ok = await env.svc.upsertRule({ placeId: home.id, transition: "exit", instruction: "  Lock up.  " });
  assert.equal(ok.created, true);
  assert.match(ok.rule.id, /^lr_[a-f0-9]{10}$/);
  assert.equal(ok.rule.instruction, "Lock up.");
  assert.equal(ok.rule.name, "Leave Home");
  assert.deepEqual([ok.rule.agentId, ok.rule.once, ok.rule.enabled, ok.rule.fireCount], ["ares", false, true, 0]);
  for (const bad of [
    { placeId: "pl_nope", transition: "enter", instruction: "x y" },
    { placeId: home.id, transition: "arrive", instruction: "x y" },
    { placeId: home.id, transition: "enter", instruction: "" },
    { placeId: home.id, transition: "enter", instruction: "x".repeat(1001) },
    { placeId: home.id, transition: "enter", instruction: "ok ok", agentId: "p_ghost" },
    { placeId: home.id, transition: "enter", instruction: "ok ok", agentId: "../etc" },
    { placeId: home.id, transition: "enter", instruction: "ok ok", days: [7] },
    { placeId: home.id, transition: "enter", instruction: "ok ok", days: "weekdays" },
    { placeId: home.id, transition: "enter", instruction: "ok ok", between: { from: "9", to: "17:00" } },
    { placeId: home.id, transition: "enter", instruction: "ok ok", between: { from: "09:00", to: "09:00" } },
    { placeId: home.id, transition: "enter", instruction: "ok ok", quiet: "nights" },
    { placeId: home.id, transition: "enter", instruction: "ok ok", once: "yes" },
    { placeId: home.id, transition: "enter", instruction: "ok ok", enabled: 1 },
  ]) {
    await assert.rejects(env.svc.upsertRule(bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
  const edited = await env.svc.upsertRule({ id: ok.rule.id, placeId: home.id, transition: "exit", instruction: "Lock up.", agentId: "p_bob", days: [5, 1, 3, 3], between: { from: "9:00", to: "17:00" }, quiet: { from: "22:00", to: "07:00" } });
  assert.equal(edited.created, false);
  assert.deepEqual(edited.rule.days, [1, 3, 5], "sorted and unique");
  assert.deepEqual(edited.rule.between, { from: "09:00", to: "17:00" });
  assert.equal(edited.rule.agentId, "p_bob");
  const cleared = await env.svc.upsertRule({ id: ok.rule.id, placeId: home.id, transition: "exit", instruction: "Lock up.", between: null, days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(cleared.rule.between, undefined, "null clears a window");
  assert.equal(cleared.rule.days, undefined, "all seven days is the same as every day");
  assert.deepEqual(cleared.rule.quiet, { from: "22:00", to: "07:00" }, "an untouched field stays");
  await assert.rejects(env.svc.upsertRule({ id: "lr_0000000000", placeId: home.id, transition: "enter", instruction: "x y" }), (e) => e.status === 404);
  await env.svc.removeRule(ok.rule.id);
  await assert.rejects(env.svc.removeRule(ok.rule.id), (e) => e.status === 404);
});

test("places in use: removing one needs the owner to confirm taking its rules with it", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env, "Home");
  const work = await withPlace(env, "Work");
  await withRule(env, home);
  await withRule(env, home, { transition: "exit" });
  const keep = await withRule(env, work);
  await assert.rejects(env.svc.removePlace(home.id, false), (e) => e.status === 409 && /2 rules use/.test(e.message));
  assert.equal((await env.svc.rules()).length, 3, "nothing was removed");
  assert.deepEqual(await env.svc.removePlace(home.id, true), { removedRules: 2 });
  assert.deepEqual((await env.svc.rules()).map((r) => r.id), [keep.id]);
  assert.deepEqual(await env.svc.removePlace(await withPlace(env, "Gym").then((p) => p.id), false), { removedRules: 0 });
  await assert.rejects(env.svc.removePlace("pl_ffffffffff", true), (e) => e.status === 404);
});

// ── the iOS limit ─────────────────────────────────────────────────────────

test("iOS can watch 20 regions: the 21st place in use is refused with an explanation, and freeing one makes room", async (t) => {
  const env = make(await tempHome(t));
  const rules = [];
  for (let i = 0; i < IOS_REGION_CAP; i++) rules.push(await withRule(env, await withPlace(env, `Place ${i}`, { lat: 30 + i / 100 })));
  assert.equal((await env.svc.snapshot()).limits.regionsInUse, 20);
  const extra = await withPlace(env, "Place 21", { lat: 31 });
  await assert.rejects(env.svc.upsertRule({ placeId: extra.id, transition: "enter", instruction: "one too many" }), (e) => e.status === 409 && /at most 20 places/.test(e.message));
  // Another rule at a place already watched costs nothing.
  await withRule(env, (await env.svc.places())[0], { transition: "exit" });
  assert.equal((await env.svc.snapshot()).limits.regionsInUse, 20);
  // A switched-off rule is not a region; turning it back on is where the limit bites.
  await env.svc.upsertRule({ id: rules[3].id, placeId: rules[3].placeId, transition: "enter", instruction: rules[3].instruction, enabled: false });
  assert.equal((await env.svc.snapshot()).limits.regionsInUse, 19);
  const taken = await withRule(env, extra);
  assert.equal((await env.svc.snapshot()).limits.regionsInUse, 20);
  await assert.rejects(env.svc.upsertRule({ id: rules[3].id, placeId: rules[3].placeId, transition: "enter", instruction: rules[3].instruction, enabled: true }), (e) => e.status === 409);
  await env.svc.removeRule(taken.id);
  assert.equal((await env.svc.upsertRule({ id: rules[3].id, placeId: rules[3].placeId, transition: "enter", instruction: rules[3].instruction, enabled: true })).rule.enabled, true);
  const { limits } = await env.svc.snapshot();
  assert.deepEqual([limits.maxPlaces, limits.maxRules, limits.regionCap], [MAX_PLACES, MAX_RULES, 20]);
});

test("the overall caps: 50 places, 100 rules", async (t) => {
  const env = make(await tempHome(t));
  const places = [];
  for (let i = 0; i < MAX_PLACES; i++) places.push((await env.svc.upsertPlace({ name: `P${i}`, lat: 10 + i / 100, lon: 10 })).place);
  await assert.rejects(env.svc.upsertPlace({ name: "One more", lat: 1, lon: 1 }), (e) => e.status === 409 && /at most 50/.test(e.message));
  for (let i = 0; i < MAX_RULES; i++) await env.svc.upsertRule({ placeId: places[i % IOS_REGION_CAP].id, transition: i % 2 ? "enter" : "exit", instruction: `rule ${i}` });
  await assert.rejects(env.svc.upsertRule({ placeId: places[0].id, transition: "enter", instruction: "too many" }), (e) => e.status === 409 && /at most 100/.test(e.message));
});

// ── the engine matrix ─────────────────────────────────────────────────────

test("matrix: enter and exit rules match only their own crossing, at their own place", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env, "Home");
  const work = await withPlace(env, "Work");
  const arriveHome = await withRule(env, home, { transition: "enter", name: "Arrive home" });
  await withRule(env, home, { transition: "exit", name: "Leave home" });
  await withRule(env, work, { transition: "enter", name: "Arrive at work" });
  const r = await env.svc.handleEvent(event(home, "enter"));
  assert.equal(r.ok, true);
  assert.equal(r.matched, 1);
  assert.deepEqual(r.fired, [{ ruleId: arriveHome.id, name: "Arrive home" }]);
  assert.equal(env.fired.length, 1);
  assert.equal(env.fired[0].place.id, home.id);
  assert.match(env.fired[0].inputId, new RegExp(`^loc_${arriveHome.id}_\\d+$`));
  const none = await env.svc.handleEvent(event(work, "exit"));
  assert.deepEqual([none.matched, none.fired.length], [0, 0]);
  const stored = (await env.svc.rules()).find((x) => x.id === arriveHome.id);
  assert.equal(stored.fireCount, 1);
  assert.equal(stored.lastFiredAt, new Date(WED_NOON).toISOString());
});

test("matrix: weekdays", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  const rule = await withRule(env, home, { days: [1, 2, 3, 4, 5] });
  env.setNow(SAT_NOON);
  const sat = await env.svc.handleEvent(event(home, "enter"));
  assert.deepEqual(sat.skipped, [{ ruleId: rule.id, name: rule.name, reason: "days" }]);
  assert.equal(env.fired.length, 0);
  env.setNow(WED_NOON);
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "d2" }))).fired.length, 1);
  // Sunday is day 0.
  const sunday = make(await tempHome(t), { nowMs: at(2026, 10, 4, 12, 0) });
  const sp = await withPlace(sunday);
  await withRule(sunday, sp, { days: [0] });
  assert.equal((await sunday.svc.handleEvent(event(sp, "enter"))).fired.length, 1);
});

test("matrix: 'between' windows, including one that wraps midnight, evaluated at the moment the phone crossed", async (t) => {
  const probe = async (h, mi) => {
    const env = make(await tempHome(t), { nowMs: at(2026, 9, 30, h, mi) });
    const place = await withPlace(env);
    await withRule(env, place, { name: "Workday", between: { from: "09:00", to: "17:00" } });
    await withRule(env, place, { name: "Night", between: { from: "22:00", to: "06:00" } });
    const r = await env.svc.handleEvent(event(place, "enter"));
    return r.fired.map((f) => f.name);
  };
  assert.deepEqual(await probe(8, 59), []);
  assert.deepEqual(await probe(9, 0), ["Workday"], "the start is inside");
  assert.deepEqual(await probe(16, 59), ["Workday"]);
  assert.deepEqual(await probe(17, 0), [], "the end is outside");
  assert.deepEqual(await probe(21, 59), []);
  assert.deepEqual(await probe(22, 0), ["Night"]);
  assert.deepEqual(await probe(23, 59), ["Night"]);
  assert.deepEqual(await probe(0, 0), ["Night"], "past midnight is still the night window");
  assert.deepEqual(await probe(5, 59), ["Night"]);
  assert.deepEqual(await probe(6, 0), []);
  // The window is the moment of the crossing, not the moment the phone got signal back.
  const late = make(await tempHome(t), { nowMs: at(2026, 9, 30, 9, 5) });
  const lp = await withPlace(late);
  await withRule(late, lp, { between: { from: "09:00", to: "17:00" } });
  const earlier = await late.svc.handleEvent(event(lp, "enter", { at: new Date(at(2026, 9, 30, 8, 58)).toISOString() }));
  assert.equal(earlier.skipped[0].reason, "outside_window", "it crossed at 08:58, before the window opened");
});

test("matrix: quiet hours never fire, even inside the allowed window", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  await withRule(env, home, { quiet: { from: "22:00", to: "07:00" } });
  env.setNow(at(2026, 9, 30, 23, 15));
  assert.equal((await env.svc.handleEvent(event(home, "enter"))).skipped[0].reason, "quiet_hours");
  env.setNow(at(2026, 10, 1, 6, 59));
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "x" }))).skipped[0].reason, "quiet_hours");
  env.setNow(at(2026, 10, 1, 7, 0));
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "y" }))).fired.length, 1);
  assert.equal(env.fired.length, 1);
});

test("matrix: the zone is where the phone is: the event's own zone wins over the garrison's", async (t) => {
  const env = make(await tempHome(t), { nowMs: Date.UTC(2026, 8, 30, 14, 0) }); // 10:00 New York, 23:00 Tokyo
  const home = await withPlace(env);
  await withRule(env, home, { between: { from: "09:00", to: "17:00" } });
  const tokyo = await env.svc.handleEvent({ placeId: home.id, transition: "enter", timeZone: "Asia/Tokyo" });
  assert.equal(tokyo.skipped[0].reason, "outside_window", "23:00 in Tokyo");
  env.setNow(Date.UTC(2026, 8, 30, 14, 5));
  const ny = await env.svc.handleEvent({ placeId: home.id, transition: "enter", timeZone: NY, deviceId: "d2" });
  assert.equal(ny.fired.length, 1);
  // A zone that is not a zone is ignored, not trusted.
  const prior = process.env.ARES_OWNER_TIMEZONE;
  process.env.ARES_OWNER_TIMEZONE = NY;
  t.after(() => { if (prior === undefined) delete process.env.ARES_OWNER_TIMEZONE; else process.env.ARES_OWNER_TIMEZONE = prior; });
  env.setNow(Date.UTC(2026, 8, 30, 14, 8));
  assert.equal((await env.svc.handleEvent({ placeId: home.id, transition: "enter", timeZone: "Nowhere/Land", deviceId: "d3" })).skipped[0].reason, "deduped", "fell back to the owner's zone (inside the window) and only then hit the rule's own dedupe");
});

test("one-shot rules run once, then show as completed until the owner turns them back on", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  const rule = await withRule(env, home, { once: true, name: "Once" });
  assert.equal((await env.svc.handleEvent(event(home, "enter"))).fired.length, 1);
  const after = (await env.svc.rules())[0];
  assert.equal(after.enabled, false);
  assert.equal(after.completedAt, new Date(WED_NOON).toISOString());
  env.setNow(WED_NOON + DEDUPE_MS + 5 * min);
  const second = await env.svc.handleEvent(event(home, "enter", { deviceId: "d2" }));
  assert.deepEqual([second.matched, second.fired.length, second.skipped[0].reason], [1, 0, "completed"]);
  assert.equal(env.fired.length, 1);
  assert.equal((await env.svc.snapshot()).limits.regionsInUse, 0, "a finished one-shot is not a region");
  const rearmed = await env.svc.upsertRule({ id: rule.id, placeId: home.id, transition: "enter", instruction: rule.instruction, once: true, enabled: true });
  assert.equal(rearmed.rule.completedAt, undefined);
  env.setNow(WED_NOON + 2 * DEDUPE_MS);
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "d3" }))).fired.length, 1);
});

test("dedupe: a rule fires at most once per ten minutes whatever the phone resends; the same crossing within a minute is one event", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  const rule = await withRule(env, home);
  const first = await env.svc.handleEvent(event(home, "enter", { deviceId: "phone" }));
  assert.equal(first.fired.length, 1);
  env.setNow(WED_NOON + 30_000);
  const dup = await env.svc.handleEvent(event(home, "enter", { deviceId: "phone" }));
  assert.deepEqual(dup, { ok: true, matched: 0, fired: [], skipped: [], deduped: true });
  env.setNow(WED_NOON + 5 * min);
  const bounce = await env.svc.handleEvent(event(home, "enter", { deviceId: "phone" }));
  assert.deepEqual(bounce.skipped, [{ ruleId: rule.id, name: rule.name, reason: "deduped" }], "GPS bounce at the edge");
  env.setNow(WED_NOON + DEDUPE_MS - 1);
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "other" }))).skipped[0].reason, "deduped");
  env.setNow(WED_NOON + DEDUPE_MS);
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "phone" }))).fired.length, 1, "ten minutes on, it may fire again");
  assert.equal(env.fired.length, 2);
});

test("dedupe survives a restart: a fresh service on the same home still remembers when the rule last fired", async (t) => {
  const home = await tempHome(t);
  const a = make(home);
  const place = await withPlace(a);
  await withRule(a, place);
  assert.equal((await a.svc.handleEvent(event(place, "enter"))).fired.length, 1);
  const b = make(home, { nowMs: WED_NOON + 3 * min });
  const r = await b.svc.handleEvent(event(place, "enter", { deviceId: "late" }));
  assert.equal(r.skipped[0].reason, "deduped");
  assert.equal(b.fired.length, 0);
  assert.equal((await b.svc.places()).length, 1, "places and rules are on disk, under the garrison home");
  assert.ok((await fsp.readFile(path.join(home, "location", "rules.json"), "utf8")).includes("lastFiredAt"));
});

test("rate limit: at most N rules in an hour; the rest are skipped, and the hour rolls", async (t) => {
  const env = make(await tempHome(t), { options: { maxFiresPerHour: 3 } });
  const home = await withPlace(env);
  for (let i = 0; i < 5; i++) await withRule(env, home, { name: `R${i}` });
  const r = await env.svc.handleEvent(event(home, "enter"));
  assert.deepEqual(r.fired.map((f) => f.name), ["R0", "R1", "R2"]);
  assert.deepEqual(r.skipped.map((s) => `${s.name}:${s.reason}`), ["R3:rate_limited", "R4:rate_limited"]);
  env.setNow(WED_NOON + 61 * min);
  const later = await env.svc.handleEvent(event(home, "enter", { deviceId: "d2" }));
  assert.equal(later.fired.length, 3, "an hour on the budget is back");
});

test("pause and kill switch: while Ares is paused nothing fires, and the event is still recorded as skipped", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  await withRule(env, home);
  ownerPause.pause();
  const r = await env.svc.handleEvent(event(home, "enter"));
  assert.deepEqual(r.fired, []);
  assert.equal(r.skipped[0].reason, "paused");
  assert.equal(env.fired.length, 0);
  assert.equal((await env.svc.recent())[0].skipped[0].reason, "paused");
  ownerPause.resume();
  env.setNow(WED_NOON + 2 * min);
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "again" }))).fired.length, 1, "after resume it works; the paused event was not queued behind it");
  env.setNow(WED_NOON + 60 * min);
  process.env.ARES_LOCATION_RULES = "0";
  assert.equal((await env.svc.handleEvent(event(home, "enter", { deviceId: "off" }))).skipped[0].reason, "disabled", "ARES_LOCATION_RULES=0 is a hard off switch");
});

test("stale and odd timestamps: an old queued arrival never runs today's errand", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env);
  await withRule(env, home);
  const old = await env.svc.handleEvent(event(home, "enter", { at: new Date(WED_NOON - 16 * min).toISOString() }));
  assert.equal(old.skipped[0].reason, "stale");
  const fresh = await env.svc.handleEvent(event(home, "enter", { at: new Date(WED_NOON - 10 * min).toISOString(), deviceId: "b" }));
  assert.equal(fresh.fired.length, 1);
  env.setNow(WED_NOON + 5 * min);
  const future = await env.svc.handleEvent(event(home, "enter", { at: new Date(WED_NOON + 3 * 3_600_000).toISOString(), deviceId: "c" }));
  assert.equal(future.skipped[0].reason, "deduped", "a clock from the future is treated as now, not trusted");
  env.setNow(WED_NOON + 40 * min);
  const junk = await env.svc.handleEvent(event(home, "enter", { at: "yesterday-ish", deviceId: "d" }));
  assert.equal(junk.fired.length, 1, "an unreadable stamp means now");
});

test("a rule that cannot start is skipped as failed and does not count as fired; a slow turn does not hold the phone's request", async (t) => {
  const failing = make(await tempHome(t), { fire: async () => { throw new Error("agent p_bob no longer exists"); } });
  const home = await withPlace(failing);
  const rule = await withRule(failing, home);
  const r = await failing.svc.handleEvent(event(home, "enter"));
  assert.deepEqual(r.fired, []);
  assert.equal(r.skipped[0].reason, "failed");
  assert.equal((await failing.svc.rules())[0].lastFiredAt, undefined, "a failure leaves no latch: the next arrival tries again");
  assert.equal((await failing.svc.rules())[0].fireCount, 0);
  assert.ok(failing.logs.some((l) => /could not start/.test(l)));
  assert.equal(rule.id, (await failing.svc.rules())[0].id);

  // A turn that takes minutes: the request returns once the turn had its moment to refuse.
  let finish;
  const slow = make(await tempHome(t), { fire: () => new Promise((resolve) => { finish = resolve; }), options: { admitMs: 20 } });
  const sp = await withPlace(slow);
  await withRule(slow, sp);
  const started = Date.now();
  const sr = await slow.svc.handleEvent(event(sp, "enter"));
  assert.ok(Date.now() - started < 500, "returned without waiting for the turn to end");
  assert.equal(sr.fired.length, 1);
  finish();
  // ...and a turn that only fails later is logged, never thrown into the phone's request.
  let late;
  const lateFail = make(await tempHome(t), { fire: () => new Promise((_, reject) => { late = reject; }), options: { admitMs: 20 } });
  const lp = await withPlace(lateFail);
  await withRule(lateFail, lp);
  assert.equal((await lateFail.svc.handleEvent(event(lp, "enter"))).fired.length, 1);
  late(new Error("provider fell over"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(lateFail.logs.some((l) => /ended with an error \(provider fell over\)/.test(l)));
});

test("events: unknown place, bad transition and flooding are refused; every decision is audited without secrets", async (t) => {
  const env = make(await tempHome(t));
  const home = await withPlace(env, "Home");
  const rule = await withRule(env, home, { quiet: { from: "12:00", to: "13:00" } });
  await assert.rejects(env.svc.handleEvent({ placeId: "pl_nonexistent", transition: "enter" }), (e) => e.status === 404);
  await assert.rejects(env.svc.handleEvent({ placeId: home.id, transition: "arrive" }), (e) => e.status === 400);
  await assert.rejects(env.svc.handleEvent({ transition: "enter" }), (e) => e.status === 404);
  await env.svc.handleEvent(event(home, "enter", { deviceId: "iPhone-1" }));
  assert.equal(env.audits.length, 1);
  assert.deepEqual(env.audits[0], { actor: "location", action: "location.rule", target: rule.name, params: { rule: rule.id, place: "Home", transition: "enter", device: "iPhone-1" }, result: "skipped: quiet_hours" });
  env.setNow(at(2026, 9, 30, 14, 0));
  await env.svc.handleEvent(event(home, "enter", { deviceId: "iPhone-1" }));
  assert.equal(env.audits[1].result, "fired");
  const flood = make(await tempHome(t));
  const fp = await withPlace(flood);
  let refused = 0;
  for (let i = 0; i < 80; i++) {
    try { await flood.svc.handleEvent(event(fp, i % 2 ? "enter" : "exit", { deviceId: `d${i}` })); } catch (e) { if (e.status === 429) refused++; }
  }
  assert.ok(refused >= 15, `a flood is refused (${refused})`);
});

test("the turn a rule starts: names the crossing, carries the owner's words, asks for approval and grants none", () => {
  const place = { id: "pl_aaaaaaaaaa", name: "Work", lat: 1, lon: 1, radiusM: 150, createdAt: "x" };
  const rule = { id: "lr_aaaaaaaaaa", name: "r", placeId: place.id, transition: "exit", agentId: "ares", instruction: "Text Dana that I'm on my way.", once: false, enabled: true, createdAt: "x", fireCount: 0 };
  const text = ruleTurnText({ rule, place, eventMs: at(2026, 9, 30, 17, 5), timeZone: NY });
  assert.match(text, /^\(System: a location rule just fired: the owner left "Work" at 17:05 on Wednesday\./);
  assert.match(text, /usual approval on their phone: ask, do not assume/);
  assert.match(text, /if it is refused, stop and tell them/);
  assert.doesNotMatch(text, /auto-?approve|without asking|always allow|you have permission/i);
  assert.equal(stripPreamble(text), "Text Dana that I'm on my way.", "the note strips; the thread reads as the owner's own instruction");
  assert.match(ruleTurnText({ rule: { ...rule, transition: "enter" }, place, eventMs: at(2026, 9, 30, 8, 0), timeZone: NY }), /arrived at "Work" at 08:00/);
});

// ── HTTP, through a real RemoteAgentServer ────────────────────────────────

async function serve(t, home, over = {}) {
  const env = make(home, over);
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", phoneApi: { location: createLocationApi(env.svc) } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  env.call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return env;
}

test("http: every route needs the owner's bearer", async (t) => {
  const s = await serve(t, await tempHome(t));
  for (const [method, p, body] of [
    ["GET", "/gateway/location"], ["GET", "/gateway/location/places"], ["POST", "/gateway/location/places", { name: "A", lat: 1, lon: 1 }], ["DELETE", "/gateway/location/places/pl_aaaaaaaaaa"],
    ["GET", "/gateway/location/rules"], ["POST", "/gateway/location/rules", {}], ["DELETE", "/gateway/location/rules/lr_aaaaaaaaaa"],
    ["POST", "/gateway/location/event", { placeId: "pl_aaaaaaaaaa", transition: "enter" }], ["GET", "/gateway/location/recent"],
  ]) {
    assert.equal((await s.call(method, p, body, null)).status, 401, `${method} ${p} without a token`);
    assert.equal((await s.call(method, p, body, "guest-tok")).status, 401, `${method} ${p} with a wrong token`);
  }
  assert.equal((await s.svc.places()).length, 0, "a stranger created nothing");
  assert.equal(s.fired.length, 0);
});

test("http: places and rules round trip, with the limits the screen explains", async (t) => {
  const s = await serve(t, await tempHome(t));
  const empty = await s.call("GET", "/gateway/location");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { places: [], rules: [], limits: { maxPlaces: 50, maxRules: 100, regionCap: 20, regionsInUse: 0 }, recent: [] });
  const made = await s.call("POST", "/gateway/location/places", { name: "Home", lat: 30.2672, lon: -97.7431, radiusM: 200 });
  assert.equal(made.status, 201);
  const place = made.body.place;
  assert.equal((await s.call("POST", "/gateway/location/places", { name: "Home", lat: 1, lon: 1 })).status, 409);
  assert.equal((await s.call("POST", "/gateway/location/places", { name: "Bad", lat: 99, lon: 1 })).status, 400);
  assert.equal((await s.call("POST", "/gateway/location/places", { id: place.id, name: "Home", lat: 30.3, lon: -97.7, radiusM: 250 })).status, 200);
  const rule = await s.call("POST", "/gateway/location/rules", { placeId: place.id, transition: "enter", instruction: "Read me my day.", days: [1, 2, 3, 4, 5], between: { from: "16:00", to: "20:00" }, agentId: "p_bob" });
  assert.equal(rule.status, 201);
  assert.equal(rule.body.rule.agentId, "p_bob");
  assert.equal((await s.call("POST", "/gateway/location/rules", { placeId: "pl_nope", transition: "enter", instruction: "x y" })).status, 400);
  assert.equal((await s.call("POST", "/gateway/location/rules", { id: rule.body.rule.id, placeId: place.id, transition: "enter", instruction: "Read me my day, then my mail.", enabled: false })).status, 200);
  const all = await s.call("GET", "/gateway/location");
  assert.equal(all.body.places[0].radiusM, 250);
  assert.equal(all.body.rules[0].instruction, "Read me my day, then my mail.");
  assert.equal(all.body.limits.regionsInUse, 0, "the rule is off");
  assert.deepEqual((await s.call("GET", "/gateway/location/places")).body.places.map((p) => p.name), ["Home"]);
  assert.deepEqual((await s.call("GET", "/gateway/location/rules")).body.rules.length, 1);
  // A place in use is not removed without the owner's say-so.
  const blocked = await s.call("DELETE", `/gateway/location/places/${place.id}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /a rule uses this place/);
  assert.equal((await s.call("DELETE", `/gateway/location/rules/${rule.body.rule.id}`)).status, 200);
  assert.equal((await s.call("DELETE", `/gateway/location/rules/${rule.body.rule.id}`)).status, 404);
  assert.deepEqual((await s.call("DELETE", `/gateway/location/places/${place.id}`)).body, { ok: true, removedRules: 0 });
  assert.equal((await s.call("DELETE", `/gateway/location/places/${place.id}`)).status, 404);
  assert.equal((await s.call("DELETE", "/gateway/location/places/..%2F..%2Fetc")).status, 404, "an id is not a path");
  // Wrong verbs and unknown routes.
  assert.equal((await s.call("PATCH", "/gateway/location/places", {})).status, 405);
  assert.equal((await s.call("GET", "/gateway/location/event")).status, 405);
  assert.equal((await s.call("DELETE", "/gateway/location")).status, 405);
  assert.equal((await s.call("GET", "/gateway/location/nonsense")).status, 404);
  assert.equal((await s.call("POST", "/gateway/location/places", "not json{")).status, 400);
  assert.equal((await s.call("POST", "/gateway/location/places", { name: "x".repeat(20_000), lat: 1, lon: 1 })).status, 413);
});

test("http: the phone's events fire rules, are deduped, audited and shown back in recent", async (t) => {
  const s = await serve(t, await tempHome(t));
  const place = (await s.call("POST", "/gateway/location/places", { name: "Home", lat: 30, lon: -97 })).body.place;
  const rule = (await s.call("POST", "/gateway/location/rules", { placeId: place.id, transition: "enter", instruction: "Welcome me home." })).body.rule;
  const unknown = await s.call("POST", "/gateway/location/event", { placeId: "pl_0123456789", transition: "enter" });
  assert.equal(unknown.status, 404);
  assert.equal((await s.call("POST", "/gateway/location/event", { placeId: place.id, transition: "sideways" })).status, 400);
  const fired = await s.call("POST", "/gateway/location/event", { placeId: place.id, transition: "enter", at: new Date(WED_NOON).toISOString(), deviceId: "iphone", timeZone: NY });
  assert.equal(fired.status, 200);
  assert.deepEqual(fired.body, { ok: true, matched: 1, fired: [{ ruleId: rule.id, name: rule.name }], skipped: [] });
  assert.equal(s.fired.length, 1);
  assert.match(s.fired[0].text, /Welcome me home\.$/);
  const dup = await s.call("POST", "/gateway/location/event", { placeId: place.id, transition: "enter", deviceId: "iphone", timeZone: NY });
  assert.equal(dup.body.deduped, true);
  const recent = (await s.call("GET", "/gateway/location/recent")).body.events;
  assert.equal(recent.length, 1);
  assert.deepEqual([recent[0].placeName, recent[0].transition, recent[0].fired, recent[0].deviceId], ["Home", "enter", 1, "iphone"]);
  assert.equal((await s.call("GET", "/gateway/location")).body.recent.length, 1);
  assert.equal(s.audits.at(-1).result, "fired");
  ownerPause.pause();
  s.setNow(WED_NOON + 30 * min);
  const paused = await s.call("POST", "/gateway/location/event", { placeId: place.id, transition: "enter", deviceId: "iphone", timeZone: NY });
  assert.equal(paused.body.skipped[0].reason, "paused");
  assert.equal(s.fired.length, 1);
});

// ── never auto-approves ───────────────────────────────────────────────────

const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };

test("a rule's turn is an ordinary owner turn: a dangerous action waits for the owner's phone and is never pre-approved", async (t) => {
  const home = await tempHome(t);
  const seen = { text: [], decision: undefined, asked: false };
  const sessions = new SessionManager({
    home,
    permissionTimeoutMs: 60_000,
    factory: ({ requestPermission }) => {
      let current = "";
      return {
        engine: {
          appendUserMessageContent(content) { current = content.map((b) => b.text ?? "").join(""); seen.text.push(current); },
          hydrate() {},
          history: () => [],
          streamTurn: async function* () {
            seen.asked = true;
            yield { type: "permission_request", id: "p1", toolName: "Stripe", input: { url: "https://pay.example/c" } };
            seen.decision = await requestPermission({ id: "p1", toolName: "Stripe", input: { url: "https://pay.example/c" }, reason: "money" });
            yield { type: "text_delta", text: "Done." };
            yield TURN_END;
          },
        },
        providerName: "fake",
        model: "fake",
        workspace: home,
      };
    },
  });
  const main = sessions.create({ surface: "mobile", tenant: { role: "owner" } }).id;
  const bob = sessions.create({ surface: "mobile", tenant: { role: "owner" } }).id;
  const personas = { store: { get: (id) => (id === "p_bob" ? { sessionId: bob } : undefined) }, defaultThread: async () => main };
  const env = make(home, { fire: makeLocationFirer({ sessions, personas }) });
  const place = await withPlace(env);
  await withRule(env, place, { instruction: "Pay the parking meter." });
  const events = [];
  sessions.attach(main, (e) => events.push(e));
  const r = await env.svc.handleEvent(event(place, "enter"));
  assert.equal(r.fired.length, 1);
  for (let i = 0; i < 200 && !seen.asked; i++) await new Promise((res) => setTimeout(res, 5));
  assert.ok(seen.asked, "the turn started in the default thread");
  assert.match(seen.text[0], /^\(System: a location rule just fired/);
  assert.match(seen.text[0], /Pay the parking meter\.$/);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(seen.decision, undefined, "nothing answered the permission prompt on the owner's behalf");
  assert.ok(events.some((e) => e.type === "permission_request"), "the prompt is on its way to the owner's phone");
  assert.ok(sessions.respondPermission(main, "p1", "deny"), "only the owner's own answer resolves it");
  for (let i = 0; i < 200 && seen.decision === undefined; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(seen.decision, "deny");

  // A rule for a named agent goes to that agent's own thread.
  env.setNow(WED_NOON + 5 * min);
  seen.asked = false;
  seen.decision = undefined;
  const second = await withRule(env, place, { agentId: "p_bob", instruction: "Check on the invoices.", name: "Bob's rule" });
  const r2 = await env.svc.handleEvent(event(place, "enter", { deviceId: "b" }));
  assert.deepEqual(r2.fired.map((f) => f.ruleId), [second.id], "the first rule is inside its ten minutes");
  for (let i = 0; i < 200 && !seen.asked; i++) await new Promise((res) => setTimeout(res, 5));
  assert.match(seen.text.at(-1), /Check on the invoices\.$/);
  assert.ok(sessions.respondPermission(bob, "p1", "deny"), "the prompt belongs to Bob's thread");
});

test("a rule whose agent is gone fails loudly instead of running as someone else", async () => {
  const sessions = { create: () => ({ id: "x" }), ensureLive: async () => ({}), send: async () => { throw new Error("must not run"); } };
  const fire = makeLocationFirer({ sessions, personas: { store: { get: () => undefined }, defaultThread: async () => "main" } });
  await assert.rejects(fire({ agentId: "p_ghost" }, {}, "t", "i"), /no longer exists/);
});
