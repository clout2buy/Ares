// Extracted from entry.ts — telegramWiring.

import { installGlobalCrashHandlers } from "@ares/core";
import { readFile } from "node:fs/promises";
import { getWeatherText, setRemindScheduler } from "@ares/tools";
import { notice } from "../terminalUi.js";
import { loadTelegramConfig, telegramConfigured, clearTelegramConfig, saveTelegramConfig } from "../telegramConfig.js";
import { OperatorBackgroundLoop, isOperatorPaused, setOperatorControl, createGoal, listGoals, loadGoal, saveGoal, loadStandingOrders, addStandingOrder, removeStandingOrder, renderStandingOrders, runMeetingNudgeTick, DEFAULT_MEETING_LEAD_MINUTES, type MeetingEvent } from "@ares/operator";
import { detectWorkspaceProjectId, loadProjectState, loadMissionState, loadRecentAfterActions } from "@ares/mind";
import { tokenPath, DEFAULT_GARRISON_PORT, type GatewayServerFrame } from "@ares/garrison";
import { TelegramApi, TelegramBridge, OperatorTelegramReporter, formatWarMapBriefing, classifyMissionAction, stableHash, loadRoster, saveRoster, seedOwners, TelegramOutbound, TelegramScheduler } from "@ares/channels";
import { OAUTH_PROVIDERS, PROVIDER_LABELS, startOAuthFlow, connectedProviders } from "@ares/core";
import { buildDayBrief, defaultDayBriefSources } from "./introspect.js";
import { CliRuntimeContext, ParsedArgs, cliRuntimeContext } from "./runtime.js";

/** The Telegram remote-command deps (state/control/orchestration) shared by the
 *  `telegram serve` verb and the garrison auto-start. Reads the war map straight
 *  from ~/.ares; controls the operator via the cross-process flag; /run_next is
 *  dry-run, approve queues an operator goal — never direct tool execution. */
export interface TelegramModelControl {
  listModels?: (provider?: string) => Promise<string[]>;
  switchModel?: (provider: string, model?: string) => Promise<{ ok: boolean; text: string }>;
}

function telegramCommandDeps(context: CliRuntimeContext, modelControl?: TelegramModelControl, operatorLoop?: OperatorBackgroundLoop | null) {
  return {
    listModels: modelControl?.listModels,
    switchModel: modelControl?.switchModel,
    state: async () => {
      const projectId = await detectWorkspaceProjectId(context.workspace).catch(() => undefined);
      const [mission, project, paused] = await Promise.all([
        loadMissionState(context.home).catch(() => null),
        projectId ? loadProjectState(projectId, context.home).catch(() => null) : Promise.resolve(null),
        isOperatorPaused(context.home).catch(() => false),
      ]);
      return {
        project: project?.name ?? projectId,
        campaign: mission?.currentCampaign,
        nextActions: project?.nextActions ?? mission?.nextStrategicMoves,
        lastGate: project?.lastGate,
        recentWins: project?.recentWins,
        operatorPaused: paused,
      };
    },
    control: async (action: "pause" | "resume" | "stop") => {
      // "stop" now differs from "pause" when the live OperatorBackgroundLoop is
      // reachable (this daemon's own in-process loop, e.g. from `garrison serve`):
      // it clears the scheduler outright via .stop(), not just the cross-process
      // pause flag. "resume" must be able to undo THAT too — .stop() destroys the
      // setInterval driving every future tick, so clearing the pause flag alone
      // is a no-op once stopped (worse than plain pause, which was always
      // resumable via the flag since the timer was never destroyed). start() is
      // written to be safely re-callable, so restart it whenever it isn't running.
      if (action === "stop") operatorLoop?.stop();
      else if (action === "resume" && operatorLoop && !operatorLoop.started) operatorLoop.start();
      await setOperatorControl({ paused: action !== "resume" }, context.home);
    },
    proposeNext: async () => {
      const projectId = await detectWorkspaceProjectId(context.workspace).catch(() => undefined);
      const project = projectId ? await loadProjectState(projectId, context.home).catch(() => null) : null;
      const action = project?.nextActions?.[0] ?? "(no next action queued)";
      const { planningOnly } = classifyMissionAction(action);
      return { id: `tg-${stableHash(`${projectId ?? ""}:${action}`)}`, action, why: "top of the project war map's nextActions", planningOnly };
    },
    authorizeMission: async (p: { id: string; action: string; planningOnly: boolean }) => {
      const existing = await loadGoal(context.home, p.id).catch(() => null);
      if (existing) return { id: p.id, created: false };
      const statement = p.planningOnly
        ? `Plan ONLY — do NOT execute. Investigate and propose changes for the owner's approval: ${p.action}`
        : p.action;
      await saveGoal(context.home, createGoal({ id: p.id, statement }));
      return { id: p.id, created: true };
    },
    listMissions: async () => {
      const goals = await listGoals(context.home).catch(() => []);
      return goals.slice(0, 20).map((g) => ({ id: g.id, statement: g.statement, status: g.status, progress: g.progress, verdict: g.verdict }));
    },
    getMission: async (id: string) => {
      const g = await loadGoal(context.home, id).catch(() => null);
      return g ? { id: g.id, statement: g.statement, status: g.status, progress: g.progress, verdict: g.verdict } : null;
    },
    cancelMission: async (id: string) => {
      const g = await loadGoal(context.home, id).catch(() => null);
      if (!g || g.status === "done" || g.status === "abandoned") return false;
      await saveGoal(context.home, { ...g, status: "abandoned", updatedAt: new Date().toISOString() });
      return true;
    },
    standing: {
      list: async () => renderStandingOrders(await loadStandingOrders(context.home).catch(() => [])),
      add: async (statement: string, cadenceMs: number) => {
        const o = await addStandingOrder(context.home, { statement, cadenceMs });
        return o.id;
      },
      cancel: async (id: string) => removeStandingOrder(context.home, id),
    },
  };
}

/** Start the Telegram bridge in-process when configured (garrison auto-start) —
 *  no second terminal. Best-effort: a Telegram failure never touches the daemon.
 *  Returns the bridge (to stop on shutdown) or null when not configured. */
export async function startTelegramBridge(context: CliRuntimeContext, gatewayUrl: string, gatewayToken: string, modelControl?: TelegramModelControl, operatorLoop?: OperatorBackgroundLoop | null): Promise<TelegramBridge | null> {
  if (!(await telegramConfigured().catch(() => false))) return null;
  const cfg = await loadTelegramConfig();
  if (!cfg.botToken || cfg.allowedChats.length === 0) return null;
  // The roster (names + roles + added guests) is the durable source of truth;
  // the configured chats are seeded as owners. Guests join via /allow at runtime.
  const roster = seedOwners(await loadRoster(context.home), cfg.allowedChats);
  const bridge = new TelegramBridge({
    api: new TelegramApi(cfg.botToken),
    gateway: { url: gatewayUrl, token: gatewayToken },
    allowedChatIds: cfg.allowedChats,
    ownerChatIds: cfg.allowedChats,
    initialRoster: roster,
    persistRoster: (data) => saveRoster(context.home, data),
    reloadRoster: () => loadRoster(context.home),
    log: (line) => process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "telegram", line } }) + "\n"),
    commands: telegramCommandDeps(context, modelControl, operatorLoop),
    connectDeps: {
      startOAuthFlow,
      providers: OAUTH_PROVIDERS,
      providerLabels: PROVIDER_LABELS,
      connectedProviders,
      home: context.home,
    },
  });
  bridge.start();
  return bridge;
}

export async function startTelegramCheckins(context: CliRuntimeContext): Promise<TelegramScheduler | null> {
  if (!(await telegramConfigured().catch(() => false))) return null;
  const cfg = await loadTelegramConfig();
  if (!cfg.botToken) return null;
  const outbound = new TelegramOutbound({ botToken: cfg.botToken, home: context.home });
  const ownerLocation = process.env.ARES_OWNER_LOCATION;
  const tgLog = (line: string) => process.stdout.write(JSON.stringify({ type: "lifecycle", event: { kind: "telegram-scheduler", line } }) + "\n");
  const tgScheduler = new TelegramScheduler({
    outbound,
    home: context.home,
    buildMessage: async (ctx) => {
      const time = ctx.now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      const lines = [`🜂 ${ctx.alarm.label} — ${time}`];
      if (ctx.alarm.body) lines.push("", ctx.alarm.body);
      if (ownerLocation) {
        const weather = await getWeatherText(ownerLocation).catch(() => "");
        if (weather) lines.push("", weather);
      }
      lines.push("", "Anything you need? I'm here.");
      return lines.join("\n");
    },
    log: tgLog,
  });
  await tgScheduler.start();
  // Inject into the Remind tool so the agent can add/remove/list alarms at runtime.
  setRemindScheduler(tgScheduler);
  return tgScheduler;
}

/** Build the operator→Telegram reporter from the vault config (env overrides),
 *  or null when disabled/unconfigured. */
/**
 * Garrison gateway mirror for the desktop daemon.
 *
 * The UI talks to this daemon over NDJSON. When a Garrison server is running
 * (e.g., `ares garrison serve` with the Telegram bridge), this client attaches
 * to every session on the gateway and forwards TurnEvents to the UI verbatim,
 * tagged with the gateway session id. That makes Telegram conversations and
 * other companion-client sessions show up live inside the desktop app.
 *
 * Best-effort: if no gateway is reachable the daemon keeps running normally and
 * just serves its local sessions. Reconnects automatically if the gateway
 * later appears.
 */
export async function startGatewayMirror(
  context: CliRuntimeContext,
  emit: (sessionId: string | undefined, obj: Record<string, unknown>) => void,
): Promise<() => void> {
  const token = await readFile(tokenPath(context.home), "utf8").then((t) => t.trim()).catch(() => "");
  if (!token) return () => {};
  const port = Number(process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  const url = `ws://127.0.0.1:${port}`;
  const { default: WebSocket } = await import("ws");
  const attached = new Set<string>();
  let ws: InstanceType<typeof WebSocket> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const send = (frame: unknown) => {
    try {
      ws?.send(JSON.stringify(frame));
    } catch {
      // socket may be closing; next reconnect will retry
    }
  };

  const attach = (id: string) => {
    if (attached.has(id)) return;
    attached.add(id);
    send({ type: "session.attach", sessionId: id });
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.on("open", () => send({ type: "hello", token, client: "daemon-mirror", proto: 1 }));
    ws.on("close", () => scheduleReconnect());
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer) => {
      let frame: GatewayServerFrame;
      try {
        frame = JSON.parse(String(raw)) as GatewayServerFrame;
      } catch {
        return;
      }
      if (frame.type === "welcome") {
        for (const s of frame.sessions) attach(s.id);
      } else if (frame.type === "session.created") {
        attach(frame.session.id);
      } else if (frame.type === "event" && typeof frame.sessionId === "string") {
        // Forward verbatim so the desktop UI renders the gateway session in
        // its own card. Avoid re-emitting events for sessions this daemon also
        // owns locally: the local engine already streams those.
        if (!attached.has(frame.sessionId)) attach(frame.sessionId);
        emit(frame.sessionId, frame.event as Record<string, unknown>);
      }
    });
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 3_000);
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {}
  };
}

export async function buildOperatorReporter(): Promise<OperatorTelegramReporter | null> {
  const cfg = await loadTelegramConfig().catch(() => null);
  if (!cfg || !cfg.enabled || !cfg.botToken) return null;
  const chatIds = cfg.defaultChatId ? [cfg.defaultChatId] : cfg.allowedChats;
  if (chatIds.length === 0) return null;
  return new OperatorTelegramReporter({
    api: new TelegramApi(cfg.botToken),
    chatIds,
    debug: process.env.ARES_TELEGRAM_DEBUG === "1",
    log: (line) => process.stderr.write(line + "\n"),
  });
}

/** Push a compact war-map status (campaign / project / next / gate / last action). */
export async function sendWarMapBriefing(reporter: OperatorTelegramReporter, context: CliRuntimeContext): Promise<void> {
  const projectId = await detectWorkspaceProjectId(context.workspace).catch(() => undefined);
  const [mission, project, recent] = await Promise.all([
    loadMissionState(context.home).catch(() => null),
    projectId ? loadProjectState(projectId, context.home).catch(() => null) : Promise.resolve(null),
    projectId ? loadRecentAfterActions(projectId, 1, context.home).catch(() => []) : Promise.resolve([]),
  ]);
  await reporter.send(
    formatWarMapBriefing({
      project: project?.name ?? projectId,
      campaign: mission?.currentCampaign,
      nextActions: project?.nextActions ?? mission?.nextStrategicMoves,
      lastGate: project?.lastGate,
      recentAction: recent[0]?.summary,
    }),
  );
}

// `ares telegram serve` — the outbound channel that makes autonomy VISIBLE:
// Telegram DMs in (one Ares session per allowed chat, via the Garrison gateway),
// and a daily briefing pushed out every morning. This is the organ the audit
// found fully implemented but never constructed — now it has a launch verb.
export async function telegramCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "serve";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });

  // Setup/management subcommands — no token needed to inspect or tear down.
  if (sub === "status") {
    const c = await loadTelegramConfig();
    const configured = Boolean(c.botToken && c.allowedChats.length > 0);
    process.stdout.write(
      notice("Telegram", [
        `state    ${configured ? (c.enabled ? "configured + enabled" : "configured (disabled)") : "not configured"}`,
        `chats    ${c.allowedChats.length ? c.allowedChats.join(", ") : "—"}`,
        `token    ${c.botToken ? "set (hidden)" : "—"}`,
        configured ? "" : "Tip: open Ares and say \"connect telegram\" — it'll walk you through it.",
      ].filter(Boolean), configured ? "success" : "info"),
    );
    return 0;
  }
  if (sub === "disable") {
    await saveTelegramConfig({ enabled: false });
    process.stdout.write(notice("Telegram", ["disabled (config kept; 'reset' to wipe)"], "info"));
    return 0;
  }
  if (sub === "reset") {
    await clearTelegramConfig();
    process.stdout.write(notice("Telegram", ["config wiped (token, chats, enabled)"], "info"));
    return 0;
  }
  if (sub !== "serve") {
    process.stderr.write("error: usage: ares telegram <serve|status|disable|reset>\n");
    return 2;
  }

  // serve: prefer the vault config (set via 'connect telegram'); env still works.
  const cfg = await loadTelegramConfig();
  const botToken = cfg.botToken ?? args.flags.get("bot-token");
  if (!botToken) {
    process.stderr.write("error: Telegram isn't configured. In Ares, say \"connect telegram\" to set it up (or set ARES_TELEGRAM_BOT_TOKEN).\n");
    return 2;
  }
  const allowedChatIds = cfg.allowedChats.length
    ? cfg.allowedChats
    : (args.flags.get("allow") ?? "").split(/[\s,]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n !== 0);
  if (allowedChatIds.length === 0) {
    process.stderr.write("error: no allowed chats. Say \"connect telegram\" in Ares (or set ARES_TELEGRAM_ALLOWED_CHATS).\n");
    return 2;
  }

  // Crash safety for the long-lived Telegram channel process (keeps its own
  // SIGINT/SIGTERM shutdown below, so handleSignals:false). Fatals → crash log;
  // a stray rejection is logged, not fatal to the channel.
  const uninstallTelegramCrashHandlers = installGlobalCrashHandlers({
    home: context.home,
    process: "telegram",
    emit: (notice) => process.stderr.write(`telegram: crash(${notice.kind}): ${notice.message} → ${notice.logFile ?? "(unwritten)"}\n`),
    handleSignals: false,
  });

  const port = Number(args.flags.get("port") ?? process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  const gatewayUrl = args.flags.get("url") ?? `ws://127.0.0.1:${port}`;
  let gatewayToken: string;
  try {
    gatewayToken = (await readFile(tokenPath(context.home), "utf8")).trim();
  } catch {
    process.stderr.write(`error: no garrison token at ${tokenPath(context.home)} — start it first (ares garrison serve).\n`);
    return 2;
  }

  const api = new TelegramApi(botToken);
  const roster = seedOwners(await loadRoster(context.home), allowedChatIds);
  const bridge = new TelegramBridge({
    api,
    gateway: { url: gatewayUrl, token: gatewayToken },
    allowedChatIds,
    ownerChatIds: allowedChatIds,
    initialRoster: roster,
    persistRoster: (data) => saveRoster(context.home, data),
    reloadRoster: () => loadRoster(context.home),
    log: (line: string) => process.stdout.write(`telegram: ${line}\n`),
    commands: telegramCommandDeps(context),
  });
  bridge.start();

  // Daily briefing push. Fires at ARES_BRIEFING_HOUR (local, default 8) and on
  // first boot after the hour if it hasn't gone out today — so "report to me
  // daily" actually happens, unattended. The body is the full morning brief
  // (weather → calendar → reminders → email → missions); a source that isn't
  // connected costs one line, never the push.
  const briefingHour = Math.min(23, Math.max(0, Number(process.env.ARES_BRIEFING_HOUR) || 8));
  let lastBriefingDay = "";
  const pushBriefing = async () => {
    try {
      const brief = await buildDayBrief(context);
      const text = ["🜂 Ares — daily briefing", "", brief.text].join("\n");
      for (const chatId of allowedChatIds) await api.sendMessage(chatId, text).catch(() => undefined);
    } catch {
      // never let the briefing crash the channel
    }
  };
  // Meeting-prep nudges PIGGYBACK the same 5-minute briefing tick below — the
  // scheduler owns no new setInterval, and a 5-min cadence comfortably lands a
  // 30-min-lead nudge. Events come from the SAME calendar source the day brief
  // uses (defaultDayBriefSources), so a nudge and the morning brief always
  // agree about what's connected: no calendar source → silently no nudges.
  // ARES_MEETING_NUDGE=0 disables; ARES_MEETING_PREP_MIN tunes the lead.
  const meetingNudgesEnabled = process.env.ARES_MEETING_NUDGE !== "0";
  const meetingLeadMinutes = Math.max(1, Number(process.env.ARES_MEETING_PREP_MIN) || DEFAULT_MEETING_LEAD_MINUTES);
  const checkMeetingNudges = async (): Promise<void> => {
    if (!meetingNudgesEnabled) return;
    try {
      const sources = await defaultDayBriefSources(context);
      const calendar = sources.calendar;
      if (!calendar) return; // Google not connected — stay silent, never nag
      await runMeetingNudgeTick({
        home: context.home,
        leadMinutes: meetingLeadMinutes,
        fetchEvents: async () => (await calendar()) as MeetingEvent[],
        send: async (text) => {
          for (const chatId of allowedChatIds) await api.sendMessage(chatId, text).catch(() => undefined);
        },
      });
    } catch {
      // best-effort: a calendar/API hiccup never touches the channel
    }
  };

  const briefingTimer = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() >= briefingHour && day !== lastBriefingDay) {
      lastBriefingDay = day;
      void pushBriefing();
    }
    void checkMeetingNudges();
  }, 5 * 60_000);
  // A restart mid-lead-window must not eat a nudge — check once at boot too
  // (the durable fingerprint set makes this safe from duplicates).
  void checkMeetingNudges();

  process.stdout.write(
    notice(
      "Telegram · channel up",
      [
        `gateway   ${gatewayUrl}`,
        `chats     ${allowedChatIds.join(", ")}`,
        `briefing  daily at ${String(briefingHour).padStart(2, "0")}:00 (ARES_BRIEFING_HOUR)`,
      ],
      "success",
    ),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\ntelegram: standing down…\n");
      clearInterval(briefingTimer);
      uninstallTelegramCrashHandlers();
      void bridge.stop().finally(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
