// session.send is idempotent on the client's message id.
//
// The phone queues messages while it has no signal and re-sends them on
// reconnect, so "did that one arrive?" is never knowable from the phone's
// side. The contract that makes retrying safe: a send carrying an inputId
// (alias clientMsgId) is executed ONCE however often it is sent, every attempt
// is answered with `send.ack` (duplicate:true for a retry), the history holds
// the message once, and the same id carrying a different message is refused.
//
// Real GarrisonServer + SessionManager + Core Session over the real SQLite
// session kernel (the production arrangement); one test goes in through the
// real RemoteAgentServer /gateway proxy the phone actually uses. Only the
// model is fake. A second group pins the legacy (no durable kernel) engine.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GarrisonServer, SessionManager, InputConflictError, ensureToken, loadGarrisonRollout } from "../packages/garrison/dist/index.js";
import { Session, QueryEngine, MockEchoProvider, openWorkspaceSessionKernel } from "../packages/core/dist/index.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

const wsModule = await import("ws").catch(() => import("../packages/garrison/node_modules/ws/wrapper.mjs"));
const WebSocket = wsModule.default ?? wsModule.WebSocket;

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await tick(5);
  }
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    ws.on("message", (d) => this.frames.push(JSON.parse(d.toString())));
    ws.on("error", () => {});
  }
  static async open(url, token, name = "phone") {
    const ws = new WebSocket(url);
    const c = new Client(ws);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    c.send({ type: "hello", token, client: name, proto: 1 });
    await waitFor(() => c.frames.some((f) => f.type === "welcome"), "welcome");
    return c;
  }
  send(frame) { this.ws.send(JSON.stringify(frame)); }
  of(type) { return this.frames.filter((f) => f.type === type); }
  acks(inputId) { return this.frames.filter((f) => f.type === "send.ack" && f.inputId === inputId); }
  admitted(inputId) { return this.frames.filter((f) => f.type === "event" && f.event.type === "input_admitted" && (!inputId || f.event.inputId === inputId)); }
  kill() { this.ws.terminate(); }
}

/** A provider that counts calls and can hold the first one open. */
function gatedProvider() {
  const state = { calls: 0, prompts: [], gate: Promise.resolve(), release: () => {}, started: () => {} };
  const startedP = new Promise((r) => { state.started = r; });
  state.startedP = startedP;
  state.hold = () => { state.gate = new Promise((r) => { state.release = r; }); };
  state.provider = {
    name: "counted",
    async *stream(req) {
      state.calls += 1;
      state.prompts.push(JSON.stringify(req.messages?.at?.(-1) ?? ""));
      state.started();
      await state.gate;
      yield {
        type: "message_done",
        message: { id: `reply-${state.calls}`, role: "assistant", content: [{ type: "text", text: `answer ${state.calls}` }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  return state;
}

async function boot(t, { hold = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-idem-send-"));
  const kernel = await openWorkspaceSessionKernel(home);
  const model = gatedProvider();
  if (hold) model.hold();
  const beforeSend = [];
  const sessions = new SessionManager({
    home,
    beforeSend: (ctx) => { beforeSend.push(ctx.text); },
    factory: ({ sessionId, model: m, signal, requestPermission, initialMessages, initialEventCount }) => ({
      session: new Session({
        workspace: home,
        provider: model.provider,
        model: m ?? "mock",
        systemPrompt: "idempotent send test",
        tools: [],
        signal,
        requestPermission,
        sessionId,
        initialMessages,
        initialSeq: initialEventCount,
        telemetryDir: path.join(home, "telemetry"),
        sessionRegistryHome: home,
        sessionKernel: kernel,
      }),
      providerName: "counted",
      model: m ?? "mock",
      workspace: home,
    }),
    sessionKernel: kernel,
    // The history the phone replays on attach is read from the garrison's own rollout.
  });
  const server = new GarrisonServer({
    home,
    sessions,
    port: 0,
    history: (sessionId, opts) => loadGarrisonRollout(home, sessionId, opts),
  });
  const { port } = await server.start();
  const token = await ensureToken(home);
  const clients = [];
  t.after(async () => {
    model.release();
    for (const c of clients) c.kill();
    await sessions.flush();
    await server.close();
    kernel.close();
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });
  const open = async (url = `ws://127.0.0.1:${port}`, tok = token) => { const c = await Client.open(url, tok); clients.push(c); return c; };
  return { home, kernel, model, sessions, server, port, token, open, beforeSend };
}

async function history(client, sessionId) {
  const before = client.of("session.history").length;
  client.send({ type: "session.history", sessionId, limit: 500 });
  await waitFor(() => client.of("session.history").length > before, "history");
  return client.of("session.history").at(-1).entries.map((e) => e.event);
}

test("replay after a dropped connection: executed once, acked as a duplicate, in the history once", async (t) => {
  const g = await boot(t, { hold: true });
  const first = await g.open();
  first.send({ type: "session.create" });
  const { session } = await waitFor(() => first.of("session.created")[0], "created");
  const sid = session.id;

  first.send({ type: "session.send", sessionId: sid, text: "book the table", inputId: "msg-1", delivery: "steer" });
  await waitFor(() => first.acks("msg-1").length === 1, "first ack");
  assert.equal(first.acks("msg-1")[0].duplicate, false, "the first attempt is not a duplicate");
  assert.equal(first.acks("msg-1")[0].sessionId, sid);
  await g.model.startedP;
  first.kill(); // the line drops with the turn still running; the phone never saw the answer

  // New connection, new socket, same message: it was never attached to the session.
  const second = await g.open();
  second.send({ type: "session.send", sessionId: sid, text: "book the table", inputId: "msg-1", delivery: "steer" });
  await waitFor(() => second.acks("msg-1").length === 1, "replay ack");
  assert.equal(second.acks("msg-1")[0].duplicate, true, "the retry is recognised");
  g.model.release();
  await waitFor(() => g.sessions.list().find((s) => s.id === sid)?.busy === false, "turn settled");
  await g.sessions.flush();

  assert.equal(g.model.calls, 1, "one model turn, however many times it was sent");
  assert.equal(g.kernel.getInput("msg-1")?.state, "consumed");
  assert.deepEqual(g.beforeSend, ["book the table"], "memory capture ran once, not for the replay");

  const events = await history(second, sid);
  assert.equal(events.filter((e) => e.type === "input_admitted").length, 1, "the history holds the message once");
  assert.equal(events.filter((e) => e.type === "message_done").length, 1);
  assert.ok(events.some((e) => e.type === "turn_end"));
});

test("replay after the turn finished: still no second turn, still acked", async (t) => {
  const g = await boot(t);
  const a = await g.open();
  a.send({ type: "session.create" });
  const sid = (await waitFor(() => a.of("session.created")[0], "created")).session.id;
  a.send({ type: "session.attach", sessionId: sid });
  a.send({ type: "session.send", sessionId: sid, text: "what is the weather", inputId: "msg-a", delivery: "queue" });
  await waitFor(() => a.of("event").some((f) => f.event.type === "turn_end"), "turn end");
  assert.equal(g.model.calls, 1);
  a.kill();

  const b = await g.open();
  for (let i = 0; i < 3; i++) b.send({ type: "session.send", sessionId: sid, text: "what is the weather", inputId: "msg-a", delivery: "queue" });
  await waitFor(() => b.acks("msg-a").length === 3, "three acks");
  assert.ok(b.acks("msg-a").every((x) => x.duplicate === true));
  await waitFor(() => g.sessions.list().find((s) => s.id === sid)?.busy === false, "idle");
  await g.sessions.flush();
  assert.equal(g.model.calls, 1);
  assert.equal(g.beforeSend.length, 1);
  const events = await history(b, sid);
  assert.equal(events.filter((e) => e.type === "input_admitted").length, 1);
  assert.equal(events.filter((e) => e.type === "turn_start").length, 1);
});

test("the same id with a different message is refused, and the original is untouched", async (t) => {
  const g = await boot(t);
  const c = await g.open();
  c.send({ type: "session.create" });
  const sid = (await waitFor(() => c.of("session.created")[0], "created")).session.id;
  c.send({ type: "session.send", sessionId: sid, text: "pay the electric bill", inputId: "msg-x", delivery: "queue" });
  await waitFor(() => c.acks("msg-x").length === 1, "ack");
  await waitFor(() => g.sessions.list().find((s) => s.id === sid)?.busy === false, "idle");

  c.send({ type: "session.send", sessionId: sid, text: "pay the gas bill instead", inputId: "msg-x", delivery: "queue" });
  const err = await waitFor(() => c.of("error").find((f) => /already used/i.test(f.message)), "conflict error");
  assert.match(err.message, /different (input|message)/i);
  assert.equal(c.acks("msg-x").length, 1, "the refused attempt is not acked");
  assert.equal(g.model.calls, 1);
  assert.deepEqual(g.beforeSend, ["pay the electric bill"]);
});

test("clientMsgId is the same key as inputId; two that disagree are refused", async (t) => {
  const g = await boot(t);
  const c = await g.open();
  c.send({ type: "session.create" });
  const sid = (await waitFor(() => c.of("session.created")[0], "created")).session.id;
  c.send({ type: "session.send", sessionId: sid, text: "hello there", clientMsgId: "cm-1", delivery: "queue" });
  await waitFor(() => c.acks("cm-1").length === 1, "ack by clientMsgId");
  await waitFor(() => g.sessions.list().find((s) => s.id === sid)?.busy === false, "idle");
  c.send({ type: "session.send", sessionId: sid, text: "hello there", inputId: "cm-1", delivery: "queue" });
  await waitFor(() => c.acks("cm-1").length === 2, "replay under the other name");
  assert.equal(c.acks("cm-1")[1].duplicate, true);
  assert.equal(g.model.calls, 1);

  c.send({ type: "session.send", sessionId: sid, text: "x", inputId: "one", clientMsgId: "two" });
  await waitFor(() => c.of("error").some((f) => /must match/.test(f.message)), "mismatch error");
  c.send({ type: "session.send", sessionId: sid, text: "x", clientMsgId: "" });
  await waitFor(() => c.of("error").some((f) => /clientMsgId must be a non-empty string/.test(f.message)), "empty id error");
  c.send({ type: "session.send", sessionId: sid, text: "x", clientMsgId: "y".repeat(1025) });
  await waitFor(() => c.of("error").filter((f) => /clientMsgId must be a non-empty string/.test(f.message)).length === 2, "long id error");
  assert.equal(g.model.calls, 1);
});

test("without an id nothing changes: no ack frames, and the same words twice are two messages", async (t) => {
  const g = await boot(t);
  const c = await g.open();
  c.send({ type: "session.create" });
  const sid = (await waitFor(() => c.of("session.created")[0], "created")).session.id;
  c.send({ type: "session.send", sessionId: sid, text: "again", delivery: "queue" });
  await waitFor(() => g.model.calls === 1 && g.sessions.list().find((s) => s.id === sid)?.busy === false, "first done");
  c.send({ type: "session.send", sessionId: sid, text: "again", delivery: "queue" });
  await waitFor(() => g.model.calls === 2, "second ran");
  assert.equal(c.of("send.ack").length, 0);
});

test("an offline queue flushed on reconnect, then flushed AGAIN out of order, runs each message once and in order", async (t) => {
  const g = await boot(t);
  const first = await g.open();
  first.send({ type: "session.create" });
  const sid = (await waitFor(() => first.of("session.created")[0], "created")).session.id;
  first.kill();

  // The phone reconnects and flushes its outbox, oldest first.
  const phone = await g.open();
  phone.send({ type: "session.attach", sessionId: sid });
  const queue = ["one", "two", "three"].map((word, i) => ({ type: "session.send", sessionId: sid, text: `message ${word}`, inputId: `q-${i}`, delivery: "queue" }));
  // The outbox sends the next one once the previous is acknowledged.
  for (const frame of queue) {
    phone.send(frame);
    await waitFor(() => phone.acks(frame.inputId).length === 1, `ack for ${frame.inputId}`);
  }
  await waitFor(() => g.model.calls === 3 && g.sessions.list().find((s) => s.id === sid)?.busy === false, "all three ran");

  // The ack for the last one was lost to a flaky link, so the phone flushes everything again, shuffled.
  const again = await g.open();
  for (const frame of [queue[2], queue[0], queue[1], queue[2]]) again.send(frame);
  await waitFor(() => again.of("send.ack").length === 4, "four duplicate acks");
  assert.ok(again.of("send.ack").every((a) => a.duplicate));
  await tick(50);
  await g.sessions.flush();
  assert.equal(g.model.calls, 3, "no message ran twice");
  const events = await history(again, sid);
  const said = events.filter((e) => e.type === "input_admitted").map((e) => e.userMessage.content[0].text);
  assert.deepEqual(said, ["message one", "message two", "message three"], "once each, in the order first sent");
});

test("through the real RemoteAgentServer /gateway proxy: a phone that drops and reconnects replays safely", async (t) => {
  const g = await boot(t, { hold: true });
  const remote = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", gatewayUrl: `ws://127.0.0.1:${g.port}`, controlToken: g.token });
  await remote.start();
  t.after(() => remote.close());
  const url = `ws://127.0.0.1:${remote.port}/gateway`;

  const phone = await g.open(url);
  phone.send({ type: "session.create", surface: "mobile" });
  const sid = (await waitFor(() => phone.of("session.created")[0], "created")).session.id;
  phone.send({ type: "session.send", sessionId: sid, text: "photo caption", inputId: "m-9", delivery: "steer", attachments: [{ kind: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  await waitFor(() => phone.acks("m-9").length === 1, "ack through the proxy");
  await g.model.startedP;
  phone.kill();

  const back = await g.open(url);
  back.send({ type: "session.send", sessionId: sid, text: "photo caption", inputId: "m-9", delivery: "steer", attachments: [{ kind: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }] });
  await waitFor(() => back.acks("m-9").length === 1, "replay ack through the proxy");
  assert.equal(back.acks("m-9")[0].duplicate, true);
  // The same id with a different picture is a different message.
  back.send({ type: "session.send", sessionId: sid, text: "photo caption", inputId: "m-9", delivery: "steer", attachments: [{ kind: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAA=" }] });
  await waitFor(() => back.of("error").some((f) => /already used/i.test(f.message)), "different attachment refused");
  g.model.release();
  await waitFor(() => g.sessions.list().find((s) => s.id === sid)?.busy === false, "settled");
  assert.equal(g.model.calls, 1);
});

// ── the legacy engine (no durable kernel) ────────────────────────────────────

function legacyManager(home, script) {
  const holder = { turns: [] };
  const sessions = new SessionManager({
    home,
    factory: ({ sessionId }) => {
      let current = "";
      return {
        engine: {
          appendUserMessageContent(content) { current = content.map((b) => b.text ?? "").join(""); },
          hydrate() {},
          history: () => [],
          streamTurn: () => { holder.turns.push(current); return script(current, holder.turns.length); },
        },
        providerName: "fake",
        model: "fake",
        workspace: home,
      };
    },
  });
  return { sessions, holder };
}
const TURN_END = { type: "turn_end", status: "completed", workStatus: "verified", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 };

test("legacy engine: a retried inputId is acked and not run again; a different message under it is refused", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-idem-legacy-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const { sessions, holder } = legacyManager(home, async function* () { yield TURN_END; });
  const { id } = sessions.create({});
  const acks = [];
  await sessions.send(id, "do it once", { inputId: "k1", onAdmitted: (a) => acks.push(a) });
  await sessions.send(id, "do it once", { inputId: "k1", onAdmitted: (a) => acks.push(a) });
  assert.deepEqual(acks, [{ inputId: "k1", duplicate: false }, { inputId: "k1", duplicate: true }]);
  assert.deepEqual(holder.turns, ["do it once"]);
  await assert.rejects(() => sessions.send(id, "do something else", { inputId: "k1" }), InputConflictError);
  assert.equal(holder.turns.length, 1);
  await sessions.send(id, "no id", {});
  await sessions.send(id, "no id", {});
  assert.equal(holder.turns.length, 3, "sends without an id are never deduplicated");
  await sessions.flush();
});

test("legacy engine: a turn that threw, or was refused as busy, is not remembered; its retry runs", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-idem-legacy-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  const { sessions, holder } = legacyManager(home, async function* (text, n) {
    if (text === "explode") throw new Error("engine blew up");
    if (text === "slow") await gate;
    yield TURN_END;
  });
  const { id } = sessions.create({});
  await assert.rejects(() => sessions.send(id, "explode", { inputId: "boom" }), /blew up/);
  await assert.rejects(() => sessions.send(id, "explode", { inputId: "boom" }), /blew up/, "the retry of a failed turn runs again");
  assert.equal(holder.turns.length, 2);

  const slow = sessions.send(id, "slow", { inputId: "slow-1" });
  await assert.rejects(() => sessions.send(id, "other", { inputId: "other-1" }), /session busy/);
  release();
  await slow;
  await sessions.send(id, "other", { inputId: "other-1" });
  assert.deepEqual(holder.turns.slice(2), ["slow", "other"], "a send refused as busy was not swallowed by its own retry");
  await sessions.flush();
});
