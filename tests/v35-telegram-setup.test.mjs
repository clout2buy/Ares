// Verifies conversational Telegram setup: token verification, chat-id discovery
// from /start, encrypted-at-rest config, and the TelegramSetup tool's
// verify→link→save flow — with the token never echoed and never plaintext on disk.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { verifyTelegramToken, discoverChatFromUpdates } from "../packages/channels/dist/index.js";
import { loadTelegramConfig, saveTelegramConfig, clearTelegramConfig, telegramConfigured } from "../packages/cli/dist/telegramConfig.js";
import { makeTelegramSetupTool } from "../packages/cli/dist/telegramSetupTool.js";

async function freshHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v35-"));
  process.env.ARES_HOME = home;
  // env overrides would mask the vault — make sure none leak in from the runner.
  for (const k of ["ARES_TELEGRAM", "ARES_TELEGRAM_BOT_TOKEN", "ARES_TELEGRAM_ALLOWED_CHATS", "ARES_TELEGRAM_CHAT_ID"]) delete process.env[k];
  return home;
}

const fakeApi = ({ me = { id: 9, is_bot: true, username: "AresTestBot" }, meThrows = false, updates = [], sent = [] } = {}) => ({
  async getMe() { if (meThrows) throw new Error("Unauthorized: bad token"); return me; },
  async getUpdates() { return updates; },
  async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
});

const ctx = { workspace: ".", signal: new AbortController().signal, permissionMode: "workspace-write" };

// ── Token verification ────────────────────────────────────────────────────────

test("verifyTelegramToken: a real bot token passes, a bad one fails (no throw)", async () => {
  assert.deepEqual(await verifyTelegramToken(fakeApi()), { ok: true, username: "AresTestBot" });
  const bad = await verifyTelegramToken(fakeApi({ meThrows: true }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unauthorized/);
});

// ── Chat discovery from /start ────────────────────────────────────────────────

test("discoverChatFromUpdates: picks the private /start, ignores groups", () => {
  const found = discoverChatFromUpdates([
    { update_id: 1, message: { chat: { id: -100, type: "group" }, text: "/start" } },
    { update_id: 2, message: { chat: { id: 4242, type: "private" }, text: "/start", from: { username: "noah" } } },
  ]);
  assert.equal(found.chatId, 4242, "the private chat, never the group");
  assert.equal(found.name, "noah");
  assert.equal(discoverChatFromUpdates([]), null, "no updates → null");
  assert.equal(discoverChatFromUpdates([{ update_id: 1, message: { chat: { id: -5, type: "supergroup" }, text: "/start" } }]), null, "only a group → null");
});

// ── Config round-trip + encryption at rest ────────────────────────────────────

test("config: save/load/clear round-trips; token is ENCRYPTED on disk", async () => {
  const home = await freshHome();
  await saveTelegramConfig({ botToken: "12345:PLAINTEXT_SECRET", allowedChats: [4242], defaultChatId: 4242, enabled: true });

  const loaded = await loadTelegramConfig();
  assert.equal(loaded.botToken, "12345:PLAINTEXT_SECRET", "decrypts back to the original");
  assert.deepEqual(loaded.allowedChats, [4242]);
  assert.equal(loaded.enabled, true);
  assert.equal(await telegramConfigured(), true);

  const raw = await fs.readFile(path.join(home, "ui.json"), "utf8");
  assert.ok(!raw.includes("PLAINTEXT_SECRET"), "the token is NOT stored in plaintext");
  assert.match(raw, /enc:v1:/, "it's AES-encrypted at rest");

  await clearTelegramConfig();
  const cleared = await loadTelegramConfig();
  assert.equal(cleared.botToken, undefined);
  assert.equal(await telegramConfigured(), false);
});

// ── The TelegramSetup tool: verify → link → save ──────────────────────────────

test("tool: verify → link → save connects Telegram, never echoing the token", async () => {
  await freshHome();
  const sent = [];
  const api = fakeApi({ updates: [{ update_id: 7, message: { chat: { id: 4242, type: "private" }, text: "/start", from: { username: "noah" } } }], sent });
  const tool = makeTelegramSetupTool({ apiFactory: () => api });

  const verify = await tool.call({ action: "verify", token: "12345:SUPER_SECRET_TOKEN" }, ctx);
  assert.equal(verify.output.username, "AresTestBot");
  assert.ok(!JSON.stringify(verify).includes("SUPER_SECRET_TOKEN"), "verify never echoes the token");
  assert.equal((await loadTelegramConfig()).enabled, false, "verify stores the token but does NOT go live yet");

  const link = await tool.call({ action: "link" }, ctx);
  assert.equal(link.output.found, true);
  assert.equal(link.output.chatId, 4242);

  const save = await tool.call({ action: "save", chat_id: 4242 }, ctx);
  assert.equal(save.output.ok, true);
  assert.ok(sent.some((s) => s.chatId === 4242 && /live/.test(s.text)), "a test ping was sent");
  assert.equal(await telegramConfigured(), true, "now fully configured + enabled");
});

test("tool: verify rejects a bad token and stores nothing", async () => {
  await freshHome();
  const tool = makeTelegramSetupTool({ apiFactory: () => fakeApi({ meThrows: true }) });
  await assert.rejects(tool.call({ action: "verify", token: "bad" }, ctx), /didn't verify/);
  assert.equal((await loadTelegramConfig()).botToken, undefined, "a bad token is never saved");
});

test("tool: status / disable / reset", async () => {
  await freshHome();
  const api = fakeApi({ updates: [{ update_id: 1, message: { chat: { id: 7, type: "private" }, text: "/start" } }] });
  const tool = makeTelegramSetupTool({ apiFactory: () => api });
  assert.match((await tool.call({ action: "status" }, ctx)).display, /not configured/);

  await tool.call({ action: "verify", token: "1:t" }, ctx);
  await tool.call({ action: "save", chat_id: 7 }, ctx);
  assert.match((await tool.call({ action: "status" }, ctx)).display, /ON/);

  await tool.call({ action: "disable" }, ctx);
  assert.equal((await loadTelegramConfig()).enabled, false);

  await tool.call({ action: "reset" }, ctx);
  assert.equal((await loadTelegramConfig()).botToken, undefined, "reset wipes the token");
});

test("tool: link before verify is a clear error (no token yet)", async () => {
  await freshHome();
  const tool = makeTelegramSetupTool({ apiFactory: () => fakeApi() });
  await assert.rejects(tool.call({ action: "link" }, ctx), /verify/i);
});
