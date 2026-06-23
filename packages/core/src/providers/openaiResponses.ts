// OpenAI Responses provider — ChatGPT OAuth → Codex backend, streaming.
//
// Ares only supports ChatGPT OAuth (not OPENAI_API_KEY). Requests always
// route to the Codex backend at chatgpt.com/backend-api/codex/responses.
//
// Input message shape is Anthropic SDK-compatible: tool results arrive
// as USER-role messages with tool_result content blocks. This provider
// translates them to the Responses API's function_call_output items at
// the wire edge.
//
// SSE events handled:
//   response.created
//   response.output_item.added            (text or function_call)
//   response.output_text.delta            (text chunk)
//   response.function_call_arguments.delta (tool args chunk)
//   response.function_call_arguments.done  (tool args complete)
//   response.output_item.done             (item complete)
//   response.completed                    (turn done + usage)
//   error                                 (terminal)

import type {
  Message,
  StreamEvent,
  Usage,
  StopReason,
  ContentBlock,
} from "@ares/protocol";
import { openAIReasoningEffort } from "@ares/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { loadAuthToken, type AuthToken } from "./openaiAuth.js";
import { parseRetryAfterMs } from "./retryAfter.js";
import { buildPromptCacheKey } from "../promptCache.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

export interface OpenAIResponsesProviderOptions {
  /** Override the discovered auth token (tests). */
  auth?: AuthToken;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override URL (tests). */
  endpointUrl?: string;
}

export class OpenAIResponsesProvider implements Provider {
  readonly name = "openai-responses";
  private readonly fetchImpl: typeof fetch;
  private readonly overrideAuth?: AuthToken;
  private readonly overrideUrl?: string;

  constructor(opts: OpenAIResponsesProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.overrideAuth = opts.auth;
    this.overrideUrl = opts.endpointUrl;
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const auth = this.overrideAuth ?? (await loadAuthToken());
    if (!auth) {
      yield {
        type: "error",
        error: {
          code: "no_auth",
          message: "No ChatGPT OAuth token. Run `ares login` to authorize.",
          retriable: false,
        },
      };
      return;
    }

    const url = this.overrideUrl ?? CODEX_RESPONSES_URL;
    const body = buildRequestBody(req);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.token}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "ares",
      "User-Agent": "ares",
      version: "ares-ts",
    };
    if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
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

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${response.status}`,
          message: `OpenAI Responses returned ${response.status}: ${text.slice(0, 500)}`,
          retriable: response.status === 429 || response.status >= 500,
          retryAfterMs: parseRetryAfterMs(response.headers),
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

    yield* this.parseSSE(response.body);
  }

  private async *parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder("utf8");
    const reader = body.getReader();
    let buffer = "";

    // Accumulation state for the in-flight message
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    const toolUseByItemId = new Map<string, { callId: string; name: string; argsText: string; completed: boolean }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";
    let messageId = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines.
      let sepIndex: number;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const event = parseSSEEvent(rawEvent);
        if (!event) continue;

        const evt = event.data as ResponsesEvent | null;
        if (!evt || !evt.type) continue;

        if (isReasoningDeltaEvent(evt)) {
          const delta = evt.delta ?? evt.text ?? "";
          if (delta) {
            thinkingParts.push(delta);
            yield { type: "thinking_delta", text: delta };
          }
          continue;
        }

        switch (evt.type) {
          case "response.created":
          case "response.in_progress":
            messageId = evt.response?.id ?? messageId;
            continue;

          case "response.output_item.added": {
            const item = evt.item;
            if (item?.type === "function_call") {
              const itemId = item.id ?? item.call_id ?? `call_${toolUseByItemId.size}`;
              const callId = item.call_id ?? itemId;
              toolUseByItemId.set(itemId, { callId, name: item.name ?? "", argsText: "", completed: false });
              yield { type: "tool_use_start", id: callId, name: item.name ?? "" };
            }
            continue;
          }

          case "response.output_text.delta": {
            const delta = evt.delta ?? "";
            if (delta) {
              textParts.push(delta);
              yield { type: "text_delta", text: delta };
            }
            continue;
          }

          case "response.function_call_arguments.delta": {
            const itemId = evt.item_id ?? evt.id ?? "";
            const delta = evt.delta ?? "";
            const entry = toolUseByItemId.get(itemId);
            if (entry && delta) {
              entry.argsText += delta;
              yield { type: "tool_use_input_delta", id: entry.callId, deltaJson: delta };
            }
            continue;
          }

          case "response.function_call_arguments.done": {
            const itemId = evt.item_id ?? evt.id ?? "";
            const entry = toolUseByItemId.get(itemId);
            if (!entry || entry.completed) continue;
            entry.completed = true;
            let input: unknown;
            try {
              input = entry.argsText ? JSON.parse(entry.argsText) : {};
            } catch {
              input = { __unparseable_args__: entry.argsText };
            }
            yield { type: "tool_use_input_done", id: entry.callId, input };
            continue;
          }

          case "response.completed": {
            usage = extractUsage(evt.response) ?? usage;
            stopReason = mapStopReason(evt.response);
            messageId = evt.response?.id ?? messageId;
            continue;
          }

          case "error": {
            yield {
              type: "error",
              error: {
                code: evt.error?.code ?? "stream_error",
                message: evt.error?.message ?? "unknown stream error",
                retriable: false,
              },
            };
            return;
          }

          default:
            // Ignore unknown event types (forward-compat).
            continue;
        }
      }
    }

    // Build the final assistant Message.
    const content: ContentBlock[] = [];
    if (thinkingParts.length > 0) {
      content.push({ type: "thinking", text: thinkingParts.join("") });
    }
    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("") });
    }
    for (const entry of toolUseByItemId.values()) {
      let input: unknown;
      try {
        input = entry.argsText ? JSON.parse(entry.argsText) : {};
      } catch {
        input = { __unparseable_args__: entry.argsText };
      }
      content.push({ type: "tool_use", id: entry.callId, name: entry.name, input });
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

// ─── Helpers ───────────────────────────────────────────────────────────

function buildRequestBody(req: ProviderRequest): Record<string, unknown> {
  const cache = buildPromptCacheKey(req);
  return {
    model: req.model,
    instructions: req.system,
    input: req.messages.flatMap(toResponsesInputItems),
    store: false,
    prompt_cache_key: cache.key,
    tools: req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    stream: true,
    ...(req.reasoningLevel ? { reasoning: { effort: openAIReasoningEffort(req.reasoningLevel) } } : {}),
  };
}

function toResponsesInputItems(m: Message): Record<string, unknown>[] {
  // Anthropic-shaped messages: tool_results live as USER-role content
  // blocks. Translate them to function_call_output items first; the
  // remaining text/image content (if any) flows through as a normal
  // input message.
  const items: Record<string, unknown>[] = [];
  const messageContent: Record<string, unknown>[] = [];

  for (const b of m.content) {
    if (b.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: b.tool_use_id,
        output: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      });
    } else if (b.type === "text") {
      messageContent.push({
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: b.text,
      });
    } else if (b.type === "system_reminder") {
      messageContent.push({ type: "input_text", text: `<system-reminder>${b.text}</system-reminder>` });
    } else if (b.type === "image") {
      messageContent.push(toResponsesImage(b));
    } else if (b.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input),
      });
    }
  }

  if (messageContent.length > 0) {
    items.unshift({
      type: "message",
      role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
      content: messageContent,
    });
  }

  return items;
}

function toResponsesImage(block: Extract<ContentBlock, { type: "image" }>): Record<string, unknown> {
  if (block.source.kind === "url") {
    return { type: "input_image", image_url: block.source.url };
  }
  return {
    type: "input_image",
    image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
  };
}

function extractUsage(resp: ResponsesEvent["response"]): Usage | null {
  if (!resp?.usage) return null;
  return {
    inputTokens: resp.usage.input_tokens ?? 0,
    outputTokens: resp.usage.output_tokens ?? 0,
    cacheReadTokens: resp.usage.input_tokens_details?.cached_tokens,
    reasoningTokens: resp.usage.output_tokens_details?.reasoning_tokens,
  };
}

function mapStopReason(resp: ResponsesEvent["response"]): StopReason {
  switch (resp?.status) {
    case "completed":
      return "end_turn";
    case "incomplete":
      return resp.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : "interrupted";
    case "failed":
      return "error";
    default:
      return "end_turn";
  }
}

// ─── SSE parsing ───────────────────────────────────────────────────────

interface ParsedSSE {
  event?: string;
  data: unknown;
}

function parseSSEEvent(raw: string): ParsedSSE | null {
  const lines = raw.split("\n");
  let event: string | undefined;
  let dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data: null };
  }
}

// ─── Loose Responses API event shape ───────────────────────────────────
// We type only the fields we read; everything else is forward-compatible.

interface ResponsesEvent {
  type: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  item_id?: string;
  id?: string;
  delta?: string;
  text?: string;
  response?: {
    id?: string;
    status?: "completed" | "incomplete" | "failed" | "in_progress";
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { code?: string; message?: string };
}

function isReasoningDeltaEvent(evt: ResponsesEvent): boolean {
  return /reasoning|thinking/u.test(evt.type) && /delta/u.test(evt.type);
}

// Model discovery: the Codex backend does not expose /v1/models. The user
// selects their model explicitly via `ares model <id>` or --model flag.
