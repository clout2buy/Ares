// Remote command parser — "Ares while I'm at work." Lets you CONTROL Ares from
// Telegram with safe, explicit commands instead of only receiving reports.
//
// v1 is read + control only: status / war_map / next / summary report compact
// state; pause / resume / stop emit a control action; run_next is DRY-RUN (shows
// the proposed move + why, never executes). No risky actions from Telegram v1 —
// the approval bridge already gates anything outward/irreversible. Unknown
// messages return null and fall through to the normal garrison chat session.

import { redactForTelegram } from "./operatorReport.js";

export type TelegramCommandKind =
  | "status"
  | "war_map"
  | "next"
  | "pause"
  | "resume"
  | "stop"
  | "summary"
  | "run_next"
  | "help";

const ALIASES: Record<string, TelegramCommandKind> = {
  status: "status",
  war_map: "war_map",
  warmap: "war_map",
  map: "war_map",
  next: "next",
  pause: "pause",
  resume: "resume",
  stop: "stop",
  summary: "summary",
  today: "summary",
  run_next: "run_next",
  runnext: "run_next",
  help: "help",
};

/**
 * Recognize a slash command (/status, /run_next, /status@bot) or a bare
 * single-word command (status, pause). Anything else → null (route to chat).
 * Multi-word messages are never commands ("pause the music" is a chat).
 */
export function parseTelegramCommand(text: string): TelegramCommandKind | null {
  const t = text.trim();
  if (!t) return null;
  const slash = /^\/([a-z_]+)(?:@\w+)?(?:\s.*)?$/i.exec(t);
  const plain = /^([a-z][a-z_]*)$/i.exec(t);
  const word = (slash?.[1] ?? plain?.[1])?.toLowerCase().replace(/-/g, "_");
  if (!word) return null;
  return ALIASES[word] ?? null;
}

/** Compact state the command handler renders. Supplied by the caller (read from
 *  ~/.ares mission/project/after-action state — channels stays decoupled). */
export interface TelegramCommandState {
  project?: string;
  campaign?: string;
  nextActions?: readonly string[];
  lastGate?: string;
  recentWins?: readonly string[];
  /** Whether the operator loop is currently paused. */
  operatorPaused?: boolean;
}

export interface TelegramCommandDeps {
  state?: () => TelegramCommandState | Promise<TelegramCommandState>;
  control?: (action: "pause" | "resume" | "stop") => void | Promise<void>;
  /** The proposed next move + reason, for /run_next DRY-RUN. Never executes here. */
  runNextDryRun?: () => { action: string; why: string } | Promise<{ action: string; why: string }>;
}

export interface TelegramCommandResult {
  text: string;
  /** A control action the caller should apply (pause/resume/stop). */
  control?: "pause" | "resume" | "stop";
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};
const list = (xs: readonly string[] | undefined, n: number): string =>
  (xs ?? []).slice(0, n).map((x) => clip(x, 90)).join("; ");

const HELP = [
  "🜂 Ares — commands",
  "/status — online + key state",
  "/war_map — full mission/project map",
  "/next — next strategic moves",
  "/summary — recent wins",
  "/run_next — propose the next move (dry-run)",
  "/pause /resume /stop — operator control",
  "/help — this",
  "Anything else talks to Ares directly.",
].join("\n");

/** Handle a recognized command. PURE except for the injected deps. */
export async function handleTelegramCommand(
  kind: TelegramCommandKind,
  deps: TelegramCommandDeps = {},
): Promise<TelegramCommandResult> {
  const stateOf = async (): Promise<TelegramCommandState> => (deps.state ? await deps.state() : {});

  switch (kind) {
    case "help":
      return { text: HELP };

    case "status": {
      const s = await stateOf();
      const lines = ["🜂 Ares online."];
      if (s.project) lines.push(`Project: ${s.project}`);
      lines.push(`Operator: ${s.operatorPaused ? "paused" : "running"}`);
      if (s.campaign) lines.push(`Campaign: ${clip(s.campaign, 180)}`);
      if (s.lastGate) lines.push(`Gate: ${clip(s.lastGate, 80)}`);
      if (s.nextActions?.length) lines.push(`Next: ${list(s.nextActions, 3)}`);
      return { text: redactForTelegram(lines.join("\n")) };
    }

    case "war_map": {
      const s = await stateOf();
      const lines = ["🜂 Ares — war map"];
      if (s.project) lines.push(`Project: ${s.project}`);
      if (s.campaign) lines.push(`Campaign: ${clip(s.campaign, 200)}`);
      if (s.lastGate) lines.push(`Gate: ${clip(s.lastGate, 80)}`);
      if (s.recentWins?.length) lines.push(`Recent: ${list(s.recentWins, 4)}`);
      if (s.nextActions?.length) lines.push(`Next: ${list(s.nextActions, 4)}`);
      return { text: redactForTelegram(lines.join("\n")) };
    }

    case "next": {
      const s = await stateOf();
      const next = list(s.nextActions, 5);
      return { text: redactForTelegram(next ? `Next strategic moves:\n- ${(s.nextActions ?? []).slice(0, 5).map((x) => clip(x, 90)).join("\n- ")}` : "No next actions queued.") };
    }

    case "summary": {
      const s = await stateOf();
      const wins = (s.recentWins ?? []).slice(0, 5);
      return { text: redactForTelegram(wins.length ? `Recent wins:\n- ${wins.map((x) => clip(x, 100)).join("\n- ")}` : "Nothing logged yet.") };
    }

    case "run_next": {
      // DRY-RUN ONLY. Show the move + why; do not create or run a mission.
      const proposal = deps.runNextDryRun
        ? await deps.runNextDryRun()
        : (async () => {
            const s = await stateOf();
            return { action: s.nextActions?.[0] ?? "(no next action queued)", why: "top of the project's nextActions" };
          })();
      const p = await proposal;
      return {
        text: redactForTelegram(
          [`🔎 Proposed next move (dry-run):`, `Action: ${clip(p.action, 160)}`, `Why: ${clip(p.why, 160)}`, `Not executed — risky/outward actions need approval.`].join("\n"),
        ),
      };
    }

    case "pause":
      return { text: "⏸ Operator paused.", control: "pause" };
    case "resume":
      return { text: "▶ Operator resumed.", control: "resume" };
    case "stop":
      return { text: "⏹ Operator stopped.", control: "stop" };
  }
}
