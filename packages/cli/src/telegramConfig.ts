// Telegram config — the vault-backed setup state, so "connect telegram" needs no
// env vars. The bot token lives encrypted in ui.json (it's a SECRET_FIELD);
// chat allowlist + enabled flag sit alongside. Env vars still override (dev
// smoke tests), but the product path is the vault.

import { readFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { aresHome } from "@ares/core";
import { loadUiSettings, updateUiSettings, type UiSettings } from "./uiSettings.js";

export interface TelegramConfig {
  botToken?: string;
  allowedChats: number[];
  defaultChatId?: number;
  enabled: boolean;
}

function parseChats(raw?: string): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0);
}

/** Effective config: env vars first (dev override), then the encrypted vault. */
export async function loadTelegramConfig(): Promise<TelegramConfig> {
  const s = await loadUiSettings();
  const botToken = (process.env.ARES_TELEGRAM_BOT_TOKEN ?? s.telegramBotToken) || undefined;
  const allowedChats = parseChats(process.env.ARES_TELEGRAM_ALLOWED_CHATS ?? s.telegramAllowedChats);
  const defaultChatId =
    parseChats(process.env.ARES_TELEGRAM_CHAT_ID ?? s.telegramDefaultChatId)[0] ?? allowedChats[0];
  const enabled = process.env.ARES_TELEGRAM === "1" || s.telegramEnabled === true;
  return { botToken, allowedChats, defaultChatId, enabled };
}

export async function saveTelegramConfig(patch: {
  botToken?: string;
  allowedChats?: number[];
  defaultChatId?: number;
  enabled?: boolean;
}): Promise<void> {
  const up: Partial<UiSettings> = {};
  if (patch.botToken !== undefined) up.telegramBotToken = patch.botToken;
  if (patch.allowedChats !== undefined) up.telegramAllowedChats = patch.allowedChats.join(",");
  if (patch.defaultChatId !== undefined) up.telegramDefaultChatId = String(patch.defaultChatId);
  if (patch.enabled !== undefined) up.telegramEnabled = patch.enabled;
  await updateUiSettings(up);
}

/** Wipe Telegram config (the bot token included). Leaves nothing behind. */
export async function clearTelegramConfig(): Promise<void> {
  await updateUiSettings({
    telegramBotToken: undefined,
    telegramAllowedChats: undefined,
    telegramDefaultChatId: undefined,
    telegramEnabled: false,
  });
}

/** Enough to start the bridge: enabled + a token + at least one allowed chat. */
export async function telegramConfigured(): Promise<boolean> {
  const c = await loadTelegramConfig();
  return Boolean(c.enabled && c.botToken && c.allowedChats.length > 0);
}

// ─── Legacy desktop vault adoption ───────────────────────────────────────────
//
// Until v0.38 the desktop app kept its own vault (Windows %APPDATA%\Ares\home,
// macOS ~/Library/Application Support/Ares/home, Linux ~/.config/Ares/home).
// When the split closed, a machine that had BOTH vaults populated was left on
// ~/.ares with the desktop-only state untouched — and Telegram had only ever
// been set up from the desktop. Result: the token and the enabled flag stayed
// behind, the garrison read ~/.ares, and Telegram was silently off while the
// chat allowlist still looked "connected". This adopts exactly the missing
// Telegram fields (re-encrypting the token under the current vault key) and
// leaves everything else alone.

/** Where the pre-v0.38 desktop vault lived on this platform, if anywhere. */
export function legacyDesktopHome(): string | undefined {
  const home = os.homedir();
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(base, "Ares", "home");
  }
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Ares", "home");
  const base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.join(base, "Ares", "home");
}

const VAULT_PREFIX = "enc:v1:";

/** Decrypt one vault value with an explicit key file (not the process-wide cached key). */
async function decryptWithKeyFile(value: string, keyFile: string): Promise<string | undefined> {
  if (!value.startsWith(VAULT_PREFIX)) return value;
  try {
    const key = (await readFile(keyFile)).subarray(0, 32);
    const raw = Buffer.from(value.slice(VAULT_PREFIX.length), "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export interface LegacyAdoption {
  adopted: boolean;
  /** Human line worth logging; undefined when nothing happened. */
  note?: string;
}

/**
 * If the current vault has no usable Telegram config but the legacy desktop
 * vault does, copy the token (re-encrypted) and the enabled flag across,
 * merging chat allowlists. Idempotent: a configured current vault is never
 * touched. Explicit paths exist for tests.
 */
export async function adoptLegacyTelegramConfig(opts: { legacyHome?: string; currentHome?: string } = {}): Promise<LegacyAdoption> {
  const current = opts.currentHome ?? aresHome();
  const legacy = opts.legacyHome ?? legacyDesktopHome();
  if (!legacy || path.resolve(legacy) === path.resolve(current)) return { adopted: false };

  const have = await loadTelegramConfig();
  if (have.botToken && have.enabled) return { adopted: false };

  let legacyRaw: Record<string, unknown>;
  try {
    legacyRaw = JSON.parse(await readFile(path.join(legacy, "ui.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return { adopted: false };
  }
  const encToken = legacyRaw["telegramBotToken"];
  if (typeof encToken !== "string" || !encToken) return { adopted: false };
  const token = await decryptWithKeyFile(encToken, path.join(legacy, ".keysecret"));
  if (!token) return { adopted: false, note: `legacy Telegram token at ${legacy} could not be decrypted; not adopted` };

  const legacyChats = parseChats(typeof legacyRaw["telegramAllowedChats"] === "string" ? legacyRaw["telegramAllowedChats"] : undefined);
  const chats = [...new Set([...have.allowedChats, ...legacyChats])];
  const legacyDefault = parseChats(typeof legacyRaw["telegramDefaultChatId"] === "string" ? legacyRaw["telegramDefaultChatId"] : undefined)[0];
  const enabled = have.enabled || legacyRaw["telegramEnabled"] === true;

  await saveTelegramConfig({
    botToken: have.botToken ?? token,
    allowedChats: chats,
    defaultChatId: have.defaultChatId ?? legacyDefault ?? chats[0],
    enabled,
  });
  return {
    adopted: true,
    note: `adopted Telegram config from the pre-v0.38 desktop vault (${legacy}) — ${chats.length} chat(s), ${enabled ? "enabled" : "disabled"}`,
  };
}
