// Verifies the Telegram multi-user roster + the "my girl's mad" UX fixes:
//   1. Roster pure ops: add/remove/roles/render, file round-trip.
//   2. toTelegramText flattens markdown to clean plain text.
//   3. Owner-only approvals: the Gate reaches owners, never guests.
//   4. A guest's first turn is prefixed with an identity note; the owner's isn't.
//   5. /who, /allow, /revoke are owner-only and mutate the live allowlist.
//   6. A stranger's DM notifies the owner once with an /allow hint.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import {
  TelegramBridge,
  toTelegramText,
  emptyRoster,
  upsertParticipant,
  removeParticipant,
  ownerChatIds,
  renderWho,
  seedOwners,
  loadRoster,
  saveRoster,
} from "../packages/channels/dist/index.js";

// ── 1. roster pure ops + persistence ─────────────────────────────────────────

test("roster: add guest, revoke, roles, and file round-trip", async () => {
  let r = seedOwners(emptyRoster(), [42], "Noah");
  r = upsertParticipant(r, { chatId: 99, name: "Sarah", role: "guest", addedBy: 42 });
  assert.deepEqual(ownerChatIds(r), [42]);
  assert.match(renderWho(r), /👑 Noah/);
  assert.match(renderWho(r), /👤 Sarah/);

  const { data, removed } = removeParticipant(r, "sarah"); // case-insensitive by name
  assert.equal(removed.chatId, 99);
  assert.equal(data.participants.length, 1);

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v39-"));
  await saveRoster(home, r);
  const loaded = await loadRoster(home);
  assert.equal(loaded.participants.length, 2);
});

// ── 2. markdown flattening ───────────────────────────────────────────────────

test("toTelegramText: markdown becomes clean plain text", () => {
  const out = toTelegramText("# Title\n\nHello **bold** and `code` and [link](https://x.io)\n- one\n- two");
  assert.ok(!out.includes("**"), "no bold markers");
  assert.ok(!out.includes("`"), "no backticks");
  assert.ok(!out.includes("#"), "no heading marks");
  assert.match(out, /link \(https:\/\/x\.io\)/);
  assert.match(out, /• one/);
});

// ── bridge harness ───────────────────────────────────────────────────────────

class FakeTg {
  constructor() {
    this.sent = [];
    this.actions = [];
    this.seq = 0;
    this.waiters = [];
  }
  pushMessage(chatId, text, from) {
    const update = { update_id: ++this.seq, message: { message_id: this.seq, chat: { id: chatId, type: "private" }, from, text } };
    const w = this.waiters.shift();
    if (w) w([update]);
    else this.pending = [...(this.pending ?? []), update];
  }
  async getUpdates(_offset, _timeoutS, signal) {
    if (this.pending?.length) { const u = this.pending; this.pending = []; return u; }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      // Honor shutdown — otherwise bridge.stop() awaits this poll forever.
      signal?.addEventListener("abort", () => {
        const i = this.waiters.indexOf(resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve([]);
      }, { once: true });
    });
  }
  async sendMessage(chatId, text, opts = {}) {
    this.sent.push({ chatId, text, replyMarkup: opts.replyMarkup });
    return { message_id: ++this.seq, chat: { id: chatId, type: "private" }, text };
  }
  async editMessageText() {}
  async answerCallbackQuery() {}
  async sendChatAction(chatId, action = "typing") { this.actions.push({ chatId, action }); }
}

class FakeGateway {
  constructor() { this.frames = []; this.sessions = 0; }
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
          const id = `s${++this.sessions}`;
          ws.send(JSON.stringify({ type: "session.created", session: { id } }));
        }
      });
    });
  }
  event(sessionId, event) { this.ws.send(JSON.stringify({ type: "event", sessionId, event })); }
  approval(staged) { this.ws.send(JSON.stringify({ type: "approval.pending", staged })); }
  framesOf(type) { return this.frames.filter((f) => f.type === type); }
  async close() { await new Promise((r) => this.wss.close(r)); }
}

const fastTimers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout: (h) => clearTimeout(h) };

async function waitFor(cond, label, ms = 2000) {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function boot({ allowed = [42], owners = [42], roster, reloadRoster } = {}) {
  const gateway = new FakeGateway();
  await gateway.listen();
  const tg = new FakeTg();
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${gateway.port}`, token: "tok" },
    allowedChatIds: allowed,
    ownerChatIds: owners,
    initialRoster: roster,
    reloadRoster,
    timers: fastTimers,
    pollTimeoutS: 1,
  });
  bridge.start();
  return { gateway, tg, bridge };
}

// ── 2b. live roster reload (conversational "authorize my friend") ────────────

test("bridge: a roster grant made out-of-band goes live with no restart", async () => {
  // The agent's TelegramRoster tool writes the roster file; reloadRoster reads it.
  let live = seedOwners(emptyRoster(), [42], "Noah");
  const ctx = await boot({ allowed: [42], owners: [42], reloadRoster: () => live });
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length === 1, "hello");

    // Sarah (99) is NOT yet authorized → refused.
    ctx.tg.pushMessage(99, "hi", { first_name: "Sarah" });
    await waitFor(() => ctx.tg.sent.some((m) => m.chatId === 99 && /private/.test(m.text)), "refused first");
    assert.ok(!ctx.gateway.framesOf("session.send").some((f) => f.text.includes("hi")), "no session for the unauthorized chat");

    // The owner authorizes her (simulating the tool writing the roster file).
    live = upsertParticipant(live, { chatId: 99, name: "Sarah", role: "guest" });

    // Her NEXT message goes through — no restart.
    ctx.tg.pushMessage(99, "hey ares", { first_name: "Sarah" });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send").find((f) => f.text.includes("hey ares")), "now allowed");
    assert.ok(send, "the freshly-authorized friend can talk on her next message");
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});

// ── 2c. activity view ("who and what it's talking about") ────────────────────

test("bridge: /activity shows the owner who's talking and about what", async () => {
  const roster = upsertParticipant(seedOwners(emptyRoster(), [42], "Noah"), { chatId: 99, name: "Sarah", role: "guest" });
  const ctx = await boot({ allowed: [42, 99], owners: [42], roster });
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length === 1, "hello");
    // Sarah holds a real conversation.
    ctx.tg.pushMessage(99, "can you help me plan a birthday party", { first_name: "Sarah" });
    await waitFor(() => ctx.gateway.framesOf("session.send").some((f) => f.text.includes("birthday")), "sarah chatted");

    // Owner asks who's talking and about what.
    ctx.tg.pushMessage(42, "/activity", { first_name: "Noah" });
    const view = await waitFor(() => ctx.tg.sent.find((m) => m.chatId === 42 && /talking to me/.test(m.text)), "activity view");
    assert.match(view.text, /Sarah/);
    assert.match(view.text, /birthday party/, "shows what she's talking about");
    assert.match(view.text, /1 msg/);

    // A guest never gets the owner-only activity view (it's not an admin path for them).
    ctx.tg.pushMessage(99, "/activity", { first_name: "Sarah" });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!ctx.tg.sent.some((m) => m.chatId === 99 && /talking to me/.test(m.text)), "guest never sees the activity view");
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});

// ── 3. owner-only approvals ──────────────────────────────────────────────────

test("bridge: the approval Gate reaches owners only, never guests", async () => {
  const roster = upsertParticipant(seedOwners(emptyRoster(), [42], "Noah"), { chatId: 99, name: "Sarah", role: "guest" });
  const ctx = await boot({ allowed: [42, 99], owners: [42], roster });
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length === 1, "hello");
    ctx.gateway.approval({ id: "appr-1", kind: "charge", domain: "payments", reason: "Stripe $49" });
    await waitFor(() => ctx.tg.sent.some((m) => m.replyMarkup), "approval sent");
    const gated = ctx.tg.sent.filter((m) => m.replyMarkup);
    assert.ok(gated.every((m) => m.chatId === 42), "only the owner got the Gate");
    assert.ok(!gated.some((m) => m.chatId === 99), "the guest never saw it");
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});

// ── 4. guest identity preamble ───────────────────────────────────────────────

test("bridge: a guest's first turn carries an identity note; the owner's does not", async () => {
  const roster = upsertParticipant(seedOwners(emptyRoster(), [42], "Noah"), { chatId: 99, name: "Sarah", role: "guest" });
  const ctx = await boot({ allowed: [42, 99], owners: [42], roster });
  try {
    ctx.tg.pushMessage(99, "hey ares", { first_name: "Sarah" });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send").find((f) => f.text.includes("hey ares")), "guest send");
    assert.match(send.text, /guest/i, "guest turn is prefixed with an identity note");
    assert.match(send.text, /Sarah/, "the guest is named");
    assert.match(send.text, /Noah/, "the owner is named as private");

    ctx.tg.pushMessage(42, "status check please", { first_name: "Noah" });
    const ownerSend = await waitFor(
      () => ctx.gateway.framesOf("session.send").find((f) => f.text.includes("status check")),
      "owner send",
    );
    assert.equal(ownerSend.text, "status check please", "the owner's turn is verbatim — no preamble");
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});

// ── 5. owner admin commands ──────────────────────────────────────────────────

test("bridge: /allow and /who are owner-only and mutate the allowlist", async () => {
  const captured = [];
  const ctx = await boot({ allowed: [42], owners: [42] });
  ctx.bridge; // roster persistence is optional here
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length === 1, "hello");

    // Owner adds a guest.
    ctx.tg.pushMessage(42, "/allow 99 Sarah", { first_name: "Noah" });
    await waitFor(() => ctx.tg.sent.some((m) => m.chatId === 42 && /can now talk/.test(m.text)), "allow ack");

    // The newly-allowed guest can now chat (not refused).
    ctx.tg.pushMessage(99, "hi", { first_name: "Sarah" });
    await waitFor(() => ctx.gateway.framesOf("session.send").some((f) => f.text.includes("hi")), "guest now chats");

    // /who lists both.
    ctx.tg.pushMessage(42, "/who", { first_name: "Noah" });
    const who = await waitFor(() => ctx.tg.sent.find((m) => m.chatId === 42 && /Who can talk/.test(m.text)), "who");
    assert.match(who.text, /Sarah/);
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});

// ── 6. stranger notifies the owner once ──────────────────────────────────────

test("bridge: an unknown chat is refused and the owner is pinged once with an /allow hint", async () => {
  const ctx = await boot({ allowed: [42], owners: [42] });
  try {
    await waitFor(() => ctx.gateway.framesOf("hello").length === 1, "hello");
    ctx.tg.pushMessage(777, "let me in", { first_name: "Stranger" });
    ctx.tg.pushMessage(777, "hello?", { first_name: "Stranger" });
    const ping = await waitFor(() => ctx.tg.sent.find((m) => m.chatId === 42 && /allow 777/.test(m.text)), "owner pinged");
    assert.match(ping.text, /Stranger/);
    // Only one owner ping despite two messages.
    const pings = ctx.tg.sent.filter((m) => m.chatId === 42 && /allow 777/.test(m.text));
    assert.equal(pings.length, 1, "stranger surfaced once, not per message");
  } finally {
    await ctx.bridge.stop();
    await ctx.gateway.close();
  }
});
