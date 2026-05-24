// OllamaCloudPool — exploit Ollama Cloud's 3 concurrent model slots.
//
// Three roles, each pinned to a model:
//   REASONER  — main agent loop (the user's choice)
//   APPLY     — ApplyIntent + FindAndEdit per-location LLM
//   SUMMARIZE — WebFetch summary, todo derivation, commit messages
//
// The pool serializes per-slot but parallelizes across slots, so the
// REASONER can think while APPLY is materializing the previous edit and
// SUMMARIZE is compacting an oversized tool result. End-to-end latency
// drops below single-model harnesses because the slow steps overlap.
//
// Routes through local Ollama at http://127.0.0.1:11434 (which proxies
// to the Cloud). Discovery via /api/tags at startup.

import type {
  ContentBlock,
  Message,
  StreamEvent,
  Usage,
  StopReason,
} from "@crix/protocol";
import type { Provider, ProviderRequest } from "../queryEngine.js";

export type SlotName = "reasoner" | "apply" | "summarize";

export interface SlotConfig {
  /** Ollama model id, e.g. "qwen3-coder:480b-cloud", "gpt-oss:20b-cloud". */
  model: string;
}

export interface OllamaCloudPoolOptions {
  /** Ollama HTTP host. Default http://127.0.0.1:11434. */
  host?: string;
  /** Slot configuration. All three required. */
  slots: Record<SlotName, SlotConfig>;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

interface SlotState {
  model: string;
  inFlight: Promise<unknown> | null;
}

export class OllamaCloudPool {
  readonly host: string;
  private readonly slots: Map<SlotName, SlotState>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaCloudPoolOptions) {
    this.host = (opts.host ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.slots = new Map(
      (Object.entries(opts.slots) as Array<[SlotName, SlotConfig]>).map(([name, cfg]) => [
        name,
        { model: cfg.model, inFlight: null },
      ]),
    );
  }

  /** Get a Provider bound to a specific slot. Used by QueryEngine. */
  provider(slot: SlotName): Provider {
    return new OllamaSlotProvider(this, slot);
  }

  /** The slot's configured model id. */
  modelFor(slot: SlotName): string {
    const s = this.slots.get(slot);
    if (!s) throw new Error(`unknown slot: ${slot}`);
    return s.model;
  }

  /**
   * Stream from a given slot. Respects the per-slot single-concurrency
   * cap by awaiting the prior inFlight promise.
   */
  async *stream(slot: SlotName, req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const s = this.slots.get(slot);
    if (!s) {
      yield {
        type: "error",
        error: { code: "unknown_slot", message: `unknown slot: ${slot}`, retriable: false },
      };
      return;
    }

    // Serialize per-slot. (Other slots may proceed in parallel.)
    while (s.inFlight) {
      try {
        await s.inFlight;
      } catch {
        // The previous request failing on this slot doesn't block us.
      }
    }

    const { promise, generator } = this.dispatch(s.model, req);
    s.inFlight = promise;
    try {
      for await (const event of generator) yield event;
    } finally {
      s.inFlight = null;
    }
  }

  /** APPLY slot one-shot helper: materialize an edit from intent + sketch. */
  async apply(req: {
    file: string;
    original: string;
    instructions: string;
    sketch: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const system =
      "You are an apply-model. Given an ORIGINAL file, an INSTRUCTION, and a SKETCH that uses `// ... existing code ...` markers for unchanged regions, output ONLY the final file content. No commentary. No code fences.";
    const userText = `ORIGINAL (${req.file}):\n\`\`\`\n${req.original}\n\`\`\`\n\nINSTRUCTION:\n${req.instructions}\n\nSKETCH:\n\`\`\`\n${req.sketch}\n\`\`\``;
    return await this.collectText("apply", system, userText, req.signal);
  }

  /** SUMMARIZE slot one-shot helper. */
  async summarize(req: { input: string; instructions?: string; signal?: AbortSignal }): Promise<string> {
    const system =
      req.instructions ??
      "Summarize the following content in 5 sentences or fewer. Plain prose. No preamble.";
    return await this.collectText("summarize", system, req.input, req.signal);
  }

  /** Probe Ollama for installed models. Returns model ids, or [] if unreachable. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${this.host}/api/tags`, { signal });
      if (!res.ok) return [];
      const json = (await res.json()) as { models?: Array<{ name?: string }> };
      return (json.models ?? []).map((m) => m.name ?? "").filter((n) => n.length > 0);
    } catch {
      return [];
    }
  }

  /** Probe reachable + slot-models present. Used by `crix doctor`. */
  async health(): Promise<{
    reachable: boolean;
    host: string;
    availableModels: string[];
    slots: Array<{ name: SlotName; model: string; present: boolean }>;
  }> {
    const available = await this.listModels();
    const reachable = available.length > 0 || (await this.ping());
    const slots = (Object.keys(Object.fromEntries(this.slots)) as SlotName[]).map((name) => {
      const model = this.modelFor(name);
      return { name, model, present: available.includes(model) };
    });
    return { reachable, host: this.host, availableModels: available, slots };
  }

  private async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.host}/`);
      return res.ok || res.status === 404; // Ollama root returns "Ollama is running"
    } catch {
      return false;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private dispatch(model: string, req: ProviderRequest): {
    promise: Promise<void>;
    generator: AsyncGenerator<StreamEvent>;
  } {
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const self = this;
    const generator = (async function* (): AsyncGenerator<StreamEvent> {
      try {
        yield* self.callOllamaChat(model, req);
        resolveDone();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield { type: "error", error: { code: "ollama_throw", message, retriable: true } };
        rejectDone(err instanceof Error ? err : new Error(message));
      }
    })();

    return { promise, generator };
  }

  private async *callOllamaChat(
    model: string,
    req: ProviderRequest,
  ): AsyncGenerator<StreamEvent> {
    const messages = req.messages.flatMap(toOllamaMessages);

    const body = {
      model,
      messages,
      tools:
        req.tools.length > 0
          ? req.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            }))
          : undefined,
      stream: true,
      options: { num_ctx: 32_768, temperature: 0.2 },
      // Inject the system prompt as a leading system message — Ollama
      // doesn't have a separate `system` field at the chat-level API.
      ...(req.system
        ? {
            messages: [
              { role: "system", content: req.system },
              ...req.messages.flatMap(toOllamaMessages),
            ],
          }
        : {}),
    };

    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        error: {
          code: `http_${res.status}`,
          message: `Ollama returned ${res.status}: ${text.slice(0, 500)}`,
          retriable: res.status >= 500,
        },
      };
      return;
    }

    if (!res.body) {
      yield {
        type: "error",
        error: { code: "no_body", message: "Ollama returned no body", retriable: false },
      };
      return;
    }

    const decoder = new TextDecoder("utf8");
    const reader = res.body.getReader();
    let buffer = "";

    const textParts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          continue;
        }

        if (chunk.message?.content) {
          const delta = chunk.message.content;
          textParts.push(delta);
          yield { type: "text_delta", text: delta };
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const id = tc.id ?? `call_${toolCalls.length + 1}`;
            const name = tc.function?.name ?? "";
            const argRaw = tc.function?.arguments;
            const input = typeof argRaw === "string" ? safeJson(argRaw) : argRaw ?? {};
            yield { type: "tool_use_start", id, name };
            const json = JSON.stringify(input);
            yield { type: "tool_use_input_delta", id, deltaJson: json };
            yield { type: "tool_use_input_done", id, input };
            toolCalls.push({ id, name, input });
          }
        }

        if (chunk.done) {
          usage = {
            inputTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
          };
          stopReason = chunk.done_reason === "length" ? "max_tokens" : "end_turn";
        }
      }
    }

    const content: ContentBlock[] = [];
    if (textParts.length > 0) content.push({ type: "text", text: textParts.join("") });
    for (const tc of toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }

    const message: Message = {
      id: `msg_${Date.now().toString(36)}`,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };
    yield { type: "message_done", message, usage, stopReason };
  }

  private async collectText(
    slot: SlotName,
    system: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: userText }],
        createdAt: new Date().toISOString(),
      },
    ];
    const parts: string[] = [];
    for await (const ev of this.stream(slot, {
      model: this.modelFor(slot),
      system,
      messages,
      tools: [],
      signal,
    })) {
      if (ev.type === "text_delta") parts.push(ev.text);
      if (ev.type === "error") throw new Error(`${slot} slot: ${ev.error.message}`);
    }
    return parts.join("");
  }
}

class OllamaSlotProvider implements Provider {
  readonly name: string;
  constructor(private readonly pool: OllamaCloudPool, private readonly slot: SlotName) {
    this.name = `ollama-cloud:${slot}`;
  }
  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    yield* this.pool.stream(this.slot, req);
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function toOllamaMessages(
  m: Message,
): Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> {
  // Anthropic-shaped messages: tool_result blocks live inside user-role
  // messages alongside text. Ollama needs each tool result as its own
  // tool-role message, so we may emit multiple messages from one input.
  const out: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];

  for (const b of m.content) {
    if (b.type === "tool_result") {
      out.push({
        role: "tool",
        content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        tool_call_id: b.tool_use_id,
      });
    }
  }

  const text = m.content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "system_reminder") return `<system-reminder>${b.text}</system-reminder>`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  const toolCalls = m.content
    .filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));

  if (text.length > 0 || toolCalls.length > 0) {
    out.push({
      role: m.role,
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparseable_args__: s };
  }
}

interface OllamaChunk {
  message?: {
    role: string;
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: { name?: string; arguments?: string | Record<string, unknown> };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Defaults a fresh CLI uses if the user doesn't override ────────────

export const DEFAULT_OLLAMA_SLOTS: Record<SlotName, SlotConfig> = {
  reasoner: { model: process.env.CRIX_REASONER ?? "qwen3-coder:480b-cloud" },
  apply: { model: process.env.CRIX_APPLY ?? "qwen3-coder:30b-cloud" },
  summarize: { model: process.env.CRIX_SUMMARIZE ?? "gpt-oss:20b-cloud" },
};
