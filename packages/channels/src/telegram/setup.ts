// Conversational Telegram setup helpers — the "connect telegram" flow.
//
// No env vars, no @userinfobot hunt: verify the bot token, then DISCOVER the
// owner's chat id from the /start they send the bot. Injectable api → testable
// with a fake, no network. The token is never returned or logged here.

import type { TgUpdate } from "./api.js";

/** The narrow api surface setup needs (TelegramApi satisfies it; fakes are trivial). */
export interface TelegramSetupApi {
  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string; first_name?: string; is_bot?: boolean }>;
  getUpdates(offset: number, timeoutS: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface VerifyResult {
  ok: boolean;
  username?: string;
  error?: string;
}

/** Confirm a bot token is real and grab the bot's @username. Never echoes the token. */
export async function verifyTelegramToken(api: TelegramSetupApi): Promise<VerifyResult> {
  try {
    const me = await api.getMe();
    if (!me?.id || me.is_bot === false) return { ok: false, error: "not a bot token" };
    return { ok: true, username: me.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface DiscoveredChat {
  chatId: number;
  name?: string;
  /** The latest update_id seen — pass back as offset to avoid re-scanning. */
  nextOffset: number;
}

/**
 * Discover the owner's chat from recent updates — the chat that just DMed the bot
 * (prefer a /start). Returns the most recent private chat, or null if none yet.
 * Only PRIVATE chats are eligible (never auto-allowlist a group).
 */
export function discoverChatFromUpdates(updates: readonly TgUpdate[]): DiscoveredChat | null {
  let nextOffset = 0;
  let best: DiscoveredChat | null = null;
  let bestStart = false;
  for (const u of updates) {
    if (u.update_id >= nextOffset) nextOffset = u.update_id + 1;
    const msg = u.message;
    if (!msg?.chat || msg.chat.type !== "private") continue;
    const isStart = (msg.text ?? "").trim().toLowerCase().startsWith("/start");
    // Prefer the newest /start; else the newest private message.
    if (!best || (isStart && !bestStart) || u.update_id >= (best ? nextOffset - 1 : -1)) {
      if (isStart || !bestStart) {
        best = { chatId: msg.chat.id, name: msg.from?.username ?? msg.from?.first_name ?? msg.chat.title, nextOffset };
        bestStart = bestStart || isStart;
      }
    }
  }
  return best ? { ...best, nextOffset } : null;
}

/** Poll once for the owner's chat (a /start they just sent). Best-effort. */
export async function pollForOwnerChat(api: TelegramSetupApi, offset = 0, timeoutS = 0): Promise<DiscoveredChat | null> {
  const updates = await api.getUpdates(offset, timeoutS);
  return discoverChatFromUpdates(updates);
}
