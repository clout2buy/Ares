// The owner's control plane — the security review's rules, pinned.
//
//   1. AUDIT: every tool outcome and permission decision that passes through
//      the garrison's session loop becomes one append-only, redacted line;
//      progress never does. The phone reads it newest-first (GET
//      /gateway/audit) and Telegram shows a compact /log.
//   2. KILL SWITCH: stop-all is a control-plane signal that reaches every
//      layer at once — turns in every session, registered subagents, jobs and
//      browsers, pending prompts — not a chat message the model may ignore.
//   3. PAUSE ≠ STOP: pause freezes at the next tool boundary (the tool does
//      not run until resume, or fails "paused by owner" when the pause
//      outlasts its watchdog); new turns wait at the door; scheduled jobs hold.
//   4. JOBS: every scheduled job is listable with who made it and whether its
//      schedule was approved, and killable. A recurring job the agent creates
//      needs an owner approval that names the schedule; a one-time job gets
//      exactly one run.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { SessionManager, Scheduler } from "../packages/garrison/dist/index.js";
import {
  QueryEngine,
  ownerPause,
  readAudit,
  registerStoppable,
  listStoppables,
} from "../packages/core/dist/index.js";
import { RemindTool, setRemindScheduler } from "../packages/tools/dist/index.js";
import { OwnerControlPlane, ownerControlledDispatcher } from "../packages/cli/dist/entry/ownerControlPlane.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { remoteAutonomyDecision, gateToolPermission } from "../packages/cli/dist/policyGate.js";
import { addStandingOrder, loadStandingOrders, dueStandingOrders } from "../packages/operator/dist/index.js";
import {
  TelegramBridge,
  TelegramScheduler,
  parseOwnerControlCommand,
  emptyRoster,
  seedOwners,
  upsertParticipant,
} from "../packages/channels/dist/index.js";

// ── harness ──────────────────────────────────────────────────────────────────

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-v63-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

async function waitFor(cond, label, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };

/**
 * A SessionManager whose sessions run a scripted legacy engine: `script(ctx)`
 * is an async generator of TurnEvents with the session's signal and gateway
 * permission prompt in hand — exactly what a real engine gets.
 */
function scriptedSessions(home, script) {
  const holder = { script };
  const sessions = new SessionManager({
    home,
    permissionTimeoutMs: 60_000,
    factory: ({ sessionId, signal, requestPermission }) => ({
      engine: {
        appendUserMessageContent() {},
        hydrate() {},
        history: () => [],
        streamTurn: () => holder.script({ sessionId, signal, requestPermission }),
      },
      providerName: "fake",
      model: "fake",
      workspace: home,
    }),
  });
  return { sessions, holder };
}

function untilAborted(signal) {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
}

test.afterEach(() => {
  // The pause gate is process-wide; no test may leak a paused state.
  ownerPause.resume();
});

// ── 1. audit ─────────────────────────────────────────────────────────────────

test("every tool outcome and permission decision is audited once, redacted; progress is not", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scriptedSessions(home, async function* ({ requestPermission }) {
    yield { type: "tool_start", id: "t1", name: "Gmail", input: { action: "send", to: "bob@example.com", api_key: "sk_live_abcdefghijklmnop" }, activityDescription: "Sending" };
    yield { type: "tool_progress", id: "t1", data: "halfway" };
    yield { type: "tool_end", id: "t1", output: { ok: true }, durationMs: 3 };
    yield { type: "tool_start", id: "t2", name: "Bash", input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuv' https://api.x" }, activityDescription: "curl" };
    yield { type: "tool_error", id: "t2", error: "exit 7\nconnection refused", durationMs: 2 };
    yield { type: "permission_request", id: "p1", toolName: "Stripe", input: { url: "https://pay.example/checkout" }, reason: "money" };
    await requestPermission({ id: "p1", toolName: "Stripe", input: { url: "https://pay.example/checkout" }, reason: "money" });
    yield { type: "permission_response", id: "p1", decision: "deny" };
    yield TURN_END;
  });
  const { id } = sessions.create();
  const turn = sessions.send(id, "go");
  await waitFor(() => sessions.respondPermission(id, "p1", "deny"), "prompt pending");
  await turn;

  const entries = await waitFor(async () => {
    const got = await readAudit({ home });
    return got.length >= 3 ? got : null;
  }, "three audit lines");
  assert.equal(entries.length, 3, "start/progress events never become lines");
  const [perm, bash, gmail] = entries; // newest first
  assert.deepEqual(
    { actor: gmail.actor, sessionId: gmail.sessionId, action: gmail.action, target: gmail.target, result: gmail.result },
    { actor: "ares", sessionId: id, action: "Gmail.send", target: "bob@example.com", result: "ok" },
  );
  assert.equal(gmail.params.api_key, "[redacted]", "secret keys never reach the file");
  assert.equal(bash.action, "Bash");
  assert.match(bash.result, /^error: exit 7 connection refused/);
  assert.doesNotMatch(JSON.stringify(bash), /abcdefghijklmnopqrstuv/, "a bearer token in a command is redacted by shape");
  assert.equal(perm.action, "permission:Stripe");
  assert.equal(perm.target, "https://pay.example/checkout");
  assert.equal(perm.result, "denied");
  assert.ok(Date.parse(gmail.ts) <= Date.parse(perm.ts));

  const only = await readAudit({ home, sessionId: "sess_other" });
  assert.equal(only.length, 0, "sessionId filters");
});

// ── 2. kill switch ───────────────────────────────────────────────────────────

test("stop-all reaches every layer: turns in every session, subagents, jobs, browsers, prompts", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scriptedSessions(home, async function* ({ signal, requestPermission, sessionId }) {
    if (sessionId === waiterId) {
      const decision = await requestPermission({ id: "pw", toolName: "Bash", input: { command: "rm -rf /x" }, reason: "wipe" });
      yield { type: "text_delta", text: `got ${decision}` };
      yield TURN_END;
      return;
    }
    yield { type: "tool_start", id: "t", name: "Bash", input: { command: "sleep 600" }, activityDescription: "sleeping" };
    await untilAborted(signal);
    yield { type: "tool_error", id: "t", error: "interrupted", durationMs: 1 };
    yield { ...TURN_END, status: "interrupted" };
  });
  const a = sessions.create().id;
  const b = sessions.create().id;
  const waiterId = sessions.create().id;
  const turns = [sessions.send(a, "one"), sessions.send(b, "two"), sessions.send(waiterId, "three")];
  await waitFor(() => sessions.runningTurns().filter((r) => r.currentTool === "Bash").length === 2, "two busy turns");

  const stops = [];
  const unregister = [
    registerStoppable({ kind: "subagent", id: "agent_1", label: "researcher", stop: () => { stops.push("subagent"); return true; } }),
    registerStoppable({ kind: "job", id: "operator:g1", stop: () => { stops.push("job"); return true; } }),
    registerStoppable({ kind: "browser", id: "browser:test", persistent: true, stop: () => { stops.push("browser"); return true; } }),
  ];
  t.after(() => unregister.forEach((u) => u()));

  const plane = new OwnerControlPlane({ home, sessions });
  const status = plane.status();
  assert.equal(status.paused, false);
  assert.equal(status.running.turns.length, 3);
  assert.ok(status.running.jobs.some((j) => j.id === "agent_1"), "running subagents show as jobs");

  const result = await plane.stopAll();
  assert.deepEqual(result.stopped, { turns: 3, subagents: 1, jobs: 1, browsers: 1, prompts: 1, queued: 0 });
  assert.deepEqual(stops.sort(), ["browser", "job", "subagent"]);
  await Promise.all(turns);
  assert.equal(sessions.runningTurns().length, 0, "nothing left running");
  assert.ok(listStoppables("browser").some((e) => e.id === "browser:test"), "a browser tool stays registered for the next browser it opens");
  assert.ok(!listStoppables("subagent").some((e) => e.id === "agent_1"), "one-shot entries are gone");

  const audit = await waitFor(async () => (await readAudit({ home })).find((e) => e.action === "control.stop"), "control.stop audited");
  assert.equal(audit.actor, "owner");
  assert.equal(audit.params.turns, 3);
});

// ── 3. pause ≠ stop ──────────────────────────────────────────────────────────

class OneToolProvider {
  constructor(input = {}) { this.name = "one-tool"; this.input = input; }
  async *stream(req) {
    const done = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
    const message = done
      ? { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }], createdAt: new Date().toISOString() }
      : { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "u1", name: "Probe", input: this.input }], createdAt: new Date().toISOString() };
    if (!done) {
      yield { type: "tool_use_start", id: "u1", name: "Probe" };
      yield { type: "tool_use_input_done", id: "u1", input: this.input };
    }
    yield { type: "message_done", message, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: done ? "end_turn" : "tool_use" };
  }
}

function probeTool(calls, watchdogTimeoutMs = 5_000) {
  return {
    schema: { name: "Probe", description: "probe", inputJsonSchema: { type: "object" }, safety: "read-only", concurrency: "parallel-safe", watchdogTimeoutMs },
    async call() {
      calls.push(Date.now());
      return { output: "ran" };
    },
  };
}

async function runEngineTurn(engine) {
  const events = [];
  engine.appendUserMessageContent([{ type: "text", text: "go" }]);
  for await (const event of engine.streamTurn()) events.push(event);
  return events;
}

test("pause freezes a turn at the next tool boundary; resume runs the tool exactly once", async (t) => {
  const workspace = await tempHome(t);
  const calls = [];
  const engine = QueryEngine.forTesting({ provider: new OneToolProvider(), model: "m", systemPrompt: "s", tools: [probeTool(calls)], workspace }, "pause-1");
  ownerPause.pause();
  const run = runEngineTurn(engine);
  await waitFor(() => ownerPause.waiting === 1, "turn frozen at the boundary");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0, "no tool runs while paused");
  ownerPause.resume();
  const events = await run;
  assert.equal(calls.length, 1);
  assert.ok(events.some((e) => e.type === "tool_end"));
});

test("a pause that outlasts the tool's watchdog fails the call with 'paused by owner' instead of wedging", async (t) => {
  const workspace = await tempHome(t);
  const calls = [];
  const engine = QueryEngine.forTesting({ provider: new OneToolProvider(), model: "m", systemPrompt: "s", tools: [probeTool(calls, 60)], workspace }, "pause-2");
  ownerPause.pause();
  const events = await runEngineTurn(engine);
  assert.equal(calls.length, 0, "the tool never ran");
  const failure = events.find((e) => e.type === "tool_error");
  assert.match(failure.error, /paused by owner/);
  assert.equal(events.at(-1).type, "turn_end", "the turn still ends");
});

test("new turns wait at the door while paused; stop-all drops them unadmitted", async (t) => {
  const home = await tempHome(t);
  let started = 0;
  const { sessions } = scriptedSessions(home, async function* () {
    started += 1;
    yield TURN_END;
  });
  const id = sessions.create().id;
  const plane = new OwnerControlPlane({ home, sessions });
  plane.pause();
  const waiting = sessions.send(id, "hello");
  await waitFor(() => plane.status().running.turns.some((r) => r.waitingForResume), "waiting at the door");
  assert.equal(started, 0);
  plane.resume();
  await waiting;
  assert.equal(started, 1, "resume lets it through");

  plane.pause();
  const dropped = sessions.send(id, "later");
  await waitFor(() => sessions.runningTurns().length === 1, "second waits");
  const { stopped } = await plane.stopAll();
  assert.equal(stopped.queued, 1);
  await assert.rejects(dropped, /stopped by owner/);
  assert.equal(started, 1, "the dropped message never ran");
});

test("scheduler holds system jobs while paused and audits every run", async () => {
  const fns = [];
  let ran = 0;
  let paused = true;
  const runs = [];
  const scheduler = new Scheduler({
    hooks: { heartbeat: async () => { ran += 1; } },
    heartbeatEveryMs: 1_000,
    setIntervalFn: (fn) => { fns.push(fn); return fns.length; },
    clearIntervalFn: () => {},
    isPaused: () => paused,
    onRun: (hook, result) => runs.push([hook, result]),
  });
  scheduler.start();
  fns[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ran, 0, "paused: the heartbeat does not start");
  paused = false;
  fns[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ran, 1);
  assert.deepEqual(runs, [["heartbeat", "ok"]]);
  const [status] = scheduler.jobStatus();
  assert.equal(status.name, "heartbeat");
  assert.equal(status.schedule, "every 1s");
  assert.equal(status.lastResult, "ok");
  assert.ok(scheduler.holdHook("heartbeat", true));
  fns[0]();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ran, 1, "a held system job stays held");
  assert.equal(scheduler.jobStatus()[0].paused, true);
});

test("operator steps are stoppable jobs and never start while paused", async () => {
  let entered = 0;
  const audits = [];
  const dispatcher = ownerControlledDispatcher({
    async runStep(_goal, ctx) {
      entered += 1;
      await untilAborted(ctx.signal);
      return { moved: false, goalMet: false, evidence: "aborted" };
    },
  }, (entry) => audits.push(entry));
  const goal = { id: "g1", statement: "summarize email" };
  ownerPause.pause();
  const outer = new AbortController();
  const held = dispatcher.runStep(goal, { signal: outer.signal, now: () => new Date() });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(entered, 0, "paused: the step does not start");
  ownerPause.resume();
  await waitFor(() => listStoppables("job").some((j) => j.id === "operator:g1"), "step registered");
  const plane = new OwnerControlPlane({ home: os.tmpdir(), sessions: { interruptAll: () => ({ turns: 0, waiting: 0 }), denyAllPendingPermissions: () => 0, runningTurns: () => [] } });
  const { stopped } = await plane.stopAll();
  assert.equal(stopped.jobs, 1);
  const verdict = await held;
  assert.equal(verdict.moved, false);
  assert.equal(audits[0].actor, "operator");
});

// ── the phone's routes ───────────────────────────────────────────────────────

test("phone routes: /gateway/control gains paused+running, pause/resume/stop, jobs, audit", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scriptedSessions(home, async function* () { yield TURN_END; });
  const heldHooks = [];
  const plane = new OwnerControlPlane({
    home,
    sessions,
    scheduler: {
      jobStatus: () => [{ name: "heartbeat", schedule: "every 30m", enabled: true, paused: heldHooks.includes("heartbeat"), running: false }],
      holdHook: (name, held) => { if (held) heldHooks.push(name); return true; },
    },
  });
  const order = await addStandingOrder(home, { statement: "brief me on AI news", cadenceMs: 2 * 3_600_000, createdBy: "ares", approved: true });
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: {
      control: {
        providers: () => ["deepseek"], models: async () => [], effort: () => ({ current: "high", levels: ["high"] }),
        setEffort: async () => {}, permissions: () => [], revokePermission: async () => false,
      },
      ownerControl: plane,
    },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer tok", "content-type": "application/json" };
  const get = async (p) => (await fetch(`${base}${p}`, { headers: auth })).json();
  const post = async (p, body = {}) => {
    const res = await fetch(`${base}${p}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await fetch(`${base}/gateway/control/stop`, { method: "POST" })).status, 401, "bearer required");

  let control = await get("/gateway/control");
  assert.deepEqual(control.providers, ["deepseek"], "the settings cockpit is intact");
  assert.equal(control.paused, false);
  assert.deepEqual(control.running, { turns: [], jobs: [] });

  const paused = await post("/gateway/control/pause");
  assert.equal(paused.body.paused, true);
  assert.ok(paused.body.pausedAt);
  control = await get("/gateway/control");
  assert.equal(control.paused, true);
  assert.equal(control.pausedAt, paused.body.pausedAt);
  assert.equal((await post("/gateway/control/resume")).body.paused, false);

  const stop = await post("/gateway/control/stop");
  assert.equal(stop.status, 200);
  assert.deepEqual(Object.keys(stop.body.stopped).sort(), ["browsers", "jobs", "prompts", "queued", "subagents", "turns"]);

  const { jobs } = await get("/gateway/jobs");
  const heartbeat = jobs.find((j) => j.id === "system:heartbeat");
  assert.deepEqual({ createdBy: heartbeat.createdBy, approved: heartbeat.approved, schedule: heartbeat.schedule }, { createdBy: "system", approved: true, schedule: "every 30m" });
  const standing = jobs.find((j) => j.id === `standing:${order.id}`);
  assert.deepEqual({ createdBy: standing.createdBy, approved: standing.approved, schedule: standing.schedule }, { createdBy: "ares", approved: true, schedule: "every 2h" });
  assert.ok(standing.nextRunAt);

  assert.equal((await post("/gateway/jobs/cancel", {})).status, 400, "id required");
  const cancelled = await post("/gateway/jobs/cancel", { id: `standing:${order.id}` });
  assert.equal(cancelled.body.ok, true);
  assert.equal((await loadStandingOrders(home)).length, 0, "gone from disk");
  const held = await post("/gateway/jobs/cancel", { id: "system:heartbeat" });
  assert.equal(held.body.ok, true);
  assert.match(held.body.detail, /paused/);
  assert.equal((await post("/gateway/jobs/cancel", { id: "alarm:nope" })).status, 404);

  const audit = await waitFor(async () => {
    const body = await get("/gateway/audit?limit=50");
    return body.entries.filter((e) => e.actor === "owner").length >= 6 ? body : null;
  }, "owner actions audited");
  const actions = audit.entries.filter((e) => e.actor === "owner").map((e) => e.action);
  assert.deepEqual(actions, ["jobs.cancel", "jobs.cancel", "jobs.cancel", "control.stop", "control.resume", "control.pause"], "newest first");
  assert.match(audit.entries[0].result, /^error: /, "a failed cancel is audited as failed");
  assert.equal(audit.entries[0].target, "alarm:nope");
  assert.equal((await get("/gateway/audit?limit=1")).entries.length, 1);
});

// ── 4. scheduled jobs: scoped and killable ───────────────────────────────────

test("a recurring reminder is armed only after the owner approves its schedule; one-time needs no second yes", async (t) => {
  const added = [];
  setRemindScheduler({
    addAlarm: async (input) => { added.push(input); return { id: `a${added.length}`, label: input.label, hour: input.hour, minute: input.minute }; },
    removeAlarm: async () => undefined,
    renderAlarms: async () => "",
  });
  t.after(() => setRemindScheduler(null));
  const asked = [];
  const ctx = (answer) => ({ signal: new AbortController().signal, requestPermission: async (r) => { asked.push(r); return answer; } });

  await assert.rejects(
    RemindTool.call({ action: "add", label: "standup", hour: 9, minute: 30, days: [1, 3] }, ctx("deny")),
    (err) => err.name === "PermissionDeniedError" && /Nothing was scheduled/.test(err.message),
  );
  assert.equal(added.length, 0, "denied → never armed");
  assert.equal(asked[0].ownerDecision, true, "an owner-only question");
  assert.match(asked[0].reason, /RECURRING .*Mon, Wed at 09:30/, "the question names the schedule");

  await assert.rejects(
    RemindTool.call({ action: "add", label: "standup", hour: 9 }, { signal: new AbortController().signal }),
    /no owner is available/,
  );

  await RemindTool.call({ action: "add", label: "standup", hour: 9, minute: 30 }, ctx("allow_once"));
  assert.equal(added.length, 1);
  assert.deepEqual({ createdBy: added[0].createdBy, approved: added[0].approved }, { createdBy: "ares", approved: true });

  asked.length = 0;
  await RemindTool.call({ action: "add", label: "call mom", hour: 17, once: true }, ctx("deny"));
  assert.equal(asked.length, 0, "a one-time reminder is its own single authorization");
  assert.equal(added.length, 2);

  // Autonomy never answers an owner decision, attended or not.
  const request = { toolName: "Remind", input: {}, reason: "recurring", ownerDecision: true };
  assert.equal(remoteAutonomyDecision(request), "ask");
  assert.equal(gateToolPermission(request, { attended: false }).kind, "deny");
  assert.equal(gateToolPermission(request, { attended: true }).kind, "ask");
});

test("a one-time alarm runs exactly once even when its send fails; unapproved and paused alarms never fire", async (t) => {
  const home = await tempHome(t);
  let sends = 0;
  const outbound = {
    sendToOwners: async () => { sends += 1; throw new Error("telegram down"); },
    sendToChats: async () => { sends += 1; return { sent: 1 }; },
  };
  let paused = false;
  const scheduler = new TelegramScheduler({
    outbound, home, tickMs: 3_600_000,
    now: () => new Date(2026, 8, 23, 9, 0, 30),
    isPaused: () => paused,
  });
  await scheduler.start();
  t.after(() => scheduler.stop());
  await scheduler.addAlarm({ label: "one shot", hour: 9, minute: 0, once: true, createdBy: "ares" });
  await scheduler.addAlarm({ label: "unapproved", hour: 9, minute: 0, createdBy: "ares", approved: false });
  paused = true;
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sends, 0, "paused: nothing fires");
  paused = false;
  scheduler.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sends, 1, "only the one-shot fired; the unapproved alarm did not");
  const left = await scheduler.listAlarms();
  assert.deepEqual(left.map((a) => a.label), ["unapproved"], "the one-shot is consumed despite the failed send");
});

test("a standing order written unapproved is never materialized", () => {
  const now = new Date();
  const base = { schemaVersion: 1, statement: "x", cadenceMs: 300_000, enabled: true, createdAt: now.toISOString(), runCount: 0 };
  const due = dueStandingOrders([
    { ...base, id: "legacy" },
    { ...base, id: "approved", approved: true },
    { ...base, id: "pending", approved: false },
  ], now);
  assert.deepEqual(due.map((o) => o.id), ["legacy", "approved"]);
});

// ── Telegram: owner-only, one message each ───────────────────────────────────

test("parseOwnerControlCommand knows the control words and nothing else", () => {
  assert.deepEqual(parseOwnerControlCommand("/stopall"), { kind: "stopall" });
  assert.deepEqual(parseOwnerControlCommand("/pause@AresBot"), { kind: "pause" });
  assert.deepEqual(parseOwnerControlCommand("/cancel_job standing:so_1"), { kind: "cancel_job", arg: "standing:so_1" });
  assert.deepEqual(parseOwnerControlCommand("/log"), { kind: "log" });
  assert.equal(parseOwnerControlCommand("pause"), null, "a bare word in chat is conversation");
  assert.equal(parseOwnerControlCommand("/stop"), null, "/stop keeps its per-turn meaning");
});

class FakeTg {
  constructor() { this.updates = []; this.waiters = []; this.sent = []; this.seq = 0; this.msg = 100; }
  pushMessage(chatId, text) {
    this.updates.push({ update_id: ++this.seq, message: { message_id: ++this.msg, chat: { id: chatId, type: "private" }, text } });
    const w = this.waiters.shift();
    if (w) w(this.updates.splice(0));
  }
  async getUpdates(_o, _t, signal) {
    if (this.updates.length) return this.updates.splice(0);
    return new Promise((resolve) => {
      const w = (b) => resolve(b);
      this.waiters.push(w);
      signal?.addEventListener("abort", () => resolve([]), { once: true });
    });
  }
  async sendMessage(chatId, text) { this.sent.push({ chatId, text }); return { message_id: ++this.msg, chat: { id: chatId, type: "private" }, text }; }
  async editMessageText() {}
  async answerCallbackQuery() {}
  async sendChatAction() {}
}

test("Telegram /stopall /pause /log are owner-only control signals with one reply each", async (t) => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const frames = [];
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      frames.push(f);
      if (f.type === "session.create") ws.send(JSON.stringify({ type: "session.created", session: { id: "s1" } }));
    });
  });
  const tg = new FakeTg();
  const calls = [];
  let roster = seedOwners(emptyRoster(), [42], "Crix");
  roster = upsertParticipant(roster, { chatId: 7, name: "guest", role: "guest" });
  let operatorControl = 0;
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${wss.address().port}`, token: "tok" },
    allowedChatIds: [42, 7],
    ownerChatIds: [42],
    initialRoster: roster,
    timers: { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout: (h) => clearTimeout(h) },
    pollTimeoutS: 1,
    commands: { control: async () => { operatorControl += 1; } },
    ownerControl: {
      stopAll: async () => { calls.push("stopall"); return "⏹ Stopped everything: 2 turns."; },
      pause: () => { calls.push("pause"); return "⏸ Paused."; },
      resume: () => { calls.push("resume"); return "▶ Resumed."; },
      log: async () => { calls.push("log"); return "📜 Last 1 actions"; },
    },
  });
  bridge.start();
  // Bridge first, then the gateway: a server with a live client never closes.
  t.after(async () => {
    await bridge.stop();
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
  });
  await waitFor(() => frames.some((f) => f.type === "hello"), "hello");

  tg.pushMessage(42, "/stopall");
  tg.pushMessage(42, "/pause");
  tg.pushMessage(42, "/log");
  await waitFor(() => tg.sent.filter((m) => m.chatId === 42).length === 3, "three replies");
  assert.deepEqual(calls, ["stopall", "pause", "log"]);
  assert.deepEqual(tg.sent.map((m) => m.text), ["⏹ Stopped everything: 2 turns.", "⏸ Paused.", "📜 Last 1 actions"]);

  tg.pushMessage(7, "/stopall");
  tg.pushMessage(7, "/pause");
  await waitFor(() => tg.sent.some((m) => m.chatId === 7 && /Only the owner/.test(m.text)), "guest refused");
  assert.deepEqual(calls, ["stopall", "pause", "log"], "a guest never reaches the control plane");
  assert.equal(operatorControl, 0, "nor the operator's pause");
});
