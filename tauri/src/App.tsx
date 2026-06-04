import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "framer-motion";
import * as THREE from "three";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Cloud,
  Code2,
  Database,
  Flag,
  Gauge,
  Globe2,
  HardDrive,
  HeartPulse,
  ImagePlus,
  Info,
  Layers,
  MessageSquare,
  Minus,
  Pencil,
  Play,
  Power,
  RefreshCw,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  TerminalSquare,
  Trash2,
  Wallet,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";

type View = "chat" | "providers" | "mind" | "tools";
type ProviderId = "ollama" | "openai" | "mock";
type ThemeName = "signal" | "graphite" | "oxide" | "matrix" | "storm";
type CornerMode = "rounded" | "square";
type HeartbeatStatus = "idle" | "active" | "alert" | "dreaming" | "error";
type DaemonState = "starting" | "running" | "stopped" | "error";

interface EvolutionGain {
  target: string;
  delta: number;
  kind?: string;
}

interface CrixEvent {
  type: string;
  id?: string;
  text?: string;
  name?: string;
  toolName?: string;
  status?: string;
  source?: string;
  phase?: string;
  root?: string;
  reason?: string;
  suggestion?: string;
  decision?: string;
  level?: string;
  reasoningLevel?: string;
  error?: unknown;
  provider?: string;
  model?: string;
  durationMs?: number;
  receivedAt?: number;
  startedAt?: number;
  updatedAt?: number;
  activityDescription?: string;
  display?: string;
  output?: unknown;
  input?: unknown;
  data?: unknown;
  touchedFiles?: string[];
  attachments?: ChatAttachment[];
  webSearch?: boolean;
  gain?: EvolutionGain;
  // For wrapped lifecycle events: { type: "lifecycle", event: { type, gain, ... } }
  event?: CrixEvent;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

interface EvolutionPulse {
  id: number;
  sourceType: string;
  target: string;
  delta: number;
  kind?: string;
  createdAt: number;
}

interface DaemonStatus {
  running: boolean;
  root?: string | null;
  provider?: string | null;
  model?: string | null;
}

interface BufferedEvent {
  seq: number;
  event: CrixEvent;
}

interface ProviderModel {
  id: string;
  hint: string;
  group: string;
  source?: "cloud" | "local" | "dev";
  size?: number;
  modifiedAt?: string;
  description?: string;
  family?: string;
  parameters?: string;
  quantization?: string;
  contextWindow?: number;
  modalities?: string[];
  capabilities?: string[];
  storagePath?: string;
  pulls?: string;
  updated?: string;
  usageLevel?: 1 | 2 | 3 | 4;
  usageLabel?: string;
  websiteUrl?: string;
  imageUrl?: string;
}

interface ProviderOption {
  id: ProviderId;
  label: string;
  note: string;
  models: ProviderModel[];
}

interface Selection {
  provider: ProviderId;
  model: string;
}

interface CrixIdentity {
  name?: string | null;
  avatar?: string | null;
  mark?: string | null;
}

interface OllamaDiscovery {
  host: string;
  reachable: boolean;
  models: ProviderModel[];
  error?: string;
  localRoot?: string;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  turns: number;
  updatedAt: number;
}

interface SessionRecord {
  id: string;
  name: string;
  events: CrixEvent[];
  createdAt: number;
  updatedAt: number;
}

interface ChatAttachment {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
}

interface AppearanceSettings {
  opacity: number;
  corners: CornerMode;
}

const SETTINGS_KEY = "crix.desktop.settings.v2";
const USAGE_KEY = "crix.desktop.modelUsage.v1";
const SESSION_LIMIT = 220;

const OLLAMA_CLOUD_MODELS: ProviderModel[] = [
  model("qwen3-coder:480b-cloud", "Top coding reasoner", "engineering", "cloud", {
    parameters: "480B",
    contextWindow: 262144,
    capabilities: ["tools"],
    pulls: "5.7M",
    updated: "8 months ago",
    usageLevel: 4,
    usageLabel: "High",
    websiteUrl: "https://ollama.com/library/qwen3-coder",
    imageUrl: "https://ollama.com/assets/library/qwen3/a5541098-87ba-4184-a5af-2b63312c2522",
    description: "Alibaba's performant long context models for agentic and coding tasks.",
  }),
  model("qwen3-coder-next:cloud", "Agentic coding", "engineering", "cloud", {
    parameters: "79.7B",
    contextWindow: 262144,
    capabilities: ["tools"],
    pulls: "1.3M",
    updated: "3 months ago",
    usageLevel: 2,
    usageLabel: "Medium",
    websiteUrl: "https://ollama.com/library/qwen3-coder-next",
    imageUrl: "https://ollama.com/assets/library/qwen3-coder-next/dbbd2b20-4b43-4d02-9cfe-e83a63cabae8",
    description: "Qwen3-Coder-Next is a coding-focused language model from Alibaba's Qwen team, optimized for agentic coding workflows and local development.",
  }),
  model("qwen3.5:397b-cloud", "Large multimodal reasoner", "engineering", "cloud", {
    parameters: "397B",
    contextWindow: 262144,
    capabilities: ["vision", "tools", "thinking"],
    modalities: ["Text", "Image"],
    pulls: "12.7M",
    updated: "6 days ago",
    usageLevel: 2,
    usageLabel: "Medium",
    websiteUrl: "https://ollama.com/library/qwen3.5",
    description: "Qwen 3.5 is a family of open-source multimodal models that delivers exceptional utility and performance.",
  }),
  model("deepseek-v4-pro:cloud", "Frontier reasoning", "engineering", "cloud", {
    contextWindow: 1_000_000,
    capabilities: ["tools", "thinking"],
    pulls: "85.6K",
    updated: "1 month ago",
    usageLevel: 4,
    usageLabel: "Extra heavy",
    websiteUrl: "https://ollama.com/library/deepseek-v4-pro",
    description: "DeepSeek-V4-Pro is a frontier Mixture-of-Experts model with a 1M-token context window and three reasoning modes.",
  }),
  model("deepseek-v4-flash:cloud", "Fast long-context reasoning", "engineering", "cloud", {
    parameters: "284B",
    contextWindow: 1_000_000,
    capabilities: ["tools", "thinking"],
    pulls: "93.4K",
    updated: "1 month ago",
    usageLevel: 3,
    usageLabel: "Heavy",
    websiteUrl: "https://ollama.com/library/deepseek-v4-flash",
    description: "DeepSeek-V4-Flash is a preview of the DeepSeek-V4 series, a Mixture-of-Experts model with 284B total parameters and 13B activated, built for efficient reasoning across a 1M-token context window.",
  }),
  model("glm-5.1:cloud", "Flagship agentic engineering", "engineering", "cloud", {
    parameters: "756B",
    contextWindow: 198_000,
    capabilities: ["tools", "thinking"],
    pulls: "2.2M",
    updated: "1 month ago",
    usageLevel: 4,
    usageLabel: "High",
    websiteUrl: "https://ollama.com/library/glm-5.1",
    imageUrl: "https://ollama.com/assets/library/glm-4.7-flash/8e1f3c2e-cfb1-4516-a57c-312b7daac14a",
    description: "GLM-5.1 is our next-generation flagship model for agentic engineering, with significantly stronger coding capabilities than its predecessor. It achieves state-of-the-art performance on SWE-Bench Pro and leads GLM-5 by a wide margin.",
  }),
  model("kimi-k2.6:cloud", "Multimodal agentic coding", "engineering", "cloud", {
    capabilities: ["vision", "tools", "thinking"],
    modalities: ["Text", "Image"],
    pulls: "270.6K",
    updated: "1 month ago",
    usageLevel: 3,
    usageLabel: "Heavy",
    websiteUrl: "https://ollama.com/library/kimi-k2.6",
    description: "Kimi K2.6 is an open-source, native multimodal agentic model that advances practical capabilities in long-horizon coding, coding-driven design, proactive autonomous execution, and swarm-based task orchestration.",
  }),
  model("minimax-m2.7:cloud", "Coding and productivity", "engineering", "cloud", {
    capabilities: ["tools", "thinking"],
    pulls: "2.2M",
    updated: "2 months ago",
    usageLevel: 3,
    usageLabel: "Heavy",
    websiteUrl: "https://ollama.com/library/minimax-m2.7",
    description: "MiniMax's M2-series model for coding, agentic workflows, and professional productivity.",
  }),
  model("devstral-2:123b-cloud", "Codebase agents", "engineering", "cloud", {
    parameters: "123B",
    capabilities: ["tools"],
    usageLevel: 2,
    usageLabel: "Medium",
    websiteUrl: "https://ollama.com/library/devstral-2",
    description: "Codebase-oriented model for repo navigation, patching, and autonomous coding loops.",
  }),
  model("gpt-oss:120b-cloud", "Open reasoning", "engineering", "cloud", {
    parameters: "120B",
    capabilities: ["thinking"],
    usageLevel: 2,
    usageLabel: "Medium",
    websiteUrl: "https://ollama.com/library/gpt-oss",
    description: "Open-weight reasoning lane with cloud routing for general engineering work.",
  }),
  model("devstral-small-2:24b-cloud", "Fast apply/edit slot", "fast", "cloud", {
    parameters: "24B",
    capabilities: ["vision", "tools"],
    pulls: "845.9K",
    updated: "5 months ago",
    usageLevel: 1,
    usageLabel: "Light",
    websiteUrl: "https://ollama.com/library/devstral-small-2",
    description: "24B model that excels at using tools to explore codebases, editing multiple files and power software engineering agents.",
  }),
  model("gpt-oss:20b-cloud", "Fast summary utility", "fast", "cloud", {
    parameters: "20B",
    usageLevel: 1,
    usageLabel: "Light",
    websiteUrl: "https://ollama.com/library/gpt-oss",
    description: "Small open reasoning model for quick summaries, small edits, and utility turns.",
  }),
  model("gemini-3-flash-preview:cloud", "Fast multimodal", "general", "cloud", {
    capabilities: ["vision", "tools", "thinking"],
    modalities: ["Text", "Image"],
    pulls: "2.2M",
    updated: "5 months ago",
    usageLevel: 1,
    usageLabel: "Light",
    websiteUrl: "https://ollama.com/library/gemini-3-flash-preview",
    description: "Gemini 3 Flash offers frontier intelligence built for speed at a fraction of the cost.",
  }),
  model("gemma4:31b-cloud", "Multimodal reasoning", "general", "cloud", {
    parameters: "31B",
    contextWindow: 262144,
    capabilities: ["vision", "tools", "thinking"],
    modalities: ["Text", "Image"],
    pulls: "10.7M",
    updated: "6 days ago",
    usageLevel: 2,
    usageLabel: "Medium",
    websiteUrl: "https://ollama.com/library/gemma4",
    description: "Gemma 4 models are designed to deliver frontier-level performance at each size. They are well-suited for reasoning, agentic workflows, coding, and multimodal understanding.",
  }),
  model("qwen3-vl:235b-cloud", "Vision-language reasoning", "general", "cloud", {
    parameters: "235B",
    capabilities: ["vision"],
    modalities: ["Text", "Image"],
    usageLevel: 3,
    usageLabel: "Heavy",
    websiteUrl: "https://ollama.com/library/qwen3-vl",
    description: "Large Qwen vision-language model for screenshots, UI review, and image-grounded reasoning.",
  }),
];

const OPENAI_MODELS: ProviderModel[] = [
  model("gpt-5.5", "Default frontier model", "frontier", "cloud", { capabilities: ["tools", "thinking"], description: "Frontier model through Crix's OpenAI Responses path." }),
  model("gpt-5.1-codex", "Coding-specialized", "frontier", "cloud", { capabilities: ["tools"], description: "Coding-specialized OpenAI model for repo work and patch-heavy turns." }),
  model("gpt-5.1", "General reasoning", "frontier", "cloud", { capabilities: ["thinking"], description: "General OpenAI reasoning model for planning, analysis, and mixed tasks." }),
];

const DEV_MODELS: ProviderModel[] = [
  model("mock-echo", "No network, no auth", "local", "dev"),
];

// Reasoning dial — one control, translated per provider by the daemon (OpenAI
// reasoning.effort, Ollama/Anthropic thinking.budget_tokens). "Extra High" = max.
type ReasoningLevel = "low" | "medium" | "high" | "max";
type ReasoningSync = "idle" | "syncing" | "applied" | "error";
type PermissionDecision = "allow_once" | "allow_always" | "deny";

interface LiveActivity {
  title: string;
  detail: string;
  tone: "idle" | "active" | "warn" | "bad";
  startedAt?: number;
  updatedAt?: number;
}

const REASONING_OPTIONS: { id: ReasoningLevel; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Extra High" },
];
function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === "low" || value === "medium" || value === "high" || value === "max";
}

const PROVIDERS: ProviderOption[] = buildProviderOptions(false, []);

function buildProviderOptions(devMode: boolean, localOllamaModels: ProviderModel[]): ProviderOption[] {
  const providers: ProviderOption[] = [
  {
    id: "ollama",
    label: "Ollama",
    note: "Local daemon discovery plus cloud-capable model ids and Crix slot routing.",
    models: [...localOllamaModels, ...OLLAMA_CLOUD_MODELS],
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "OpenAI Responses through the existing Crix auth path.",
    models: OPENAI_MODELS,
  },
  ];
  if (devMode) {
    providers.push({
      id: "mock",
      label: "Mock",
      note: "Deterministic local echo provider for UI checks and demos.",
      models: DEV_MODELS,
    });
  }
  return providers;
}

const THEME_LABELS: Record<ThemeName, string> = {
  signal: "Frost",
  matrix: "Matrix",
  storm: "Storm",
  graphite: "Graphite",
  oxide: "Oxide",
};

const THEME_CHOICES: ThemeName[] = ["signal", "matrix", "storm"];

const STATUS_LABELS: Record<HeartbeatStatus, string> = {
  idle: "Ready",
  active: "Working",
  alert: "Attention",
  dreaming: "Dreaming",
  error: "Error",
};

const DEFAULT_SELECTION: Selection = {
  provider: "ollama",
  model: "qwen3-coder:480b-cloud",
};
const DEFAULT_APPEARANCE: AppearanceSettings = {
  opacity: 0.72,
  corners: "rounded",
};
const UI_DEV_MODE = import.meta.env.VITE_CRIX_DEV === "1";

function App() {
  const initial = loadDesktopSettings();
  const [theme, setTheme] = useState<ThemeName>(initial.theme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(initial.appearance);
  const [activeView, setActiveView] = useState<View>("chat");
  const [selection, setSelection] = useState<Selection>(initial.selection);
  const [draftSelection, setDraftSelection] = useState<Selection>(initial.selection);
  const [customModel, setCustomModel] = useState(initial.selection.model);
  const [sessions, setSessions] = useState<SessionRecord[]>(() => [createSession()]);
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id ?? "");
  const [status, setStatus] = useState<HeartbeatStatus>("idle");
  const [daemon, setDaemon] = useState<DaemonState>("starting");
  const [root, setRoot] = useState<string>("");
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [webSearchMode, setWebSearchMode] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>("medium");
  const [reasoningSync, setReasoningSync] = useState<ReasoningSync>("idle");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renamingSessionName, setRenamingSessionName] = useState("");
  const [devMode, setDevMode] = useState(() => UI_DEV_MODE);
  const [ollamaDiscovery, setOllamaDiscovery] = useState<OllamaDiscovery>({
    host: "http://localhost:11434",
    reachable: false,
    models: [],
  });
  const [agentIdentity, setAgentIdentity] = useState<CrixIdentity>({});
  const [usageByModel, setUsageByModel] = useState<Record<string, ModelUsage>>(loadModelUsage);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const selectionRef = useRef(selection);
  const lastEventSeqRef = useRef(0);
  const reasoningSyncTimerRef = useRef<number | null>(null);
  const reasoningSyncRef = useRef(reasoningSync);

  // Weirdcore +N TARGET pulses — agent evolution telemetry the daemon
  // forwards to us as { type: "lifecycle", event: { type, gain, ... } }.
  const [pulses, setPulses] = useState<EvolutionPulse[]>([]);
  const pulseIdRef = useRef(1);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPulses((prev) => prev.filter((p) => now - p.createdAt < 5000));
    }, 400);
    return () => window.clearInterval(timer);
  }, []);
  function pushPulse(sourceType: string, gain: EvolutionGain) {
    const id = pulseIdRef.current++;
    setPulses((prev) => [...prev.slice(-4), {
      id,
      sourceType,
      target: gain.target,
      delta: gain.delta,
      kind: gain.kind,
      createdAt: Date.now(),
    }]);
  }
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const events = activeSession?.events ?? [];
  const providers = useMemo(() => buildProviderOptions(devMode, ollamaDiscovery.models), [devMode, ollamaDiscovery.models]);
  const provider = providerById(draftSelection.provider, providers);
  const visibleModels = provider.models;
  const running = daemon === "running";
  const stats = useMemo(() => collectStats(events), [events]);
  const activeSelection = useMemo(
    () => ({
      provider: draftSelection.provider,
      model: draftSelection.model === "__custom" ? customModel : draftSelection.model,
    }),
    [customModel, draftSelection.model, draftSelection.provider],
  );
  const modelSelectionChanged = activeSelection.provider !== selection.provider || activeSelection.model !== selection.model;
  const liveActivity = useMemo(
    () => currentLiveActivity(events, daemon, status, clockNow),
    [clockNow, daemon, events, status],
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    reasoningSyncRef.current = reasoningSync;
  }, [reasoningSync]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (reasoningSyncTimerRef.current !== null) {
        window.clearTimeout(reasoningSyncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    saveDesktopSettings({ theme, selection, appearance });
    if (hasNativeBridge()) void invoke("crix_set_theme", { name: theme }).catch(() => null);
  }, [theme, selection, appearance]);

  useEffect(() => {
    saveModelUsage(usageByModel);
  }, [usageByModel]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (!hasNativeBridge()) {
        if (!mounted) return;
        setDevMode(UI_DEV_MODE);
        setOllamaDiscovery({
          host: "http://localhost:11434",
          reachable: false,
          models: [],
          error: "Native discovery runs in the desktop app.",
        });
        return;
      }
      try {
        const [nextDevMode, discovery] = await Promise.all([
          invoke<boolean>("crix_dev_mode").catch(() => UI_DEV_MODE),
          invoke<OllamaDiscovery>("crix_ollama_models").catch((error: unknown) => ({
            host: "http://localhost:11434",
            reachable: false,
            models: [],
            error: String(error),
          })),
        ]);
        if (!mounted) return;
        setDevMode(Boolean(nextDevMode) || UI_DEV_MODE);
        setOllamaDiscovery(discovery);
      } catch {
        // Discovery is best effort; static cloud cards remain usable.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 18_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!hasNativeBridge()) return;
    let mounted = true;
    const refresh = async () => {
      const identity = await invoke<CrixIdentity>("crix_agent_identity").catch(() => ({}));
      if (mounted) setAgentIdentity(identity);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (devMode || selection.provider !== "mock") return;
    const fallback = { provider: "ollama" as const, model: modelForProvider("ollama", providers) };
    setSelection(fallback);
    setDraftSelection(fallback);
    setCustomModel(fallback.model);
  }, [devMode, providers, selection.provider]);

  useEffect(() => {
    let mounted = true;
    let poller: number | null = null;
    let unlistenBuffered: (() => void) | null = null;

    if (!hasNativeBridge()) {
      setDaemon("stopped");
      appendToActiveSession({ type: "desktop_preview", text: "Browser preview mode. Native daemon controls are available in the Tauri app." });
      lastEventSeqRef.current = Number.MAX_SAFE_INTEGER;
      return () => {
        mounted = false;
      };
    }

    const acceptBufferedEvent = (item: BufferedEvent) => {
      if (item.seq <= lastEventSeqRef.current) return;
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, item.seq);
      handleDaemonEvent(item.event);
    };

    const poll = async () => {
      try {
        const events = await invoke<BufferedEvent[]>("crix_drain_events", { after: lastEventSeqRef.current });
        if (!mounted) return;
        for (const item of events) {
          acceptBufferedEvent(item);
        }
      } catch {
        if (mounted && lastEventSeqRef.current === 0) {
          appendToActiveSession({ type: "desktop_preview", text: "Browser preview mode. Native daemon controls are available in the Tauri app." });
          lastEventSeqRef.current = Number.MAX_SAFE_INTEGER;
        }
      }
    };

    const boot = async () => {
      try {
        const stopListening = await listen<BufferedEvent>("crix:event-buffered", (event) => {
          if (!mounted) return;
          acceptBufferedEvent(event.payload);
        });
        if (!mounted) {
          stopListening();
          return;
        }
        unlistenBuffered = stopListening;
      } catch {
        // Polling below is the compatibility path for browser preview and older shells.
      }
      if (!mounted) return;

      invoke<DaemonStatus>("crix_start_daemon", daemonSelectionArgs(initial.selection))
        .then((state) => {
          if (!mounted) return;
          applyDaemonStatus(state);
        })
        .catch((error: unknown) => {
          if (!mounted) return;
          setDaemon("error");
          setStatus("error");
          appendToActiveSession({ type: "desktop_error", text: String(error) });
        });

      void poll();
      poller = window.setInterval(() => void poll(), 1000);
    };
    void boot();

    return () => {
      mounted = false;
      if (poller !== null) window.clearInterval(poller);
      unlistenBuffered?.();
    };
  }, []);

  useEffect(() => {
    const target = transcriptRef.current;
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      target.scrollTop = target.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events.length, activeSessionId]);

  function appendToActiveSession(event: CrixEvent) {
    const targetSessionId = activeSessionIdRef.current;
    const stamped = { ...event, receivedAt: event.receivedAt ?? Date.now() };
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== targetSessionId) return session;
        const nextEvents = appendEvent(session.events, stamped).slice(-SESSION_LIMIT);
        return {
          ...session,
          events: nextEvents,
          updatedAt: Date.now(),
          name: session.name === "New session" && stamped.type === "user_send" && stamped.text ? titleFromPrompt(stamped.text) : session.name,
        };
      }),
    );
  }

  function handleDaemonEvent(detail: CrixEvent) {
    if (!detail) return;
    // Lifecycle envelopes drive pulses/status only. They are not chat lines.
    if (detail.type === "lifecycle" && detail.event) {
      const inner = detail.event;
      if (inner.gain && inner.gain.target && typeof inner.gain.delta === "number") {
        pushPulse(inner.type, inner.gain);
      }
      if (inner.type === "dream_phase_started") setStatus("dreaming");
      if (inner.type === "dream_phase_ended") setStatus("idle");
      return;
    }
    if (detail.gain && detail.gain.target && typeof detail.gain.delta === "number") {
      pushPulse(detail.type, detail.gain);
    }
    if (detail.root) setRoot(detail.root);
    if (detail.provider && isProviderId(detail.provider)) {
      setSelection((current) => ({ provider: detail.provider as ProviderId, model: detail.model || current.model }));
      setDraftSelection((current) => ({ provider: detail.provider as ProviderId, model: detail.model || current.model }));
    }
    if (detail.model) {
      setSelection((current) => ({ ...current, model: detail.model || current.model }));
      setDraftSelection((current) => ({ ...current, model: detail.model || current.model }));
      setCustomModel(detail.model);
    }
    if (detail.type === "daemon_ready" || detail.type === "desktop_daemon_started") setDaemon("running");
    const maybeLevel = detail.type === "reasoning_set" ? detail.level : detail.reasoningLevel;
    if (isReasoningLevel(maybeLevel)) {
      setReasoningLevel(maybeLevel);
      if (detail.type === "reasoning_set") markReasoningSync("applied");
    }
    if (detail.type === "desktop_daemon_restarting") setDaemon("starting");
    if (detail.type === "desktop_daemon_stopped") setDaemon("stopped");
    if (detail.type === "daemon_error" || detail.type === "daemon_stderr" || detail.type === "error") {
      setStatus("error");
      if (reasoningSyncRef.current === "syncing") markReasoningSync("error");
    }
    if (detail.type === "turn_start" || detail.type === "tool_start" || detail.type === "thinking_delta" || detail.type === "text_delta") setStatus("active");
    if (detail.type === "permission_request") setStatus("alert");
    if (detail.type === "permission_response" && detail.decision !== "deny") setStatus("active");
    if (detail.type === "turn_end") setStatus(detail.status === "failed" ? "error" : "idle");
    if (detail.type === "turn_end" && detail.usage) recordModelUsage(selectionRef.current, detail.usage);
    if (detail.type === "heartbeat_tick") setStatus(detail.text || detail.reason ? "alert" : "idle");
    if (detail.type === "dream_phase_started") setStatus("dreaming");
    if (detail.type === "dream_phase_ended") setStatus("idle");
    appendToActiveSession(detail);
  }

  function recordModelUsage(usedSelection: Selection, usage: NonNullable<CrixEvent["usage"]>) {
    const key = usageKey(usedSelection);
    setUsageByModel((current) => {
      const previous = current[key] ?? emptyUsage();
      return {
        ...current,
        [key]: {
          inputTokens: previous.inputTokens + Number(usage.inputTokens ?? 0),
          outputTokens: previous.outputTokens + Number(usage.outputTokens ?? 0),
          cacheReadTokens: previous.cacheReadTokens + Number(usage.cacheReadTokens ?? 0),
          cacheWriteTokens: previous.cacheWriteTokens + Number(usage.cacheWriteTokens ?? 0),
          reasoningTokens: previous.reasoningTokens + Number(usage.reasoningTokens ?? 0),
          turns: previous.turns + 1,
          updatedAt: Date.now(),
        },
      };
    });
  }

  function applyDaemonStatus(state: DaemonStatus) {
    setDaemon(state.running ? "running" : "stopped");
    setRoot(state.root ?? "");
    if (state.provider && isProviderId(state.provider)) {
      const next = { provider: state.provider as ProviderId, model: state.model || modelForProvider(state.provider as ProviderId, providers) };
      setSelection(next);
      setDraftSelection(next);
      setCustomModel(next.model);
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const cleanMessage = message.trim();
    const hasAttachments = attachments.length > 0;
    if ((!cleanMessage && !hasAttachments) || !running) return;
    const displayText = cleanMessage || "Inspect the attached image.";
    const goal = buildOutgoingGoal(displayText, attachments, webSearchMode);
    setMessage("");
    setAttachments([]);
    appendToActiveSession({ type: "user_send", text: displayText, attachments, webSearch: webSearchMode });
    try {
      await invoke("crix_send", { goal });
    } catch (error) {
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: String(error) });
    }
  }

  async function addAttachmentFiles(files: FileList | File[]) {
    const selected = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (selected.length === 0) return;
    const loaded = await Promise.all(selected.slice(0, 8).map(readAttachmentFile));
    setAttachments((current) => dedupeAttachments([...current, ...loaded]).slice(-8));
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function markReasoningSync(next: ReasoningSync) {
    if (reasoningSyncTimerRef.current !== null) {
      window.clearTimeout(reasoningSyncTimerRef.current);
      reasoningSyncTimerRef.current = null;
    }
    setReasoningSync(next);
    reasoningSyncRef.current = next;
    if (next === "applied") {
      reasoningSyncTimerRef.current = window.setTimeout(() => {
        setReasoningSync("idle");
        reasoningSyncRef.current = "idle";
        reasoningSyncTimerRef.current = null;
      }, 1600);
    }
    if (next === "syncing") {
      reasoningSyncTimerRef.current = window.setTimeout(() => {
        if (reasoningSyncRef.current !== "syncing") return;
        setReasoningSync("error");
        reasoningSyncRef.current = "error";
        reasoningSyncTimerRef.current = null;
      }, 3000);
    }
  }

  function changeReasoning(level: ReasoningLevel) {
    setReasoningLevel(level);
    if (!hasNativeBridge()) {
      markReasoningSync("applied");
      return;
    }
    markReasoningSync("syncing");
    void invoke("crix_set_reasoning", { level }).catch((error: unknown) => {
      markReasoningSync("error");
      appendToActiveSession({ type: "desktop_error", text: `Reasoning update failed: ${String(error)}` });
    });
  }

  function respondToPermission(id: string | undefined, decision: PermissionDecision) {
    if (!id || !hasNativeBridge()) return;
    void invoke("crix_permission_response", { id, decision }).catch((error: unknown) => {
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: `Permission response failed: ${String(error)}` });
    });
  }

  async function restartWith(nextSelection = selection) {
    setDaemon("starting");
    setStatus("active");
    try {
      const state = await invoke<DaemonStatus>("crix_restart_daemon", daemonSelectionArgs(nextSelection));
      setSelection(nextSelection);
      setDraftSelection(nextSelection);
      setCustomModel(nextSelection.model);
      applyDaemonStatus(state);
      appendToActiveSession({ type: "desktop_model_applied", provider: nextSelection.provider, model: nextSelection.model });
    } catch (error) {
      setDaemon("error");
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: String(error) });
    }
  }

  async function stopDaemon() {
    await invoke("crix_stop_daemon");
    setDaemon("stopped");
  }

  function newSession() {
    const session = createSession();
    setSessions((current) => [session, ...current].slice(0, 24));
    setActiveSessionId(session.id);
    setActiveView("chat");
  }

  function deleteSession(sessionId: string) {
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      if (next.length === 0) {
        const fresh = createSession();
        setActiveSessionId(fresh.id);
        activeSessionIdRef.current = fresh.id;
        return [fresh];
      }
      if (activeSessionIdRef.current === sessionId) {
        setActiveSessionId(next[0].id);
        activeSessionIdRef.current = next[0].id;
      }
      return next;
    });
  }

  function startRenameSession(session: SessionRecord) {
    setRenamingSessionId(session.id);
    setRenamingSessionName(session.name);
  }

  function cancelRenameSession() {
    setRenamingSessionId(null);
    setRenamingSessionName("");
  }

  function commitRenameSession() {
    const nextName = renamingSessionName.trim();
    if (!renamingSessionId || !nextName) {
      cancelRenameSession();
      return;
    }
    setSessions((current) => current.map((session) => (
      session.id === renamingSessionId ? { ...session, name: titleFromPrompt(nextName), updatedAt: Date.now() } : session
    )));
    cancelRenameSession();
  }

  function updateDraftProvider(providerId: ProviderId) {
    const modelId = modelForProvider(providerId, providers);
    setDraftSelection({ provider: providerId, model: modelId });
    setCustomModel(modelId);
  }

  function updateDraftModel(modelId: string) {
    setDraftSelection((current) => ({ ...current, model: modelId }));
    setCustomModel(modelId);
  }

  const activeProvider = providerById(selection.provider, providers);

  return (
    <main
      className="crix-app"
      data-corners={appearance.corners}
      data-theme={theme}
      data-native={hasNativeBridge() ? "1" : "0"}
      style={{
        "--glass-opacity": appearance.opacity,
        "--shell-radius": appearance.corners === "rounded" ? "38px" : "10px",
      } as React.CSSProperties}
    >
      <ThreeScene running={running} status={status} theme={theme} />
      <FxLayer status={status} running={running} />
      <div className="commandHud" data-active={status === "active" ? "1" : "0"} aria-hidden="true" />
      <EvolutionPulseDeck pulses={pulses} />
      <Titlebar identity={agentIdentity} />
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark" data-hot={running ? "1" : "0"}><CrixAvatar identity={agentIdentity} /></div>
          <div>
            <strong>Crix</strong>
            <span>{identitySubtitle(agentIdentity, running ? "daemon linked" : daemon)}</span>
          </div>
        </div>

        <div className="modeTabs">
          <NavButton active={activeView === "chat"} icon={MessageSquare} label="Chat" onClick={() => setActiveView("chat")} />
          <NavButton active={activeView === "providers"} icon={Cloud} label="Models" onClick={() => setActiveView("providers")} />
          <NavButton active={activeView === "mind"} icon={Brain} label="Mind" onClick={() => setActiveView("mind")} />
          <NavButton active={activeView === "tools"} icon={Wrench} label="Tools" onClick={() => setActiveView("tools")} />
        </div>

        <button className="newSession" type="button" onClick={newSession}>
          <Sparkles size={16} />
          New session
        </button>

        <section className="sidebarSection">
          <span className="sectionLabel">Current</span>
          <InfoLine icon={Cloud} label="Provider" value={activeProvider.label} />
          <InfoLine icon={CpuIcon} label="Model" value={selection.model} />
          <InfoLine icon={HeartPulse} label="Pulse" value={STATUS_LABELS[status]} />
          <InfoLine icon={Database} label="Events" value={String(events.length)} />
        </section>

        <section className="sidebarSection sessions">
          <span className="sectionLabel">Sessions</span>
          {sessions.map((session) => (
            <div
              className={session.id === activeSessionId ? "sessionItem active" : "sessionItem"}
              key={session.id}
              title={session.name}
            >
              {renamingSessionId === session.id ? (
                <form
                  className="sessionRenameForm"
                  onSubmit={(event) => {
                    event.preventDefault();
                    commitRenameSession();
                  }}
                >
                  <input
                    autoFocus
                    className="sessionNameInput"
                    onBlur={commitRenameSession}
                    onChange={(event) => setRenamingSessionName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") cancelRenameSession();
                    }}
                    value={renamingSessionName}
                  />
                </form>
              ) : (
                <button
                  className="sessionOpen"
                  onClick={() => {
                    setActiveSessionId(session.id);
                    setActiveView("chat");
                  }}
                  type="button"
                >
                  <span>{session.events.filter((event) => event.type === "user_send").length}</span>
                  <strong>{session.name}</strong>
                </button>
              )}
              <button
                aria-label={`Rename session ${session.name}`}
                className="sessionRename"
                onClick={() => startRenameSession(session)}
                title="Rename session"
                type="button"
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`Delete session ${session.name}`}
                className="sessionDelete"
                onClick={() => deleteSession(session.id)}
                title="Delete session"
                type="button"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </section>

        <div className="sidebarFooter">
          <span className={running ? "connectionDot online" : "connectionDot"} />
          <span>{root || "D:\\Crix"}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspaceTop">
          <div>
            <h1>{activeViewTitle(activeView)}</h1>
            <p>{selection.provider} / {selection.model}</p>
          </div>
          <div className="modelDock">
            <label>
              <span>Provider</span>
              <select value={draftSelection.provider} onChange={(event) => updateDraftProvider(event.target.value as ProviderId)}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="wide">
              <span>Model</span>
              <select value={visibleModels.some((item) => item.id === draftSelection.model) ? draftSelection.model : "__custom"} onChange={(event) => updateDraftModel(event.target.value)}>
                {visibleModels.map((item) => (
                  <option key={item.id} value={item.id}>{item.id}</option>
                ))}
                <option value="__custom">Custom...</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <label className={`reasoningDial sync-${reasoningSync}`} title="Reasoning depth updates the live daemon immediately and affects the next model call">
              <span>Reasoning <small>{reasoningSyncLabel(reasoningSync)}</small></span>
              <select value={reasoningLevel} onChange={(event) => changeReasoning(event.target.value as ReasoningLevel)}>
                {REASONING_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <button
              className="iconAction modelRestartAction"
              disabled={!modelSelectionChanged}
              title={modelSelectionChanged ? "Restart with selected provider/model" : "Current provider/model is already running"}
              type="button"
              onClick={() => restartWith(activeSelection)}
            >
              <RefreshCw size={16} />
            </button>
            <button className="iconAction" title={running ? "Stop daemon" : "Start daemon"} type="button" onClick={running ? stopDaemon : () => restartWith(selection)}>
              {running ? <Power size={16} /> : <Play size={16} />}
            </button>
          </div>
        </header>

        <AnimatePresence mode="wait">
          <motion.div
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            className="viewFrame"
            exit={{ opacity: 0, y: -8, filter: "blur(6px)" }}
            initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
            key={activeView}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          >
            {activeView === "providers" ? (
              <ProvidersView
                customModel={customModel}
                draftSelection={draftSelection}
                onApply={() => restartWith({ ...draftSelection, model: draftSelection.model === "__custom" ? customModel : draftSelection.model })}
                onCustomModel={setCustomModel}
                onModel={updateDraftModel}
                onProvider={updateDraftProvider}
                providers={providers}
                ollamaDiscovery={ollamaDiscovery}
                running={running}
                usageByModel={usageByModel}
              />
            ) : activeView === "mind" ? (
              <MindView
                appearance={appearance}
                events={events}
                onAppearance={setAppearance}
                onTheme={setTheme}
                status={status}
                stats={stats}
                theme={theme}
              />
            ) : activeView === "tools" ? (
              <ToolsView events={events} />
            ) : (
              <ChatView
                attachments={attachments}
                daemon={daemon}
                events={events}
                fileInputRef={fileInputRef}
                message={message}
                onAttachmentFiles={(files) => void addAttachmentFiles(files)}
                onAttachmentRemove={removeAttachment}
                onMessage={setMessage}
                onPermissionDecision={respondToPermission}
                onSend={sendMessage}
                onWebSearchMode={setWebSearchMode}
                refEl={transcriptRef}
                running={running}
                stats={stats}
                status={status}
                liveActivity={liveActivity}
                webSearchMode={webSearchMode}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </section>
    </main>
  );
}

interface PulseMeta {
  label: string;
  tone: string;
  icon: typeof Sparkles;
}

const PULSE_META: Record<string, PulseMeta> = {
  bootstrap_complete: { label: "Awakened", tone: "born", icon: Sparkles },
  self_evolve: { label: "Rewrote self", tone: "soul", icon: Brain },
  capture_detected: { label: "Learned you", tone: "capture", icon: Sparkles },
  recall_surfaced: { label: "Remembered", tone: "recall", icon: Database },
  skill_crafted: { label: "New skill", tone: "skill", icon: Wrench },
  skill_ran: { label: "Skill ran", tone: "skill-ran", icon: Zap },
  capability_changed: { label: "Leveled up", tone: "capability", icon: BarChart3 },
  self_reflected: { label: "Reflected", tone: "self-reflect", icon: Gauge },
  dream_phase_ended: { label: "Consolidated", tone: "dream", icon: HeartPulse },
  mission_started: { label: "Mission set", tone: "mission", icon: Target },
  mission_step_completed: { label: "Step cleared", tone: "mission-step", icon: Check },
  mission_verified: { label: "Verified", tone: "mission-verify", icon: ShieldCheck },
  mission_completed: { label: "Mission done", tone: "mission-done", icon: Flag },
};

function pulseMeta(sourceType: string): PulseMeta {
  return PULSE_META[sourceType] ?? { label: humanizeSource(sourceType), tone: "default", icon: Sparkles };
}

function humanizeSource(sourceType: string): string {
  return sourceType.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function prettyPulseTarget(target: string, kind?: string): string {
  const base = target.includes("/") ? target.split("/").pop() ?? target : target;
  return (kind?.trim() || base).toLowerCase();
}

function EvolutionPulseDeck({ pulses }: { pulses: EvolutionPulse[] }) {
  return (
    <div className="pulseDeck" aria-hidden="true">
      <AnimatePresence mode="popLayout">
        {pulses.map((pulse) => {
          const meta = pulseMeta(pulse.sourceType);
          const Icon = meta.icon;
          return (
            <motion.div
              key={pulse.id}
              layout
              className={`pulseCard pulse-${meta.tone}`}
              initial={{ opacity: 0, x: 48, scale: 0.7 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 14, scale: 0.9, transition: { duration: 0.3 } }}
              transition={{ type: "spring", stiffness: 480, damping: 24, mass: 0.7 }}
            >
              <span className="pulseIcon"><Icon size={15} strokeWidth={2.4} /></span>
              <span className="pulseBody">
                <span className="pulseLabel">{meta.label}</span>
                <span className="pulseTarget">{prettyPulseTarget(pulse.target, pulse.kind)}</span>
              </span>
              <motion.span
                className="pulseDelta"
                initial={{ scale: 1.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 560, damping: 16, delay: 0.06 }}
              >
                +{pulse.delta}
              </motion.span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

type SceneMode = ThemeName; // every theme now gets its own distinct hero + palette

interface ScenePalette {
  key: number;
  rim: number;
  fog: number;
  glass: number;
  emissive: number;
  accent: number;
  core: number;
  dust: number;
}

function scenePalette(mode: SceneMode): ScenePalette {
  switch (mode) {
    case "matrix":
      return { key: 0xbb66ff, rim: 0x00ffbb, fog: 0x12061f, glass: 0xb67cff, emissive: 0x6a00a8, accent: 0x00ffbb, core: 0x9bffe6, dust: 0x9b7bff };
    case "storm":
      return { key: 0x99c9ff, rim: 0xaed8ff, fog: 0x06101f, glass: 0xcfe6ff, emissive: 0x2486ff, accent: 0xf2f8ff, core: 0xeaf4ff, dust: 0xaeccff };
    case "graphite":
      return { key: 0xdfe8ff, rim: 0x7fa8d8, fog: 0x090b10, glass: 0xcdd6e4, emissive: 0x3a4a78, accent: 0x8fb6ff, core: 0xeaf0ff, dust: 0xaab8d0 };
    case "oxide":
      return { key: 0xffd9a8, rim: 0xff8a4c, fog: 0x140a06, glass: 0xffc59a, emissive: 0x9a3a0c, accent: 0xff7a3c, core: 0xfff0d8, dust: 0xffb070 };
    default: // signal
      return { key: 0xffffff, rim: 0x5ea8ff, fog: 0x0a1626, glass: 0xbfe0ff, emissive: 0x1c54a0, accent: 0xffb27a, core: 0xeafff7, dust: 0x8fd0ff };
  }
}

// A scene "rig" exposes the moving parts so the animation loop can drive them:
// independent spins, multi-axis tumbles, emissive heartbeats, and breathing
// additive glow shells. This is what turns a static hero into a living thing.
interface ScenePulse {
  material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
  base: number;
  amp: number;
}
interface SceneGlow {
  mesh: THREE.Mesh;
  base: number;
  amp: number;
  opacity: number;
}
interface SceneRig {
  spin: THREE.Object3D[];
  counter: THREE.Object3D[];
  tumble: THREE.Object3D[];
  pulses: ScenePulse[];
  glows: SceneGlow[];
  core?: THREE.Object3D;
}

function ThreeScene({ running, status, theme }: { running: boolean; status: string; theme: ThemeName }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  // Live signals read by the render loop WITHOUT rebuilding the scene: the scene
  // only re-creates on a theme change, but it reacts every frame to whether the
  // daemon is running and whether Crix is actively thinking/streaming/tooling.
  const runningRef = useRef(running);
  const statusRef = useRef(status);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Cursor parallax — the whole scene leans toward the pointer, so the
  // depth reads as a real volume instead of a flat decal.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      pointerRef.current = {
        x: (event.clientX / window.innerWidth) * 2 - 1,
        y: (event.clientY / window.innerHeight) * 2 - 1,
      };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const mode: SceneMode = theme;
    const palette = scenePalette(mode);
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas,
      powerPreference: "high-performance",
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(palette.fog, 0.03);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 0, 9);

    scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.PointLight(palette.key, 6.2, 40);
    key.position.set(5, 5, 6);
    const rim = new THREE.PointLight(palette.rim, 3.6, 40);
    rim.position.set(-6, -3, 2);
    // A third, accent-coloured light that orbits the hero — moving highlights
    // sweep across the glass and sell the volume far harder than static lights.
    const spark = new THREE.PointLight(palette.accent, 2.8, 30);
    scene.add(key, rim, spark);

    const root = new THREE.Group();
    scene.add(root);
    const rig = buildSceneObject(root, mode, palette);
    const baseScale = mode === "matrix" ? 1.12 : 1.2;
    const baseX = mode === "matrix" ? 1.1 : 1.35;
    const baseY = mode === "storm" ? -0.14 : -0.04;
    root.scale.setScalar(baseScale);
    root.position.set(baseX, baseY, 0);

    const dust = buildParticleField(palette.dust);
    scene.add(dust);
    const stars = buildStarfield(palette.core);
    scene.add(stars);
    const grids = buildHologramGrids(palette.accent);
    for (const g of grids) scene.add(g);

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.floor(width));
      const nextHeight = Math.max(1, Math.floor(height));
      renderer.setSize(nextWidth, nextHeight, false);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const dustMat = dust.material as THREE.PointsMaterial;
    const starMat = stars.material as THREE.PointsMaterial;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    let frame = 0;
    let raf = 0;
    let leanX = 0;
    let leanY = 0;
    let energy = runningRef.current ? 0.72 : 0.42;
    const animate = () => {
      // Energy ramps smoothly toward its target, so the scene SURGES when Crix
      // starts thinking/streaming and settles when it goes idle — never snaps.
      const active = statusRef.current === "active";
      const targetEnergy = runningRef.current ? (active ? 1.0 : 0.72) : active ? 0.62 : 0.42;
      energy += (targetEnergy - energy) * 0.04;
      frame += 0.006 + energy * 0.01;

      // Ease toward the pointer target — never snap.
      const targetX = pointerRef.current.x * 0.45;
      const targetY = -pointerRef.current.y * 0.32;
      leanX += (targetX - leanX) * 0.045;
      leanY += (targetY - leanY) * 0.045;

      // A shared "heartbeat" that drives every pulsing element in phase.
      const beat = 0.5 + 0.5 * Math.sin(frame * 2.1);
      const shimmer = 0.5 + 0.5 * Math.sin(frame * 5.3);

      root.rotation.y += 0.0035 + energy * 0.006;
      root.rotation.x = leanY * 0.7 + Math.sin(frame * 0.6) * 0.07;
      root.rotation.z = Math.sin(frame * 0.4) * 0.05;
      root.position.x = baseX + leanX * 0.6;
      root.position.y = baseY + Math.sin(frame) * 0.12;

      // Per-part motion from the rig.
      for (const o of rig.spin) o.rotation.y += 0.004 + energy * 0.006;
      for (const o of rig.counter) o.rotation.y -= 0.003 + energy * 0.005;
      for (const o of rig.tumble) {
        o.rotation.x += 0.003 + energy * 0.004;
        o.rotation.z += 0.0018 + energy * 0.0025;
      }
      for (const p of rig.pulses) p.material.emissiveIntensity = p.base + p.amp * beat * (0.6 + energy * 0.4);
      for (const g of rig.glows) {
        g.mesh.scale.setScalar(g.base + g.amp * beat);
        (g.mesh.material as THREE.MeshBasicMaterial).opacity = g.opacity * (0.55 + 0.45 * beat) * (0.7 + energy * 0.3);
      }
      if (rig.core) rig.core.scale.setScalar(0.9 + 0.14 * beat * (0.6 + energy * 0.4));

      // Orbiting accent light + breathing key light intensity.
      spark.position.set(Math.cos(frame * 0.9) * 4.5 + baseX, Math.sin(frame * 0.7) * 3.2, Math.sin(frame * 0.9) * 4.5 + 2);
      spark.intensity = (2.2 + 1.6 * shimmer) * (0.5 + energy * 0.5);
      key.intensity = 5.4 + 1.4 * beat;

      // Two counter-rotating particle layers that twinkle out of phase.
      dust.rotation.y += 0.0009 + energy * 0.0008;
      dust.rotation.x = leanY * 0.25;
      dust.position.x = leanX * 0.3;
      dustMat.opacity = 0.4 + 0.3 * beat;
      stars.rotation.y -= 0.00035;
      stars.rotation.x = leanY * 0.1;
      starMat.opacity = 0.35 + 0.45 * shimmer;

      // Hologram grids scroll past in opposite directions — depth + motion floor.
      const gridScroll = (frame * 0.5) % 1;
      grids[0].position.z = gridScroll;
      grids[1].position.z = -gridScroll;

      // Subtle camera dolly + drift — the world breathes around the hero.
      camera.position.z = 9 + Math.sin(frame * 0.5) * 0.45;
      camera.position.x = leanX * 0.25;
      camera.lookAt(baseX * 0.4, 0, 0);

      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };
    // Respect reduced-motion: render one gorgeous still frame, skip the loop.
    if (reduceMotion) renderer.render(scene, camera);
    else animate();

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      const disposeObject = (object: THREE.Object3D) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose?.();
      };
      root.traverse(disposeObject);
      disposeObject(dust);
      disposeObject(stars);
      for (const g of grids) {
        g.geometry.dispose();
        const mat = g.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
      renderer.dispose();
    };
  }, [theme]);

  return <canvas className="threeScene" ref={canvasRef} aria-hidden="true" />;
}

// A soft shell of drifting motes around the hero object. Additive blending
// makes them read as floating light, which is what sells "depth" over "decal".
function buildParticleField(color: number): THREE.Points {
  const count = 1100;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const radius = 4.5 + Math.random() * 10;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size: 0.06,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

// A far, slow starfield behind everything — gives the scene real parallax depth
// and a horizon that twinkles independently of the near dust.
function buildStarfield(color: number): THREE.Points {
  const count = 700;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const radius = 16 + Math.random() * 24;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color,
    size: 0.05,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}

// Hologram grid planes — a floor and a ceiling of additive light lines that
// scroll past the hero. This is what turns "a glowing object" into "a control
// room you're standing inside".
function buildHologramGrids(color: number): THREE.GridHelper[] {
  const make = (y: number, opacity: number): THREE.GridHelper => {
    const grid = new THREE.GridHelper(80, 80, color, color);
    const apply = (m: THREE.LineBasicMaterial) => {
      m.transparent = true;
      m.opacity = opacity;
      m.blending = THREE.AdditiveBlending;
      m.depthWrite = false;
    };
    const mat = grid.material as THREE.LineBasicMaterial | THREE.LineBasicMaterial[];
    if (Array.isArray(mat)) mat.forEach(apply);
    else apply(mat);
    grid.position.set(0, y, 0);
    return grid;
  };
  return [make(-6, 0.16), make(6.5, 0.08)];
}

// An additive glow shell — a soft sphere of light the animation loop breathes
// in and out. This is the cheap, reliable way to fake bloom on a transparent
// canvas without a post-processing pass eating the page background.
function glowShell(radius: number, color: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
}

function emissiveRing(radius: number, tube: number, color: number, intensity: number, opacity = 0.9): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.TorusGeometry(radius, tube, 20, 220),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, metalness: 0.5, roughness: 0.3, transparent: true, opacity }),
  );
}

function buildSceneObject(root: THREE.Group, mode: SceneMode, palette: ScenePalette): SceneRig {
  if (mode === "matrix") {
    const crystalMat = new THREE.MeshPhysicalMaterial({
      color: palette.glass, emissive: palette.emissive, emissiveIntensity: 0.55,
      metalness: 0.3, roughness: 0.14, transmission: 0.55, thickness: 1.3, ior: 1.4,
      transparent: true, opacity: 0.92, flatShading: true, clearcoat: 0.6, clearcoatRoughness: 0.25,
    });
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(2.2, 0), crystalMat);
    const eyeMat = new THREE.MeshStandardMaterial({ color: palette.core, emissive: palette.accent, emissiveIntensity: 2.4, roughness: 0.2 });
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.46, 36, 24), eyeMat);
    const eyeGlow = glowShell(1.0, palette.accent, 0.3);
    eye.add(eyeGlow);
    const ringA = emissiveRing(1.85, 0.03, palette.accent, 1.1, 0.9);
    ringA.rotation.x = Math.PI / 2.4;
    const ringB = emissiveRing(2.4, 0.02, palette.accent, 0.8, 0.6);
    ringB.rotation.x = Math.PI / 2.8;
    ringB.rotation.y = Math.PI / 4;
    const halo = glowShell(2.9, palette.accent, 0.05);
    root.add(crystal, eye, ringA, ringB, halo);
    return {
      spin: [crystal], counter: [ringB], tumble: [ringA],
      pulses: [{ material: crystalMat, base: 0.55, amp: 0.5 }, { material: eyeMat, base: 2.4, amp: 1.3 }],
      glows: [{ mesh: eyeGlow, base: 1.0, amp: 0.5, opacity: 0.3 }, { mesh: halo, base: 1.0, amp: 0.18, opacity: 0.05 }],
      core: eye,
    };
  }

  if (mode === "storm") {
    const boltShape = new THREE.Shape()
      .moveTo(-0.2, 2.1).lineTo(0.85, 0.35).lineTo(0.16, 0.35)
      .lineTo(0.56, -2.0).lineTo(-0.95, -0.05).lineTo(-0.22, -0.05).lineTo(-0.2, 2.1);
    const boltMat = new THREE.MeshPhysicalMaterial({
      color: palette.glass, emissive: palette.emissive, emissiveIntensity: 0.9,
      metalness: 0.45, roughness: 0.16, clearcoat: 0.85, clearcoatRoughness: 0.12, transparent: true, opacity: 0.97,
    });
    const bolt = new THREE.Mesh(
      new THREE.ExtrudeGeometry(boltShape, { depth: 0.42, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.08, bevelSegments: 3 }),
      boltMat,
    );
    const halo = glowShell(2.5, palette.accent, 0.08);
    const ringA = emissiveRing(2.55, 0.024, palette.accent, 1.0, 0.75);
    ringA.rotation.x = Math.PI / 2.5;
    const ringB = emissiveRing(3.05, 0.018, palette.accent, 0.7, 0.5);
    ringB.rotation.x = Math.PI / 2.2;
    ringB.rotation.z = Math.PI / 5;
    root.add(bolt, halo, ringA, ringB);
    return {
      spin: [], counter: [ringB], tumble: [ringA],
      pulses: [{ material: boltMat, base: 0.9, amp: 0.9 }],
      glows: [{ mesh: halo, base: 1.0, amp: 0.22, opacity: 0.08 }],
      core: bolt,
    };
  }

  if (mode === "graphite") {
    // A machined chrome gyroscope — cold, metallic, hypnotic.
    const knotMat = new THREE.MeshPhysicalMaterial({
      color: palette.glass, emissive: palette.emissive, emissiveIntensity: 0.35,
      metalness: 0.95, roughness: 0.16, clearcoat: 1.0, clearcoatRoughness: 0.1, transparent: true, opacity: 0.98,
    });
    const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.45, 0.42, 220, 32, 2, 3), knotMat);
    const coreMat = new THREE.MeshStandardMaterial({ color: palette.core, emissive: palette.accent, emissiveIntensity: 2.2, roughness: 0.2 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 36, 24), coreMat);
    const coreGlow = glowShell(0.95, palette.accent, 0.22);
    core.add(coreGlow);
    const ringA = emissiveRing(2.7, 0.02, palette.accent, 0.9, 0.7);
    ringA.rotation.x = Math.PI / 2.6;
    const ringB = emissiveRing(2.95, 0.014, palette.rim, 0.7, 0.5);
    ringB.rotation.x = Math.PI / 2.1;
    ringB.rotation.y = Math.PI / 3;
    const halo = glowShell(3.0, palette.rim, 0.04);
    root.add(knot, core, ringA, ringB, halo);
    return {
      spin: [knot], counter: [ringB], tumble: [ringA],
      pulses: [{ material: knotMat, base: 0.35, amp: 0.3 }, { material: coreMat, base: 2.2, amp: 1.0 }],
      glows: [{ mesh: coreGlow, base: 0.95, amp: 0.4, opacity: 0.22 }, { mesh: halo, base: 1.0, amp: 0.14, opacity: 0.04 }],
      core,
    };
  }

  if (mode === "oxide") {
    // A molten ember core inside a faceted shell — warm, volcanic, glowing.
    const shellMat = new THREE.MeshPhysicalMaterial({
      color: palette.glass, emissive: palette.emissive, emissiveIntensity: 0.6,
      metalness: 0.35, roughness: 0.32, transmission: 0.25, thickness: 1.2, ior: 1.45,
      transparent: true, opacity: 0.7, flatShading: true, clearcoat: 0.5, clearcoatRoughness: 0.3,
    });
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(2.15, 1), shellMat);
    const emberMat = new THREE.MeshStandardMaterial({ color: palette.core, emissive: palette.accent, emissiveIntensity: 2.8, roughness: 0.35 });
    const ember = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 2), emberMat);
    const emberGlow = glowShell(1.9, palette.accent, 0.18);
    ember.add(emberGlow);
    const ringA = emissiveRing(2.75, 0.03, palette.accent, 1.1, 0.7);
    ringA.rotation.x = Math.PI / 2.5;
    const halo = glowShell(3.2, palette.accent, 0.06);
    root.add(shell, ember, ringA, halo);
    return {
      spin: [shell], counter: [ember], tumble: [ringA],
      pulses: [{ material: shellMat, base: 0.6, amp: 0.4 }, { material: emberMat, base: 2.8, amp: 1.4 }],
      glows: [{ mesh: emberGlow, base: 1.9, amp: 0.5, opacity: 0.18 }, { mesh: halo, base: 1.0, amp: 0.2, opacity: 0.06 }],
      core: ember,
    };
  }

  // signal (default) — the glass world with a luminous core.
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: palette.glass, emissive: palette.emissive, emissiveIntensity: 0.4,
    metalness: 0.1, roughness: 0.1, transmission: 0.92, thickness: 1.5, ior: 1.32,
    transparent: true, opacity: 0.88, clearcoat: 0.7, clearcoatRoughness: 0.18,
  });
  const glass = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 5), glassMat);
  const orbitA = emissiveRing(2.95, 0.04, palette.accent, 1.2, 0.9);
  orbitA.rotation.x = Math.PI / 2.6;
  const orbitB = emissiveRing(2.55, 0.02, palette.accent, 0.9, 0.55);
  orbitB.rotation.x = Math.PI / 2.6;
  orbitB.rotation.y = Math.PI / 3;
  const coreMat = new THREE.MeshStandardMaterial({ color: palette.core, emissive: palette.rim, emissiveIntensity: 2.2, roughness: 0.2 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.5, 36, 24), coreMat);
  const coreGlow = glowShell(1.05, palette.accent, 0.22);
  core.add(coreGlow);
  const halo = glowShell(3.2, palette.accent, 0.05);
  root.add(glass, orbitA, orbitB, core, halo);
  return {
    spin: [glass], counter: [orbitB], tumble: [orbitA],
    pulses: [{ material: glassMat, base: 0.4, amp: 0.4 }, { material: coreMat, base: 2.2, amp: 1.0 }],
    glows: [{ mesh: coreGlow, base: 1.05, amp: 0.45, opacity: 0.22 }, { mesh: halo, base: 1.0, amp: 0.16, opacity: 0.05 }],
    core,
  };
}

function CrixAvatar({ identity }: { identity?: CrixIdentity }) {
  const avatar = cleanIdentityValue(identity?.avatar);
  if (avatar && isImageAvatar(avatar)) {
    return <img alt="" className="crixAvatarImage" src={avatarToSrc(avatar)} />;
  }
  if (avatar && isTextAvatar(avatar)) {
    return <span className="crixAvatarText">{avatar}</span>;
  }
  return <CrixGlyph />;
}

function identitySubtitle(identity: CrixIdentity, status: string) {
  const name = cleanIdentityValue(identity.name);
  return name && name.toLowerCase() !== "crix" ? `${name} · ${status}` : status;
}

function cleanIdentityValue(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function isImageAvatar(value: string) {
  return /^(https?:\/\/|data:image\/)/i.test(value) || looksLikeLocalImagePath(value);
}

function isTextAvatar(value: string) {
  return value.length <= 4 && !/[\s[\]]/u.test(value);
}

function looksLikeLocalImagePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^\/[^/]/.test(value);
}

function avatarToSrc(value: string) {
  return looksLikeLocalImagePath(value) ? convertFileSrc(value) : value;
}

function CrixGlyph() {
  return (
    <svg className="crixGlyph" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="crixGlyphMain" x1="14" x2="52" y1="10" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5EA8FF" />
          <stop offset="0.46" stopColor="#70F0D2" />
          <stop offset="1" stopColor="#FFD07A" />
        </linearGradient>
        <linearGradient id="crixGlyphGlass" x1="12" x2="48" y1="8" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <path className="crixGlyphCore" d="M15 19.5C15 13.7 19.7 9 25.5 9h13C49.3 9 58 17.7 58 28.5S49.3 48 38.5 48H26.8l-9.4 7.4c-1.3 1-3.2.1-3.2-1.5v-8.2C9.2 42.5 6 36.9 6 30.5C6 24.4 9.9 19.5 15 19.5Z" />
      <path className="crixGlyphGlass" d="M17 21.5C17 15.9 21.5 11.4 27.1 11.4h10.5c9.6 0 17.4 7.8 17.4 17.4S47.2 46.2 37.6 46.2H27.4l-7.7 6v-8.4l-1-.6C13.6 40.4 10.4 35.2 10.4 29.4c0-4.5 2.8-7.9 6.6-7.9Z" />
      <path className="crixGlyphTrace" d="M22 29.3c1.4-6.5 7.2-10.8 14.1-10.2 6.8.6 11.7 5.7 12.2 12.2" />
      <path className="crixGlyphTrace secondary" d="M41.7 37.4c-2.2 2.1-5.2 3.3-8.7 3.1-5.2-.2-9.5-3.4-11.1-7.9" />
      <circle className="crixGlyphDot" cx="25" cy="31" r="2.4" />
      <circle className="crixGlyphDot" cx="39" cy="31" r="2.4" />
    </svg>
  );
}

function FxLayer({ running, status }: { running: boolean; status: HeartbeatStatus }) {
  return (
    <div className={`fxLayer ${running ? "online" : ""} ${status}`} aria-hidden="true">
      <div className="fxWallpaper" />
      <div className="fxBackdropBlur" />
      <div className="fxGlassRibbons" />
      <div className="fxLens" />
      <div className="fxVignette" />
      <div className="fxGrid" />
      <div className="fxPulse" />
      <div className="fxGlyphs">
        {Array.from({ length: 12 }, (_, index) => <span key={index}>{index % 3 === 0 ? "01" : index % 3 === 1 ? "CR" : "IX"}</span>)}
      </div>
    </div>
  );
}

function Titlebar({ identity }: { identity: CrixIdentity }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebarBrand" data-tauri-drag-region>
        <span className="titlebarSigil"><CrixAvatar identity={identity} /></span>
        <span className="titlebarName">Crix</span>
      </div>
      <div className="windowButtons">
        <button title="Minimize" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("crix_window_minimize")}><Minus size={14} /></button>
        <button title="Maximize" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("crix_window_toggle_maximize")}><Square size={12} /></button>
        <button title="Close" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("crix_window_close")}><X size={15} /></button>
      </div>
    </div>
  );
}

function ChatView({
  attachments,
  daemon,
  events,
  fileInputRef,
  message,
  onAttachmentFiles,
  onAttachmentRemove,
  onMessage,
  onPermissionDecision,
  onSend,
  onWebSearchMode,
  refEl,
  running,
  stats,
  status,
  liveActivity,
  webSearchMode,
}: {
  attachments: ChatAttachment[];
  daemon: DaemonState;
  events: CrixEvent[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  message: string;
  onAttachmentFiles: (files: FileList | File[]) => void;
  onAttachmentRemove: (id: string) => void;
  onMessage: (value: string) => void;
  onPermissionDecision: (id: string | undefined, decision: PermissionDecision) => void;
  onSend: (event: React.FormEvent) => void;
  onWebSearchMode: (value: boolean) => void;
  refEl: React.RefObject<HTMLDivElement | null>;
  running: boolean;
  stats: ReturnType<typeof collectStats>;
  status: HeartbeatStatus;
  liveActivity: LiveActivity;
  webSearchMode: boolean;
}) {
  const chatEvents = events.filter(isChatVisibleEvent);
  const clippedCount = Math.max(0, chatEvents.length - 90);
  const visibleEvents = clippedCount > 0 ? chatEvents.slice(-90) : chatEvents;
  const chatActive = running && (status === "active" || liveActivity.tone === "active");
  return (
    <section className="chatShell" data-active={chatActive ? "1" : "0"}>
      <div className="chatAtmosphere" aria-hidden="true">
        <div className="chatNebula" />
        <div className="chatHoloGrid" />
        <div className="chatOrbitRings" />
        <div className="chatParticleField" />
        <div className="chatSignalSweep" />
      </div>
      <div className="transcript" ref={refEl}>
        {chatEvents.length === 0 ? (
          <div className="emptyState">
            <TerminalSquare size={34} />
            <h2>Ready for a real run.</h2>
            <p>Pick a model up top, then send a prompt. The daemon is managed by the app.</p>
          </div>
        ) : (
          <>
            {clippedCount > 0 ? <div className="transcriptClipNotice">{clippedCount} older event{clippedCount === 1 ? "" : "s"} kept in session memory</div> : null}
            {visibleEvents.map((event, index) => (
              <EventCard
                event={event}
                key={`${event.id ?? event.type}-${chatEvents.length - visibleEvents.length + index}`}
                onPermissionDecision={onPermissionDecision}
              />
            ))}
          </>
        )}
      </div>
      <form className="composerBar" onSubmit={onSend}>
        <div className="composerTools">
          <StatusPill label="Daemon" value={daemon} tone={running ? "ok" : daemon === "error" ? "bad" : "warn"} />
          <StatusPill label="Turns" value={String(stats.turns)} />
          <StatusPill label="Tools" value={String(stats.tools)} />
          <StatusPill label="Tokens" value={formatNumber(stats.tokens)} />
          {webSearchMode ? <StatusPill label="Web" value="on" tone="ok" /> : null}
          {attachments.length > 0 ? <StatusPill label="Images" value={String(attachments.length)} tone="ok" /> : null}
        </div>
        {attachments.length > 0 ? (
          <AttachmentTray attachments={attachments} onRemove={onAttachmentRemove} />
        ) : null}
        <LiveActivityStrip activity={liveActivity} />
        <div className="composerInput">
          <div className="composerIconCluster">
            <input
              ref={fileInputRef}
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={(event) => {
                if (event.target.files) onAttachmentFiles(event.target.files);
                event.currentTarget.value = "";
              }}
              type="file"
            />
            <button
              className="composerIconButton"
              disabled={!running}
              onClick={() => fileInputRef.current?.click()}
              title="Attach image"
              type="button"
            >
              <ImagePlus size={18} />
            </button>
            <button
              aria-pressed={webSearchMode}
              className={webSearchMode ? "composerIconButton active" : "composerIconButton"}
              disabled={!running}
              onClick={() => onWebSearchMode(!webSearchMode)}
              title="Use web search for this message"
              type="button"
            >
              <Globe2 size={18} />
            </button>
          </div>
          <textarea
            value={message}
            onChange={(event) => onMessage(event.target.value)}
            onDrop={(event) => {
              const files = event.dataTransfer.files;
              if (!files?.length) return;
              event.preventDefault();
              onAttachmentFiles(files);
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
              if (files.length === 0) return;
              event.preventDefault();
              onAttachmentFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Message Crix..."
            disabled={!running}
          />
          <button className="sendButton" disabled={!running || (message.trim().length === 0 && attachments.length === 0)} type="submit" title="Send">
            <SendHorizontal size={20} />
          </button>
        </div>
      </form>
    </section>
  );
}

function ProvidersView({
  customModel,
  draftSelection,
  ollamaDiscovery,
  onApply,
  onCustomModel,
  onModel,
  onProvider,
  providers,
  running,
  usageByModel,
}: {
  customModel: string;
  draftSelection: Selection;
  ollamaDiscovery: OllamaDiscovery;
  onApply: () => void;
  onCustomModel: (value: string) => void;
  onModel: (value: string) => void;
  onProvider: (value: ProviderId) => void;
  providers: ProviderOption[];
  running: boolean;
  usageByModel: Record<string, ModelUsage>;
}) {
  const activeProvider = providerById(draftSelection.provider, providers);
  const [inspectedModelId, setInspectedModelId] = useState<string | null>(null);
  const localModels = activeProvider.id === "ollama" ? activeProvider.models.filter((item) => item.source === "local") : [];
  const cloudModels = activeProvider.id === "ollama" ? activeProvider.models.filter((item) => item.source !== "local") : [];
  const groups = groupedModels(activeProvider.id === "ollama" ? cloudModels : activeProvider.models);
  useEffect(() => {
    setInspectedModelId(null);
  }, [activeProvider.id]);
  const selectedModel = activeProvider.models.find((item) => item.id === inspectedModelId)
    ?? activeProvider.models.find((item) => item.id === draftSelection.model)
    ?? activeProvider.models.find((item) => item.id === customModel)
    ?? model(customModel, "Custom model id", "custom", activeProvider.id === "ollama" ? "cloud" : "cloud");
  const selectedUsage = usageByModel[usageKey({ provider: activeProvider.id, model: selectedModel.id })] ?? emptyUsage();
  return (
    <main className="providersShell">
      <section className="providerRail">
        {providers.map((provider) => (
          <button
            className={provider.id === draftSelection.provider ? "providerTile active" : "providerTile"}
            key={provider.id}
            onClick={() => onProvider(provider.id)}
            type="button"
          >
            <Cloud size={17} />
            <span>
              <strong>{provider.label}</strong>
              <small>{provider.note}</small>
            </span>
          </button>
        ))}
      </section>

      <section className="providerDetail">
        <div className="detailTitle">
          {activeProvider.id === "ollama" ? <HardDrive size={20} /> : <Code2 size={20} />}
          <div>
            <h2>{activeProvider.label}</h2>
            <p>{activeProvider.note}</p>
          </div>
        </div>

        {activeProvider.id === "ollama" ? (
          <div className={ollamaDiscovery.reachable ? "discoveryBar online" : "discoveryBar"}>
            {ollamaDiscovery.reachable ? <Check size={15} /> : <AlertTriangle size={15} />}
            <span>{ollamaDiscovery.host}</span>
            <strong>{ollamaDiscovery.reachable ? `${localModels.length} local model${localModels.length === 1 ? "" : "s"}` : `${localModels.length} disk model${localModels.length === 1 ? "" : "s"} / daemon offline`}</strong>
            <button type="button" title="Discovery refreshes automatically" disabled>
              <RefreshCw size={14} />
            </button>
          </div>
        ) : null}

        <ModelInspector
          model={selectedModel}
          onSelect={() => onModel(selectedModel.id)}
          provider={activeProvider}
          selected={selectedModel.id === draftSelection.model}
          usage={selectedUsage}
          localRoot={ollamaDiscovery.localRoot}
        />

        <div className="customModel">
          <label>
            <span>Exact model id</span>
            <input value={customModel} onChange={(event) => {
              onCustomModel(event.target.value);
              onModel("__custom");
            }} />
          </label>
          <button className="primaryAction" type="button" onClick={onApply}>
            <Play size={15} />
            {running ? "Restart with model" : "Start with model"}
          </button>
        </div>

        {activeProvider.id === "ollama" ? (
          <ModelSection
            emptyText={ollamaDiscovery.reachable ? "No local models returned by /api/tags yet." : ollamaDiscovery.error || "Start Ollama and local models appear here."}
            models={localModels}
            inspected={selectedModel.id}
            onInspect={setInspectedModelId}
            onSelect={onModel}
            selection={draftSelection.model}
            title="Local Ollama"
            usageByModel={usageByModel}
            providerId={activeProvider.id}
          />
        ) : null}

        {groups.map(([group, models]) => (
          <section className="modelGroup" key={group}>
            <h3>{activeProvider.id === "ollama" ? `Ollama Cloud / ${group}` : group}</h3>
            <div className="modelGrid">
              {models.map((item) => (
                <ModelTile
                  item={item}
                  key={item.id}
                  inspected={item.id === selectedModel.id}
                  onInspect={setInspectedModelId}
                  onSelect={onModel}
                  selected={item.id === draftSelection.model}
                  usage={usageByModel[usageKey({ provider: activeProvider.id, model: item.id })]}
                />
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}

function ModelSection({
  emptyText,
  inspected,
  models,
  onInspect,
  onSelect,
  providerId,
  selection,
  title,
  usageByModel,
}: {
  emptyText: string;
  inspected: string;
  models: ProviderModel[];
  onInspect: (value: string) => void;
  onSelect: (value: string) => void;
  providerId: ProviderId;
  selection: string;
  title: string;
  usageByModel: Record<string, ModelUsage>;
}) {
  return (
    <section className="modelGroup">
      <h3>{title}</h3>
      {models.length === 0 ? <p className="modelEmpty">{emptyText}</p> : null}
      <div className="modelGrid">
        {models.map((item) => (
          <ModelTile
            item={item}
            key={item.id}
            inspected={item.id === inspected}
            onInspect={onInspect}
            onSelect={onSelect}
            selected={item.id === selection}
            usage={usageByModel[usageKey({ provider: providerId, model: item.id })]}
          />
        ))}
      </div>
    </section>
  );
}

function ModelTile({
  inspected,
  item,
  onInspect,
  onSelect,
  selected,
  usage,
}: {
  inspected: boolean;
  item: ProviderModel;
  onInspect: (value: string) => void;
  onSelect: (value: string) => void;
  selected: boolean;
  usage?: ModelUsage;
}) {
  const tokenTotal = usageTotal(usage);
  const className = `modelTile${selected ? " active" : ""}${inspected ? " inspected" : ""}`;
  return (
    <motion.article
      className={className}
      data-source={item.source ?? "cloud"}
      onClick={() => onInspect(item.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onInspect(item.id);
        }
      }}
      role="button"
      tabIndex={0}
      whileHover={{ y: -4, scale: 1.012 }}
      whileTap={{ scale: 0.982 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {item.imageUrl ? <img alt="" className="modelTileImage" src={item.imageUrl} /> : null}
      <span>{cleanModelName(item.id)}</span>
      <small>{item.hint}</small>
      <div className="modelBadges">
        <em>{sourceLabel(item)}</em>
        {item.usageLevel ? <CloudUsageBars level={item.usageLevel} label={item.usageLabel} compact /> : null}
        {item.size ? <em>{formatBytes(item.size)}</em> : null}
        {item.contextWindow ? <em>{formatContext(item.contextWindow)}</em> : null}
        {item.modalities?.slice(0, 2).map((modality) => <em key={modality}>{modality}</em>)}
      </div>
      {tokenTotal > 0 ? (
        <strong className="usageBadge">
          <BarChart3 size={12} />
          {formatNumber(tokenTotal)}
        </strong>
      ) : null}
      <button
        className={selected ? "modelSelectButton selected" : "modelSelectButton"}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(item.id);
        }}
        type="button"
      >
        {selected ? <Check size={13} /> : <Play size={12} />}
        {selected ? "Selected" : "Select"}
      </button>
    </motion.article>
  );
}

function ModelInspector({
  localRoot,
  model,
  onSelect,
  provider,
  selected,
  usage,
}: {
  localRoot?: string;
  model: ProviderModel;
  onSelect: () => void;
  provider: ProviderOption;
  selected: boolean;
  usage: ModelUsage;
}) {
  const total = usageTotal(usage);
  const spendLabel = model.source === "local" ? "zero cloud spend" : provider.id === "ollama" ? "Ollama cloud counter" : "provider counter";
  return (
    <motion.section
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      className="modelInspector"
      initial={{ opacity: 0, y: 10, scale: 0.985, filter: "blur(10px)" }}
      key={`${provider.id}-${model.id}`}
      transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="modelHero">
        <div className="modelOrb" data-source={model.source ?? "cloud"}>
          {model.imageUrl ? <img alt="" src={model.imageUrl} /> : model.source === "local" ? <HardDrive size={22} /> : <Cloud size={22} />}
        </div>
        <div>
          <p>{sourceLabel(model)} model</p>
          <h2>{model.id}</h2>
          <span>{model.description ?? model.hint}</span>
        </div>
        <button className={selected ? "modelInspectorSelect selected" : "modelInspectorSelect"} onClick={onSelect} type="button">
          {selected ? <Check size={15} /> : <Play size={15} />}
          {selected ? "Selected" : "Select model"}
        </button>
      </div>
      <div className="modelFacts">
        <Fact icon={Layers} label="Size" value={model.size ? formatBytes(model.size) : model.parameters ?? "metered"} />
        <Fact icon={Info} label="Context" value={model.contextWindow ? formatContext(model.contextWindow) : "model default"} />
        <Fact icon={MessageSquare} label="Modes" value={(model.modalities?.length ? model.modalities : ["Text"]).join(", ")} />
        <Fact icon={Wallet} label="Usage" value={total > 0 ? `${formatNumber(total)} tokens` : spendLabel} />
      </div>
      <div className="usageStrip">
        <span><strong>{formatNumber(usage.inputTokens)}</strong> input</span>
        <span><strong>{formatNumber(usage.outputTokens)}</strong> output</span>
        <span><strong>{formatNumber(usage.reasoningTokens)}</strong> reasoning</span>
        <span><strong>{usage.turns}</strong> turns</span>
        {model.usageLevel ? <span className="usageLevelChip"><CloudUsageBars level={model.usageLevel} label={model.usageLabel} /> {model.usageLabel ?? "Usage"}</span> : null}
        {model.pulls ? <span><strong>{model.pulls}</strong> pulls</span> : null}
        {model.updated ? <span>updated <strong>{model.updated}</strong></span> : null}
      </div>
      {provider.id === "ollama" ? (
        <p className="modelFootnote">
          {model.source === "local"
            ? `Local source: ${model.storagePath ?? localRoot ?? "Ollama model store"}`
            : "Cloud usage is tracked from Crix turn token reports so you can see which Ollama model is burning plan budget inside this app."}
          {model.websiteUrl ? <> <a href={model.websiteUrl} rel="noreferrer" target="_blank">Open Ollama page</a></> : null}
        </p>
      ) : null}
    </motion.section>
  );
}

function CloudUsageBars({ compact = false, label, level }: { compact?: boolean; label?: string; level: number }) {
  return (
    <span className={compact ? "cloudUsageBars compact" : "cloudUsageBars"} title={label ? `${label} usage` : "Cloud usage level"}>
      {Array.from({ length: 4 }, (_, index) => (
        <i className={index < level ? "filled" : ""} key={index} />
      ))}
    </span>
  );
}

function Fact({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string }) {
  return (
    <div className="modelFact">
      <Icon size={14} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MindView({
  appearance,
  events,
  onAppearance,
  onTheme,
  status,
  stats,
  theme,
}: {
  appearance: AppearanceSettings;
  events: CrixEvent[];
  onAppearance: (value: AppearanceSettings) => void;
  onTheme: (value: ThemeName) => void;
  status: HeartbeatStatus;
  stats: ReturnType<typeof collectStats>;
  theme: ThemeName;
}) {
  const cards = [
    ["Identity", "Loaded from ~/.crix/IDENTITY.md and SOUL.md"],
    ["Autonomy", "SelfEvolve can rewrite mind files without workspace write prompts"],
    ["Memory", "Capture hook writes preferences, corrections, and decisions into daily raw memory"],
    ["Recall", "Vector memory surfaces relevant context before meaningful turns"],
    ["Dreaming", "LIGHT, DEEP, and REM promote short notes into durable memory"],
    ["Skills", "Capability gaps can become skills and tools instead of dead-end asks"],
  ];
  return (
    <main className="surfaceGrid">
      <AppearancePanel
        appearance={appearance}
        onAppearance={onAppearance}
        onTheme={onTheme}
        theme={theme}
      />
      <section className="surfacePanel wide">
        <header>
          <span><Brain size={17} /> Mind State</span>
          <StatusPill label="Pulse" value={STATUS_LABELS[status]} tone={status === "error" ? "bad" : status === "alert" ? "warn" : "ok"} />
        </header>
        <div className="metricGrid">
          <MetricCard label="Turns" value={String(stats.turns)} />
          <MetricCard label="Tools" value={String(stats.tools)} />
          <MetricCard label="Dreams" value={String(stats.dreams)} />
          <MetricCard label="Recall" value={String(stats.recalls)} />
        </div>
      </section>
      <GrowthPanel events={events} />
      {cards.map(([title, body]) => (
        <section className="surfacePanel" key={title}>
          <header><span><Sparkles size={16} /> {title}</span></header>
          <p>{body}</p>
        </section>
      ))}
    </main>
  );
}

function GrowthPanel({ events }: { events: CrixEvent[] }) {
  const gains = events
    .flatMap((event) => {
      const inner = event.type === "lifecycle" ? event.event : event;
      return inner?.gain ? [{ type: inner.type, gain: inner.gain, at: inner.receivedAt ?? event.receivedAt ?? 0 }] : [];
    })
    .filter((item) => item.gain.target && typeof item.gain.delta === "number")
    .slice(-6)
    .reverse();

  return (
    <section className="surfacePanel wide growthPanel">
      <header><span><BarChart3 size={16} /> Growth Feed</span></header>
      {gains.length > 0 ? (
        <div className="growthList">
          {gains.map((item, index) => (
            <div className="growthItem" key={`${item.type}-${item.gain.target}-${index}`}>
              <span>{humanizeSource(item.type)}</span>
              <strong>{prettyPulseTarget(item.gain.target, item.gain.kind)}</strong>
              <em>+{item.gain.delta}</em>
            </div>
          ))}
        </div>
      ) : (
        <p>No growth telemetry in this visible session yet.</p>
      )}
    </section>
  );
}

function AppearancePanel({
  appearance,
  onAppearance,
  onTheme,
  theme,
}: {
  appearance: AppearanceSettings;
  onAppearance: (value: AppearanceSettings) => void;
  onTheme: (value: ThemeName) => void;
  theme: ThemeName;
}) {
  return (
    <section className="surfacePanel wide appearancePanel">
      <header>
        <span><Sparkles size={17} /> Appearance</span>
        <StatusPill label="Theme" value={THEME_LABELS[theme]} tone="ok" />
      </header>
      <div className="themeChooser">
        {THEME_CHOICES.map((item) => (
          <button
            className={theme === item ? "themeChoice active" : "themeChoice"}
            key={item}
            onClick={() => onTheme(item)}
            type="button"
          >
            <ThemeGlyph theme={item} />
            <span>{THEME_LABELS[item]}</span>
          </button>
        ))}
      </div>
      <div className="appearanceControls">
        <label className="opacityControl">
          <span>Opacity <strong>{Math.round(appearance.opacity * 100)}%</strong></span>
          <input
            max="0.92"
            min="0.34"
            onChange={(event) => onAppearance({ ...appearance, opacity: clampOpacity(Number(event.target.value)) })}
            step="0.02"
            type="range"
            value={appearance.opacity}
          />
        </label>
        <div className="cornerControl" role="group" aria-label="Corner style">
          <button
            className={appearance.corners === "rounded" ? "active" : ""}
            onClick={() => onAppearance({ ...appearance, corners: "rounded" })}
            type="button"
          >
            Rounded
          </button>
          <button
            className={appearance.corners === "square" ? "active" : ""}
            onClick={() => onAppearance({ ...appearance, corners: "square" })}
            type="button"
          >
            Squared
          </button>
        </div>
      </div>
    </section>
  );
}

function ThemeGlyph({ theme }: { theme: ThemeName }) {
  if (theme === "matrix") return <TerminalSquare size={18} />;
  if (theme === "storm") return <Power size={18} />;
  return <Sparkles size={18} />;
}

function ToolsView({ events }: { events: CrixEvent[] }) {
  const toolEvents = events.filter((event) => event.type === "tool_call" || event.type.startsWith("tool_")).slice(-36).reverse();
  return (
    <main className="surfaceGrid toolsGrid">
      <section className="surfacePanel wide">
        <header><span><Wrench size={17} /> Tool Runs</span></header>
        <div className="toolList">
          {toolEvents.length === 0 ? <p className="muted">No tool runs in this session yet.</p> : null}
          {toolEvents.map((event, index) => (
            <EventCard event={event} key={`${event.type}-${index}`} compact />
          ))}
        </div>
      </section>
    </main>
  );
}

function EventCard({
  event,
  compact = false,
  onPermissionDecision,
}: {
  event: CrixEvent;
  compact?: boolean;
  onPermissionDecision?: (id: string | undefined, decision: PermissionDecision) => void;
}) {
  if (event.type === "thinking_stream") return <ThinkingTrace event={event} compact={compact} />;
  const kind = eventKind(event);
  const title = eventTitle(event);
  const text = eventText(event);
  const Icon = eventIcon(event);
  const state = event.type === "tool_call" ? event.status ?? "queued" : "";
  return (
    <motion.article
      className={`eventCard ${kind}${state ? ` state-${state}` : ""}${compact ? " compact" : ""}`}
      layout
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="eventAvatar"><Icon size={16} /></div>
      <div className="eventBody">
        <header>
          <strong>{title}</strong>
          <time>{event.type === "tool_call" ? event.status : event.type}</time>
        </header>
        {event.type === "permission_gate" ? (
          <PermissionGate event={event} onDecision={onPermissionDecision} />
        ) : event.type === "tool_call" ? (
          <ToolCallShow event={event} text={text} />
        ) : event.type === "assistant_stream" && text ? (
          <StreamingText text={text} />
        ) : text ? (
          <pre>{text}</pre>
        ) : null}
        {event.attachments?.length ? <AttachmentStrip attachments={event.attachments} /> : null}
        {event.webSearch ? (
          <span className="eventModeBadge">
            <Globe2 size={12} />
            Web search requested
          </span>
        ) : null}
      </div>
    </motion.article>
  );
}

function PermissionGate({
  event,
  onDecision,
}: {
  event: CrixEvent;
  onDecision?: (id: string | undefined, decision: PermissionDecision) => void;
}) {
  const waiting = event.status === "waiting";
  const decision = normalizeDecision(event.decision);
  return (
    <div className="permissionGate">
      <div className="permissionReason">
        <ShieldCheck size={14} />
        <span>{event.reason || "Tool permission required"}</span>
      </div>
      {event.input !== undefined ? <pre className="permissionInput">{previewValue(event.input)}</pre> : null}
      {waiting ? (
        <div className="permissionActions">
          <button type="button" onClick={() => onDecision?.(event.id, "allow_once")}>
            <Check size={14} />
            Allow once
          </button>
          <button type="button" onClick={() => onDecision?.(event.id, "allow_always")}>
            <ShieldCheck size={14} />
            Always
          </button>
          <button className="deny" type="button" onClick={() => onDecision?.(event.id, "deny")}>
            <X size={14} />
            Deny
          </button>
        </div>
      ) : (
        <div className={`permissionResult ${decision === "deny" ? "deny" : "allow"}`}>
          {decision === "deny" ? <X size={14} /> : <Check size={14} />}
          {decision ? permissionDecisionLabel(decision) : "Answered"}
        </div>
      )}
    </div>
  );
}

function LiveActivityStrip({ activity }: { activity: LiveActivity }) {
  const elapsed = activity.startedAt ? formatElapsed(Date.now() - activity.startedAt) : "";
  const stale = activity.updatedAt && activity.tone === "active" ? formatElapsed(Date.now() - activity.updatedAt) : "";
  return (
    <div className={`liveActivityStrip ${activity.tone}`}>
      <span className="liveActivityDot" />
      <strong>{activity.title}</strong>
      <span>{activity.detail}</span>
      {elapsed ? <em>{elapsed}</em> : null}
      {stale && stale !== elapsed ? <small>last {stale}</small> : null}
    </div>
  );
}

function AttachmentTray({ attachments, onRemove }: { attachments: ChatAttachment[]; onRemove: (id: string) => void }) {
  return (
    <div className="attachmentTray">
      {attachments.map((attachment) => (
        <motion.div
          className="attachmentChip"
          key={attachment.id}
          layout
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.96 }}
        >
          <img alt="" src={attachment.dataUrl} />
          <span>
            <strong>{attachment.name}</strong>
            <small>{formatBytes(attachment.size)}</small>
          </span>
          <button aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)} type="button">
            <X size={13} />
          </button>
        </motion.div>
      ))}
    </div>
  );
}

function AttachmentStrip({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="eventAttachments">
      {attachments.map((attachment) => (
        <figure key={attachment.id}>
          <img alt={attachment.name} src={attachment.dataUrl} />
          <figcaption>{attachment.name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function ThinkingTrace({ event, compact = false }: { event: CrixEvent; compact?: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const text = eventText(event);
  const charCount = text.length;
  return (
    <motion.article
      className={`eventCard thinking${compact ? " compact" : ""}`}
      layout
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="eventAvatar"><Brain size={16} /></div>
      <div className="thinkingPanel">
        <button
          aria-expanded={expanded}
          className="thinkingToggle"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <span className="thinkingPulse" />
          <strong>Thinking</strong>
          <span className="thinkingMeta">{charCount > 0 ? `${formatNumber(charCount)} chars streaming` : "waiting"}</span>
          <ChevronDown className={expanded ? "thinkingChevron open" : "thinkingChevron"} size={16} />
        </button>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              animate={{ height: "auto", opacity: 1, filter: "blur(0px)" }}
              className="thinkingContent"
              exit={{ height: 0, opacity: 0, filter: "blur(6px)" }}
              initial={{ height: 0, opacity: 0, filter: "blur(6px)" }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
            >
              <StreamingText text={text || "Thinking..."} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.article>
  );
}

function StreamingText({ text }: { text: string }) {
  const stable = text.length > 90 ? text.slice(0, -90) : "";
  const live = text.length > 90 ? text.slice(-90) : text;
  return (
    <pre className="streamingText">
      {stable}
      {[...live].map((char, index) => (
        <span key={`${index}-${char}`} style={{ animationDelay: `${index * 8}ms` }}>{char}</span>
      ))}
    </pre>
  );
}

function ToolCallShow({ event, text }: { event: CrixEvent; text: string }) {
  const stages = ["planned", "args", "run", "done"];
  const index = toolStageIndex(event.status);
  return (
    <div className="toolShowcase">
      <div className="toolStageTrack" data-state={event.status ?? "queued"}>
        {stages.map((stage, stageIndex) => (
          <span className={stageIndex <= index ? "active" : ""} key={stage}>
            <i />
            {stage}
          </span>
        ))}
      </div>
      {text ? <pre className="toolPayload">{text}</pre> : null}
      <ToolStateRail event={event} />
    </div>
  );
}

function ToolStateRail({ event }: { event: CrixEvent }) {
  const filePulse = event.touchedFiles?.length ? `+${event.touchedFiles.length} file${event.touchedFiles.length === 1 ? "" : "s"}` : "done";
  return (
    <div className="toolStateRail">
      <span className="toolBlink" />
      <span>{event.name ?? "tool"}</span>
      {event.status === "completed" ? <strong>{filePulse}</strong> : null}
      {event.status === "running" || event.status === "planning" ? <strong>streaming</strong> : null}
      {event.status === "failed" ? <strong>blocked</strong> : null}
    </div>
  );
}

function toolStageIndex(status?: string): number {
  if (status === "failed") return 3;
  if (status === "completed") return 3;
  if (status === "running") return 2;
  if (status === "ready") return 1;
  if (status === "planning") return 0;
  return 0;
}

function NavButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: React.ComponentType<{ size?: number }>; label: string; onClick: () => void }) {
  return (
    <button className={active ? "navButton active" : "navButton"} onClick={onClick} type="button">
      <Icon size={15} />
      {label}
    </button>
  );
}

function InfoLine({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string }) {
  return (
    <div className="infoLine">
      <Icon size={14} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  return (
    <span className={`statusPill ${tone}`}>
      <small>{label}</small>
      {value}
    </span>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function appendEvent(events: CrixEvent[], event: CrixEvent): CrixEvent[] {
  if (event.type === "tool_use_input_delta") return events;
  if (isPermissionEvent(event)) return upsertPermissionEvent(events, event);
  if (isToolEvent(event)) return upsertToolEvent(events, event);
  if (event.type === "turn_start") {
    const now = event.receivedAt ?? Date.now();
    return [...events, { type: "thinking_stream", text: "", startedAt: now, updatedAt: now, receivedAt: now }];
  }
  if (event.type === "text_delta") {
    const last = events[events.length - 1];
    const now = event.receivedAt ?? Date.now();
    if (last?.type === "thinking_stream" && !last.text) {
      return [...events.slice(0, -1), { type: "assistant_stream", text: event.text ?? "", startedAt: last.startedAt ?? now, updatedAt: now, receivedAt: now }];
    }
    if (last?.type === "assistant_stream") {
      return [...events.slice(0, -1), { ...last, text: `${last.text ?? ""}${event.text ?? ""}`, updatedAt: now, receivedAt: now }];
    }
    return [...events, { type: "assistant_stream", text: event.text ?? "", startedAt: now, updatedAt: now, receivedAt: now }];
  }
  if (event.type === "thinking_delta") {
    const last = events[events.length - 1];
    const now = event.receivedAt ?? Date.now();
    if (last?.type === "thinking_stream") {
      return [...events.slice(0, -1), { ...last, text: `${last.text ?? ""}${event.text ?? ""}`, updatedAt: now, receivedAt: now }];
    }
    return [...events, { type: "thinking_stream", text: event.text ?? "", startedAt: now, updatedAt: now, receivedAt: now }];
  }
  if (event.type === "message_done") return events;
  return [...events, event];
}

function isToolEvent(event: CrixEvent): boolean {
  return [
    "tool_use_start",
    "tool_use_input_done",
    "tool_start",
    "tool_progress",
    "tool_end",
    "tool_error",
  ].includes(event.type);
}

function isPermissionEvent(event: CrixEvent): boolean {
  return event.type === "permission_request" || event.type === "permission_response";
}

function upsertPermissionEvent(events: CrixEvent[], event: CrixEvent): CrixEvent[] {
  const id = event.id;
  if (!id) return [...events, event];
  const index = events.findIndex((item) => item.type === "permission_gate" && item.id === id);
  const previous = index >= 0 ? events[index] : undefined;
  const merged = mergePermissionEvent(previous, event);
  if (index === -1) return [...events, merged];
  return [...events.slice(0, index), merged, ...events.slice(index + 1)];
}

function mergePermissionEvent(previous: CrixEvent | undefined, event: CrixEvent): CrixEvent {
  const now = event.receivedAt ?? Date.now();
  const base: CrixEvent = previous ?? {
    type: "permission_gate",
    id: event.id,
    toolName: event.toolName,
    status: "waiting",
    startedAt: now,
    updatedAt: now,
    receivedAt: now,
  };
  if (event.type === "permission_request") {
    return {
      ...base,
      id: event.id,
      toolName: event.toolName ?? base.toolName,
      input: event.input ?? base.input,
      reason: event.reason ?? base.reason,
      suggestion: event.suggestion ?? base.suggestion,
      status: "waiting",
      updatedAt: now,
      receivedAt: now,
    };
  }
  const decision = normalizeDecision(event.decision);
  return {
    ...base,
    id: event.id,
    decision: decision ?? event.decision,
    status: decision === "deny" ? "denied" : "allowed",
    updatedAt: now,
    receivedAt: now,
  };
}

function upsertToolEvent(events: CrixEvent[], event: CrixEvent): CrixEvent[] {
  const id = event.id;
  if (!id) return [...events, event];
  const index = events.findIndex((item) => item.type === "tool_call" && item.id === id);
  const previous = index >= 0 ? events[index] : undefined;
  const merged = mergeToolEvent(previous, event);
  if (index === -1) return [...events, merged];
  return [...events.slice(0, index), merged, ...events.slice(index + 1)];
}

function mergeToolEvent(previous: CrixEvent | undefined, event: CrixEvent): CrixEvent {
  const now = event.receivedAt ?? Date.now();
  const base: CrixEvent = previous ?? {
    type: "tool_call",
    id: event.id,
    name: event.name,
    status: "queued",
    startedAt: now,
    updatedAt: now,
    receivedAt: now,
  };
  if (event.type === "tool_use_start") {
    return { ...base, id: event.id, name: event.name ?? base.name, status: "planning", updatedAt: now, receivedAt: now };
  }
  if (event.type === "tool_use_input_done") {
    return { ...base, id: event.id, input: event.input, status: base.status === "running" ? "running" : "ready", updatedAt: now, receivedAt: now };
  }
  if (event.type === "tool_start") {
    return {
      ...base,
      id: event.id,
      name: event.name ?? base.name,
      input: event.input ?? base.input,
      activityDescription: event.activityDescription,
      status: "running",
      updatedAt: now,
      receivedAt: now,
    };
  }
  if (event.type === "tool_progress") {
    return { ...base, id: event.id, data: event.data, status: "running", updatedAt: now, receivedAt: now };
  }
  if (event.type === "tool_end") {
    return {
      ...base,
      id: event.id,
      output: event.output,
      touchedFiles: event.touchedFiles,
      durationMs: event.durationMs,
      display: event.display,
      status: "completed",
      updatedAt: now,
      receivedAt: now,
    };
  }
  if (event.type === "tool_error") {
    return { ...base, id: event.id, error: event.error, durationMs: event.durationMs, status: "failed", updatedAt: now, receivedAt: now };
  }
  return { ...base, ...event };
}

function collectStats(events: CrixEvent[]) {
  let tokens = 0;
  let turns = 0;
  let tools = 0;
  let dreams = 0;
  let recalls = 0;
  for (const event of events) {
    if (event.type === "turn_end") {
      turns++;
      tokens += Number(event.usage?.inputTokens ?? 0) + Number(event.usage?.outputTokens ?? 0);
    }
    if (event.type === "tool_call") tools++;
    if (event.type === "dream_phase_ended") dreams++;
    if (event.type === "memory_recall_emitted" || event.type === "system_reminder_injected" && event.source === "recall") recalls++;
  }
  return { turns, tools, tokens, dreams, recalls };
}

function isChatVisibleEvent(event: CrixEvent): boolean {
  if (event.type === "user_send" || event.type === "assistant_stream" || event.type === "thinking_stream") return true;
  if (event.type === "tool_call") return true;
  if (event.type === "permission_gate") return true;
  if (event.type === "desktop_preview" || event.type === "desktop_error" || event.type === "desktop_model_applied") return true;
  if (event.type === "reasoning_set") return true;
  if (event.type === "error" || event.type === "daemon_error") return true;
  return false;
}

function eventKind(event: CrixEvent): string {
  if (event.type === "user_send") return "user";
  if (event.type === "assistant_stream") return "assistant";
  if (event.type === "thinking_stream") return "thinking";
  if (event.type === "permission_gate") return event.status === "denied" ? "bad" : "tool";
  if (event.type.includes("error") || event.status === "failed") return "bad";
  if (event.type === "tool_call" || event.type.startsWith("tool_")) return "tool";
  if (event.type.includes("daemon")) return "daemon";
  if (event.type.includes("dream") || event.type.includes("memory") || event.type.includes("soul")) return "mind";
  return "system";
}

function eventIcon(event: CrixEvent) {
  if (event.type === "user_send") return MessageSquare;
  if (event.type === "assistant_stream") return Bot;
  if (event.type === "thinking_stream") return Brain;
  if (event.type === "permission_gate") return ShieldCheck;
  if (event.type === "tool_call" || event.type.startsWith("tool_")) return Wrench;
  if (event.type.includes("daemon")) return TerminalSquare;
  if (event.type.includes("dream") || event.type.includes("memory") || event.type.includes("soul")) return Brain;
  return Sparkles;
}

function eventTitle(event: CrixEvent): string {
  if (event.type === "user_send") return "You";
  if (event.type === "assistant_stream") return "Crix";
  if (event.type === "thinking_stream") return "Thinking";
  if (event.type === "permission_gate") return event.toolName ? `Permission: ${event.toolName}` : "Permission";
  if (event.type === "tool_call") return event.name ? `Tool: ${event.name}` : "Tool";
  if (event.type === "tool_start") return event.name ? `Tool: ${event.name}` : "Tool started";
  if (event.type === "tool_end") return event.name ? `Tool finished: ${event.name}` : "Tool finished";
  if (event.type === "turn_end") return `Turn ${event.status ?? "ended"}`;
  if (event.type === "desktop_model_applied") return "Model applied";
  if (event.type === "reasoning_set") return "Reasoning updated";
  return humanize(event.type);
}

function eventText(event: CrixEvent): string {
  if (event.type === "tool_call") {
    if (event.status === "completed") {
      return [event.display, event.output !== undefined ? previewValue(event.output) : ""].filter(Boolean).join("\n");
    }
    if (event.status === "failed") return event.error ? (typeof event.error === "string" ? event.error : previewValue(event.error)) : "failed";
    if (event.status === "running" && event.data !== undefined) return progressText(event.data) ?? previewValue(event.data);
    if (event.activityDescription) return event.activityDescription;
    if (event.input !== undefined) return previewValue(event.input);
    if (event.data !== undefined) return previewValue(event.data);
    return event.status ?? "";
  }
  if (event.type === "permission_gate") return event.reason ?? "";
  if (event.type === "reasoning_set") return isReasoningLevel(event.level) ? `Reasoning is now ${reasoningLabel(event.level)}.` : "";
  if (event.text) return event.text;
  if (event.error) return typeof event.error === "string" ? event.error : previewValue(event.error);
  if (event.activityDescription) return event.activityDescription;
  if (event.display) return event.display;
  if (event.provider || event.model) return [event.provider, event.model].filter(Boolean).join(" / ");
  if (event.phase) return event.phase;
  if (event.status) return event.durationMs ? `${event.status} in ${event.durationMs}ms` : event.status;
  if (event.root) return event.root;
  if (event.output !== undefined) return previewValue(event.output);
  if (event.input !== undefined) return previewValue(event.input);
  return "";
}

function providerById(id: ProviderId, providers: ProviderOption[] = PROVIDERS): ProviderOption {
  return providers.find((provider) => provider.id === id) ?? providers[0] ?? PROVIDERS[0];
}

function currentLiveActivity(events: CrixEvent[], daemon: DaemonState, status: HeartbeatStatus, now: number): LiveActivity {
  if (daemon !== "running") {
    return {
      title: daemon === "starting" ? "Starting daemon" : daemon === "error" ? "Daemon error" : "Daemon stopped",
      detail: daemon === "error" ? "check the latest error card" : "native bridge is not ready",
      tone: daemon === "error" ? "bad" : "warn",
      updatedAt: now,
    };
  }

  const waitingPermission = [...events].reverse().find((event) => event.type === "permission_gate" && event.status === "waiting");
  if (waitingPermission) {
    return {
      title: "Waiting for approval",
      detail: waitingPermission.toolName || waitingPermission.reason || "tool permission",
      tone: "warn",
      startedAt: waitingPermission.startedAt,
      updatedAt: waitingPermission.updatedAt,
    };
  }

  const runningTool = [...events].reverse().find((event) => event.type === "tool_call" && ["planning", "ready", "running"].includes(event.status ?? ""));
  if (runningTool) {
    return {
      title: runningTool.name ? `Running ${runningTool.name}` : "Running tool",
      detail: progressText(runningTool.data) ?? runningTool.activityDescription ?? eventText(runningTool) ?? "waiting for tool output",
      tone: "active",
      startedAt: runningTool.startedAt,
      updatedAt: runningTool.updatedAt,
    };
  }

  const latest = [...events].reverse().find((event) => event.type === "thinking_stream" || event.type === "assistant_stream" || event.type === "user_send");
  if (status === "active" && latest?.type === "assistant_stream") {
    return {
      title: "Streaming answer",
      detail: `${formatNumber((latest.text ?? "").length)} chars received`,
      tone: "active",
      startedAt: latest.startedAt,
      updatedAt: latest.updatedAt,
    };
  }
  if (status === "active" && latest?.type === "thinking_stream") {
    const chars = (latest.text ?? "").length;
    return {
      title: chars > 0 ? "Thinking live" : "Waiting for first token",
      detail: chars > 0 ? `${formatNumber(chars)} reasoning chars streamed` : "provider accepted the turn; no token yet",
      tone: "active",
      startedAt: latest.startedAt,
      updatedAt: latest.updatedAt,
    };
  }
  if (status === "alert") {
    return {
      title: "Needs attention",
      detail: "latest event is waiting on you",
      tone: "warn",
      updatedAt: now,
    };
  }
  if (status === "error") {
    return {
      title: "Stopped on error",
      detail: "open the latest error card",
      tone: "bad",
      updatedAt: now,
    };
  }
  return {
    title: "Ready",
    detail: "daemon linked; send the next message",
    tone: "idle",
    updatedAt: now,
  };
}

function modelForProvider(id: ProviderId, providers: ProviderOption[] = PROVIDERS): string {
  return providerById(id, providers).models[0]?.id ?? DEFAULT_SELECTION.model;
}

function isProviderId(value: string): boolean {
  return value === "ollama" || value === "openai" || value === "mock";
}

function groupedModels(models: ProviderModel[]): Array<[string, ProviderModel[]]> {
  const groups = new Map<string, ProviderModel[]>();
  for (const item of models) {
    groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  }
  return [...groups.entries()];
}

function model(
  id: string,
  hint: string,
  group: string,
  source: ProviderModel["source"] = "cloud",
  extra: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    modalities: source === "local" ? ["Text"] : ["Text"],
    capabilities: [],
    ...extra,
    id,
    hint,
    group,
    source,
  };
}

function sourceLabel(item: ProviderModel): string {
  if (item.source === "local") return "Local";
  if (item.source === "dev") return "Dev";
  return "Cloud";
}

function usageKey(selection: Selection): string {
  return `${selection.provider}/${selection.model}`;
}

function daemonSelectionArgs(selection: Selection): Record<string, string> {
  return {
    provider: selection.provider,
    model: selection.model,
  };
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    turns: 0,
    updatedAt: 0,
  };
}

function usageTotal(usage?: ModelUsage): number {
  if (!usage) return 0;
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.reasoningTokens;
}

function loadModelUsage(): Record<string, ModelUsage> {
  try {
    const raw = window.localStorage.getItem(USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelUsage>>;
    const clean: Record<string, ModelUsage> = {};
    for (const [key, value] of Object.entries(parsed)) {
      clean[key] = {
        inputTokens: Number(value.inputTokens ?? 0),
        outputTokens: Number(value.outputTokens ?? 0),
        cacheReadTokens: Number(value.cacheReadTokens ?? 0),
        cacheWriteTokens: Number(value.cacheWriteTokens ?? 0),
        reasoningTokens: Number(value.reasoningTokens ?? 0),
        turns: Number(value.turns ?? 0),
        updatedAt: Number(value.updatedAt ?? 0),
      };
    }
    return clean;
  } catch {
    return {};
  }
}

function saveModelUsage(usage: Record<string, ModelUsage>): void {
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Usage is helpful UI telemetry, not a critical state path.
  }
}

function createSession(): SessionRecord {
  const now = Date.now();
  return {
    id: `session-${now}-${Math.random().toString(16).slice(2)}`,
    name: "New session",
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function titleFromPrompt(text: string): string {
  const first = text.trim().split(/\r?\n/, 1)[0] || "New session";
  return first.length > 44 ? `${first.slice(0, 41).trim()}...` : first;
}

function activeViewTitle(view: View): string {
  if (view === "providers") return "Provider Control";
  if (view === "mind") return "Mind";
  if (view === "tools") return "Tool Deck";
  return "Session";
}

function cleanModelName(id: string): string {
  return id.replace(/-cloud$/u, "").replace(/:cloud$/u, "").replace(/:/gu, " ");
}

function humanize(value: string): string {
  return value.replace(/_/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function reasoningLabel(level: ReasoningLevel): string {
  return REASONING_OPTIONS.find((option) => option.id === level)?.label ?? level;
}

function reasoningSyncLabel(sync: ReasoningSync): string {
  if (sync === "syncing") return "syncing";
  if (sync === "applied") return "live";
  if (sync === "error") return "error";
  return "live";
}

function normalizeDecision(value: unknown): PermissionDecision | null {
  return value === "allow_once" || value === "allow_always" || value === "deny" ? value : null;
}

function permissionDecisionLabel(decision: PermissionDecision): string {
  if (decision === "allow_always") return "Allowed always";
  if (decision === "allow_once") return "Allowed once";
  return "Denied";
}

function progressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "shell_output") {
    const text = String(obj.text ?? "").trimEnd();
    return text ? `${obj.stream ?? "stdout"} ${text}`.slice(0, 320) : null;
  }
  if (obj.kind === "grep_match") {
    const file = typeof obj.file === "string" ? shortPath(obj.file) : "files";
    return `grep ${obj.total ?? "?"} match(es) · ${file}${obj.line ? `:${obj.line}` : ""}`;
  }
  if (obj.kind === "lsp_init") return `starting ${obj.server ?? "LSP"}`;
  if (obj.kind === "lsp_ready") return `${obj.server ?? "LSP"} ready`;
  return previewValue(obj);
}

function shortPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

function previewValue(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
  } catch {
    return String(value);
  }
}

function buildOutgoingGoal(text: string, attachments: ChatAttachment[], webSearch: boolean): string {
  const parts = [text.trim()];
  if (webSearch) {
    parts.push(
      [
        "",
        "[Crix desktop web mode is ON for this message.]",
        "Use WebSearch and WebFetch when current web context would improve the answer. Cite or summarize what you used instead of guessing.",
      ].join("\n"),
    );
  }
  if (attachments.length > 0) {
    parts.push(
      [
        "",
        "[Attached image data follows. Inspect it directly before answering.]",
        ...attachments.flatMap((attachment, index) => [
          `Image ${index + 1}: ${attachment.name} (${attachment.mediaType}, ${formatBytes(attachment.size)})`,
          attachment.dataUrl,
        ]),
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

function readAttachmentFile(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
    reader.onload = () => {
      resolve({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        mediaType: file.type || mediaTypeForAttachmentName(file.name) || "image/png",
        dataUrl: String(reader.result ?? ""),
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

function dedupeAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>();
  const out: ChatAttachment[] = [];
  for (const attachment of attachments) {
    const key = `${attachment.name}:${attachment.size}:${attachment.dataUrl.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}

function mediaTypeForAttachmentName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function formatContext(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function loadDesktopSettings(): { theme: ThemeName; selection: Selection; appearance: AppearanceSettings } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<{ theme: ThemeName; selection: Selection; appearance: Partial<AppearanceSettings> }>;
    const allowMock = Boolean(import.meta.env.DEV) || window.localStorage.getItem("crix.dev") === "1";
    const parsedProvider = parsed.selection?.provider;
    const provider =
      parsedProvider && isProviderId(parsedProvider) && (parsedProvider !== "mock" || allowMock)
        ? parsedProvider
        : DEFAULT_SELECTION.provider;
    const selection = {
      provider,
      model: parsed.selection?.model || modelForProvider(provider),
    };
    return {
      theme: normalizeTheme(parsed.theme),
      selection,
      appearance: normalizeAppearance(parsed.appearance),
    };
  } catch {
    return { theme: "signal", selection: DEFAULT_SELECTION, appearance: DEFAULT_APPEARANCE };
  }
}

function saveDesktopSettings(settings: { theme: ThemeName; selection: Selection; appearance: AppearanceSettings }) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings persistence is best effort.
  }
}

function normalizeTheme(value?: string): ThemeName {
  if (value === "matrix" || value === "storm" || value === "signal" || value === "graphite" || value === "oxide") return value;
  return "signal";
}

function normalizeAppearance(value?: Partial<AppearanceSettings>): AppearanceSettings {
  return {
    opacity: clampOpacity(Number(value?.opacity ?? DEFAULT_APPEARANCE.opacity)),
    corners: value?.corners === "square" ? "square" : "rounded",
  };
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.opacity;
  return Math.min(0.92, Math.max(0.34, value));
}

function CpuIcon(props: { size?: number }) {
  return <Settings2 {...props} />;
}

function stopDragEvent(event: React.MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

function runWindowCommand(command: "crix_window_minimize" | "crix_window_toggle_maximize" | "crix_window_close") {
  return (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void invoke(command);
  };
}

function hasNativeBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

createRoot(document.getElementById("root")!).render(<App />);
