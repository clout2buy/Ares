// Anthropic provider — Messages API v1, streaming SSE, prompt caching.
//
// Ares's wire protocol IS the Anthropic SDK message shape, so request
// translation is near-passthrough: system_reminder blocks render as
// <system-reminder> text, image sources rename their discriminants, and
// unsigned thinking blocks are dropped from replayed history (the API
// rejects thinking blocks without a valid signature).
//
// Prompt caching: cache_control {type:"ephemeral"} breakpoints on the
// LAST tool definition and the system block. Tools render before system
// in Anthropic's prefix, so these two breakpoints cache the full stable
// prefix — what makes a Crucible side-fork (sideQuery) cost cents.
//
// Auth: ARES_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY, or an injected
// {apiKey}. Fetch and endpoint are injectable for tests.
//
// SSE events handled:
//   message_start         (id + input/cache token usage)
//   content_block_start   (text | thinking | tool_use → tool_use_start)
//   content_block_delta   (text_delta | thinking_delta | input_json_delta | signature_delta)
//   content_block_stop    (tool_use → tool_use_input_done with parsed input)
//   message_delta         (stop_reason + output token usage)
//   message_stop          (assemble message_done)
//   ping                  (ignored)
//   error                 (terminal; overloaded/api errors are retriable)

import type {
  ContentBlock,
  Message,
  StopReason,
  StreamEvent,
  Usage,
} from "@ares/protocol";
import { thinkingBudgetTokens } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { createStallGuard, stallErrorEvent, type StallGuard } from "./stallGuard.js";
import {
  resolveAnthropicAccessToken,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_OAUTH_IDENTITY,
  ANTHROPIC_OAUTH_USER_AGENT,
  ANTHROPIC_OAUTH_X_APP,
} from "./anthropicAuth.js";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Default model for the "anthropic" router lane. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";

/** Model generations that take {type:"adaptive"} thinking (no token budgets). */
export function usesAdaptiveThinking(model: string): boolean {
  return /fable|claude-fable/i.test(model);
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface AnthropicProviderOptions {
  /** Override the API key (tests / injected config). Falls back to
   *  ARES_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override URL (tests / proxies). */
  endpointUrl?: string;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly fetchImpl: typeof fetch;
  private readonly overrideKey?: string;
  private readonly overrideUrl?: string;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.overrideKey = opts.apiKey;
    this.overrideUrl = opts.endpointUrl;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const apiKey =
      this.overrideKey ||
      process.env.ARES_ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      "";
    // Prefer an explicit API key; otherwise fall back to a Claude subscription
    // OAuth token (Pro/Max). The two use different auth headers.
    const oauthToken = apiKey ? null : await resolveAnthropicAccessToken(this.fetchImpl);
    if (!apiKey && !oauthToken) {
      yield {
        type: "error",
        error: {
          code: "no_auth",
          // The desktop watches for "no_auth" + anthropic to prompt a browser sign-in.
          message: "Not signed in to Anthropic. Sign in with your Claude account, or set an API key.",
          retriable: false,
        },
      };
      return;
    }
    if (req.signal?.aborted) return;

    const url = this.overrideUrl ?? ANTHROPIC_MESSAGES_URL;
    const body = buildMessagesBody(req);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    } else if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
      headers["User-Agent"] = ANTHROPIC_OAUTH_USER_AGENT;
      headers["x-app"] = ANTHROPIC_OAUTH_X_APP;
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      const existingSystem = Array.isArray(body.system) ? body.system : [];
      // Block 0 stays byte-identical — it's the required OAuth contract string
      // (the token is rejected otherwise; see ares-anthropic.test.mjs). The
      // "Claude Code" identity leak is neutralized at the INSTRUCTION level by the
      // always-on identity anchor in composeAgentSystemPrompt, which explicitly
      // names "Claude Code" as a transport label, not the agent's name.
      body.system = [
        { type: "text", text: ANTHROPIC_OAUTH_IDENTITY },
        ...existingSystem,
      ];
    }

    // Stall watchdog: abort the fetch when no bytes arrive for the stall
    // window so a hung connection becomes a retriable error, not a freeze.
    const guard = createStallGuard(req.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: guard.signal,
      });
    } catch (err) {
      guard.dispose();
      if (guard.stalled()) {
        yield stallErrorEvent();
        return;
      }
      if (req.signal?.aborted || isAbortError(err)) return;
      yield {
        type: "error",
        error: {
          code: "network_error",
          message: err instanceof Error ? err.message : String(err),
          retriable: true,
        },
      };
      return;
    }
    guard.reset();

    if (!response.ok) {
      // Surface the body verbatim: the engine's context-limit matcher
      // reads it ("prompt is too long"), and 529s carry overloaded_error.
      const text = await response.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${response.status}`,
          message: `Anthropic returned ${response.status}: ${text.slice(0, 500)}`,
          retriable:
            response.status === 429 ||
            response.status >= 500 ||
            text.includes("overloaded_error"),
        },
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: { code: "no_body", message: "Response had no body", retriable: false },
      };
      return;
    }

    yield* this.parseSSE(response.body, req.signal, guard);
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    guard?: StallGuard,
  ): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder("utf8");
    const reader = body.getReader();
    let buffer = "";

    const blocks = new Map<number, BlockState>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let messageId = "";

    const cancel = (): void => {
      void reader.cancel().catch(() => {});
    };

    read: while (true) {
      if (signal?.aborted) {
        cancel();
        return;
      }
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        guard?.dispose();
        if (guard?.stalled()) {
          yield stallErrorEvent();
          return;
        }
        if (signal?.aborted || isAbortError(err)) return;
        yield {
          type: "error",
          error: {
            code: "stream_read_error",
            message: err instanceof Error ? err.message : String(err),
            retriable: true,
          },
        };
        return;
      }
      guard?.reset();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        if (signal?.aborted) {
          cancel();
          return;
        }
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const evt = parseAnthropicSSE(raw);
        if (!evt || !evt.type) continue; // malformed data line → skip

        switch (evt.type) {
          case "message_start": {
            messageId = evt.message?.id ?? messageId;
            const u = evt.message?.usage;
            if (u) usage = mergeUsage(usage, u);
            continue;
          }

          case "content_block_start": {
            if (typeof evt.index !== "number") continue;
            const cb = evt.content_block;
            if (cb?.type === "text") {
              blocks.set(evt.index, freshBlock("text"));
            } else if (cb?.type === "thinking") {
              blocks.set(evt.index, freshBlock("thinking"));
            } else if (cb?.type === "tool_use") {
              const toolId = cb.id ?? `toolu_${evt.index}`;
              const toolName = cb.name ?? "";
              const state = freshBlock("tool_use");
              state.toolId = toolId;
              state.toolName = toolName;
              blocks.set(evt.index, state);
              yield { type: "tool_use_start", id: toolId, name: toolName };
            }
            // Unknown block kinds (redacted_thinking, server tools): ignore.
            continue;
          }

          case "content_block_delta": {
            if (typeof evt.index !== "number") continue;
            const block = blocks.get(evt.index);
            if (!block) continue;
            const d = evt.delta;
            if (d?.type === "text_delta" && d.text) {
              block.text += d.text;
              yield { type: "text_delta", text: d.text };
            } else if (d?.type === "thinking_delta" && d.thinking) {
              block.thinking += d.thinking;
              yield { type: "thinking_delta", text: d.thinking };
            } else if (d?.type === "input_json_delta" && d.partial_json !== undefined) {
              block.partialJson += d.partial_json;
              if (block.toolId) {
                yield { type: "tool_use_input_delta", id: block.toolId, deltaJson: d.partial_json };
              }
            } else if (d?.type === "signature_delta" && d.signature) {
              // Captured so replayed assistant turns keep valid thinking blocks.
              block.signature += d.signature;
            }
            continue;
          }

          case "content_block_stop": {
            if (typeof evt.index !== "number") continue;
            const block = blocks.get(evt.index);
            if (!block || block.kind !== "tool_use" || !block.toolId) continue;
            yield { type: "tool_use_input_done", id: block.toolId, input: parseToolInput(block.partialJson) };
            continue;
          }

          case "message_delta": {
            if (evt.usage) usage = mergeUsage(usage, evt.usage);
            stopReason = mapStopReason(evt.delta?.stop_reason) ?? stopReason;
            continue;
          }

          case "message_stop": {
            cancel();
            break read;
          }

          case "error": {
            const kind = evt.error?.type ?? "stream_error";
            yield {
              type: "error",
              error: {
                code: kind,
                message: evt.error?.message ?? "Anthropic stream error",
                retriable: kind === "overloaded_error" || kind === "api_error",
              },
            };
            cancel();
            return;
          }

          default:
            continue; // ping + unknown event types (forward-compat)
        }
      }
    }

    guard?.dispose();
    if (signal?.aborted) return;

    // Assemble the final assistant message in wire (index) order. Reached
    // via message_stop, or stream close — emit what accumulated either way
    // so the engine always sees a terminal event.
    const content: ContentBlock[] = [];
    for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
      const block = blocks.get(idx)!;
      if (block.kind === "text" && block.text) {
        content.push({ type: "text", text: block.text });
      } else if (block.kind === "thinking" && block.thinking) {
        content.push({
          type: "thinking",
          text: block.thinking,
          ...(block.signature ? { signature: block.signature } : {}),
        });
      } else if (block.kind === "tool_use" && block.toolId) {
        content.push({
          type: "tool_use",
          id: block.toolId,
          name: block.toolName ?? "",
          input: parseToolInput(block.partialJson),
        });
      }
    }

    const message: Message = {
      id: messageId || `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };
    yield { type: "message_done", message, usage, stopReason };
  }
}

// ─── Request building ───────────────────────────────────────────────────

function buildMessagesBody(req: ProviderRequest): Record<string, unknown> {
  const outputAllowance = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: outputAllowance,
    stream: true,
    messages: req.messages
      .map((m) => ({
        // Anthropic accepts only user/assistant; stray system-role history
        // (rare — the prompt rides req.system) folds into the user turn.
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content
          .map(toAnthropicContentBlock)
          .filter((b): b is Record<string, unknown> => b !== null),
      }))
      .filter((m) => m.content.length > 0),
  };

  // Reasoning dial → extended thinking. Fable-class models removed
  // budget_tokens in favor of adaptive thinking and 400 on the enabled+budget
  // shape; older models still take explicit budgets (and require max_tokens to
  // exceed the budget, so grow the ceiling to leave room for visible output).
  if (req.reasoningLevel) {
    if (usesAdaptiveThinking(req.model)) {
      body.thinking = { type: "adaptive" };
    } else {
      const budget = thinkingBudgetTokens(req.reasoningLevel);
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = budget + outputAllowance;
    }
  }

  if (req.system) {
    body.system = [
      { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
    ];
  }

  if (req.tools.length > 0) {
    body.tools = req.tools.map((t, index) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      ...(index === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
    }));
  }

  // S3 — rolling conversation cache breakpoint. The system + last-tool
  // breakpoints only cache the STATIC prefix; without a breakpoint inside the
  // message history, every turn of a long session re-bills the entire growing
  // transcript. Mark the last block of the most recent message: Anthropic caches
  // that prefix, and the next turn's longest-prefix match reuses all the shared
  // history (cache reads are ~10% the price of fresh input). Moves forward every
  // turn, so the cached span grows with the conversation. 3 breakpoints total
  // (system + tools + history), under the 4-breakpoint ceiling.
  const msgs = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    if (lastBlock && typeof lastBlock === "object") {
      lastBlock.cache_control = { type: "ephemeral" };
    }
  }

  return body;
}

function toAnthropicContentBlock(block: ContentBlock): Record<string, unknown> | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "system_reminder":
      return { type: "text", text: `<system-reminder>${block.text}</system-reminder>` };
    case "image":
      return toAnthropicImage(block);
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content.map((inner) =>
                inner.type === "image" ? toAnthropicImage(inner) : { type: "text", text: inner.text },
              ),
        ...(block.is_error ? { is_error: true } : {}),
      };
    case "thinking":
      // Replayed thinking needs the server-issued signature; unsigned
      // blocks would be rejected, so they drop from outbound history.
      return block.signature
        ? { type: "thinking", thinking: block.text, signature: block.signature }
        : null;
  }
}

function toAnthropicImage(block: Extract<ContentBlock, { type: "image" }>): Record<string, unknown> {
  if (block.source.kind === "url") {
    return { type: "image", source: { type: "url", url: block.source.url } };
  }
  return {
    type: "image",
    source: { type: "base64", media_type: block.source.mediaType, data: block.source.data },
  };
}

// ─── Stream-side helpers ────────────────────────────────────────────────

interface BlockState {
  kind: "text" | "thinking" | "tool_use";
  text: string;
  thinking: string;
  signature: string;
  partialJson: string;
  toolId?: string;
  toolName?: string;
}

function freshBlock(kind: BlockState["kind"]): BlockState {
  return { kind, text: "", thinking: "", signature: "", partialJson: "" };
}

function parseToolInput(partialJson: string): unknown {
  if (!partialJson) return {};
  try {
    return JSON.parse(partialJson);
  } catch {
    return { __unparseable_args__: partialJson };
  }
}

function mergeUsage(prev: Usage, wire: AnthropicWireUsage): Usage {
  const cacheReadTokens = wire.cache_read_input_tokens ?? prev.cacheReadTokens;
  const cacheWriteTokens = wire.cache_creation_input_tokens ?? prev.cacheWriteTokens;
  const freshInput = wire.input_tokens;
  return {
    inputTokens:
      freshInput === undefined
        ? prev.inputTokens
        : freshInput + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0),
    outputTokens: wire.output_tokens ?? prev.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

function mapStopReason(raw: string | undefined): StopReason | null {
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

// ─── Anthropic SSE event shape (only the fields we read) ───────────────

interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicSSEEvent {
  type?: string;
  index?: number;
  message?: { id?: string; usage?: AnthropicWireUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: AnthropicWireUsage;
  error?: { type?: string; message?: string };
}

function parseAnthropicSSE(raw: string): AnthropicSSEEvent | null {
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as AnthropicSSEEvent;
  } catch {
    return null;
  }
}
