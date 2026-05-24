import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderRequest, ToolCall, UpgradePlan } from "@crix/protocol";
import { crixHome } from "./openaiAuth.js";
import { buildUpgradePlanUserPrompt } from "./planPrompt.js";
import { extractOllamaToolCalls, ollamaChatTools, type OllamaChatFunctionTool } from "./providerNativeTools.js";
import { parseProviderJsonResponse } from "./providerResponse.js";
import { buildChatSystemPrompt } from "./systemPrompt.js";

type FetchLike = typeof fetch;

const DEFAULT_REMOTE_HOST = "https://ollama.com";
const DEFAULT_LOCAL_HOST = "http://127.0.0.1:11434";
const DEFAULT_LOCAL_MODEL = "qwen3-coder";

export const OLLAMA_CLOUD_MODELS = {
  "deepseek-v4-flash": "deepseek-v4-flash:cloud",
  "deepseek-v4-pro": "deepseek-v4-pro:cloud",
  "kimi-k2.6": "kimi-k2.6:cloud",
  "glm-5.1": "glm-5.1:cloud",
  "minimax-m2.7": "minimax-m2.7:cloud",
  gemma4: "gemma4:cloud",
  "nemotron-3-super": "nemotron-3-super:cloud",
  "qwen3.5": "qwen3.5:cloud",
  "glm-5": "glm-5:cloud",
  "minimax-m2.5": "minimax-m2.5:cloud",
  "qwen3-coder-next": "qwen3-coder-next:cloud",
  "kimi-k2.5": "kimi-k2.5:cloud",
  "glm-4.7": "glm-4.7:cloud",
  "minimax-m2.1": "minimax-m2.1:cloud",
  "gemini-3-flash-preview": "gemini-3-flash-preview:cloud",
  "nemotron-3-nano": "nemotron-3-nano:cloud",
  "devstral-small-2": "devstral-small-2:cloud",
  "rnj-1": "rnj-1:cloud",
  "deepseek-v3.2": "deepseek-v3.2:cloud",
  "devstral-2": "devstral-2:cloud",
} as const;

export interface OllamaCloudStatus {
  configured: boolean;
  source: "env:OLLAMA_API_KEY" | "file" | "none" | "local-default";
  authPath: string;
  host: string;
  model: string;
  tokenPreview?: string;
}

interface OllamaAuthFile {
  apiKey?: string;
  model?: string;
  host?: string;
  updatedAt: string;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  message?: { content?: string; tool_calls?: unknown[] };
  response?: string;
}

export type OllamaTextDeltaHandler = (delta: string) => void | Promise<void>;
export interface OllamaRequestOptions {
  signal?: AbortSignal;
}

export class OllamaCloudAuthStore {
  private readonly home: string;

  constructor(home = crixHome()) {
    this.home = home;
  }

  authPath(): string {
    return path.join(this.home, "ollama.json");
  }

  async status(): Promise<OllamaCloudStatus> {
    const envKey = process.env.OLLAMA_API_KEY?.trim();
    const envHost = process.env.OLLAMA_HOST?.trim() || process.env.OLLAMA_CLOUD_HOST?.trim();
    const envModel = process.env.CRIX_OLLAMA_MODEL?.trim() || process.env.OLLAMA_CLOUD_MODEL?.trim();
    if (envKey) {
      return {
        configured: true,
        source: "env:OLLAMA_API_KEY",
        authPath: this.authPath(),
        host: normalizeHost(envHost || DEFAULT_REMOTE_HOST),
        model: resolveOllamaModel(envModel),
        tokenPreview: previewToken(envKey),
      };
    }
    const auth = await this.load();
    if (!auth || (!auth.apiKey && !auth.host && !auth.model)) {
      return {
        configured: true,
        source: "local-default",
        authPath: this.authPath(),
        host: normalizeHost(envHost || DEFAULT_LOCAL_HOST),
        model: resolveOllamaModel(envModel || DEFAULT_LOCAL_MODEL),
      };
    }
    const resolvedHost = normalizeHost(envHost || auth.host || DEFAULT_LOCAL_HOST);
    const resolvedModel = resolveOllamaModel(envModel || auth.model || DEFAULT_LOCAL_MODEL);
    return {
      configured: true,
      source: "file",
      authPath: this.authPath(),
      host: resolvedHost,
      model: resolvedModel,
      tokenPreview: auth.apiKey ? previewToken(auth.apiKey) : undefined,
    };
  }

  async getApiKey(): Promise<string | undefined> {
    const envKey = process.env.OLLAMA_API_KEY?.trim();
    if (envKey) return envKey;
    const auth = await this.load();
    return auth?.apiKey?.trim() || undefined;
  }

  async saveApiKey(apiKey: string, model?: string): Promise<void> {
    if (!apiKey.trim()) throw new Error("Ollama API key must not be empty.");
    const existing = await this.load();
    const auth: OllamaAuthFile = {
      apiKey: apiKey.trim(),
      model: resolveOllamaModel(model ?? existing?.model ?? DEFAULT_LOCAL_MODEL),
      host: normalizeHost(process.env.OLLAMA_HOST ?? process.env.OLLAMA_CLOUD_HOST ?? existing?.host ?? DEFAULT_LOCAL_HOST),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.home, { recursive: true });
    await writeFile(this.authPath(), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
    try {
      await chmod(this.authPath(), 0o600);
    } catch {
      // Windows may ignore POSIX mode changes.
    }
  }

  async saveModel(model: string): Promise<void> {
    const existing = await this.load();
    const auth: OllamaAuthFile = {
      apiKey: existing?.apiKey?.trim() || undefined,
      model: resolveOllamaModel(model),
      host: normalizeHost(process.env.OLLAMA_HOST ?? process.env.OLLAMA_CLOUD_HOST ?? existing?.host ?? DEFAULT_LOCAL_HOST),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.home, { recursive: true });
    await writeFile(this.authPath(), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
  }

  async saveHost(host: string): Promise<void> {
    const existing = await this.load();
    const auth: OllamaAuthFile = {
      apiKey: existing?.apiKey?.trim() || undefined,
      model: resolveOllamaModel(existing?.model ?? DEFAULT_LOCAL_MODEL),
      host: normalizeHost(host || DEFAULT_LOCAL_HOST),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.home, { recursive: true });
    await writeFile(this.authPath(), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
  }

  async logout(): Promise<boolean> {
    try {
      await rm(this.authPath(), { force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async load(): Promise<OllamaAuthFile | undefined> {
    try {
      const raw = await readFile(this.authPath(), "utf8");
      const parsed = JSON.parse(raw.trimStart().replace(/^\uFEFF/, "")) as Partial<OllamaAuthFile>;
      return {
        apiKey: typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        host: typeof parsed.host === "string" ? parsed.host : undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private hostFromEnvOrFile(): string {
    return normalizeHost(process.env.OLLAMA_HOST ?? process.env.OLLAMA_CLOUD_HOST ?? DEFAULT_LOCAL_HOST);
  }
}

export class OllamaCloudClient {
  private readonly authStore: OllamaCloudAuthStore;
  private readonly fetchImpl: FetchLike;
  readonly host: string;
  readonly model: string;

  constructor(options: { authStore?: OllamaCloudAuthStore; fetchImpl?: FetchLike; host?: string; model?: string } = {}) {
    this.authStore = options.authStore ?? new OllamaCloudAuthStore();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.host = normalizeHost(options.host ?? process.env.OLLAMA_HOST ?? process.env.OLLAMA_CLOUD_HOST ?? DEFAULT_LOCAL_HOST);
    this.model = resolveOllamaModel(options.model ?? process.env.CRIX_OLLAMA_MODEL ?? process.env.OLLAMA_CLOUD_MODEL ?? DEFAULT_LOCAL_MODEL);
  }

  async chat(messages: OllamaChatMessage[], model = this.model, options: OllamaRequestOptions = {}): Promise<string> {
    return extractOllamaText(await this.chatResponse(messages, model, options));
  }

  async chatResponse(messages: OllamaChatMessage[], model = this.model, options: OllamaRequestOptions & { tools?: OllamaChatFunctionTool[] } = {}): Promise<OllamaChatResponse> {
    const resolvedModel = resolveOllamaModel(model);
    const apiKey = await this.authStore.getApiKey();
    const host = resolveRequestHost(this.host, resolvedModel, apiKey);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${host}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: resolvedModel,
          messages,
          ...(options.tools?.length ? { tools: options.tools } : {}),
          stream: false,
        }),
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(formatOllamaFetchError(error, host, resolvedModel, Boolean(apiKey)));
    }
    if (!response.ok) throw new Error(formatOllamaError(response.status, await safeResponseText(response)));
    return (await response.json()) as OllamaChatResponse;
  }

  async chatStream(messages: OllamaChatMessage[], onDelta: OllamaTextDeltaHandler, model = this.model, options: OllamaRequestOptions = {}): Promise<string> {
    const resolvedModel = resolveOllamaModel(model);
    const apiKey = await this.authStore.getApiKey();
    const host = resolveRequestHost(this.host, resolvedModel, apiKey);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${host}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: resolvedModel,
          messages,
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (error) {
      throw new Error(formatOllamaFetchError(error, host, resolvedModel, Boolean(apiKey)));
    }
    if (!response.ok) throw new Error(formatOllamaError(response.status, await safeResponseText(response)));
    if (!response.body) {
      const text = extractOllamaText((await response.json()) as OllamaChatResponse);
      await onDelta(text);
      return text;
    }
    return await parseOllamaStream(response.body, onDelta);
  }

  async listModels(): Promise<string[]> {
    const apiKey = await this.authStore.getApiKey();
    const host = resolveRequestHost(this.host, this.model, apiKey);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${host}/api/tags`, {
        method: "GET",
        headers,
      });
    } catch (error) {
      throw new Error(formatOllamaFetchError(error, host, this.model, Boolean(apiKey)));
    }
    if (!response.ok) throw new Error(formatOllamaError(response.status, await safeResponseText(response)));
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    const names = (payload.models ?? [])
      .map((item) => item.name || item.model)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return [...new Set(names)];
  }

  async completeText(text: string, systemPrompt = buildChatSystemPrompt(), options: OllamaRequestOptions = {}): Promise<string> {
    return await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ], this.model, options);
  }

  async streamCompleteText(text: string, onDelta: OllamaTextDeltaHandler, systemPrompt = buildChatSystemPrompt(), options: OllamaRequestOptions = {}): Promise<string> {
    return await this.chatStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ], onDelta, this.model, options);
  }

  async createUpgradePlan(request: ProviderRequest, options: OllamaRequestOptions = {}): Promise<{ text: string; plan?: UpgradePlan; toolCalls?: ToolCall[] }> {
    const response = await this.chatResponse([
      { role: "system", content: `${request.systemPrompt}\nReturn only valid JSON matching the Crix UpgradePlan contract.` },
      { role: "user", content: buildUpgradePlanUserPrompt(request) },
    ], this.model, { ...options, tools: request.tools.length ? ollamaChatTools(request.tools) : undefined });
    const nativeToolCalls = extractOllamaToolCalls(response);
    if (nativeToolCalls.length > 0) {
      return { text: `requested ${nativeToolCalls.length} native Ollama tool call(s)`, toolCalls: nativeToolCalls };
    }
    const text = stripJsonFence(extractOllamaText(response));
    try {
      return parseProviderJsonResponse(text);
    } catch {
      return { text };
    }
  }
}

export function resolveOllamaModel(value?: string): string {
  const key = value?.trim().toLowerCase();
  if (!key) return DEFAULT_LOCAL_MODEL;
  return OLLAMA_CLOUD_MODELS[key as keyof typeof OLLAMA_CLOUD_MODELS] ?? value!.trim();
}

export async function hasUsableOllamaCloudAuth(store = new OllamaCloudAuthStore()): Promise<boolean> {
  return (await store.status()).configured;
}

export function extractOllamaText(value: OllamaChatResponse): string {
  const text = value.message?.content ?? value.response;
  if (!text?.trim()) throw new Error("Ollama response text was empty.");
  return text.trim();
}

async function parseOllamaStream(stream: ReadableStream<Uint8Array>, onDelta: OllamaTextDeltaHandler): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks: string[] = [];

  async function drainLines(final = false): Promise<void> {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? "" : lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: OllamaChatResponse & { done?: boolean };
      try {
        event = JSON.parse(trimmed) as OllamaChatResponse & { done?: boolean };
      } catch {
        continue;
      }
      const delta = event.message?.content ?? event.response ?? "";
      if (delta) {
        chunks.push(delta);
        await onDelta(delta);
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      await drainLines(false);
    }
    if (done) {
      buffer += decoder.decode();
      await drainLines(true);
      break;
    }
  }

  const text = chunks.join("");
  if (!text.trim()) throw new Error("Ollama response text was empty.");
  return text.trim();
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function normalizeHost(host: string): string {
  const raw = host.trim() || DEFAULT_LOCAL_HOST;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    if (
      !url.port
      && url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    ) {
      url.port = "11434";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function resolveRequestHost(host: string, model: string, apiKey?: string): string {
  if (apiKey && isDefaultLocalHost(host) && isOllamaCloudModel(model)) return DEFAULT_REMOTE_HOST;
  return host;
}

function isDefaultLocalHost(host: string): boolean {
  try {
    const url = new URL(host);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname) && (!url.port || url.port === "11434");
  } catch {
    return host === DEFAULT_LOCAL_HOST;
  }
}

function isOllamaCloudModel(model: string): boolean {
  const value = model.toLowerCase();
  return value.endsWith(":cloud") || value.endsWith("-cloud");
}

function previewToken(token: string): string {
  if (token.length <= 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function formatOllamaError(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "Ollama request auth failed. Local Ollama does not require auth; cloud API endpoints require valid credentials.";
  }
  return `Ollama request failed with HTTP ${status}: ${body}`;
}

function formatOllamaFetchError(error: unknown, host: string, model: string, hasApiKey: boolean): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isDefaultLocalHost(host)) {
    if (isOllamaCloudModel(model)) {
      return [
        `Could not reach local Ollama at ${host}.`,
        "The selected model looks like a cloud alias. Crix still talks through your local Ollama app/server; start Ollama locally or choose an installed local model.",
        `network: ${detail}`,
      ].join("\n");
    }
    return [
      `Could not reach local Ollama at ${host}.`,
      "Start Ollama locally, then try `ollama list` or choose an installed local model.",
      `network: ${detail}`,
    ].join("\n");
  }
  if (host === DEFAULT_REMOTE_HOST && !hasApiKey) {
    return "Direct remote Ollama API access requires an externally configured API key; Crix does not manage Ollama login.";
  }
  return `Ollama request to ${host} failed: ${detail}`;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 1000);
}
