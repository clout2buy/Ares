// The pre-v0.38 desktop vault left Telegram's token + enabled flag behind when
// the homes converged (the Rust side refuses to merge two populated vaults).
// adoptLegacyTelegramConfig moves exactly those fields across, re-encrypting
// the token under the current vault key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { randomBytes, createCipheriv } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { adoptLegacyTelegramConfig, loadTelegramConfig, saveTelegramConfig, clearTelegramConfig } from "../packages/cli/dist/telegramConfig.js";

const CURRENT_HOME = process.env.ARES_HOME; // set by tests/_isolate-home.mjs

function encryptWith(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "enc:v1:" + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function makeLegacyHome(settings) {
  const dir = mkdtempSync(path.join(tmpdir(), "ares-legacy-home-"));
  const key = randomBytes(32);
  writeFileSync(path.join(dir, ".keysecret"), key);
  const onDisk = { ...settings };
  if (typeof onDisk.telegramBotToken === "string") onDisk.telegramBotToken = encryptWith(key, onDisk.telegramBotToken);
  writeFileSync(path.join(dir, "ui.json"), JSON.stringify(onDisk, null, 2));
  return dir;
}

test("adopts token + enabled from the legacy vault and merges chat lists", async () => {
  assert.ok(CURRENT_HOME, "tests must run with the isolated ARES_HOME");
  // Current vault: the state the owner actually had — chats present, no token.
  await saveTelegramConfig({ allowedChats: [111, 222], defaultChatId: 111 });
  const legacy = makeLegacyHome({
    telegramBotToken: "123456:real-bot-token",
    telegramEnabled: true,
    telegramAllowedChats: "111,333",
    telegramDefaultChatId: "111",
    openRouterKey: "should-not-move",
  });
  try {
    const before = await loadTelegramConfig();
    assert.equal(before.botToken, undefined);

    const result = await adoptLegacyTelegramConfig({ legacyHome: legacy });
    assert.equal(result.adopted, true);
    assert.match(result.note, /adopted Telegram config/);

    const after = await loadTelegramConfig();
    assert.equal(after.botToken, "123456:real-bot-token");
    assert.equal(after.enabled, true);
    assert.deepEqual([...after.allowedChats].sort(), [111, 222, 333]);
    assert.equal(after.defaultChatId, 111);

    // Re-encrypted under the CURRENT key, not copied as the legacy ciphertext.
    const raw = JSON.parse(readFileSync(path.join(CURRENT_HOME, "ui.json"), "utf8"));
    assert.match(raw.telegramBotToken, /^enc:v1:/);
    const legacyRaw = JSON.parse(readFileSync(path.join(legacy, "ui.json"), "utf8"));
    assert.notEqual(raw.telegramBotToken, legacyRaw.telegramBotToken);
    assert.equal(raw.openRouterKey, undefined, "only Telegram fields move");

    // Idempotent: a configured vault is never touched again.
    const again = await adoptLegacyTelegramConfig({ legacyHome: legacy });
    assert.equal(again.adopted, false);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
    await clearTelegramConfig();
  }
});

test("no legacy vault, or a legacy vault without Telegram, is a no-op", async () => {
  const empty = makeLegacyHome({ openRouterKey: "x" });
  try {
    assert.equal((await adoptLegacyTelegramConfig({ legacyHome: empty })).adopted, false);
    assert.equal((await adoptLegacyTelegramConfig({ legacyHome: path.join(tmpdir(), "does-not-exist-" + Date.now()) })).adopted, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a token that cannot be decrypted is reported, not adopted", async () => {
  const legacy = makeLegacyHome({ telegramBotToken: "tok", telegramEnabled: true });
  writeFileSync(path.join(legacy, ".keysecret"), randomBytes(32)); // wrong key
  try {
    const result = await adoptLegacyTelegramConfig({ legacyHome: legacy });
    assert.equal(result.adopted, false);
    assert.match(result.note, /could not be decrypted/);
    assert.equal((await loadTelegramConfig()).botToken, undefined);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});
