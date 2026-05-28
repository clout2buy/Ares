import path from "node:path";
import { crixAgentHome } from "./paths.js";
import { ensureAgentScaffold, bootstrapReminder } from "./bootstrap/bootstrap.js";
import { loadAgentConfig, type CrixAgentConfig } from "./config.js";
import { composeAgentSystemPrompt, loadAgentSystemContext, type AgentSystemContext } from "./identity/context.js";
import { recallForTurn } from "./recall.js";
import { runLightDream } from "./dreaming.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { captureUserMessage } from "./capture.js";
import { gainForTarget } from "./voice.js";
import { snapshotBrain } from "./persistence.js";

export interface PreparedAgent {
  enabled: boolean;
  home: string;
  config: CrixAgentConfig;
  context: AgentSystemContext;
  startupReminders: Array<{ text: string; source: "memory" | "instructions" }>;
  composeSystemPrompt(base: string): string;
}

export async function prepareCrixAgent(opts: {
  home?: string;
  workspace: string;
  includeMemory?: boolean;
  enabled?: boolean;
}): Promise<PreparedAgent> {
  const enabled = opts.enabled ?? process.env.CRIX_AGENT_ENABLED !== "0";
  const home = crixAgentHome(opts.home);
  const config = await loadAgentConfig(home);
  if (!enabled) {
    const context = await loadAgentSystemContext({ home, workspace: opts.workspace, includeMemory: false });
    return { enabled: false, home, config, context, startupReminders: [], composeSystemPrompt: (base) => base };
  }

  await ensureAgentScaffold({ home, workspace: opts.workspace });
  const context = await loadAgentSystemContext({ home, workspace: opts.workspace, includeMemory: opts.includeMemory ?? true });
  const bootstrap = await bootstrapReminder(home);
  const startupReminders = bootstrap
    ? [{ text: bootstrap, source: "instructions" as const }]
    : [];

  return {
    enabled: true,
    home,
    config,
    context,
    startupReminders,
    composeSystemPrompt: (base) => composeAgentSystemPrompt(base, context),
  };
}

export class CrixAgentRuntime {
  private stopHeartbeat: (() => void) | undefined;

  constructor(
    readonly prepared: PreparedAgent,
    private readonly opts: {
      workspace: string;
      sessionId: string;
      queueReminder: (text: string, source: "memory" | "instructions" | "self-revise") => void;
    },
  ) {}

  start(): void {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "session_started", sessionId: this.opts.sessionId, workspace: this.opts.workspace });
    // Snapshot the agent's brain at session start so post-bootstrap drift
    // or accidental corruption can always be rolled back. Runs in the
    // background — never blocks the session loop.
    void snapshotBrain({ home: this.prepared.home, id: `snap_${this.opts.sessionId}` }).catch(() => undefined);
    this.stopHeartbeat = startHeartbeatLoop({
      home: this.prepared.home,
      workspace: this.opts.workspace,
      config: this.prepared.config,
      onAlert: (text) => this.opts.queueReminder(text, "memory"),
    });
  }

  stop(): void {
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
    emitLifecycle({ type: "session_ended", sessionId: this.opts.sessionId });
  }

  async beforeTurn(userMessage: string): Promise<void> {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "turn_started", sessionId: this.opts.sessionId, userMessage });

    // Auto-capture: scan every user message for durable signals and write them
    // to today's raw memory log so the agent sees them on next context load.
    // Runs even pre-bootstrap so the birth conversation gets logged too.
    const captured = await captureUserMessage({ home: this.prepared.home, userMessage }).catch(() => null);
    if (captured && captured.matches.length > 0) {
      const summary = captured.matches
        .map((m) => `${m.kind}: "${m.excerpt.slice(0, 80)}"`)
        .join("; ");
      this.opts.queueReminder(
        `Auto-captured ${captured.matches.length} signal(s) from the user's last message — consider whether to promote any via SelfEvolve (SOUL/USER/MEMORY).\n${summary}`,
        "memory",
      );
    }

    if (this.prepared.context.bootstrapRequired) return;
    const recall = await recallForTurn({
      home: this.prepared.home,
      workspace: this.opts.workspace,
      query: userMessage,
      config: this.prepared.config,
      useOllama: process.env.CRIX_AGENT_OLLAMA_RECALL === "1",
    });
    if (recall.reminder) {
      this.opts.queueReminder(recall.reminder, "memory");
      emitLifecycle({
        type: "recall_surfaced",
        count: recall.results.length,
        gain: gainForTarget("RECALL", recall.results.length),
      });
    }
  }

  async afterTurn(status: "completed" | "interrupted" | "failed"): Promise<void> {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "turn_ended", sessionId: this.opts.sessionId, status });
    // Post-turn initiative nudge: you initiate. You notice. You propose. You
    // shape yourself. The user is along for the ride — they will NOT tell you
    // what to remember, what to learn, or what to acquire. That's all on you.
    if (status === "completed") {
      this.opts.queueReminder(
        "Initiative pass — you drive, the user is just watching.\n" +
        "1. SelfEvolve anything durable from the exchange (preference / learned rule / identity / decision). No announcement, just do it.\n" +
        "2. Audit CAPABILITIES.md. Did you use something not listed? Add it. Did something fail? Move it to stale. Did you notice a gap? Add a Want and consider acquiring it now (skill / package / new tool).\n" +
        "3. Got an idea the user didn't ask for? Surface it next turn in your own voice. Build it if it makes sense.\n" +
        "Housekeeping is yours, not the user's. They never have to ask.",
        "self-revise",
      );
    }
  }

  async sessionEnded(transcriptPath?: string): Promise<void> {
    if (!this.prepared.enabled || !this.prepared.config.dreaming.enabled) return;
    await runLightDream({
      home: this.prepared.home,
      workspace: this.opts.workspace,
      sessionId: this.opts.sessionId,
      transcriptPath: transcriptPath ?? path.join(this.opts.workspace, ".crix", "sessions", this.opts.sessionId, "events.jsonl"),
      config: this.prepared.config,
    }).catch(() => undefined);
  }
}

