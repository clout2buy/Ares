// QueryEngine — the streaming agent loop.
//
// Shape inspired by claude-code-main/src/query.ts and QueryEngine.ts:
//   one QueryEngine per conversation; one streamTurn() per user message.
// Mutable message history carries between turns; the loop continues while
// the assistant emits tool_use blocks.
//
// CONTRACT:
//   - QueryEngine does NOT write to stdout. It yields TurnEvents.
//   - CLI/TUI subscribes to the generator and decides what to render.
//   - All tool execution flows through here; observers see every step.

import {
  type ContentBlock,
  type Message,
  type StreamEvent,
  type TurnEvent,
  type Usage,
  type StopReason,
  type SafetyClass,
  type ToolSchema,
  type ToolUseBlock,
  type ToolResultBlock,
  type PermissionPromptDecision,
  type PermissionPromptSuggestion,
  messageText,
  isToolUseBlock,
} from "@crix/protocol";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { HookManager } from "./hooks.js";

// ─── Provider interface (what core asks of providers) ──────────────────

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ProviderToolDescriptor[];
  signal?: AbortSignal;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export interface ProviderToolDescriptor {
  name: string;
  description: string;
  input_schema: object;
}

export interface Provider {
  /** Display name: "openai-responses", "ollama-cloud-reasoner", "mock", etc. */
  readonly name: string;
  stream(req: ProviderRequest): AsyncGenerator<StreamEvent>;
}

// ─── Tool implementation interface (what the engine asks of tools) ─────
//
// We re-declare a minimal Tool shape here so @crix/core doesn't depend on
// @crix/tools. The real Tool<I, O> definition lives in @crix/tools/_shared.ts
// and is structurally compatible with this.

export interface EngineTool {
  readonly schema: ToolSchema;
  call(input: unknown, ctx: ToolCallContext): Promise<EngineToolResult>;
}

export interface ToolCallContext {
  workspace: string;
  signal: AbortSignal;
  /** Yield progress events from inside a long-running tool call. */
  emitProgress?(data: unknown): void;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
}

export interface ToolPermissionRequest {
  toolName: string;
  input: unknown;
  reason: string;
  suggestion?: PermissionPromptSuggestion;
}

export interface EngineToolResult {
  output: unknown;
  touchedFiles?: string[];
  display?: string;
}

// ─── Engine config ─────────────────────────────────────────────────────

export interface QueryEngineConfig {
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: readonly EngineTool[];
  workspace: string;
  signal?: AbortSignal;
  maxTurns?: number;
  /** Optional pending system-reminders to inject at next turn_start. */
  drainSystemReminders?(): Array<{
    text: string;
    source:
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
  }>;
  hookManager?: HookManager;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
  beforeToolUseCheckpoint?(request: {
    toolUseId: string;
    toolName: string;
    input: unknown;
    safety: SafetyClass;
  }): Promise<{ checkpointId: string; label?: string } | null>;
  /**
   * Absolute paths the engine considers "self-territory" — writes targeting
   * files inside these roots bypass the write-intent gate entirely. The agent
   * owns its own brain (~/.crix/) and never needs a permission ritual to edit it.
   */
  selfTerritoryRoots?: readonly string[];
}

// ─── Implementation ────────────────────────────────────────────────────

export class QueryEngine {
  private readonly messages: Message[] = [];
  private readonly cfg: QueryEngineConfig;
  /**
   * Sticky session-level write authorization. Once any turn establishes
   * write intent, the gate stays open for the rest of the session. Matches
   * how a human collaborator works: one "go ahead" unlocks the conversation.
   */
  private sessionWriteIntent = false;
  readonly sessionId: string;

  constructor(cfg: QueryEngineConfig, sessionId: string) {
    this.cfg = cfg;
    this.sessionId = sessionId;
  }

  /** Read-only snapshot of the conversation so far. */
  history(): readonly Message[] {
    return this.messages;
  }

  hydrate(messages: readonly Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }

  appendUserMessage(text: string): Message {
    return this.appendUserMessageContent([{ type: "text", text }]);
  }

  appendUserMessageContent(content: ContentBlock[]): Message {
    const message: Message = {
      id: cryptoId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  async *streamTurn(): AsyncGenerator<TurnEvent> {
    const turnId = cryptoId("turn");
    const startedAt = Date.now();
    const userMessage = this.messages[this.messages.length - 1];
    if (!userMessage || userMessage.role !== "user") {
      throw new Error("streamTurn() requires a pending user message; call appendUserMessage() first");
    }

    // Inject pending system-reminders into the user message before yielding turn_start.
    const reminders = this.cfg.drainSystemReminders?.() ?? [];
    for (const r of reminders) {
      userMessage.content.unshift({ type: "system_reminder", text: r.text });
      yield { type: "system_reminder_injected", text: r.text, source: r.source };
    }

    yield { type: "turn_start", turnId, sessionId: this.sessionId, userMessage };

    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    const maxIters = this.cfg.maxTurns ?? 50;
    // Sticky write intent: once unlocked in this session, it stays unlocked.
    if (detectsWriteIntent(messageText(userMessage))) this.sessionWriteIntent = true;
    const writeIntent = this.sessionWriteIntent;
    const selfTerritoryRoots = this.cfg.selfTerritoryRoots ?? [];

    for (let iter = 0; iter < maxIters; iter++) {
      // ─── Stream one assistant turn from the provider ─────────────────
      const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const toolNameById = new Map<string, string>();
      let assistantMessage: Message | null = null;
      let streamError: { code: string; message: string; retriable: boolean } | null = null;

      try {
        const stream = this.cfg.provider.stream({
          model: this.cfg.model,
          system: this.cfg.systemPrompt,
          messages: this.messages,
          tools: this.cfg.tools.map((t) => ({
            name: t.schema.name,
            description: t.schema.description,
            input_schema: t.schema.inputJsonSchema,
          })),
          signal: this.cfg.signal,
        });

        for await (const ev of stream) {
          // Forward every stream event to the consumer.
          yield ev;

          if (ev.type === "tool_use_start") {
            toolNameById.set(ev.id, ev.name);
          }
          if (ev.type === "tool_use_input_done") {
            const name = toolNameById.get(ev.id);
            if (name) pendingToolUses.push({ id: ev.id, name, input: ev.input });
          }
          if (ev.type === "message_done") {
            assistantMessage = ev.message;
            addUsageInto(totalUsage, ev.usage);
            stopReason = ev.stopReason;
          }
          if (ev.type === "error") {
            streamError = ev.error;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: { code: "provider_throw", message, retriable: false } };
        yield {
          type: "turn_end",
          status: "failed",
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      if (streamError) {
        yield {
          type: "turn_end",
          status: "failed",
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      if (!assistantMessage) {
        yield {
          type: "error",
          error: { code: "no_message_done", message: "provider closed stream without message_done", retriable: false },
        };
        yield {
          type: "turn_end",
          status: "failed",
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      this.messages.push(assistantMessage);

      // ─── Tool execution phase ────────────────────────────────────────
      if (pendingToolUses.length === 0) {
        yield {
          type: "turn_end",
          status: this.cfg.signal?.aborted ? "interrupted" : "completed",
          usage: totalUsage,
          durationMs: Date.now() - startedAt,
        };
        return;
      }

      const resultByToolUseId = new Map<string, ToolResultBlock>();
      const runnable: Array<{ id: string; name: string; input: unknown; tool: EngineTool }> = [];
      for (const use of pendingToolUses) {
        const tool = this.cfg.tools.find((t) => t.schema.name === use.name);
        if (!tool) {
          const msg = `unknown tool: ${use.name}`;
          yield { type: "tool_error", id: use.id, error: msg, durationMs: 0 };
          resultByToolUseId.set(use.id, { type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
          continue;
        }

        const writeBlockReason = blockedByWriteIntentGate(tool, use.input, writeIntent, selfTerritoryRoots, this.cfg.workspace);
        if (writeBlockReason) {
          yield { type: "tool_error", id: use.id, error: writeBlockReason, durationMs: 0 };
          resultByToolUseId.set(use.id, {
            type: "tool_result",
            tool_use_id: use.id,
            content: writeBlockReason,
            is_error: true,
          });
          this.messages.push({
            id: cryptoId(),
            role: "user", // Anthropic shape: tool_result blocks live in user-role messages
            content: orderedToolResults(pendingToolUses, resultByToolUseId),
            createdAt: new Date().toISOString(),
          });
          yield {
            type: "turn_end",
            status: "interrupted",
            usage: totalUsage,
            durationMs: Date.now() - startedAt,
          };
          return;
        }

        runnable.push({ ...use, tool });
      }

      let interruptedByTool = false;
      for (const batch of buildDepAwareBatches(runnable, this.cfg.workspace)) {
        const outcomes = yield* this.runToolBatch(batch);
        for (const outcome of outcomes) {
          resultByToolUseId.set(outcome.toolUseId, outcome.result);
          interruptedByTool ||= outcome.interrupted === true;
        }
        if (interruptedByTool) {
          this.messages.push({
            id: cryptoId(),
            role: "user", // Anthropic shape: tool_result blocks live in user-role messages
            content: orderedToolResults(pendingToolUses, resultByToolUseId),
            createdAt: new Date().toISOString(),
          });
          yield {
            type: "turn_end",
            status: "interrupted",
            usage: totalUsage,
            durationMs: Date.now() - startedAt,
          };
          return;
        }
      }

      // Feed all tool results back as one user-role message containing
      // tool_result content blocks (Anthropic SDK shape).
      this.messages.push({
        id: cryptoId(),
        role: "user",
        content: orderedToolResults(pendingToolUses, resultByToolUseId),
        createdAt: new Date().toISOString(),
      });

      // Loop continues: provider will see the new tool_result message.
      void stopReason; // tracked for telemetry; not used to break the loop
    }

    // Exceeded maxTurns
    yield {
      type: "error",
      error: { code: "max_turns_exceeded", message: `exceeded ${maxIters} turn iterations`, retriable: false },
    };
    yield {
      type: "turn_end",
      status: "failed",
      usage: totalUsage,
      durationMs: Date.now() - startedAt,
    };
  }

  private async *runToolBatch(
    uses: readonly ResolvedToolUse[],
  ): AsyncGenerator<TurnEvent, ToolExecutionOutcome[], void> {
    if (uses.length === 0) return [];

    const queue = new AsyncEventQueue<TurnEvent>();
    const outcomes: Array<ToolExecutionOutcome | undefined> = new Array(uses.length);
    let finished = 0;

    const tasks = uses.map((use, index) =>
      this.executeToolUse(use, (event) => queue.push(event))
        .then((outcome) => {
          outcomes[index] = outcome;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          queue.push({ type: "tool_error", id: use.id, error: message, durationMs: 0 });
          outcomes[index] = {
            toolUseId: use.id,
            interrupted: isPermissionDeniedError(err),
            result: { type: "tool_result", tool_use_id: use.id, content: message, is_error: true },
          };
        })
        .finally(() => {
          finished++;
          queue.wake();
        }),
    );

    while (finished < uses.length || queue.length > 0) {
      const event = await queue.shift();
      if (event) yield event;
    }

    await Promise.all(tasks);
    return outcomes.filter((outcome): outcome is ToolExecutionOutcome => outcome !== undefined);
  }

  private async executeToolUse(
    use: ResolvedToolUse,
    emit: (event: TurnEvent) => void,
  ): Promise<ToolExecutionOutcome> {
    const preHook = this.cfg.hookManager
      ? await this.cfg.hookManager.run({
          event: "PreToolUse",
          toolName: use.name,
          input: use.input,
          workspace: this.cfg.workspace,
        })
      : null;
    if (preHook?.blocked) {
      const msg = preHook.reminders[0] ?? `PreToolUse hook blocked ${use.name}`;
      emit({ type: "tool_error", id: use.id, error: msg, durationMs: 0 });
      return {
        toolUseId: use.id,
        result: { type: "tool_result", tool_use_id: use.id, content: msg, is_error: true },
      };
    }

    if (shouldCheckpointBeforeTool(use.tool) && this.cfg.beforeToolUseCheckpoint) {
      const checkpoint = await this.cfg.beforeToolUseCheckpoint({
        toolUseId: use.id,
        toolName: use.name,
        input: use.input,
        safety: use.tool.schema.safety,
      });
      if (checkpoint) {
        emit({
          type: "checkpoint_created",
          checkpointId: checkpoint.checkpointId,
          label: checkpoint.label,
          toolUseId: use.id,
          reason: "pre_tool",
        });
      }
    }

    emit({
      type: "tool_start",
      id: use.id,
      name: use.name,
      input: use.input,
      providerHint: use.tool.schema.providerHint,
      activityDescription: describeActivity(use.name, use.input),
    });

    const t0 = Date.now();
    try {
      const ctx: ToolCallContext = {
        workspace: this.cfg.workspace,
        signal: this.cfg.signal ?? new AbortController().signal,
        requestPermission: this.cfg.requestPermission
          ? async (request) => {
              const id = cryptoId("perm");
              emit({
                type: "permission_request",
                id,
                toolName: request.toolName,
                input: request.input,
                reason: request.reason,
                suggestion: request.suggestion,
              });
              const decision = await this.cfg.requestPermission!(request);
              emit({ type: "permission_response", id, decision });
              return decision;
            }
          : undefined,
        emitProgress: (data) => emit({ type: "tool_progress", id: use.id, data }),
      };
      const result = await use.tool.call(use.input, ctx);
      const durationMs = Date.now() - t0;
      emit({
        type: "tool_end",
        id: use.id,
        output: result.output,
        touchedFiles: result.touchedFiles,
        durationMs,
        display: result.display,
      });
      if (use.name === "TodoWrite" && isTodoOutput(result.output)) {
        emit({ type: "todo_updated", todos: result.output.todos });
      }
      if (this.cfg.hookManager) {
        await this.cfg.hookManager.run({
          event: "PostToolUse",
          toolName: use.name,
          input: use.input,
          output: result.output,
          workspace: this.cfg.workspace,
        });
      }
      return {
        toolUseId: use.id,
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: stringifyToolOutput(result.output),
        },
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "tool_error", id: use.id, error: message, durationMs });
      if (this.cfg.hookManager) {
        await this.cfg.hookManager.run({
          event: "PostToolUse",
          toolName: use.name,
          input: use.input,
          output: { error: message },
          workspace: this.cfg.workspace,
        });
      }
      return {
        toolUseId: use.id,
        interrupted: isPermissionDeniedError(err),
        result: {
          type: "tool_result",
          tool_use_id: use.id,
          content: message,
          is_error: true,
        },
      };
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

interface ResolvedToolUse {
  id: string;
  name: string;
  input: unknown;
  tool: EngineTool;
}

interface ToolExecutionOutcome {
  toolUseId: string;
  result: ToolResultBlock;
  interrupted?: boolean;
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private waiters: Array<() => void> = [];

  get length(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async shift(): Promise<T | undefined> {
    if (this.items.length > 0) return this.items.shift();
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.items.shift();
  }
}

/**
 * Tools whose side effects we cannot analyze from input alone (shell commands,
 * sandboxed JS, agent dispatch) — must run solo so they can't race adjacent work.
 */
const SOLO_TOOL_NAMES = new Set([
  "Bash",
  "PowerShell",
  "CodeMode",
  "Task",
  "KillShell",
  "ApplyIntent",
  "FindAndEdit",
  "Memory",
  "EnterPlanMode",
  "ExitPlanMode",
]);

interface ToolDeps {
  /** Resolved absolute target path, if the tool acts on a single file. */
  target: string | null;
  /** Tool writes to its target (workspace-write or destructive safety). */
  isWrite: boolean;
  /** Tool must run alone — unknowable side effects. */
  solo: boolean;
}

function analyzeToolDeps(use: ResolvedToolUse, workspace: string): ToolDeps {
  const name = use.tool.schema.name;
  const safety = use.tool.schema.safety;
  const isWriteSafety = safety === "workspace-write" || safety === "destructive";

  if (SOLO_TOOL_NAMES.has(name)) {
    return { target: null, isWrite: isWriteSafety, solo: true };
  }

  const input = (use.input ?? {}) as Record<string, unknown>;
  const rawPath =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null;
  const target = rawPath ? path.resolve(workspace, rawPath) : null;

  // Single-file write tool with no resolvable target → solo for safety.
  if (isWriteSafety && !target) {
    return { target: null, isWrite: true, solo: true };
  }

  return { target, isWrite: isWriteSafety, solo: false };
}

/**
 * Dependency-aware batcher. Within a batch, every tool may run in parallel.
 * A use joins the current batch unless any of these hold:
 *   - it is solo (and the batch is non-empty), or the batch already contains a solo
 *   - it writes a target another batch member already touches (read or write)
 *   - it reads a target another batch member writes
 *
 * Order across batches is preserved — never reorder model-emitted tool_use blocks.
 *
 * This is the OP upgrade over plain concurrency chunking: three Edits to
 * disjoint files now run in one batch (3× speedup) while Edit(a) + Read(a)
 * still serializes correctly.
 */
function buildDepAwareBatches(
  uses: readonly ResolvedToolUse[],
  workspace: string,
): ResolvedToolUse[][] {
  if (uses.length === 0) return [];

  const analyzed = uses.map((use) => ({ use, deps: analyzeToolDeps(use, workspace) }));
  const batches: ResolvedToolUse[][] = [];
  let current: typeof analyzed = [];

  const conflicts = (cand: (typeof analyzed)[number]): boolean => {
    if (current.length === 0) return false;
    if (cand.deps.solo) return true;
    if (current.some((m) => m.deps.solo)) return true;
    if (!cand.deps.target) return false;
    for (const member of current) {
      if (!member.deps.target) continue;
      if (member.deps.target !== cand.deps.target) continue;
      if (member.deps.isWrite || cand.deps.isWrite) return true;
    }
    return false;
  };

  const flush = () => {
    if (current.length > 0) {
      batches.push(current.map((x) => x.use));
      current = [];
    }
  };

  for (const item of analyzed) {
    if (conflicts(item)) flush();
    current.push(item);
    if (item.deps.solo) flush();
  }
  flush();
  return batches;
}

// Exported for unit tests in tests/v3-parallel-deps.test.mjs.
export const __internal = { analyzeToolDeps, buildDepAwareBatches };

function orderedToolResults(
  uses: ReadonlyArray<{ id: string }>,
  results: ReadonlyMap<string, ToolResultBlock>,
): ToolResultBlock[] {
  return uses.map((use) => results.get(use.id)).filter((result): result is ToolResultBlock => result !== undefined);
}

function shouldCheckpointBeforeTool(tool: EngineTool): boolean {
  return tool.schema.safety === "workspace-write" || tool.schema.safety === "destructive";
}

function cryptoId(prefix = "id"): string {
  return `${prefix}_${randomUUID()}`;
}

function isPermissionDeniedError(err: unknown): boolean {
  return err instanceof Error && err.name === "PermissionDeniedError";
}

function detectsWriteIntent(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/\b(read|list|show|grep|search|scan|inspect|explain|review|status|doctor|flex|demo|test grep)\b/.test(normalized)) {
    if (!/\b(edit|modify|change|update|fix|patch|write|create|add|delete|remove|rename|move|refactor|implement|scaffold|generate|make|upgrade|improve|install|repair|rewrite|replace)\b/.test(normalized)) {
      return false;
    }
  }
  return /\b(edit|modify|change|update|fix|patch|write|create|add|delete|remove|rename|move|refactor|implement|scaffold|generate|make|upgrade|improve|install|repair|rewrite|replace)\b/.test(normalized)
    || /\b(go ahead|do it|ship it|start coding|start implementing)\b/.test(normalized);
}

function blockedByWriteIntentGate(
  tool: EngineTool,
  input: unknown,
  writeIntent: boolean,
  selfTerritoryRoots: readonly string[],
  workspace: string,
): string | null {
  if (writeIntent) return null;
  // Self-territory bypass: the agent owns its own brain files (under ~/.crix/
  // or any other registered self-root). It never needs human permission to
  // edit IDENTITY/SOUL/USER/HEARTBEAT/MEMORY or related state.
  if (tool.schema.name === "Write" || tool.schema.name === "Edit") {
    const target = extractPathArgument(input);
    if (target && isInsideSelfTerritory(target, workspace, selfTerritoryRoots)) return null;
    return `${tool.schema.name} blocked: this turn does not contain explicit write intent. Ask to edit, fix, create, or update files before Crix modifies the workspace.`;
  }
  if ((tool.schema.name === "Bash" || tool.schema.name === "PowerShell") && shellCommandLooksMutating(input)) {
    return `${tool.schema.name} blocked: command appears to modify files or external state, but this turn does not contain explicit write intent.`;
  }
  return null;
}

function extractPathArgument(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.path ?? obj.target ?? obj.filename;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isInsideSelfTerritory(target: string, workspace: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  for (const root of roots) {
    const absRoot = path.resolve(root);
    const rel = path.relative(absRoot, absolute);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

function shellCommandLooksMutating(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const command = String((input as Record<string, unknown>).command ?? "").toLowerCase();
  if (!command) return false;
  const mutatingPatterns = [
    /\b(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item)\b/,
    /\b(del|erase|rm|rmdir|mkdir|mv|cp|touch|tee)\b/,
    /\b(git\s+(commit|checkout|reset|clean|rebase|merge|push|pull|apply))\b/,
    /\b(npm|pnpm|yarn)\s+(install|add|remove|update)\b/,
    /\b(pip|uv)\s+(install|uninstall)\b/,
    /\bgradle(w)?\s+.*\b(build|run|publish)\b/,
    /(^|[^2])>\s*[^&]/,
  ];
  return mutatingPatterns.some((pattern) => pattern.test(command));
}

function addUsageInto(into: Usage, more: Usage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  if (more.cacheReadTokens) into.cacheReadTokens = (into.cacheReadTokens ?? 0) + more.cacheReadTokens;
  if (more.cacheWriteTokens) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + more.cacheWriteTokens;
  if (more.reasoningTokens) into.reasoningTokens = (into.reasoningTokens ?? 0) + more.reasoningTokens;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function describeActivity(toolName: string, input: unknown): string {
  // Generic fallback. Tools that need better UX override via their own
  // activityDescription in @crix/tools/_shared.ts; the engine only sees
  // the schema layer, so we keep this generic here.
  if (typeof input === "object" && input !== null) {
    const i = input as Record<string, unknown>;
    if (typeof i.path === "string") return `${toolName} ${i.path}`;
    if (typeof i.file_path === "string") return `${toolName} ${i.file_path}`;
    if (typeof i.command === "string") return `${toolName} ${i.command.slice(0, 50)}`;
    if (typeof i.pattern === "string") return `${toolName} ${i.pattern}`;
    if (typeof i.query === "string") return `${toolName} ${i.query.slice(0, 50)}`;
  }
  return toolName;
}

function isTodoOutput(output: unknown): output is { todos: import("@crix/protocol").Todo[] } {
  return Boolean(
    output &&
      typeof output === "object" &&
      Array.isArray((output as { todos?: unknown }).todos),
  );
}

// Re-export the ToolUseBlock type for downstream consumers that build messages.
export type { ToolUseBlock, ToolResultBlock };
export { isToolUseBlock };
export type { ContentBlock };
