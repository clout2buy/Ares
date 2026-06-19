// Remote command parser — "Ares while I'm at work." Control Ares from Telegram.
//
// v1 read/control: status / war_map / next / summary report compact state;
// pause / resume / stop control the operator loop.
//
// Level-3 orchestration (two-step approval): /run_next proposes the next move
// (DRY-RUN), /run_next approve QUEUES a mission (an operator goal — never direct
// tool execution), /run_next reject discards it. /missions, /mission <id>,
// /cancel <id> manage the queue. Telegram AUTHORIZES; the operator EXECUTES with
// its own safety gates; the approval bridge guards anything risky. Dangerous
// proposals are downgraded to planning-only. Telegram is never a tool backdoor.

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
  | "missions"
  | "mission"
  | "cancel"
  | "model"
  | "models"
  | "connect"
  | "standing"
  | "help";

export interface TelegramCommand {
  kind: TelegramCommandKind;
  /** Trailing argument (e.g. "approve" for /run_next, an id for /mission). */
  arg?: string;
}

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
  missions: "missions",
  mission: "mission",
  cancel: "cancel",
  model: "model",
  models: "models",
  connect: "connect",
  services: "connect",
  standing: "standing",
  orders: "standing",
  help: "help",
  start: "help",
};

/**
 * Recognize a slash command (/status, /run_next approve, /mission abc) or a bare
 * one-word command (status, pause). Anything else → null (route to chat).
 */
export function parseTelegramCommand(text: string): TelegramCommand | null {
  const t = text.trim();
  if (!t) return null;
  const slash = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(t);
  const plain = /^([a-z][a-z_]*)$/i.exec(t);
  const word = (slash?.[1] ?? plain?.[1])?.toLowerCase().replace(/-/g, "_");
  if (!word) return null;
  const kind = ALIASES[word];
  if (!kind) return null;
  const arg = slash?.[2]?.trim();
  return arg ? { kind, arg } : { kind };
}

/** A queued/running/recent mission as Telegram shows it. */
export interface MissionSummary {
  id: string;
  statement: string;
  status: string;
  progress?: number;
}

/** The proposed next move — stable id so approving twice is idempotent. */
export interface MissionProposal {
  id: string;
  action: string;
  why: string;
  /** True when the action is risky and must be queued as planning-only. */
  planningOnly: boolean;
}

const DANGEROUS_ACTION =
  /\b(force[- ]?push|push\b|deploy|publish|delete|destroy|drop\s+(?:database|table)|rm\s+-[a-z]*[rf]|wipe|format\s+disk|buy|purchase|payment|\bpay\b|checkout|charge|credit\s*card|password|credential|secret|api[_-]?key|\btoken\b|log\s*in|sign\s*in|send\s+(?:an?\s+)?email|send\s+mail)\b/i;

/** Classify a proposed action: risky ones are downgraded to planning-only. */
export function classifyMissionAction(action: string): { planningOnly: boolean; reason?: string } {
  const m = DANGEROUS_ACTION.exec(action);
  return m ? { planningOnly: true, reason: `mentions "${m[0].trim()}"` } : { planningOnly: false };
}

export interface TelegramCommandState {
  project?: string;
  campaign?: string;
  nextActions?: readonly string[];
  lastGate?: string;
  recentWins?: readonly string[];
  operatorPaused?: boolean;
}

export interface TelegramCommandDeps {
  state?: () => TelegramCommandState | Promise<TelegramCommandState>;
  control?: (action: "pause" | "resume" | "stop") => void | Promise<void>;
  /** The proposed next move for /run_next (deterministic → stable id). */
  proposeNext?: () => MissionProposal | Promise<MissionProposal>;
  /** Authorize (queue) a mission. Idempotent by proposal id. */
  authorizeMission?: (p: MissionProposal) => { id: string; created: boolean } | Promise<{ id: string; created: boolean }>;
  listMissions?: () => MissionSummary[] | Promise<MissionSummary[]>;
  getMission?: (id: string) => MissionSummary | null | Promise<MissionSummary | null>;
  cancelMission?: (id: string) => boolean | Promise<boolean>;
  /** List the model catalog for a provider (omit → current/all). */
  listModels?: (provider?: string) => string[] | Promise<string[]>;
  /** Switch the live provider/model. ok=true → the bridge resets the session. */
  switchModel?: (provider: string, model?: string) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>;
  /** Standing orders — recurring missions the operator runs unattended. */
  standing?: {
    list: () => string | Promise<string>;
    add: (statement: string, cadenceMs: number) => string | Promise<string>;
    cancel: (id: string) => boolean | Promise<boolean>;
  };
}

export interface TelegramCommandResult {
  text: string;
  control?: "pause" | "resume" | "stop";
  /** After a successful /model switch, the bridge drops the chat's session so the
   *  next message spins up a fresh one on the new model. */
  resetSession?: boolean;
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
  "/run_next approve|reject — queue / discard it",
  "/missions — queued/running missions",
  "/mission <id> — one mission",
  "/cancel <id> — cancel a mission",
  "/pause /resume /stop — operator control",
  "/models [provider] — list models · /model <provider> [id] — switch",
  "/connect — manage service connections (Google, Spotify, etc)",
  "/standing — recurring missions Ares runs while you're gone",
  "/standing add 2h <mission> · /standing cancel <id>",
  "/who /activity — who can talk + who's saying what (owner)",
  "/allow <id> <name> · /revoke <id|name> — manage people (owner)",
  "Anything else talks to Ares directly.",
].join("\n");

async function fallbackProposal(state: TelegramCommandState): Promise<MissionProposal> {
  const action = state.nextActions?.[0] ?? "(no next action queued)";
  const { planningOnly } = classifyMissionAction(action);
  return { id: `tg-${stableHash(`${state.project ?? ""}:${action}`)}`, action, why: "top of the project war map's nextActions", planningOnly };
}

/** Handle a recognized command. PURE except for the injected deps. */
export async function handleTelegramCommand(
  kind: TelegramCommandKind,
  deps: TelegramCommandDeps = {},
  arg?: string,
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
      const actions = (s.nextActions ?? []).slice(0, 5);
      return { text: redactForTelegram(actions.length ? `Next strategic moves:\n- ${actions.map((x) => clip(x, 90)).join("\n- ")}` : "No next actions queued.") };
    }

    case "summary": {
      const s = await stateOf();
      const wins = (s.recentWins ?? []).slice(0, 5);
      return { text: redactForTelegram(wins.length ? `Recent wins:\n- ${wins.map((x) => clip(x, 100)).join("\n- ")}` : "Nothing logged yet.") };
    }

    case "run_next": {
      const proposal = deps.proposeNext ? await deps.proposeNext() : await fallbackProposal(await stateOf());
      const sub = arg?.toLowerCase();
      if (sub === "approve") {
        if (!deps.authorizeMission) return { text: "Mission creation isn't wired here." };
        const res = await deps.authorizeMission(proposal);
        if (!res.created) return { text: redactForTelegram(`Already queued (${res.id}) — not duplicated.`) };
        return {
          text: redactForTelegram(
            `✅ Mission queued (${res.id}): ${clip(proposal.action, 160)}` +
              (proposal.planningOnly ? "\n(planning-only — risky action downgraded; it will propose, not execute)" : "") +
              "\nThe operator will pick it up under its safety gates.",
          ),
        };
      }
      if (sub === "reject") return { text: "Proposal rejected — nothing queued." };
      return {
        text: redactForTelegram(
          [
            "🔎 Proposed next move (dry-run):",
            `Action: ${clip(proposal.action, 160)}`,
            `Why: ${clip(proposal.why, 160)}`,
            proposal.planningOnly ? "Note: risky → would be queued planning-only." : "",
            "Reply /run_next approve to queue it, /run_next reject to discard.",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      };
    }

    case "missions": {
      const missions = deps.listMissions ? await deps.listMissions() : [];
      if (missions.length === 0) return { text: "No missions queued." };
      const lines = missions.slice(0, 10).map((m) => `• ${m.id} [${m.status}] ${clip(m.statement, 80)}`);
      return { text: redactForTelegram(["🜂 Missions", ...lines].join("\n")) };
    }

    case "mission": {
      if (!arg) return { text: "Usage: /mission <id>" };
      const m = deps.getMission ? await deps.getMission(arg) : null;
      if (!m) return { text: `No mission ${arg}.` };
      return {
        text: redactForTelegram([`🜂 Mission ${m.id}`, `Status: ${m.status}`, typeof m.progress === "number" ? `Progress: ${m.progress}` : "", clip(m.statement, 300)].filter(Boolean).join("\n")),
      };
    }

    case "cancel": {
      if (!arg) return { text: "Usage: /cancel <id>" };
      const ok = deps.cancelMission ? await deps.cancelMission(arg) : false;
      return { text: ok ? `⏹ Cancelled mission ${arg}.` : `No pending mission ${arg} to cancel.` };
    }

    case "models": {
      if (!deps.listModels) return { text: "Model listing isn't available here." };
      const lines = await deps.listModels(arg);
      return { text: lines.join("\n").slice(0, 3500) };
    }

    case "model": {
      if (!deps.switchModel) return { text: "Model switching isn't available here." };
      if (!arg) return { text: "Usage: /model <provider> [model-id]. Browse with /models <provider>." };
      const [provider, ...rest] = arg.split(/\s+/);
      const res = await deps.switchModel(provider.toLowerCase(), rest.join(" ").trim() || undefined);
      return { text: res.text, resetSession: res.ok };
    }

    case "connect":
      return { text: "__CONNECT_MENU__" };

    case "standing": {
      if (!deps.standing) return { text: "Standing orders aren't wired here." };
      const sub = arg?.trim() ?? "";
      // /standing  → list
      if (!sub) return { text: redactForTelegram(["🜂 Standing orders", await deps.standing.list()].join("\n")) };
      // /standing cancel <id>
      const cancelM = /^(?:cancel|remove|rm|del)\s+(\S+)$/i.exec(sub);
      if (cancelM) {
        const ok = await deps.standing.cancel(cancelM[1]);
        return { text: ok ? `⏹ Standing order ${cancelM[1]} cancelled.` : `No standing order ${cancelM[1]}.` };
      }
      // /standing add <cadence> <statement>   e.g. "add 2h summarize new email"
      const addM = /^add\s+(\d+)\s*([mhd])\s+([\s\S]+)$/i.exec(sub);
      if (addM) {
        const n = Number(addM[1]);
        const unit = addM[2].toLowerCase();
        const ms = unit === "d" ? n * 86_400_000 : unit === "h" ? n * 3_600_000 : n * 60_000;
        const statement = addM[3].trim();
        if (!statement) return { text: "Usage: /standing add <2h|30m|1d> <mission>" };
        const id = await deps.standing.add(statement, ms);
        return {
          text: redactForTelegram(
            `✅ Standing order queued (${id}) — every ${addM[1]}${unit}.\n${clip(statement, 160)}\nAres will run it unattended under its safety gates and report here.`,
          ),
        };
      }
      return { text: "Usage:\n/standing — list\n/standing add <2h|30m|1d> <mission>\n/standing cancel <id>" };
    }

    case "pause":
      return { text: "⏸ Operator paused.", control: "pause" };
    case "resume":
      return { text: "▶ Operator resumed.", control: "resume" };
    case "stop":
      return { text: "⏹ Operator stopped.", control: "stop" };
  }
}

/** Tiny deterministic hash for stable proposal ids (FNV-1a, base36). */
export function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
