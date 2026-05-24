// OpenAI Responses API provider — native streaming with function calling.
//
// SSE events handled:
//   response.created
//   response.output_item.added            (text or function_call)
//   response.output_text.delta            (text chunk)
//   response.function_call_arguments.delta (tool args chunk)
//   response.function_call_arguments.done  (tool args complete)
//   response.output_item.done             (item complete; finalize)
//   response.completed                    (turn done + usage)
//   error                                 (terminal)
//
// Two routing modes:
//   - api-key   -> https://api.openai.com/v1/responses
//   - chatgpt   -> https://chatgpt.com/backend-api/codex/responses
//
// Model list fetched lazily from /v1/models with 24h cache at
// %CRIX_HOME%/models.json. No hardcoded fake `gpt-5.5-codex-spark` list.

import type {
  Message,
  StreamEvent,
  Usage,
  StopReason,
  ContentBlock,
} from "@crix/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";
import { loadAuthToken, type AuthToken } from "./openaiAuth.js";

const PLATFORM_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const PLATFORM_MODELS_URL = "https://api.openai.com/v1/models";

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
          message: "No OpenAI auth. Set OPENAI_API_KEY or run `crix login`.",
          retriable: false,
        },
      };
      return;
    }

    const url =
      this.overrideUrl ??
      (auth.endpoint === "codex-backend" ? CODEX_RESPONSES_URL : PLATFORM_RESPONSES_URL);

    const body = buildRequestBody(req);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.token}`,
    };
    if (auth.endpoint === "codex-backend") {
      headers["OpenAI-Beta"] = "responses=experimental";
      headers.originator = "crix";
      headers["User-Agent"] = "crix";
      headers.version = "crix-ts";
      if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;
    }

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
    const toolUseById = new Map<string, { name: string; argsText: string; completed: boolean }>();
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

        switch (evt.type) {
          case "response.created":
          case "response.in_progress":
            messageId = evt.response?.id ?? messageId;
            continue;

          case "response.output_item.added": {
            const item = evt.item;
            if (item?.type === "function_call") {
              const id = item.id ?? item.call_id ?? `call_${toolUseById.size}`;
              toolUseById.set(id, { name: item.name ?? "", argsText: "", completed: false });
              yield { type: "tool_use_start", id, name: item.name ?? "" };
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
            const id = evt.item_id ?? evt.id ?? "";
            const delta = evt.delta ?? "";
            const entry = toolUseById.get(id);
            if (entry && delta) {
              entry.argsText += delta;
              yield { type: "tool_use_input_delta", id, deltaJson: delta };
            }
            continue;
          }

          case "response.function_call_arguments.done": {
            const id = evt.item_id ?? evt.id ?? "";
            const entry = toolUseById.get(id);
            if (!entry || entry.completed) continue;
            entry.completed = true;
            let input: unknown;
            try {
              input = entry.argsText ? JSON.parse(entry.argsText) : {};
            } catch {
              input = { __unparseable_args__: entry.argsText };
            }
            yield { type: "tool_use_input_done", id, input };
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
    if (textParts.length > 0) {
      content.push({ type: "text", text: textParts.join("") });
    }
    for (const [id, entry] of toolUseById) {
      let input: unknown;
      try {
        input = entry.argsText ? JSON.parse(entry.argsText) : {};
      } catch {
        input = { __unparseable_args__: entry.argsText };
      }
      content.push({ type: "tool_use", id, name: entry.name, input });
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
  return {
    model: req.model,
    instructions: req.system,
    input: req.messages.map(toResponsesInputItem),
    tools: req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    })),
    stream: true,
    ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
    ...(req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
  };
}

function toResponsesInputItem(m: Message): Record<string, unknown> {
  if (m.role === "tool") {
    // Tool results map to function_call_output items in the Responses API.
    return {
      type: "input",
      content: m.content.map((b) => {
        if (b.type === "tool_result") {
          return {
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
          };
        }
        return b;
      }),
    };
  }
  // assistant/user/system go through as content blocks
  return {
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "text") return { type: m.role === "assistant" ? "output_text" : "input_text", text: b.text };
      if (b.type === "tool_use") {
        return {
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input),
        };
      }
      if (b.type === "system_reminder") return { type: "input_text", text: `<system-reminder>${b.text}</system-reminder>` };
      return b;
    }),
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

// ─── Model discovery ───────────────────────────────────────────────────

export interface ModelListEntry {
  id: string;
  ownedBy: string;
}

/** Fetch the user's model list. Caches to %CRIX_HOME%/models.json for 24h. */
export async function fetchModelList(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelListEntry[]> {
  const auth = await loadAuthToken();
  if (!auth || auth.endpoint !== "openai-platform") {
    // Codex-backend doesn't expose /v1/models; surface a clear message.
    throw new Error(
      "Model listing requires an OpenAI API key (OPENAI_API_KEY). " +
        "ChatGPT OAuth users should select their model via `crix model <id>`.",
    );
  }
  const res = await fetchImpl(PLATFORM_MODELS_URL, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  if (!res.ok) throw new Error(`models list failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
  return (json.data ?? []).map((m) => ({ id: m.id, ownedBy: m.owned_by ?? "openai" }));
}
