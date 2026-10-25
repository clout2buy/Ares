// ChangeSetting — say it, and Ares changes it.
//
// Owner, 2026-10-25: new people never find the right settings tab. Anything
// they could click in Settings they can now SAY in chat ("use the cheaper
// model", "stop asking me before running commands", "turn voice off"). Like
// SetUiEffect, the daemon side only validates and echoes: the DESKTOP watches
// the event stream for this call and applies it through the same handlers
// the Settings panel uses, so the two can never disagree. On the TUI or
// Telegram there is no desktop to apply it — the note says so.

import { z } from "zod";
import { buildTool } from "./_shared.js";

export const CHANGEABLE_SETTINGS = ["ask_before_acting", "model", "effort", "voice", "effects", "name"] as const;
export type ChangeableSetting = (typeof CHANGEABLE_SETTINGS)[number];

const inputSchema = z
  .object({
    setting: z.enum(CHANGEABLE_SETTINGS).describe(
      [
        "ask_before_acting: value on/off — off = act on everything without asking (files, commands, web, payments); on = ask before anything sensitive.",
        "model: value '<provider>/<model id>' — the brain THIS agent thinks with from the next turn (e.g. anthropic/claude-sonnet-5, openai/gpt-5.5). Use a model id you know exists for that provider.",
        "effort: value off/low/medium/high/max or default — how hard this agent thinks before answering (rungs the model lacks snap to the nearest).",
        "voice: value on/off — spoken replies.",
        "effects: value glow/minimal/off — the working animation.",
        "name: value <text> — what Ares calls the owner.",
      ].join(" "),
    ),
    value: z.string().min(1).max(120).describe("The new value, as described for the setting."),
  })
  .strict();

export interface ChangeSettingOutput {
  applied: { setting: ChangeableSetting; value: string };
  note: string;
}

export const ChangeSettingTool = buildTool({
  name: "ChangeSetting",
  description:
    "Change one of the owner's Ares settings for them, instead of sending them to the Settings panel. Use when they ask in plain words: 'stop asking me before running commands' (ask_before_acting=off), 'use the cheaper model' / 'switch to Sonnet' (model), 'think harder' (effort), 'turn voice off' (voice), 'call me Sam' (name). Applies live on the desktop and persists. Say what you changed in one line; never claim a change you did not make.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Changing ${i.setting} → ${i.value}`,

  async call(i): Promise<{ output: ChangeSettingOutput; display: string }> {
    const value = i.value.trim();
    return {
      output: {
        applied: { setting: i.setting, value },
        note: "The desktop applies this live from the event stream and saves it. If the owner is on the TUI or Telegram, nothing changes — tell them to do it in the app instead of pretending.",
      },
      display: `⚙ ${i.setting} → ${value}`,
    };
  },
});
