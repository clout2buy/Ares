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
    await this.api.sendVoice(chatId, voice, { caption });
  }

  /** Send a photo to specific chats (inline image on the phone). */
  async sendPhotoToChats(chatIds: number[], image: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const id of chatIds) {
      try {
        await this.api.sendPhoto(id, image, opts);
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Send a photo to every owner. */
  async sendPhotoToOwners(image: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<{ sent: number; failed: number }> {
    const roster = await loadRoster(this.home);
    return this.sendPhotoToChats(ownerChatIds(roster), image, opts);
  }

  /** Send a file (document) to specific chats. */
  async sendDocumentToChats(chatIds: number[], file: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const id of chatIds) {
      try {
        await this.api.sendDocument(id, file, opts);
        sent++;
      } catch {
        failed++;
      }
    }
    return { sent, failed };
  }

  /** Send a file to every owner. */
  async sendDocumentToOwners(file: Buffer, opts: { caption?: string; filename?: string } = {}): Promise<{ sent: number; failed: number }> {
    const roster = await loadRoster(this.home);
    return this.sendDocumentToChats(ownerChatIds(roster), file, opts);
  }
}

/** Convenience: create an outbound sender when you already have the token. */
export function createOutbound(botToken: string, home: string): TelegramOutbound {
  return new TelegramOutbound({ botToken, home });
}
