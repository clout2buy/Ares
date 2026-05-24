import type { ProviderRequest, ToolCall, UpgradePlan } from "@crix/protocol";
import { OpenAIAuthStore, type OpenAIAuthToken } from "./openaiAuth.js";
import { buildUpgradePlanUserPrompt } from "./planPrompt.js";
import { extractOpenAIResponseToolCalls, openAIResponseTools } from "./providerNativeTools.js";
import { parseProviderJsonResponse } from "./providerResponse.js";
import { buildChatSystemPrompt } from "./systemPrompt.js";

type FetchLike = typeof fetch;

const DEFAULT_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-5.5";

interface ResponsesClientOptions {
  authStore?: OpenAIAuthStore;
  fetchImpl?: FetchLike;
  responsesUrl?: string;
  model?: string;
}

export type TextDeltaHandler = (delta: string) => void | Promise<void>;
export interface ProviderClientOptions {
  signal?: AbortSignal;
}

export class OpenAIResponsesClient {
  private readonly authStore: OpenAIAuthStore;
  private readonly fetchImpl: FetchLike;
  private readonly responsesUrl?: string;
  readonly model: string;

  constructor(options: ResponsesClientOptions = {}) {
    this.authStore = options.authStore ?? new OpenAIAuthStore();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.responsesUrl = options.responsesUrl ?? process.env.CRIX_OPENAI_RESPONSES_URL;
    this.model = options.model ?? process.env.CRIX_OPENAI_MODEL ?? DEFAULT_MODEL;
  }

  async createResponse(body: Record<string, unknown>, options: ProviderClientOptions = {}): Promise<unknown> {
    const auth = await this.authStore.getAuthToken();
    const url = this.responsesUrl ?? defaultResponsesUrl(auth);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${auth.token}`,
        ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "crix",
        "User-Agent": "crix",
        version: "crix-ts",
      },
      body: JSON.stringify(buildResponsesBody(this.model, body, auth, url)),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(formatResponsesError(response.status, await safeResponseText(response), auth, url));
    return parseResponsesBody(await response.text(), response.headers.get("content-type") ?? "");
  }

  async completeText(input: string, instructions: string, options: ProviderClientOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      instructions,
      input: userInput(input),
    };
    const reasoning = responseReasoning();
    if (reasoning) body.reasoning = reasoning;
    const response = await this.createResponse(body, options);
    return extractResponseText(response);
  }

  async streamText(input: string, instructions: string, onDelta: TextDeltaHandler, options: ProviderClientOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      instructions,
      input: userInput(input),
    };
    const reasoning = responseReasoning();
    if (reasoning) body.reasoning = reasoning;
    return await this.createTextStream(body, onDelta, options);
  }

  private async createTextStream(body: Record<string, unknown>, onDelta: TextDeltaHandler, options: ProviderClientOptions = {}): Promise<string> {
    const auth = await this.authStore.getAuthToken();
    const url = this.responsesUrl ?? defaultResponsesUrl(auth);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${auth.token}`,
        ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
        "OpenAI-Beta": "responses=experimental",
        originator: "crix",
        "User-Agent": "crix",
        version: "crix-ts",
      },
      body: JSON.stringify(buildResponsesBody(this.model, body, auth, url)),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(formatResponsesError(response.status, await safeResponseText(response), auth, url));
    if (!response.body) {
      const parsed = parseResponsesBody(await response.text(), response.headers.get("content-type") ?? "");
      const text = extractResponseText(parsed);
      if (text) await onDelta(text);
      return text;
    }
    return await parseResponsesSseStream(response.body, onDelta);
  }

  async createUpgradePlan(request: ProviderRequest, options: ProviderClientOptions = {}): Promise<{ text: string; plan?: UpgradePlan; toolCalls?: ToolCall[] }> {
    const prompt = buildUpgradePlanUserPrompt(request);
    const body: Record<string, unknown> = {
      instructions: `${request.systemPrompt}\n\nReturn only a JSON object matching the Crix UpgradePlan contract.`,
      input: userInput(prompt),
    };
    if (request.tools.length > 0) {
      body.tools = openAIResponseTools(request.tools);
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
    const reasoning = responseReasoning();
    if (reasoning) body.reasoning = reasoning;
    const response = await this.createResponse(body, options);
    const nativeToolCalls = extractOpenAIResponseToolCalls(response);
    if (nativeToolCalls.length > 0) {
      return { text: `requested ${nativeToolCalls.length} native OpenAI tool call(s)`, toolCalls: nativeToolCalls };
    }
    const text = stripJsonFence(extractResponseText(response));
    try {
      return parseProviderJsonResponse(text);
    } catch {
      return { text };
    }
  }
}

function userInput(text: string): Array<{ role: "user"; content: Array<{ type: "input_text"; text: string }> }> {
  return [{ role: "user", content: [{ type: "input_text", text }] }];
}

export async function completeOpenAIChat(
  text: string,
  options: { instructions?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return await new OpenAIResponsesClient({ model: options.model }).completeText(
    text,
    options.instructions ?? buildChatSystemPrompt(),
    { signal: options.signal },
  );
}

export async function streamOpenAIChat(
  text: string,
  onDelta: TextDeltaHandler,
  options: { instructions?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string> {
  return await new OpenAIResponsesClient({ model: options.model }).streamText(
    text,
    options.instructions ?? buildChatSystemPrompt(),
    onDelta,
    { signal: options.signal },
  );
}

export function extractResponseText(value: unknown): string {
  if (isRecord(value) && typeof value.output_text === "string") return value.output_text;
  if (!isRecord(value) || !Array.isArray(value.output)) throw new Error("OpenAI response did not include output text.");
  const chunks: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content)) continue;
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("OpenAI response output text was empty.");
  return text;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function defaultResponsesUrl(auth: OpenAIAuthToken): string {
  return auth.mode === "api-key" ? DEFAULT_RESPONSES_URL : DEFAULT_CODEX_RESPONSES_URL;
}

function buildResponsesBody(
  model: string,
  body: Record<string, unknown>,
  auth: OpenAIAuthToken,
  url: string,
): Record<string, unknown> {
  const wireBody: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    text: { verbosity: "low" },
    ...body,
  };
  if (isCodexBackend(auth, url)) {
    // ChatGPT subscription/Codex backend rejects output-token caps. CryptCore
    // sends no max_* token field for this route; keep Crix on that shape.
    delete wireBody.max_output_tokens;
    delete wireBody.max_tokens;
    delete wireBody.max_completion_tokens;
    wireBody.include ??= ["reasoning.encrypted_content"];
    wireBody.tool_choice ??= "auto";
    wireBody.parallel_tool_calls ??= true;
  }
  return wireBody;
}

function isCodexBackend(auth: OpenAIAuthToken, url: string): boolean {
  return auth.mode !== "api-key" || url.includes("/backend-api/codex/");
}

function responseReasoning(): { effort: string; summary?: string } | undefined {
  const effort = process.env.CRIX_OPENAI_REASONING_EFFORT?.trim();
  if (!effort) return undefined;
  const summary = process.env.CRIX_OPENAI_REASONING_SUMMARY?.trim();
  return summary ? { effort, summary } : { effort };
}

function formatResponsesError(status: number, body: string, auth: OpenAIAuthToken, url: string): string {
  if (status === 401 && body.includes("api.responses.write")) {
    return [
      "OpenAI auth reached the wrong endpoint for this token.",
      `auth: ${auth.mode}`,
      `endpoint: ${url}`,
      "ChatGPT OAuth should use the Codex backend; API keys should use the OpenAI Platform endpoint.",
      "Try `auth logout`, then `login`, or set OPENAI_API_KEY if you want Platform API billing.",
    ].join("\n");
  }
  return `OpenAI Responses request failed with HTTP ${status}: ${body}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1000);
}

function parseResponsesBody(text: string, contentType: string): unknown {
  const trimmed = text.trimStart();
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:") || trimmed.startsWith("event:")) {
    return parseResponsesSse(text);
  }
  return JSON.parse(text);
}

function parseResponsesSse(text: string): unknown {
  const textChunks: string[] = [];
  let completedResponse: unknown;

  for (const payload of ssePayloads(text)) {
    if (payload === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType === "error") throw new Error(`OpenAI stream error: ${JSON.stringify(event.error ?? event)}`);
    if (eventType === "response.failed") throw new Error(`OpenAI response failed: ${JSON.stringify(event.response ?? event)}`);
    if (eventType === "response.output_text.delta" && typeof event.delta === "string") {
      textChunks.push(event.delta);
      continue;
    }
    if (eventType === "response.output_text.done" && textChunks.length === 0 && typeof event.text === "string") {
      textChunks.push(event.text);
      continue;
    }
    if (eventType === "response.completed" && "response" in event) completedResponse = event.response;
  }

  if (textChunks.length > 0) return { output_text: textChunks.join("") };
  if (completedResponse !== undefined) return completedResponse;
  throw new Error("OpenAI stream ended without output text or response.completed.");
}

async function parseResponsesSseStream(stream: ReadableStream<Uint8Array>, onDelta: TextDeltaHandler): Promise<string> {
  const textChunks: string[] = [];
  let completedResponse: unknown;

  await readSsePayloads(stream, async (payload) => {
    if (payload === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(event)) return;

    const eventType = typeof event.type === "string" ? event.type : "";
    if (eventType === "error") throw new Error(`OpenAI stream error: ${JSON.stringify(event.error ?? event)}`);
    if (eventType === "response.failed") throw new Error(`OpenAI response failed: ${JSON.stringify(event.response ?? event)}`);
    if (eventType === "response.output_text.delta" && typeof event.delta === "string") {
      textChunks.push(event.delta);
      await onDelta(event.delta);
      return;
    }
    if (eventType === "response.output_text.done" && textChunks.length === 0 && typeof event.text === "string") {
      textChunks.push(event.text);
      await onDelta(event.text);
      return;
    }
    if (eventType === "response.completed" && "response" in event) completedResponse = event.response;
  });

  if (textChunks.length > 0) return textChunks.join("");
  if (completedResponse !== undefined) {
    const text = extractResponseText(completedResponse);
    await onDelta(text);
    return text;
  }
  throw new Error("OpenAI stream ended without output text or response.completed.");
}

async function readSsePayloads(stream: ReadableStream<Uint8Array>, onPayload: (payload: string) => Promise<void>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer = await drainSseBuffer(buffer, onPayload);
  }
  buffer = await drainSseBuffer(`${buffer}\n\n`, onPayload);
}

async function drainSseBuffer(buffer: string, onPayload: (payload: string) => Promise<void>): Promise<string> {
  let remaining = buffer;
  while (true) {
    const match = remaining.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) return remaining;
    const boundary = match.index;
    const block = remaining.slice(0, boundary);
    remaining = remaining.slice(boundary + match[0].length);
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) await onPayload(data);
  }
}

function ssePayloads(text: string): string[] {
  const payloads: string[] = [];
  let current: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (current.length > 0) {
        payloads.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) current.push(line.slice(5).trimStart());
  }
  if (current.length > 0) payloads.push(current.join("\n"));
  return payloads;
}

const VERIFICATION_COMMAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["program", "args"],
  properties: {
    program: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    timeoutMs: { type: "number" },
  },
} as const;

const PLAN_STEP_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "safety", "type", "path"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        safety: { enum: ["read-only", "workspace-write"] },
        type: { const: "create_dir" },
        path: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "safety", "type", "path", "content"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        safety: { enum: ["workspace-write"] },
        type: { const: "write_file" },
        path: { type: "string" },
        content: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "safety", "type", "path", "oldText", "newText"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        safety: { enum: ["workspace-write"] },
        type: { const: "replace_text" },
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "safety", "type", "command"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        safety: { enum: ["read-only"] },
        type: { const: "run_verification" },
        command: VERIFICATION_COMMAND_SCHEMA,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["id", "title", "safety", "type", "agent", "prompt"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        safety: { enum: ["read-only"] },
        type: { const: "spawn_agent" },
        agent: { type: "string" },
        prompt: { type: "string" },
        background: { type: "boolean" },
      },
    },
  ],
} as const;

const UPGRADE_PLAN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "summary", "steps", "verification"],
  properties: {
    goal: { type: "string" },
    summary: { type: "string" },
    steps: { type: "array", items: PLAN_STEP_SCHEMA },
    verification: { type: "array", items: VERIFICATION_COMMAND_SCHEMA },
  },
} as const;
