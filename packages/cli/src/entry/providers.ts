// Extracted from entry.ts — providers.

import { MockEchoProvider, OpenAIResponsesProvider, OpenRouterProvider, DeepSeekProvider, AnthropicProvider, DEFAULT_ANTHROPIC_MODEL, OllamaCloudPool, DEFAULT_OLLAMA_SLOTS, OLLAMA_CLOUD_MODELS, fetchDeepSeekModels, fetchOpenRouterModels, fetchAnthropicModels, loadAuthToken, type Provider } from "@ares/core";
import path from "node:path";
import { type SubModelPool } from "@ares/tools";
import { loadUiSettings, type UiSettings } from "../uiSettings.js";

// Ares talks to the LOCAL Ollama daemon (native /api/chat) by default — it
// proxies :cloud models via your `ollama signin`. We do NOT auto-flip into
// Anthropic-compat from stray ANTHROPIC_* env (those are common from other
// tools and would hijack the call into a key-required endpoint → 401). Compat
// is opt-in only via ARES_OLLAMA_ANTHROPIC_COMPAT=1.
export const NATIVE_OLLAMA_OPTS = {
  useAnthropicCompat: process.env.ARES_OLLAMA_ANTHROPIC_COMPAT === "1",
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
} as const;

export interface ProviderSelection {
  provider: Provider;
  model: string;
  source: string;
  subModel?: SubModelPool;
}

interface DaemonModelOption {
  id: string;
  label?: string;
  hint?: string;
  group: string;
  capabilities?: string[];
}

export const TERMINAL_PROVIDERS = ["ollama", "openai", "anthropic", "deepseek", "openrouter", "custom", "mock"] as const;

type TerminalProviderId = (typeof TERMINAL_PROVIDERS)[number];

export const ROUTE_LANES = ["chat", "coding", "research", "tool-use"] as const;

const STATIC_MODEL_CATALOG: Record<"openai" | "anthropic" | "mock", DaemonModelOption[]> = {
  openai: [
    { id: "gpt-5.5", hint: "flagship deep reasoning", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
    { id: "gpt-5.5-codex", hint: "agentic coding tuned", group: "OpenAI", capabilities: ["tools", "reasoning"] },
    { id: "gpt-5.1", hint: "previous flagship", group: "OpenAI", capabilities: ["tools", "reasoning", "vision"] },
    { id: "gpt-5.1-codex", hint: "coding tuned", group: "OpenAI", capabilities: ["tools", "reasoning"] },
    { id: "gpt-5", hint: "stable baseline", group: "OpenAI", capabilities: ["tools", "reasoning"] },
    { id: "gpt-5-mini", hint: "fast + cheap", group: "OpenAI", capabilities: ["tools"] },
  ],
  anthropic: [
    { id: "claude-fable-5", hint: "flagship adaptive thinking", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-opus-4-8", hint: "deep reasoning workhorse · 1M context", group: "Anthropic", capabilities: ["tools", "reasoning", "vision"] },
    { id: "claude-sonnet-4-6", hint: "balanced speed / depth", group: "Anthropic", capabilities: ["tools", "reasoning"] },
    { id: "claude-haiku-4-5-20251001", hint: "fast + cheap", group: "Anthropic", capabilities: ["tools"] },
  ],
  mock: [{ id: "mock-echo", hint: "offline echo provider for UI testing", group: "Mock", capabilities: [] }],
};

export function isTerminalProviderId(provider: string): provider is TerminalProviderId {
  return (TERMINAL_PROVIDERS as readonly string[]).includes(provider);
}

export function defaultTerminalModel(provider: string, settings: UiSettings): string {
  switch (provider) {
    case "openai":
      return settings.lastOpenAIModel ?? STATIC_MODEL_CATALOG.openai[0].id;
    case "anthropic":
      return settings.lastAnthropicModel ?? STATIC_MODEL_CATALOG.anthropic[0].id;
    case "deepseek":
      return settings.lastDeepSeekModel ?? "deepseek-v4-pro";
    case "openrouter":
      return settings.lastOpenRouterModel ?? "openai/gpt-4o-mini";
    case "mock":
      return "mock-echo";
    case "ollama":
    default:
      return settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model;
  }
}

/** Build a live model catalog without exposing provider keys to the webview. */
export async function daemonModelCatalog(provider: string): Promise<DaemonModelOption[]> {
  const settings = await loadUiSettings();

  if (provider === "openai" || provider === "mock") {
    return STATIC_MODEL_CATALOG[provider];
  }

  if (provider === "anthropic") {
    // Live-fetch-with-static-fallback, same pattern as the deepseek branch below:
    // an unreachable/unauthed Anthropic API silently falls back to the curated
    // static catalog rather than returning an empty list.
    const live = await fetchAnthropicModels(settings.anthropicKey || process.env.ANTHROPIC_API_KEY || process.env.ARES_ANTHROPIC_API_KEY || "").catch(() => []);
    if (live.length === 0) return STATIC_MODEL_CATALOG.anthropic;
    const staticHints = new Map(STATIC_MODEL_CATALOG.anthropic.map((m) => [m.id, m]));
    return live.map((model: { id: string; label?: string }) => {
      const known = staticHints.get(model.id);
      return {
        id: model.id,
        label: model.label ?? known?.hint,
        hint: known?.hint ?? model.label ?? "",
        group: "Anthropic",
        capabilities: known?.capabilities ?? ["tools", "reasoning"],
      };
    });
  }

  if (provider === "openrouter") {
    const rows = await fetchOpenRouterModels().catch(() => []);
    return rows.map((model) => ({
      id: model.id,
      label: model.name,
      hint: [
        model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : "",
        model.promptPrice ? `$${(Number(model.promptPrice) * 1e6).toFixed(2)}/M in` : "",
      ].filter(Boolean).join(" · "),
      group: "OpenRouter",
      capabilities: [
        ...(model.supportedParameters ?? []).filter((item) => item === "tools" || item === "reasoning" || item === "structured_outputs"),
        ...((model.inputModalities ?? []).includes("image") ? ["vision"] : []),
        ...(Number(model.promptPrice ?? "1") === 0 ? ["free"] : []),
      ],
    }));
  }

  if (provider === "deepseek") {
    const live = await fetchDeepSeekModels({ apiKey: settings.deepSeekKey }).catch(() => []);
    const rows = live.length > 0
      ? live
      : [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }];
    return rows.map((model) => ({
      id: model.id,
      label: model.id === "deepseek-v4-pro" ? "DeepSeek V4 Pro" : model.id === "deepseek-v4-flash" ? "DeepSeek V4 Flash" : model.id,
      hint: model.id.includes("flash") ? "fast agentic reasoning · 1M context" : "frontier coding + reasoning · 1M context",
      group: "DeepSeek",
      capabilities: ["tools", "reasoning"],
    }));
  }

  if (provider !== "ollama") return [];

  const byId = new Map<string, DaemonModelOption>();
  const put = (model: DaemonModelOption) => {
    const prior = byId.get(model.id);
    byId.set(model.id, {
      ...prior,
      ...model,
      capabilities: [...new Set([...(prior?.capabilities ?? []), ...(model.capabilities ?? [])])],
    });
  };

  for (const model of OLLAMA_CLOUD_MODELS) {
    put({
      id: model.id,
      hint: model.hint,
      group: `Ollama Cloud · ${model.role}`,
      capabilities: model.role === "reasoner" ? ["tools", "reasoning"] : ["tools"],
    });
  }

  if (settings.ollamaApiKey || process.env.OLLAMA_API_KEY) {
    const apiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY || "";
    const response = await fetch("https://ollama.com/api/tags", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    }).catch(() => null);
    if (response?.ok) {
      const payload = await response.json() as {
        models?: Array<{
          name?: string;
          model?: string;
          size?: number;
          details?: { parameter_size?: string; family?: string };
        }>;
      };
      for (const row of payload.models ?? []) {
        const id = row.name ?? row.model;
        if (!id) continue;
        put({
          id,
          hint: [row.details?.parameter_size, row.details?.family].filter(Boolean).join(" · "),
          group: "Ollama Cloud · live",
          capabilities: ["tools"],
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function providerFamilyForSelection(selection: ProviderSelection): string {
  const fromSource = selection.source.split(":").at(-1);
  if (fromSource && ["openai", "ollama", "anthropic", "deepseek", "openrouter", "mock"].includes(fromSource)) {
    return fromSource;
  }
  const name = selection.provider.name.toLowerCase();
  if (name.startsWith("ollama")) return "ollama";
  if (name.startsWith("mock")) return "mock";
  return name;
}

export async function selectProvider(flags: Map<string, string>): Promise<ProviderSelection> {
  const explicit = flags.get("provider");
  const requestedModel = flags.get("model");
  const auth = await loadAuthToken();
  const settings = await loadUiSettings();
  const preferred = explicit ?? settings.lastProvider;

  if (preferred === "mock") {
    return {
      provider: new MockEchoProvider(),
      model: requestedModel ?? "mock-echo",
      source: "explicit:mock",
    };
  }

  if (preferred === "openai" || (!preferred && auth)) {
    const provider = new OpenAIResponsesProvider();
    return {
      provider,
      model: requestedModel ?? process.env.ARES_OPENAI_MODEL ?? settings.lastOpenAIModel ?? "gpt-5.5",
      source: explicit ? "explicit:openai" : preferred ? "settings:openai" : "auto:openai",
    };
  }

  if (preferred === "openrouter") {
    const model = requestedModel ?? settings.lastOpenRouterModel ?? "openai/gpt-4o-mini";
    return {
      // Empty key → the provider yields a clear no_auth error the UI surfaces.
      provider: new OpenRouterProvider({ apiKey: settings.openRouterKey ?? "", model }),
      model,
      source: explicit ? "explicit:openrouter" : "settings:openrouter",
    };
  }

  if (preferred === "custom") {
    // Universal OpenAI-compatible provider: the owner points Ares at ANY base URL
    // (Together, Groq, Fireworks, a self-hosted vLLM, LM Studio, a gateway…) plus
    // a key, and model discovery hits {base}/models. Reuses the OpenAI-compatible
    // OpenRouter client — same /chat/completions wire shape. Empty key/url yields
    // a clear no_auth error the UI surfaces. baseUrl should end at the API root
    // (…/v1); the trailing slash is stripped so paths don't double up.
    const model = requestedModel ?? settings.lastCustomModel ?? "";
    const baseUrl = (settings.customBaseUrl || process.env.ARES_CUSTOM_BASE_URL || "").trim().replace(/\/+$/, "");
    return {
      provider: new OpenRouterProvider({
        apiKey: settings.customApiKey || process.env.ARES_CUSTOM_API_KEY || "",
        baseUrl: baseUrl || undefined,
        model,
      }),
      model,
      source: explicit ? "explicit:custom" : "settings:custom",
    };
  }

  if (preferred === "deepseek") {
    const model = requestedModel ?? settings.lastDeepSeekModel ?? "deepseek-v4-pro";
    // Default: DeepSeek's Anthropic-compatible endpoint via the hardened
    // AnthropicProvider — proper thinking<->tool interleaving, unsigned-reasoning
    // echo on tool loops (DeepSeek 400s otherwise), no wasted cache_control /
    // budget_tokens. x-api-key skips the OAuth identity branch (no Claude-Code
    // leak). ARES_DEEPSEEK_DIALECT=openai forces the legacy OpenAI-compat path.
    const useOpenAiDialect = process.env.ARES_DEEPSEEK_DIALECT === "openai";
    return {
      provider: useOpenAiDialect
        ? new DeepSeekProvider({ apiKey: settings.deepSeekKey, model })
        : new AnthropicProvider({
            apiKey: settings.deepSeekKey || undefined,
            // /anthropic is the base; the Messages API path appends like Anthropic's own.
            endpointUrl: "https://api.deepseek.com/anthropic/v1/messages",
            dialect: "deepseek",
          }),
      model,
      source: explicit ? "explicit:deepseek" : "settings:deepseek",
    };
  }

  if (preferred === "anthropic") {
    const model = requestedModel ?? settings.lastAnthropicModel ?? DEFAULT_ANTHROPIC_MODEL;
    return {
      // Empty key → AnthropicProvider falls back to ARES_ANTHROPIC_API_KEY /
      // ANTHROPIC_API_KEY, then yields a clear no_auth error the UI surfaces.
      provider: new AnthropicProvider({ apiKey: settings.anthropicKey || undefined }),
      model,
      source: explicit ? "explicit:anthropic" : "settings:anthropic",
    };
  }

  if (preferred === "ollama" || !preferred) {
    const slots = {
      ...DEFAULT_OLLAMA_SLOTS,
      reasoner: { model: requestedModel ?? settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model },
    };
    const ollamaApiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY;
    // A cloud API key with no explicit OLLAMA_HOST means "use Ollama's CLOUD"
    // (ollama.com) — not the local app. Without this, a user who set only an API
    // key (no local Ollama running) times out hitting 127.0.0.1. An explicit
    // OLLAMA_HOST, or no key at all, keeps the local-app default.
    const ollamaHost =
      process.env.OLLAMA_HOST ?? (ollamaApiKey ? "https://ollama.com" : "http://127.0.0.1:11434");
    const pool = new OllamaCloudPool({
      slots,
      useAnthropicCompat: NATIVE_OLLAMA_OPTS.useAnthropicCompat,
      host: ollamaHost,
      apiKey: ollamaApiKey,
    });
    return {
      provider: pool.provider("reasoner"),
      model: slots.reasoner.model,
      source: explicit ? "explicit:ollama" : preferred ? "settings:ollama" : "auto:ollama",
      subModel: {
        apply: (req) => pool.apply(req),
        summarize: (req) => pool.summarize(req),
      },
    };
  }

  throw new Error(`unknown provider: ${preferred}`);
}
