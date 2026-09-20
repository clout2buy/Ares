// v54 — the Telegram surface stops behaving like a firehose.
//
//   1. fitMarkdown / splitPoint cut on a boundary, measured on the RENDERED
//      text (rendering is not length-preserving).
//   2. A reply streams into ONE message that is edited in place — a tool call
//      mid-turn no longer splits the answer into a new bubble per paragraph.
//   3. The activity card carries every step with durations, and failures.
//   4. Permission prompts: show the actual input, collapse duplicates onto one
//      question, go to the owner in the conversation (not every owner), and
//      close out into a record with no live buttons once answered.
//   5. A tool that trips over an unconnected service gets a sign-in card in
//      the thread, once, with a real url button on the authorize step.
//   6. Steering: a message typed mid-turn goes INTO the live turn; /stop
//      interrupts it.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import {
  TelegramBridge,
  fitMarkdown,
  splitPoint,
  describePermissionInput,
  permissionKey,
  oauthProviderFromError,
  renderActivityCard,
  renderActivitySummary,
  formatDuration,
  newActivityCard,
  emptyRoster,
  seedOwners,
  upsertParticipant,
} from "../packages/channels/dist/index.js";

// ── 1. pure helpers ──────────────────────────────────────────────────────────

test("splitPoint prefers a paragraph break, then a line, then a word", () => {
  assert.equal(splitPoint("aaaaaa\n\nbbbb"), 8);
  assert.equal(splitPoint("aaaaaa\nbbbb"), 7);
  assert.equal(splitPoint("aaaaaa bbbb"), 7);
  // No boundary past the halfway mark → take the whole slice rather than
  // leaving a nearly-empty bubble.
  assert.equal(splitPoint("a bbbbbbbbbb"), 12);
});

test("fitMarkdown measures the rendered length, not the source length", () => {
  const md = "**bold** ".repeat(50); // renders ~4 chars shorter per repeat
  const fitted = fitMarkdown(md, 100);
  const rendered = fitted.replace(/\*\*/g, "");
  assert.ok(rendered.length <= 100, `rendered ${rendered.length}`);
  // A naive source-length cut would have stopped far earlier than this.
  assert.ok(fitted.length > 100, "markers don't count against the budget");
  assert.equal(fitMarkdown("short", 100), "short", "text that fits is untouched");
});

test("describePermissionInput surfaces the thing you're actually approving", () => {
  assert.equal(describePermissionInput({ command: "rm -rf /tmp/x", description: "clean" }), "rm -rf /tmp/x");
  assert.equal(describePermissionInput({ file_path: "/etc/hosts" }), "/etc/hosts");
  assert.equal(describePermissionInput({ url: "https://pay.example/checkout" }), "https://pay.example/checkout");
  assert.equal(describePermissionInput({ unrecognized: 1 }), undefined);
  assert.equal(describePermissionInput({ command: "x".repeat(400) }).length, 180);
});

test("permissionKey ignores key order, so one question stays one question", () => {
  assert.equal(
    permissionKey("s1", "Bash", { command: "ls", timeout: 5 }),
    permissionKey("s1", "Bash", { timeout: 5, command: "ls" }),
  );
  assert.notEqual(permissionKey("s1", "Bash", { command: "ls" }), permissionKey("s1", "Bash", { command: "rm" }));
  assert.notEqual(permissionKey("s1", "Bash", { command: "ls" }), permissionKey("s2", "Bash", { command: "ls" }));
});

test("oauthProviderFromError recognizes both unconnected and expired", () => {
  assert.deepEqual(
    oauthProviderFromError("OAUTH_NOT_AUTHORIZED: google is not connected. The owner must authorize it once"),
    { provider: "google", expired: false },
  );
  assert.deepEqual(oauthProviderFromError("OAUTH_EXPIRED: spotify access token expired"), {
    provider: "spotify",
    expired: true,
  });
  assert.equal(oauthProviderFromError("ENOENT: no such file"), undefined);
  assert.equal(oauthProviderFromError(undefined), undefined);
});

test("the activity card renders steps and collapses to a receipt", () => {
  const card = newActivityCard(1_000);
  card.steps.push({ id: "a", label: "Reading bridge.ts", startedAt: 1_000, endedAt: 1_200, state: "ok" });
  card.steps.push({ id: "b", label: "Running tests", startedAt: 1_200, state: "running" });
  const live = renderActivityCard(card, 5_000);
  assert.match(live, /^🜂 Working · 4s\n/);
  assert.match(live, /✓ Reading bridge\.ts · 0\.2s/);
  assert.match(live, /⚙ Running tests… 4s/, "a slow step shows a clock");

  card.steering = true;
  assert.match(renderActivityCard(card, 5_000), /^↪ Steering/);

  card.steps[1].state = "failed";
  card.steps[1].endedAt = 6_000;
  card.steps[1].detail = "2 type errors";
  const receipt = renderActivitySummary(card, 6_000);
  assert.match(receipt, /⚠ 2 steps · 5s · 1 failed/);
  assert.match(receipt, /✗ Running tests — 2 type errors/);

  card.steps[1].state = "ok";
  assert.equal(renderActivitySummary(card, 6_000), "✓ 2 steps · 5s");
});

test("formatDuration stays short at every scale", () => {
  assert.equal(formatDuration(120), "0.1s");
  assert.equal(formatDuration(4_400), "4s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(120_000), "2m");
});

// ── harness ──────────────────────────────────────────────────────────────────

class FakeTg {
  constructor() {
    this.updates = [];
    this.waiters = [];
    this.sent = [];
    this.edits = [];
    this.answered = [];
    this.updateSeq = 0;
    this.messageSeq = 100;
  }
  pushMessage(chatId, text) {
    this.#push({
      update_id: ++this.updateSeq,
      message: { message_id: ++this.messageSeq, chat: { id: chatId, type: "private" }, text },
    });
  }
  pushCallback(chatId, data) {
    this.#push({
      update_id: ++this.updateSeq,
      callback_query: {
        id: `cb-${this.updateSeq}`,
        from: { id: chatId },
        message: { message_id: 1, chat: { id: chatId, type: "private" } },
        data,
      },
    });
  }
  #push(update) {
    this.updates.push(update);
    const waiter = this.waiters.shift();
    if (waiter) waiter(this.updates.splice(0));
  }
  async getUpdates(_offset, _timeoutS, signal) {
    if (this.updates.length > 0) return this.updates.splice(0);
    if (signal?.aborted) return [];
    return new Promise((resolve) => {
      const waiter = (batch) => resolve(batch);
      this.waiters.push(waiter);
      signal?.addEventListener("abort", () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve([]);
      }, { once: true });
    });
  }
  async sendMessage(chatId, text, opts = {}) {
    const messageId = ++this.messageSeq;
    this.sent.push({ chatId, messageId, text, parseMode: opts.parseMode, replyMarkup: opts.replyMarkup });
    return { message_id: messageId, chat: { id: chatId, type: "private" }, text };
  }
  async editMessageText(chatId, messageId, text, opts = {}) {
    this.edits.push({ chatId, messageId, text, replyMarkup: opts.replyMarkup, parseMode: opts.parseMode });
  }
  async answerCallbackQuery(id, opts = {}) {
    this.answered.push({ id, text: opts.text });
  }
  async sendChatAction() {}
  /** Everything sent to a chat that isn't the activity card or a prompt. */
  repliesTo(chatId) {
    return this.sent.filter((m) => m.chatId === chatId && !/^[🜂✓⚠🛡🔗]/.test(m.text));
  }
}

class FakeGateway {
  constructor() {
    this.frames = [];
    this.sessions = 0;
  }
  async listen() {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => this.wss.on("listening", r));
    this.port = this.wss.address().port;
    this.wss.on("connection", (ws) => {
      this.ws = ws;
      ws.send(JSON.stringify({ type: "welcome" }));
      ws.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        this.frames.push(f);
        if (f.type === "session.create") {
          ws.send(JSON.stringify({ type: "session.created", session: { id: `s${++this.sessions}` } }));
        }
      });
    });
  }
  event(sessionId, event) {
    this.ws.send(JSON.stringify({ type: "event", sessionId, event }));
  }
  framesOf(type) {
    return this.frames.filter((f) => f.type === type);
  }
  async close() {
    await new Promise((r) => this.wss.close(r));
  }
}

const fastTimers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout: (h) => clearTimeout(h) };

async function waitFor(cond, label, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let the outbound send-chain drain so assertions see a settled chat. */
async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

async function boot({ owners = [42], allowed = [42], connectDeps } = {}) {
  const gateway = new FakeGateway();
  await gateway.listen();
  const tg = new FakeTg();
  let roster = seedOwners(emptyRoster(), owners, "Crix");
  for (const id of allowed) if (!owners.includes(id)) roster = upsertParticipant(roster, { chatId: id, name: `chat ${id}`, role: "guest" });
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${gateway.port}`, token: "tok" },
    allowedChatIds: allowed,
    ownerChatIds: owners,
    initialRoster: roster,
    timers: fastTimers,
    pollTimeoutS: 1,
    connectDeps,
  });
  bridge.start();
  await waitFor(() => gateway.framesOf("hello").length === 1, "hello");
  return {
    gateway,
    tg,
    bridge,
    stop: async () => {
      await bridge.stop();
      await gateway.close();
    },
  };
}

/** Drive a chat to the point where a turn is in flight; returns the sessionId. */
async function startTurn(ctx, chatId = 42, text = "do the thing") {
  ctx.tg.pushMessage(chatId, text);
  const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
  return send.sessionId;
}

// ── 2. streaming into one bubble ─────────────────────────────────────────────

test("a reply streams into ONE message, edited in place, across tool calls", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx);
    // Enough text to pass the flush floor, then a tool call, then more text.
    ctx.gateway.event(sid, {
      type: "text_delta",
      text: "Let me take a look at the bridge and see exactly what is going on with the streaming here.\n\n",
    });
    await waitFor(() => ctx.tg.repliesTo(42).length === 1, "first bubble");
    const bubble = ctx.tg.repliesTo(42)[0];

    ctx.gateway.event(sid, { type: "tool_start", id: "t1", name: "Read", input: {}, activityDescription: "Reading bridge.ts" });
    ctx.gateway.event(sid, { type: "tool_end", id: "t1", output: {}, durationMs: 40 });
    ctx.gateway.event(sid, { type: "text_delta", text: "Found it — the flush timer was opening a new message every three seconds." });
    ctx.gateway.event(sid, { type: "turn_end", status: "ok" });

    const finalEdit = await waitFor(
      () => ctx.tg.edits.filter((e) => /Found it/.test(e.text)).pop(),
      "final edit carrying the whole reply",
    );
    await settle();
    // A tool call mid-reply used to force a flush and a SECOND bubble.
    assert.equal(ctx.tg.repliesTo(42).length, 1, "still exactly one reply message");
    assert.equal(finalEdit.messageId, bubble.messageId, "it edited the bubble it already sent");
    assert.match(finalEdit.text, /Let me take a look/, "the bubble keeps everything said so far");
    assert.match(finalEdit.text, /Found it/);
  } finally {
    await ctx.stop();
  }
});

test("a short reply is one message and never an edit storm", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx);
    ctx.gateway.event(sid, { type: "text_delta", text: "Done." });
    ctx.gateway.event(sid, { type: "turn_end", status: "ok" });
    await waitFor(() => ctx.tg.repliesTo(42).length === 1, "the reply");
    await settle();
    assert.equal(ctx.tg.repliesTo(42)[0].text, "Done.");
    assert.equal(ctx.tg.edits.length, 0, "nothing to edit — it fit the first send");
  } finally {
    await ctx.stop();
  }
});

// ── 4. permission prompts ────────────────────────────────────────────────────

test("a permission prompt shows the real input and closes out when answered", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx);
    ctx.gateway.event(sid, {
      type: "permission_request",
      id: "r1",
      toolName: "Bash",
      input: { command: "pnpm publish", description: "publish" },
      reason: "publishing is irreversible",
    });
    const prompt = await waitFor(() => ctx.tg.sent.find((m) => m.replyMarkup && /Permission needed/.test(m.text)), "prompt");
    assert.match(prompt.text, /↳ pnpm publish/, "you can see WHAT you're approving");
    assert.match(prompt.text, /publishing is irreversible/);
    const buttons = prompt.replyMarkup.inline_keyboard[0].map((b) => b.callback_data);
    assert.deepEqual(buttons.map((d) => d.split(":")[2]), ["allow", "always", "deny"]);

    ctx.tg.pushCallback(42, buttons[0]);
    const respond = await waitFor(() => ctx.gateway.framesOf("permission.respond")[0], "respond");
    assert.equal(respond.requestId, "r1");
    assert.equal(respond.decision, "allow_once");

    // The message stops being a live button and becomes a record.
    const closed = await waitFor(() => ctx.tg.edits.find((e) => /^✅ Allowed · Bash/.test(e.text)), "closed prompt");
    assert.match(closed.text, /↳ pnpm publish/);
    assert.equal(closed.replyMarkup, undefined, "buttons are gone");
  } finally {
    await ctx.stop();
  }
});

test("identical permission requests collapse onto one prompt, answered once", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx);
    const ask = (id) => ctx.gateway.event(sid, {
      type: "permission_request",
      id,
      toolName: "ComputerUse",
      input: { action: "click", x: 10, y: 20 },
      reason: "drives the real machine",
    });
    ask("r1");
    await waitFor(() => ctx.tg.sent.filter((m) => /Permission needed/.test(m.text)).length === 1, "first prompt");
    ask("r2");
    ask("r3");
    await settle();
    assert.equal(
      ctx.tg.sent.filter((m) => /Permission needed/.test(m.text)).length,
      1,
      "a retrying tool does not paper the chat",
    );

    const token = ctx.tg.sent.find((m) => m.replyMarkup).replyMarkup.inline_keyboard[0][1].callback_data;
    ctx.tg.pushCallback(42, token); // "Always"
    await waitFor(() => ctx.gateway.framesOf("permission.respond").length === 3, "every collapsed request answered");
    const decisions = ctx.gateway.framesOf("permission.respond");
    assert.deepEqual(decisions.map((d) => d.requestId), ["r1", "r2", "r3"]);
    assert.ok(decisions.every((d) => d.decision === "allow_always"));
  } finally {
    await ctx.stop();
  }
});

test("a prompt goes to the owner in the conversation, not to every owner", async () => {
  const ctx = await boot({ owners: [42, 99], allowed: [42, 99] });
  try {
    const sid = await startTurn(ctx, 42);
    ctx.gateway.event(sid, { type: "permission_request", id: "r1", toolName: "Deploy", input: { provider: "vercel" }, reason: "ship it" });
    await waitFor(() => ctx.tg.sent.some((m) => /Permission needed/.test(m.text)), "prompt");
    await settle();
    const prompts = ctx.tg.sent.filter((m) => /Permission needed/.test(m.text));
    assert.equal(prompts.length, 1, "one owner, one prompt — not one copy per owner chat");
    assert.equal(prompts[0].chatId, 42);
  } finally {
    await ctx.stop();
  }
});

// ── 5. connectors at the point of need ───────────────────────────────────────

function fakeConnectDeps() {
  return {
    providers: { google: { provider: "google", authorizeUrl: "https://accounts.google/x", tokenUrl: "https://t", scopes: [] } },
    providerLabels: { google: "Google (Calendar, Gmail, Contacts)" },
    connectedProviders: async () => ({ google: false }),
    startOAuthFlow: async ({ onAuthorizeUrl, onSuccess }) => {
      await onAuthorizeUrl?.("https://accounts.google/consent?state=abc");
      await onSuccess?.({ accessToken: "tok" });
      return { accessToken: "tok" };
    },
  };
}

test("a tool failing on an unconnected service offers the sign-in, once", async () => {
  const ctx = await boot({ connectDeps: fakeConnectDeps() });
  try {
    const sid = await startTurn(ctx, 42, "what's on my calendar");
    const fail = (id) => ctx.gateway.event(ctx.sid ?? sid, {
      type: "tool_error",
      id,
      error: "OAUTH_NOT_AUTHORIZED: google is not connected. The owner must authorize it once",
      durationMs: 3,
    });
    fail("t1");
    const offer = await waitFor(() => ctx.tg.sent.find((m) => /isn't connected yet/.test(m.text)), "connect offer");
    assert.match(offer.text, /Google/);
    assert.equal(offer.replyMarkup.inline_keyboard[0][0].callback_data, "ares:connect:google");

    // A retry loop must not turn the offer into its own spam.
    fail("t2");
    fail("t3");
    await settle();
    assert.equal(ctx.tg.sent.filter((m) => /isn't connected yet/.test(m.text)).length, 1);

    // Tapping it starts the flow and the authorize step is a REAL url button.
    ctx.tg.pushCallback(42, "ares:connect:google");
    const authorize = await waitFor(() => ctx.tg.sent.find((m) => m.replyMarkup?.inline_keyboard[0][0].url), "authorize button");
    assert.equal(authorize.replyMarkup.inline_keyboard[0][0].url, "https://accounts.google/consent?state=abc");
    assert.match(authorize.replyMarkup.inline_keyboard[0][0].text, /Sign in with Google/);
  } finally {
    await ctx.stop();
  }
});

// ── 6. steering ──────────────────────────────────────────────────────────────

test("a message typed mid-turn steers the live turn instead of queueing", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx, 42, "refactor the bridge");
    ctx.gateway.event(sid, { type: "tool_start", id: "t1", name: "Edit", input: {}, activityDescription: "Editing bridge.ts" });

    ctx.tg.pushMessage(42, "wait — not that file");
    const steer = await waitFor(() => ctx.gateway.framesOf("session.send")[1], "steering send");
    assert.equal(steer.delivery, "steer", "it goes INTO the running turn");
    assert.equal(steer.sessionId, sid);
    assert.match(steer.text, /not that file/);

    // The card says so, so you know the correction landed.
    ctx.gateway.event(sid, { type: "steer_routed", inputId: "i1", disposition: "provider_preempting" });
    await waitFor(() => ctx.tg.edits.find((e) => /^↪ Steering/.test(e.text)), "steering shown on the card");
  } finally {
    await ctx.stop();
  }
});

test("a message sent while idle still queues as a normal turn", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx, 42, "first");
    ctx.gateway.event(sid, { type: "text_delta", text: "Done." });
    ctx.gateway.event(sid, { type: "turn_end", status: "ok" });
    // The reply landing proves the bridge has processed turn_end.
    await waitFor(() => ctx.tg.repliesTo(42).length === 1, "turn settled");
    ctx.tg.pushMessage(42, "second");
    const next = await waitFor(() => ctx.gateway.framesOf("session.send")[1], "second turn");
    assert.equal(next.delivery, undefined, "no live turn to steer — this is a new one");
  } finally {
    await ctx.stop();
  }
});

test("/stop interrupts the running turn; idle /stop says so", async () => {
  const ctx = await boot();
  try {
    const sid = await startTurn(ctx, 42, "run the long thing");
    ctx.tg.pushMessage(42, "/stop");
    const interrupt = await waitFor(() => ctx.gateway.framesOf("session.interrupt")[0], "interrupt");
    assert.equal(interrupt.sessionId, sid);
    await waitFor(() => ctx.tg.sent.find((m) => /⏹ Stopping/.test(m.text)), "ack");
    // It must not also be sent to the model as a message.
    assert.equal(ctx.gateway.framesOf("session.send").length, 1);
  } finally {
    await ctx.stop();
  }
});
