// Telegram "eyes and hands" batch — Ares on the phone, all day:
//   1. toTelegramHtml renders bold/code/pre/links and escapes the rest.
//   2. screenshotPathOf only trusts image paths on a tool result.
//   3. A photo the user sends becomes an image ATTACHMENT on session.send,
//      beside its caption — the model sees pixels. The first turn also carries
//      the "you're on Telegram" preamble.
//   4. An album (media_group_id) coalesces into ONE input with every photo.
//   5. A non-image document lands in <home>/telegram/inbox/<chat>/ and the
//      agent gets its path.
//   6. A tool_end carrying screenshotPath → the PNG is forwarded as a photo at
//      turn_end, once.
//   7. Replies go out as HTML; a rejected HTML send falls back to plain text.
//   8. A very long reply becomes a preview + .md document, not eight bubbles.
//   9. /new drops the chat's session; the next message creates a fresh one.
//  10. The Telegram tool: routes to the session's chat, else the owners; sends
//      a photo file's bytes; degrades cleanly when not connected.
//  11. Garrison: normalizeSessionAttachments enforces shape and budget;
//      inputContent yields text + image blocks.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import { TelegramBridge, toTelegramHtml, screenshotPathOf, seedOwners, emptyRoster } from "../packages/channels/dist/index.js";
import { TelegramTool, setTelegramChannel, resolveTelegramTargets } from "../packages/tools/dist/index.js";
import { normalizeSessionAttachments, inputContent } from "../packages/garrison/dist/index.js";

// ── 1. HTML rendering ────────────────────────────────────────────────────────

test("toTelegramHtml: bold, code, pre, links survive; angle brackets are escaped", () => {
  const html = toTelegramHtml("# Title\n**bold** and `x < y` here\n```js\nif (a > b) {}\n```\n[link](https://x.io)\n- one\n- two");
  assert.match(html, /<b>Title<\/b>/);
  assert.match(html, /<b>bold<\/b>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
  assert.match(html, /<pre>if \(a &gt; b\) \{\}<\/pre>/);
  assert.match(html, /<a href="https:\/\/x\.io">link<\/a>/);
  assert.match(html, /• one\n• two/);
  assert.ok(!html.includes("```"), "fences stripped");
  assert.ok(!html.includes("**"), "bold markers stripped");
});

// ── 2. screenshot path detection ─────────────────────────────────────────────

test("screenshotPathOf: image paths only", () => {
  assert.equal(screenshotPathOf({ screenshotPath: "C:\\shots\\a.png" }), "C:\\shots\\a.png");
  assert.equal(screenshotPathOf({ screenshotPath: "/tmp/x.txt" }), undefined);
  assert.equal(screenshotPathOf({ other: 1 }), undefined);
  assert.equal(screenshotPathOf("nope"), undefined);
});

// ── bridge harness ───────────────────────────────────────────────────────────

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

class FakeTg {
  constructor() {
    this.sent = [];
    this.photos = [];
    this.documents = [];
    this.files = new Map(); // file_id → { path, bytes }
    this.rejectHtml = false;
    this.seq = 0;
    this.waiters = [];
  }
  push(message) {
    const update = { update_id: ++this.seq, message: { message_id: this.seq, chat: { id: message.chatId, type: "private" }, ...message } };
    const w = this.waiters.shift();
    if (w) w([update]);
    else this.pending = [...(this.pending ?? []), update];
  }
  pushMessage(chatId, text, from) { this.push({ chatId, from, text }); }
  addFile(fileId, bytes) { this.files.set(fileId, { path: `files/${fileId}.bin`, bytes }); }
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
    if (opts.parseMode === "HTML" && this.rejectHtml) throw new Error("telegram sendMessage failed (400): can't parse entities");
    this.sent.push({ chatId, text, parseMode: opts.parseMode, replyMarkup: opts.replyMarkup });
    return { message_id: ++this.seq, chat: { id: chatId, type: "private" }, text };
  }
  async editMessageText() {}
  async answerCallbackQuery() {}
  async sendChatAction() {}
  async getFile(fileId) {
    const f = this.files.get(fileId);
    if (!f) throw new Error("file not found");
    return { file_id: fileId, file_path: f.path, file_size: f.bytes.byteLength };
  }
  async downloadFile(filePath) {
    for (const f of this.files.values()) if (f.path === filePath) return f.bytes;
    throw new Error("download failed");
  }
  async sendPhoto(chatId, image, opts = {}) {
    this.photos.push({ chatId, bytes: image, caption: opts.caption, filename: opts.filename });
    return { message_id: ++this.seq, chat: { id: chatId, type: "private" } };
  }
  async sendDocument(chatId, file, opts = {}) {
    this.documents.push({ chatId, bytes: file, caption: opts.caption, filename: opts.filename });
    return { message_id: ++this.seq, chat: { id: chatId, type: "private" } };
  }
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
  framesOf(type) { return this.frames.filter((f) => f.type === type); }
  async close() { await new Promise((r) => this.wss.close(r)); }
}

const fastTimers = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 20)), clearTimeout: (h) => clearTimeout(h) };

async function waitFor(cond, label, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function boot({ allowed = [42], owners = [42] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-tg-media-"));
  const gateway = new FakeGateway();
  await gateway.listen();
  const tg = new FakeTg();
  const bridge = new TelegramBridge({
    api: tg,
    gateway: { url: `ws://127.0.0.1:${gateway.port}`, token: "tok" },
    allowedChatIds: allowed,
    ownerChatIds: owners,
    initialRoster: seedOwners(emptyRoster(), owners, "Crix"),
    timers: fastTimers,
    pollTimeoutS: 1,
    home,
  });
  bridge.start();
  await waitFor(() => gateway.framesOf("hello").length === 1, "hello");
  const stop = async () => {
    await bridge.stop();
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  };
  return { gateway, tg, bridge, home, stop };
}

/** Drive one whole turn: the bridge sent session.send → gateway emits reply → turn_end. */
function reply(gateway, sessionId, text, extraEvents = []) {
  for (const e of extraEvents) gateway.event(sessionId, e);
  gateway.event(sessionId, { type: "text_delta", text });
  gateway.event(sessionId, { type: "turn_end", status: "ok" });
}

// ── 3. photo → attachment ────────────────────────────────────────────────────

test("bridge: a photo with a caption becomes an image attachment beside the text", async () => {
  const ctx = await boot();
  try {
    ctx.tg.addFile("ph1", PNG_1PX);
    ctx.tg.push({ chatId: 42, caption: "what is this?", photo: [{ file_id: "small", width: 10, height: 10 }, { file_id: "ph1", width: 100, height: 100 }] });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    assert.match(send.text, /what is this\?/);
    assert.match(send.text, /over Telegram on the user's phone/, "first turn carries the surface preamble");
    assert.match(send.text, /Telegram tool/);
    assert.equal(send.attachments.length, 1);
    assert.equal(send.attachments[0].kind, "image");
    assert.equal(send.attachments[0].mediaType, "image/jpeg");
    assert.equal(send.attachments[0].data, PNG_1PX.toString("base64"));

    // The second turn carries no preamble.
    reply(ctx.gateway, "s1", "It's a pixel.");
    await waitFor(() => ctx.tg.sent.length === 1, "reply");
    ctx.tg.pushMessage(42, "thanks");
    const second = await waitFor(() => ctx.gateway.framesOf("session.send")[1], "second send");
    assert.equal(second.text, "thanks");
    assert.equal(second.attachments, undefined);
  } finally {
    await ctx.stop();
  }
});

test("bridge: a photo without a caption still reaches the model with a hint", async () => {
  const ctx = await boot();
  try {
    ctx.tg.addFile("ph2", PNG_1PX);
    ctx.tg.push({ chatId: 42, photo: [{ file_id: "ph2", width: 100, height: 100 }] });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    assert.match(send.text, /sent this photo without a caption/);
    assert.equal(send.attachments.length, 1);
  } finally {
    await ctx.stop();
  }
});

// ── 4. albums coalesce ───────────────────────────────────────────────────────

test("bridge: an album of photos becomes ONE input with every image", async () => {
  const ctx = await boot();
  try {
    ctx.tg.addFile("a1", PNG_1PX);
    ctx.tg.addFile("a2", Buffer.concat([PNG_1PX, Buffer.from([0])]));
    ctx.tg.push({ chatId: 42, caption: "which one?", media_group_id: "g1", photo: [{ file_id: "a1", width: 1, height: 1 }] });
    ctx.tg.push({ chatId: 42, media_group_id: "g1", photo: [{ file_id: "a2", width: 1, height: 1 }] });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    assert.equal(send.attachments.length, 2, "both photos on one input");
    assert.match(send.text, /which one\?/);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(ctx.gateway.framesOf("session.send").length, 1, "no second turn for the second photo");
  } finally {
    await ctx.stop();
  }
});

// ── 5. documents → inbox ─────────────────────────────────────────────────────

test("bridge: a non-image document is saved to the inbox and its path handed to the agent", async () => {
  const ctx = await boot();
  try {
    ctx.tg.addFile("d1", Buffer.from("hello,world\n1,2\n"));
    ctx.tg.push({ chatId: 42, caption: "sum this", document: { file_id: "d1", file_name: "data.csv", mime_type: "text/csv" } });
    const send = await waitFor(() => ctx.gateway.framesOf("session.send")[0], "session.send");
    assert.match(send.text, /sum this/);
    assert.match(send.text, /The user sent a file: (.+data\.csv)/);
    const saved = /The user sent a file: (\S+data\.csv)/.exec(send.text)[1];
    assert.ok(saved.startsWith(path.join(ctx.home, "telegram", "inbox", "42")), `saved under the chat's inbox: ${saved}`);
    assert.equal(await fs.readFile(saved, "utf8"), "hello,world\n1,2\n");
    assert.equal(send.attachments, undefined, "a CSV is not an image block");
  } finally {
    await ctx.stop();
  }
});

// ── 6. screenshot forwarding ─────────────────────────────────────────────────

test("bridge: the turn's last screenshot is forwarded as a photo, once", async () => {
  const ctx = await boot();
  try {
    const shot = path.join(ctx.home, "shot-1.png");
    await fs.writeFile(shot, PNG_1PX);
    ctx.tg.pushMessage(42, "screenshot my desktop");
    await waitFor(() => ctx.gateway.framesOf("session.send")[0], "send");
    reply(ctx.gateway, "s1", "Here's your desktop.", [
      { type: "tool_start", id: "t1", name: "ComputerUse", activityDescription: "Taking a screenshot" },
      { type: "tool_end", id: "t1", output: { action: "screenshot", screenshotPath: path.join(ctx.home, "missing.png") }, durationMs: 1 },
      { type: "tool_end", id: "t2", output: { action: "screenshot", screenshotPath: shot }, durationMs: 1 },
    ]);
    await waitFor(() => ctx.tg.photos.length === 1 && ctx.tg.sent.length >= 1, "photo + text");
    assert.equal(ctx.tg.photos[0].chatId, 42);
    assert.deepEqual(ctx.tg.photos[0].bytes, PNG_1PX);
    assert.equal(ctx.tg.photos[0].filename, "shot-1.png");

    // Same path again on a later turn → not re-sent.
    ctx.tg.pushMessage(42, "again");
    await waitFor(() => ctx.gateway.framesOf("session.send")[1], "second send");
    reply(ctx.gateway, "s1", "Same as before.", [{ type: "tool_end", id: "t3", output: { screenshotPath: shot }, durationMs: 1 }]);
    await waitFor(() => ctx.tg.sent.length >= 2, "second text");
    assert.equal(ctx.tg.photos.length, 1, "duplicate screenshot not forwarded");
  } finally {
    await ctx.stop();
  }
});

// ── 7. HTML replies + fallback ───────────────────────────────────────────────

test("bridge: replies are HTML; a rejected HTML send falls back to plain text", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "hi");
    await waitFor(() => ctx.gateway.framesOf("session.send")[0], "send");
    reply(ctx.gateway, "s1", "**Done.** See `foo`.");
    const first = await waitFor(() => ctx.tg.sent[0], "html reply");
    assert.equal(first.parseMode, "HTML");
    assert.equal(first.text, "<b>Done.</b> See <code>foo</code>.");

    ctx.tg.rejectHtml = true;
    ctx.tg.pushMessage(42, "again");
    await waitFor(() => ctx.gateway.framesOf("session.send")[1], "send 2");
    reply(ctx.gateway, "s1", "**Still done.**");
    const second = await waitFor(() => ctx.tg.sent[1], "plain fallback");
    assert.equal(second.parseMode, undefined);
    assert.equal(second.text, "Still done.");
  } finally {
    await ctx.stop();
  }
});

// ── 8. long replies → document ───────────────────────────────────────────────

test("bridge: a very long reply becomes a preview plus a .md document", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "write the report");
    await waitFor(() => ctx.gateway.framesOf("session.send")[0], "send");
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of a long report that keeps going`).join("\n");
    reply(ctx.gateway, "s1", long);
    await waitFor(() => ctx.tg.documents.length === 1, "document");
    assert.equal(ctx.tg.sent.length, 1, "one preview bubble, not eight");
    assert.match(ctx.tg.sent[0].text, /full reply attached/);
    assert.ok(ctx.tg.sent[0].text.length <= 4000);
    assert.match(ctx.tg.documents[0].filename, /^ares-reply-.*\.md$/);
    assert.equal(ctx.tg.documents[0].bytes.toString("utf8"), long);
  } finally {
    await ctx.stop();
  }
});

// ── 9. /new ──────────────────────────────────────────────────────────────────

test("bridge: /new drops the session; the next message starts a fresh one", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "hello");
    await waitFor(() => ctx.gateway.framesOf("session.send")[0], "send");
    reply(ctx.gateway, "s1", "hey");
    await waitFor(() => ctx.tg.sent.length === 1, "reply");
    ctx.tg.pushMessage(42, "/new");
    await waitFor(() => ctx.tg.sent.some((m) => /Fresh thread/.test(m.text)), "ack");
    ctx.tg.pushMessage(42, "start over");
    await waitFor(() => ctx.gateway.framesOf("session.create").length === 2, "second session created");
    const send = await waitFor(() => ctx.gateway.framesOf("session.send").find((f) => f.sessionId === "s2"), "send on s2");
    assert.match(send.text, /over Telegram/, "fresh session gets the preamble again");
    assert.match(send.text, /start over/);
  } finally {
    await ctx.stop();
  }
});

// ── 9b. permission card: Always ──────────────────────────────────────────────

test("bridge: the permission card offers Always, which answers allow_always", async () => {
  const ctx = await boot();
  try {
    ctx.tg.pushMessage(42, "click through the listing");
    await waitFor(() => ctx.gateway.framesOf("session.send")[0], "send");
    ctx.gateway.event("s1", { type: "permission_request", id: "req-1", toolName: "ComputerUse", reason: "ComputerUse wants to perform an external-state action." });
    const card = await waitFor(() => ctx.tg.sent.find((m) => /Permission needed/.test(m.text)), "card");
    const buttons = card.replyMarkup.inline_keyboard[0].map((b) => b.text);
    assert.deepEqual(buttons, ["✅ Allow", "✅ Always", "🚫 Deny"]);
    assert.match(card.text, /Auto-denies in 5 min/);
    const always = card.replyMarkup.inline_keyboard[0][1].callback_data;
    // Tap Always.
    const w = ctx.tg.waiters.shift();
    const cq = { update_id: 999, callback_query: { id: "cq1", from: { id: 42 }, message: { message_id: 1, chat: { id: 42, type: "private" } }, data: always } };
    if (w) w([cq]); else ctx.tg.pending = [...(ctx.tg.pending ?? []), cq];
    const respond = await waitFor(() => ctx.gateway.framesOf("permission.respond")[0], "permission.respond");
    assert.equal(respond.decision, "allow_always");
    assert.equal(respond.sessionId, "s1");
    assert.equal(respond.requestId, "req-1");
  } finally {
    await ctx.stop();
  }
});

// ── 10. the Telegram tool ────────────────────────────────────────────────────

function toolCtx(sessionId, workspace) {
  return { workspace, sessionId, signal: new AbortController().signal, permissionMode: "bypass", fileReadStamps: new Map() };
}

class FakeChannel {
  constructor() { this.texts = []; this.photos = []; this.docs = []; }
  chatForSession(id) { return id === "tg-1" ? 42 : undefined; }
  ownerChats() { return [42, 43]; }
  async sendTextTo(chatId, text) { this.texts.push({ chatId, text }); }
  async sendPhotoTo(chatId, image, opts) { this.photos.push({ chatId, image, ...opts }); }
  async sendDocumentTo(chatId, file, opts) { this.docs.push({ chatId, file, ...opts }); }
}

test("Telegram tool: targets the session's chat, else every owner", () => {
  const ch = new FakeChannel();
  assert.deepEqual(resolveTelegramTargets(ch, "tg-1", undefined), [42]);
  assert.deepEqual(resolveTelegramTargets(ch, "desktop-9", undefined), [42, 43]);
  assert.deepEqual(resolveTelegramTargets(ch, "tg-1", "owner"), [42, 43]);
});

test("Telegram tool: sends a photo's bytes, a file, and a message; degrades when not connected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-tg-tool-"));
  try {
    setTelegramChannel(null);
    const off = await TelegramTool.call({ action: "message", text: "hi" }, toolCtx("tg-1", dir));
    assert.equal(off.output.ok, false);
    assert.match(off.output.note, /isn't connected/);

    const ch = new FakeChannel();
    setTelegramChannel(ch);
    await fs.writeFile(path.join(dir, "listing.png"), PNG_1PX);
    await fs.writeFile(path.join(dir, "report.txt"), "report body");

    const photo = await TelegramTool.call({ action: "photo", path: "listing.png", caption: "found it" }, toolCtx("tg-1", dir));
    assert.equal(photo.output.ok, true);
    assert.deepEqual(photo.output.chats, [42]);
    assert.deepEqual(ch.photos[0].image, PNG_1PX);
    assert.equal(ch.photos[0].caption, "found it");
    assert.equal(ch.photos[0].filename, "listing.png");

    const file = await TelegramTool.call({ action: "file", path: path.join(dir, "report.txt") }, toolCtx("desktop-9", dir));
    assert.equal(file.output.ok, true);
    assert.deepEqual(file.output.chats, [42, 43], "from the desktop it goes to the owners");
    assert.equal(ch.docs.length, 2);
    assert.equal(ch.docs[0].file.toString("utf8"), "report body");

    const msg = await TelegramTool.call({ action: "message", text: "heads up" }, toolCtx("tg-1", dir));
    assert.equal(msg.output.ok, true);
    assert.deepEqual(ch.texts, [{ chatId: 42, text: "heads up" }]);

    await assert.rejects(TelegramTool.call({ action: "photo", path: "report.txt" }, toolCtx("tg-1", dir)), /PNG, JPEG, WebP, or GIF/);
    await assert.rejects(TelegramTool.call({ action: "file", path: "nope.bin" }, toolCtx("tg-1", dir)), /No such file/);
  } finally {
    setTelegramChannel(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── 11. garrison attachment validation ───────────────────────────────────────

test("garrison: normalizeSessionAttachments enforces shape and budget; inputContent builds image blocks", () => {
  assert.deepEqual(normalizeSessionAttachments(undefined), []);
  assert.equal(typeof normalizeSessionAttachments("x"), "string");
  assert.equal(typeof normalizeSessionAttachments([{ kind: "video", mediaType: "image/png", data: "AAAA" }]), "string");
  assert.equal(typeof normalizeSessionAttachments([{ kind: "image", mediaType: "image/bmp", data: "AAAA" }]), "string");
  assert.equal(typeof normalizeSessionAttachments([{ kind: "image", mediaType: "image/png", data: "not base64!" }]), "string");
  assert.equal(typeof normalizeSessionAttachments([{ kind: "image", mediaType: "image/png", data: "A".repeat(2_000_001) }]), "string");
  assert.equal(typeof normalizeSessionAttachments(Array.from({ length: 9 }, () => ({ kind: "image", mediaType: "image/png", data: "AAAA" }))), "string");
  const ok = normalizeSessionAttachments([{ kind: "image", mediaType: "image/jpeg", data: "AAAA", extra: 1 }]);
  assert.deepEqual(ok, [{ kind: "image", mediaType: "image/jpeg", data: "AAAA" }]);
  assert.deepEqual(inputContent("look", ok), [
    { type: "text", text: "look" },
    { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "AAAA" } },
  ]);
  assert.deepEqual(inputContent("plain", undefined), [{ type: "text", text: "plain" }]);
});
