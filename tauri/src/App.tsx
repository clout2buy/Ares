import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
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
  Volume2,
  VolumeX,
  Mic,
  MicOff,
  Wallet,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import "./styles.css";

type View = "chat" | "providers" | "mind" | "tools";
type ProviderId = "ollama" | "openai" | "openrouter" | "mock";
type ThemeName = "signal" | "graphite" | "oxide" | "matrix" | "storm";
type CornerMode = "rounded" | "square";
type HeartbeatStatus = "idle" | "active" | "alert" | "dreaming" | "error";
type DaemonState = "starting" | "running" | "stopped" | "error";
type VoiceStatus = "off" | "connecting" | "ready" | "speaking" | "error";
type SttStatus = "off" | "ready" | "listening" | "transcribing" | "error";

interface EvolutionGain {
  target: string;
  delta: number;
  kind?: string;
}

interface AresEvent {
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
  event?: AresEvent;
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
  event: AresEvent;
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

interface AresIdentity {
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
  events: AresEvent[];
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

interface VoiceServerEvent {
  type?: string;
  id?: string;
  audio?: string;
  mime?: string;
  message?: string;
}

interface MindBeat {
  id: string;
  kind: string;
  text: string;
  confidence?: number;
}

// Glyphs mirror @ares/mind cognition/stream.ts so the rendered monologue reads
// like a mind at work, not a log.
const MIND_GLYPH: Record<string, string> = {
  observe: "\u{1F441}",
  recall: "\u{1F4AD}",
  question: "?",
  idea: "\u{1F4A1}",
  doubt: "\u{1F914}",
  decide: "✓",
  intend: "→",
  reflect: "↻",
};

// The "watch it think" surface — advisory cognition beats streamed live, typed in
// with their glyph; decide/intend carry a confidence chip. Non-binding by design.
interface CoreActivity {
  id: string;
  zone: string;
  label: string;
  status: "active" | "completed";
}

// Map a tool to a Containment-Core "zone" — the presence layer's room names.
function zoneForActivity(name: string | undefined, _label: string): string {
  const n = (name ?? "").toLowerCase();
  if (["read", "write", "edit", "applyintent", "findandedit"].includes(n)) return "Code Forge";
  if (["bash", "powershell", "bashoutput", "killshell"].includes(n)) return "Build Forge";
  if (["grep", "glob", "codebasesearch"].includes(n)) return "Index Scan";
  if (["browser", "webfetch", "websearch"].includes(n)) return "Browser Radar";
  if (["memory", "livingmind"].includes(n)) return "Memory Vault";
  if (["mission", "operator"].includes(n)) return "Mission War Room";
  if (n === "task") return "Subagent Bay";
  if (n.startsWith("skill") || ["runskill", "selfevolve", "self", "bootstrap"].includes(n)) return "Self Lab";
  return "Core Reactor";
}

// The presence layer: slides in on tool activity, snaps to COMPLETED (or a red
// CONTAINMENT BREACH on failure) with a glitch beat, then dismisses.
function CorePanel({ activity }: { activity: CoreActivity }) {
  const done = activity.status === "completed";
  return (
    <motion.div
      className={`corePanel${done ? " done" : ""}`}
      initial={{ opacity: 0, x: 44, filter: "blur(4px)" }}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: 44, filter: "blur(8px)" }}
      transition={{ duration: 0.28, ease: [0.16, 0.84, 0.24, 1] }}
    >
      <div className="corePanelScan" aria-hidden="true" />
      <div className="corePanelHead">
        <span className="coreDot" />
        <strong>{activity.zone}</strong>
        <span className="coreState">{done ? "done" : "active"}</span>
      </div>
      <div className="coreActivityLabel">{activity.label}</div>
    </motion.div>
  );
}

function MindPanel({ beats }: { beats: MindBeat[] }) {
  const latestId = beats[beats.length - 1]?.id;
  return (
    <motion.div
      className="mindPanel"
      initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, y: 8, filter: "blur(4px)" }}
      transition={{ duration: 0.26, ease: [0.16, 0.84, 0.24, 1] }}
    >
      <div className="mindPanelHead">
        <Brain size={13} />
        <strong>Thinking</strong>
        <span className="mindPanelHint">advisory · not acted on</span>
      </div>
      <div className="mindBeats">
        {beats.map((b) => (
          <div className={`mindBeat ${b.kind}${b.id === latestId ? " live" : ""}`} key={b.id}>
            <span className="mindGlyph">{MIND_GLYPH[b.kind] ?? "·"}</span>
            <span className="mindText">{b.text}</span>
            {typeof b.confidence === "number" ? (
              <span className="mindConf">{Math.round(b.confidence * 100)}%</span>
            ) : null}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

interface AppearanceSettings {
  opacity: number;
  corners: CornerMode;
  voiceId: string;
  voiceSpeed: number;
}

// Owner-assigned model routing — the "pill" lets the user pin a provider+model
// to each task lane. Mirrors @ares/core's RouteLane / RouteAssignments. A lane
// left null falls back to Ares's heuristic router.
type RouteLane = "chat" | "coding" | "research" | "tool-use";
const ROUTE_LANES: readonly RouteLane[] = ["chat", "coding", "research", "tool-use"] as const;
const ROUTE_LANE_LABELS: Record<RouteLane, string> = {
  chat: "Chat",
  coding: "Coding",
  research: "Research",
  "tool-use": "Tool use",
};
const ROUTE_LANE_HINTS: Record<RouteLane, string> = {
  chat: "Everyday conversation, memory, quick answers",
  coding: "Writing & editing code",
  research: "Planning, review, deep reasoning",
  "tool-use": "Driving tools & summarizing their output",
};

interface RouteTarget {
  provider: string;
  model: string;
}

type RoutingTable = Partial<Record<RouteLane, RouteTarget>>;

// Mirror of @ares/core classifyLane — the Tauri app is a standalone bundle, so
// the heuristic is duplicated here. Keep in sync with packages/core/modelRouter.
function classifyLaneUI(goal: string): RouteLane {
  const g = ` ${goal.toLowerCase()} `;
  const coding = /\b(code|coding|bug|debug|fix|refactor|function|class|method|implement|compile|build|stack ?trace|exception|typescript|javascript|python|rust|golang|api|endpoint|test|unit test|repo|git|commit|merge|lint|regex|sql|css|html|component|module|import|syntax)\b/;
  const research = /\b(research|plan|planning|analyz|investigat|compare|comparison|evaluate|assess|design|architect|strateg|explain|why|how does|trade-?off|pros and cons|summar|review|deep dive|explore|options)\b/;
  if (coding.test(g)) return "coding";
  if (research.test(g)) return "research";
  return "chat";
}

interface PendingRoute {
  lane: RouteLane;
  target: RouteTarget;
  goal: string;
  displayText: string;
  attachments: ChatAttachment[];
  webSearch: boolean;
}

interface VoiceOption {
  id: string;
  label: string;
  gender: "female" | "male";
  lang: string;
  accent: string;
  tier: string;
  character: string;
}

const SETTINGS_KEY = "ares.desktop.settings.v2";
const USAGE_KEY = "ares.desktop.modelUsage.v1";
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
  model("gpt-5.5", "Default frontier model", "frontier", "cloud", { capabilities: ["tools", "thinking"], description: "Frontier model through Ares's OpenAI Responses path." }),
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
    note: "Local daemon discovery plus cloud-capable model ids and Ares slot routing.",
    models: [...localOllamaModels, ...OLLAMA_CLOUD_MODELS],
  },
  {
    id: "openai",
    label: "OpenAI",
    note: "OpenAI Responses through the existing Ares auth path.",
    models: OPENAI_MODELS,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    note: "Paste your OpenRouter key, then pick from its live model catalog.",
    models: [],
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
  corners: "square",
  voiceId: "af_heart",
  voiceSpeed: 1.15,
};
// Empty by default → every lane uses Ares's heuristic router until the owner pins one.
const DEFAULT_ROUTING: RoutingTable = {};
const UI_DEV_MODE = import.meta.env.VITE_ARES_DEV === "1";
const VOICE_TTS_ENDPOINT = "ws://127.0.0.1:8765/tts";
const VOICE_HTTP_ENDPOINT = "http://127.0.0.1:8765/voices";
const STT_ENDPOINT = "ws://127.0.0.1:8765/stt";
const WEB_PREVIEW_BRIDGE_URL = import.meta.env.VITE_ARES_WEB_BRIDGE_URL ?? "http://127.0.0.1:1421";
const VOICE_PREVIEW_TEXT = "Systems online. Your new entity is ready when you are.";
// Flush speech in small, natural units so it is spoken as it streams rather than
// in one block at the end. A clause (comma/clause break) is enough to start; a
// sentence end always flushes. MIN keeps fragments from being absurdly short.
const VOICE_MIN_CHUNK_CHARS = 16;
const VOICE_SOFT_FLUSH_CHARS = 48;
const VOICE_HARD_FLUSH_CHARS = 100;

installWebPreviewBridge();

type PreviewTauriInternals = {
  invoke?: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  transformCallback?: (callback: (payload: unknown) => void, once?: boolean) => number;
  unregisterCallback?: (id: number) => void;
  runCallback?: (id: number, payload: unknown) => void;
  callbacks?: Record<number, (payload: unknown) => void>;
  convertFileSrc?: (filePath: string, protocol?: string) => string;
};

function installWebPreviewBridge() {
  if (typeof window === "undefined") return;
  const target = window as unknown as {
    __TAURI_INTERNALS__?: PreviewTauriInternals;
    __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: () => void };
  };
  if (typeof target.__TAURI_INTERNALS__?.invoke === "function") return;
  if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) return;

  let callbackId = 1;
  const callbacks: Record<number, (payload: unknown) => void> = {};
  target.__TAURI_INTERNALS__ = {
    callbacks,
    async invoke(cmd, args = {}) {
      const response = await fetch(`${WEB_PREVIEW_BRIDGE_URL}/invoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(String(payload?.error ?? `Preview bridge failed: HTTP ${response.status}`));
      }
      return payload.value;
    },
    transformCallback(callback, once) {
      const id = callbackId++;
      callbacks[id] = once
        ? (payload: unknown) => {
            callback(payload);
            delete callbacks[id];
          }
        : callback;
      return id;
    },
    unregisterCallback(id) {
      delete callbacks[id];
    },
    runCallback(id, payload) {
      callbacks[id]?.(payload);
    },
    convertFileSrc(filePath) {
      return `${WEB_PREVIEW_BRIDGE_URL}/file?path=${encodeURIComponent(filePath)}`;
    },
  };
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => null };
}

function App() {
  const initial = loadDesktopSettings();
  const [theme, setTheme] = useState<ThemeName>(initial.theme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(initial.appearance);
  const [routing, setRouting] = useState<RoutingTable>(initial.routing);
  const [pendingRoute, setPendingRoute] = useState<PendingRoute | null>(null);
  // Reduced-motion / low-power mode: stills all looping animation + the WebGL
  // scene. Driven by the OS preference or a "ares.nofx" flag (also lets headless
  // preview capture an idle frame).
  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      (window.localStorage.getItem("ares.nofx") === "1" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true),
    [],
  );
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
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [sttStatus, setSttStatus] = useState<SttStatus>("off");
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
  const [agentIdentity, setAgentIdentity] = useState<AresIdentity>({});
  const [usageByModel, setUsageByModel] = useState<Record<string, ModelUsage>>(loadModelUsage);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const selectionRef = useRef(selection);
  const lastEventSeqRef = useRef(0);
  const reasoningSyncTimerRef = useRef<number | null>(null);
  const reasoningSyncRef = useRef(reasoningSync);
  const voiceEnabledRef = useRef(voiceEnabled);
  const voiceSocketRef = useRef<WebSocket | null>(null);
  const voicePhraseBufferRef = useRef("");
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const voiceAudioQueueRef = useRef<string[]>([]);
  const voiceChunkIdRef = useRef(1);
  const voiceConnectTimerRef = useRef<number | null>(null);
  const voiceReconnectTimerRef = useRef<number | null>(null);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceOption[]>([]);
  // The WS callbacks close over this ref so chunks always ship the LATEST chosen
  // voice/speed, even though the socket was opened earlier.
  const voiceSettingsRef = useRef({ voice: appearance.voiceId, speed: appearance.voiceSpeed });
  const sttSocketRef = useRef<WebSocket | null>(null);
  const sttHoldingRef = useRef(false);
  const sttReconnectTimerRef = useRef<number | null>(null);

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

  // Live inner monologue — advisory cognition beats forwarded by the daemon as
  // { type: "lifecycle", event: { type: "thought", kind, text, confidence } }.
  const [mindThoughts, setMindThoughts] = useState<MindBeat[]>([]);
  const mindBeatSeqRef = useRef(0);
  const mindIdleClearRef = useRef<number | null>(null);
  // Containment Core presence — a side panel driven by live tool activity.
  const [coreActivity, setCoreActivity] = useState<CoreActivity | null>(null);
  const coreSeqRef = useRef(0);
  const coreClearRef = useRef<number | null>(null);
  useEffect(() => {
    if (mindThoughts.length === 0) return;
    if (mindIdleClearRef.current !== null) window.clearTimeout(mindIdleClearRef.current);
    mindIdleClearRef.current = window.setTimeout(() => setMindThoughts([]), 7000);
    return () => {
      if (mindIdleClearRef.current !== null) window.clearTimeout(mindIdleClearRef.current);
    };
  }, [mindThoughts]);

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
    voiceEnabledRef.current = voiceEnabled;
    if (voiceEnabled) {
      openVoiceSocket();
      void fetchVoiceCatalog();
    } else {
      closeVoiceSocket();
    }
  }, [voiceEnabled]);

  useEffect(() => {
    voiceSettingsRef.current = { voice: appearance.voiceId, speed: appearance.voiceSpeed };
  }, [appearance.voiceId, appearance.voiceSpeed]);

  useEffect(() => {
    void fetchVoiceCatalog();
  }, []);

  // Push-to-talk: keep the STT socket warm and bind global release/cancel + the
  // F9 hold-to-talk hotkey (works regardless of focus; no typing conflict).
  useEffect(() => {
    openSttSocket();
    const onMouseUp = () => stopListening();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "F9" && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        startListening();
      } else if (event.code === "Escape" && sttHoldingRef.current) {
        cancelListening();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "F9") {
        event.preventDefault();
        stopListening();
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      const socket = sttSocketRef.current;
      sttSocketRef.current = null;
      if (sttReconnectTimerRef.current !== null) window.clearTimeout(sttReconnectTimerRef.current);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (reasoningSyncTimerRef.current !== null) {
        window.clearTimeout(reasoningSyncTimerRef.current);
      }
      closeVoiceSocket();
    };
  }, []);

  useEffect(() => {
    saveDesktopSettings({ theme, selection, appearance, routing });
    if (hasNativeBridge()) void invoke("ares_set_theme", { name: theme }).catch(() => null);
  }, [theme, selection, appearance, routing]);

  // Push the owner's routing table to the daemon so the live turn uses it.
  useEffect(() => {
    if (hasNativeBridge()) void invoke("ares_set_routing", { routing }).catch(() => null);
  }, [routing]);

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
          invoke<boolean>("ares_dev_mode").catch(() => UI_DEV_MODE),
          invoke<OllamaDiscovery>("ares_ollama_models").catch((error: unknown) => ({
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
      const identity = await invoke<AresIdentity>("ares_agent_identity").catch(() => ({}));
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
        const events = await invoke<BufferedEvent[]>("ares_drain_events", { after: lastEventSeqRef.current });
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
        const stopListening = await listen<BufferedEvent>("ares:event-buffered", (event) => {
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

      invoke<DaemonStatus>("ares_start_daemon", daemonSelectionArgs(initial.selection))
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

  function toggleVoiceReplies() {
    setVoiceEnabled((enabled) => !enabled);
  }

  function openVoiceSocket() {
    const current = voiceSocketRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

    clearVoiceReconnectTimer();
    clearVoiceConnectTimer();
    setVoiceStatus("connecting");
    const socket = new WebSocket(VOICE_TTS_ENDPOINT);
    voiceSocketRef.current = socket;
    voiceConnectTimerRef.current = window.setTimeout(() => {
      if (voiceSocketRef.current !== socket || socket.readyState !== WebSocket.CONNECTING) return;
      setVoiceStatus("error");
      socket.close();
    }, 2500);

    socket.onopen = () => {
      if (voiceSocketRef.current !== socket) return;
      clearVoiceConnectTimer();
      setVoiceStatus(voiceAudioRef.current ? "speaking" : "ready");
      flushVoiceBuffer(false);
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      handleVoiceSocketMessage(event.data);
    };

    socket.onerror = () => {
      if (voiceSocketRef.current !== socket) return;
      clearVoiceConnectTimer();
      setVoiceStatus("error");
    };

    socket.onclose = () => {
      if (voiceSocketRef.current !== socket) return;
      clearVoiceConnectTimer();
      voiceSocketRef.current = null;
      if (voiceEnabledRef.current) {
        setVoiceStatus("error");
        scheduleVoiceReconnect();
      } else {
        setVoiceStatus("off");
      }
    };
  }

  function closeVoiceSocket() {
    clearVoiceReconnectTimer();
    clearVoiceConnectTimer();
    const socket = voiceSocketRef.current;
    voiceSocketRef.current = null;
    voicePhraseBufferRef.current = "";
    stopVoicePlayback(false);
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }
    setVoiceStatus("off");
  }

  function scheduleVoiceReconnect() {
    if (!voiceEnabledRef.current || voiceReconnectTimerRef.current !== null) return;
    voiceReconnectTimerRef.current = window.setTimeout(() => {
      voiceReconnectTimerRef.current = null;
      if (voiceEnabledRef.current) openVoiceSocket();
    }, 1800);
  }

  function clearVoiceConnectTimer() {
    if (voiceConnectTimerRef.current === null) return;
    window.clearTimeout(voiceConnectTimerRef.current);
    voiceConnectTimerRef.current = null;
  }

  function clearVoiceReconnectTimer() {
    if (voiceReconnectTimerRef.current === null) return;
    window.clearTimeout(voiceReconnectTimerRef.current);
    voiceReconnectTimerRef.current = null;
  }

  function handleVoiceSocketMessage(data: string) {
    let payload: VoiceServerEvent;
    try {
      payload = JSON.parse(data) as VoiceServerEvent;
    } catch {
      setVoiceStatus("error");
      return;
    }

    if (payload.type === "ready") {
      setVoiceStatus(voiceAudioRef.current ? "speaking" : "ready");
      flushVoiceBuffer(false);
      return;
    }

    if (payload.type === "audio" && payload.audio) {
      enqueueVoiceAudio(audioUrlFromBase64(payload.audio, payload.mime ?? "audio/wav"));
      return;
    }

    if (payload.type === "error") {
      setVoiceStatus("error");
    }
  }

  function feedVoiceText(text: string | undefined) {
    if (!voiceEnabledRef.current || !text) return;
    voicePhraseBufferRef.current += text;
    flushVoiceBuffer(false);
  }

  function flushVoiceBuffer(force: boolean) {
    const socket = voiceSocketRef.current;
    if (!voiceEnabledRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;

    for (let index = 0; index < 8; index += 1) {
      const next = takeVoiceChunk(voicePhraseBufferRef.current, force);
      if (!next) return;
      voicePhraseBufferRef.current = next.rest;
      sendVoiceChunk(next.chunk);
    }
  }

  function sendVoiceChunk(text: string) {
    const socket = voiceSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const clean = prepareVoiceText(text);
    if (!clean) return;
    const { voice, speed } = voiceSettingsRef.current;
    socket.send(JSON.stringify({
      type: "speak",
      id: `tts-${voiceChunkIdRef.current++}`,
      text: clean,
      voice,
      speed,
    }));
  }

  async function fetchVoiceCatalog() {
    try {
      const res = await fetch(VOICE_HTTP_ENDPOINT);
      if (!res.ok) return;
      const data = (await res.json()) as { voices?: VoiceOption[] };
      if (Array.isArray(data.voices) && data.voices.length) setVoiceCatalog(data.voices);
    } catch {
      // sidecar not up yet; the picker still works on reconnect.
    }
  }

  // Preview a voice without disturbing the chat: speak a fixed sample line. Uses
  // the live socket if open, else opens a throwaway one just for the audition.
  function previewVoice(voiceId: string) {
    const speed = voiceSettingsRef.current.speed;
    const payload = JSON.stringify({ type: "speak", id: `preview-${voiceChunkIdRef.current++}`, text: VOICE_PREVIEW_TEXT, voice: voiceId, speed });
    const socket = voiceSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      stopVoicePlayback();
      socket.send(payload);
      return;
    }
    const preview = new WebSocket(VOICE_TTS_ENDPOINT);
    preview.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as VoiceServerEvent;
      if (message.type === "audio" && message.audio) {
        const audio = new Audio(audioUrlFromBase64(message.audio, message.mime ?? "audio/wav"));
        void audio.play().catch(() => null);
      }
      if (message.type === "done") preview.close();
    };
    preview.onopen = () => preview.send(payload);
    window.setTimeout(() => preview.readyState === WebSocket.OPEN && preview.close(), 12000);
  }

  // ── Voice input (push-to-talk STT) — the mic is captured server-side by the
  // sidecar, so there's no WebView microphone-permission prompt. ──────────────
  function openSttSocket() {
    const current = sttSocketRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;
    if (sttReconnectTimerRef.current !== null) {
      window.clearTimeout(sttReconnectTimerRef.current);
      sttReconnectTimerRef.current = null;
    }
    const socket = new WebSocket(STT_ENDPOINT);
    sttSocketRef.current = socket;
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handleSttMessage(event.data);
    };
    socket.onerror = () => {
      if (sttSocketRef.current === socket) setSttStatus("error");
    };
    socket.onclose = () => {
      if (sttSocketRef.current !== socket) return;
      sttSocketRef.current = null;
      sttHoldingRef.current = false;
      setSttStatus("off");
      if (sttReconnectTimerRef.current === null) {
        sttReconnectTimerRef.current = window.setTimeout(() => {
          sttReconnectTimerRef.current = null;
          openSttSocket();
        }, 2500);
      }
    };
  }

  function handleSttMessage(data: string) {
    let payload: { type?: string; text?: string; available?: boolean };
    try {
      payload = JSON.parse(data) as typeof payload;
    } catch {
      return;
    }
    if (payload.type === "ready") setSttStatus(payload.available === false ? "error" : "ready");
    else if (payload.type === "listening") setSttStatus("listening");
    else if (payload.type === "transcribing") setSttStatus("transcribing");
    else if (payload.type === "transcript") {
      setSttStatus("ready");
      const text = (payload.text ?? "").trim();
      if (text) setMessage((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
    } else if (payload.type === "cancelled") setSttStatus("ready");
    else if (payload.type === "error") setSttStatus("error");
  }

  function startListening() {
    const socket = sttSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      openSttSocket();
      return;
    }
    if (sttHoldingRef.current) return;
    sttHoldingRef.current = true;
    if (voiceEnabledRef.current) stopVoicePlayback(); // barge-in + echo guard
    socket.send(JSON.stringify({ type: "listen_start" }));
  }

  function stopListening() {
    if (!sttHoldingRef.current) return;
    sttHoldingRef.current = false;
    const socket = sttSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "listen_stop" }));
  }

  function cancelListening() {
    if (!sttHoldingRef.current) return;
    sttHoldingRef.current = false;
    const socket = sttSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "listen_cancel" }));
  }

  function enqueueVoiceAudio(url: string) {
    voiceAudioQueueRef.current.push(url);
    playNextVoiceAudio();
  }

  function playNextVoiceAudio() {
    if (voiceAudioRef.current) return;
    const next = voiceAudioQueueRef.current.shift();
    if (!next) {
      setVoiceStatus(voiceEnabledRef.current && voiceSocketRef.current?.readyState === WebSocket.OPEN ? "ready" : voiceEnabledRef.current ? "connecting" : "off");
      return;
    }

    const audio = new Audio(next);
    voiceAudioRef.current = audio;
    setVoiceStatus("speaking");

    const cleanup = () => {
      if (voiceAudioRef.current === audio) voiceAudioRef.current = null;
      URL.revokeObjectURL(next);
      playNextVoiceAudio();
    };

    audio.onended = cleanup;
    audio.onerror = cleanup;
    void audio.play().catch(() => {
      setVoiceStatus("error");
      cleanup();
    });
  }

  function stopVoicePlayback(sendCancel = true) {
    voicePhraseBufferRef.current = "";
    for (const url of voiceAudioQueueRef.current) URL.revokeObjectURL(url);
    voiceAudioQueueRef.current = [];

    const audio = voiceAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      URL.revokeObjectURL(audio.src);
      voiceAudioRef.current = null;
    }

    const socket = voiceSocketRef.current;
    if (sendCancel && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "cancel" }));
    }
    setVoiceStatus(voiceEnabledRef.current && socket?.readyState === WebSocket.OPEN ? "ready" : voiceEnabledRef.current ? "connecting" : "off");
  }

  function appendToActiveSession(event: AresEvent) {
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

  function handleDaemonEvent(detail: AresEvent) {
    if (!detail) return;
    // Lifecycle envelopes drive pulses/status only. They are not chat lines.
    if (detail.type === "lifecycle" && detail.event) {
      const inner = detail.event;
      if (inner.gain && inner.gain.target && typeof inner.gain.delta === "number") {
        pushPulse(inner.type, inner.gain);
      }
      if (inner.type === "dream_phase_started") setStatus("dreaming");
      if (inner.type === "dream_phase_ended") setStatus("idle");
      if (inner.type === "thought") {
        const t = inner as { kind?: string; text?: string; phase?: string; confidence?: number };
        const beat: MindBeat = {
          id: `mb-${mindBeatSeqRef.current++}`,
          kind: t.kind ?? "observe",
          text: t.text ?? "",
          confidence: typeof t.confidence === "number" ? t.confidence : undefined,
        };
        setMindThoughts((prev) => (t.phase === "open" ? [beat] : [...prev, beat].slice(-10)));
      }
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
    if (detail.type === "turn_start") {
      stopVoicePlayback();
      setMindThoughts([]);
      if (coreClearRef.current !== null) {
        window.clearTimeout(coreClearRef.current);
        coreClearRef.current = null;
      }
      setCoreActivity(null);
    }
    if (detail.type === "text_delta") feedVoiceText(detail.text);
    if (detail.type === "turn_end") flushVoiceBuffer(true);
    // Containment Core presence: light up on tool activity, flash COMPLETED, vanish.
    if (detail.type === "tool_start" || (detail.type === "tool_call" && ["planning", "ready", "running"].includes(detail.status ?? ""))) {
      const label = detail.activityDescription || (detail.name ? `Running ${detail.name}` : "Working");
      if (coreClearRef.current !== null) {
        window.clearTimeout(coreClearRef.current);
        coreClearRef.current = null;
      }
      setCoreActivity({ id: `core-${coreSeqRef.current++}`, zone: zoneForActivity(detail.name, label), label, status: "active" });
    }
    if (detail.type === "turn_end") {
      setCoreActivity((cur) => (cur ? { ...cur, status: "completed", label: detail.status === "failed" ? "CONTAINMENT BREACH" : "COMPLETED" } : cur));
      if (coreClearRef.current !== null) window.clearTimeout(coreClearRef.current);
      coreClearRef.current = window.setTimeout(() => setCoreActivity(null), 2200);
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

  function recordModelUsage(usedSelection: Selection, usage: NonNullable<AresEvent["usage"]>) {
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

  async function dispatchSend(goal: string, displayText: string, atts: ChatAttachment[], webSearch: boolean) {
    if (voiceEnabledRef.current) stopVoicePlayback();
    appendToActiveSession({ type: "user_send", text: displayText, attachments: atts, webSearch });
    try {
      await invoke("ares_send", { goal });
    } catch (error) {
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: String(error) });
    }
  }

  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const cleanMessage = message.trim();
    const hasAttachments = attachments.length > 0;
    if ((!cleanMessage && !hasAttachments) || !running) return;
    const displayText = cleanMessage || "Inspect the attached image.";
    const atts = attachments;
    const webSearch = webSearchMode;
    const goal = buildOutgoingGoal(displayText, atts, webSearch);
    setMessage("");
    setAttachments([]);
    // ── live routing: does this task want a model other than what's running? ──
    const lane = classifyLaneUI(displayText);
    const target = routing[lane];
    if (target && (target.provider !== selection.provider || target.model !== selection.model)) {
      setPendingRoute({ lane, target, goal, displayText, attachments: atts, webSearch });
      return; // notify-and-confirm: wait for the owner's call
    }
    await dispatchSend(goal, displayText, atts, webSearch);
  }

  async function confirmRouteSwitch() {
    const pr = pendingRoute;
    if (!pr) return;
    setPendingRoute(null);
    if (providers.some((p) => p.id === pr.target.provider)) {
      await restartWith({ provider: pr.target.provider as ProviderId, model: pr.target.model });
    }
    await dispatchSend(pr.goal, pr.displayText, pr.attachments, pr.webSearch);
  }

  function keepCurrentRoute() {
    const pr = pendingRoute;
    if (!pr) return;
    setPendingRoute(null);
    void dispatchSend(pr.goal, pr.displayText, pr.attachments, pr.webSearch);
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
    void invoke("ares_set_reasoning", { level }).catch((error: unknown) => {
      markReasoningSync("error");
      appendToActiveSession({ type: "desktop_error", text: `Reasoning update failed: ${String(error)}` });
    });
  }

  function respondToPermission(id: string | undefined, decision: PermissionDecision) {
    if (!id || !hasNativeBridge()) return;
    void invoke("ares_permission_response", { id, decision }).catch((error: unknown) => {
      setStatus("error");
      appendToActiveSession({ type: "desktop_error", text: `Permission response failed: ${String(error)}` });
    });
  }

  async function restartWith(nextSelection = selection) {
    setDaemon("starting");
    setStatus("active");
    try {
      const state = await invoke<DaemonStatus>("ares_restart_daemon", daemonSelectionArgs(nextSelection));
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
    await invoke("ares_stop_daemon");
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
      className="ares-app"
      data-corners={appearance.corners}
      data-theme={theme}
      data-fx={reducedMotion ? "off" : "on"}
      data-native={hasNativeBridge() ? "1" : "0"}
      style={{
        "--glass-opacity": appearance.opacity,
        "--shell-radius": appearance.corners === "rounded" ? "38px" : "0px",
      } as React.CSSProperties}
    >
      <ThreeScene running={running} status={status} theme={theme} />
      <FxLayer status={status} running={running} />
      <ImageLightbox />
      <div className="commandHud" data-active={status === "active" ? "1" : "0"} aria-hidden="true" />
      <EvolutionPulseDeck pulses={pulses} />
      <AnimatePresence>
        {mindThoughts.length > 0 ? <MindPanel beats={mindThoughts} /> : null}
      </AnimatePresence>
      <AnimatePresence>
        {coreActivity ? <CorePanel activity={coreActivity} /> : null}
      </AnimatePresence>
      <Titlebar identity={agentIdentity} />
      <aside className="sidebar">
        <div className="brandBlock">
          <div className="brandMark" data-hot={running ? "1" : "0"}><AresAvatar identity={agentIdentity} /></div>
          <div>
            <strong>{cleanIdentityValue(agentIdentity.name) ?? "New entity"}</strong>
            <span>{running ? "daemon linked" : daemon}</span>
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
          <span>{root || "Desktop\\Ares Workspace"}</span>
        </div>
      </aside>

      <section className="workspace">
        <EntityRunner energy={running} busy={status === "active"} />
        <header className="workspaceTop" data-live={running ? "1" : "0"}>
          <div className="workspaceScan" aria-hidden="true" />
          <div className="workspaceHeading">
            <h1>{activeViewTitle(activeView)}</h1>
            <p>{selection.provider} / {selection.model}</p>
          </div>
          <div className="workspaceLive" data-on={running ? "1" : "0"} data-fault={daemon === "error" ? "1" : "0"}>
            <span className="workspaceLiveDot" data-on={running ? "1" : "0"} />
            <span className="workspaceLiveText">{running ? "online" : daemon === "error" ? "fault" : "standby"}</span>
          </div>
          <div className="modelDock">
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
            exit={{ opacity: 0, y: -6, filter: "blur(3px)" }}
            initial={{ opacity: 0, y: 7, filter: "blur(3px)" }}
            key={activeView}
            transition={{ duration: 0.24, ease: [0.16, 0.84, 0.24, 1] }}
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
                routing={routing}
                onRouting={setRouting}
                ollamaDiscovery={ollamaDiscovery}
                running={running}
                usageByModel={usageByModel}
              />
            ) : activeView === "mind" ? (
              <MindView
                appearance={appearance}
                events={events}
                onAppearance={setAppearance}
                onPreviewVoice={previewVoice}
                onTheme={setTheme}
                status={status}
                stats={stats}
                theme={theme}
                voiceCatalog={voiceCatalog}
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
                onPttStart={startListening}
                onPttStop={stopListening}
                onVoiceStop={() => stopVoicePlayback()}
                onVoiceToggle={toggleVoiceReplies}
                sttStatus={sttStatus}
                onWebSearchMode={setWebSearchMode}
                refEl={transcriptRef}
                running={running}
                stats={stats}
                status={status}
                liveActivity={liveActivity}
                voiceEnabled={voiceEnabled}
                voiceStatus={voiceStatus}
                webSearchMode={webSearchMode}
                reasoningLevel={reasoningLevel}
                onReasoning={changeReasoning}
                reasoningSync={reasoningSync}
                routing={routing}
                onRouting={setRouting}
                providers={providers}
                selection={selection}
                draftSelection={draftSelection}
                onProvider={updateDraftProvider}
                onModel={updateDraftModel}
                onApply={() => restartWith({ ...draftSelection, model: draftSelection.model === "__custom" ? customModel : draftSelection.model })}
                voiceId={appearance.voiceId}
                voiceSpeed={appearance.voiceSpeed}
                voiceCatalog={voiceCatalog}
                onVoice={(id) => setAppearance({ ...appearance, voiceId: id })}
                onSpeed={(speed) => setAppearance({ ...appearance, voiceSpeed: speed })}
                onPreviewVoice={previewVoice}
                pendingRoute={pendingRoute}
                onConfirmRoute={confirmRouteSwitch}
                onKeepRoute={keepCurrentRoute}
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
              transition={{ type: "spring", stiffness: 560, damping: 30, mass: 0.6 }}
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
      return { key: 0xc46bff, rim: 0x2dffb0, fog: 0x0c0018, glass: 0xc88cff, emissive: 0x6a00b0, accent: 0x2dffb0, core: 0xbfffe8, dust: 0xa97bff };
    case "storm":
      return { key: 0x8fc6ff, rim: 0x4ff0ff, fog: 0x040e28, glass: 0xd6ecff, emissive: 0x1f74ff, accent: 0xffe94f, core: 0xf2faff, dust: 0x9cc8ff };
    case "graphite":
      return { key: 0xe4ecff, rim: 0x7fa8d8, fog: 0x070910, glass: 0xcdd6e4, emissive: 0x3a4a78, accent: 0x8fb6ff, core: 0xeaf0ff, dust: 0xaab8d0 };
    case "oxide":
      return { key: 0xffd9a8, rim: 0xff8a4c, fog: 0x120804, glass: 0xffc59a, emissive: 0x9a3a0c, accent: 0xff7a3c, core: 0xfff0d8, dust: 0xffb070 };
    default: // signal / Frost — clean cool world, warm-amber accent for contrast
      return { key: 0xffffff, rim: 0x5ea8ff, fog: 0x08131f, glass: 0xcfe8ff, emissive: 0x1556c4, accent: 0xff9d3c, core: 0xeafff9, dust: 0x8fd0ff };
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
  // daemon is running and whether Ares is actively thinking/streaming/tooling.
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
    // Escape hatch: skip the WebGL scene for low-power mode, reduced-motion
    // preference, or headless preview/screenshot capture (which hangs on GPU
    // readback from a live render loop).
    const fxDisabled =
      typeof window !== "undefined" &&
      (window.localStorage.getItem("ares.nofx") === "1" ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    if (fxDisabled) return;
    const mode: SceneMode = theme;
    const palette = scenePalette(mode);
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      canvas,
      powerPreference: "high-performance",
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(palette.fog, 0.022);
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
    // Per-theme motion mood — Frost calm, Storm turbulent, Matrix fast-scroll.
    const moodByMode: Record<string, { idle: number; spin: number; grid: number; sway: number }> = {
      signal: { idle: 0.40, spin: 0.0030, grid: 0.42, sway: 0.10 },
      storm: { idle: 0.50, spin: 0.0052, grid: 0.78, sway: 0.18 },
      matrix: { idle: 0.46, spin: 0.0046, grid: 0.95, sway: 0.13 },
      graphite: { idle: 0.42, spin: 0.0040, grid: 0.50, sway: 0.11 },
      oxide: { idle: 0.44, spin: 0.0042, grid: 0.58, sway: 0.12 },
    };
    const mood = moodByMode[mode] ?? moodByMode.signal;
    let energy = runningRef.current ? 0.72 : mood.idle;
    const animate = () => {
      // Skip rendering while the window is hidden — no point burning GPU/CPU on
      // an invisible WebGL scene (keeps the UI responsive when backgrounded).
      if (typeof document !== "undefined" && document.hidden) {
        raf = window.requestAnimationFrame(animate);
        return;
      }
      // Energy ramps smoothly toward its target, so the scene SURGES when Ares
      // starts thinking/streaming and settles when it goes idle — never snaps.
      const active = statusRef.current === "active";
      const targetEnergy = runningRef.current ? (active ? 1.0 : 0.72) : active ? 0.62 : mood.idle;
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

      root.rotation.y += mood.spin + energy * 0.006;
      root.rotation.x = leanY * 0.7 + Math.sin(frame * 0.6) * (0.07 * (mood.sway / 0.1));
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
      const gridScroll = (frame * 0.5 * mood.grid) % 1;
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
  const count = 760;
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
  const count = 520;
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

function AresAvatar({ identity }: { identity?: AresIdentity }) {
  const avatar = cleanIdentityValue(identity?.avatar);
  if (avatar && isImageAvatar(avatar)) {
    return <img alt="" className="aresAvatarImage" src={avatarToSrc(avatar)} />;
  }
  if (avatar && isTextAvatar(avatar)) {
    return <span className="aresAvatarText">{avatar}</span>;
  }
  return <AresGlyph />;
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

function AresGlyph() {
  return (
    <svg className="aresGlyph" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="aresGlyphMain" x1="14" x2="52" y1="10" y2="56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5EA8FF" />
          <stop offset="0.46" stopColor="#70F0D2" />
          <stop offset="1" stopColor="#FFD07A" />
        </linearGradient>
        <linearGradient id="aresGlyphGlass" x1="12" x2="48" y1="8" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.95" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <path className="aresGlyphCore" d="M15 19.5C15 13.7 19.7 9 25.5 9h13C49.3 9 58 17.7 58 28.5S49.3 48 38.5 48H26.8l-9.4 7.4c-1.3 1-3.2.1-3.2-1.5v-8.2C9.2 42.5 6 36.9 6 30.5C6 24.4 9.9 19.5 15 19.5Z" />
      <path className="aresGlyphGlass" d="M17 21.5C17 15.9 21.5 11.4 27.1 11.4h10.5c9.6 0 17.4 7.8 17.4 17.4S47.2 46.2 37.6 46.2H27.4l-7.7 6v-8.4l-1-.6C13.6 40.4 10.4 35.2 10.4 29.4c0-4.5 2.8-7.9 6.6-7.9Z" />
      <path className="aresGlyphTrace" d="M22 29.3c1.4-6.5 7.2-10.8 14.1-10.2 6.8.6 11.7 5.7 12.2 12.2" />
      <path className="aresGlyphTrace secondary" d="M41.7 37.4c-2.2 2.1-5.2 3.3-8.7 3.1-5.2-.2-9.5-3.4-11.1-7.9" />
      <circle className="aresGlyphDot" cx="25" cy="31" r="2.4" />
      <circle className="aresGlyphDot" cx="39" cy="31" r="2.4" />
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

function Titlebar({ identity }: { identity: AresIdentity }) {
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebarBrand" data-tauri-drag-region>
        <span className="titlebarSigil"><AresAvatar identity={identity} /></span>
        <span className="titlebarName">Ares</span>
      </div>
      <div className="windowButtons">
        <button title="Minimize" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("ares_window_minimize")}><Minus size={14} /></button>
        <button title="Maximize" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("ares_window_toggle_maximize")}><Square size={12} /></button>
        <button title="Close" type="button" onMouseDown={stopDragEvent} onClick={runWindowCommand("ares_window_close")}><X size={15} /></button>
      </div>
    </div>
  );
}

// ── The entity: an autonomous, draggable 2D creature that lives on the header.
// It is NOT on a fixed track — a tiny behavior brain (steering + a weighted
// decision loop) makes it wander, idle, pull off parkour tricks, and — when
// your cursor strays into its turf — chase it down, leap, grab it, and hang on
// tugging. Grab IT with the mouse and it dangles from your pointer; let go and
// it falls (gravity) and carries on. `energy` (daemon live) just makes it
// friskier — it roams either way.
type RunnerPose = "idle" | "run" | "jump" | "flip" | "roll" | "slide" | "punch" | "sit" | "work";
type RunnerMode = "idle" | "wander" | "trick" | "roll" | "chase" | "grab" | "held" | "fall" | "sit" | "work";

const FLOOR = 1; // y of the header floor (0 = top ledge)
const ENTITY_KEY = "ares.entity.v1";

// ── Sprite-sheet engine config ──────────────────────────────────────────────
// Drop a sheet at tauri/public/entity.png and set the grid below. Until then,
// the engine auto-falls back to the CSS creature (the app keeps working).
//
// HOW TO CONFIGURE after you add your sheet:
//   • frameW/frameH = pixel size of ONE frame cell
//   • cols          = how many frame columns the sheet has
//   • displayH      = on-screen height in px (width scales to keep the frame ratio)
//   • clips         = for each action: { row (0-based), from (first col), count, fps }
//     Map your sheet's rows to: idle / walk / jump / roll / attack / sit.
interface SheetClip { row: number; from: number; count: number; fps: number; }
interface SheetConfig {
  src: string;
  frameW: number;
  frameH: number;
  cols: number;
  displayH: number;
  clips: Record<"idle" | "walk" | "jump" | "roll" | "attack" | "sit", SheetClip>;
}
const ENTITY_SHEET: SheetConfig = {
  src: "/entity.png",
  frameW: 32,
  frameH: 32,
  cols: 7,
  displayH: 34,
  clips: {
    idle: { row: 0, from: 0, count: 1, fps: 4 },
    walk: { row: 1, from: 0, count: 7, fps: 12 },
    jump: { row: 2, from: 0, count: 3, fps: 9 },
    roll: { row: 3, from: 0, count: 6, fps: 16 },
    attack: { row: 4, from: 0, count: 5, fps: 16 },
    sit: { row: 0, from: 0, count: 1, fps: 2 },
  },
};
type ClipName = keyof SheetConfig["clips"];
function poseToClip(pose: RunnerPose): ClipName {
  switch (pose) {
    case "run": return "walk";
    case "jump":
    case "flip": return "jump";
    case "roll":
    case "slide": return "roll";
    case "punch":
    case "work": return "attack";
    case "sit": return "sit";
    case "idle":
    default: return "idle";
  }
}

function EntityRunner({ energy, busy }: { energy: boolean; busy: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const spriteRef = useRef<HTMLDivElement>(null);
  const tetherRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [pose, setPose] = useState<RunnerPose>("idle");
  const [sheetReady, setSheetReady] = useState(false);
  const sheetReadyRef = useRef(false);
  const frameAnim = useRef({ clip: "idle" as ClipName, idx: 0, acc: 0 });

  // Mutable agent state — kept in a ref so the rAF loop never re-renders.
  const A = useRef({
    x: 0.88, y: FLOOR, vx: 0, vy: 0,
    mode: "idle" as RunnerMode, t: 0, dur: 1000,
    target: 0.88, rot: 0, face: 1, spin: 0, airborne: false,
    combo: 0, boredom: 0,
  });
  const cursor = useRef({ x: 0.5, y: 0.5, inside: false });
  const heldRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const draw = (ts: number) => {
    const stage = stageRef.current;
    const sprite = spriteRef.current;
    if (!stage || !sprite) return;
    const w = stage.clientWidth - 24;
    const h = stage.clientHeight - 28;
    const a = A.current;
    const px = Math.max(0, Math.min(1, a.x)) * w;
    let py = Math.max(0, Math.min(1, a.y)) * h;
    // per-stride bob so running/working reads as steps, not a glide
    if ((a.mode === "wander" || a.mode === "chase") && !a.airborne) {
      py -= Math.abs(Math.sin(ts / 90)) * 3.2;
    }
    sprite.style.transform = `translate(${px}px, ${py}px) rotate(${a.rot}deg) scaleX(${a.face})`;
    const tether = tetherRef.current;
    if (tether) {
      if (a.mode === "grab") {
        const cx = cursor.current.x * w, cy = cursor.current.y * h;
        const dx = cx - px, dy = cy - py;
        tether.style.opacity = "1";
        tether.style.width = `${Math.hypot(dx, dy)}px`;
        tether.style.transform = `translate(${px + 11}px, ${py + 6}px) rotate(${Math.atan2(dy, dx)}rad)`;
      } else {
        tether.style.opacity = "0";
      }
    }
  };

  const setMode = (m: RunnerMode, dur: number) => {
    const a = A.current;
    a.mode = m; a.t = 0; a.dur = dur; a.spin = 0;
  };

  // launch one trick: half the time a backflip arc, half a ground roll
  const startTrick = () => {
    const a = A.current;
    if (Math.random() < 0.55) {
      a.target = Math.max(0.08, Math.min(0.92, a.x + (Math.random() - 0.5) * 0.55));
      setMode("trick", 720);
      a.vy = -2.9; a.vx = (a.target - a.x) * 1.6; a.airborne = true;
      a.spin = a.vx < 0 ? 360 : -360;
    } else {
      const dir = Math.random() < 0.5 ? -1 : 1;
      a.target = Math.max(0.08, Math.min(0.92, a.x + dir * (0.3 + Math.random() * 0.3)));
      setMode("roll", 620);
      a.vx = dir * 1.1; a.spin = dir * 560;
    }
  };

  const think = () => {
    const a = A.current;
    const c = cursor.current;
    // tools are working → go home and "work" (the seed of the containment core)
    if (busyRef.current && Math.random() < 0.72) {
      a.target = 0.86; setMode("work", 1600 + Math.random() * 1800); a.boredom = 0; return;
    }
    // cursor in the den → hunt it
    if (c.inside) {
      const home = Math.abs(c.x - 0.88) < 0.25;
      if (home || Math.random() < (energy ? 0.66 : 0.4)) { setMode("chase", 4500); a.boredom = 0; return; }
    }
    const r = Math.random();
    if (a.boredom > 4 && r < 0.5) { setMode("sit", 1800 + Math.random() * 1800); a.boredom = 0; return; }
    if (r < 0.26) { setMode("idle", 700 + Math.random() * 1100); a.boredom++; }
    else if (r < 0.56) { a.target = 0.08 + Math.random() * 0.84; setMode("wander", 3200); a.boredom = 0; }
    else if (r < 0.68) { setMode("sit", 1300 + Math.random() * 1400); a.boredom = 0; } // occasional chill
    else { a.combo = energy ? 2 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2); a.boredom = 0; startTrick(); } // show off
  };

  // probe for the sprite sheet; upgrade from the CSS creature if it's present
  useEffect(() => {
    const img = new Image();
    img.onload = () => { sheetReadyRef.current = true; setSheetReady(true); };
    img.onerror = () => { sheetReadyRef.current = false; setSheetReady(false); };
    img.src = ENTITY_SHEET.src;
  }, []);

  // restore last known position
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(ENTITY_KEY) || "{}");
      if (typeof s.x === "number") A.current.x = Math.max(0, Math.min(1, s.x));
    } catch { /* ignore */ }
    const id = window.setInterval(() => {
      try { localStorage.setItem(ENTITY_KEY, JSON.stringify({ x: A.current.x })); } catch { /* ignore */ }
    }, 4000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width;
      const ny = (e.clientY - r.top) / r.height;
      cursor.current.inside = nx >= -0.05 && nx <= 1.05 && ny >= -0.2 && ny <= 1.4;
      cursor.current.x = Math.max(0, Math.min(1, nx));
      cursor.current.y = Math.max(0, Math.min(1, ny));
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    let raf = 0, last = 0;
    let curPose: RunnerPose = "idle";
    const G = 9.5;       // gravity (norm/s²)
    const RUN = 0.34;    // run speed (norm/s) — slow enough that strides read

    const nextTrickOrThink = () => {
      const a = A.current;
      if (a.combo > 0) { a.combo--; startTrick(); } else think();
    };

    const step = (ts: number) => {
      if (!last) last = ts;
      const dt = Math.min(0.048, (ts - last) / 1000);
      last = ts;
      const a = A.current;
      const c = cursor.current;
      let nextPose: RunnerPose = "idle";

      if (heldRef.current) {
        a.x += (c.x - a.x) * Math.min(1, dt * 16);
        a.y += (c.y + 0.12 - a.y) * Math.min(1, dt * 16);
        a.rot = Math.sin(ts / 80) * 14;
        a.airborne = true; a.vy = 0;
        nextPose = "punch";
      } else {
        a.t += dt * 1000;
        switch (a.mode) {
          case "idle": { a.vx = 0; if (a.t > a.dur) think(); nextPose = "idle"; break; }
          case "sit": { a.vx = 0; if (a.t > a.dur) think(); nextPose = "sit"; break; }
          case "work": {
            // walk to the den, then hammer away
            const dx = a.target - a.x;
            if (Math.abs(dx) > 0.02) { a.vx = Math.sign(dx) * RUN; a.x += a.vx * dt; a.face = a.vx < 0 ? -1 : 1; nextPose = "run"; }
            else { a.vx = 0; a.face = 1; nextPose = "work"; }
            if (a.t > a.dur) think();
            break;
          }
          case "wander": {
            const dx = a.target - a.x;
            a.vx = Math.sign(dx) * RUN; a.x += a.vx * dt; a.face = a.vx < 0 ? -1 : 1;
            if (Math.abs(dx) < 0.02 || a.t > a.dur) think();
            nextPose = "run"; break;
          }
          case "trick": {
            a.vy += G * dt; a.x += a.vx * dt; a.y += a.vy * dt;
            a.face = a.vx < 0 ? -1 : 1; a.rot = (a.rot + a.spin * dt) % 360;
            nextPose = "flip";
            if (a.y >= FLOOR) { a.y = FLOOR; a.vy = 0; a.airborne = false; a.rot = 0; nextTrickOrThink(); }
            break;
          }
          case "roll": {
            a.x += a.vx * dt; a.rot = (a.rot + a.spin * dt) % 360; a.face = a.vx < 0 ? -1 : 1;
            nextPose = "roll";
            if (a.t > a.dur || a.x <= 0.04 || a.x >= 0.96) { a.rot = 0; nextTrickOrThink(); }
            break;
          }
          case "chase": {
            const dx = c.x - a.x;
            a.vx = Math.sign(dx) * RUN * 1.6; a.x += a.vx * dt; a.face = a.vx < 0 ? -1 : 1;
            a.y += (Math.min(FLOOR, c.y) - a.y) * Math.min(1, dt * 4);
            const near = Math.hypot(c.x - a.x, c.y - a.y);
            nextPose = "run";
            if (!c.inside || a.t > a.dur) setMode("fall", 0);
            else if (near < 0.07) setMode("grab", 1600 + Math.random() * 1800);
            break;
          }
          case "grab": {
            // latched on → PUNCH the cursor, lunging with each jab
            const jab = Math.sin(ts / 55);
            a.x += (c.x - 0.02 * a.face - a.x) * Math.min(1, dt * 13) + jab * 0.004;
            a.y += (c.y + 0.08 - a.y) * Math.min(1, dt * 13);
            a.face = c.x < a.x ? -1 : 1;
            a.rot = jab * 8;
            nextPose = "punch";
            if (!c.inside || a.t > a.dur) { a.rot = 0; setMode("fall", 0); a.vy = -1.2; }
            break;
          }
          case "fall": {
            a.vy += G * dt; a.y += a.vy * dt; a.x += a.vx * dt; a.rot *= 0.9;
            nextPose = "jump";
            if (a.y >= FLOOR) { a.y = FLOOR; a.vy = 0; a.vx = 0; a.rot = 0; think(); }
            break;
          }
        }
      }

      a.x = Math.max(0, Math.min(1, a.x));
      a.y = Math.max(0, Math.min(1, a.y));
      draw(ts);
      if (curPose !== nextPose) { curPose = nextPose; setPose(nextPose); }

      // advance the sprite-sheet frame for the active clip
      if (sheetReadyRef.current) {
        const clipName = poseToClip(nextPose);
        const fa = frameAnim.current;
        if (fa.clip !== clipName) { fa.clip = clipName; fa.idx = 0; fa.acc = 0; }
        const clip = ENTITY_SHEET.clips[clipName];
        fa.acc += dt;
        if (fa.acc >= 1 / clip.fps) { fa.acc = 0; fa.idx = (fa.idx + 1) % Math.max(1, clip.count); }
        const frame = frameRef.current;
        if (frame) {
          const scale = ENTITY_SHEET.displayH / ENTITY_SHEET.frameH;
          const col = clip.from + fa.idx;
          frame.style.backgroundPosition = `${-col * ENTITY_SHEET.frameW * scale}px ${-clip.row * ENTITY_SHEET.frameH * scale}px`;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [energy]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    heldRef.current = true;
    setPose("punch");
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!heldRef.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    cursor.current.x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    cursor.current.y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
  };
  const onPointerUp = () => {
    if (!heldRef.current) return;
    heldRef.current = false;
    const a = A.current;
    a.mode = "fall"; a.t = 0; a.dur = 0; a.vy = -0.6; a.vx = 0;
  };

  return (
    <div className="entityStage" ref={stageRef} aria-hidden="true">
      <div className="entityTether" ref={tetherRef} />
      <div
        className={sheetReady ? "entityRunner sheetMode" : "entityRunner"}
        ref={spriteRef}
        data-pose={pose}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {sheetReady ? (
          <div
            className="entitySheet"
            ref={frameRef}
            style={{
              width: `${ENTITY_SHEET.frameW * (ENTITY_SHEET.displayH / ENTITY_SHEET.frameH)}px`,
              height: `${ENTITY_SHEET.displayH}px`,
              backgroundImage: `url(${ENTITY_SHEET.src})`,
              backgroundSize: `${ENTITY_SHEET.cols * ENTITY_SHEET.frameW * (ENTITY_SHEET.displayH / ENTITY_SHEET.frameH)}px auto`,
            }}
          />
        ) : (
          <>
            <span className="erShadow" />
            <span className="erArms"><i /><i /></span>
            <span className="erBody"><i className="erEye" /></span>
            <span className="erLegs"><i /><i /></span>
          </>
        )}
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
  onPttStart,
  onPttStop,
  onSend,
  onVoiceStop,
  onVoiceToggle,
  onWebSearchMode,
  refEl,
  running,
  stats,
  status,
  liveActivity,
  sttStatus,
  voiceEnabled,
  voiceStatus,
  webSearchMode,
  reasoningLevel,
  onReasoning,
  reasoningSync,
  routing,
  onRouting,
  providers,
  selection,
  draftSelection,
  onProvider,
  onModel,
  onApply,
  voiceId,
  voiceSpeed,
  voiceCatalog,
  onVoice,
  onSpeed,
  onPreviewVoice,
  pendingRoute,
  onConfirmRoute,
  onKeepRoute,
}: {
  attachments: ChatAttachment[];
  daemon: DaemonState;
  events: AresEvent[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  message: string;
  onAttachmentFiles: (files: FileList | File[]) => void;
  onAttachmentRemove: (id: string) => void;
  onMessage: (value: string) => void;
  onPermissionDecision: (id: string | undefined, decision: PermissionDecision) => void;
  onSend: (event: React.FormEvent) => void;
  onPttStart: () => void;
  onPttStop: () => void;
  onVoiceStop: () => void;
  onVoiceToggle: () => void;
  onWebSearchMode: (value: boolean) => void;
  refEl: React.RefObject<HTMLDivElement | null>;
  running: boolean;
  stats: ReturnType<typeof collectStats>;
  status: HeartbeatStatus;
  liveActivity: LiveActivity;
  sttStatus: SttStatus;
  voiceEnabled: boolean;
  voiceStatus: VoiceStatus;
  webSearchMode: boolean;
  reasoningLevel: ReasoningLevel;
  onReasoning: (level: ReasoningLevel) => void;
  reasoningSync: ReasoningSync;
  routing: RoutingTable;
  onRouting: (next: RoutingTable) => void;
  providers: ProviderOption[];
  selection: Selection;
  draftSelection: Selection;
  onProvider: (value: ProviderId) => void;
  onModel: (value: string) => void;
  onApply: () => void;
  voiceId: string;
  voiceSpeed: number;
  voiceCatalog: VoiceOption[];
  onVoice: (id: string) => void;
  onSpeed: (speed: number) => void;
  onPreviewVoice: (id: string) => void;
  pendingRoute: PendingRoute | null;
  onConfirmRoute: () => void;
  onKeepRoute: () => void;
}) {
  // Filter + clip once per events-change, not on every render (status/activity
  // ticks re-render ChatView constantly during a turn).
  const { chatEvents, visibleEvents, clippedCount } = useMemo(() => {
    const all = events.filter(isChatVisibleEvent);
    // Drop orphaned empty "Thinking" rows (turn_start seeds one; if a tool/text
    // lands before any thinking_delta it's left blank) — keep one only if it's
    // the last event (the live "thinking…" indicator).
    const ce = all.filter((e, i) =>
      !(e.type === "thinking_stream" && !(e.text && e.text.trim()) && i !== all.length - 1),
    );
    const clipped = Math.max(0, ce.length - 90);
    return { chatEvents: ce, visibleEvents: clipped > 0 ? ce.slice(-90) : ce, clippedCount: clipped };
  }, [events]);
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
                key={eventKey(event, index)}
                onPermissionDecision={onPermissionDecision}
              />
            ))}
          </>
        )}
      </div>
      <form className="composerBar" onSubmit={onSend}>
        {pendingRoute ? (
          <div className="routeSuggest">
            <span className="routeSuggestText">
              <strong>{ROUTE_LANE_LABELS[pendingRoute.lane]} task</strong>
              {providers.some((p) => p.id === pendingRoute.target.provider)
                ? <> — switch to <em>{pendingRoute.target.provider} / {pendingRoute.target.model}</em>?</>
                : <> — pinned to <em>{pendingRoute.target.provider} / {pendingRoute.target.model}</em> (not available yet)</>}
            </span>
            <span className="routeSuggestActions">
              {providers.some((p) => p.id === pendingRoute.target.provider) ? (
                <button type="button" className="routeSwitch" onClick={onConfirmRoute}>Switch &amp; send</button>
              ) : null}
              <button type="button" className="routeKeep" onClick={onKeepRoute}>Send on current</button>
            </span>
          </div>
        ) : null}
        <OptionsBar
          dropUp
          reasoningLevel={reasoningLevel}
          onReasoning={onReasoning}
          reasoningSync={reasoningSync}
          routing={routing}
          onRouting={onRouting}
          providers={providers}
          selection={selection}
          draftSelection={draftSelection}
          onProvider={onProvider}
          onModel={onModel}
          onApply={onApply}
          running={running}
          voiceId={voiceId}
          voiceSpeed={voiceSpeed}
          voiceCatalog={voiceCatalog}
          onVoice={onVoice}
          onSpeed={onSpeed}
          onPreviewVoice={onPreviewVoice}
        />
        {(webSearchMode || (voiceEnabled && voiceStatus !== "off") || sttStatus === "listening" || sttStatus === "transcribing") ? (
          <div className="composerTools">
            {webSearchMode ? <StatusPill label="Web" value="on" tone="ok" /> : null}
            {voiceEnabled && voiceStatus !== "off" ? (
              <StatusPill
                label="Voice"
                value={voiceStatusLabel(voiceStatus)}
                tone={voiceStatus === "error" ? "bad" : voiceStatus === "ready" || voiceStatus === "speaking" ? "ok" : "warn"}
              />
            ) : null}
            {sttStatus === "listening" || sttStatus === "transcribing" ? (
              <StatusPill label="Mic" value={sttStatus} tone="ok" />
            ) : null}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <AttachmentTray attachments={attachments} onRemove={onAttachmentRemove} />
        ) : null}
        {liveActivity.tone !== "idle" ? <LiveActivityStrip activity={liveActivity} /> : null}
        <div className="composerInput">
          <div className={voiceEnabled ? "composerIconCluster voiceCluster" : "composerIconCluster"}>
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
            <button
              aria-pressed={sttStatus === "listening"}
              className={`composerIconButton ptt-${sttStatus}${sttStatus === "listening" ? " active" : ""}`}
              disabled={sttStatus === "off" || sttStatus === "error"}
              onMouseDown={(event) => { event.preventDefault(); onPttStart(); }}
              onMouseUp={onPttStop}
              title={sttStatus === "off" || sttStatus === "error" ? "Voice input offline — start the voice sidecar (pnpm voice:tts)" : "Hold to talk (or hold F9)"}
              type="button"
            >
              {sttStatus === "off" || sttStatus === "error" ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              aria-pressed={voiceEnabled}
              className={voiceEnabled ? `composerIconButton active voice-${voiceStatus}` : "composerIconButton"}
              onClick={onVoiceToggle}
              title={voiceEnabled ? "Disable spoken replies" : "Enable spoken replies"}
              type="button"
            >
              {voiceEnabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
            </button>
            {voiceEnabled ? (
              <button
                className="composerIconButton voiceStopButton"
                disabled={voiceStatus === "off"}
                onClick={onVoiceStop}
                title="Stop spoken reply"
                type="button"
              >
                <Square size={14} />
              </button>
            ) : null}
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
            placeholder="Message your entity..."
            rows={1}
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

// OpenRouter: paste a key, load the live catalog, pick a model. The key is sent
// to the daemon (persisted to ui.json) and used as Bearer auth; the model list
// comes from OpenRouter's public /models endpoint (fetched in-webview).
interface OpenRouterModelRow { id: string; name: string; context?: number; price?: string }
function OpenRouterPanel({
  draftSelection,
  onPick,
  onApply,
  running,
}: {
  draftSelection: Selection;
  onPick: (modelId: string) => void;
  onApply: () => void;
  running: boolean;
}) {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<OpenRouterModelRow[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "loaded">("idle");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const loadModels = async (withKey?: string) => {
    setStatus("loading");
    setError("");
    try {
      const headers: Record<string, string> = {};
      if (withKey) headers.Authorization = `Bearer ${withKey}`;
      const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const rows: OpenRouterModelRow[] = (Array.isArray(json.data) ? json.data : []).map((r: Record<string, unknown>) => ({
        id: String(r.id),
        name: typeof r.name === "string" ? r.name : String(r.id),
        context: typeof r.context_length === "number" ? r.context_length : undefined,
        price: typeof (r.pricing as Record<string, unknown> | undefined)?.prompt === "string" ? String((r.pricing as Record<string, unknown>).prompt) : undefined,
      }));
      rows.sort((a, b) => a.id.localeCompare(b.id));
      setModels(rows);
      setStatus("loaded");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveKey = async () => {
    const trimmed = key.trim();
    try {
      if (hasNativeBridge()) await invoke("ares_set_openrouter_key", { key: trimmed, model: draftSelection.model });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
      void loadModels(trimmed || undefined);
    } catch {
      setStatus("error");
      setError("Could not save key to the daemon.");
    }
  };

  const shown = filter.trim()
    ? models.filter((m) => (m.id + " " + m.name).toLowerCase().includes(filter.trim().toLowerCase()))
    : models;

  return (
    <section className="orPanel">
      <div className="orKeyRow">
        <label>
          <span>OpenRouter API key</span>
          <input
            type="password"
            value={key}
            placeholder="sk-or-…  (stored locally, sent only to OpenRouter)"
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void saveKey(); }}
          />
        </label>
        <button type="button" className="primaryAction" onClick={() => void saveKey()}>
          {saved ? <><Check size={15} /> Saved</> : "Save key"}
        </button>
      </div>
      <div className="orCatalogHead">
        <input className="orFilter" value={filter} placeholder="Filter models…" onChange={(e) => setFilter(e.target.value)} />
        <span className="orCount">
          {status === "loading" ? "Loading…" : status === "error" ? `Error: ${error}` : `${shown.length} models`}
        </span>
        <button type="button" className="iconAction" title="Reload catalog" onClick={() => void loadModels(key.trim() || undefined)}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="orList">
        {shown.slice(0, 400).map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === draftSelection.model ? "orModel selected" : "orModel"}
            onClick={() => onPick(m.id)}
          >
            <span className="orModelMain">
              <strong>{m.id}</strong>
              <small>{m.name}{m.context ? ` · ${Math.round(m.context / 1000)}k ctx` : ""}</small>
            </span>
            {m.id === draftSelection.model ? <Check size={15} /> : null}
          </button>
        ))}
        {status === "loaded" && shown.length === 0 ? <div className="orEmpty">No models match.</div> : null}
      </div>
      <div className="orApplyRow">
        <span className="orSelected">{draftSelection.model || "no model selected"}</span>
        <button className="primaryAction" type="button" onClick={onApply}>
          <Play size={15} /> {running ? "Restart with model" : "Start with model"}
        </button>
      </div>
    </section>
  );
}

// The owner-facing routing pills: one labeled pill per task lane. Each shows
// its current target (or "Auto" → heuristic router) and expands to assign a
// provider + model. Writing here flows to localStorage + the daemon, and the
// live turn resolves the route via @ares/core resolveRoute().
function RoutingPills({
  routing,
  providers,
  onRouting,
}: {
  routing: RoutingTable;
  providers: ProviderOption[];
  onRouting: (next: RoutingTable) => void;
}) {
  const [editing, setEditing] = useState<RouteLane | null>(null);
  const providerLabel = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  const setLane = (lane: RouteLane, target: RouteTarget | null) => {
    const next: RoutingTable = { ...routing };
    if (target) next[lane] = target;
    else delete next[lane];
    onRouting(next);
  };

  return (
    <section className="routingPills">
      <header className="routingHead">
        <span><Sparkles size={15} /> Model routing</span>
        <small>Pin a model to a task — or leave it on Auto for the smart router.</small>
      </header>
      <div className="routingRow">
        {ROUTE_LANES.map((lane) => {
          const target = routing[lane];
          const open = editing === lane;
          return (
            <div className={open ? "routePill open" : "routePill"} key={lane}>
              <button
                type="button"
                className={target ? "routePillFace pinned" : "routePillFace"}
                onClick={() => setEditing(open ? null : lane)}
                title={ROUTE_LANE_HINTS[lane]}
              >
                <span className="routeLane">{ROUTE_LANE_LABELS[lane]}</span>
                <span className="routeTarget">
                  {target ? `${providerLabel(target.provider)} · ${target.model}` : "Auto"}
                </span>
              </button>
              {open ? (
                <div className="routeEditor">
                  <label>
                    <span>Provider</span>
                    <select
                      value={target?.provider ?? providers[0]?.id ?? ""}
                      onChange={(event) =>
                        setLane(lane, { provider: event.target.value, model: target?.model ?? "" })
                      }
                    >
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                      ))}
                      <option value="openrouter">OpenRouter</option>
                    </select>
                  </label>
                  <label>
                    <span>Model id</span>
                    <input
                      value={target?.model ?? ""}
                      placeholder="e.g. qwen3-coder:480b-cloud"
                      onChange={(event) =>
                        setLane(lane, {
                          provider: target?.provider ?? providers[0]?.id ?? "ollama",
                          model: event.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="routeEditorActions">
                    <button
                      type="button"
                      className="routeClear"
                      onClick={() => {
                        setLane(lane, null);
                        setEditing(null);
                      }}
                    >
                      Reset to Auto
                    </button>
                    <button type="button" className="routeDone" onClick={() => setEditing(null)}>
                      Done
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The three route lanes the owner steers from the bar (tool-use stays Auto).
const ROUTE_PILL_LANES: { lane: RouteLane; label: string; hint: string }[] = [
  { lane: "chat", label: "Main", hint: "Normal chat & quick answers" },
  { lane: "coding", label: "Coding", hint: "Writing & editing code" },
  { lane: "research", label: "Research", hint: "Planning, review, deep reasoning" },
];

// Claude-style options bar: a row of labeled pills (Reasoning · Route · Voice),
// each opening an animated dropdown. Route + Voice fan out to a nested side
// panel for per-option customization (provider + model).
function OptionsBar({
  reasoningLevel,
  onReasoning,
  reasoningSync,
  routing,
  onRouting,
  providers,
  selection,
  draftSelection,
  onProvider,
  onModel,
  onApply,
  running,
  voiceId,
  voiceSpeed,
  voiceCatalog,
  onVoice,
  onSpeed,
  onPreviewVoice,
  dropUp = false,
}: {
  reasoningLevel: ReasoningLevel;
  onReasoning: (level: ReasoningLevel) => void;
  reasoningSync: ReasoningSync;
  routing: RoutingTable;
  onRouting: (next: RoutingTable) => void;
  providers: ProviderOption[];
  selection: Selection;
  draftSelection: Selection;
  onProvider: (value: ProviderId) => void;
  onModel: (value: string) => void;
  onApply: () => void;
  running: boolean;
  voiceId: string;
  voiceSpeed: number;
  voiceCatalog: VoiceOption[];
  onVoice: (id: string) => void;
  onSpeed: (speed: number) => void;
  onPreviewVoice: (id: string) => void;
  dropUp?: boolean;
}) {
  const [open, setOpen] = useState<null | "provider" | "model" | "reasoning" | "route" | "voice">(null);
  const [activeLane, setActiveLane] = useState<RouteLane>("chat");
  const barRef = useRef<HTMLDivElement>(null);

  const activeProvider = providers.find((p) => p.id === draftSelection.provider) ?? providers[0];
  const draftModels = activeProvider?.models ?? [];
  const modelDirty =
    draftSelection.provider !== selection.provider || draftSelection.model !== selection.model;

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const providerLabel = (id: string) =>
    providers.find((p) => p.id === id)?.label ?? (id === "openrouter" ? "OpenRouter" : id);
  const pinnedCount = ROUTE_PILL_LANES.filter(({ lane }) => routing[lane]).length;
  const activeTarget = routing[activeLane];
  const activeVoice = voiceCatalog.find((v) => v.id === voiceId);

  const setLane = (lane: RouteLane, target: RouteTarget | null) => {
    const next: RoutingTable = { ...routing };
    if (target) next[lane] = target;
    else delete next[lane];
    onRouting(next);
  };

  const menuMotion = {
    initial: { opacity: 0, y: dropUp ? 8 : -8, scale: 0.97 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: dropUp ? 8 : -8, scale: 0.97 },
    transition: { duration: 0.16, ease: [0.16, 0.84, 0.24, 1] as [number, number, number, number] },
  };

  return (
    <div className={dropUp ? "optionsBar dropUp" : "optionsBar"} ref={barRef}>
      {/* ── Provider ──────────────────────────────────────────── */}
      <div className="optionPillWrap">
        <button
          type="button"
          className={open === "provider" ? "optionPill active" : "optionPill"}
          onClick={() => setOpen(open === "provider" ? null : "provider")}
        >
          <Cloud size={14} />
          <span className="optionPillBody">
            <small>Provider</small>
            <strong>{activeProvider?.label ?? draftSelection.provider}</strong>
          </span>
          <ChevronDown size={13} className="optionChevron" />
        </button>
        <AnimatePresence>
          {open === "provider" ? (
            <motion.div className="optionMenu" {...menuMotion}>
              <div className="optionMenuHead">Provider</div>
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === draftSelection.provider ? "optionRow selected" : "optionRow"}
                  onClick={() => {
                    onProvider(p.id);
                    setOpen("model");
                  }}
                >
                  <span className="laneText">
                    <strong>{p.label}</strong>
                    <small>{p.note}</small>
                  </span>
                  {p.id === draftSelection.provider ? <Check size={14} /> : null}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Model ─────────────────────────────────────────────── */}
      <div className="optionPillWrap">
        <button
          type="button"
          className={open === "model" ? "optionPill active" : "optionPill"}
          onClick={() => setOpen(open === "model" ? null : "model")}
        >
          <Layers size={14} />
          <span className="optionPillBody">
            <small>Model{modelDirty ? " •" : ""}</small>
            <strong>{draftSelection.model}</strong>
          </span>
          <ChevronDown size={13} className="optionChevron" />
        </button>
        <AnimatePresence>
          {open === "model" ? (
            <motion.div className="optionMenu modelMenu" {...menuMotion}>
              <div className="optionMenuHead">{activeProvider?.label ?? "Model"}</div>
              <div className="voiceScroll">
                {draftModels.length === 0 ? (
                  <div className="optionEmpty">No models discovered for this provider.</div>
                ) : (
                  draftModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={m.id === draftSelection.model ? "optionRow selected" : "optionRow"}
                      onClick={() => onModel(m.id)}
                    >
                      <span className="laneText">
                        <strong>{m.id}</strong>
                        {m.hint ? <small>{m.hint}</small> : null}
                      </span>
                      {m.id === draftSelection.model ? <Check size={14} /> : null}
                    </button>
                  ))
                )}
              </div>
              <button
                type="button"
                className="modelApply"
                disabled={!modelDirty}
                onClick={() => {
                  onApply();
                  setOpen(null);
                }}
              >
                {running ? "Restart with this model" : "Start with this model"}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Reasoning ─────────────────────────────────────────── */}
      <div className="optionPillWrap">
        <button
          type="button"
          className={open === "reasoning" ? "optionPill active" : "optionPill"}
          onClick={() => setOpen(open === "reasoning" ? null : "reasoning")}
        >
          <Brain size={14} />
          <span className="optionPillBody">
            <small>Reasoning</small>
            <strong>{reasoningLabel(reasoningLevel)}</strong>
          </span>
          <ChevronDown size={13} className="optionChevron" />
        </button>
        <AnimatePresence>
          {open === "reasoning" ? (
            <motion.div className="optionMenu" {...menuMotion}>
              <div className="optionMenuHead">Reasoning effort <small className={`reasoningTag sync-${reasoningSync}`}>{reasoningSyncLabel(reasoningSync)}</small></div>
              {REASONING_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={opt.id === reasoningLevel ? "optionRow selected" : "optionRow"}
                  onClick={() => {
                    onReasoning(opt.id);
                    setOpen(null);
                  }}
                >
                  <span>{opt.label}</span>
                  {opt.id === reasoningLevel ? <Check size={14} /> : null}
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Route ─────────────────────────────────────────────── */}
      <div className="optionPillWrap">
        <button
          type="button"
          className={open === "route" ? "optionPill active" : "optionPill"}
          onClick={() => setOpen(open === "route" ? null : "route")}
        >
          <Gauge size={14} />
          <span className="optionPillBody">
            <small>Route</small>
            <strong>{pinnedCount > 0 ? `${pinnedCount} pinned` : "Auto"}</strong>
          </span>
          <ChevronDown size={13} className="optionChevron" />
        </button>
        <AnimatePresence>
          {open === "route" ? (
            <motion.div className="optionMenu withSub" {...menuMotion}>
              <div className="optionMenuCol">
                <div className="optionMenuHead">Route by task</div>
                {ROUTE_PILL_LANES.map(({ lane, label, hint }) => {
                  const target = routing[lane];
                  return (
                    <button
                      key={lane}
                      type="button"
                      className={activeLane === lane ? "optionRow lane selected" : "optionRow lane"}
                      onMouseEnter={() => setActiveLane(lane)}
                      onClick={() => setActiveLane(lane)}
                    >
                      <span className="laneText">
                        <strong>{label}</strong>
                        <small>{target ? `${providerLabel(target.provider)} · ${target.model}` : hint}</small>
                      </span>
                      <ChevronDown size={13} className="laneArrow" />
                    </button>
                  );
                })}
              </div>
              <div className="optionMenuSub">
                <div className="optionMenuHead">{ROUTE_PILL_LANES.find((l) => l.lane === activeLane)?.label}</div>
                <label className="subField">
                  <span>Provider</span>
                  <select
                    value={activeTarget?.provider ?? providers[0]?.id ?? ""}
                    onChange={(event) =>
                      setLane(activeLane, { provider: event.target.value, model: activeTarget?.model ?? "" })
                    }
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                    <option value="openrouter">OpenRouter</option>
                  </select>
                </label>
                <label className="subField">
                  <span>Model id</span>
                  <input
                    value={activeTarget?.model ?? ""}
                    placeholder="e.g. qwen3-coder:480b-cloud"
                    onChange={(event) =>
                      setLane(activeLane, {
                        provider: activeTarget?.provider ?? providers[0]?.id ?? "ollama",
                        model: event.target.value,
                      })
                    }
                  />
                </label>
                <button type="button" className="subReset" onClick={() => setLane(activeLane, null)}>
                  Reset to Auto
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* ── Voice ─────────────────────────────────────────────── */}
      <div className="optionPillWrap">
        <button
          type="button"
          className={open === "voice" ? "optionPill active" : "optionPill"}
          onClick={() => setOpen(open === "voice" ? null : "voice")}
        >
          <Volume2 size={14} />
          <span className="optionPillBody">
            <small>Voice</small>
            <strong>{activeVoice?.label ?? voiceId}</strong>
          </span>
          <ChevronDown size={13} className="optionChevron" />
        </button>
        <AnimatePresence>
          {open === "voice" ? (
            <motion.div className="optionMenu withSub voiceMenu" {...menuMotion}>
              <div className="optionMenuCol">
                <div className="optionMenuHead">Voice <small className="reasoningTag">Local · Kokoro</small></div>
                <div className="voiceScroll">
                  {voiceCatalog.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={v.id === voiceId ? "optionRow selected" : "optionRow"}
                      onClick={() => {
                        onVoice(v.id);
                        onPreviewVoice(v.id);
                      }}
                    >
                      <span className="laneText">
                        <strong>{v.label}</strong>
                        <small>{v.accent} · {v.character}</small>
                      </span>
                      {v.id === voiceId ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="optionMenuSub">
                <div className="optionMenuHead">Tuning</div>
                <label className="subField">
                  <span>Speed <strong>{voiceSpeed.toFixed(2)}×</strong></span>
                  <input
                    type="range"
                    min="0.7"
                    max="1.5"
                    step="0.05"
                    value={voiceSpeed}
                    onChange={(event) => onSpeed(Number(event.target.value))}
                  />
                </label>
                <button type="button" className="subReset" onClick={() => onPreviewVoice(voiceId)}>
                  <Volume2 size={13} /> Preview
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
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
  routing,
  onRouting,
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
  routing: RoutingTable;
  onRouting: (next: RoutingTable) => void;
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

        <RoutingPills routing={routing} providers={providers} onRouting={onRouting} />

        {activeProvider.id === "openrouter" ? (
          <OpenRouterPanel
            draftSelection={draftSelection}
            onPick={(id) => onModel(id)}
            onApply={onApply}
            running={running}
          />
        ) : null}

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

        {activeProvider.id !== "openrouter" ? (
          <>
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
          </>
        ) : null}

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
            : "Cloud usage is tracked from Ares turn token reports so you can see which Ollama model is burning plan budget inside this app."}
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
  onPreviewVoice,
  onTheme,
  status,
  stats,
  theme,
  voiceCatalog,
}: {
  appearance: AppearanceSettings;
  events: AresEvent[];
  onAppearance: (value: AppearanceSettings) => void;
  onPreviewVoice: (id: string) => void;
  onTheme: (value: ThemeName) => void;
  status: HeartbeatStatus;
  stats: ReturnType<typeof collectStats>;
  theme: ThemeName;
  voiceCatalog: VoiceOption[];
}) {
  const cards = [
    ["Identity", "Loaded from ~/.ares/IDENTITY.md and SOUL.md"],
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
        onPreviewVoice={onPreviewVoice}
        onTheme={onTheme}
        theme={theme}
        voiceCatalog={voiceCatalog}
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

function GrowthPanel({ events }: { events: AresEvent[] }) {
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
  onPreviewVoice,
  onTheme,
  theme,
  voiceCatalog,
}: {
  appearance: AppearanceSettings;
  onAppearance: (value: AppearanceSettings) => void;
  onPreviewVoice: (id: string) => void;
  onTheme: (value: ThemeName) => void;
  theme: ThemeName;
  voiceCatalog: VoiceOption[];
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
      <VoicePicker
        catalog={voiceCatalog}
        onPreview={onPreviewVoice}
        onSpeed={(speed) => onAppearance({ ...appearance, voiceSpeed: speed })}
        onVoice={(id) => onAppearance({ ...appearance, voiceId: id })}
        voiceId={appearance.voiceId}
        voiceSpeed={appearance.voiceSpeed}
      />
    </section>
  );
}

function VoicePicker({
  catalog,
  onPreview,
  onSpeed,
  onVoice,
  voiceId,
  voiceSpeed,
}: {
  catalog: VoiceOption[];
  onPreview: (id: string) => void;
  onSpeed: (speed: number) => void;
  onVoice: (id: string) => void;
  voiceId: string;
  voiceSpeed: number;
}) {
  const list = catalog.length
    ? catalog
    : [{ id: voiceId, label: voiceId, gender: "female", lang: "a", accent: "", tier: "", character: "Enable voice replies to load the full catalog." } as VoiceOption];
  return (
    <div className="voicePicker">
      <div className="voicePickerHead">
        <span><Volume2 size={15} /> Voice</span>
        <label className="voiceSpeedControl">
          <span>Speed <strong>{voiceSpeed.toFixed(2)}x</strong></span>
          <input max="1.5" min="0.7" step="0.05" type="range" value={voiceSpeed} onChange={(event) => onSpeed(Number(event.target.value))} />
        </label>
      </div>
      <div className="voiceGrid">
        {list.map((voice) => (
          <button
            className={voice.id === voiceId ? "voiceChip active" : "voiceChip"}
            key={voice.id}
            onClick={() => onVoice(voice.id)}
            title={voice.character}
            type="button"
          >
            <span className="voiceChipName">{voice.label}</span>
            <span className="voiceChipMeta">{voice.accent} {voice.gender === "male" ? "M" : "F"}{voice.tier ? ` · ${voice.tier}` : ""}</span>
            <span
              aria-label={`Preview ${voice.label}`}
              className="voiceChipPreview"
              onClick={(event) => { event.stopPropagation(); onPreview(voice.id); }}
              role="button"
              tabIndex={-1}
            >
              <Play size={13} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThemeGlyph({ theme }: { theme: ThemeName }) {
  if (theme === "matrix") return <TerminalSquare size={18} />;
  if (theme === "storm") return <Power size={18} />;
  return <Sparkles size={18} />;
}

function ToolsView({ events }: { events: AresEvent[] }) {
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

// Hermes-style compact activity flow row for a tool call: one line —
// [icon] what it's doing ............... duration — expandable for detail,
// instead of a heavy stacked card. Running = pulsing; done = quiet; failed = red.
function flowIcon(name?: string, activity?: string) {
  const s = `${name ?? ""} ${activity ?? ""}`.toLowerCase();
  if (/web|search|browser|fetch|http|open|navigat|url|page/.test(s)) return Globe2;
  if (/read|file|cat|view|edit|write|patch|diff|code/.test(s)) return Code2;
  if (/bash|shell|command|run|exec|terminal|npm|git|build/.test(s)) return TerminalSquare;
  if (/memory|recall|remember|store|db/.test(s)) return Database;
  return Wrench;
}

// Walk a tool's output for LOCAL image files (browser screenshot frames,
// filmstrip captures) so they render inline as actual pictures via Tauri's
// convertFileSrc — this is how "find me images" shows results headlessly.
function collectToolImagePaths(output: unknown, acc: string[] = [], depth = 0): string[] {
  if (acc.length >= 6 || depth > 5 || output == null) return acc;
  if (typeof output === "string") {
    if (/[\\/][^\\/]+\.(png|jpe?g|webp|gif)$/i.test(output) && /^[a-z]:[\\/]|^\//i.test(output)) acc.push(output);
    return acc;
  }
  if (Array.isArray(output)) {
    for (const v of output) collectToolImagePaths(v, acc, depth + 1);
    return acc;
  }
  if (typeof output === "object") {
    for (const v of Object.values(output as Record<string, unknown>)) collectToolImagePaths(v, acc, depth + 1);
  }
  return acc;
}

function ToolFlowRow({ event }: { event: AresEvent }) {
  const [open, setOpen] = useState(false);
  const status = event.status ?? "running";
  const Icon = flowIcon(event.name, event.activityDescription);
  const label = event.activityDescription || (event.name ? `Running ${event.name}` : "Working");
  const dur = typeof event.durationMs === "number" ? formatToolDuration(event.durationMs) : "";
  const detail = status === "failed"
    ? (typeof event.error === "string" ? event.error : previewValue(event.error))
    : [event.display, event.output !== undefined ? previewValue(event.output) : ""].filter(Boolean).join("\n");
  const hasDetail = Boolean(detail && detail.trim());
  const imagePaths = useMemo(
    () => (status === "completed" ? collectToolImagePaths(event.output) : []),
    [status, event.output],
  );
  return (
    <motion.div
      className={`flowRow state-${status}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <button type="button" className="flowHead" onClick={() => hasDetail && setOpen((v) => !v)} disabled={!hasDetail}>
        <span className="flowIcon"><Icon size={14} /></span>
        <span className="flowLabel">{label}</span>
        {status === "running" ? (
          <span className="flowDots"><i /><i /><i /></span>
        ) : status === "failed" ? (
          <span className="flowBad">failed</span>
        ) : null}
        {dur ? <span className="flowMeta">{dur}</span> : null}
        {hasDetail ? <ChevronDown size={12} className={open ? "flowChevron open" : "flowChevron"} /> : null}
      </button>
      {imagePaths.length > 0 ? (
        <div className="chatImages flowImages">
          {imagePaths.map((p) => <ChatImageThumb key={p} src={hasNativeBridge() ? convertFileSrc(p) : p} />)}
        </div>
      ) : null}
      {open && hasDetail ? <pre className="flowDetail">{detail}</pre> : null}
    </motion.div>
  );
}

function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const EventCard = memo(function EventCard({
  event,
  compact = false,
  onPermissionDecision,
}: {
  event: AresEvent;
  compact?: boolean;
  onPermissionDecision?: (id: string | undefined, decision: PermissionDecision) => void;
}) {
  if (event.type === "thinking_stream") return <ThinkingTrace event={event} compact={compact} />;
  if (event.type === "tool_call") return <ToolFlowRow event={event} />;
  if (event.type === "permission_gate") return <PermissionFlow event={event} onDecision={onPermissionDecision} />;
  const kind = eventKind(event);
  const title = eventTitle(event);
  const text = eventText(event);
  const Icon = eventIcon(event);
  const state = event.type === "tool_call" ? event.status ?? "queued" : "";
  return (
    <motion.article
      className={`eventCard ${kind}${state ? ` state-${state}` : ""}${compact ? " compact" : ""}`}
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="eventAvatar"><Icon size={16} /></div>
      <div className="eventBody">
        <header>
          <strong>{title}</strong>
          <time>{event.type}</time>
        </header>
        {event.type === "assistant_stream" && text ? (
          <>
            <StreamingText text={text} />
            <ChatImages text={text} />
          </>
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
}, (a, b) => a.event === b.event && a.compact === b.compact);

// Clean flow-styled approval prompt — matches the activity rows instead of the
// old heavy card. Reason inline, input collapsed, compact actions.
function PermissionFlow({
  event,
  onDecision,
}: {
  event: AresEvent;
  onDecision?: (id: string | undefined, decision: PermissionDecision) => void;
}) {
  const [showInput, setShowInput] = useState(false);
  const waiting = event.status === "waiting";
  const decision = normalizeDecision(event.decision);
  const tool = event.toolName || "Action";
  return (
    <motion.div
      className={`flowRow permissionFlow ${waiting ? "waiting" : decision === "deny" ? "denied" : "allowed"}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div className="permFlowHead">
        <span className="flowIcon"><ShieldCheck size={14} /></span>
        <span className="permFlowText">
          <strong>{tool}</strong> {event.reason || "needs approval"}
        </span>
        {event.input !== undefined ? (
          <button type="button" className="permFlowPeek" onClick={() => setShowInput((v) => !v)}>
            {showInput ? "hide" : "details"}
          </button>
        ) : null}
      </div>
      {showInput && event.input !== undefined ? <pre className="flowDetail">{previewValue(event.input)}</pre> : null}
      {waiting ? (
        <div className="permFlowActions">
          <button type="button" className="pAllow" onClick={() => onDecision?.(event.id, "allow_once")}><Check size={13} /> Allow</button>
          <button type="button" className="pAlways" onClick={() => onDecision?.(event.id, "allow_always")}><ShieldCheck size={13} /> Always</button>
          <button type="button" className="pDeny" onClick={() => onDecision?.(event.id, "deny")}><X size={13} /> Deny</button>
        </div>
      ) : (
        <div className={`permFlowResult ${decision === "deny" ? "deny" : "allow"}`}>
          {decision === "deny" ? <X size={12} /> : <Check size={12} />}
          {decision ? permissionDecisionLabel(decision) : "Answered"}
        </div>
      )}
    </motion.div>
  );
}

function PermissionGate({
  event,
  onDecision,
}: {
  event: AresEvent;
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

function ThinkingTrace({ event, compact = false }: { event: AresEvent; compact?: boolean }) {
  const [open, setOpen] = useState(true);
  const text = eventText(event);
  const meta = text.length > 0 ? `${formatNumber(text.length)} chars` : "";
  return (
    <motion.div
      className={`flowRow state-thinking${compact ? " compact" : ""}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <button type="button" className="flowHead" onClick={() => setOpen((v) => !v)}>
        <span className="flowIcon"><Brain size={14} /></span>
        <span className="flowLabel">Thinking</span>
        {meta ? <span className="flowMeta">{meta}</span> : <span className="flowDots"><i /><i /><i /></span>}
        <ChevronDown size={12} className={open ? "flowChevron open" : "flowChevron"} />
      </button>
      {open && text ? (
        <div className="flowDetail thinkingFlow"><StreamingText text={text} /></div>
      ) : null}
    </motion.div>
  );
}

// Pull image URLs out of an assistant message (markdown images + bare image
// links) so they render as actual pictures in the chat instead of raw links.
function extractImageUrls(text: string): string[] {
  const urls = new Set<string>();
  const md = /!\[[^\]]*\]\(([^)\n]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text))) {
    const candidate = m[1].trim();
    if (isRenderableChatImage(candidate)) urls.add(candidate);
  }
  const bare = /(https?:\/\/[^\s)<>"']+\.(?:png|jpe?g|gif|webp|avif)(?:\?[^\s)<>"']*)?)/gi;
  while ((m = bare.exec(text))) urls.add(m[1]);
  const local = /((?:[a-z]:[\\/]|\/)[^\s)<>"']+\.(?:png|jpe?g|gif|webp))/gi;
  while ((m = local.exec(text))) urls.add(m[1]);
  return [...urls].slice(0, 12);
}

// Open the full-screen lightbox for an image. Decoupled via a window event so
// deeply-nested (memoized) image components don't need a callback prop.
function openLightbox(src: string) {
  window.dispatchEvent(new CustomEvent("ares:lightbox", { detail: { src } }));
}

function ChatImageThumb({ src }: { src: string }) {
  return (
    <button type="button" className="chatImage" onClick={() => openLightbox(src)} title="Click to expand">
      <img src={src} alt="" loading="lazy" onError={(e) => { (e.currentTarget.closest(".chatImage") as HTMLElement).style.display = "none"; }} />
    </button>
  );
}

function ChatImages({ text }: { text: string }) {
  const urls = useMemo(() => extractImageUrls(text), [text]);
  if (urls.length === 0) return null;
  return (
    <div className="chatImages">
      {urls.map((url) => {
        const src = looksLikeLocalImagePath(url) && hasNativeBridge() ? convertFileSrc(url) : url;
        return <ChatImageThumb key={url} src={src} />;
      })}
    </div>
  );
}

// Full-screen image viewer: click any chat image to expand, X / Esc / backdrop to close.
function ImageLightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => setSrc((e as CustomEvent<{ src: string }>).detail?.src ?? null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSrc(null); };
    window.addEventListener("ares:lightbox", onOpen as EventListener);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("ares:lightbox", onOpen as EventListener); window.removeEventListener("keydown", onKey); };
  }, []);
  return (
    <AnimatePresence>
      {src ? (
        <motion.div
          className="imageLightbox"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={() => setSrc(null)}
        >
          <button type="button" className="lightboxClose" onClick={() => setSrc(null)} title="Close (Esc)"><X size={20} /></button>
          <motion.img
            src={src} alt="" onClick={(e) => e.stopPropagation()}
            initial={{ scale: 0.94 }} animate={{ scale: 1 }} exit={{ scale: 0.94 }}
            transition={{ duration: 0.18, ease: [0.16, 0.84, 0.24, 1] }}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function isRenderableChatImage(value: string) {
  return /^(https?:\/\/|data:image\/)/i.test(value) || looksLikeLocalImagePath(value);
}

// Plain text — the old per-character animated spans created dozens of animating
// nodes per message and re-laid-out on every stream tick, which tanked the UI
// once the transcript filled up. Streaming already updates the text live.
function StreamingText({ text }: { text: string }) {
  return <pre className="streamingText">{text}</pre>;
}

function ToolCallShow({ event, text }: { event: AresEvent; text: string }) {
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

function ToolStateRail({ event }: { event: AresEvent }) {
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

function voiceStatusLabel(status: VoiceStatus): string {
  if (status === "connecting") return "linking";
  if (status === "ready") return "ready";
  if (status === "speaking") return "speaking";
  if (status === "error") return "offline";
  return "off";
}

function takeVoiceChunk(buffer: string, force: boolean): { chunk: string; rest: string } | null {
  const text = buffer.trimStart();
  if (!text) return null;

  // A sentence end is always a clean break, at any length.
  const sentenceMatch = /[.!?…](?:\s|$)/.exec(text);
  if (sentenceMatch?.index !== undefined) {
    return splitVoiceChunk(text, sentenceMatch.index + sentenceMatch[0].length);
  }

  // Once we have a phrase's worth of text, speak it at the next clause break
  // (comma / semicolon / colon / dash) so audio keeps pace with generation.
  if (text.length >= VOICE_MIN_CHUNK_CHARS) {
    const clauseMatch = /[,;:—–](?:\s|$)/.exec(text.slice(VOICE_MIN_CHUNK_CHARS));
    if (clauseMatch?.index !== undefined) {
      return splitVoiceChunk(text, VOICE_MIN_CHUNK_CHARS + clauseMatch.index + clauseMatch[0].length);
    }
  }

  // No punctuation but the buffer is getting long — break at a word boundary.
  if (text.length >= VOICE_SOFT_FLUSH_CHARS) {
    const whitespace = text.lastIndexOf(" ", VOICE_HARD_FLUSH_CHARS);
    const end = whitespace > VOICE_MIN_CHUNK_CHARS ? whitespace : Math.min(text.length, VOICE_HARD_FLUSH_CHARS);
    return splitVoiceChunk(text, end);
  }

  if (force) return { chunk: text.trim(), rest: "" };
  return null;
}

function splitVoiceChunk(text: string, end: number): { chunk: string; rest: string } {
  return {
    chunk: text.slice(0, end).trim(),
    rest: text.slice(end),
  };
}

function prepareVoiceText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " code omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Don't read emojis aloud — strip pictographs + their modifiers/joiners.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu, "")
    .replace(/[#*_>~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function audioUrlFromBase64(base64: string, mime: string): string {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function appendEvent(events: AresEvent[], event: AresEvent): AresEvent[] {
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

function isToolEvent(event: AresEvent): boolean {
  return [
    "tool_use_start",
    "tool_use_input_done",
    "tool_start",
    "tool_progress",
    "tool_end",
    "tool_error",
  ].includes(event.type);
}

function isPermissionEvent(event: AresEvent): boolean {
  return event.type === "permission_request" || event.type === "permission_response";
}

function upsertPermissionEvent(events: AresEvent[], event: AresEvent): AresEvent[] {
  const id = event.id;
  if (!id) return [...events, event];
  const index = events.findIndex((item) => item.type === "permission_gate" && item.id === id);
  const previous = index >= 0 ? events[index] : undefined;
  const merged = mergePermissionEvent(previous, event);
  if (index === -1) return [...events, merged];
  return [...events.slice(0, index), merged, ...events.slice(index + 1)];
}

function mergePermissionEvent(previous: AresEvent | undefined, event: AresEvent): AresEvent {
  const now = event.receivedAt ?? Date.now();
  const base: AresEvent = previous ?? {
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

function upsertToolEvent(events: AresEvent[], event: AresEvent): AresEvent[] {
  const id = event.id;
  if (!id) return [...events, event];
  const index = events.findIndex((item) => item.type === "tool_call" && item.id === id);
  const previous = index >= 0 ? events[index] : undefined;
  const merged = mergeToolEvent(previous, event);
  if (index === -1) return [...events, merged];
  return [...events.slice(0, index), merged, ...events.slice(index + 1)];
}

function mergeToolEvent(previous: AresEvent | undefined, event: AresEvent): AresEvent {
  const now = event.receivedAt ?? Date.now();
  const base: AresEvent = previous ?? {
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

function collectStats(events: AresEvent[]) {
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

// Stable per-event key. tool_call carries an id; stream/thinking carry a
// creation-time startedAt that is preserved across delta updates (the spread in
// appendEvent keeps it). Using these instead of the visible-window index avoids
// remounting every card once the transcript clips past 90 (a real perf cliff).
function eventKey(event: AresEvent, index: number): string {
  return `${event.type}-${event.id ?? event.startedAt ?? index}`;
}

function isChatVisibleEvent(event: AresEvent): boolean {
  if (event.type === "user_send" || event.type === "assistant_stream" || event.type === "thinking_stream") return true;
  if (event.type === "tool_call") return true;
  if (event.type === "permission_gate") return true;
  if (event.type === "desktop_preview" || event.type === "desktop_error" || event.type === "desktop_model_applied") return true;
  if (event.type === "reasoning_set") return true;
  if (event.type === "error" || event.type === "daemon_error") return true;
  return false;
}

function eventKind(event: AresEvent): string {
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

function eventIcon(event: AresEvent) {
  if (event.type === "user_send") return MessageSquare;
  if (event.type === "assistant_stream") return Bot;
  if (event.type === "thinking_stream") return Brain;
  if (event.type === "permission_gate") return ShieldCheck;
  if (event.type === "tool_call" || event.type.startsWith("tool_")) return Wrench;
  if (event.type.includes("daemon")) return TerminalSquare;
  if (event.type.includes("dream") || event.type.includes("memory") || event.type.includes("soul")) return Brain;
  return Sparkles;
}

function eventTitle(event: AresEvent): string {
  if (event.type === "user_send") return "You";
  if (event.type === "assistant_stream") return "Ares";
  if (event.type === "thinking_stream") return "Thinking";
  if (event.type === "permission_gate") return event.toolName ? `Permission: ${event.toolName}` : "Permission";
  if (event.type === "tool_call") return event.activityDescription || (event.name ? `Tool: ${event.name}` : "Tool");
  if (event.type === "tool_start") return event.activityDescription || (event.name ? `Tool: ${event.name}` : "Tool started");
  if (event.type === "tool_end") return event.activityDescription || (event.name ? `Tool finished: ${event.name}` : "Tool finished");
  if (event.type === "turn_end") return `Turn ${event.status ?? "ended"}`;
  if (event.type === "desktop_model_applied") return "Model applied";
  if (event.type === "reasoning_set") return "Reasoning updated";
  return humanize(event.type);
}

function eventText(event: AresEvent): string {
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

function currentLiveActivity(events: AresEvent[], daemon: DaemonState, status: HeartbeatStatus, now: number): LiveActivity {
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
      title: runningTool.activityDescription || (runningTool.name ? `Running ${runningTool.name}` : "Running tool"),
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
  return value === "ollama" || value === "openai" || value === "openrouter" || value === "mock";
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
        "[Ares desktop web mode is ON for this message.]",
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

function loadDesktopSettings(): { theme: ThemeName; selection: Selection; appearance: AppearanceSettings; routing: RoutingTable } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<{ theme: ThemeName; selection: Selection; appearance: Partial<AppearanceSettings>; routing: unknown }>;
    const allowMock = Boolean(import.meta.env.DEV) || window.localStorage.getItem("ares.dev") === "1";
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
      routing: normalizeRouting(parsed.routing),
    };
  } catch {
    return { theme: "signal", selection: DEFAULT_SELECTION, appearance: DEFAULT_APPEARANCE, routing: DEFAULT_ROUTING };
  }
}

function normalizeRouting(value: unknown): RoutingTable {
  if (!value || typeof value !== "object") return {};
  const out: RoutingTable = {};
  for (const lane of ROUTE_LANES) {
    const entry = (value as Record<string, unknown>)[lane];
    if (entry && typeof entry === "object") {
      const provider = (entry as Record<string, unknown>).provider;
      const model = (entry as Record<string, unknown>).model;
      if (typeof provider === "string" && provider && typeof model === "string" && model) {
        out[lane] = { provider, model };
      }
    }
  }
  return out;
}

function saveDesktopSettings(settings: { theme: ThemeName; selection: Selection; appearance: AppearanceSettings; routing: RoutingTable }) {
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
  const speed = Number(value?.voiceSpeed ?? DEFAULT_APPEARANCE.voiceSpeed);
  return {
    opacity: clampOpacity(Number(value?.opacity ?? DEFAULT_APPEARANCE.opacity)),
    corners: value?.corners === "rounded" ? "rounded" : "square",
    voiceId: typeof value?.voiceId === "string" && value.voiceId.trim() ? value.voiceId.trim() : DEFAULT_APPEARANCE.voiceId,
    voiceSpeed: Number.isFinite(speed) ? Math.min(1.5, Math.max(0.7, speed)) : DEFAULT_APPEARANCE.voiceSpeed,
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

function runWindowCommand(command: "ares_window_minimize" | "ares_window_toggle_maximize" | "ares_window_close") {
  return (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void invoke(command);
  };
}

function hasNativeBridge(): boolean {
  // Require a REAL invoke — some sandboxes (and the web preview) inject a partial
  // __TAURI_INTERNALS__ with no working invoke, which made the guard pass and the
  // daemon calls throw "Cannot read properties of undefined (reading 'invoke')".
  if (typeof window === "undefined") return false;
  if (isTauri()) return true;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

// Create the React root once and reuse it across HMR updates. Calling
// createRoot() again on the same container spawns overlapping React trees that
// fight over one DOM node (stale/frozen state, duplicate effects).
const container = document.getElementById("root")! as HTMLElement & { __aresRoot?: ReturnType<typeof createRoot> };
const root = container.__aresRoot ?? (container.__aresRoot = createRoot(container));
root.render(<App />);
