// TelegramSetup — the tool the agent drives when you say "connect telegram".
// No env vars, no second terminal, no @userinfobot: verify the bot token, watch
// for the /start you send the bot, confirm the chat, save it encrypted, ping.
//
//   verify(token) → getMe, stores the token (encrypted, disabled)
//   link()        → discovers the chat from your /start
//   save(chat_id) → allowlists it, enables, sends a test ping
//   status / disable / reset
//
// The token is NEVER echoed back. The operator can't usefully call this (it needs
// a human to paste a token + DM /start), so background autonomy can't self-enable
// a remote channel.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import { TelegramApi, verifyTelegramToken, pollForOwnerChat, type TelegramSetupApi } from "@ares/channels";
import { loadTelegramConfig, saveTelegramConfig, clearTelegramConfig } from "./telegramConfig.js";

const inputSchema = z
  .object({
    action: z.enum(["status", "verify", "link", "save", "disable", "reset"]).describe(
      "status: show current config. verify: check a bot token (pass token). link: discover your chat from a /start you sent the bot. save: allowlist a chat (pass chat_id) + enable + test ping. disable: turn off (keep config). reset: wipe config.",
    ),
    token: z.string().optional().describe("Bot token from @BotFather — only for 'verify'."),
    chat_id: z.number().int().optional().describe("Chat id to allowlist — only for 'save' (use the id from 'link')."),
  })
  .strict();

export interface TelegramSetupOutput {
  action: string;
  ok: boolean;
  configured?: boolean;
  enabled?: boolean;
  username?: string;
  chatId?: number;
  chatName?: string;
  found?: boolean;
  note?: string;
}

export interface TelegramSetupDeps {
  /** Injectable for tests; default builds a real TelegramApi. */
  apiFactory?: (token: string) => TelegramSetupApi;
}

export function makeTelegramSetupTool(deps: TelegramSetupDeps = {}) {
  const apiFactory = deps.apiFactory ?? ((token: string) => new TelegramApi(token));
  return buildTool({
    name: "TelegramSetup",
    description:
      "Connect/manage the owner's Telegram so they can command Ares from their phone. Use this when the owner asks to set up / connect / enable Telegram. Flow: ask for their bot token from @BotFather → verify(token); ask them to DM /start to the bot, then link() to discover their chat; confirm it's them, then save(chat_id). The token is stored encrypted and never shown.",
    safety: "external-state",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) => `Telegram setup: ${i.action}`,
    async checkPermissions(_i, ctx) {
      if (ctx.permissionMode === "plan") return { kind: "deny", reason: "TelegramSetup is disabled in plan mode." };
      return { kind: "allow" };
    },
    async call(i): Promise<{ output: TelegramSetupOutput; display: string }> {
      switch (i.action) {
        case "status": {
          const c = await loadTelegramConfig();
          const configured = Boolean(c.botToken && c.allowedChats.length > 0);
          return {
            output: { action: "status", ok: true, configured, enabled: c.enabled, chatId: c.defaultChatId, note: configured ? `${c.allowedChats.length} chat(s)` : "not configured" },
            display: configured ? `Telegram ${c.enabled ? "ON" : "off"} — ${c.allowedChats.length} chat(s)` : "Telegram not configured",
          };
        }
        case "verify": {
          const token = i.token?.trim();
          if (!token) throw new Error("verify needs the bot token (from @BotFather).");
          const res = await verifyTelegramToken(apiFactory(token));
          if (!res.ok) throw new Error(`That token didn't verify: ${res.error}. Re-check the token from @BotFather.`);
          await saveTelegramConfig({ botToken: token, enabled: false }); // stored encrypted; not live yet
          return {
            output: { action: "verify", ok: true, username: res.username, note: "token stored (encrypted); now DM /start to the bot, then run link" },
            display: `Bot verified: @${res.username ?? "your bot"}. Ask the owner to DM /start to it, then run link.`,
          };
        }
        case "link": {
          const c = await loadTelegramConfig();
          if (!c.botToken) throw new Error("No bot token yet — run verify with the token first.");
          const found = await pollForOwnerChat(apiFactory(c.botToken), 0, 0).catch(() => null);
          if (!found) {
            return { output: { action: "link", ok: true, found: false, note: "no /start seen yet" }, display: "No /start from the owner yet — ask them to DM /start to the bot, then run link again." };
          }
          return {
            output: { action: "link", ok: true, found: true, chatId: found.chatId, chatName: found.name, note: "confirm this is the owner, then save(chat_id)" },
            display: `Found a /start from ${found.name ?? "a chat"} (id ${found.chatId}). Confirm it's the owner, then save with that chat_id.`,
          };
        }
        case "save": {
          if (i.chat_id === undefined) throw new Error("save needs chat_id (from link).");
          const c = await loadTelegramConfig();
          if (!c.botToken) throw new Error("No bot token — run verify first.");
          await saveTelegramConfig({ allowedChats: [i.chat_id], defaultChatId: i.chat_id, enabled: true });
          let pinged = false;
          try {
            await apiFactory(c.botToken).sendMessage(i.chat_id, "🜂 Ares Telegram link is live. Send /help.");
            pinged = true;
          } catch {
            // config is saved regardless; the ping is best-effort confirmation
          }
          return {
            output: { action: "save", ok: true, chatId: i.chat_id, note: pinged ? "test ping sent" : "saved (test ping failed — check the chat id)" },
            display: pinged ? "Telegram connected — test ping sent. Restart the daemon (or it auto-starts) to go live." : "Telegram saved, but the test ping failed — double-check the chat id.",
          };
        }
        case "disable":
          await saveTelegramConfig({ enabled: false });
          return { output: { action: "disable", ok: true, enabled: false }, display: "Telegram disabled (config kept; reset to wipe)." };
        case "reset":
          await clearTelegramConfig();
          return { output: { action: "reset", ok: true }, display: "Telegram config wiped." };
      }
    },
  });
}
