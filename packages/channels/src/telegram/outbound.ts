// Proactive outbound Telegram — Ares initiates, not just responds.
//
// The bridge handles INBOUND (user DMs → garrison sessions). This module is
// the other direction: Ares decides to send a message (check-in, alert,
// reminder, weather, anything) without the user having spoken first.
//
// It loads the bot token from the vault (same config the bridge uses),
// resolves the owner chat IDs from the roster, and exposes a clean
// sendToOwners / sendToChat API. Stateless — each call is fire-and-forget.

import { TelegramApi } from "./api.js";
import { loadRoster, ownerChatIds, allowedChatIds, type RosterData } from "./roster.js";

export interface OutboundConfig {
  botToken: string;
  home: string;
}

export interface OutboundMessage {
  text: string;
  /** Target specific chat IDs. If omitted, sends to all owners. */
  chatIds?: number[];
}

export class TelegramOutbound {
  private readonly api: TelegramApi;
  private readonly home: string;

  constructor(config: OutboundConfig) {
    this.api = new TelegramApi(config.botToken);
    this.home = config.home;
  }

  /** Send a message to all owners (the approval-holders). */
  async sendToOwners(text: string): Promise<{ sent: number; failed: number }> {
    const roster = await loadRoster(this.home);
    const ids = ownerChatIds(roster);
    return this.sendToChats(ids, text);
  }

  /** Send a message to all allowed participants. */
  async sendToAll(text: string): Promise<{ sent: number; failed: number }> {
    const roster = await loadRoster(this.home);
    const ids = allowedChatIds(roster);
    return this.sendToChats(ids, text);
  }

  /** Send a message to specific chat IDs. */
  async sendToChats(chatIds: number[], text: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const id of chatIds) {
      try {
        await this.api.sendMessage(id, text);
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Send a voice note (OGG/Opus) to specific chats. */
  async sendVoiceToChats(chatIds: number[], voice: Buffer, caption?: string): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const id of chatIds) {
      try {
        await this.sendVoice(id, voice, caption);
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Send a voice note to all owners. */
  async sendVoiceToOwners(voice: Buffer, caption?: string): Promise<{ sent: number; failed: number }> {
    const roster = await loadRoster(this.home);
    return this.sendVoiceToChats(ownerChatIds(roster), voice, caption);
  }

  /** Low-level: send a voice note (OGG/Opus buffer) to one chat. */
  private async sendVoice(chatId: number, voice: Buffer, caption?: string): Promise<void> {
    const boundary = `----AresVoice${Date.now()}`;
    const parts: Buffer[] = [];

    const addField = (name: string, value: string) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    addField("chat_id", String(chatId));
    if (caption) addField("caption", caption);

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="checkin.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
    ));
    parts.push(voice);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const token = (this.api as any).token as string;
    const base = (this.api as any).base as string || "https://api.telegram.org";
    const res = await fetch(`${base}/bot${token}/sendVoice`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sendVoice failed (${res.status}): ${text}`);
    }
  }
}

/** Convenience: create an outbound sender when you already have the token. */
export function createOutbound(botToken: string, home: string): TelegramOutbound {
  return new TelegramOutbound({ botToken, home });
}
