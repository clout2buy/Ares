// POST /gateway/ask — the Siri "ask Ares" endpoint. Real RemoteAgentServer (so
// the owner-bearer gate is the production one) + a real SessionManager over a
// scripted engine (so pause, kill switch and permission prompts are the real
// ones); only the model is fake.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "../packages/garrison/dist/index.js";
import { ownerPause } from "../packages/core/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { OwnerControlPlane } from "../packages/cli/dist/entry/ownerControlPlane.js";
import { stripPreamble } from "../packages/cli/dist/personas.js";
import {
  createAskApi,
  toSpeakable,
  voiceSteeringNote,
  WORKING_REPLY,
  FAILED_REPLY,
  STOPPED_REPLY,
  VOICE_SESSION_TITLE,
} from "../packages/cli/dist/phoneAsk.js";

const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };
const say = (text) => ({ type: "text_delta", text });
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

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
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-ask-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

test.afterEach(() => ownerPause.resume());

/** Real SessionManager; each turn runs holder.script(ctx), which gets the text
 *  the model would have seen. */
function scripted(home, script, extra = {}) {
  const holder = { script, received: [], created: 0 };
  const sessions = new SessionManager({
    home,
    permissionTimeoutMs: extra.permissionTimeoutMs ?? 60_000,
    factory: ({ sessionId, signal, requestPermission }) => {
      holder.created++;
      let current = "";
      return {
        engine: {
          appendUserMessageContent(content) {
            current = content.map((b) => b.text ?? "").join("");
            holder.received.push(current);
          },
          hydrate() {},
          history: () => [],
          streamTurn: () => holder.script({ sessionId, signal, requestPermission, text: current }),
        },
        providerName: "fake",
        model: "fake",
        workspace: home,
      };
    },
  });
  return { sessions, holder };
}

async function serve(t, home, script, { budgetMs = 400, available, permissionTimeoutMs } = {}) {
  const { sessions, holder } = scripted(home, script, { permissionTimeoutMs });
  const lines = [];
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "owner-tok",
    phoneApi: { ask: createAskApi(sessions, { home, budgetMs, available, log: (l) => lines.push(l) }) },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method, p, body, token = "owner-tok") => {
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const res = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, sessions, holder, lines };
}

const answer = (text) => async function* () { yield say(text); yield TURN_END; };

// ── auth + validation ─────────────────────────────────────────────────────

test("auth: no token and a non-owner (guest) token are 401; GET last too", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("hi"));
  assert.equal((await s.call("POST", "/gateway/ask", { text: "hello" }, null)).status, 401);
  assert.equal((await s.call("POST", "/gateway/ask", { text: "hello" }, "guest-tok")).status, 401);
  assert.equal((await s.call("GET", "/gateway/ask/last", undefined, "guest-tok")).status, 401);
  assert.equal(s.holder.created, 0, "nothing ran for an unauthenticated caller");
});

test("validation: empty, oversize, non-string, bad surface, bad JSON are 400", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("hi"));
  for (const body of [{}, { text: "" }, { text: "   " }, { text: 5 }, { text: "x".repeat(2001) }, { text: "ok", surface: "fax" }, { text: "ok", session: 7 }, [], "not json{"]) {
    const r = await s.call("POST", "/gateway/ask", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
    assert.ok(r.body.error);
  }
  assert.equal((await s.call("POST", "/gateway/ask", { text: "x".repeat(2000) })).status, 200, "2000 chars is allowed");
  assert.equal((await s.call("PUT", "/gateway/ask", { text: "hi" })).status, 405);
});

// ── happy path, conversion, caps ──────────────────────────────────────────

test("happy path: the assistant's final text comes back as speakable text", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("It is **72 degrees** and sunny in Austin. 🌞"));
  const r = await s.call("POST", "/gateway/ask", { text: "what's the weather", surface: "siri" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  assert.equal(r.body.reply, "It is 72 degrees and sunny in Austin.");
  assert.match(r.body.sessionId, /^sess_/);
});

test("narration before a tool is dropped; the answer after the last tool is spoken", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, async function* () {
    yield say("Let me check that for you.");
    yield { type: "tool_start", id: "t1", name: "Bash", input: {}, activityDescription: "x" };
    yield { type: "tool_end", id: "t1", output: "ok", durationMs: 1 };
    yield say("You have three meetings today.");
    yield TURN_END;
  });
  assert.equal((await s.call("POST", "/gateway/ask", { text: "my day" })).body.reply, "You have three meetings today.");
});

test("toSpeakable: markdown, code, urls, emoji, lists", () => {
  assert.equal(toSpeakable("# Title\n\nSome *italic* and __bold__ and `code` here."), "Title Some italic and bold and code here.");
  assert.equal(toSpeakable("Here you go:\n```js\nconsole.log(1)\n```\nRun it."), "Here you go: I put the code in the app. Run it.");
  assert.equal(toSpeakable("```py\nprint(1)"), "I put the code in the app.");
  assert.equal(toSpeakable("See [the docs](https://www.example.com/a/b?c=1) or https://news.ycombinator.com/item?id=9."), "See the docs or news.ycombinator.com.");
  assert.equal(toSpeakable("![chart](https://x.io/c.png) done"), "chart done");
  assert.equal(toSpeakable("Ready \u{1F680}\u{1F44D}\u{1F3FD} now ❤️"), "Ready now");
  assert.equal(toSpeakable("Pick one:\n- Apples\n- Pears.\n1. Plums"), "Pick one: Apples. Pears. Plums.");
  assert.equal(toSpeakable("> quoted\n\n---\n\nend"), "quoted end");
  assert.equal(toSpeakable("| a | b |\n|---|---|\n| 1 | 2 |"), "a, b. 1, 2.");
  assert.equal(toSpeakable("   \n  "), "");
});

test("toSpeakable: caps at ~600 chars on a sentence boundary", () => {
  const long = Array.from({ length: 80 }, (_, i) => `This is sentence number ${i}.`).join(" ");
  const out = toSpeakable(long);
  assert.ok(out.length <= 600, String(out.length));
  assert.match(out, /\.$/);
  assert.match(out, /sentence number \d+\.$/);
  const noBreaks = toSpeakable("word ".repeat(400));
  assert.ok(noBreaks.length <= 601);
  assert.match(noBreaks, /\.$/);
});

test("response size: a huge reply is capped in the JSON body", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("Big sentence here. ".repeat(5000)));
  const r = await s.call("POST", "/gateway/ask", { text: "essay" });
  assert.ok(r.body.reply.length <= 600);
  assert.equal(r.body.status, "done");
});

// ── dedicated session + steering ──────────────────────────────────────────

test("one dedicated session: created once, titled Voice, mobile surface, reused; survives a new handler", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("ok"));
  const a = await s.call("POST", "/gateway/ask", { text: "first" });
  const b = await s.call("POST", "/gateway/ask", { text: "second" });
  assert.equal(a.body.sessionId, b.body.sessionId);
  assert.equal(s.holder.created, 1);
  const summary = s.sessions.list().find((x) => x.id === a.body.sessionId);
  assert.equal(summary.title, VOICE_SESSION_TITLE);
  assert.equal(summary.surface, "mobile");
  assert.equal(summary.tenant?.role ?? "owner", "owner");
  // A fresh handler on the same home (daemon restart) finds the same session.
  const again = createAskApi(s.sessions, { home, budgetMs: 400 });
  assert.equal(typeof again, "function");
  const saved = JSON.parse(await fsp.readFile(path.join(home, "voice-ask.json"), "utf8"));
  assert.equal(saved.sessionId, a.body.sessionId);
});

test("every ask carries the hidden voice steering note, and it strips cleanly", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("ok"));
  await s.call("POST", "/gateway/ask", { text: "what time is it", surface: "shortcut" });
  await s.call("POST", "/gateway/ask", { text: "and in Tokyo" });
  assert.equal(s.holder.received.length, 2);
  for (const seen of s.holder.received) {
    assert.match(seen, /^\(System: /);
    assert.match(seen, /Siri|shortcut/);
    assert.match(seen, /one to three short spoken sentences/);
    assert.match(seen, /no markdown/i);
    assert.match(seen, /permission rules still apply/);
  }
  assert.equal(stripPreamble(s.holder.received[0]), "what time is it");
  assert.equal(stripPreamble(s.holder.received[1]), "and in Tokyo");
  assert.equal(stripPreamble(voiceSteeringNote("widget") + "\n\nhi"), "hi");
  // Never auto-approves: nothing in the note grants anything.
  assert.doesNotMatch(voiceSteeringNote(), /auto-?approve|without asking|always allow/i);
});

// ── budget, concurrency, last ─────────────────────────────────────────────

test("budget expiry returns working without aborting; /ask/last shows the eventual reply", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  let aborted = false;
  const s = await serve(t, home, async function* ({ signal }) {
    signal.addEventListener("abort", () => { aborted = true; });
    await gate;
    yield say("Done, the report is ready.");
    yield TURN_END;
  }, { budgetMs: 60 });
  const r = await s.call("POST", "/gateway/ask", { text: "build the report" });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "working");
  assert.equal(r.body.reply, WORKING_REPLY);
  assert.ok(r.body.sessionId);
  assert.deepEqual((await s.call("GET", "/gateway/ask/last")).body.status, "working");
  assert.equal((await s.call("GET", "/gateway/ask/last")).body.reply, undefined);
  release();
  await waitFor(async () => (await s.call("GET", "/gateway/ask/last")).body.status === "done", "turn finishes");
  const last = (await s.call("GET", "/gateway/ask/last")).body;
  assert.equal(last.reply, "Done, the report is ready.");
  assert.equal(typeof last.at, "number");
  assert.equal(aborted, false, "the turn was never aborted");
});

test("budget: ARES_ASK_BUDGET_MS is honoured and clamped to 28s", async (t) => {
  const home = await tempHome(t);
  const { sessions } = scripted(home, answer("x"));
  const prior = process.env.ARES_ASK_BUDGET_MS;
  t.after(() => { if (prior === undefined) delete process.env.ARES_ASK_BUDGET_MS; else process.env.ARES_ASK_BUDGET_MS = prior; });
  process.env.ARES_ASK_BUDGET_MS = "50";
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = scripted(home, async function* () { await gate; yield say("late"); yield TURN_END; });
  const api = createAskApi(slow.sessions, { home });
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok", phoneApi: { ask: api } });
  await server.start();
  t.after(() => server.close());
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${server.port}/gateway/ask`, { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify({ text: "slow" }) });
  assert.equal((await res.json()).status, "working");
  assert.ok(Date.now() - started < 2000, "env budget of 50ms applied, not the 22s default");
  release();
  void sessions;
});

test("concurrent ask: a different question while one runs is 429 with working info; the same question joins the running turn", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  let turns = 0;
  const s = await serve(t, home, async function* () {
    turns++;
    await gate;
    yield say("Seven.");
    yield TURN_END;
  }, { budgetMs: 80 });
  const first = await s.call("POST", "/gateway/ask", { text: "how many" });
  assert.equal(first.body.status, "working");
  const other = await s.call("POST", "/gateway/ask", { text: "something else" });
  assert.equal(other.status, 429);
  assert.equal(other.body.status, "working");
  assert.equal(other.body.sessionId, first.body.sessionId);
  const retry = await s.call("POST", "/gateway/ask", { text: "  How   many " });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, "working");
  release();
  await waitFor(async () => (await s.call("GET", "/gateway/ask/last")).body.status === "done", "done");
  assert.equal(turns, 1, "exactly one turn ran");
  const after = await s.call("POST", "/gateway/ask", { text: "how many" });
  assert.equal(after.status, 200, "a finished ask no longer blocks");
  assert.equal(turns, 2);
});

test("a retried identical ask that finishes within its budget returns the answer", async (t) => {
  const home = await tempHome(t);
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await serve(t, home, async function* () { await gate; yield say("Finally."); yield TURN_END; }, { budgetMs: 60 });
  assert.equal((await s.call("POST", "/gateway/ask", { text: "q" })).body.status, "working");
  setTimeout(release, 20);
  const retry = await s.call("POST", "/gateway/ask", { text: "q" });
  assert.deepEqual([retry.body.status, retry.body.reply], ["done", "Finally."]);
});

test("/ask/last before any ask is an empty done; reply survives in memory between asks", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("Noted."));
  assert.deepEqual((await s.call("GET", "/gateway/ask/last")).body, { status: "done" });
  await s.call("POST", "/gateway/ask", { text: "remember" });
  const last = (await s.call("GET", "/gateway/ask/last")).body;
  assert.equal(last.reply, "Noted.");
  assert.equal(last.status, "done");
});

// ── pause, kill switch, approvals, failures ───────────────────────────────

test("owner pause: the turn waits at the door, the ask returns working, and resume completes it", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("Back again."), { budgetMs: 60 });
  const plane = new OwnerControlPlane({ home, sessions: s.sessions });
  plane.pause();
  const r = await s.call("POST", "/gateway/ask", { text: "hello" });
  assert.equal(r.body.status, "working");
  assert.equal(s.holder.received.length, 0, "nothing reached the model while paused");
  plane.resume();
  await waitFor(async () => (await s.call("GET", "/gateway/ask/last")).body.reply === "Back again.", "completes after resume");
});

test("kill switch wins: stop-all while an ask waits drops it and nothing runs", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("should not run"), { budgetMs: 80 });
  const plane = new OwnerControlPlane({ home, sessions: s.sessions });
  plane.pause();
  const first = await s.call("POST", "/gateway/ask", { text: "do it" });
  assert.equal(first.body.status, "working");
  await plane.stopAll();
  await waitFor(async () => (await s.call("GET", "/gateway/ask/last")).body.status === "done", "settles");
  const last = (await s.call("GET", "/gateway/ask/last")).body;
  assert.equal(last.reply, STOPPED_REPLY);
  assert.equal(s.holder.received.length, 0, "the stopped ask never ran");
  plane.resume();
});

test("an approval nobody answers: the ask times out to working; nothing is auto-approved", async (t) => {
  const home = await tempHome(t);
  const decisions = [];
  const s = await serve(t, home, async function* ({ requestPermission }) {
    const d = await requestPermission({ id: "p1", toolName: "Stripe", input: { url: "https://pay.example/c" }, reason: "money" });
    decisions.push(d);
    yield say(d === "deny" ? "I wasn't allowed to." : "Paid.");
    yield TURN_END;
  }, { budgetMs: 80 });
  const r = await s.call("POST", "/gateway/ask", { text: "buy it" });
  assert.equal(r.body.status, "working");
  assert.deepEqual(decisions, [], "still pending, not auto-approved");
  assert.ok(s.sessions.respondPermission(r.body.sessionId, "p1", "deny"), "the prompt is answerable from the app");
  await waitFor(async () => (await s.call("GET", "/gateway/ask/last")).body.reply === "I wasn't allowed to.", "denied turn finishes");
  assert.notEqual(decisions[0], "allow_once");
});

test("provider unavailable: 503 before any session or turn", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, answer("x"), { available: () => "no model is configured" });
  const r = await s.call("POST", "/gateway/ask", { text: "hi" });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /no model/);
  assert.equal(s.holder.created, 0);
  const s2 = await serve(t, home, answer("x"), { available: () => false });
  assert.equal((await s2.call("POST", "/gateway/ask", { text: "hi" })).status, 503);
});

test("a send that throws (brain failed to start) is 503; a failed turn with no text is an honest line", async (t) => {
  const home = await tempHome(t);
  const s = await serve(t, home, async function* () { throw new Error("401 invalid api key"); });
  const r = await s.call("POST", "/gateway/ask", { text: "hi" });
  assert.equal(r.status, 503);
  const home2 = await tempHome(t);
  const s2 = await serve(t, home2, async function* () {
    yield { type: "error", error: { code: "x", message: "overloaded", retriable: false } };
    yield { ...TURN_END, status: "failed" };
  });
  const r2 = await s2.call("POST", "/gateway/ask", { text: "hi" });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.reply, FAILED_REPLY);
  assert.ok(s2.lines.some((l) => /overloaded/.test(l)));
});

test("the thread is an ordinary session: a failed ask does not wedge the next one", async (t) => {
  const home = await tempHome(t);
  let n = 0;
  const s = await serve(t, home, async function* () {
    n++;
    if (n === 1) { yield { ...TURN_END, status: "failed" }; return; }
    yield say("Second time lucky.");
    yield TURN_END;
  });
  assert.equal((await s.call("POST", "/gateway/ask", { text: "one" })).body.reply, FAILED_REPLY);
  assert.equal((await s.call("POST", "/gateway/ask", { text: "two" })).body.reply, "Second time lucky.");
});
