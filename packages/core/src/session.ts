// Session — wraps QueryEngine with persistence and lifecycle.
//
// One Session per conversation. Each turn:
//   1. session.send(text) returns AsyncGenerator<TurnEvent>
//   2. Every event is appended to <workspace>/.ares/sessions/<id>/events.jsonl
//   3. Caller (CLI or TUI) consumes the same stream for display
//
// Full DAG fork/diff/rollback come in M4; M1 provides linear rollout.

import { mkdir, appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  messageText,
  type ContentBlock,
  type TurnEvent,
  type SessionMeta,
  type RolloutEntry,
  type ProviderInfo,
  type Message,
  type ToolResultBlock,
} from "@ares/protocol";
import { QueryEngine, stringifyModelToolOutput, type EngineTool, type Provider } from "./queryEngine.js";
import type { ToolPermissionRequest } from "./queryEngine.js";
import type { PermissionPromptDecision, ReasoningLevel } from "@ares/protocol";
import type { HookManager } from "./hooks.js";
import { createWorkspaceCheckpoint, diffWorkspaceCheckpointUnified } from "./checkpoints.js";

type ReminderSource =
  | "verifier"
  | "compaction"
  | "hook"
  | "skill"
  | "memory"
  | "instructions"
  | "undo"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";

export interface SessionOptions {
  workspace: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  signal?: AbortSignal;
  /** Optional pre-set sessionId (for resume). Defaults to a fresh id. */
  sessionId?: string;
  sessionMeta?: SessionMeta;
  initialMessages?: readonly Message[];
  initialSeq?: number;
  /** Pending system-reminders to inject at next turn_start. */
  drainSystemReminders?: () => Array<{ text: string; source: ReminderSource }>;
  hookManager?: HookManager;
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision>;
  /**
   * Absolute paths the engine treats as "self-territory" — writes inside
   * these roots bypass the write-intent gate. Used to give the agent
   * unrestricted authority over its own brain (~/.ares/).
   */
  selfTerritoryRoots?: readonly string[];
  /** Reasoning dial for reasoning-capable models (owner-selectable, low→max). */
  reasoningLevel?: ReasoningLevel;
  /** Output-token cap per provider call. */
  maxOutputTokens?: number;
  /** Trim oldest history to keep estimated input under this many tokens. */
  contextBudgetTokens?: number;
}

export class Session {
  readonly meta: SessionMeta;
  readonly engine: QueryEngine;
  private seq = 0;
  private readonly eventsPath: string;
  private readonly metaPath: string;
  private metaWritten = false;
  private lastCheckpointId: string | undefined;

  constructor(private readonly opts: SessionOptions) {
    const sessionId = opts.sessionMeta?.id ?? opts.sessionId ?? `sess_${randomUUID()}`;
    const providerInfo: ProviderInfo = { name: opts.provider.name, model: opts.model };
    this.meta = opts.sessionMeta ?? {
      id: sessionId,
      workspace: opts.workspace,
      provider: providerInfo,
      createdAt: new Date().toISOString(),
    };
    const sessionDir = path.join(opts.workspace, ".ares", "sessions", sessionId);
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
        hookManager: opts.hookManager,
        requestPermission: opts.requestPermission,
        selfTerritoryRoots: opts.selfTerritoryRoots,
        reasoningLevel: opts.reasoningLevel,
        maxOutputTokens: opts.maxOutputTokens,
        contextBudgetTokens: opts.contextBudgetTokens,
        beforeToolUseCheckpoint: async ({ toolUseId, toolName }) => {
          const checkpoint = await createWorkspaceCheckpoint({
            workspace: this.opts.workspace,
            sessionId: this.meta.id,
            turnSeq: this.seq,
            parentCheckpointId: this.lastCheckpointId,
            label: `before ${toolName} ${toolUseId}`,
          });
          this.lastCheckpointId = checkpoint.id;
          return { checkpointId: checkpoint.id, label: checkpoint.label };
        },
      },
      sessionId,
    );
    if (opts.initialMessages) this.engine.hydrate(opts.initialMessages);
    if (opts.initialSeq) this.seq = opts.initialSeq;
    if (opts.sessionMeta) this.metaWritten = true;
  }

  /** Change the reasoning dial mid-session — applies to the next turn. */
  setReasoningLevel(level: ReasoningLevel): void {
    this.engine.setReasoningLevel(level);
  }

  /** Append a user message and stream the turn. Events persist to rollout. */
  async *send(text: string): AsyncGenerator<TurnEvent> {
    yield* this.sendContent([{ type: "text", text }]);
  }

  /** Append arbitrary user content (text + image blocks) and stream the turn. */
  async *sendContent(content: ContentBlock[]): AsyncGenerator<TurnEvent> {
    await this.ensureSessionDir();
    this.engine.appendUserMessageContent(content);
    const preToolCheckpoints = new Map<string, string>();
    for await (const event of this.engine.streamTurn()) {
      await this.persistEvent(event);
      yield event;
      if (event.type === "checkpoint_created" && event.toolUseId && event.reason === "pre_tool") {
        preToolCheckpoints.set(event.toolUseId, event.checkpointId);
      }
      if (event.type === "tool_end" && event.touchedFiles && event.touchedFiles.length > 0) {
        const checkpointId = preToolCheckpoints.get(event.id);
        if (!checkpointId) continue;
        const diff = await diffWorkspaceCheckpointUnified(this.opts.workspace, checkpointId, event.touchedFiles).catch(() => null);
        if (!diff || !diff.diff) continue;
        const diffEvent: TurnEvent = {
          type: "workspace_diff",
          checkpointId,
          toolUseId: event.id,
          files: diff.files,
          diff: diff.diff,
          truncated: diff.truncated,
        };
        await this.persistEvent(diffEvent);
        yield diffEvent;
      }
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

  private async persistEvent(event: TurnEvent): Promise<void> {
    const entry: RolloutEntry = {
      ts: new Date().toISOString(),
      seq: this.seq++,
      event,
    };
    await appendFile(this.eventsPath, JSON.stringify(entry) + "\n", "utf8");
  }
}

export interface SessionSummary {
  id: string;
  workspace: string;
  provider: ProviderInfo;
  createdAt: string;
  updatedAt: string;
  eventCount: number;
  preview: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: Message[];
  nextSeq: number;
  eventCount: number;
  preview: string;
  compacted: boolean;
  omittedMessageCount: number;
  replayedMessageCount: number;
}

export interface LoadSessionSnapshotOptions {
  maxMessages?: number;
}

export async function listSessions(workspace: string, limit = 20): Promise<SessionSummary[]> {
  const root = path.join(workspace, ".ares", "sessions");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const summaries = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<SessionSummary | null> => {
        const sessionDir = path.join(root, entry.name);
        const meta = await readSessionMeta(sessionDir);
        if (!meta) return null;
        const eventsPath = path.join(sessionDir, "events.jsonl");
        const eventsText = await readFile(eventsPath, "utf8").catch(() => "");
        const eventCount = eventsText.trim() ? eventsText.trim().split(/\r?\n/).length : 0;
        const updated = await stat(eventsPath).catch(() => null);
        const preview = previewFromEvents(eventsText);
        return {
          id: meta.id,
          workspace: meta.workspace,
          provider: meta.provider,
          createdAt: meta.createdAt,
          updatedAt: updated?.mtime.toISOString() ?? meta.createdAt,
          eventCount,
          preview,
        };
      }),
  );
  return summaries
    .filter((s): s is SessionSummary => s !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function loadSessionSnapshot(
  workspace: string,
  sessionId: string,
  opts: LoadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const sessionDir = path.join(workspace, ".ares", "sessions", sessionId);
  const meta = await readSessionMeta(sessionDir);
  if (!meta) throw new Error(`session not found: ${sessionId}`);
  const eventsPath = path.join(sessionDir, "events.jsonl");
  const eventsText = await readFile(eventsPath, "utf8").catch(() => "");
  const entries = parseRolloutEntries(eventsText);
  const rawMessages = messagesFromRollout(entries);
  const replay = compactReplayMessages(rawMessages, sessionId, opts.maxMessages);
  const nextSeq = entries.length > 0 ? Math.max(...entries.map((entry) => entry.seq)) + 1 : 0;
  return {
    meta,
    messages: replay.messages,
    nextSeq,
    eventCount: entries.length,
    preview: previewFromMessages(rawMessages),
    compacted: replay.compacted,
    omittedMessageCount: replay.omittedMessageCount,
    replayedMessageCount: replay.messages.length,
  };
}

async function readSessionMeta(sessionDir: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

function parseRolloutEntries(text: string): RolloutEntry[] {
  const entries: RolloutEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as RolloutEntry);
    } catch {
      // Ignore a torn/corrupt tail line; the next append stays usable.
    }
  }
  return entries.sort((a, b) => a.seq - b.seq);
}

function messagesFromRollout(entries: readonly RolloutEntry[]): Message[] {
  const messages: Message[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      id: `replay_tool_${messages.length}`,
      role: "user", // Anthropic shape: tool_result blocks live in user-role messages
      content: pendingToolResults,
      createdAt: new Date().toISOString(),
      metadata: { source: "session-replay" },
    });
    pendingToolResults = [];
  };

  for (const entry of entries) {
    const event = entry.event;
    if (event.type === "turn_start") {
      flushToolResults();
      messages.push(event.userMessage);
      continue;
    }
    if (event.type === "message_done") {
      flushToolResults();
      messages.push(event.message);
      continue;
    }
    if (event.type === "tool_end") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: stringifyReplayOutput(event.output),
      });
      continue;
    }
    if (event.type === "tool_error") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: event.id,
        content: event.error,
        is_error: true,
      });
    }
  }
  flushToolResults();
  return messages;
}

function stringifyReplayOutput(output: unknown): string {
  return stringifyModelToolOutput(output);
}

function compactReplayMessages(
  messages: readonly Message[],
  sessionId: string,
  maxMessages?: number,
): { messages: Message[]; compacted: boolean; omittedMessageCount: number } {
  if (!maxMessages || messages.length <= maxMessages) {
    return { messages: [...messages], compacted: false, omittedMessageCount: 0 };
  }

  const tailBudget = Math.max(4, maxMessages - 1);
  const tail = messages.slice(-tailBudget);
  while (tail.length > 0 && tail[0].role !== "user") tail.shift();
  if (tail.length === 0) tail.push(...messages.slice(-Math.min(tailBudget, messages.length)));

  const omitted = messages.slice(0, messages.length - tail.length);
  const summary: Message = {
    id: `session_summary_${sessionId}`,
    role: "system",
    content: [{ type: "text", text: buildReplaySummary(sessionId, omitted) }],
    createdAt: new Date().toISOString(),
    metadata: { source: "session-replay-compaction", omittedMessageCount: omitted.length },
  };
  return {
    messages: [summary, ...tail],
    compacted: true,
    omittedMessageCount: omitted.length,
  };
}

function buildReplaySummary(sessionId: string, omitted: readonly Message[]): string {
  const roleCounts = omitted.reduce<Record<string, number>>((counts, message) => {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
    return counts;
  }, {});
  const toolResults = omitted.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
  const errorCount = toolResults.filter((block) => block.type === "tool_result" && block.is_error).length;
  const recentUsers = omitted
    .filter((message) => message.role === "user")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-8);
  const recentAssistants = omitted
    .filter((message) => message.role === "assistant")
    .map((message) => messageText(message).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-5);

  const lines = [
    `Previous Ares session ${sessionId} was compacted before resume.`,
    `Older replay omitted ${omitted.length} message(s): user=${roleCounts.user ?? 0}, assistant=${roleCounts.assistant ?? 0}, tool=${roleCounts.tool ?? 0}.`,
    `Omitted tool result blocks: ${toolResults.length}, errors: ${errorCount}.`,
  ];
  if (recentUsers.length > 0) {
    lines.push("Recent omitted user requests:");
    for (const text of recentUsers) lines.push(`- ${truncateSummaryText(text)}`);
  }
  if (recentAssistants.length > 0) {
    lines.push("Recent omitted assistant replies:");
    for (const text of recentAssistants) lines.push(`- ${truncateSummaryText(text)}`);
  }
  lines.push("The exact event log remains on disk under .ares/sessions if a tool needs to inspect it.");
  return lines.join("\n");
}

function truncateSummaryText(text: string): string {
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function previewFromEvents(text: string): string {
  return previewFromMessages(messagesFromRollout(parseRolloutEntries(text)));
}

function previewFromMessages(messages: readonly Message[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = lastUser ? messageText(lastUser).replace(/\s+/g, " ").trim() : "";
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}
