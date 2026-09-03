// The live route — where @ares/core's resolveRoute() finally meets a turn.
//
// resolveRoute() shipped as Nexus Phase 2 with zero callers: the daemon's
// Auto-routing path read the owner's per-lane assignment table directly and
// left every unassigned lane on whatever model already owned the conversation,
// while a stale comment claimed the router was in charge. This module is the
// missing seam. Given the classified lane, the goal, the owner's assignments
// and the live provider configuration, it produces ONE decision with cited
// reasons:
//
//   pinned    — manual routing: the owner's selection is a pin, no router runs;
//   assigned  — the owner assigned this lane a provider+model: it wins outright;
//   heuristic — nothing assigned: routeModel() scores the CONFIGURED providers
//               with a lane-shaped task (sensitive-surface detection biases
//               local/private, explore/summarize work is cost-aware).
//
// `executable` keeps the router honest: a route is only acted on when its
// provider is actually configured and not retired for the session. The
// daemon treats a non-executable route as "keep the current model" and still
// surfaces the reasons/warnings so the owner can see why nothing moved.
//
// Pure given its inputs (settings + env + dead-set) — no I/O, no network.

import { laneForTask, resolveRoute, type Locality, type ModelProviderProfile, type ModelTask, type ModelTaskKind, type ModelTouch, type RouteAssignments, type RouteLane } from "@ares/core";
import { isLocalProviderHost } from "./localProviderDiagnosis.js";
import { defaultTerminalModel } from "./providers.js";
import type { UiSettings } from "../uiSettings.js";

/** Credentials, identity, money, health, payroll — data an owner would not
 *  want leaving the machine without a deliberate choice. Deliberately broad:
 *  a false positive costs a warning and a local preference; a miss ships a
 *  password to a cloud model. */
export function detectSensitiveSurface(goal: string): { sensitive: boolean; touches: ModelTouch[] } {
  const g = goal.toLowerCase();
  const credential = /\b(password|passwd|passphrase|api[ _-]?key|secret|token|credential|private key|ssh key|\.env\b|bearer|oauth|2fa|otp)\b/.test(g);
  const identity = /\b(ssn|social security|passport|driver'?s licen[cs]e|date of birth|bank account|routing number|credit card|card number|cvv|iban|swift)\b/.test(g);
  const personal = /\b(medical|diagnosis|prescription|therapy|salary|payroll|tax return|w-?2|1099|confidential|nda|personal data|pii|phi|hipaa)\b/.test(g);
  const explicit = /\b(sensitive|private data|keep (this|it) (local|private|offline)|don'?t send (this )?to the cloud)\b/.test(g);
  const touches: ModelTouch[] = [];
  if (credential) touches.push("credentials");
  if (identity || personal || explicit) touches.push("user-data");
  return { sensitive: touches.length > 0, touches };
}

/** Research-lane work that is really a cheap skim: summaries, overviews,
 *  "what's in here" exploration. Routed cost-aware (fast/cheap/local-ok). */
export function isExploreOrSummarizeGoal(goal: string): boolean {
  return /\b(summar(y|ize|ise|ies)|tl;?dr|recap|skim|overview|explore|survey|what'?s in|list (the|all) (files|folders|functions)|scan the (repo|codebase|folder)|give me the gist)\b/i.test(goal);
}

/** Shape a router task from the owner lane + goal. This is the policy the
 *  live turn asks the router to judge; keep it in one place. */
export function laneTask(lane: RouteLane, goal: string): ModelTask & { kind: ModelTaskKind } {
  const { sensitive, touches } = detectSensitiveSurface(goal);
  const privacy = sensitive ? "local-preferred" : "cloud-ok";
  const summary = goal.replace(/\s+/g, " ").trim().slice(0, 120);
  switch (lane) {
    case "coding":
      return { kind: "code", quality: "best", privacy, cost: "balanced", latency: "normal", touches, summary };
    case "research":
      return isExploreOrSummarizeGoal(goal)
        ? { kind: "summarization", quality: "fast", privacy: sensitive ? "local-preferred" : "local-preferred", cost: "cheap", latency: "low", touches, summary }
        : { kind: "planning", quality: "best", privacy, cost: sensitive ? "balanced" : "premium-ok", latency: "patient", touches, summary };
    case "tool-use":
      return { kind: "tool-output-summary", touches, summary };
    case "chat":
    default:
      // Plain chat is premium-ok: with a frontier key configured the owner
      // expects it to answer, not a free local 8B — unless the message
      // carries something that should stay on this machine, in which case
      // the privacy bias (and a balanced cost) tips the score local.
      return { kind: "chat", quality: "balanced", privacy, cost: sensitive ? "balanced" : "premium-ok", latency: "normal", touches, summary };
  }
}

export interface LiveProfileOptions {
  /** Families retired for the session (auth/balance deaths). */
  dead?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  /** Families known to be usable beyond what settings/env reveal — the
   *  current live selection, OAuth sign-ins the daemon has verified. */
  extraAuthed?: Iterable<string>;
}

/**
 * Provider profiles for the router, built from what is ACTUALLY configured
 * on this machine rather than the generic DEFAULT_PROVIDER_PROFILES catalog.
 * Family ids are the terminal provider ids (`anthropic`, `ollama`, …) so a
 * route resolves straight into selectProvider(). Ollama's locality follows
 * its host: loopback = local + private; ollama.com = cloud.
 */
export function buildLiveProfiles(settings: UiSettings, opts: LiveProfileOptions = {}): ModelProviderProfile[] {
  const env = opts.env ?? process.env;
  const dead = opts.dead ?? new Set<string>();
  const extra = new Set(opts.extraAuthed ?? []);
  const authed = (family: string, configured: boolean): boolean => !dead.has(family) && (configured || extra.has(family));
  const ollamaApiKey = settings.ollamaApiKey || env.OLLAMA_API_KEY;
  const ollamaHost = env.OLLAMA_HOST ?? (ollamaApiKey ? "https://ollama.com" : "http://127.0.0.1:11434");
  const ollamaLocal = isLocalProviderHost(ollamaHost);
  const customLocal = isLocalProviderHost(settings.customBaseUrl || env.ARES_CUSTOM_BASE_URL);
  const cloud = (family: string, label: string, configured: boolean, costTier: 0 | 1 | 2 | 3, strengths: ModelTaskKind[], vision: boolean, model: string): ModelProviderProfile => ({
    family,
    label,
    locality: "cloud",
    private: false,
    costTier,
    latencyTier: 1,
    available: authed(family, configured),
    capability: { strengths, ceiling: "best", maxContextTokens: 200_000, vision },
    modelClass: model,
  });
  const profiles: ModelProviderProfile[] = [
    cloud("anthropic", "Anthropic", Boolean(settings.anthropicKey || env.ANTHROPIC_API_KEY || env.ARES_ANTHROPIC_API_KEY), 3, ["planning", "code", "review", "chat", "vision", "workshop"], true, defaultTerminalModel("anthropic", settings)),
    cloud("openai", "OpenAI", Boolean(env.ARES_OPENAI_OAUTH_TOKEN || env.OPENAI_API_KEY), 2, ["planning", "review", "code", "chat", "vision"], true, defaultTerminalModel("openai", settings)),
    cloud("deepseek", "DeepSeek", Boolean(settings.deepSeekKey || env.DEEPSEEK_API_KEY), 1, ["code", "planning", "chat", "review"], false, defaultTerminalModel("deepseek", settings)),
    cloud("kimi", "Kimi", Boolean(settings.kimiKey || env.KIMI_API_KEY), 1, ["code", "chat", "planning"], true, settings.lastKimiModel ?? "kimi-for-coding"),
    cloud("openrouter", "OpenRouter", Boolean(settings.openRouterKey), 2, ["planning", "code", "review", "chat", "vision", "workshop"], true, defaultTerminalModel("openrouter", settings)),
    cloud("ares", "Ares Gateway", Boolean(settings.aresGatewayToken || env.ARES_GATEWAY_TOKEN), 2, ["planning", "code", "review", "chat", "vision", "workshop"], true, defaultTerminalModel("ares", settings)),
    {
      family: "ollama",
      label: ollamaLocal ? "Local Ollama" : "Ollama Cloud",
      locality: ollamaLocal ? "local" : "cloud",
      private: ollamaLocal,
      costTier: ollamaLocal ? 0 : 1,
      latencyTier: 1,
      available: authed("ollama", Boolean(settings.lastOllamaModel || env.OLLAMA_HOST || ollamaApiKey || settings.lastProvider === "ollama")),
      capability: ollamaLocal
        ? { strengths: ["chat", "summarization", "memory", "tool-output-summary", "code"], ceiling: "balanced", maxContextTokens: 32_000 }
        : { strengths: ["code", "planning", "chat", "review", "summarization"], ceiling: "best", maxContextTokens: 160_000 },
      modelClass: defaultTerminalModel("ollama", settings),
    },
    {
      family: "custom",
      label: customLocal ? "Local OpenAI-compatible" : "Custom OpenAI-compatible",
      locality: customLocal ? "local" : "cloud",
      private: customLocal,
      costTier: customLocal ? 0 : 1,
      latencyTier: 1,
      available: authed("custom", Boolean(settings.customBaseUrl || env.ARES_CUSTOM_BASE_URL)),
      capability: { strengths: ["chat", "code", "summarization", "tool-output-summary"], ceiling: "balanced", maxContextTokens: 32_000 },
      modelClass: settings.lastCustomModel ?? "",
    },
  ];
  return profiles;
}

export interface LiveRouteInput {
  goal: string;
  lane: RouteLane;
  routingMode: "auto" | "manual";
  /** What owns the conversation right now. */
  current: { family: string; model: string };
  assignments: RouteAssignments;
  settings: UiSettings;
  dead?: ReadonlySet<string>;
  hasImages?: boolean;
  env?: NodeJS.ProcessEnv;
  extraAuthed?: Iterable<string>;
}

export interface LiveRouteResult {
  lane: RouteLane;
  family: string;
  model?: string;
  locality: Locality;
  source: "pinned" | "assigned" | "heuristic";
  reasons: string[];
  warnings: string[];
  /** True only when the route's provider is configured and alive — the
   *  daemon may act on it. Advisory otherwise. */
  executable: boolean;
  /** The route differs from the current selection. */
  switch: boolean;
  sensitive: boolean;
  task: ModelTask;
}

/** Resolve the route for one live turn. Owner assignments win; pins win over lanes. */
export function resolveLiveRoute(input: LiveRouteInput): LiveRouteResult {
  const task = laneTask(input.lane, input.goal);
  const sensitive = (task.touches?.length ?? 0) > 0;
  if (input.routingMode !== "auto") {
    return {
      lane: input.lane,
      family: input.current.family,
      model: input.current.model,
      locality: "cloud",
      source: "pinned",
      reasons: [`manual model selection is a pin — ${input.current.family}/${input.current.model} keeps the turn`],
      warnings: sensitive ? ["sensitive data detected in the request; the pinned model handles it as-is"] : [],
      executable: true,
      switch: false,
      sensitive,
      task,
    };
  }
  const dead = input.dead ?? new Set<string>();
  const profiles = buildLiveProfiles(input.settings, { dead, env: input.env, extraAuthed: [...(input.extraAuthed ?? []), input.current.family] });
  // resolveRoute keys assignments by laneForTask(kind); an explore/summarize
  // goal is scored as "summarization" (→ chat lane) while the OWNER lane stays
  // research, so re-key the owner's pick onto whatever lane the kind maps to.
  const ownerPick = input.assignments[input.lane];
  const rekeyed: RouteAssignments = ownerPick ? { [laneForTask(task.kind)]: ownerPick } : {};
  const resolved = resolveRoute(task, { profiles }, rekeyed);
  const profile = profiles.find((p) => p.family === resolved.family);
  const warnings = [...resolved.warnings];
  const reasons = [...resolved.reasons];
  if (input.hasImages && profile && !profile.capability.vision) {
    warnings.push(`the turn carries an image but ${profile.label} is text-only — the vision guard will detour this turn`);
  }
  if (resolved.source === "assigned" && sensitive && profile?.locality === "cloud") {
    warnings.push(`sensitive data detected (${task.touches?.join("/")}) but the assigned ${profile.label} is a cloud provider — consider a local model for this lane`);
  }
  if (sensitive && resolved.source === "heuristic" && profile?.locality === "local") {
    reasons.push(`sensitive data detected (${task.touches?.join("/")}) — kept on the local, private provider`);
  }
  if (task.kind === "summarization") reasons.push("explore/summarize work — routed cost-aware (fast, cheap)");
  const executable = Boolean(resolved.family) && Boolean(profile?.available) && !dead.has(resolved.family);
  if (resolved.family && !executable) {
    warnings.push(dead.has(resolved.family)
      ? `${resolved.family} is retired for this session — keeping the current model`
      : `${resolved.family} is not configured — keeping the current model`);
  }
  const model = resolved.source === "assigned" ? resolved.model : (profile?.modelClass || undefined);
  return {
    lane: input.lane,
    family: resolved.family,
    model,
    locality: resolved.locality,
    source: resolved.source,
    reasons,
    warnings,
    executable,
    switch: executable && !(resolved.family === input.current.family && (!model || model === input.current.model)),
    sensitive,
    task,
  };
}
