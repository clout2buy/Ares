// TelegramRoster — let the OWNER authorize/revoke people by just TALKING.
//
// "Hey, authorize my friend Sarah (she DM'd you)" → the agent calls this tool
// instead of the owner having to type the /allow command. add/remove are gated
// behind the approval Gate (so they surface on the owner's Telegram for a tap,
// and a guest can never quietly authorize someone); list is read-only.
//
// It writes the SAME roster file the live bridge reads (~/.ares/telegram-roster.json),
// and the bridge reloads it on each inbound message, so a grant goes live with no
// restart — the friend can talk to Ares on their very next message.

import { z } from "zod";
import { buildTool } from "@ares/tools";
import { aresHome } from "@ares/core";
import {
  loadRoster,
  saveRoster,
  upsertParticipant,
  removeParticipant,
  renderWho,
  type RosterData,
} from "@ares/channels";

const inputSchema = z
  .object({
    action: z.enum(["list", "add", "remove"]).describe(
      "list: show everyone allowed + when they were last active. add: authorize a person (REQUIRES chat_id + name). remove: revoke a person (REQUIRES chat_id or name). Only call 'add'/'remove' when the owner explicitly asked to authorize/allow or remove/revoke someone.",
    ),
    chat_id: z.number().int().optional().describe("The person's Telegram chat id — for 'add', or 'remove' by id. Get it from the 'X (id N) tried to message me' notice or by asking the owner."),
    name: z.string().optional().describe("Display name for 'add' (e.g. 'Sarah'); or the name to 'remove' by."),
  })
  .strict();

export interface TelegramRosterOutput {
  action: string;
  ok: boolean;
  who?: string;
  changed?: { chatId?: number; name?: string };
  note?: string;
}

const home = () => aresHome();

export function makeTelegramRosterTool() {
  return buildTool({
    name: "TelegramRoster",
    description:
      "Authorize, revoke, or list the people allowed to talk to Ares over Telegram — the conversational version of /allow, /revoke, /who. Use 'add' when the owner says to authorize/allow/let someone in, 'remove' when they say to revoke/remove/block someone, and 'list' when they ask who can talk to you. add/remove require a human approval tap. Do NOT call this on an incidental mention — only on an explicit request.",
    safety: "external-state",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) => `Telegram roster: ${i.action}${i.name ? ` ${i.name}` : ""}`,

    async checkPermissions(i, ctx) {
      if (ctx.permissionMode === "plan") return { kind: "deny", reason: "TelegramRoster is disabled in plan mode." };
      if (i.action === "list") return { kind: "allow" };
      const who = i.name ?? (i.chat_id !== undefined ? `chat ${i.chat_id}` : "someone");
      return {
        kind: "ask",
        prompt: i.action === "add" ? `Authorize ${who} to talk to Ares on Telegram?` : `Revoke ${who}'s Telegram access?`,
        suggestion: "allow_once",
      };
    },

    async call(i): Promise<{ output: TelegramRosterOutput; display: string }> {
      const roster: RosterData = await loadRoster(home());

      if (i.action === "list") {
        return { output: { action: "list", ok: true, who: renderWho(roster) }, display: renderWho(roster) };
      }

      if (i.action === "add") {
        if (i.chat_id === undefined) throw new Error("add needs the person's chat_id (from the 'tried to message me' notice, or ask the owner).");
        const name = i.name?.trim() || `chat ${i.chat_id}`;
        const next = upsertParticipant(roster, { chatId: i.chat_id, name, role: "guest" });
        await saveRoster(home(), next);
        return {
          output: { action: "add", ok: true, changed: { chatId: i.chat_id, name }, note: "they can talk to Ares from their next message — no restart needed" },
          display: `Authorized ${name} (id ${i.chat_id}). They're live on their next message.`,
        };
      }

      // remove
      const target = i.chat_id ?? i.name;
      if (target === undefined) throw new Error("remove needs a chat_id or a name.");
      const { data, removed } = removeParticipant(roster, target);
      if (!removed) return { output: { action: "remove", ok: false, note: "no matching person on the allowlist" }, display: `No one matching "${target}" to remove.` };
      if (removed.role === "owner") throw new Error("Refusing to remove an owner.");
      await saveRoster(home(), data);
      return {
        output: { action: "remove", ok: true, changed: { chatId: removed.chatId, name: removed.name }, note: "revoked; they can no longer talk to Ares" },
        display: `Revoked ${removed.name} (id ${removed.chatId}).`,
      };
    },
  });
}
