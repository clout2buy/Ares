// Telegram config — the vault-backed setup state, so "connect telegram" needs no
// env vars. The bot token lives encrypted in ui.json (it's a SECRET_FIELD);
// chat allowlist + enabled flag sit alongside. Env vars still override (dev
// smoke tests), but the product path is the vault.

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
