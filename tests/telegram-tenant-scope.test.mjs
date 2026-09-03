// Guest tenancy end-to-end through the Telegram bridge:
//   1. A guest's message opens a session stamped surface "telegram" + a guest
//      tenant, and every session.send frame restates that tenant.
//   2. memoryScopeForTenant maps that wire tenant to `guest:<chatId>`; the
//      owner's frames map to the owner pool.
//   3. tenantForChat never resolves an unknown chat to the owner.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import {
  TelegramBridge,
  emptyRoster,
  upsertParticipant,
  seedOwners,
  tenantForChat,
} from "../packages/channels/dist/index.js";
import { memoryScopeForTenant } from "../packages/cli/dist/entry/turnPipeline.js";
import { OWNER_SCOPE } from "../packages/mind/dist/index.js";

class FakeTg {
  constructor() { this.sent = []; this.seq = 0; this.waiters = []; }
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
  async sendChatAction() {}
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
          ws.send(JSON.stringify({ type: "session.created", session: { id, surface: f.surface, tenant: f.tenant } }));
        }
      });
    });
  }
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

test("bridge: a guest's frames carry surface telegram + a guest tenant that scopes to guest:<chatId>", async () => {
  const roster = upsertParticipant(seedOwners(emptyRoster(), [42], "Noah"), { chatId: 99, name: "Sarah", role: "guest" });
  const gateway = new FakeGateway();
  await gateway.listen();
  const tg = new FakeTg();
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${gateway.port}`, token: "tok" },
    allowedChatIds: [42, 99],
    ownerChatIds: [42],
    initialRoster: roster,
    timers: fastTimers,
    pollTimeoutS: 1,
  });
  bridge.start();
  try {
    await waitFor(() => gateway.framesOf("hello").length === 1, "hello");

    tg.pushMessage(99, "can you help me plan a birthday party", { first_name: "Sarah" });
    const guestSend = await waitFor(() => gateway.framesOf("session.send").find((f) => f.text.includes("birthday")), "guest send");
    const guestCreate = gateway.framesOf("session.create").find((f) => f.tenant?.chatId === "99");
    assert.ok(guestCreate, "the guest's session.create is stamped with her tenant");
    assert.equal(guestCreate.surface, "telegram");
    assert.deepEqual(guestCreate.tenant, { role: "guest", chatId: "99" });
    assert.deepEqual(guestSend.tenant, { role: "guest", chatId: "99" }, "every send restates the tenant");
    assert.equal(memoryScopeForTenant(guestSend.tenant), "guest:99");

    // Her second message (same session) still carries the tenant.
    gateway.ws.send(JSON.stringify({ type: "event", sessionId: guestSend.sessionId, event: { type: "turn_end", status: "completed" } }));
    tg.pushMessage(99, "make it a surprise", { first_name: "Sarah" });
    const guestSend2 = await waitFor(() => gateway.framesOf("session.send").find((f) => f.text.includes("surprise")), "guest send 2");
    assert.deepEqual(guestSend2.tenant, { role: "guest", chatId: "99" });
    assert.equal(guestSend2.sessionId, guestSend.sessionId);

    // The owner resolves to the owner pool.
    tg.pushMessage(42, "what did sarah want", { first_name: "Noah" });
    const ownerSend = await waitFor(() => gateway.framesOf("session.send").find((f) => f.text.includes("sarah want")), "owner send");
    assert.deepEqual(ownerSend.tenant, { role: "owner" });
    assert.equal(memoryScopeForTenant(ownerSend.tenant), OWNER_SCOPE);
    const ownerCreate = gateway.framesOf("session.create").find((f) => f.tenant?.role === "owner");
    assert.ok(ownerCreate && ownerCreate.surface === "telegram");
    assert.notEqual(ownerSend.sessionId, guestSend.sessionId, "owner and guest never share a session");
  } finally {
    await bridge.stop();
    await gateway.close();
  }
});

test("tenantForChat: only roster owners are owners; unknown chats are guests keyed by id", () => {
  const roster = upsertParticipant(seedOwners(emptyRoster(), [42], "Noah"), { chatId: 99, name: "Sarah", role: "guest" });
  assert.deepEqual(tenantForChat(roster, 42), { role: "owner" });
  assert.deepEqual(tenantForChat(roster, 99), { role: "guest", chatId: "99" });
  assert.deepEqual(tenantForChat(roster, 7), { role: "guest", chatId: "7" }, "a stranger is never the owner");
  assert.equal(memoryScopeForTenant(tenantForChat(roster, 7)), "guest:7");
});
