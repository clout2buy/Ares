// V10 — Telegram bridge as a pure gateway client. Fully mocked round-trip:
// a real ws server plays the Garrison gateway (wire protocol v1) and an
// in-memory fake plays the Telegram Bot API. No network beyond loopback.
// See docs/roadmap/NEXT-ARES.md (V10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import {
  TelegramApi,
  TelegramBridge,
  chunkMessage,
} from "../packages/channels/dist/index.js";

const GATEWAY_TOKEN = "0123456789abcdef0123456789abcdef";

async function waitFor(probe, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─── Fake Garrison gateway (wire protocol v1 over real ws) ───────────────

class FakeGateway {
  constructor() {
    this.frames = [];
    this.sockets = new Set();
    this.sessionSeq = 0;
    this.port = 0;
  }

  async listen(port = 0) {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
    });
    this.port = this.wss.address().port;
    this.wss.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        this.frames.push(frame);
        if (frame.type === "hello") {
          if (frame.token !== GATEWAY_TOKEN) {
            socket.send(JSON.stringify({ type: "error", message: "bad token" }));
            socket.close();
            return;
          }
          socket.send(JSON.stringify({ type: "welcome", sessions: [] }));
        } else if (frame.type === "session.create") {
          const id = `s${++this.sessionSeq}`;
          socket.send(
            JSON.stringify({
              type: "session.created",
              session: { id, title: "telegram", model: "m", provider: "p", busy: false },
            }),
          );
        }
      });
    });
  }

  sendToAll(frame) {
    const raw = JSON.stringify(frame);
    for (const socket of this.sockets) socket.send(raw);
  }

  sendEvent(sessionId, event) {
    this.sendToAll({ type: "event", sessionId, event });
  }

  framesOf(type) {
    return this.frames.filter((f) => f.type === type);
  }

  dropClients() {
    for (const socket of this.sockets) socket.terminate();
  }

  async close() {
    this.dropClients();
    await new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

// ─── Fake Telegram Bot API (in-memory queues) ────────────────────────────

class FakeTelegram {
  constructor() {
    this.updates = [];
    this.waiters = [];
    this.sent = []; // { chatId, text, replyMarkup }
    this.edits = []; // { chatId, messageId, text }
    this.answered = []; // { id, text }
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
      signal?.addEventListener(
        "abort",
        () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve([]);
        },
        { once: true },
      );
    });
  }

  async sendMessage(chatId, text, opts = {}) {
    this.sent.push({ chatId, text, replyMarkup: opts.replyMarkup });
    return { message_id: ++this.messageSeq, chat: { id: chatId, type: "private" }, text };
  }

  async editMessageText(chatId, messageId, text) {
    this.edits.push({ chatId, messageId, text });
  }

  async answerCallbackQuery(id, opts = {}) {
    this.answered.push({ id, text: opts.text });
  }
}

// Injectable timers: real scheduling, compressed durations (backoff/throttle
// become ~10ms so reconnect and flush tests run instantly).
const fastTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)),
  clearTimeout: (handle) => clearTimeout(handle),
};

async function boot(allowedChatIds = [42]) {
  const gateway = new FakeGateway();
  await gateway.listen();
  const tg = new FakeTelegram();
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${gateway.port}`, token: GATEWAY_TOKEN },
    allowedChatIds,
    timers: fastTimers,
    pollTimeoutS: 1,
  });
  bridge.start();
  return { gateway, tg, bridge };
}

async function shutdown(ctx) {
  await ctx.bridge.stop();
  await ctx.gateway.close();
}

// ─── Tests ───────────────────────────────────────────────────────────────

test("inbound Telegram text becomes session.send on a freshly created session", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "hello ares");
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send frame");
    assert.equal(send.sessionId, "s1");
    assert.equal(send.text, "hello ares");
    assert.equal(ctx.gateway.framesOf("session.create").length, 1);

    const hello = ctx.gateway.framesOf("hello")[0];
    assert.equal(hello.proto, 1);
    assert.equal(hello.token, GATEWAY_TOKEN);
    assert.equal(hello.client, "telegram");
  } finally {
    await shutdown(ctx);
  }
});

test("text deltas accumulate and flush as one message on turn_end", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "ping");
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    ctx.gateway.sendEvent(send.sessionId, { type: "text_delta", text: "Hello " });
    ctx.gateway.sendEvent(send.sessionId, { type: "text_delta", text: "from the " });
    ctx.gateway.sendEvent(send.sessionId, { type: "text_delta", text: "Garrison." });
    ctx.gateway.sendEvent(send.sessionId, {
      type: "turn_end",
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 3 },
      durationMs: 7,
    });
    await waitFor(() => ctx.tg.sent.length >= 1, "telegram sendMessage");
    assert.equal(ctx.tg.sent.length, 1);
    assert.equal(ctx.tg.sent[0].chatId, 42);
    assert.equal(ctx.tg.sent[0].text, "Hello from the Garrison.");
  } finally {
    await shutdown(ctx);
  }
});

test("a turn longer than 4000 chars is chunked across messages", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "long one please");
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    const big = "x".repeat(4100);
    ctx.gateway.sendEvent(send.sessionId, { type: "text_delta", text: big });
    ctx.gateway.sendEvent(send.sessionId, {
      type: "turn_end",
      status: "completed",
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 5,
    });
    await waitFor(() => ctx.tg.sent.length >= 2, "two chunks");
    assert.equal(ctx.tg.sent.length, 2);
    assert.equal(ctx.tg.sent[0].text.length, 4000);
    assert.equal(ctx.tg.sent[1].text.length, 100);
    assert.equal(ctx.tg.sent[0].text + ctx.tg.sent[1].text, big);
  } finally {
    await shutdown(ctx);
  }
});

test("chunkMessage hard-caps pathological outputs with a truncation marker", () => {
  const text = "y".repeat(4000 * 9);
  const chunks = chunkMessage(text);
  assert.equal(chunks.length, 8);
  assert.ok(chunks[7].endsWith("…[truncated]"));
  for (const chunk of chunks) assert.ok(chunk.length <= 4000);
});

test("tool_start frames render one status message with throttled edits", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "work");
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    const sid = send.sessionId;
    ctx.gateway.sendEvent(sid, { type: "tool_start", id: "t1", name: "Bash", input: {}, activityDescription: "Running tests" });
    ctx.gateway.sendEvent(sid, { type: "tool_start", id: "t2", name: "Read", input: {}, activityDescription: "Reading config" });
    ctx.gateway.sendEvent(sid, { type: "tool_start", id: "t3", name: "Edit", input: {}, activityDescription: "Patching bridge" });

    await waitFor(() => ctx.tg.sent.length >= 1, "status message");
    assert.equal(ctx.tg.sent[0].text, "⚙ Running tests");
    // Later activities coalesce into throttled edits carrying the latest text.
    await waitFor(() => ctx.tg.edits.find((e) => e.text === "⚙ Patching bridge"), "final status edit");
    assert.ok(ctx.tg.edits.length <= 2, "edits are throttled, not one per tool_start");
    assert.equal(ctx.tg.sent.length, 1, "only one status message is ever created");
  } finally {
    await shutdown(ctx);
  }
});

test("approval.pending renders an inline keyboard; taps answer + respond", async () => {
  const ctx = await boot();
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length >= 1, "bridge hello");
    ctx.gateway.sendToAll({
      type: "approval.pending",
      staged: { id: "ap1", kind: "git.push", domain: "git", reason: "push 3 commits to origin/main" },
    });
    const card = await waitFor(() => ctx.tg.sent.find((m) => m.replyMarkup), "approval card");
    assert.equal(card.chatId, 42);
    assert.match(card.text, /push 3 commits/);
    const row = card.replyMarkup.inline_keyboard[0];
    assert.deepEqual(row.map((b) => b.text), ["Approve", "Deny"]);
    assert.equal(row[0].callback_data, "ares:approve:ap1");
    assert.equal(row[1].callback_data, "ares:deny:ap1");

    ctx.tg.pushCallback(42, "ares:approve:ap1");
    const approve = await waitFor(() => ctx.gateway.framesOf("approval.respond")[0], "approval.respond");
    assert.equal(approve.approvalId, "ap1");
    assert.equal(approve.verb, "allow_once");
    await waitFor(() => ctx.tg.answered.length >= 1, "answerCallbackQuery");

    ctx.tg.pushCallback(42, "ares:deny:ap1");
    await waitFor(() => ctx.gateway.framesOf("approval.respond").length >= 2, "second respond");
    assert.equal(ctx.gateway.framesOf("approval.respond")[1].verb, "deny");
  } finally {
    await shutdown(ctx);
  }
});

test("a chat off the allowlist is refused once, then ignored", async () => {
  const ctx = await boot([42]);
  try {
    ctx.tg.pushMessage(777, "let me in");
    await waitFor(() => ctx.tg.sent.length >= 1, "refusal message");
    assert.equal(ctx.tg.sent[0].chatId, 777);
    assert.match(ctx.tg.sent[0].text, /private|allowlist/i);

    ctx.tg.pushMessage(777, "hello again");
    ctx.tg.pushMessage(42, "real work");
    await waitFor(() => ctx.gateway.framesOf("session.send").length >= 1, "allowed chat session.send");

    assert.equal(ctx.tg.sent.filter((m) => m.chatId === 777).length, 1, "refused exactly once");
    assert.equal(ctx.gateway.framesOf("session.create").length, 1, "no session for the stranger");
  } finally {
    await shutdown(ctx);
  }
});

test("gateway drop → backoff reconnect → fresh session continues the chat", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "first");
    const first = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "first session.send");
    assert.equal(first.sessionId, "s1");

    ctx.gateway.dropClients();
    await waitFor(() => ctx.gateway.framesOf("hello").length >= 2, "re-hello after drop");

    ctx.tg.pushMessage(42, "second");
    const second = await waitFor(
      () => ctx.gateway.framesOf("session.send").find((f) => f.text === "second"),
      "session.send after reconnect",
    );
    assert.equal(second.sessionId, "s2", "session is recreated, not the dead one");
  } finally {
    await shutdown(ctx);
  }
});

// ─── TelegramApi unit surface (no bridge, no socket) ─────────────────────

test("TelegramApi honors 429 retry_after with an injectable sleep", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } } },
    { status: 200, body: { ok: true, result: { message_id: 7, chat: { id: 1, type: "private" }, text: "hi" } } },
  ];
  const api = new TelegramApi("secret-bot-token-xyz", {
    baseUrl: "https://tg.test",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      const next = responses.shift();
      return { status: next.status, json: async () => next.body };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  const msg = await api.sendMessage(1, "hi");
  assert.equal(msg.message_id, 7);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith("https://tg.test/botsecret-bot-token-xyz/sendMessage"));
  assert.equal(calls[0].body.chat_id, 1);
});

test("TelegramApi surfaces Bot API errors without leaking the token", async () => {
  const api = new TelegramApi("secret-bot-token-xyz", {
    baseUrl: "https://tg.test",
    fetchImpl: async () => ({
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: "Bad Request: chat not found" }),
    }),
  });
  await assert.rejects(
    () => api.sendMessage(123, "x"),
    (err) => {
      assert.equal(err.name, "TelegramApiError");
      assert.equal(err.code, 400);
      assert.match(err.message, /chat not found/);
      assert.ok(!err.message.includes("secret-bot-token-xyz"));
      return true;
    },
  );
});
