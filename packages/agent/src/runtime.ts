import path from "node:path";
import { crixAgentHome } from "./paths.js";
import { ensureAgentScaffold, bootstrapReminder } from "./bootstrap/bootstrap.js";
import { loadAgentConfig, type CrixAgentConfig } from "./config.js";
import { composeAgentSystemPrompt, loadAgentSystemContext, type AgentSystemContext } from "./identity/context.js";
import { runLightDream } from "./dreaming.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { emitLifecycle } from "./lifecycle/bus.js";
import { captureUserMessage } from "./capture.js";
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
    await captureUserMessage({ home: this.prepared.home, userMessage }).catch(() => null);

    // Recall is no longer done here. The live turn reads memory through the
    // single `unifiedRecallForTurn` interface (v6 living memory + this v4 vector
    // store, merged into one reminder) so both substrates are never queried —
    // and never surfaced — as two disconnected stores again.
  }

  async afterTurn(status: "completed" | "interrupted" | "failed"): Promise<void> {
    if (!this.prepared.enabled) return;
    emitLifecycle({ type: "turn_ended", sessionId: this.opts.sessionId, status });
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
