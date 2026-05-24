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
  isToolUseBlock,
} from "@crix/protocol";

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

        yield {
          type: "tool_start",
          id: use.id,
          name: use.name,
          input: use.input,
          providerHint: tool.schema.providerHint,
          activityDescription: describeActivity(use.name, use.input),
        };

        const t0 = Date.now();
        try {
          const ctx: ToolCallContext = {
            workspace: this.cfg.workspace,
            signal: this.cfg.signal ?? new AbortController().signal,
            emitProgress: () => {
              /* engine swallows for now; M3 forwards as tool_progress */
            },
          };
          const result = await tool.call(use.input, ctx);
          const durationMs = Date.now() - t0;
          yield {
            type: "tool_end",
            id: use.id,
            output: result.output,
            touchedFiles: result.touchedFiles,
            durationMs,
            display: result.display,
          };
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: stringifyToolOutput(result.output),
          });
        } catch (err) {
          const durationMs = Date.now() - t0;
          const message = err instanceof Error ? err.message : String(err);
          yield { type: "tool_error", id: use.id, error: message, durationMs };
          toolResults.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: message,
            is_error: true,
          });
        }
      }

      // Feed all tool results back as one tool-role message.
      this.messages.push({
        id: cryptoId(),
        role: "tool",
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
  // Avoid pulling in crypto.randomUUID's optionality across Node versions.
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}`;
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

// Re-export the ToolUseBlock type for downstream consumers that build messages.
export type { ToolUseBlock, ToolResultBlock };
export { isToolUseBlock };
export type { ContentBlock };
