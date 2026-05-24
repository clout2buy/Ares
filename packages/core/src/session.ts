// Session — wraps QueryEngine with persistence and lifecycle.
//
// One Session per conversation. Each turn:
//   1. session.send(text) returns AsyncGenerator<TurnEvent>
//   2. Every event is appended to <workspace>/.crix/sessions/<id>/events.jsonl
//   3. Caller (CLI or TUI) consumes the same stream for display
//
// Full DAG fork/diff/rollback come in M4; M1 provides linear rollout.

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TurnEvent,
  SessionMeta,
  RolloutEntry,
  ProviderInfo,
} from "@crix/protocol";
import { QueryEngine, type EngineTool, type Provider } from "./queryEngine.js";

export interface SessionOptions {
  workspace: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  signal?: AbortSignal;
  /** Optional pre-set sessionId (for resume). Defaults to a fresh id. */
  sessionId?: string;
  /** Pending system-reminders to inject at next turn_start. */
  drainSystemReminders?: () => Array<{ text: string; source: "verifier" | "compaction" | "hook" | "skill" }>;
}

export class Session {
  readonly meta: SessionMeta;
  readonly engine: QueryEngine;
  private seq = 0;
  private readonly eventsPath: string;
  private readonly metaPath: string;
  private metaWritten = false;

  constructor(private readonly opts: SessionOptions) {
    const sessionId = opts.sessionId ?? `sess_${Date.now().toString(36)}_${randSuffix()}`;
    const providerInfo: ProviderInfo = { name: opts.provider.name, model: opts.model };
    this.meta = {
      id: sessionId,
      workspace: opts.workspace,
      provider: providerInfo,
      createdAt: new Date().toISOString(),
    };
    const sessionDir = path.join(opts.workspace, ".crix", "sessions", sessionId);
    this.eventsPath = path.join(sessionDir, "events.jsonl");
    this.metaPath = path.join(sessionDir, "meta.json");
    this.engine = new QueryEngine(
      {
        provider: opts.provider,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
        workspace: opts.workspace,
        signal: opts.signal,
        drainSystemReminders: opts.drainSystemReminders,
      },
      sessionId,
    );
  }

  /** Append a user message and stream the turn. Events persist to rollout. */
  async *send(text: string): AsyncGenerator<TurnEvent> {
    await this.ensureSessionDir();
    this.engine.appendUserMessage(text);
    for await (const event of this.engine.streamTurn()) {
      const entry: RolloutEntry = {
        ts: new Date().toISOString(),
        seq: this.seq++,
        event,
      };
      // Best-effort persistence — never let disk failure break the turn.
      appendFile(this.eventsPath, JSON.stringify(entry) + "\n", "utf8").catch(() => undefined);
      yield event;
    }
  }

  /** Read-only history snapshot. */
  history() {
    return this.engine.history();
  }

  private async ensureSessionDir(): Promise<void> {
    if (this.metaWritten) return;
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    await writeFile(this.metaPath, JSON.stringify(this.meta, null, 2) + "\n", "utf8");
    this.metaWritten = true;
  }
}

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
