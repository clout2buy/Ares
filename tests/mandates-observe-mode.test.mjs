// Observe mode + mandates for unasked work.
//   * an acting run with no mandate does not act: it records "would have done
//     X because Y"; reading work needs no mandate; off does nothing at all;
//   * approve-always turns a scope into a standing rule (auto for it), approve
//     once lets exactly one run through, dismiss is sticky;
//   * a revoked mandate stops the next run and is never silently re-granted;
//   * wired: scheduled jobs (DesktopJobs + daemon mandates) and the operator
//     loop's goal gate.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MandateStore, OperatorBackgroundLoop, createGoal, saveGoal, operatorGoalGate } from "../packages/operator/dist/index.js";
import { DesktopJobs } from "../packages/cli/dist/entry/daemon/jobs.js";
import { createDaemonMandates, jobScope } from "../packages/cli/dist/entry/daemon/mandates.js";
import { reusablePrimaryId, rememberPrimaryId } from "../packages/cli/dist/entry/daemon/primarySession.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-mandates-"));
// change("run") starts its own tick; wait it out before ticking again.
async function settle(jobs) {
  for (let i = 0; i < 400 && jobs["ticking"]; i++) await new Promise((r) => setTimeout(r, 5));
}
const act = (scope, extra = {}) => ({ source: "jobs", scope, wouldDo: `run ${scope}`, because: "it came due", takesActions: true, ...extra });

test("no mandate: an acting run is recorded, not allowed; reading runs; off does nothing", async () => {
  const store = new MandateStore({ home: await makeHome() });
  const r = await store.gate(act("job:a"));
  assert.equal(r.allowed, false);
  assert.equal(r.observation.status, "pending");
  assert.equal(r.observation.wouldDo, "run job:a");
  assert.equal(r.observation.because, "it came due");
  const again = await store.gate(act("job:a"));
  assert.equal(again.observation.id, r.observation.id, "a recurring run folds into one entry");
  assert.equal(again.observation.count, 2);

  assert.equal((await store.gate({ ...act("brief"), source: "briefing", takesActions: false })).allowed, true, "reading needs no mandate");
  assert.equal(await store.modeOf("jobs"), "observe", "acting sources default to observe");
  assert.equal(await store.modeOf("dreaming"), "auto", "reading sources default to auto");

  await store.setMode("jobs", "off");
  const off = await store.gate(act("job:b"));
  assert.equal(off.allowed, false);
  assert.equal(off.observation, undefined, "off records nothing");
  const snap = await store.snapshot();
  assert.equal(snap.observations.filter((o) => o.scope === "job:b").length, 0);
});

test("approve always converts the scope to auto; once lets one run through; dismiss is sticky", async () => {
  const store = new MandateStore({ home: await makeHome() });
  const first = await store.gate(act("job:always"));
  const decided = await store.decide(first.observation.id, "always");
  assert.equal(decided.mandate.grantedBy.kind, "standing_rule");
  for (let i = 0; i < 3; i++) {
    const r = await store.gate(act("job:always"));
    assert.equal(r.allowed, true, `run ${i} allowed by the standing rule`);
    assert.equal(r.via, "mandate");
  }

  const o = await store.gate(act("job:once"));
  await store.decide(o.observation.id, "once");
  assert.equal((await store.gate(act("job:once"))).via, "once");
  assert.equal((await store.gate(act("job:once"))).allowed, false, "a one-time approval is spent");

  const d = await store.gate(act("job:dismiss"));
  await store.decide(d.observation.id, "dismiss");
  await store.gate(act("job:dismiss"));
  const pending = (await store.snapshot()).observations.filter((x) => x.scope === "job:dismiss" && x.status === "pending");
  assert.equal(pending.length, 0, "dismissed does not come back as a new ask");
});

test("source auto is a revocable standing rule", async () => {
  const store = new MandateStore({ home: await makeHome() });
  await store.setMode("jobs", "auto");
  const r = await store.gate(act("job:any"));
  assert.equal(r.allowed, true);
  assert.equal(r.via, "source_auto");
  await store.setMode("jobs", "observe");
  assert.equal((await store.gate(act("job:any"))).allowed, false, "back to observe revokes the rule");
});

test("revoke stops the next run, and ensure() never re-grants a revoked scope", async () => {
  const store = new MandateStore({ home: await makeHome() });
  const grant = { source: "jobs", scope: "job:r", grantedBy: { kind: "owner_created", what: "job", at: "2026-11-01T00:00:00Z" }, may: "run r" };
  const m = await store.ensure(grant);
  assert.ok(m);
  assert.equal((await store.gate(act("job:r"))).allowed, true);
  await store.revoke({ id: m.id });
  assert.equal(await store.ensure(grant), undefined, "no silent re-grant");
  const r = await store.gate(act("job:r"));
  assert.equal(r.allowed, false);
  assert.equal(r.revoked, true);
  // Mandates survive a fresh store on the same file (durable).
  const reopened = new MandateStore({ file: store.file });
  assert.equal((await reopened.gate(act("job:r"))).revoked, true);
});

test("jobs: owner job runs; agent job is observed; approve always runs it; revoke pauses it", async () => {
  const home = await makeHome();
  let now = Date.parse("2026-11-02T09:00:00Z");
  const woke = [];
  const emitted = [];
  let jobs;
  const mandates = createDaemonMandates({
    home,
    emit: (p) => emitted.push(p),
    runJobNow: (id) => jobs.change(id, "run"),
  });
  jobs = new DesktopJobs({
    home,
    emit: () => {},
    agentExists: () => true,
    roomName: () => undefined,
    wake: async (job) => { woke.push(job.id); return `thread_${job.id}`; },
    gate: (job) => mandates.jobGate(job),
    now: () => now,
  });
  const owner = await jobs.add({ agentId: "a1", task: "water the plants", when: "every 30m", createdBy: "owner" });
  const agent = await jobs.add({ agentId: "a1", task: "launch minecraft", when: "every 30m", createdBy: "agent" });
  now += 31 * 60_000;
  await jobs.tick();
  assert.deepEqual(woke, [owner.id], "only the owner-authorized job ran");
  const held = jobs.get(agent.id);
  assert.equal(held.status, "active");
  assert.equal(held.runs, 0);
  assert.ok(Date.parse(held.nextRunAt) > now, "its clock moved on: no re-ask every tick");
  const list = emitted.filter((p) => p.type === "mandates_list").at(-1);
  assert.equal(list.wanted.length, 1);
  assert.match(list.wanted[0].wouldDo, /launch minecraft/);

  // Approve always: runs now, and on its own from then on.
  await mandates.handle({ type: "mandate_decide", id: list.wanted[0].id, decision: "always" });
  await settle(jobs);
  await jobs.tick();
  assert.deepEqual(woke, [owner.id, agent.id]);
  now += 31 * 60_000;
  await jobs.tick();
  assert.equal(woke.filter((id) => id === agent.id).length, 2, "approve-always converted it to auto");

  // Revoke: the next run does not happen and the job is paused.
  const live = (await mandates.store.snapshot()).mandates.find((m) => m.scope === jobScope(agent.id) && !m.revokedAt);
  await mandates.handle({ type: "mandate_revoke", id: live.id });
  now += 31 * 60_000;
  const before = woke.length;
  await jobs.tick();
  assert.equal(woke.filter((id) => id === agent.id).length, 2, "revoked: no further run");
  assert.ok(woke.length === before + 1 && woke.at(-1) === owner.id, "the owner's job is unaffected");
  assert.equal(jobs.get(agent.id).status, "paused");
  assert.match(jobs.get(agent.id).lastRun.note, /revoked/);

  // The owner resuming it in the panel is a fresh authorization.
  await mandates.ownerJobAct(agent.id, "resume", agent.title);
  await jobs.change(agent.id, "resume");
  now += 31 * 60_000;
  await jobs.tick();
  assert.equal(woke.filter((id) => id === agent.id).length, 3);
});

test("jobs: a one-time approval spent on a busy agent is handed back", async () => {
  const home = await makeHome();
  let busy = true;
  let jobs;
  const mandates = createDaemonMandates({ home, emit: () => {}, runJobNow: (id) => jobs.change(id, "run") });
  const woke = [];
  jobs = new DesktopJobs({
    home, emit: () => {}, agentExists: () => true, roomName: () => undefined,
    wake: async (job) => { if (busy) return undefined; woke.push(job.id); return "t"; },
    gate: (job) => mandates.jobGate(job),
  });
  const j = await jobs.add({ agentId: "a", task: "once thing", when: "in 1h", createdBy: "agent" });
  await mandates.ownerJobAct(j.id, "run", j.title);
  await jobs.change(j.id, "run");
  await settle(jobs);
  assert.deepEqual(woke, []);
  busy = false;
  await jobs.tick();
  assert.deepEqual(woke, [j.id], "the approval survived the busy tick");
});

test("operator loop: an unauthorized goal is observed, a consented one runs, approve-always converts it", async () => {
  const home = await makeHome();
  await saveGoal(home, createGoal({ id: "g_unasked", statement: "relaunch the minecraft server" }));
  const ran = [];
  const store = new MandateStore({ home });
  const loop = new OperatorBackgroundLoop(
    { home, dispatcher: { async runStep(goal) { ran.push(goal.id); return { moved: true, goalMet: false }; } } },
    { gate: operatorGoalGate(store) },
  );
  const t1 = await loop.tickOnce();
  assert.equal(t1.ran.length, 0);
  assert.deepEqual(ran, []);
  const wanted = (await store.snapshot()).observations.filter((o) => o.status === "pending");
  assert.equal(wanted.length, 1);
  assert.equal(wanted[0].scope, "goal:g_unasked");

  await saveGoal(home, createGoal({ id: "g_consented", statement: "tidy the notes", consent: { approvalId: "msg_123", at: "2026-11-02T08:00:00Z" } }));
  const t2 = await loop.tickOnce();
  assert.deepEqual(t2.ran.map((g) => g.id), ["g_consented"], "the held goal does not starve the mandated one");
  const m = (await store.snapshot()).mandates.find((x) => x.scope === "goal:g_consented");
  assert.deepEqual(m.grantedBy, { kind: "owner_message", messageId: "msg_123" });

  await store.decide(wanted[0].id, "always");
  assert.equal(await operatorGoalGate(store)({ id: "g_unasked", statement: "relaunch the minecraft server" }), true);
});

test("daemon boot reuses its primary session id only while it is still empty", async () => {
  const home = await makeHome();
  const rows = new Map();
  const kernel = {
    getSession: (id) => rows.get(id),
    listMessages: (id) => rows.get(id)?.messages ?? [],
    countEvents: (id) => rows.get(id)?.events ?? 0,
  };
  assert.equal(await reusablePrimaryId(home, kernel), undefined, "nothing remembered yet");
  await rememberPrimaryId(home, "sess_0123456789abcdef");
  assert.equal(await reusablePrimaryId(home, kernel), "sess_0123456789abcdef", "no row yet: reuse");
  rows.set("sess_0123456789abcdef", { messages: [], events: 0 });
  assert.equal(await reusablePrimaryId(home, kernel), "sess_0123456789abcdef", "empty row: reuse");
  rows.set("sess_0123456789abcdef", { messages: [{}], events: 3 });
  assert.equal(await reusablePrimaryId(home, kernel), undefined, "a conversation: mint a new one");
});
