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
  type ToolSchema,
  type ToolUseBlock,
  type ToolResultBlock,
  type PermissionPromptDecision,
  type PermissionPromptSuggestion,
  messageText,
  isToolUseBlock,
} from "@crix/protocol";
import { randomUUID } from "node:crypto";
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
  drainSystemReminders?(): Array<{ text: string; source: "verifier" | "compaction" | "hook" | "skill" }>;
  hookManager?: HookManager;
  requestPermission?(request: ToolPermissionRequest): Promise<PermissionPromptDecision>;
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

  hydrate(messages: readonly Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }

  appendUserMessage(text: string): Message {
    const message: Message = {
      id: cryptoId(),
      role: "user",
      content: [{ type: "text", text }],
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
    const writeIntent = detectsWriteIntent(messageText(userMessage));

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

      // Partition: parallel-safe tools run concurrently; exclusive tools serial.
      // For M0 we just run sequentially; concurrency comes in M3.
      const toolResults: ToolResultBlock[] = [];
      for (const use of pendingToolUses) {
        const tool = this.cfg.tools.find((t) => t.schema.name === use.name);
        if (!tool) {
          const msg = `unknown tool: ${use.name}`;
          yield { type: "tool_error", id: use.id, error: msg, durationMs: 0 };
          toolResults.push({ type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
          continue;
        }

        const writeBlockReason = blockedByWriteIntentGate(tool, use.input, writeIntent);
        if (writeBlockReason) {
          yield { type: "tool_error", id: use.id, error: writeBlockReason, durationMs: 0 };
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: writeBlockReason,
            is_error: true,
          });
          this.messages.push({
            id: cryptoId(),
            role: "user", // Anthropic shape: tool_result blocks live in user-role messages
            content: toolResults,
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
          yield { type: "tool_error", id: use.id, error: msg, durationMs: 0 };
          toolResults.push({ type: "tool_result", tool_use_id: use.id, content: msg, is_error: true });
          continue;
        }

        yield {
          type: "tool_start",
          id: use.id,
          name: use.name,
          input: use.input,
          providerHint: tool.schema.providerHint,
          activityDescription: describeActivity(use.name, use.input),
        };

        const t0 = Date.now();
        const permissionEvents: TurnEvent[] = [];
        try {
          const ctx: ToolCallContext = {
            workspace: this.cfg.workspace,
            signal: this.cfg.signal ?? new AbortController().signal,
            requestPermission: this.cfg.requestPermission
              ? async (request) => {
                  const id = cryptoId("perm");
                  permissionEvents.push({
                    type: "permission_request",
                    id,
                    toolName: request.toolName,
                    input: request.input,
                    reason: request.reason,
                    suggestion: request.suggestion,
                  });
                  const decision = await this.cfg.requestPermission!(request);
                  permissionEvents.push({ type: "permission_response", id, decision });
                  return decision;
                }
              : undefined,
            emitProgress: () => {
              /* engine swallows for now; M3 forwards as tool_progress */
            },
          };
          const result = await tool.call(use.input, ctx);
          const durationMs = Date.now() - t0;
          for (const ev of permissionEvents) yield ev;
          yield {
            type: "tool_end",
            id: use.id,
            output: result.output,
            touchedFiles: result.touchedFiles,
            durationMs,
            display: result.display,
          };
          if (use.name === "TodoWrite" && isTodoOutput(result.output)) {
            yield { type: "todo_updated", todos: result.output.todos };
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
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: stringifyToolOutput(result.output),
          });
        } catch (err) {
          const durationMs = Date.now() - t0;
          const message = err instanceof Error ? err.message : String(err);
          for (const ev of permissionEvents) yield ev;
          yield { type: "tool_error", id: use.id, error: message, durationMs };
          if (this.cfg.hookManager) {
            await this.cfg.hookManager.run({
              event: "PostToolUse",
              toolName: use.name,
              input: use.input,
              output: { error: message },
              workspace: this.cfg.workspace,
            });
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: message,
            is_error: true,
          });
          if (isPermissionDeniedError(err)) {
            this.messages.push({
              id: cryptoId(),
              role: "user", // Anthropic shape: tool_result blocks live in user-role messages
              content: toolResults,
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
      }

      // Feed all tool results back as one user-role message containing
      // tool_result content blocks (Anthropic SDK shape).
      this.messages.push({
        id: cryptoId(),
        role: "user",
        content: toolResults,
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
}

// ─── Helpers ───────────────────────────────────────────────────────────

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

function blockedByWriteIntentGate(tool: EngineTool, input: unknown, writeIntent: boolean): string | null {
  if (writeIntent) return null;
  if (tool.schema.name === "Write" || tool.schema.name === "Edit") {
    return `${tool.schema.name} blocked: this turn does not contain explicit write intent. Ask to edit, fix, create, or update files before Crix modifies the workspace.`;
  }
  if ((tool.schema.name === "Bash" || tool.schema.name === "PowerShell") && shellCommandLooksMutating(input)) {
    return `${tool.schema.name} blocked: command appears to modify files or external state, but this turn does not contain explicit write intent.`;
  }
  return null;
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
