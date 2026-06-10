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
  type ReasoningLevel,
  isToolUseBlock,
} from "@ares/protocol";
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
  /** Unified reasoning dial; each provider translates it (effort vs budget). */
  reasoningLevel?: ReasoningLevel;
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
// We re-declare a minimal Tool shape here so @ares/core doesn't depend on
// @ares/tools. The real Tool<I, O> definition lives in @ares/tools/_shared.ts
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
  id?: string;
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
  /** Reasoning dial for reasoning-capable models. Owner-selectable (low→max);
   *  translated per provider (OpenAI effort, Ollama/Anthropic thinking budget). */
  reasoningLevel?: ReasoningLevel;
  /** Cap on output tokens per provider call. */
  maxOutputTokens?: number;
  /** If > 0, the engine trims the OLDEST conversation history to keep the
   *  estimated input (system + tools + messages) under this many tokens, so a
   *  long thread can never hard-fail with context_length_exceeded. The pending
   *  user message and recent context are always kept. */
  contextBudgetTokens?: number;
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
   * owns its own brain (~/.ares/) and never needs a permission ritual to edit it.
   */
  selfTerritoryRoots?: readonly string[];
}

// ─── Context budgeting ─────────────────────────────────────────────────
//
// No tokenizer dependency: a ~4-chars/token heuristic plus a flat per-image
// cost. Good enough to keep a runaway thread from blowing the model's window —
// the goal is "never hard-fail with context_length_exceeded," not exactness.

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1024; // a high-detail image's rough tile cost

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(m: Message): number {
  let t = 8; // per-message role/framing overhead
  for (const b of m.content) {
    switch (b.type) {
      case "text":
      case "thinking":
        t += estimateTextTokens(b.text);
        break;
      case "system_reminder":
        t += estimateTextTokens(b.text) + 8;
        break;
      case "tool_result":
        t += estimateTextTokens(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
        break;
      case "tool_use":
        t += estimateTextTokens(b.name) + estimateTextTokens(JSON.stringify(b.input));
        break;
      case "image":
        t += IMAGE_TOKEN_ESTIMATE;
        break;
    }
  }
  return t;
}

/** A user message whose first block is a tool_result — would orphan into a
 *  function_call_output with no preceding call if it led the kept window. */
function leadsWithToolResult(m: Message): boolean {
  return m.role === "user" && m.content[0]?.type === "tool_result";
}

/**
 * Trim the OLDEST messages until the estimated total fits the budget. Always
 * keeps the final (pending) message and never leaves a leading orphan
 * tool_result. Returns the original array untouched when already within budget
 * or when budgeting is disabled.
 */
export function budgetMessages(
  messages: readonly Message[],
  budgetTokens: number,
  overheadTokens: number,
): { messages: Message[]; trimmed: number } {
  if (budgetTokens <= 0 || messages.length <= 1) return { messages: [...messages], trimmed: 0 };
  let total = overheadTokens + messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
  if (total <= budgetTokens) return { messages: [...messages], trimmed: 0 };

  const kept = [...messages];
  let trimmed = 0;
  while (total > budgetTokens && kept.length > 1) {
    total -= estimateMessageTokens(kept.shift()!);
    trimmed++;
  }
  while (kept.length > 1 && leadsWithToolResult(kept[0])) {
    total -= estimateMessageTokens(kept.shift()!);
    trimmed++;
  }
  return { messages: kept, trimmed };
}

// ─── Implementation ────────────────────────────────────────────────────

export class QueryEngine {
  private readonly messages: Message[] = [];
  private readonly cfg: QueryEngineConfig;
  readonly sessionId: string;

  constructor(cfg: QueryEngineConfig, sessionId: string) {
    this.cfg = cfg;
    this.sessionId = sessionId;
  }

  /** Read-only snapshot of the conversation so far. */
  history(): readonly Message[] {
    return this.messages;
  }

  /** Change the reasoning dial mid-session — applies to the next turn. */
  setReasoningLevel(level: ReasoningLevel): void {
    this.cfg.reasoningLevel = level;
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

    // Inject pending system-reminders into the user message before yielding
    // turn_start. The turn_start event remains first for stable rollout/daemon
    // consumers, and reminder telemetry follows immediately after.
    const reminders = this.cfg.drainSystemReminders?.() ?? [];
    for (const r of reminders) {
      userMessage.content.unshift({ type: "system_reminder", text: r.text });
    }

    yield { type: "turn_start", turnId, sessionId: this.sessionId, userMessage };
    for (const r of reminders) {
      yield { type: "system_reminder_injected", text: r.text, source: r.source };
    }

    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    const maxIters = this.cfg.maxTurns ?? 50;

    for (let iter = 0; iter < maxIters; iter++) {
      // ─── Stream one assistant turn from the provider ─────────────────
      const pendingToolUses: Array<{ id: string; name: string; input: unknown }> = [];
      const toolNameById = new Map<string, string>();
      let assistantMessage: Message | null = null;
      let streamError: { code: string; message: string; retriable: boolean } | null = null;

      try {
        const toolDescriptors = this.cfg.tools.map((t) => ({
          name: t.schema.name,
          description: t.schema.description,
          input_schema: t.schema.inputJsonSchema,
        }));
        const overheadTokens =
          estimateTextTokens(this.cfg.systemPrompt) +
          toolDescriptors.reduce(
            (s, t) => s + estimateTextTokens(t.name) + estimateTextTokens(t.description) + estimateTextTokens(JSON.stringify(t.input_schema)) + 8,
            0,
          );

        const budgetAttempts = contextBudgetAttempts(this.cfg.contextBudgetTokens ?? 0);
        for (let attempt = 0; attempt < budgetAttempts.length; attempt++) {
          pendingToolUses.length = 0;
          toolNameById.clear();
          assistantMessage = null;
          streamError = null;

          const budgeted = budgetMessages(this.messages, budgetAttempts[attempt], overheadTokens);
          const stream = this.cfg.provider.stream({
            model: this.cfg.model,
            system: this.cfg.systemPrompt,
            messages: budgeted.messages,
            tools: toolDescriptors,
            signal: this.cfg.signal,
            reasoningLevel: this.cfg.reasoningLevel,
            maxOutputTokens: this.cfg.maxOutputTokens,
          });

          let modelStarted = false;
          for await (const ev of stream) {
            if (
              ev.type === "error" &&
              isContextLimitError(ev.error) &&
              !modelStarted &&
              attempt < budgetAttempts.length - 1
            ) {
              streamError = ev.error;
              break;
            }

            // Forward every stream event to the consumer.
            yield ev;

            if (isModelOutputEvent(ev)) modelStarted = true;
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

          if (
            streamError &&
            isContextLimitError(streamError) &&
            !modelStarted &&
            attempt < budgetAttempts.length - 1
          ) {
            yield {
              type: "system_reminder_injected",
              text: `Provider rejected the prompt as too large; retrying with a smaller recent-history window (${budgetAttempts[attempt + 1].toLocaleString()} tokens).`,
              source: "compaction",
            };
            continue;
          }
          break;
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
          fillMissingToolResults(pendingToolUses, resultByToolUseId, "tool skipped after permission interruption");
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

      // Convergence guard: after a soft cap of tool rounds, force the model to
      // stop gathering and answer with what it has. Weak models otherwise loop
      // (re-searching/re-fetching) and never deliver. Fires once.
      const softCap = Math.min(12, maxIters - 1);
      if (iter + 1 === softCap) {
        this.messages.push({
          id: cryptoId(),
          role: "user",
          content: [{
            type: "system_reminder",
            text: "You've gathered plenty — STOP calling tools now and write your final answer with what you already have. If the user asked to SEE images, include the image URLs / screenshots you already captured. Do not start new searches, fetches, or browser actions.",
          }],
          createdAt: new Date().toISOString(),
        });
        yield { type: "system_reminder_injected", text: "convergence: wrap up and answer now", source: "instructions" };
      }

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
              const requestWithId = { ...request, id };
              emit({
                type: "permission_request",
                id,
                toolName: request.toolName,
                input: request.input,
                reason: request.reason,
                suggestion: request.suggestion,
              });
              const decision = await this.cfg.requestPermission!(requestWithId);
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
          content: stringifyModelToolOutput(result.output),
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

function fillMissingToolResults(
  uses: ReadonlyArray<{ id: string }>,
  results: Map<string, ToolResultBlock>,
  message: string,
): void {
  for (const use of uses) {
    if (results.has(use.id)) continue;
    results.set(use.id, {
      type: "tool_result",
      tool_use_id: use.id,
      content: message,
      is_error: true,
    });
  }
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

function addUsageInto(into: Usage, more: Usage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  if (more.cacheReadTokens) into.cacheReadTokens = (into.cacheReadTokens ?? 0) + more.cacheReadTokens;
  if (more.cacheWriteTokens) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + more.cacheWriteTokens;
  if (more.reasoningTokens) into.reasoningTokens = (into.reasoningTokens ?? 0) + more.reasoningTokens;
}

export function stringifyModelToolOutput(output: unknown): string {
  const text = stringifyToolOutput(output);
  const maxChars = toolResultCharBudget();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[tool result truncated for model: ${text.length - maxChars} chars omitted; ask to read a narrower range if needed]`;
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function toolResultCharBudget(): number {
  const raw = Number(process.env.ARES_TOOL_RESULT_CHARS);
  if (Number.isFinite(raw) && raw > 1_000) return Math.floor(raw);
  return 24_000;
}

function contextBudgetAttempts(configuredBudgetTokens: number): number[] {
  if (configuredBudgetTokens <= 0) return [0, 32_000, 16_000, 8_000, 4_000];
  const candidates = [
    configuredBudgetTokens,
    Math.floor(configuredBudgetTokens * 0.5),
    Math.floor(configuredBudgetTokens * 0.25),
    8_000,
    4_000,
  ];
  const seen = new Set<number>();
  return candidates
    .filter((budget) => budget > 0 && budget <= configuredBudgetTokens)
    .map((budget) => Math.floor(budget))
    .sort((a, b) => b - a)
    .filter((budget) => {
      if (seen.has(budget)) return false;
      seen.add(budget);
      return true;
    });
}

function isContextLimitError(error: { code: string; message: string }): boolean {
  const text = `${error.code} ${error.message}`.toLowerCase();
  return (
    text.includes("context_length_exceeded") ||
    text.includes("prompt too long") ||
    text.includes("prompt is too long") ||
    text.includes("max context") ||
    text.includes("context window") ||
    text.includes("maximum context") ||
    text.includes("input length") ||
    text.includes("too many tokens") ||
    text.includes("exceeded max context")
  );
}

function isModelOutputEvent(ev: StreamEvent): boolean {
  return (
    ev.type === "text_delta" ||
    ev.type === "thinking_delta" ||
    ev.type === "tool_use_start" ||
    ev.type === "tool_use_input_delta" ||
    ev.type === "tool_use_input_done" ||
    ev.type === "message_done"
  );
}

function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed || p;
}

function hostOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
    return u.host.replace(/^www\./, "") || rawUrl;
  } catch {
    return rawUrl.replace(/^https?:\/\//, "").split(/[/?#]/)[0] || rawUrl;
  }
}

function summarizeShellCommand(raw: string, background: boolean): string {
  const cmd = raw.trim().replace(/\s+/g, " ");
  const lower = cmd.toLowerCase();
  const lead = (verb: string) => (background ? `${verb} in the background` : verb);
  // Git intents — narrate the topic, not the flags.
  const branch = /git\s+(?:checkout|switch)\s+(?:-b\s+)?([^\s&|;]+)/.exec(cmd);
  if (branch) return lead(`Switching to ${branch[1]}`);
  if (/git\s+commit/.test(lower)) return lead("Committing changes");
  if (/git\s+push/.test(lower)) return lead("Pushing to remote");
  if (/git\s+pull/.test(lower)) return lead("Pulling from remote");
  if (/git\s+status/.test(lower)) return lead("Checking git status");
  if (/git\s+(diff|log|show)/.test(lower)) return lead("Inspecting git history");
  if (/\bgit\b/.test(lower)) return lead("Running git");
  // Build / test / install intents.
  if (/(pnpm|npm|yarn).*(test|vitest|jest)|node --test|\bpytest\b|cargo test/.test(lower)) return lead("Running tests");
  if (/(pnpm|npm|yarn).*(build|lint|tsc)|cargo build|vite build/.test(lower)) return lead("Building the project");
  if (/(pnpm|npm|yarn)\s+(install|i|add)|cargo add/.test(lower)) return lead("Installing dependencies");
  // Generic: lead with the program name.
  const program = cmd.split(" ")[0]?.split(/[\\/]/).pop() || "command";
  return lead(`Running ${program}`);
}

// Topic-first narration of a tool run for the live UI ("Reading App.tsx",
// "Searching for useState", "Opening github.com", "Switching to main"). This is
// the SOLE producer the desktop/CLI activity surfaces read, so it carries the
// warmth — keyed on the real tool name + its actual arguments.
function describeActivity(toolName: string, input: unknown): string {
  const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const bg = i.run_in_background === true;

  switch (toolName) {
    case "Read": {
      const f = str(i.file_path);
      return f ? `Reading ${basenameOf(f)}` : "Reading a file";
    }
    case "Write": {
      const f = str(i.file_path);
      return f ? `Writing ${basenameOf(f)}` : "Writing a file";
    }
    case "Edit":
    case "ApplyIntent": {
      const f = str(i.file_path);
      return f ? `Editing ${basenameOf(f)}` : "Editing a file";
    }
    case "FindAndEdit": {
      const glob = str(i.file_glob);
      const pat = str(i.pattern);
      const verb = i.dry_run ? "Previewing edits" : "Replacing";
      if (pat && glob) return `${verb} ${pat} in ${glob}`;
      return glob ? `${verb} in ${glob}` : "Editing files";
    }
    case "Grep": {
      const pat = str(i.pattern);
      return pat ? `Searching for ${pat}` : "Searching the code";
    }
    case "Glob": {
      const pat = str(i.pattern);
      return pat ? `Finding ${pat}` : "Finding files";
    }
    case "CodebaseSearch": {
      const q = str(i.query);
      return q ? `Searching the codebase for ${q.slice(0, 60)}` : "Searching the codebase";
    }
    case "Bash":
    case "PowerShell": {
      const c = str(i.command);
      return c ? summarizeShellCommand(c, bg) : "Running a command";
    }
    case "BashOutput":
      return "Reading shell output";
    case "KillShell":
      return "Stopping a background shell";
    case "WebFetch": {
      const u = str(i.url);
      return u ? `Fetching ${hostOf(u)}` : "Fetching a page";
    }
    case "WebSearch": {
      const q = str(i.query);
      return q ? `Searching the web for ${q.slice(0, 60)}` : "Searching the web";
    }
    case "Browser": {
      const action = str(i.action);
      const u = str(i.url);
      if (action === "open") return u ? `Opening ${hostOf(u)}` : "Opening a page";
      if (action === "tree") return "Reading the page";
      if (action === "screenshot" || action === "filmstrip") return "Capturing the screen";
      if (action === "fill") return str(i.label) ? `Filling “${str(i.label)}”` : "Filling a field";
      if (action === "click") return str(i.name) ? `Clicking “${str(i.name)}”` : "Clicking a control";
      if (action === "state") return "Checking the page state";
      if (action === "close") return "Closing the browser";
      return "Browsing the web";
    }
    case "Task": {
      const d = str(i.description);
      return d ? `Delegating: ${d.slice(0, 50)}` : "Delegating a subtask";
    }
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? i.todos.length : 0;
      return todos ? `Updating ${todos} todo${todos === 1 ? "" : "s"}` : "Updating the plan";
    }
    case "Memory": {
      const action = str(i.action);
      if (action === "read") return "Recalling from memory";
      if (action === "append" || action === "write") return "Saving to memory";
      return "Working with memory";
    }
    case "LSP": {
      const f = str(i.file_path);
      const action = str(i.action) ?? "inspect";
      return f ? `Inspecting ${basenameOf(f)} (${action})` : "Inspecting code";
    }
    case "McpList":
    case "Mcp": {
      const server = str(i.server);
      const tool = str(i.tool);
      if (server && tool) return `Calling ${server}/${tool}`;
      if (server) return `Listing ${server} tools`;
      return "Listing MCP servers";
    }
    case "SkillsList":
    case "Skills": {
      const q = str(i.query);
      return q ? `Looking for skills like ${q}` : "Browsing skills";
    }
    case "SkillRead":
    case "RunSkill": {
      const n = str(i.name);
      return n ? `Running the ${n} skill` : "Running a skill";
    }
    case "CodeMode":
      return "Running a code batch";
    case "PlanMode":
      return "Entering plan mode";
    case "ExitPlanMode":
      return "Leaving plan mode";
    case "LivingMind": {
      const action = str(i.action);
      return action ? `Living memory: ${action}` : "Tending living memory";
    }
    case "Operator": {
      const action = str(i.action);
      return action ? `Operator: ${action}` : "Consulting the operator";
    }
    case "Mission": {
      const action = str(i.action);
      const goal = str(i.goal);
      if (goal) return `Mission — ${goal.slice(0, 48)}`;
      return action ? `Mission: ${action}` : "Working on a mission";
    }
    case "Self": {
      const action = str(i.action);
      return action ? `Self: ${action}` : "Reflecting on self";
    }
    case "SelfEvolve": {
      const target = str(i.target);
      return target ? `Evolving ${target}` : "Evolving itself";
    }
    case "SkillCraft": {
      const n = str(i.name);
      return n ? `Crafting the ${n} skill` : "Crafting a skill";
    }
    case "Bootstrap": {
      const agent = str(i.agent_name);
      return agent ? `Bootstrapping ${agent}` : "Bootstrapping the entity";
    }
    default:
      break;
  }

  // Generic fallback — still warmer than a bare tool name.
  const f = str(i.file_path) ?? str(i.path);
  if (f) return `${toolName} · ${basenameOf(f)}`;
  const c = str(i.command);
  if (c) return `${toolName} · ${c.slice(0, 50)}`;
  const q = str(i.pattern) ?? str(i.query);
  if (q) return `${toolName} · ${q.slice(0, 50)}`;
  return toolName;
}

function isTodoOutput(output: unknown): output is { todos: import("@ares/protocol").Todo[] } {
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
