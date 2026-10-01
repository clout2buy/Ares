// The phone's Goals tab, now writable: create, edit, finish/pause/reopen,
// delete, leave a progress note, page the timeline, ask for a check-in now.
// Real RemoteAgentServer (so the owner-bearer gate is the production one) with
// the real goals API over a real GoalsStore in a temp home; only the garrison
// couplings (agents, the runner) are fakes.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalsStore, GoalsTool, goalNotesPage, goalSummary, parseGoalFields } from "../packages/tools/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createGoalsApi } from "../packages/cli/dist/phoneGoals.js";
import { OwnerControlPlane } from "../packages/cli/dist/entry/ownerControlPlane.js";
import { appendAudit } from "../packages/core/dist/index.js";

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-phone-goals-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

const AGENTS = [{ id: "ares", name: "Ares" }, { id: "p_aaaa", name: "Coach" }];

async function serve(t, home, extra = {}) {
  const audits = [];
  const api = createGoalsApi({
    home,
    agents: () => AGENTS,
    audit: (e) => audits.push(e),
    ...extra,
  });
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", home,
    phoneApi: { goals: api },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, audits, base };
}

test("auth: every goals route is owner-only", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  for (const [method, p, body] of [
    ["GET", "/gateway/goals"],
    ["POST", "/gateway/goals", { title: "x" }],
    ["POST", "/gateway/goals/update", { id: "g", title: "y" }],
    ["POST", "/gateway/goals/status", { id: "g", status: "done" }],
    ["POST", "/gateway/goals/note", { id: "g", text: "n" }],
    ["POST", "/gateway/goals/delete", { id: "g" }],
    ["GET", "/gateway/goals/notes?id=g"],
    ["POST", "/gateway/goals/checkin", { id: "g" }],
  ]) {
    assert.equal((await s.call(method, p, body, null)).status, 401, `${method} ${p} without a token`);
    assert.equal((await s.call(method, p, body, "guest-tok")).status, 401, `${method} ${p} with a wrong token`);
  }
  assert.equal((await new GoalsStore(home).load()).length, 0, "nothing was written for an unauthenticated caller");
  assert.deepEqual(s.audits, []);
});

test("create -> list -> edit -> note -> pause -> reopen -> done -> delete, each audited", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);

  const made = await s.call("POST", "/gateway/goals", {
    title: "  Run a 5k  ", detail: "Couch to 5k.\nThree runs a week.", category: "Health", dueAt: "2026-12-01", target: "5 km without stopping",
  });
  assert.equal(made.status, 201);
  const goal = made.body.goal;
  assert.match(goal.id, /^g_/);
  assert.equal(goal.title, "Run a 5k");
  assert.equal(goal.category, "health");
  assert.equal(goal.status, "active");
  assert.equal(goal.dueAt, "2026-12-01T00:00:00.000Z");
  assert.equal(goal.detail, "Couch to 5k.\nThree runs a week.");
  assert.equal(goal.agentId, undefined, "no agent: nothing will check in");
  assert.equal(goal.nextCheckIn, undefined);
  assert.equal(goal.noteCount, 1, "the timeline starts with the creation line");
  assert.equal(goal.notes[0].by, "system");

  const listed = await s.call("GET", "/gateway/goals");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.goals.length, 1);
  assert.deepEqual(listed.body.agents, AGENTS);
  assert.equal(listed.body.canRun, false, "no runner wired in this fixture");

  const edited = await s.call("POST", "/gateway/goals/update", { id: goal.id, title: "Run a 10k", progress: 0.2, detail: null });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.goal.title, "Run a 10k");
  assert.equal(edited.body.goal.progress, 0.2);
  assert.equal(edited.body.goal.detail, undefined, "null clears a field");

  const noted = await s.call("POST", "/gateway/goals/note", { id: goal.id, text: "Did 2 km today.", progress: 0.4 });
  assert.equal(noted.status, 200);
  assert.equal(noted.body.note.by, "owner");
  assert.equal(noted.body.goal.progress, 0.4);
  assert.equal(noted.body.goal.note, "Did 2 km today.");

  const paused = await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "paused" });
  assert.equal(paused.body.goal.status, "paused");
  assert.equal(paused.body.goal.notes.at(-1).text, "Paused");
  // A paused goal is still listed with the open ones.
  assert.equal((await s.call("GET", "/gateway/goals")).body.goals[0].status, "paused");

  const reopened = await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "reopen" });
  assert.equal(reopened.body.goal.status, "active");

  const done = await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "done" });
  assert.equal(done.body.goal.status, "done");
  assert.equal(done.body.goal.progress, 1);
  assert.equal(done.body.goal.nextCheckIn, undefined);

  const again = await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "reopen" });
  assert.equal(again.body.goal.status, "active");
  assert.equal(again.body.goal.progress, undefined, "reopening something finished must not keep claiming 100%");

  const noop = await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "active" });
  assert.equal(noop.status, 200, "setting the state it is already in is not an error");

  assert.equal((await s.call("POST", "/gateway/goals/delete", { id: goal.id })).status, 200);
  assert.equal((await s.call("GET", "/gateway/goals")).body.goals.length, 0);
  assert.equal((await s.call("POST", "/gateway/goals/delete", { id: goal.id })).status, 404);

  const actions = s.audits.map((a) => a.action);
  assert.deepEqual(actions, ["goal.create", "goal.update", "goal.note", "goal.status", "goal.status", "goal.status", "goal.status", "goal.delete"]);
  assert.ok(s.audits.every((a) => a.actor === "owner" && a.target === goal.id));
  assert.ok(!JSON.stringify(s.audits).includes("Did 2 km"), "the audit line names the action, never the note's words");
});

test("the original close route still works and lands in the timeline", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const { goal } = (await s.call("POST", "/gateway/goals", { title: "Save $500" })).body;
  const closed = await s.call("POST", "/gateway/goals/close", { id: goal.id, status: "dropped" });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.ok, true);
  assert.equal(closed.body.goal.status, "dropped");
  assert.equal((await s.call("POST", "/gateway/goals/close", { id: "g_nope" })).status, 404);
});

test("validation: bad fields are 400 and never reach the file", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const bad = [
    {},
    { title: "" },
    { title: "   " },
    { title: 5 },
    { title: "x".repeat(201) },
    { title: "ok", category: "hobbies" },
    { title: "ok", dueAt: "not a date" },
    { title: "ok", detail: "x".repeat(2001) },
    { title: "ok", agentId: "p_unknown" },
    { title: "ok", agentId: "../etc" },
    { title: "ok", cadence: "hourly" },
    { title: "ok", progress: 2 },
    { title: "ok", nextCheckIn: "soon" },
    { title: "ok", clientId: "has spaces" },
    [],
    "not json{",
  ];
  for (const body of bad) {
    const r = await s.call("POST", "/gateway/goals", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(r.body.error);
  }
  assert.equal((await new GoalsStore(home).load()).length, 0);
  assert.equal((await s.call("POST", "/gateway/goals", "x".repeat(20_000))).status, 413, "an oversize body is refused");

  const { goal } = (await s.call("POST", "/gateway/goals", { title: "fine" })).body;
  assert.equal((await s.call("POST", "/gateway/goals/update", { id: goal.id })).status, 400, "nothing to change");
  assert.equal((await s.call("POST", "/gateway/goals/update", { id: goal.id, category: "nope" })).status, 400);
  assert.equal((await s.call("POST", "/gateway/goals/update", { id: "g_nope", title: "x" })).status, 404);
  assert.equal((await s.call("POST", "/gateway/goals/status", { id: goal.id, status: "finished" })).status, 400);
  assert.equal((await s.call("POST", "/gateway/goals/status", { status: "done" })).status, 400, "id required");
  assert.equal((await s.call("POST", "/gateway/goals/note", { id: goal.id, text: "" })).status, 400);
  assert.equal((await s.call("POST", "/gateway/goals/note", { id: goal.id, text: "x".repeat(601) })).status, 400);
  assert.equal((await s.call("POST", "/gateway/goals/note", { id: goal.id, text: "ok", progress: 1.5 })).status, 400);
  assert.equal((await s.call("POST", "/gateway/goals/note", { id: "g_nope", text: "ok" })).status, 404);
  assert.equal((await s.call("GET", "/gateway/goals/notes")).status, 400);
  assert.equal((await s.call("GET", "/gateway/goals/notes?id=g_nope")).status, 404);
  assert.equal((await s.call("PUT", "/gateway/goals", { title: "x" })).status, 404, "an unknown method falls through, it is not handled as a write");
});

test("a retried create with the same clientId returns the first goal, not a second", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const first = await s.call("POST", "/gateway/goals", { title: "Read more", clientId: "cl_1" });
  const retry = await s.call("POST", "/gateway/goals", { title: "Read more", clientId: "cl_1" });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.goal.id, first.body.goal.id);
  assert.equal((await new GoalsStore(home).load()).length, 1);
  assert.equal(s.audits.filter((a) => a.action === "goal.create").length, 1, "the replay is not a second audited creation");
  const raw = JSON.parse(await fsp.readFile(path.join(home, "goals.json"), "utf8"));
  assert.equal(raw.goals[0].clientId, "cl_1");
  assert.equal((await s.call("GET", "/gateway/goals")).body.goals[0].clientId, undefined, "the idempotency token is not part of the view");
});

test("assigning an agent schedules a check-in; unassigning clears it", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const before = Date.now();
  const made = (await s.call("POST", "/gateway/goals", { title: "Learn Spanish", agentId: "p_aaaa", cadence: "weekly" })).body.goal;
  assert.equal(made.agentId, "p_aaaa");
  assert.equal(made.agentName, "Coach");
  assert.equal(made.cadence, "weekly");
  assert.ok(Date.parse(made.nextCheckIn) >= before - 5 && Date.parse(made.nextCheckIn) <= Date.now() + 5, "first check-in is due now");

  const later = "2030-01-02T09:00:00.000Z";
  const moved = (await s.call("POST", "/gateway/goals/update", { id: made.id, nextCheckIn: later })).body.goal;
  assert.equal(moved.nextCheckIn, later);
  const cadence = (await s.call("POST", "/gateway/goals/update", { id: made.id, cadence: "daily" })).body.goal;
  assert.equal(cadence.cadence, "daily");
  assert.equal(cadence.nextCheckIn, later, "changing the cadence does not move the next check-in");

  const none = (await s.call("POST", "/gateway/goals/update", { id: made.id, agentId: null })).body.goal;
  assert.equal(none.agentId, undefined);
  assert.equal(none.nextCheckIn, undefined, "a goal nobody works carries no schedule");

  // No agent means nothing to check in.
  const bare = (await s.call("POST", "/gateway/goals", { title: "Bare" })).body.goal;
  assert.equal(bare.nextCheckIn, undefined);
  // Giving it to the default assistant.
  const given = (await s.call("POST", "/gateway/goals/update", { id: bare.id, agentId: "ares" })).body.goal;
  assert.equal(given.agentId, "ares");
  assert.equal(given.cadence, "daily");
  assert.ok(given.nextCheckIn);
});

test("pausing and finishing a goal stops its schedule; resuming restarts it", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const g = (await s.call("POST", "/gateway/goals", { title: "Walk", agentId: "ares", nextCheckIn: "2031-01-01T00:00:00Z" })).body.goal;
  assert.equal(g.nextCheckIn, "2031-01-01T00:00:00.000Z");
  const paused = (await s.call("POST", "/gateway/goals/status", { id: g.id, status: "paused" })).body.goal;
  assert.equal(paused.status, "paused");
  const resumed = (await s.call("POST", "/gateway/goals/status", { id: g.id, status: "active" })).body.goal;
  assert.equal(resumed.nextCheckIn, "2031-01-01T00:00:00.000Z", "a future check-in survives a pause");
  const done = (await s.call("POST", "/gateway/goals/status", { id: g.id, status: "done" })).body.goal;
  assert.equal(done.nextCheckIn, undefined);
  const reopened = (await s.call("POST", "/gateway/goals/status", { id: g.id, status: "reopen" })).body.goal;
  assert.ok(Date.parse(reopened.nextCheckIn) <= Date.now() + 5, "a goal reopened with an agent is due again");
});

test("the timeline pages newest first with a cursor, 100 notes at most", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home);
  const g = (await s.call("POST", "/gateway/goals", { title: "Journal" })).body.goal;
  for (let i = 1; i <= 7; i++) await s.call("POST", "/gateway/goals/note", { id: g.id, text: `note ${i}` });

  const first = (await s.call("GET", `/gateway/goals/notes?id=${g.id}&limit=3`)).body;
  assert.deepEqual(first.notes.map((n) => n.text), ["note 7", "note 6", "note 5"]);
  assert.equal(first.total, 8, "7 notes plus the creation line");
  assert.ok(first.nextBefore);
  const second = (await s.call("GET", `/gateway/goals/notes?id=${g.id}&limit=3&before=${first.nextBefore}`)).body;
  assert.deepEqual(second.notes.map((n) => n.text), ["note 4", "note 3", "note 2"]);
  const third = (await s.call("GET", `/gateway/goals/notes?id=${g.id}&limit=3&before=${second.nextBefore}`)).body;
  assert.deepEqual(third.notes.map((n) => n.text), ["note 1", "Goal created"]);
  assert.equal(third.nextBefore, undefined, "the last page has no cursor");
  const past = (await s.call("GET", `/gateway/goals/notes?id=${g.id}&before=n_gone`)).body;
  assert.deepEqual(past.notes, [], "a cursor that aged out ends the paging instead of repeating rows");

  // The list carries only the newest few, with the real count.
  const listed = (await s.call("GET", "/gateway/goals")).body.goals[0];
  assert.equal(listed.notes.length, 3);
  assert.equal(listed.noteCount, 8);

  // The cap: the oldest fall off.
  const store = new GoalsStore(home);
  for (let i = 0; i < 120; i++) await store.addNote(g.id, { text: `bulk ${i}`, by: "owner" });
  const goal = await store.get(g.id);
  assert.equal(goal.notes.length, 100);
  assert.equal(goal.notes.at(-1).text, "bulk 119");
  assert.equal(goalNotesPage(goal, { limit: 500 }).notes.length, 100);
  assert.equal(goalSummary(goal).noteCount, 100);
});

test("check-in now: refusals map to 404/409, a start is 202 and audited; no runner is 501", async (t) => {
  const home = await tempHome(t);
  const bare = await serve(t, home);
  const g = (await bare.call("POST", "/gateway/goals", { title: "Stretch", agentId: "ares" })).body.goal;
  assert.equal((await bare.call("POST", "/gateway/goals/checkin", { id: g.id })).status, 501);

  const calls = [];
  let outcome = { started: true };
  const t2 = await tempHome(t);
  const s = await serve(t, t2, {
    runner: { checkInNow: async (id) => { calls.push(id); return outcome; }, isRunning: (id) => id === "running-one" },
  });
  const goal = (await s.call("POST", "/gateway/goals", { title: "Stretch", agentId: "ares" })).body.goal;
  const ok = await s.call("POST", "/gateway/goals/checkin", { id: goal.id });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.started, true);
  assert.deepEqual(calls, [goal.id]);
  assert.ok(s.audits.some((a) => a.action === "goal.checkin" && a.target === goal.id));

  for (const [reason, status] of [["unknown", 404], ["no-agent", 409], ["not-active", 409], ["busy", 409], ["paused", 409], ["running", 409], ["no-thread", 409]]) {
    outcome = { started: false, reason };
    const r = await s.call("POST", "/gateway/goals/checkin", { id: goal.id });
    assert.equal(r.status, status, reason);
    assert.equal(r.body.reason, reason);
    assert.ok(r.body.error);
  }
  assert.equal((await s.call("GET", "/gateway/goals")).body.canRun, true);
});

test("the running flag rides the goal view while a check-in is in flight", async (t) => {
  const home = await tempHome(t);
  const store = new GoalsStore(home);
  const { goal } = await store.create({ title: "Run", agentId: "ares" });
  const s = await serve(t, home, { runner: { checkInNow: async () => ({ started: true }), isRunning: (id) => id === goal.id } });
  const row = (await s.call("GET", "/gateway/goals")).body.goals[0];
  assert.equal(row.running, true);
});

test("without the goals hook the original list and close routes still answer (the library fallback)", async (t) => {
  const home = await tempHome(t);
  const goal = (await new GoalsStore(home).create({ title: "Old goal" })).goal;
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", home, phoneApi: {} });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer owner-tok" };
  const listed = await (await fetch(`${base}/gateway/goals`, { headers: auth })).json();
  assert.equal(listed.goals[0].id, goal.id);
  assert.equal((await fetch(`${base}/gateway/goals/close`, { method: "POST", headers: auth, body: JSON.stringify({ id: goal.id }) })).status, 200);
  assert.equal((await fetch(`${base}/gateway/goals`, { method: "POST", headers: auth, body: JSON.stringify({ title: "new" }) })).status, 404, "creating needs the goals hook");
});

test("the Goals tool writes to the same timeline, attributed to the agent", async (t) => {
  const home = await tempHome(t);
  const prev = process.env.ARES_HOME;
  process.env.ARES_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.ARES_HOME; else process.env.ARES_HOME = prev; });
  const signal = new AbortController().signal;
  const added = await GoalsTool.call({ action: "add", title: "Save $500 a month", category: "finance", note: "Opened the account" }, { signal });
  const id = added.output.goal.id;
  assert.equal(added.output.goal.createdBy, "agent");
  await GoalsTool.call({ action: "update", id, progress: 0.25, note: "Moved $125 over" }, { signal });
  const closed = await GoalsTool.call({ action: "close", id, status: "dropped", note: "Plans changed" }, { signal });
  assert.equal(closed.output.goal.status, "dropped");
  const goal = await new GoalsStore(home).get(id);
  assert.deepEqual(goal.notes.map((n) => [n.by, n.text]), [
    ["system", "Goal created"],
    ["agent", "Opened the account"],
    ["agent", "Moved $125 over"],
    ["agent", "Plans changed"],
    ["system", "Dropped"],
  ]);
  assert.equal(goal.notes[2].progress, 0.25);
  assert.equal(goal.note, "Plans changed", "the latest agent word, not the status line");
});

test("old goals.json files (no notes, no new fields) still load and list", async (t) => {
  const home = await tempHome(t);
  await fsp.writeFile(path.join(home, "goals.json"), JSON.stringify({ version: 1, goals: [
    { id: "g_old", title: "Legacy", category: "other", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "g_odd", title: "Odd status", category: "other", status: "mystery", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", notes: [{ id: "n1" }, { id: "n2", at: "x", text: "ok", by: "owner" }] },
  ] }));
  const s = await serve(t, home);
  const { goals } = (await s.call("GET", "/gateway/goals")).body;
  assert.equal(goals.length, 2);
  const legacy = goals.find((g) => g.id === "g_old");
  assert.equal(legacy.noteCount, 0);
  assert.deepEqual(legacy.notes, []);
  assert.equal(goals.find((g) => g.id === "g_odd").status, "active", "an unknown status is read as active, not dropped");
  assert.equal(goals.find((g) => g.id === "g_odd").noteCount, 1, "a malformed note is skipped");
});

test("parseGoalFields: the shared validator", () => {
  assert.deepEqual(parseGoalFields({ title: "  a   b " }), { title: "a b" });
  assert.deepEqual(parseGoalFields({ agentId: "" }), { agentId: null });
  assert.deepEqual(parseGoalFields({ dueAt: "" }), { dueAt: null });
  assert.throws(() => parseGoalFields({ progress: "half" }), /progress/);
  assert.deepEqual(parseGoalFields({ unknown: 1 }), {}, "unknown keys are ignored");
});

test("audit paging: goal actions are readable newest first, in pages, filtered by target", async (t) => {
  const home = await tempHome(t);
  const plane = new OwnerControlPlane({ home, sessions: { interruptAll: () => ({ turns: 0, waiting: 0 }), denyAllPendingPermissions: () => 0, runningTurns: () => [] } });
  // Five days of history ending now, one entry per day per goal.
  const base = Date.now();
  const day = (i, hour) => new Date(base - (5 - i) * 86_400_000 - hour * 3_600_000).toISOString();
  for (let i = 0; i < 5; i++) {
    await appendAudit({ actor: "owner", action: "goal.note", target: "g_one", ts: day(i, 2) }, home);
    await appendAudit({ actor: "owner", action: "goal.note", target: "g_two", ts: day(i, 1) }, home);
  }
  await appendAudit({ actor: "scheduler", action: "scheduler.heartbeat", ts: day(4, 0) }, home);
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", home,
    phoneApi: { ownerControl: plane },
  });
  await server.start();
  t.after(() => server.close());
  const get = async (q) => (await fetch(`http://127.0.0.1:${server.port}/gateway/audit?${q}`, { headers: { authorization: "Bearer owner-tok" } })).json();

  const all = await get("limit=1000&days=30&action=goal.&target=g_one");
  assert.equal(all.entries.length, 5);
  assert.ok(all.entries.every((e) => e.target === "g_one" && e.action.startsWith("goal.")));
  assert.equal(all.nextBefore, undefined, "a short page has no cursor");

  const p1 = await get("limit=2&days=30&action=goal.&target=g_one");
  assert.deepEqual(p1.entries.map((e) => e.ts), [day(4, 2), day(3, 2)]);
  assert.equal(p1.nextBefore, day(3, 2));
  const p2 = await get(`limit=2&days=30&action=goal.&target=g_one&before=${p1.nextBefore}`);
  assert.deepEqual(p2.entries.map((e) => e.ts), [day(2, 2), day(1, 2)]);
  const p3 = await get(`limit=2&days=30&action=goal.&target=g_one&before=${p2.nextBefore}`);
  assert.deepEqual(p3.entries.map((e) => e.ts), [day(0, 2)]);
  assert.equal(p3.nextBefore, undefined);

  const bad = await fetch(`http://127.0.0.1:${server.port}/gateway/audit?before=yesterday`, { headers: { authorization: "Bearer owner-tok" } });
  assert.equal(bad.status, 400);
});
