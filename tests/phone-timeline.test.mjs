// GET /gateway/timeline — who handed what to whom. The pure recognisers and the
// fold are tested directly; the route is tested through a real RemoteAgentServer
// (so the owner-bearer gate is the production one) over a real SessionManager
// whose engine is scripted, so the live attach path is the real one too.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../packages/garrison/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import {
  BRIEF_CAP,
  EXCERPT_CAP,
  STALE_AFTER_MS,
  TASK_CAP,
  TIMELINE_MAX_LIMIT,
  TIMELINE_STORE_CAP,
  TimelineStore,
  classifyToolStart,
  createTimelineApi,
  excerptOf,
  parseFamilyInbound,
  parseFamilySend,
  readRolloutTail,
  scrub,
  scrubBlock,
  shellWords,
} from "../packages/cli/dist/phoneTimeline.js";

const BOB = { id: "p_bob", name: "Builder Bob", kind: "agent", color: "#4cc2ff" };
const ARES = { id: "ares", name: "Ares", kind: "agent" };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };

async function waitFor(cond, label, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await tick(5);
  }
}

async function tempHome(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-timeline-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

const taskStart = (id, o = {}) => ({ type: "tool_start", id, name: "Task", input: { description: "Find the auth handler", prompt: "Look in src/auth for the login handler and report the file.", subagent_type: "researcher", ...o }, activityDescription: "Task[researcher]" });
const toolEnd = (id, output, durationMs = 5) => ({ type: "tool_end", id, output, durationMs });

// ── hygiene ───────────────────────────────────────────────────────────────

test("scrub: secrets redacted, control/bidi characters dropped, preamble stripped, capped", () => {
  const raw = "(System: note (with parens) here)\n\nUse sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and Bearer abc.def-ghi_jkl‮ now\u0007.";
  const out = scrub(raw, 200);
  assert.ok(!out.includes("sk-ant"), out);
  assert.ok(!/Bearer abc/.test(out), out);
  assert.ok(!out.includes("System:"), out);
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\u0000-\u0008‮]/.test(out));
  assert.match(out, /\[REDACTED\]/);
  const long = scrub("word ".repeat(400), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith("…"));
  assert.equal(scrub(undefined, 10), "");
  assert.equal(scrub(42, 10), "");
  assert.equal(scrub("   ", 10), "");
});

test("scrubBlock keeps paragraphs, redacts, caps", () => {
  const out = scrubBlock("First line.\n\n\n\nSecond   line with password: hunter2hunter2\n", 400);
  assert.match(out, /^First line\.\n\nSecond line/);
  assert.ok(!out.includes("hunter2hunter2"), out);
  assert.equal(scrubBlock("x".repeat(5000), 100).length, 100);
});

test("excerptOf reads the useful field of whatever a tool returned", () => {
  assert.equal(excerptOf("plain text"), "plain text");
  assert.equal(excerptOf({ summary: "Found it in auth.ts", status: "completed" }), "Found it in auth.ts");
  assert.equal(excerptOf({ result: { summary: "nested ok" } }), "nested ok");
  assert.equal(excerptOf({ status: "failed" }), "Status: failed");
  assert.equal(excerptOf(null), "");
  assert.equal(excerptOf(7), "");
  assert.ok(excerptOf({ summary: "y".repeat(9000) }).length <= EXCERPT_CAP);
});

// ── recognising a handoff ─────────────────────────────────────────────────

test("classify: Task, Conductor, CodingBackend and a family send are handoffs; nothing else is", () => {
  const task = classifyToolStart("Task", { description: "Find auth", prompt: "Look in src/auth", subagent_type: "general-purpose", run_in_background: true });
  assert.equal(task.via, "task");
  assert.deepEqual(task.to, { id: "sub:general-purpose", name: "General purpose", kind: "subagent" });
  assert.equal(task.task, "Find auth");
  assert.equal(task.brief, "Look in src/auth");
  assert.equal(task.background, true);

  const fleet = classifyToolStart("Conductor", { goal: "Ship the redesign", phases: [{ agents: [{}, {}] }, { agents: [{}] }] });
  assert.equal(fleet.via, "fleet");
  assert.equal(fleet.count, 3);
  assert.equal(fleet.task, "Ship the redesign");
  assert.equal(classifyToolStart("Conductor", { phases: [{ agents: [{}, {}] }] }).task, "A fleet of 2 agents");

  const coding = classifyToolStart("CodingBackend", { task: "Fix the flaky test", backend: "codex" });
  assert.equal(coding.via, "coding");
  assert.equal(coding.to.name, "Codex");

  const fam = classifyToolStart("Bash", { command: "family-message send jamara \"Builder Bob\" private new \"Dinner at 7?\"" });
  assert.equal(fam.via, "family");
  assert.deepEqual(fam.to, { id: "person:jamara", name: "Jamara", kind: "person" });
  assert.equal(fam.task, "Dinner at 7?");

  assert.equal(classifyToolStart("Bash", { command: "ls -la" }), null);
  assert.equal(classifyToolStart("Read", { file_path: "/x" }), null);
  assert.equal(classifyToolStart("Task", null).via, "task", "a malformed input still classifies, with defaults");
});

test("classify: the task label and brief are scrubbed and capped", () => {
  const c = classifyToolStart("Task", { description: "d ".repeat(300), prompt: "Use sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " + "p ".repeat(500), subagent_type: "researcher" });
  assert.ok(c.task.length <= TASK_CAP);
  assert.ok(c.brief.length <= BRIEF_CAP);
  assert.ok(!c.brief.includes("sk-ant"));
});

test("shellWords and parseFamilySend: quotes, node prefix, odd input", () => {
  assert.deepEqual(shellWords(`a 'b c' "d e" f\\ g`), ["a", "b c", "d e", "f g"]);
  assert.deepEqual(shellWords("echo hi; rm -rf /"), ["echo", "hi"], "stops at a command separator");
  const a = parseFamilySend(`node /workspace/family-message.mjs send noah Muse group thr_1 "Ready when you are" `);
  assert.deepEqual(a, { to: "noah", sender: "Muse", mode: "group", text: "Ready when you are" });
  assert.deepEqual(parseFamilySend("family-message send jamara Bob private new hello there"), { to: "jamara", sender: "Bob", mode: "private", text: "hello there" });
  assert.equal(parseFamilySend("family-message read"), null);
  assert.equal(parseFamilySend("family-message send jamara Bob public new hi"), null, "mode must be private or group");
  assert.equal(parseFamilySend("family-message send jamara Bob private new"), null, "no message, no handoff");
  assert.equal(parseFamilySend("echo send"), null);
});

test("parseFamilyInbound reads the note familyReplies prepends", () => {
  const text = "(Family message from Noah in private chat: are you free (after 5)?)\nWrite only your natural reply to Noah. Do not call the family message tool.";
  assert.deepEqual(parseFamilyInbound(text), { from: "Noah", mode: "private", text: "are you free (after 5)?" });
  assert.equal(parseFamilyInbound("(Private update to your owner only: Noah replied)"), null);
  assert.equal(parseFamilyInbound("hello"), null);
});

// ── the fold ──────────────────────────────────────────────────────────────

test("a Task becomes running, then done with duration and result", () => {
  const store = new TimelineStore(() => 1_000_000, "e1");
  store.observe("s1", BOB, 1_000, taskStart("t1"));
  let { events, cursor } = store.list();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "running");
  assert.equal(events[0].from.id, "p_bob");
  assert.equal(events[0].to.name, "Researcher");
  assert.equal(events[0].sessionId, "s1");
  assert.equal(cursor, 1);

  store.observe("s1", BOB, 4_500, toolEnd("t1", { status: "completed", summary: "It lives in src/auth/login.ts", durationMs: 3400 }));
  ({ events, cursor } = store.list());
  assert.equal(events[0].status, "done");
  assert.equal(events[0].endedAt, 4_500);
  assert.equal(events[0].durationMs, 3_500);
  assert.equal(events[0].excerpt, "It lives in src/auth/login.ts");
  assert.equal(cursor, 2);
});

test("a failing Task is failed with the error, an interrupt is cancelled", () => {
  const store = new TimelineStore(() => 9_000, "e1");
  store.observe("s1", BOB, 1_000, taskStart("t1"));
  store.observe("s1", BOB, 2_000, { type: "tool_error", id: "t1", error: "subagent researcher failed: rate limited sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", durationMs: 1 });
  store.observe("s1", BOB, 3_000, taskStart("t2"));
  store.observe("s1", BOB, 3_100, { type: "turn_end", status: "interrupted", usage: {}, durationMs: 1 });
  store.observe("s1", BOB, 4_000, taskStart("t3"));
  store.observe("s1", BOB, 4_100, { type: "tool_error", id: "t3", error: "subagent researcher cancelled: stopped", durationMs: 1 });
  const byId = Object.fromEntries(store.list().events.map((e) => [e.id, e]));
  assert.equal(byId["s1:t1"].status, "failed");
  assert.ok(!byId["s1:t1"].excerpt.includes("sk-ant"));
  assert.equal(byId["s1:t2"].status, "cancelled", "a call open at an interrupted turn_end is cancelled");
  assert.equal(byId["s1:t3"].status, "cancelled");
});

test("a turn that ends with a call still open fails it; a background job is left alone", () => {
  const store = new TimelineStore(() => 9_000, "e1");
  store.observe("s1", BOB, 1_000, taskStart("t1"));
  store.observe("s1", BOB, 1_001, taskStart("bg", { run_in_background: true }));
  store.observe("s1", BOB, 1_050, toolEnd("bg", { jobId: "job_1", taskId: "k1", status: "running", description: "x" }));
  store.observe("s1", BOB, 2_000, { type: "turn_end", status: "completed", usage: {}, durationMs: 1 });
  const byId = Object.fromEntries(store.list().events.map((e) => [e.id, e]));
  assert.equal(byId["s1:t1"].status, "failed");
  assert.equal(byId["s1:bg"].status, "running", "detached work outlives its turn");
  assert.equal(byId["s1:bg"].background, true);

  // Later the owner's agent polls it with TaskOutput.
  store.observe("s1", BOB, 5_000, { type: "tool_start", id: "poll", name: "TaskOutput", input: { job_id: "job_1" }, activityDescription: "x" });
  store.observe("s1", BOB, 5_010, toolEnd("poll", { jobId: "job_1", status: "completed", result: { summary: "All 12 tests pass" } }));
  const bg = store.list().events.find((e) => e.id === "s1:bg");
  assert.equal(bg.status, "done");
  assert.equal(bg.excerpt, "All 12 tests pass");
});

test("a fleet and a coding backend carry their results", () => {
  const store = new TimelineStore(() => 9_000, "e1");
  store.observe("s1", ARES, 1_000, { type: "tool_start", id: "c1", name: "Conductor", input: { goal: "Research the stack", phases: [{ agents: [{}, {}, {}] }] }, activityDescription: "x" });
  store.observe("s1", ARES, 9_000, toolEnd("c1", { fleetId: "f1", status: "completed", summary: "Three options, one clear winner.", phases: [] }));
  store.observe("s1", ARES, 10_000, { type: "tool_start", id: "k1", name: "CodingBackend", input: { task: "Fix it", backend: "claude" }, activityDescription: "x" });
  store.observe("s1", ARES, 12_000, { type: "tool_error", id: "k1", error: "Claude Code exited 1. Last output: boom", durationMs: 1 });
  const byId = Object.fromEntries(store.list().events.map((e) => [e.id, e]));
  assert.equal(byId["s1:c1"].status, "done");
  assert.equal(byId["s1:c1"].count, 3);
  assert.equal(byId["s1:c1"].excerpt, "Three options, one clear winner.");
  assert.equal(byId["s1:k1"].status, "failed");
  assert.match(byId["s1:k1"].excerpt, /exited 1/);
  assert.equal(byId["s1:c1"].from.id, "ares");
});

test("family: an outgoing send and an incoming message that an agent answers", () => {
  const store = new TimelineStore(() => 9_000, "e1");
  store.observe("s1", BOB, 1_000, { type: "tool_start", id: "b1", name: "Bash", input: { command: "family-message send jamara \"Builder Bob\" private new \"Dinner at 7?\"" }, activityDescription: "x" });
  store.observe("s1", BOB, 1_500, toolEnd("b1", { stdout: "ok", exitCode: 0 }));
  store.observe("s1", BOB, 5_000, {
    type: "input_admitted", inputId: "in1", sessionId: "s1", delivery: "steer",
    userMessage: { id: "m", role: "user", createdAt: "", content: [{ type: "text", text: "(Family message from Noah in private chat: yes!)\nWrite only your natural reply to Noah." }] },
  });
  assert.equal(store.list().events.find((e) => e.id === "s1:in:in1").status, "running");
  store.observe("s1", BOB, 5_500, { type: "message_done", message: { id: "a", role: "assistant", createdAt: "", content: [{ type: "text", text: "Great, see you then." }] } });
  store.observe("s1", BOB, 6_000, TURN_END);
  const byId = Object.fromEntries(store.list().events.map((e) => [e.id, e]));
  assert.equal(byId["s1:b1"].to.id, "person:jamara");
  assert.equal(byId["s1:b1"].status, "done");
  const inbound = byId["s1:in:in1"];
  assert.equal(inbound.from.kind, "person");
  assert.equal(inbound.from.name, "Noah");
  assert.equal(inbound.to.id, "p_bob");
  assert.equal(inbound.status, "done");
  assert.equal(inbound.excerpt, "Great, see you then.");
  assert.equal(inbound.task, "yes!");
});

test("revisions: since returns only what changed; replaying the same events changes nothing", () => {
  const store = new TimelineStore(() => 9_000, "e1");
  const events = [
    [1_000, taskStart("t1")],
    [2_000, toolEnd("t1", { status: "completed", summary: "ok" })],
    [3_000, taskStart("t2")],
  ];
  for (const [ts, e] of events) store.observe("s1", BOB, ts, e);
  const first = store.list();
  assert.equal(first.cursor, 3);
  for (const [ts, e] of events) store.observe("s1", BOB, ts + 7, e);
  assert.equal(store.rev, 3, "a replay is a no-op");
  assert.equal(store.list({ since: 3 }).events.length, 0);
  store.observe("s1", BOB, 4_000, toolEnd("t2", { status: "completed", summary: "done too" }));
  const delta = store.list({ since: 3 });
  assert.deepEqual(delta.events.map((e) => e.id), ["s1:t2"]);
  assert.equal(delta.cursor, 4);
});

test("paging: with a cursor the oldest changes come first and the cursor advances; without, the newest N", () => {
  const store = new TimelineStore(() => 100_000, "e1");
  for (let i = 0; i < 10; i++) store.observe("s1", BOB, 1_000 + i * 100, taskStart(`t${i}`));
  const newest = store.list({ limit: 3 });
  assert.deepEqual(newest.events.map((e) => e.id), ["s1:t7", "s1:t8", "s1:t9"]);
  assert.equal(newest.more, true);
  assert.equal(newest.cursor, 10);
  const p1 = store.list({ since: 1, limit: 4 });
  assert.deepEqual(p1.events.map((e) => e.id), ["s1:t1", "s1:t2", "s1:t3", "s1:t4"]);
  assert.equal(p1.more, true);
  assert.equal(p1.cursor, 5, "advances to the last returned revision");
  const p2 = store.list({ since: p1.cursor, limit: 100 });
  assert.equal(p2.events.length, 5);
  assert.equal(p2.more, false);
  assert.equal(p2.cursor, 10);
  assert.equal(store.list({ limit: 99999 }).events.length, 10);
});

test("filters: by agent (either side) and by status", () => {
  const store = new TimelineStore(() => 100_000, "e1");
  store.observe("s1", BOB, 1_000, taskStart("a"));
  store.observe("s2", ARES, 2_000, taskStart("b"));
  store.observe("s2", ARES, 2_500, toolEnd("b", { status: "completed", summary: "ok" }));
  assert.deepEqual(store.list({ agent: "p_bob" }).events.map((e) => e.id), ["s1:a"]);
  assert.deepEqual(store.list({ agent: "ares" }).events.map((e) => e.id), ["s2:b"]);
  assert.deepEqual(store.list({ agent: "sub:researcher" }).events.length, 2, "the receiving side matches too");
  assert.deepEqual(store.list({ status: "done" }).events.map((e) => e.id), ["s2:b"]);
  assert.deepEqual(store.list({ status: "running" }).events.map((e) => e.id), ["s1:a"]);
  assert.deepEqual(store.agents().map((a) => a.id), ["ares", "p_bob"]);
});

test("a running record that has gone quiet for hours is flagged stale, never silently finished", () => {
  let now = 1_000;
  const store = new TimelineStore(() => now, "e1");
  store.observe("s1", BOB, 1_000, taskStart("bg", { run_in_background: true }));
  store.observe("s1", BOB, 1_010, toolEnd("bg", { jobId: "j", taskId: "k", status: "running", description: "x" }));
  assert.equal(store.list().events[0].stale, undefined);
  now = 1_000 + STALE_AFTER_MS + 1;
  const e = store.list().events[0];
  assert.equal(e.status, "running");
  assert.equal(e.stale, true);
});

test("the store is capped, evicting the oldest finished record and never one in flight", () => {
  const store = new TimelineStore(() => 9_999_999, "e1");
  store.observe("s1", BOB, 0, taskStart("first")); // stays running
  for (let i = 0; i < TIMELINE_STORE_CAP + 40; i++) {
    store.observe("s1", BOB, 10 + i, taskStart(`t${i}`));
    store.observe("s1", BOB, 10 + i, toolEnd(`t${i}`, { status: "completed", summary: "x" }));
  }
  assert.ok(store.list({ limit: TIMELINE_MAX_LIMIT }).events.length <= TIMELINE_MAX_LIMIT);
  assert.ok(store.list({ status: "running", limit: TIMELINE_MAX_LIMIT }).events.some((e) => e.id === "s1:first"), "the running record survives eviction");
  // The oldest finished record still held (lowest revision) is not one of the first forty.
  const oldest = store.list({ since: 1, status: "done", limit: 1 }).events[0];
  const n = Number(oldest.id.replace("s1:t", ""));
  assert.ok(n >= 40, `oldest finished survivor is t${n}`);
});

test("waitForChange resolves on a change and on timeout", async () => {
  const store = new TimelineStore(() => 1, "e1");
  const quick = store.waitForChange(store.rev, 5_000);
  setTimeout(() => store.observe("s1", BOB, 1, taskStart("t1")), 20);
  const t0 = Date.now();
  await quick;
  assert.ok(Date.now() - t0 < 1_500, "woke on the change");
  const t1 = Date.now();
  await store.waitForChange(store.rev, 60);
  assert.ok(Date.now() - t1 >= 50, "otherwise waits out the timeout");
  await store.waitForChange(0, 5_000); // already ahead of the cursor: immediate
});

// ── rollout replay ────────────────────────────────────────────────────────

async function writeRollout(home, sessionId, entries, { tornFirst = false } = {}) {
  const dir = path.join(home, "garrison", "sessions");
  await fsp.mkdir(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  if (tornFirst) lines.unshift('{"ts":"2026-09-01T00:00:00Z","event":{"type":"tool_start","id":"torn","na');
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n", "utf8");
}

test("readRolloutTail drops a torn first line and reads the newest bytes", async (t) => {
  const home = await tempHome(t);
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ ts: new Date(1_800_000_000_000 + i).toISOString(), event: { type: "text_delta", text: "x".repeat(200) } });
  await writeRollout(home, "sess_a", entries);
  const file = path.join(home, "garrison", "sessions", "sess_a.jsonl");
  const tail = await readRolloutTail(file, 2_000);
  assert.ok(tail.length > 0 && tail.length < 50);
  assert.ok(tail.every((e) => e.event.type === "text_delta"));
  assert.deepEqual(await readRolloutTail(path.join(home, "nope.jsonl"), 100), []);
});

test("the tracker replays recent rollouts at boot, skips guests, and never reads outside the sessions dir", async (t) => {
  const home = await tempHome(t);
  const at = (n) => new Date(Date.now() - 60_000 + n).toISOString();
  await writeRollout(home, "sess_bob", [
    { ts: at(0), event: taskStart("t1") },
    { ts: at(3000), event: toolEnd("t1", { status: "completed", summary: "Found it." }) },
    { ts: at(4000), event: { type: "tool_start", id: "t2", name: "Task", input: { description: "Still going", subagent_type: "researcher" }, activityDescription: "x" } },
  ], { tornFirst: true });
  await writeRollout(home, "sess_guest", [{ ts: at(0), event: taskStart("g1") }]);
  const host = {
    list: () => [{ id: "sess_bob", busy: false }, { id: "sess_guest", tenant: { role: "guest" } }, { id: "../../etc/passwd" }],
    attach: () => () => {},
  };
  const api = createTimelineApi(host, { home, agentOf: (id) => (id === "sess_bob" ? BOB : ARES), syncEveryMs: 0 });
  t.after(() => api.stop());
  await api.ready;
  const events = api.store.list().events;
  assert.deepEqual(events.map((e) => e.id).sort(), ["sess_bob:t1", "sess_bob:t2"]);
  const t1 = events.find((e) => e.id === "sess_bob:t1");
  assert.equal(t1.status, "done");
  assert.equal(t1.excerpt, "Found it.");
  assert.equal(t1.durationMs, 3000);
  assert.equal(t1.from.name, "Builder Bob");
  assert.equal(events.find((e) => e.id === "sess_bob:t2").status, "running");
  assert.ok(!events.some((e) => e.sessionId === "sess_guest"), "guest threads are never read");
});

// ── the route, through a real RemoteAgentServer + SessionManager ───────────

function scriptedSessions(home, script) {
  return new SessionManager({
    home,
    factory: ({ signal }) => {
      let current = "";
      return {
        engine: {
          appendUserMessageContent(content) { current = content.map((b) => b.text ?? "").join(""); },
          hydrate() {},
          history: () => [],
          streamTurn: () => script({ signal, text: current }),
        },
        providerName: "fake",
        model: "fake",
        workspace: home,
      };
    },
  });
}

async function serve(t, home, script, extra = {}) {
  const sessions = scriptedSessions(home, script);
  const lines = [];
  const timeline = createTimelineApi(sessions, { home, agentOf: () => BOB, log: (l) => lines.push(l), syncEveryMs: 0, ...extra });
  t.after(() => timeline.stop());
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok", phoneApi: { timeline: timeline.handle } });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, token = "owner-tok") => {
    const res = await fetch(base + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, sessions, timeline, lines };
}

const delegating = async function* () {
  yield { type: "tool_start", id: "tk1", name: "Task", input: { description: "Find the auth handler", prompt: "Look.", subagent_type: "researcher" }, activityDescription: "Task[researcher] Find the auth handler" };
  yield { type: "tool_end", id: "tk1", output: { status: "completed", summary: "src/auth/login.ts", durationMs: 12 }, durationMs: 12 };
  yield { type: "text_delta", text: "Done." };
  yield TURN_END;
};

test("route: owner bearer only, GET only, strict parameters", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, delegating);
  assert.equal((await s.call("GET", "/gateway/timeline", null)).status, 401);
  assert.equal((await s.call("GET", "/gateway/timeline", "guest-tok")).status, 401);
  assert.equal((await s.call("POST", "/gateway/timeline")).status, 405);
  assert.equal((await s.call("PUT", "/gateway/timeline")).status, 405);
  for (const q of ["since=abc", "since=-1", "limit=1.5", "wait=x", "status=exploded", "agent=" + "a".repeat(200), "agent=%00bad"]) {
    const r = await s.call("GET", `/gateway/timeline?${q}`);
    assert.equal(r.status, 400, q);
    assert.ok(r.body.error);
  }
  const ok = await s.call("GET", "/gateway/timeline");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.events, []);
  assert.equal(typeof ok.body.epoch, "string");
  assert.equal(ok.body.cursor, 0);
  assert.equal((await s.call("GET", "/gateway/timeline/")).status, 200, "a trailing slash is the same route");
  assert.equal((await s.call("GET", "/gateway/timeline?limit=99999&since=0&wait=0")).status, 200, "huge numbers are clamped, not rejected");
});

test("route: a live delegation shows up, with running then done, and a cursor delta", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await serve(t, home, async function* () {
    yield { type: "tool_start", id: "tk1", name: "Task", input: { description: "Find the auth handler", prompt: "Look.", subagent_type: "researcher" }, activityDescription: "x" };
    await gate;
    yield { type: "tool_end", id: "tk1", output: { status: "completed", summary: "src/auth/login.ts", durationMs: 12 }, durationMs: 12 };
    yield TURN_END;
  });
  const session = s.sessions.create({ surface: "mobile" });
  s.timeline.sync();
  const turn = s.sessions.send(session.id, "who handles login?");
  const running = await waitFor(async () => {
    const r = await s.call("GET", "/gateway/timeline");
    return r.body.events.length === 1 ? r.body : null;
  }, "the running handoff");
  assert.equal(running.events[0].status, "running");
  assert.equal(running.events[0].from.name, "Builder Bob");
  assert.equal(running.events[0].to.name, "Researcher");
  assert.equal(running.events[0].task, "Find the auth handler");
  assert.equal(running.events[0].sessionId, session.id);
  const cursor = running.cursor;

  // Long poll: held until the result lands, then returns just the change.
  const polled = s.call("GET", `/gateway/timeline?since=${cursor}&epoch=${running.epoch}&wait=5000`);
  await tick(60);
  release();
  const delta = await polled;
  await turn;
  assert.equal(delta.status, 200);
  assert.equal(delta.body.events.length, 1);
  assert.equal(delta.body.events[0].status, "done");
  assert.equal(delta.body.events[0].excerpt, "src/auth/login.ts");
  assert.ok(delta.body.cursor > cursor);
  assert.equal(delta.body.reset, undefined);

  // Up to date: a short wait comes back empty.
  const quiet = await s.call("GET", `/gateway/timeline?since=${delta.body.cursor}&epoch=${running.epoch}&wait=80`);
  assert.deepEqual(quiet.body.events, []);

  // A different epoch (the server restarted) starts the client over.
  const reset = await s.call("GET", `/gateway/timeline?since=${delta.body.cursor}&epoch=old-run`);
  assert.equal(reset.body.reset, true);
  assert.equal(reset.body.events.length, 1);

  // Filters ride the same route.
  assert.equal((await s.call("GET", "/gateway/timeline?agent=p_bob")).body.events.length, 1);
  assert.equal((await s.call("GET", "/gateway/timeline?agent=p_other")).body.events.length, 0);
  assert.equal((await s.call("GET", "/gateway/timeline?status=failed")).body.events.length, 0);
  assert.equal((await s.call("GET", "/gateway/timeline")).body.agents[0].id, "p_bob");
});

test("route: a guest session's delegations are never reported", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, delegating);
  const guest = s.sessions.create({ surface: "telegram", tenant: { role: "guest", chatId: "c1" } });
  s.timeline.sync();
  await s.sessions.send(guest.id, "do a thing");
  await tick(30);
  const r = await s.call("GET", "/gateway/timeline");
  assert.deepEqual(r.body.events, []);
});

test("route: a thread caught mid-turn is read back from its rollout when first noticed", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await serve(t, home, async function* () {
    yield { type: "tool_start", id: "early", name: "Task", input: { description: "Started before anyone watched", subagent_type: "researcher" }, activityDescription: "x" };
    await tick(80); // the rollout append is async: give it a beat to land
    await gate;
    yield { type: "tool_end", id: "early", output: { status: "completed", summary: "late result" }, durationMs: 1 };
    yield TURN_END;
  });
  const session = s.sessions.create({ surface: "mobile" });
  const turn = s.sessions.send(session.id, "go");
  await tick(30);
  s.timeline.sync(); // first noticed mid-turn: tool_start already happened
  const seen = await waitFor(async () => {
    const r = await s.call("GET", "/gateway/timeline");
    return r.body.events.find((e) => e.task === "Started before anyone watched");
  }, "the early handoff from the rollout");
  assert.equal(seen.status, "running");
  release();
  await turn;
  const done = await waitFor(async () => {
    const r = await s.call("GET", "/gateway/timeline");
    const e = r.body.events.find((x) => x.id === seen.id);
    return e?.status === "done" ? e : null;
  }, "its result");
  assert.equal(done.excerpt, "late result");
});
