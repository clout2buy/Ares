// Model Router foundation (Nexus Phase 1) — judgment over Crix's own brain usage.
//
// A PURE, explainable policy layer: given a task (kind + risk + privacy + quality
// + cost + latency + what it touches) and a set of provider profiles, decide
// which KIND of model should think about it — local for cheap/private/simple,
// cloud for hard reasoning — with a fallback, cited reasons, and warnings.
//
// v1 is advisory: it recommends a route, it does NOT force a live provider
// switch. No API calls, no network — routing is a deterministic function of its
// inputs, so it is fully testable offline. Local/private routing is strongly
// preferred for anything that touches sensitive surfaces.

export type ModelTaskKind =
  | "chat"
  | "code"
  | "planning"
  | "summarization"
  | "memory"
  | "review"
  | "vision"
  | "workshop"
  | "tool-output-summary";

export type RiskLevel = "low" | "medium" | "high";
export type PrivacyPosture = "local-required" | "local-preferred" | "cloud-ok" | "cloud-required";
export type QualityNeed = "fast" | "balanced" | "best";
export type CostPreference = "cheap" | "balanced" | "premium-ok";
export type LatencyPreference = "low" | "normal" | "patient";
export type Locality = "local" | "cloud";
export type ModelTouch = "none" | "user-data" | "files" | "credentials" | "browser" | "action-tools" | "code";

export interface ModelTask {
  kind: ModelTaskKind;
  risk?: RiskLevel;
  privacy?: PrivacyPosture;
  quality?: QualityNeed;
  cost?: CostPreference;
  latency?: LatencyPreference;
  /** Approximate context the task needs (tokens). */
  contextTokens?: number;
  /** Sensitive surfaces the task touches — drives privacy bias + warnings. */
  touches?: ModelTouch[];
  summary?: string;
}

export interface ModelCapability {
  strengths: ModelTaskKind[];
  /** Highest quality tier this family realistically reaches. */
  ceiling: QualityNeed;
  maxContextTokens?: number;
  vision?: boolean;
}

export interface ModelProviderProfile {
  family: string;
  label: string;
  locality: Locality;
  /** Local => true. Cloud families are not private. */
  private: boolean;
  /** 0 free/local … 3 premium. */
  costTier: 0 | 1 | 2 | 3;
  /** 0 fast … 2 slow. */
  latencyTier: 0 | 1 | 2;
  available: boolean;
  capability: ModelCapability;
  /** Optional concrete model-class hint (e.g. "qwen3-coder") — never required. */
  modelClass?: string;
}

export interface ModelRoute {
  family: string;
  modelClass?: string;
  locality: Locality;
}

export interface ModelRouteDecision {
  task: Required<Pick<ModelTask, "kind" | "risk" | "privacy" | "quality" | "cost" | "latency">> & ModelTask;
  selected: ModelRoute | null;
  fallback: ModelRoute | null;
  reasons: string[];
  warnings: string[];
  confidence: number;
  /** v1 is always advisory (false): the router recommends, it never force-switches. */
  executable: boolean;
}

export interface ModelRoutingPolicy {
  profiles: ModelProviderProfile[];
}

const QUALITY_RANK: Record<QualityNeed, number> = { fast: 0, balanced: 1, best: 2 };
const SENSITIVE: ReadonlySet<ModelTouch> = new Set(["credentials", "user-data", "action-tools"]);

/** Sensible per-task-kind defaults, applied only to fields the caller left unset. */
export function taskDefaults(kind: ModelTaskKind): Required<Pick<ModelTask, "risk" | "privacy" | "quality" | "cost" | "latency">> {
  switch (kind) {
    case "summarization":
    case "tool-output-summary":
    case "memory":
      return { risk: "low", privacy: "local-preferred", quality: "fast", cost: "cheap", latency: "low" };
    case "review":
      return { risk: "high", privacy: "local-preferred", quality: "best", cost: "balanced", latency: "normal" };
    case "planning":
    case "workshop":
      return { risk: "medium", privacy: "cloud-ok", quality: "best", cost: "premium-ok", latency: "patient" };
    case "vision":
      return { risk: "medium", privacy: "cloud-ok", quality: "balanced", cost: "balanced", latency: "normal" };
    case "code":
      return { risk: "medium", privacy: "local-preferred", quality: "balanced", cost: "balanced", latency: "normal" };
    case "chat":
    default:
      return { risk: "medium", privacy: "local-preferred", quality: "balanced", cost: "balanced", latency: "normal" };
  }
}

/** A generic, machine-agnostic starting catalog. Callers set `available` from real config. */
export const DEFAULT_PROVIDER_PROFILES: ModelProviderProfile[] = [
  {
    family: "ollama-local",
    label: "Local Ollama",
    locality: "local",
    private: true,
    costTier: 0,
    latencyTier: 1,
    available: true,
    capability: { strengths: ["chat", "summarization", "memory", "tool-output-summary", "code"], ceiling: "balanced", maxContextTokens: 32_000 },
  },
  {
    family: "ollama-cloud",
    label: "Ollama Cloud",
    locality: "cloud",
    private: false,
    costTier: 1,
    latencyTier: 1,
    available: true,
    capability: { strengths: ["code", "planning", "chat", "review"], ceiling: "best", maxContextTokens: 256_000 },
  },
  {
    family: "openrouter",
    label: "OpenRouter",
    locality: "cloud",
    private: false,
    costTier: 2,
    latencyTier: 1,
    available: true,
    capability: { strengths: ["planning", "code", "review", "chat", "vision", "workshop"], ceiling: "best", maxContextTokens: 200_000, vision: true },
  },
  {
    family: "openai",
    label: "OpenAI",
    locality: "cloud",
    private: false,
    costTier: 2,
    latencyTier: 1,
    available: true,
    capability: { strengths: ["planning", "review", "code", "chat"], ceiling: "best", maxContextTokens: 200_000 },
  },
];

interface Scored {
  profile: ModelProviderProfile;
  score: number;
  why: string[];
}

/** Decide a route for a task. PURE: deterministic, no I/O, inputs untouched. */
export function routeModel(task: ModelTask, policy: ModelRoutingPolicy): ModelRouteDecision {
  const defaults = taskDefaults(task.kind);
  const t = {
    ...task,
    risk: task.risk ?? defaults.risk,
    privacy: task.privacy ?? defaults.privacy,
    quality: task.quality ?? defaults.quality,
    cost: task.cost ?? defaults.cost,
    latency: task.latency ?? defaults.latency,
  };
  const touches = t.touches ?? [];
  const sensitive = touches.some((x) => SENSITIVE.has(x));
  const warnings: string[] = [];

  const needRank = QUALITY_RANK[t.quality];
  const scored: Scored[] = [];

  for (const profile of policy.profiles) {
    if (!profile.available) continue;
    // Hard privacy gates.
    if (t.privacy === "local-required" && profile.locality !== "local") continue;
    if (t.privacy === "cloud-required" && profile.locality !== "cloud") continue;
    // Hard context gate.
    if (t.contextTokens && profile.capability.maxContextTokens && t.contextTokens > profile.capability.maxContextTokens) continue;
    if (t.kind === "vision" && !profile.capability.vision) continue;

    const why: string[] = [];
    const isStrength = profile.capability.strengths.includes(t.kind);
    const strength = isStrength ? 1 : 0.3;
    if (isStrength) why.push(`strong at ${t.kind}`);

    const ceilingRank = QUALITY_RANK[profile.capability.ceiling];
    const qualityFit = ceilingRank >= needRank ? 1 : 0.3;
    if (ceilingRank >= needRank) why.push(`meets "${t.quality}" quality`);

    let privacyPref = 0.5;
    if (profile.locality === "local") {
      privacyPref = t.privacy === "local-preferred" || t.privacy === "local-required" || sensitive ? 1 : 0.7;
      if (sensitive) why.push("local keeps sensitive data private");
      else if (t.privacy === "local-preferred") why.push("local (privacy preferred)");
    } else {
      privacyPref = t.privacy === "cloud-ok" || t.privacy === "cloud-required" ? (needRank === QUALITY_RANK.best ? 1 : 0.8) : 0.4;
      if (needRank === QUALITY_RANK.best && (t.privacy === "cloud-ok" || t.privacy === "cloud-required")) why.push("cloud reaches the highest quality");
    }

    const costFit = t.cost === "premium-ok" ? 1 : t.cost === "cheap" ? 1 - profile.costTier / 3 : 1 - profile.costTier / 6;
    if (t.cost === "cheap" && profile.costTier === 0) why.push("free/local — no spend");
    const latencyFit = t.latency === "patient" ? 1 : t.latency === "low" ? 1 - profile.latencyTier / 2 : 1 - profile.latencyTier / 4;

    const score = 0.35 * strength + 0.3 * qualityFit + 0.2 * privacyPref + 0.1 * costFit + 0.05 * latencyFit;
    scored.push({ profile, score, why });
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    if (t.privacy === "local-required") warnings.push("no local model available for a local-required task");
    else warnings.push("no available model route satisfies these constraints");
    return { task: t, selected: null, fallback: null, reasons: [], warnings, confidence: 0, executable: false };
  }

  const top = scored[0];
  const selected: ModelRoute = { family: top.profile.family, modelClass: top.profile.modelClass, locality: top.profile.locality };
  // Fallback: prefer a different locality for resilience, else the next best.
  const fallbackScored = scored.slice(1).find((s) => s.profile.locality !== top.profile.locality) ?? scored[1];
  const fallback: ModelRoute | null = fallbackScored
    ? { family: fallbackScored.profile.family, modelClass: fallbackScored.profile.modelClass, locality: fallbackScored.profile.locality }
    : null;

  const reasons = [`${top.profile.label}: ${top.why.join(", ") || "best overall fit"}`];
  if (fallback) reasons.push(`fallback → ${fallbackScored.profile.label}${fallbackScored.profile.locality !== top.profile.locality ? " (different locality for resilience)" : ""}`);

  if (sensitive && top.profile.locality === "cloud") {
    warnings.push(`task touches ${touches.filter((x) => SENSITIVE.has(x)).join("/")} but the top route is cloud — consider a local model or explicit approval`);
  }
  if (QUALITY_RANK[top.profile.capability.ceiling] < needRank) {
    warnings.push(`no available model meets "${t.quality}" quality — "${top.profile.capability.ceiling}" is the best on hand`);
  }

  const margin = scored.length > 1 ? top.score - scored[1].score : top.score;
  const confidence = clamp01(top.score * (0.6 + 0.4 * clamp01(margin * 2)));

  return { task: t, selected, fallback, reasons, warnings, confidence, executable: false };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
