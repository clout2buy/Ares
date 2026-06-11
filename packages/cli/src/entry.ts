#!/usr/bin/env node
// ares — v2 CLI entrypoint.
//
// Commands:
//   ares chat                                      interactive terminal loop
//   ares run --goal "<text>" [--provider openai|ollama] [--model X]
//   ares login                                      OAuth device-code
//   ares doctor                                     auth + ollama health
//   ares help
//
// `run` emits NDJSON for automation; `chat` renders a human terminal loop.

import {
  Session,
  MockEchoProvider,
  OpenAIResponsesProvider,
  OpenRouterProvider,
  OllamaCloudPool,
  DEFAULT_OLLAMA_SLOTS,
  AresSubagentRunner,
  SubagentRegistry,
  ContinuousVerifier,
  HookManager,
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  diffWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  loadStartupReminders,
  buildPromptCacheKey,
  authStatus,
  deviceCodeLogin,
  listSessions,
  loadSessionSnapshot,
  loadAuthToken,
  type EngineTool,
  type ToolCallContext,
  type Provider,
  type SessionSummary,
  aresHome,
  routeModel,
  DEFAULT_PROVIDER_PROFILES,
  type ModelTask,
  type ModelTaskKind,
  type ModelRouteDecision,
  type RiskLevel,
  type PrivacyPosture,
  type QualityNeed,
  type CostPreference,
  type LatencyPreference,
  type ModelTouch,
  sideQueryJson,
  QueryEngine,
} from "@ares/core";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import {
  DEFAULT_TOOLS,
  adaptToolForEngine,
  buildTool,
  makeTodoWriteTool,
  makeTaskTool,
  makeWebFetchTool,
  makeWebSearchTool,
  makeBashOutputTool,
  makeKillShellTool,
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
  ReadTool,
  GlobTool,
  GrepTool,
  EditTool,
  WriteTool,
  ApplyIntentTool,
  MemoryTool,
  TodoStore,
  ShellRegistry,
  type RichToolContext,
  type FileReadStamp,
  type PathAccess,
  type PathGrantScope,
  type PathPermissionStore,
  type CommandPermissionStore,
  type SubModelPool,
} from "@ares/tools";
import type { ContentBlock, PermissionMode, PermissionPromptDecision, PermissionRule, PermissionRuleEffect, ReasoningLevel } from "@ares/protocol";
import { isReasoningLevel, reasoningLabel, REASONING_LEVELS, messageText } from "@ares/protocol";
import type { ToolPermissionRequest, RouteAssignments } from "@ares/core";
import { z } from "zod";
import {
  chatHeader,
  availableThemes,
  dim,
  interactiveHelp,
  notice,
  permissionPrompt,
  promptLabel,
  providerError,
  setTheme,
  themeChanged,
  themesList,
  thinkingPrefix,
  toolEnd,
  toolError,
  toolStart,
  type ThemeName,
} from "./terminalUi.js";
import { runInkChat, type InkChatSnapshot, type InkCommandResult } from "./inkTui.js";
import { runInkLauncher } from "./inkLauncher.js";
import { loadUiSettings, updateUiSettings, type UiSettings } from "./uiSettings.js";

// Ares talks to the LOCAL Ollama daemon (native /api/chat) by default — it
// proxies :cloud models via your `ollama signin`. We do NOT auto-flip into
// Anthropic-compat from stray ANTHROPIC_* env (those are common from other
// tools and would hijack the call into a key-required endpoint → 401). Compat
// is opt-in only via ARES_OLLAMA_ANTHROPIC_COMPAT=1.
const NATIVE_OLLAMA_OPTS = {
  useAnthropicCompat: process.env.ARES_OLLAMA_ANTHROPIC_COMPAT === "1",
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
} as const;
import {
  BootstrapTool,
  AresAgentRuntime,
  MissionTool,
  RunSkillTool,
  SelfEvolveTool,
  SelfTool,
  SkillCraftTool,
  completeBootstrap,
  createMemoryStore,
  aresAgentHome,
  deliberateForTurn,
  recordCardMemoryOnce,
  emitLifecycle,
  ensureAgentScaffold,
  exportHome,
  gainForTarget,
  importHome,
  listSnapshots,
  loadAgentConfig,
  onLifecycle,
  prepareAresAgent,
  restoreSnapshot,
  runDeepDream,
  runRemDream,
  snapshotBrain,
  unifiedRecallForTurn,
  runWitness,
  runHeartbeatTick,
} from "@ares/agent";
import {
  QueryEngineDispatcher,
  acquireCapability,
  attentionItemsFromCapabilities,
  attentionItemsFromGoals,
  capabilityReviewLine,
  capabilityReviewQueue,
  createGoal,
  decideAttention,
  distillMissionCard,
  ensureGoalMissionContract,
  learningCardId,
  learningCardMemoryText,
  listLearningCards,
  loadLearningCard,
  saveLearningCard,
  selectRelevantLessons,
  type LearningCard,
  listGoals,
  loadGoal,
  listAcquisitions,
  listCapabilities,
  listMissionContracts,
  loadCapability,
  loadMissionContract,
  missionContractCanComplete,
  missionContractNextVerificationAction,
  seedNativeCapabilities,
  summarizeContinuity,
  type ContinuitySummary,
  assembleWorldGraph,
  ARES_SUBSYSTEMS,
  type WorldGraph,
  rankBriefing,
  type DailyBriefing,
  newGoalId,
  novelDeltaCurve,
  saveCapability,
  reliabilityOf,
  runGoalToCompletion,
  runEvalSuite,
  parseEvalReportJson,
  saveGoal,
  draftCapability,
  capabilityEvidence,
  missionContractSummary,
  missionContractUnmetRequirements,
  promoteCapability,
  rejectCapabilityDraft,
  verificationSpecSummary,
  runCrucibleTrials,
  TrustGovernor,
  runGauntlet,
  type Goal,
  type CapabilityNode,
  type CapabilityEvidence,
  type MissionContract,
  type AcquisitionKind,
  type EvalReport,
  type EvalTask,
  type VerificationSpec,
} from "@ares/operator";
import { bridgeLegacyEnv, buildForegroundReminder, classifyUserIntent, diagnoseMemory, MemoryStore, mindPaths, type MemoryKind } from "@ares/mind";
import { SessionManager, GarrisonServer, Scheduler, tokenPath, DEFAULT_GARRISON_PORT, type GatewayServerFrame } from "@ares/garrison";
import { buildHolotableHtml } from "./holotable.js";
import {
  Filmstrip,
  clickEffect,
  createPlaywrightBrowser,
  fillEffect,
  navigateEffect,
  type BrowserConnector,
} from "@ares/connectors";
import { Budget, KillSwitch, Ledger, effectsPaths, ownerLeash, runEffect } from "@ares/effects";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  let command = "launcher";
  let rest = argv;
  if (argv[0] && !argv[0].startsWith("--")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}

function printHelp(): void {
  process.stdout.write(
    [
      "ares v0.3.0-alpha.1 — streaming coding-agent harness",
      "",
      "Commands:",
      "  ares launcher                                Open the provider/model launch deck.",
      "  ares chat [--provider openai|ollama|mock] [--model X]",
      "                              Open an interactive terminal prompt.",
      "  ares sessions               List saved workspace sessions.",
      "  ares checkpoints            List workspace checkpoints.",
      "  ares resume [session-id]     Resume a saved session (defaults to latest).",
      "  ares themes                 List terminal UI themes.",
      "  ares run --goal \"<text>\" [--provider openai|ollama|mock] [--model X]",
      "                              Run one turn, streaming TurnEvents as NDJSON.",
      "  ares daemon --json          Run NDJSON daemon mode for companion UIs.",
      "  ares agent bootstrap        Create or complete the v4 mind scaffold.",
      "  ares agent doctor           Show agent memory/backend status.",
      "  ares operator add --goal \"<text>\"    Create a durable long-horizon goal.",
      "                              Optional: --criteria \"A;B\" --constraint \"C\" --verify-file path [--verify-contains text].",
      "  ares operator draft --capability \"<name>\"",
      "                              Draft a capability before promotion.",
      "  ares operator acquire --capability \"email connector\" [--kind connector] [--ticks N]",
      "                              Register a missing capability and create its self-build goal.",
      "  ares operator promote --capability <id> --eval-report report.json [--evidence \"...\"]",
      "                              Promote only after verified outcomes, evidence, and evals.",
      "  ares operator review [--capability <id>] [--json]",
      "                              Inspect capability promotion/rejection status.",
      "  ares operator missions [--json]       Inspect mission contracts.",
      "  ares operator mission status <id> [--json]",
      "                              Inspect one mission contract.",
      "  ares operator list | status [id]     Inspect Operator goals.",
      "  ares operator run [--goal \"<text>\"] [--ticks N] [--provider X]",
      "                              Drive active goals via ephemeral QueryEngine workers.",
      "  ares operator caps | stats | attention [--json]",
      "                              Inspect capabilities, growth curve, and current attention queue.",
      "  ares mind recall \"<cue>\" [--json]   Spreading-activation recall from Living Memory.",
      "  ares mind add --content \"<text>\" [--kind episodic|semantic|procedural]",
      "  ares mind list | doctor | consolidate [--json]",
      "                              Inspect, diagnose, or sleep-consolidate memory.",
      "  ares eval [--json]         Run the built-in harness regression eval suite.",
      "  ares login                  ChatGPT OAuth device-code flow.",
      "  ares doctor                 Show provider auth + Ollama Cloud health.",
      "  ares help                   Print this help.",
      "",
      "Env vars:",
      "  ARES_OPENAI_OAUTH_TOKEN     ChatGPT OAuth access token (bypass file login).",
      "  ARES_REASONER, ARES_APPLY, ARES_SUMMARIZE",
      "                              Override Ollama Cloud slot models.",
      "  ARES_HOME                   Override auth/config dir (default ~/.ares).",
      "  ARES_RESUME_MESSAGES        Max replay messages before compaction (default 80, 0=all).",
      "  ARES_THEME                  UI theme: cyberpunk, minimal, matrix, neon, split, professional, amber, dashboard, light.",
      "",
      "Flags:",
      "  --theme NAME                Use a UI theme for this run.",
      "  --workspace PATH            Run Ares against a specific workspace.",
      "",
      "Double-click ares.bat or run `ares chat` for the interactive prompt.",
      "",
    ].join("\n"),
  );
}

// ─── provider selection ────────────────────────────────────────────────

interface ProviderSelection {
  provider: Provider;
  model: string;
  source: string;
  subModel?: SubModelPool;
}

interface ResumedSessionInfo {
  id: string;
  eventCount: number;
  preview: string;
  replayedMessageCount: number;
  omittedMessageCount: number;
  compacted: boolean;
}

interface LiveSession {
  session: Session;
  selection: ProviderSelection;
  context: CliRuntimeContext;
  runtime: AresRuntimeState;
  verifier: ContinuousVerifier;
  hooks: HookManager;
  shellRegistry: ShellRegistry;
  todoStore: TodoStore;
  agentRuntime?: AresAgentRuntime;
  queueSystemReminder(text: string, source?: ManualReminderSource): void;
  resumed?: ResumedSessionInfo;
  /** V6: living-memory ids injected into the current turn — settled at turn end. */
  lastRecallIds?: string[];
  /** V5: the user message of the current turn, for the Witness snapshot. */
  lastUserMessage?: string;
}

interface AresRuntimeState {
  permissionMode: PermissionMode;
}

interface CliRuntimeContext {
  workspace: string;
  home: string;
  aresHome: string;
  mind: ReturnType<typeof mindPaths>;
  effects: ReturnType<typeof effectsPaths>;
  selfTerritoryRoots: string[];
  browserFilmstripRoot: string;
}

function cliRuntimeContext(options: { workspace?: string; home?: string } = {}): CliRuntimeContext {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const home = aresAgentHome(options.home);
  return {
    workspace,
    home,
    aresHome: aresHome(),
    mind: mindPaths(home),
    effects: effectsPaths(home),
    selfTerritoryRoots: [home],
    browserFilmstripRoot: path.join(home, "operator", "browser", "filmstrip"),
  };
}

interface DaemonInputCommand {
  type?: string;
  goal?: string;
  command?: string;
  level?: string;
  id?: string;
  decision?: string;
  routing?: unknown;
  key?: string;
  model?: string;
}

const ROUTING_LANES = ["chat", "coding", "research", "tool-use"] as const;

/** Normalize the UI's {provider,model} routing table into core's {family,model}. */
function normalizeRoutingCommand(raw: unknown): RouteAssignments {
  const out: RouteAssignments = {};
  if (!raw || typeof raw !== "object") return out;
  for (const lane of ROUTING_LANES) {
    const entry = (raw as Record<string, unknown>)[lane];
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const family = typeof rec.family === "string" ? rec.family : typeof rec.provider === "string" ? rec.provider : "";
      const model = typeof rec.model === "string" ? rec.model : "";
      if (family && model) out[lane] = { family, model };
    }
  }
  return out;
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  shift(): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

class DaemonCommandRouter {
  private commands = new AsyncQueue<DaemonInputCommand>();
  private permissionResponses: DaemonInputCommand[] = [];
  private permissionWaiters: Array<{ id?: string; resolve: (command: DaemonInputCommand | null) => void }> = [];
  private closed = false;

  constructor(private readonly onError: (error: string) => void) {}

  start(rl: ReturnType<typeof createInterface>): void {
    void this.pump(rl);
  }

  nextCommand(): Promise<DaemonInputCommand | null> {
    return this.commands.shift();
  }

  async waitForPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
    const response = await this.takePermissionResponse(request.id);
    if (!response) return "deny";
    const decision = normalizePermissionDecision(response.decision);
    if (!decision) {
      this.onError("permission_response requires decision: allow_once|allow_always|deny");
      return "deny";
    }
    return decision;
  }

  close(): void {
    this.closed = true;
    this.commands.close();
    for (const waiter of this.permissionWaiters.splice(0)) waiter.resolve(null);
  }

  private async pump(rl: ReturnType<typeof createInterface>): Promise<void> {
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let command: DaemonInputCommand;
        try {
          command = JSON.parse(line) as DaemonInputCommand;
        } catch {
          this.onError("invalid JSON command");
          continue;
        }
        if (command.type === "permission_response" || command.type === "permission") {
          this.pushPermissionResponse(command);
        } else {
          this.commands.push(command);
        }
      }
    } finally {
      this.close();
    }
  }

  private pushPermissionResponse(command: DaemonInputCommand): void {
    if (this.closed) return;
    const responseId = cleanCommandId(command.id);
    const waiterIndex = this.permissionWaiters.findIndex((waiter) => {
      if (!waiter.id || !responseId) return true;
      return waiter.id === responseId;
    });
    if (waiterIndex >= 0) {
      const [waiter] = this.permissionWaiters.splice(waiterIndex, 1);
      waiter.resolve(command);
      return;
    }
    this.permissionResponses.push(command);
  }

  private takePermissionResponse(id?: string): Promise<DaemonInputCommand | null> {
    const requestId = cleanCommandId(id);
    const responseIndex = this.permissionResponses.findIndex((command) => {
      const responseId = cleanCommandId(command.id);
      if (!requestId || !responseId) return true;
      return requestId === responseId;
    });
    if (responseIndex >= 0) {
      const [response] = this.permissionResponses.splice(responseIndex, 1);
      return Promise.resolve(response);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.permissionWaiters.push({ id: requestId, resolve }));
  }
}

type ManualReminderSource =
  | "undo"
  | "hook"
  | "memory"
  | "instructions"
  | "heartbeat"
  | "dream"
  | "recall"
  | "self-revise";

async function selectProvider(flags: Map<string, string>): Promise<ProviderSelection> {
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

  if (preferred === "ollama" || !preferred) {
    const slots = {
      ...DEFAULT_OLLAMA_SLOTS,
      reasoner: { model: requestedModel ?? settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model },
    };
    const pool = new OllamaCloudPool({ slots, ...NATIVE_OLLAMA_OPTS });
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

// ─── tool wiring ───────────────────────────────────────────────────────

interface StoredPathGrant {
  path: string;
  access: PathAccess;
}

interface StoredPathPermissions {
  alwaysAllow: StoredPathGrant[];
}

class AresPathPermissionStore implements PathPermissionStore {
  private onceAllow: StoredPathGrant[] = [];

  private constructor(
    private readonly filePath: string,
    private readonly selfRoot: string,
    private readonly persisted: StoredPathPermissions,
  ) {}

  static async load(context: CliRuntimeContext): Promise<AresPathPermissionStore> {
    const filePath = path.join(context.aresHome, "path-permissions.json");
    let persisted: StoredPathPermissions = { alwaysAllow: [] };
    try {
      persisted = JSON.parse(await readFile(filePath, "utf8")) as StoredPathPermissions;
      persisted.alwaysAllow ??= [];
    } catch {
      // First run.
    }
    return new AresPathPermissionStore(filePath, context.home, persisted);
  }

  isAllowed(absPath: string, access: PathAccess): boolean {
    const candidate = path.resolve(absPath);
    if ((access === "read" || access === "write") && pathContains(this.selfRoot, candidate)) {
      return true;
    }
    return [...this.onceAllow, ...this.persisted.alwaysAllow].some(
      (grant) => accessCovers(grant.access, access) && pathContains(grant.path, candidate),
    );
  }

  async grant(absPath: string, access: PathAccess, scope: PathGrantScope): Promise<void> {
    const grant = { path: path.resolve(absPath), access };
    if (scope === "once") {
      this.onceAllow.push(grant);
      return;
    }
    if (!this.persisted.alwaysAllow.some((g) => g.path === grant.path && g.access === grant.access)) {
      this.persisted.alwaysAllow.push(grant);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.persisted, null, 2) + "\n", "utf8");
    }
  }
}

interface StoredCommandPermissions {
  rules?: Array<{
    pattern: string;
    effect: PermissionRuleEffect;
  }>;
}

class AresCommandPermissionStore implements CommandPermissionStore {
  private constructor(private readonly rules: PermissionRule[]) {}

  static async load(context: CliRuntimeContext): Promise<AresCommandPermissionStore> {
    const files = [
      path.join(context.aresHome, "command-permissions.json"),
      path.join(context.workspace, ".ares", "command-permissions.json"),
    ];
    const rules: PermissionRule[] = [];
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, "utf8")) as StoredCommandPermissions;
        for (const rule of json.rules ?? []) {
          rules.push({
            pattern: rule.pattern,
            effect: rule.effect,
            source: file.startsWith(path.join(context.workspace, ".ares")) ? "project" : "user-global",
          });
        }
      } catch {
        // No command rules configured.
      }
    }
    return new AresCommandPermissionStore(rules);
  }

  decide(toolName: string, command: string) {
    const target = `${toolName}(${command})`;
    const rule = [...this.rules].reverse().find((r) => wildcardToRegExp(r.pattern).test(target));
    if (!rule) return null;
    if (rule.effect === "allow") return { kind: "allow" as const, reason: `matched ${rule.pattern}` };
    if (rule.effect === "deny") return { kind: "deny" as const, reason: `${toolName} denied by rule ${rule.pattern}` };
    return {
      kind: "ask" as const,
      prompt: `${toolName} matched command permission rule ${rule.pattern}`,
      suggestion: "allow_once" as const,
    };
  }
}

function accessCovers(granted: PathAccess, requested: PathAccess): boolean {
  if (granted === "all") return true;
  if (granted === requested) return true;
  return granted === "write" && requested === "read";
}

function pathContains(rootPath: string, candidate: string): boolean {
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function wildcardToRegExp(pattern: string): RegExp {
  return new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$", "i");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePermissionDecision(value: unknown): PermissionPromptDecision | null {
  return value === "allow_once" || value === "allow_always" || value === "deny" ? value : null;
}

function cleanCommandId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Sensitive categories that ALWAYS ask the owner, even in the freedom posture.
// Everything else auto-approves so the agent's flow isn't interrupted.
const SENSITIVE_PERMISSION = new RegExp(
  [
    "credential", "secret", "api[ _-]?key", "password", "passphrase", "private key",
    "payment", "purchase", "checkout", "billing", "charge", "credit card", "\\bcard\\b",
    "send (an )?email", "email[_ ]send", "send mail",
    "external account", "log ?in to", "sign ?in to", "oauth",
    "rm -rf /", "wipe", "format disk", "drop database", "force[- ]?push", "delete account",
  ].join("|"),
  "i",
);

function autoPermissionDecision(request: ToolPermissionRequest): PermissionPromptDecision | null {
  const hay = `${request.toolName} ${request.reason}`;
  if (SENSITIVE_PERMISSION.test(hay)) return null; // escalate to the owner
  return "allow_once"; // flow freely
}

async function promptPermission(request: ToolPermissionRequest): Promise<PermissionPromptDecision> {
  process.stderr.write("\n" + permissionPrompt(request));
  const key = await readPermissionKey();
  process.stderr.write(`${key}\n`);
  if (key === "1") return "allow_once";
  if (key === "2") return "allow_always";
  return "deny";
}

async function readPermissionKey(): Promise<"1" | "2" | "3"> {
  const stream = stdin as typeof stdin & {
    setRawMode?: (mode: boolean) => void;
    isRaw?: boolean;
  };
  if (!stdin.isTTY || !stream.setRawMode) {
    return readPermissionLine();
  }

  return new Promise((resolve) => {
    const wasRaw = stream.isRaw === true;
    const cleanup = () => {
      stdin.off("data", onData);
      if (!wasRaw) stream.setRawMode?.(false);
      stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      if (key === "1" || key === "2" || key === "3") {
        cleanup();
        resolve(key);
        return;
      }
      process.stderr.write("\x07");
    };
    stream.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readPermissionLine(): Promise<"1" | "2" | "3"> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    while (true) {
      const answer = (await rl.question("Choose 1, 2, or 3: ")).trim();
      if (answer === "1" || answer === "2" || answer === "3") return answer;
      process.stderr.write("Please enter 1, 2, or 3.\n");
    }
  } finally {
    rl.close();
  }
}

async function buildEngineTools(
  pathPermissions: PathPermissionStore,
  commandPermissions: CommandPermissionStore,
  selection: ProviderSelection,
  runtime: AresRuntimeState,
  context: CliRuntimeContext,
  shellRegistry: ShellRegistry,
  todoStore: TodoStore,
): Promise<EngineTool[]> {
  // Shared per-session state populated by the tool harness.
  const fileReadStamps = new Map<string, FileReadStamp>();
  const enrich = (base: ToolCallContext): RichToolContext => ({
    ...base,
    permissionMode: runtime.permissionMode,
    fileReadStamps,
    pathPermissions,
    commandPermissions,
    shellRegistry,
    todoStore,
    subModel: selection.subModel,
  });

  const baseToolDefs = [
    ...DEFAULT_TOOLS,
    makeTodoWriteTool(todoStore),
    makeWebSearchTool(),
    makeWebFetchTool(selection.subModel),
    makeBashOutputTool(shellRegistry),
    makeKillShellTool(shellRegistry),
    makeEnterPlanModeTool(runtime),
    makeExitPlanModeTool(runtime),
    BootstrapTool,
    SelfEvolveTool,
    SkillCraftTool,
    RunSkillTool,
    MissionTool,
    SelfTool,
  ];

  const baseTools = baseToolDefs.map((tool) => {
    const adapted = adaptToolForEngine(tool, (base: ToolCallContext): RichToolContext => ({
      ...enrich(base),
    }));
    return adapted as EngineTool;
  });

  const runner = new AresSubagentRunner({
    registry: new SubagentRegistry(),
    provider: selection.provider,
    model: selection.model,
    parentTools: baseTools,
    baseSystemPrompt: buildSystemPrompt(runtime.permissionMode, context),
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  const workerTools = [...baseTools, taskTool];
  const livingMindTool = adaptToolForEngine(makeLivingMindTool(context), enrich) as EngineTool;
  const browserTool = adaptToolForEngine(makeBrowserTool(context), enrich) as EngineTool;
  const operatorWorkerTools = [...workerTools, livingMindTool, browserTool];
  const operatorTool = adaptToolForEngine(
    makeOperatorChatTool({
      selection,
      runtime,
      context,
      workerTools: operatorWorkerTools,
    }),
    enrich,
  ) as EngineTool;
  return [...workerTools, livingMindTool, operatorTool, browserTool];
}

const livingMindInput = z
  .object({
    action: z
      .enum(["remember", "recall", "list", "consolidate", "status"])
      .describe("Memory operation to perform."),
    cue: z.string().optional().describe("Recall cue for associative lookup."),
    content: z.string().optional().describe("Memory content to store."),
    kind: z.enum(["episodic", "semantic", "procedural"]).optional().describe("Kind of memory to store."),
    limit: z.number().int().min(1).max(30).optional().describe("Maximum memories/results to return."),
  })
  .strict();

interface LivingMindOutput {
  action: string;
  home: string;
  count?: number;
  result?: unknown;
}

function makeLivingMindTool(context: CliRuntimeContext) {
  return buildTool({
    name: "LivingMind",
    description:
      "Use Ares's V6 Living Memory naturally, with no keyword needed: remember durable facts, recall by association, inspect the mind, and consolidate recurring experiences into semantic knowledge.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: livingMindInput,
    activityDescription: (i) => `LivingMind ${i.action}`,

    async call(i): Promise<{ output: LivingMindOutput; display: string }> {
      const home = context.home;
      const store = await MemoryStore.open(context.mind.memoryFile);
      const limit = i.limit ?? 8;

      if (i.action === "remember") {
        const content = i.content?.trim();
        if (!content) throw new Error("LivingMind remember requires content");
        const node = await store.add({ kind: i.kind ?? "episodic", content, tags: ["chat-tool"] });
        return {
          output: { action: i.action, home, count: store.count(), result: node },
          display: `remembered ${node.kind}: ${compactLine(node.content, 140)}`,
        };
      }

      if (i.action === "recall") {
        const cue = (i.cue ?? i.content)?.trim();
        if (!cue) throw new Error("LivingMind recall requires cue");
        const result = await store.remember(cue, { limit });
        return {
          output: { action: i.action, home, count: store.count(), result },
          display: result.length
            ? `recalled ${result.length}: ${compactLine(result[0].node.content, 140)}`
            : "nothing came to mind",
        };
      }

      if (i.action === "consolidate") {
        const result = await store.consolidate();
        return {
          output: { action: i.action, home, count: store.count(), result },
          display: `consolidated: pruned ${result.pruned}, promoted ${result.promoted.length}, kept ${result.kept}`,
        };
      }

      if (i.action === "status") {
        return {
          output: { action: i.action, home, count: store.count(), result: { memoryFile: context.mind.memoryFile } },
          display: `LivingMind: ${store.count()} memories`,
        };
      }

      const result = store.all().slice(-limit).reverse();
      return {
        output: { action: i.action, home, count: store.count(), result },
        display: `listed ${result.length}/${store.count()} memories`,
      };
    },
  });
}

const verificationInput = z
  .object({
    kind: z.enum(["always", "file", "command", "http"]),
    met: z.boolean().optional(),
    summary: z.string().optional(),
    path: z.string().optional(),
    contains: z.string().optional(),
    cmd: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    expectExit: z.number().int().optional(),
    url: z.string().optional(),
    expectStatus: z.number().int().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const operatorChatInput = z
  .object({
    action: z
      .enum(["create", "run", "acquire", "list", "status", "caps", "stats", "acquisitions"])
      .describe("Operator operation: create/run durable goals, acquire a missing capability, or inspect the competence graph."),
    goal: z.string().optional().describe("Goal statement for create/run."),
    capability: z.string().optional().describe("Missing capability to acquire, e.g. email connector, Shopify connector, Stripe test-mode integration."),
    kind: z.enum(["skill", "connector", "tool", "mcp", "script"]).optional().describe("What kind of surface to build for the missing capability."),
    requires: z.array(z.string()).optional().describe("Reusable subskills this capability composes from."),
    targetFiles: z.array(z.string()).optional().describe("Expected files/skill paths the worker should create or edit."),
    id: z.string().optional().describe("Goal id for status/run."),
    ticks: z.number().int().min(0).max(20).optional().describe("Maximum ticks to run now. For acquire, defaults to 1 so Ares starts building immediately; pass 0 to only queue."),
    verification: verificationInput.optional().describe("Reality probe that decides whether the goal is truly met."),
  })
  .strict();

interface OperatorChatOutput {
  action: string;
  home: string;
  result: unknown;
}

function makeOperatorChatTool(opts: {
  selection: ProviderSelection;
  runtime: AresRuntimeState;
  context: CliRuntimeContext;
  workerTools: readonly EngineTool[];
}) {
  return buildTool({
    name: "Operator",
    description:
      "Ares's durable will and self-acquisition loop. Use it for long-horizon goals that should survive turns, and when a capability is missing use action=acquire to create the build packet, graph node, verification probe, and start a fresh Worker building it.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: operatorChatInput,
    activityDescription: (i) => `Operator ${i.action}`,

    async call(i, ctx): Promise<{ output: OperatorChatOutput; display: string }> {
      const home = opts.context.home;

      if (i.action === "create") {
        const statement = i.goal?.trim();
        if (!statement) throw new Error("Operator create requires goal");
        const goal = createGoal({
          id: i.id ?? newGoalId(),
          statement,
          verification: i.verification ? toVerificationSpec(i.verification) : undefined,
        });
        await saveGoal(home, goal);
        return {
          output: { action: i.action, home, result: goal },
          display: `created durable goal ${goal.id}`,
        };
      }

      if (i.action === "acquire") {
        const capabilityName = (i.capability ?? i.goal)?.trim();
        if (!capabilityName) throw new Error("Operator acquire requires capability or goal");
        const acquired = await acquireCapability({
          home,
          capabilityName,
          kind: i.kind as AcquisitionKind | undefined,
          requires: i.requires,
          targetFiles: i.targetFiles,
          verification: i.verification ? toVerificationSpec(i.verification) : undefined,
        });
        const ticks = i.ticks ?? 1;
        let final: Goal | null = null;
        if (ticks > 0) {
          const dispatcher = new QueryEngineDispatcher({
            provider: opts.selection.provider,
            model: opts.selection.model,
            workspace: ctx.workspace,
            tools: opts.workerTools,
            systemPrompt: buildSystemPrompt(opts.runtime.permissionMode, opts.context),
          });
          final = await runGoalToCompletion(
            {
              home,
              dispatcher,
              workspace: ctx.workspace,
              signal: ctx.signal,
            },
            acquired.goal.id,
            { maxTicks: ticks },
          );
        }
        return {
          output: { action: i.action, home, result: { ...acquired, final } },
          display: final
            ? `acquiring ${capabilityName}: ${acquired.goal.id} -> ${final.status} (${final.progress}/${final.stepLog.length})`
            : `queued acquisition ${acquired.acquisition.id} for ${capabilityName}`,
        };
      }

      if (i.action === "run") {
        let targetId = i.id;
        if (!targetId && i.goal?.trim()) {
          const goal = createGoal({
            id: newGoalId(),
            statement: i.goal.trim(),
            verification: i.verification ? toVerificationSpec(i.verification) : undefined,
          });
          await saveGoal(home, goal);
          targetId = goal.id;
        }
        const active = (await listGoals(home)).filter((g) => g.status === "active");
        const targets = targetId ? active.filter((g) => g.id === targetId) : active;
        if (targets.length === 0) {
          return {
            output: { action: i.action, home, result: [] },
            display: "no active Operator goals matched",
          };
        }
        const dispatcher = new QueryEngineDispatcher({
          provider: opts.selection.provider,
          model: opts.selection.model,
          workspace: ctx.workspace,
          tools: opts.workerTools,
          systemPrompt: buildSystemPrompt(opts.runtime.permissionMode, opts.context),
        });
        const result: Goal[] = [];
        for (const goal of targets) {
          result.push(
            await runGoalToCompletion(
              {
                home,
                dispatcher,
                workspace: ctx.workspace,
                signal: ctx.signal,
              },
              goal.id,
              { maxTicks: i.ticks ?? 1 },
            ),
          );
        }
        return {
          output: { action: i.action, home, result },
          display: result.map((g) => `${g.id} -> ${g.status} (${g.progress}/${g.stepLog.length})`).join("; "),
        };
      }

      if (i.action === "status") {
        const goals = await listGoals(home);
        const result = i.id ? goals.find((g) => g.id === i.id) ?? null : goals[0] ?? null;
        return {
          output: { action: i.action, home, result },
          display: result ? `${result.id}: ${result.status} - ${compactLine(result.statement, 120)}` : "no goals found",
        };
      }

      if (i.action === "list") {
        const result = await listGoals(home);
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} Operator goals`,
        };
      }

      if (i.action === "acquisitions") {
        const result = await listAcquisitions(home);
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} acquisition packet(s)`,
        };
      }

      if (i.action === "caps") {
        const caps = await listCapabilities(home);
        const result = caps.map((c) => ({
          ...c,
          reliability: reliabilityOf(c),
        }));
        return {
          output: { action: i.action, home, result },
          display: `listed ${result.length} learned capabilities`,
        };
      }

      const caps = await listCapabilities(home);
      const mastered = caps.filter((c) => c.status === "mastered").length;
      const result = { total: caps.length, mastered, curve: novelDeltaCurve(caps) };
      return {
        output: { action: i.action, home, result },
        display: `${caps.length} capabilities, ${mastered} mastered`,
      };
    },
  });
}

type VerificationInput = z.infer<typeof verificationInput>;

function toVerificationSpec(input: VerificationInput): VerificationSpec {
  if (input.kind === "always") {
    return { kind: "always", met: input.met ?? false, summary: input.summary };
  }
  if (input.kind === "file") {
    if (!input.path) throw new Error("file verification requires path");
    return { kind: "file", path: input.path, contains: input.contains };
  }
  if (input.kind === "command") {
    if (!input.cmd) throw new Error("command verification requires cmd");
    return {
      kind: "command",
      cmd: input.cmd,
      args: input.args,
      cwd: input.cwd,
      expectExit: input.expectExit,
      timeoutMs: input.timeoutMs,
    };
  }
  if (!input.url) throw new Error("http verification requires url");
  return {
    kind: "http",
    url: input.url,
    expectStatus: input.expectStatus,
    contains: input.contains,
    timeoutMs: input.timeoutMs,
  };
}

const browserInput = z
  .object({
    action: z
      .enum(["open", "tree", "screenshot", "fill", "click", "state", "close", "filmstrip"])
      .describe("Browser action to perform through the DOM-first connector."),
    url: z.string().optional().describe("URL for open."),
    label: z.string().optional().describe("Accessible label for fill."),
    value: z.string().optional().describe("Value for fill."),
    role: z.string().optional().describe("ARIA role for click."),
    name: z.string().optional().describe("Accessible name for click."),
    headless: z.boolean().optional().describe("Run the browser headless (invisible). DEFAULT true and STRONGLY preferred — the owner does NOT want to watch navigation. Only pass false when the owner EXPLICITLY asks to watch / 'open a browser' / 'show me live'. For 'find/look up/send me' requests, stay headless and return the findings (image URLs render inline in chat)."),
    note: z.string().optional().describe("Optional note attached to screenshot frames."),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum tree/filmstrip entries returned."),
  })
  .strict();

interface BrowserToolOutput {
  action: string;
  status: string;
  result?: unknown;
  filmstripDir: string;
}

function makeBrowserTool(context: CliRuntimeContext) {
  let browser: BrowserConnector | null = null;
  let filmstrip: Filmstrip | null = null;
  let sequence = 0;

  const ensureBrowser = async (headless?: boolean): Promise<BrowserConnector> => {
    if (!browser) browser = await createPlaywrightBrowser({ headless: headless ?? true });
    return browser;
  };

  const ensureFilmstrip = (): Filmstrip => {
    if (!filmstrip) {
      const dir = path.join(context.browserFilmstripRoot, `${new Date().toISOString().slice(0, 10)}-${process.pid}`);
      filmstrip = new Filmstrip(dir);
    }
    return filmstrip;
  };

  return buildTool({
    name: "Browser",
    description:
      "Ares's DOM-first eyes and hands for the web. Use APIs/MCP/CLI first when better, then this browser connector to open pages, inspect the accessibility tree, fill forms, click controls, screenshot, and record visual proof. Run HEADLESS by default (the owner does not want to see the browser) — only open it visibly (headless:false) when they explicitly ask to watch. When the task is to find/show images, gather the image URLs and put them in your reply; the chat renders image URLs as inline pictures.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: browserInput,
    activityDescription: (i) => {
      const host = (u?: string) => {
        if (!u) return "a page";
        try {
          return new URL(u.includes("://") ? u : `https://${u}`).host.replace(/^www\./, "");
        } catch {
          return u;
        }
      };
      if (i.action === "open") return `Opening ${host(i.url)}`;
      if (i.action === "tree") return "Reading the page";
      if (i.action === "screenshot" || i.action === "filmstrip") return "Capturing the screen";
      if (i.action === "fill") return i.label ? `Filling “${i.label}”` : "Filling a field";
      if (i.action === "click") return i.name ? `Clicking “${i.name}”` : "Clicking a control";
      if (i.action === "state") return "Checking the page state";
      if (i.action === "close") return "Closing the browser";
      return "Browsing the web";
    },

    async call(i): Promise<{ output: BrowserToolOutput; display: string }> {
      const strip = ensureFilmstrip();

      if (i.action === "filmstrip") {
        const result = (await strip.load()).slice(-(i.limit ?? 20));
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `filmstrip ${result.length} frame(s)`,
        };
      }

      if (i.action === "close") {
        if (browser) await browser.close();
        browser = null;
        return {
          output: { action: i.action, status: "closed", filmstripDir: filmstripDir(strip) },
          display: "browser closed",
        };
      }

      const br = await ensureBrowser(i.headless);

      if (i.action === "tree") {
        const result = (await br.accessibilityTree()).slice(0, i.limit ?? 80);
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `accessibility tree: ${result.length} node(s)`,
        };
      }

      if (i.action === "state") {
        const result = await br.state();
        return {
          output: { action: i.action, status: "ok", result, filmstripDir: filmstripDir(strip) },
          display: `${result.title ?? "(untitled)"} ${result.url}`,
        };
      }

      if (i.action === "screenshot") {
        const [shot, state] = await Promise.all([br.screenshot(), br.state()]);
        const frame = await strip.record({ action: "manual screenshot", url: state.url, screenshot: shot, note: i.note });
        return {
          output: { action: i.action, status: "ok", result: frame, filmstripDir: filmstripDir(strip) },
          display: `screenshot frame ${frame.frame}`,
        };
      }

      const rails = await browserRailsContext(context);
      const idemPrefix = `browser:${process.pid}:${Date.now()}:${sequence++}`;
      if (i.action === "open") {
        if (!i.url) throw new Error("Browser open requires url");
        const effect = navigateEffect(br, i.url, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
          display: `open ${i.url}: ${result.status}`,
        };
      }

      if (i.action === "fill") {
        if (!i.label) throw new Error("Browser fill requires label");
        if (i.value === undefined) throw new Error("Browser fill requires value");
        const effect = fillEffect(br, i.label, i.value, { filmstrip: strip, idemPrefix });
        const result = await runEffect(effect, rails);
        return {
          output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
          display: `fill ${i.label}: ${result.status}`,
        };
      }

      if (!i.role || !i.name) throw new Error("Browser click requires role and name");
      const effect = clickEffect(br, i.role, i.name, { filmstrip: strip, idemPrefix });
      const result = await runEffect(effect, rails);
      return {
        output: { action: i.action, status: result.status, result, filmstripDir: filmstripDir(strip) },
        display: `click ${i.role}:${i.name}: ${result.status}`,
      };
    },
  });
}

/**
 * V8 — which leash governs outward effects:
 *   unleashed (default): the owner's dial, wide open (ownerLeash).
 *   guarded (dangerousBypass: false): autonomy is EARNED — the TrustGovernor
 *   derives each domain's leash from the Crucible (confirmed procedures with
 *   net-positive records), and every level change lands in leash.jsonl next to
 *   the effects ledger with the evidence that justified it.
 */
async function resolveLeash(context: CliRuntimeContext): Promise<(domain: string) => number> {
  const settings = await loadUiSettings();
  if (settings.dangerousBypass !== false) return ownerLeash();
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const leashLog = path.join(context.effects.effectsDir, "leash.jsonl");
    const governor = new TrustGovernor({
      nodes: () => store.all(),
      append: (change) => appendFile(leashLog, JSON.stringify(change) + "\n").catch(() => undefined),
    });
    return (domain) => governor.leashOf(domain);
  } catch {
    // No readable memory: guarded mode falls back to the shortest leash.
    return ownerLeash({ trust: 1 });
  }
}

async function browserRailsContext(context: CliRuntimeContext) {
  const paths = context.effects;
  return {
    ledger: await Ledger.open(paths.ledgerFile),
    budget: new Budget(),
    killSwitch: new KillSwitch(paths.killSwitchFile),
    leashOf: await resolveLeash(context),
  };
}

function filmstripDir(strip: Filmstrip): string {
  return (strip as unknown as { dir?: string }).dir ?? "filmstrip";
}

function compactLine(text: string, limit: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : `${one.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * C1 — the end-of-turn gate, composed: flush+await the continuous verifier,
 * then hand any red verdicts to the engine, which injects them and keeps the
 * turn alive. The model cannot say "done" while its own edits are broken.
 */
async function confirmTurnEndWith(
  verifier: ContinuousVerifier,
): Promise<Array<{ text: string; source: "verifier" | "hook" }>> {
  await verifier.settle(10_000);
  return verifier
    .drainReminders()
    .map((r) => ({ text: `${r.text}

Fix this before finishing — your edits this turn caused it.`, source: "verifier" as const }));
}

async function createSession(
  args: ParsedArgs,
  resumeSessionId?: string,
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision> = promptPermission,
): Promise<LiveSession> {
  const selection = await selectProvider(args.flags);
  return createSessionWithSelection(args, selection, resumeSessionId, requestPermission);
}

// The reasoning dial the owner controls. Precedence: env override → persisted
// setting → "medium" (snappy-but-capable; a fresh session never burns minutes
// thinking on a trivial "hi", and the owner can crank it to high/max). Works
// for OpenAI (effort) and Ollama (thinking budget) alike — the providers
// translate it. The context budget trims oldest history so a long thread or a
// vision message can never hard-fail with context_length_exceeded.
function resolveReasoningLevel(settings: UiSettings): ReasoningLevel {
  const env = process.env.ARES_REASONING_LEVEL?.toLowerCase();
  if (isReasoningLevel(env)) return env;
  if (isReasoningLevel(settings.reasoningLevel)) return settings.reasoningLevel;
  return "medium";
}
function chatContextBudget(selection: ProviderSelection): number {
  const env = Number(process.env.ARES_CONTEXT_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (selection.provider.name.startsWith("ollama-cloud")) return 24_000;
  return 64_000;
}
function chatMaxOutputTokens(): number {
  return Number(process.env.ARES_MAX_OUTPUT_TOKENS) || 8192;
}

async function createSessionWithSelection(
  _args: ParsedArgs,
  selection: ProviderSelection,
  resumeSessionId?: string,
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision> = promptPermission,
): Promise<LiveSession> {
  const context = cliRuntimeContext();
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const settings = await loadUiSettings();
  // Unleashed by default — this is the owner's own agent on the owner's machine
  // (the M0 posture: permissive default, owner holds the dial). Tool calls run
  // without a permission ritual; the genuinely-useful safety net stays on
  // (pre-write undo checkpoints, the kill switch, and the effects ledger for
  // irreversible OUTWARD actions). The owner can re-guard anytime with /code or
  // /plan, which persists `dangerousBypass: false`.
  const guarded = settings.dangerousBypass === false;
  const runtime: AresRuntimeState = { permissionMode: guarded ? "workspace-write" : "bypass" };
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  const verifier = new ContinuousVerifier({
    workspace: context.workspace,
    onEvent: (event) => {
      void event;
    },
  });
  const hooks = await HookManager.load(context.workspace);
  await hooks.run({ event: "SessionStart", workspace: context.workspace });
  const startupReminders = await loadStartupReminders(context.workspace);
  const isMockProvider = selection.provider.name === "mock" || selection.provider.name.startsWith("mock-");
  const agentEnabled =
    process.env.ARES_AGENT_ENABLED === "1" ||
    (!isMockProvider && process.env.ARES_AGENT_ENABLED !== "0");
  const agent = await prepareAresAgent({
    workspace: context.workspace,
    enabled: agentEnabled,
  });
  startupReminders.push(...agent.startupReminders);
  const manualReminders: Array<{ text: string; source: ManualReminderSource }> = [];
  const queueSystemReminder = (text: string, source: ManualReminderSource = "hook") => {
    manualReminders.push({ text, source });
  };
  const drainSystemReminders = () => [
    ...startupReminders.splice(0),
    ...manualReminders.splice(0),
    ...verifier.drainReminders(),
    ...hooks.drainReminders(),
  ];
  const tools = await buildEngineTools(
    pathPermissions,
    commandPermissions,
    selection,
    runtime,
    context,
    shellRegistry,
    todoStore,
  );
  await seedNativeCapabilities(context.home).catch(() => undefined);
  const systemPrompt =
    agent.composeSystemPrompt(buildSystemPrompt(runtime.permissionMode, context)) + (await loadLiveMindContext(context));
  if (resumeSessionId) {
    const snapshot = await loadSessionSnapshot(context.workspace, resumeSessionId, {
      maxMessages: resumeMessageLimit(),
    });
    const session = new Session({
      workspace: context.workspace,
      provider: selection.provider,
      model: selection.model,
      systemPrompt,
      tools,
      requestPermission,
      drainSystemReminders,
      confirmTurnEnd: () => confirmTurnEndWith(verifier),
      hookManager: hooks,
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialSeq: snapshot.nextSeq,
      selfTerritoryRoots: context.selfTerritoryRoots,
      reasoningLevel: resolveReasoningLevel(settings),
      maxOutputTokens: chatMaxOutputTokens(),
      contextBudgetTokens: chatContextBudget(selection),
    });
    const live: LiveSession = {
      session,
      selection,
      context,
      resumed: {
        id: snapshot.meta.id,
        eventCount: snapshot.eventCount,
        preview: snapshot.preview,
        replayedMessageCount: snapshot.replayedMessageCount,
        omittedMessageCount: snapshot.omittedMessageCount,
        compacted: snapshot.compacted,
      },
      runtime,
      verifier,
      hooks,
      shellRegistry,
      todoStore,
      queueSystemReminder,
    };
    live.agentRuntime = new AresAgentRuntime(agent, {
      workspace: context.workspace,
      sessionId: session.meta.id,
      queueReminder: (text, source) => queueSystemReminder(text, source),
    });
    live.agentRuntime.start();
    return live;
  }
  const session = new Session({
    workspace: context.workspace,
    provider: selection.provider,
    model: selection.model,
    systemPrompt,
    tools,
    requestPermission,
    drainSystemReminders,
    confirmTurnEnd: () => confirmTurnEndWith(verifier),
    hookManager: hooks,
    selfTerritoryRoots: context.selfTerritoryRoots,
    reasoningLevel: resolveReasoningLevel(settings),
    maxOutputTokens: chatMaxOutputTokens(),
    contextBudgetTokens: chatContextBudget(selection),
  });
  const live: LiveSession = { session, selection, context, runtime, verifier, hooks, shellRegistry, todoStore, queueSystemReminder };
  live.agentRuntime = new AresAgentRuntime(agent, {
    workspace: context.workspace,
    sessionId: session.meta.id,
    queueReminder: (text, source) => queueSystemReminder(text, source),
  });
  live.agentRuntime.start();
  return live;
}

async function resolveResumeSessionId(target?: string, context = cliRuntimeContext()): Promise<string | undefined> {
  if (!target || target === "false") return undefined;
  if (target === "true" || target === "last" || target === "latest") {
    const [latest] = await listSessions(context.workspace, 1);
    return latest?.id;
  }
  return target;
}

async function requireResumeSessionId(target?: string, context = cliRuntimeContext()): Promise<string> {
  const sessionId = await resolveResumeSessionId(target ?? "last", context);
  if (!sessionId) throw new Error("no saved sessions in this workspace");
  return sessionId;
}

function sessionSummaryLine(session: SessionSummary): string {
  const provider = `${session.provider.name}:${session.provider.model}`;
  const preview = session.preview || "(no user text)";
  const updated = new Date(session.updatedAt).toLocaleString();
  return `${session.id}  ${provider}  ${session.eventCount} events  ${updated}  ${preview}`;
}

async function printSessions(limit = 20, context = cliRuntimeContext()): Promise<SessionSummary[]> {
  const sessions = await listSessions(context.workspace, limit);
  if (sessions.length === 0) {
    process.stdout.write(notice("Sessions", ["No saved sessions in this workspace yet."], "warn"));
    return sessions;
  }
  process.stdout.write(notice("Sessions", sessions.map(sessionSummaryLine), "info"));
  return sessions;
}

function printResumed(resumed: ResumedSessionInfo): void {
  const lines = [
    `id ${resumed.id}`,
    `${resumed.eventCount} replayed event(s)`,
    `${resumed.replayedMessageCount} message(s) hydrated into model context`,
  ];
  if (resumed.compacted) lines.push(`${resumed.omittedMessageCount} older message(s) compacted into a replay summary`);
  if (resumed.preview) lines.push(`last user message: ${resumed.preview}`);
  process.stdout.write(notice("Resumed Session", lines, "success"));
}

function resumedLines(resumed: ResumedSessionInfo): string[] {
  const lines = [
    `Resumed ${resumed.id}`,
    `${resumed.eventCount} replayed event(s)`,
    `${resumed.replayedMessageCount} message(s) hydrated into model context`,
  ];
  if (resumed.compacted) lines.push(`${resumed.omittedMessageCount} older message(s) compacted into a replay summary`);
  if (resumed.preview) lines.push(`last user message: ${resumed.preview}`);
  return lines;
}

function inkHelpLines(): string[] {
  return [
    "/help                  Show this help.",
    "/doctor                Provider and runtime status.",
    "/themes                Show installed UI themes.",
    "/theme <name>          Switch theme without restarting.",
    "/sessions              List saved .ares sessions for this workspace.",
    "/plan                  Enter read-only planning mode.",
    "/code                  Exit planning mode and allow workspace writes.",
    "/danger                Toggle bypass mode for tool prompts.",
    "/checkpoints           List local workspace checkpoints.",
    "/checkpoint-diff <id>  Compare current workspace to a checkpoint.",
    "/undo [N]              Restore the latest pre-write checkpoint.",
    "/rollback <id>         Restore a checkpoint snapshot.",
    "/resume [id|last]      Replay a saved session into model context.",
    "/workspace <path>      Switch the active workspace for tool calls.",
    "/exit                  Close Ares.",
  ];
}

function themeLines(): string[] {
  return availableThemes().map((name) => `${name}${name === currentThemeNameSafe() ? " (active)" : ""}`);
}

function currentThemeNameSafe(): string {
  try {
    return process.env.ARES_THEME ?? "amber";
  } catch {
    return "amber";
  }
}

async function sessionsLines(limit = 20, context = cliRuntimeContext()): Promise<string[]> {
  const sessions = await listSessions(context.workspace, limit);
  if (sessions.length === 0) return ["No saved sessions in this workspace yet."];
  return sessions.map(sessionSummaryLine);
}

async function doctorSummaryLines(): Promise<string[]> {
  const auth = await authStatus();
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS, ...NATIVE_OLLAMA_OPTS });
  const health = await pool.health();
  return [
    `OpenAI auth configured: ${auth.configured ? "yes" : "no"}`,
    `OpenAI auth mode: ${auth.mode}`,
    `OpenAI auth source: ${auth.source}`,
    ...(auth.email ? [`OpenAI email: ${auth.email}`] : []),
    `Ollama host: ${health.host}`,
    `Ollama reachable: ${health.reachable ? "yes" : "no"}`,
    `Ollama available models: ${health.availableModels.length}`,
    ...health.slots.map((slot) => `${slot.name}: ${slot.model} ${slot.present ? "[present]" : "[missing]"}`),
  ];
}

async function checkpointLines(context = cliRuntimeContext()): Promise<string[]> {
  const checkpoints = await listWorkspaceCheckpoints(context.workspace);
  if (checkpoints.length === 0) return ["No checkpoints in this workspace yet."];
  return checkpoints
    .slice(0, 20)
    .map((cp) => `${cp.id}  ${cp.createdAt}  ${cp.fileManifest.length} files${cp.label ? `  ${cp.label}` : ""}`);
}

async function checkpointDiffLines(id: string, context = cliRuntimeContext()): Promise<string[]> {
  if (!id) return ["Usage: /checkpoint-diff <id>"];
  try {
    const diff = await diffWorkspaceCheckpoint(context.workspace, id);
    return [
      `added: ${diff.added.length}`,
      ...diff.added.slice(0, 20).map((f) => `+ ${f}`),
      `modified: ${diff.modified.length}`,
      ...diff.modified.slice(0, 20).map((f) => `~ ${f}`),
      `deleted: ${diff.deleted.length}`,
      ...diff.deleted.slice(0, 20).map((f) => `- ${f}`),
    ];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

async function rollbackLines(id: string, context = cliRuntimeContext()): Promise<string[]> {
  if (!id) return ["Usage: /rollback <checkpoint-id>"];
  try {
    const result = await restoreWorkspaceCheckpoint(context.workspace, id);
    return [`restored ${result.restored} file(s)`, `deleted ${result.deleted} file(s)`];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

async function undoLines(live: LiveSession, rawDepth = ""): Promise<string[]> {
  const depth = rawDepth.trim() ? Number(rawDepth.trim()) : 1;
  if (!Number.isInteger(depth) || depth < 1) return ["Usage: /undo [N]"];
  const checkpoints = await listWorkspaceCheckpoints(live.context.workspace);
  const target = checkpoints[depth - 1];
  if (!target) return [`No checkpoint ${depth} step(s) back.`];
  try {
    const result = await restoreWorkspaceCheckpoint(live.context.workspace, target.id);
    live.queueSystemReminder(
      `User invoked /undo ${depth}. Restored workspace to checkpoint ${target.id}. Re-read affected files before editing again.`,
      "undo",
    );
    return [
      `undid to ${target.id}`,
      `restored ${result.restored} file(s)`,
      `deleted ${result.deleted} file(s)`,
    ];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

function resumeMessageLimit(): number | undefined {
  const raw = process.env.ARES_RESUME_MESSAGES;
  if (!raw) return 80;
  if (raw === "0" || raw.toLowerCase() === "all") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(8, Math.floor(parsed));
}

async function loadSavedTheme(): Promise<void> {
  const settings = await loadUiSettings();
  if (settings.theme) setTheme(settings.theme);
}

async function saveTheme(name: string): Promise<void> {
  await updateUiSettings({ theme: name as ThemeName });
}

async function contentFromUserInput(text: string, workspace: string): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  const seen = new Set<string>();
  const dataUrlRe = /data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)/gi;
  for (const match of text.matchAll(dataUrlRe)) {
    const key = match[0].slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    content.push({ type: "image", source: { kind: "base64", mediaType: match[1].toLowerCase(), data: match[2] } });
  }

  for (const candidate of imagePathCandidates(text)) {
    const resolved = path.resolve(workspace, candidate);
    if (seen.has(resolved)) continue;
    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile() || info.size > 15 * 1024 * 1024) continue;
    const mediaType = mediaTypeForPath(resolved);
    if (!mediaType) continue;
    const bytes = await readFile(resolved);
    seen.add(resolved);
    content.push({ type: "image", source: { kind: "base64", mediaType, data: bytes.toString("base64") } });
  }

  const stripped = text.replace(dataUrlRe, "[attached image]").trim();
  content.unshift({ type: "text", text: stripped || "Please inspect the attached image." });
  return content;
}

function imagePathCandidates(text: string): string[] {
  const out: string[] = [];
  const quoted = /["']([^"']+\.(?:png|jpe?g|webp|gif))["']/gi;
  for (const match of text.matchAll(quoted)) out.push(match[1]);
  const bare = /(?:^|\s)(@?(?:[A-Za-z]:\\|\.{1,2}[\\/]|[A-Za-z0-9_.-]+[\\/])[^"'<>|?*\s]+\.(?:png|jpe?g|webp|gif))/gi;
  for (const match of text.matchAll(bare)) out.push(match[1].replace(/^@/, ""));
  return out;
}

function mediaTypeForPath(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return null;
}

function legacyProgressText(data: unknown): string | null {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : null;
  const obj = data as Record<string, unknown>;
  if (obj.kind === "shell_output") {
    const text = String(obj.text ?? "").trimEnd();
    return text ? `${obj.stream ?? "stdout"} ${text}`.slice(0, 240) : null;
  }
  if (obj.kind === "grep_match") return `grep ${obj.total ?? "?"} match(es)`;
  if (obj.kind === "lsp_init") return `starting ${obj.server ?? "LSP"}`;
  if (obj.kind === "lsp_ready") return `${obj.server ?? "LSP"} ready`;
  return JSON.stringify(obj).slice(0, 240);
}

function colorUnifiedDiff(diff: string): string {
  const color = process.env.NO_COLOR ? false : Boolean(process.stderr.isTTY);
  const paint = (code: string, text: string) => (color ? `${code}${text}\x1b[0m` : text);
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return paint("\x1b[32m", line);
      if (line.startsWith("-") && !line.startsWith("---")) return paint("\x1b[31m", line);
      if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return paint("\x1b[36m", line);
      return dim(line);
    })
    .join("\n") + "\n";
}

function usageMeter(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }, durationMs: number): string {
  const cached = usage.cacheReadTokens ?? 0;
  const denom = usage.inputTokens + cached;
  const cachePct = denom > 0 ? Math.round((cached / denom) * 100) : 0;
  const inputPerM = Number(process.env.ARES_COST_INPUT_PER_MTOK ?? 0);
  const outputPerM = Number(process.env.ARES_COST_OUTPUT_PER_MTOK ?? 0);
  const cost =
    Number.isFinite(inputPerM) && Number.isFinite(outputPerM) && (inputPerM > 0 || outputPerM > 0)
      ? `$${(((Math.max(0, usage.inputTokens - cached) / 1_000_000) * inputPerM) + ((usage.outputTokens / 1_000_000) * outputPerM)).toFixed(4)}`
      : "$n/a";
  return `${cost} / ${Math.round(durationMs / 1000)}s / ${usage.inputTokens + usage.outputTokens} tokens / ${cachePct}% cached`;
}

// ─── commands ──────────────────────────────────────────────────────────

async function runCommand(args: ParsedArgs): Promise<number> {
  const goal = args.flags.get("goal");
  if (!goal) {
    process.stderr.write("error: --goal is required\n");
    return 2;
  }

  let live: LiveSession;
  try {
    live = await createSession(args);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  process.stderr.write(
    `ares: provider=${live.selection.provider.name} model=${live.selection.model} source=${live.selection.source} session=${live.session.meta.id}\n`,
  );

  const unsubLifecycle = onLifecycle((event) => {
    try {
      process.stdout.write(JSON.stringify({ type: "lifecycle", event }) + "\n");
    } catch {
      // ignore
    }
  });
  await prepareUserTurn(live, goal);
  let finalStatus: "completed" | "interrupted" | "failed" = "completed";
  for await (const event of live.session.sendContent(await contentFromUserInput(goal, live.context.workspace))) {
    if (event.type === "tool_end" && event.touchedFiles?.length) {
      live.verifier.scheduleFor(event.touchedFiles);
    }
    if (event.type === "turn_end") finalStatus = event.status;
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  // Keep turn_end as the final NDJSON line for downstream consumers — unsubscribe
  // before the post-turn / session-end hooks fire any additional lifecycle events.
  unsubLifecycle();
  await finishTurn(live, finalStatus);
  await live.agentRuntime?.sessionEnded();
  live.agentRuntime?.stop();
  return 0;
}

async function daemonCommand(args: ParsedArgs): Promise<number> {
  if (args.flags.get("json") !== "true" && !args.flags.has("json")) {
    process.stderr.write("error: daemon currently requires --json\n");
    return 2;
  }
  const rl = createInterface({ input: stdin, output: stderr, terminal: false });
  const commands = new DaemonCommandRouter((error) => {
    process.stdout.write(JSON.stringify({ type: "daemon_error", error }) + "\n");
  });
  commands.start(rl);
  let live: LiveSession;
  try {
    // Desktop posture: give the agent real freedom so the flow isn't constantly
    // interrupted. Low-risk actions (web/browser/read/search/most tool use)
    // auto-approve; only genuinely sensitive ones (credentials, payments,
    // sending email, external accounts, destructive wipes) still ask the owner.
    const requestPermission = (request: ToolPermissionRequest): Promise<PermissionPromptDecision> => {
      const auto = autoPermissionDecision(request);
      return auto ? Promise.resolve(auto) : commands.waitForPermission(request);
    };
    live = await createSession(args, undefined, requestPermission);
  } catch (err) {
    commands.close();
    rl.close();
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  process.stdout.write(
    JSON.stringify({ type: "daemon_ready", sessionId: live.session.meta.id, reasoningLevel: resolveReasoningLevel(await loadUiSettings()) }) + "\n",
  );

  // Bridge lifecycle events (Bootstrap, SelfEvolve, capture, recall, dream,
  // skill_crafted, etc.) out as NDJSON so the Tauri shell can render +N
  // score popups and entity-status indicators. These are separate from the
  // per-turn TurnEvent stream — they're agent-evolution telemetry.
  let lifecycleOpen = false;
  const unsubscribeLifecycle = onLifecycle((event) => {
    if (!lifecycleOpen) return;
    try {
      process.stdout.write(JSON.stringify({ type: "lifecycle", event }) + "\n");
    } catch {
      // never let lifecycle bridging crash the daemon
    }
  });
  try {
    while (true) {
      const command = await commands.nextCommand();
      if (!command) break;
      if (command.type === "exit") break;
      if (command.type === "reasoning") {
        const level = command.level?.toLowerCase();
        if (!isReasoningLevel(level)) {
          process.stdout.write(JSON.stringify({ type: "daemon_error", error: "reasoning requires level: low|medium|high|max" }) + "\n");
          continue;
        }
        live.session.setReasoningLevel(level);
        await updateUiSettings({ reasoningLevel: level });
        process.stdout.write(JSON.stringify({ type: "reasoning_set", level }) + "\n");
        continue;
      }
      if (command.type === "routing") {
        // Owner per-lane model assignments. Normalize {provider,model} → {family,model}
        // and persist; the live turn resolves via @ares/core resolveRoute().
        const routing = normalizeRoutingCommand(command.routing);
        await updateUiSettings({ routing });
        process.stdout.write(JSON.stringify({ type: "routing_set", routing }) + "\n");
        continue;
      }
      if (command.type === "openrouter_key") {
        // Persist the owner's OpenRouter key (+ optional default model). Applied
        // the next time the daemon starts on the openrouter provider.
        const patch: Partial<UiSettings> = { openRouterKey: typeof command.key === "string" ? command.key.trim() : "" };
        if (typeof command.model === "string" && command.model.trim()) patch.lastOpenRouterModel = command.model.trim();
        await updateUiSettings(patch);
        process.stdout.write(JSON.stringify({ type: "openrouter_key_set", hasKey: Boolean(patch.openRouterKey) }) + "\n");
        continue;
      }
      if (command.type !== "send" || !command.goal) {
        process.stdout.write(JSON.stringify({ type: "daemon_error", error: "expected {type:\"send\", goal:string}" }) + "\n");
        continue;
      }
      lifecycleOpen = true;
      await prepareUserTurn(live, command.goal);
      let finalStatus: "completed" | "interrupted" | "failed" = "completed";
      for await (const event of live.session.sendContent(await contentFromUserInput(command.goal, live.context.workspace))) {
        if (event.type === "turn_end") finalStatus = event.status;
        process.stdout.write(JSON.stringify(event) + "\n");
      }
      lifecycleOpen = false;
      await finishTurn(live, finalStatus);
    }
  } finally {
    lifecycleOpen = false;
    commands.close();
    rl.close();
    unsubscribeLifecycle();
    await live.agentRuntime?.sessionEnded();
    await mindSessionEnded();
    live.agentRuntime?.stop();
    rl.close();
  }
  return 0;
}

async function agentCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "doctor";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  if (subcommand === "bootstrap") {
    const shouldComplete = args.flags.has("user") || args.flags.has("name");
    if (!shouldComplete) {
      const state = await ensureAgentScaffold({ home, workspace: context.workspace });
      process.stdout.write(notice("Agent Bootstrap", [state.message, `home ${state.home}`], state.required ? "warn" : "success"));
      return 0;
    }
    const state = await completeBootstrap(
      {
        userName: args.flags.get("user") ?? os.userInfo().username,
        userTimezone: args.flags.get("timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        languages: args.flags.get("languages") ?? "TypeScript",
        style: args.flags.get("style") ?? "direct, pragmatic, verify before claiming done",
        conventions: args.flags.get("conventions") ?? "follow project-local patterns",
        agentName: args.flags.get("name") ?? "Ares",
        creature: args.flags.get("creature") ?? "coding agent",
        vibe: args.flags.get("vibe") ?? "direct",
        emoji: args.flags.get("emoji") ?? "*",
      },
      { home, workspace: context.workspace },
    );
    process.stdout.write(notice("Agent Bootstrap", [state.message, `home ${state.home}`], "success"));
    return 0;
  }
  if (subcommand === "doctor") {
    const config = await loadAgentConfig(home);
    const store = await createMemoryStore(config, home);
    const status = store.status();
    process.stdout.write(notice("Agent Doctor", [
      `home ${home}`,
      `memory backend ${status.backend}`,
      `sqlite-vec loaded ${status.vectorEnabled ? "yes" : "no"}`,
      `store ${status.path}`,
      ...(status.warning ? [status.warning] : []),
    ], status.warning ? "warn" : "success"));
    return 0;
  }
  if (subcommand === "dream") {
    const phase = args.positionals[1] ?? "deep";
    const config = await loadAgentConfig(home);
    const result = phase === "rem"
      ? await runRemDream({ home, config })
      : await runDeepDream({ home, workspace: context.workspace, config });
    process.stdout.write(notice("Agent Dream", [result.report], "success"));
    return 0;
  }
  if (subcommand === "snapshot") {
    const snap = await snapshotBrain({ home, id: args.flags.get("id") });
    if (!snap) {
      process.stdout.write(notice("Agent Snapshot", ["No brain files yet — bootstrap first."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Agent Snapshot", [
      `id ${snap.id}`,
      `dir ${snap.dir}`,
      `${snap.files.length} file(s) / ${snap.totalBytes} bytes`,
    ], "success"));
    return 0;
  }
  if (subcommand === "snapshots") {
    const list = await listSnapshots(home);
    if (list.length === 0) {
      process.stdout.write(notice("Agent Snapshots", ["No snapshots yet."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Agent Snapshots", list.slice(0, 20).map((s) =>
      `${s.id}  ${s.createdAt}  ${s.files.length} files / ${s.totalBytes}b`,
    ), "info"));
    return 0;
  }
  if (subcommand === "restore") {
    const id = args.positionals[1] ?? args.flags.get("id");
    if (!id) {
      process.stderr.write("error: ares agent restore <snapshot-id>\n");
      return 2;
    }
    const result = await restoreSnapshot({ home, id });
    process.stdout.write(notice("Agent Restore", [
      `restored ${result.restored.length} file(s) to ${result.dest}`,
      ...result.restored.map((f) => `  ${f}`),
    ], "success"));
    return 0;
  }
  if (subcommand === "backup") {
    const dest = args.flags.get("dest") ?? args.positionals[1] ?? path.join(context.workspace, `ares-agent-backup-${Date.now()}.json`);
    const result = await exportHome({ home, dest });
    process.stdout.write(notice("Agent Backup", [
      `wrote ${result.files} file(s) / ${result.bytes} bytes`,
      `→ ${result.dest}`,
    ], "success"));
    return 0;
  }
  if (subcommand === "import") {
    const source = args.flags.get("source") ?? args.positionals[1];
    if (!source) {
      process.stderr.write("error: ares agent import <backup.json> [--overwrite]\n");
      return 2;
    }
    const overwrite = args.flags.get("overwrite") === "true" || args.flags.has("overwrite");
    const result = await importHome({ home, source, overwrite });
    process.stdout.write(notice("Agent Import", [
      `wrote ${result.files} file(s); skipped ${result.skipped} (already present)`,
      overwrite ? "overwrite mode: on" : "overwrite mode: off (pass --overwrite to replace existing files)",
    ], "success"));
    return 0;
  }
  process.stderr.write("error: usage: ares agent <bootstrap|doctor|dream|snapshot|snapshots|restore|backup|import>\n");
  return 2;
}

/**
 * C6 — `ares eval coding`: run the coding gauntlet against the selected
 * provider/model with the REAL tool harness, persist the report under
 * ~/.ares/gauntlet/, and print the scoreboard. The number every C-phase
 * change must move.
 */
async function gauntletCommand(args: ParsedArgs): Promise<number> {
  const selection = await selectProvider(args.flags);
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const runtime: AresRuntimeState = { permissionMode: "bypass" };

  const report = await runGauntlet({
    provider: selection.provider,
    model: selection.model,
    keepWorkspaces: args.flags.has("keep"),
    tools: async () => {
      // Fresh harness per workspace — gauntlet runs must not share shell or
      // todo state across tasks.
      const shellRegistry = new ShellRegistry();
      const todoStore = new TodoStore();
      return buildEngineTools(pathPermissions, commandPermissions, selection, runtime, context, shellRegistry, todoStore);
    },
  });

  // Persist: one report per run, plus an append-only scoreboard for trends.
  const dir = path.join(context.home, "gauntlet");
  await mkdir(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, "-");
  const reportFile = path.join(dir, `${stamp}-${report.model.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  await appendFile(
    path.join(dir, "scoreboard.jsonl"),
    JSON.stringify({ at: report.startedAt, provider: report.provider, model: report.model, total: report.total, tasks: report.tasks.map((t) => ({ id: t.id, score: t.score })) }) + "\n",
    "utf8",
  );

  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.total >= 1 ? 0 : 1;
  }
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines = report.tasks.map((t) => {
    const bar = t.probes.map((p) => (p.met ? "+" : "-")).join("");
    return `${t.score === 1 ? "ok  " : t.score > 0 ? "part" : "FAIL"} ${pct(t.score).padStart(4)} [${bar}] ${t.title}${t.error ? ` — ${compactLine(t.error, 80)}` : ""}`;
  });
  lines.push("", `TOTAL ${pct(report.total)} — ${report.model} via ${report.provider} (${Math.round(report.durationMs / 1000)}s)`);
  lines.push(`report: ${reportFile}`);
  process.stdout.write(notice("Gauntlet · coding-v1", lines, report.total >= 0.75 ? "success" : "warn"));
  return report.total >= 0.5 ? 0 : 1;
}

async function evalCommand(args: ParsedArgs): Promise<number> {
  if (args.positionals[0] === "coding") return gauntletCommand(args);
  const root = await mkdtemp(path.join(os.tmpdir(), "ares-eval-"));
  const tasks = builtInEvalTasks();
  let report: EvalReport;
  try {
    report = await runEvalSuite(tasks, { suite: "ares builtin", workspace: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.failed > 0 ? 1 : 0;
  }

  process.stdout.write(`ares eval: ${report.total} task(s)\n`);
  for (const result of report.results) {
    const prefix = result.status === "passed" ? "ok  " : "fail";
    process.stdout.write(`${prefix} ${result.name}${result.error ? `: ${result.error}` : ""}\n`);
  }
  if (report.failed > 0) {
    process.stdout.write(`\n${report.failed}/${report.total} eval task(s) failed. score=${report.score}\n`);
    return 1;
  }
  process.stdout.write(`\n${report.passed}/${report.total} eval task(s) passed. score=${report.score}\n`);
  return 0;
}

function builtInEvalTasks(): EvalTask[] {
  return [
    {
      id: "tool-read-numbered-content",
      name: "Read returns numbered content",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/a.ts", "export const a = 1;\n");
        const result = await ReadTool.call({ file_path: "src/a.ts" }, evalToolCtx(workspace));
        assertEval(result.output.content.includes("1\texport const a = 1;"), "missing numbered line");
        return { evidence: ["Read returned numbered source content."] };
      },
    },
    {
      id: "tool-glob-typescript",
      name: "Glob finds TypeScript files",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/b.ts", "export const b = 2;\n");
        const result = await GlobTool.call({ pattern: "src/*.ts", max_results: 50 }, evalToolCtx(workspace));
        assertEval(result.output.matches.some((m) => m.path.endsWith("b.ts")), "b.ts not matched");
        return { evidence: ["Glob matched the TypeScript fixture."] };
      },
    },
    {
      id: "tool-grep-regex",
      name: "Grep finds regex matches",
      category: "tools",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/c.ts", "function target() {}\n");
        const result = await GrepTool.call({
          pattern: "target",
          path: "src",
          output_mode: "content",
          max_results: 50,
          case_insensitive: false,
          context_before: 0,
          context_after: 0,
        }, evalToolCtx(workspace));
        assertEval(result.output.totalMatches >= 1, "target not found");
        return { evidence: ["Grep found the target fixture."] };
      },
    },
    {
      id: "tool-write-create",
      name: "Write creates files",
      category: "tools",
      async run({ workspace }) {
        const result = await WriteTool.call({ file_path: "src/write.txt", content: "created\n" }, evalToolCtx(workspace));
        assertEval(result.output.created === true, "file was not created");
        return { evidence: ["Write created a new workspace file."] };
      },
    },
    {
      id: "tool-edit-after-read",
      name: "Edit updates previously read files",
      category: "tools",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await writeEvalFile(workspace, "src/edit.txt", "old\n");
        await ReadTool.call({ file_path: "src/edit.txt" }, ctx);
        await EditTool.call({ file_path: "src/edit.txt", old_string: "old", new_string: "new", replace_all: false }, ctx);
        assertEval((await readFile(path.join(workspace, "src", "edit.txt"), "utf8")) === "new\n", "edit failed");
        return { evidence: ["Edit updated a previously read file."] };
      },
    },
    {
      id: "tool-apply-intent-full-file",
      name: "ApplyIntent materializes full-file sketches",
      category: "tools",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await writeEvalFile(workspace, "src/apply.ts", "export const value = 1;\n");
        await ReadTool.call({ file_path: "src/apply.ts" }, ctx);
        await ApplyIntentTool.call({ file_path: "src/apply.ts", instructions: "change value", sketch: "export const value = 2;\n" }, ctx);
        assertEval((await readFile(path.join(workspace, "src", "apply.ts"), "utf8")).includes("2"), "apply failed");
        return { evidence: ["ApplyIntent materialized a full-file sketch."] };
      },
    },
    {
      id: "workspace-checkpoint-restore",
      name: "Checkpoints restore workspace state",
      category: "workspace",
      async run({ workspace }) {
        await writeEvalFile(workspace, "src/check.txt", "before\n");
        const checkpoint = await createWorkspaceCheckpoint({ workspace, sessionId: "eval", turnSeq: 1 });
        await writeEvalFile(workspace, "src/check.txt", "after\n");
        await restoreWorkspaceCheckpoint(workspace, checkpoint.id);
        assertEval((await readFile(path.join(workspace, "src", "check.txt"), "utf8")) === "before\n", "restore failed");
        return { evidence: ["Checkpoint restored the original file state."] };
      },
    },
    {
      id: "memory-add-search",
      name: "Memory add and search persist facts",
      category: "memory",
      async run({ workspace }) {
        const ctx = evalToolCtx(workspace);
        await MemoryTool.call({ action: "add", scope: "project", category: "Preferences", content: "Use pnpm for scripts.", tags: ["tooling"], limit: 20 }, ctx);
        const found = await MemoryTool.call({ action: "search", scope: "project", category: "General", query: "pnpm", tags: [], limit: 20 }, ctx);
        assertEval(found.output.items.length === 1, "memory search missed item");
        return { evidence: ["Project memory recalled the persisted preference."] };
      },
    },
    {
      id: "startup-ares-md",
      name: "Startup context loads ARES.md",
      category: "startup",
      async run({ workspace }) {
        await writeEvalFile(workspace, "ARES.md", "Project rule: use tabs.\n");
        const reminders = await loadStartupReminders(workspace);
        assertEval(reminders.some((r) => r.source === "instructions" && r.text.includes("use tabs")), "ARES.md not loaded");
        return { evidence: ["Startup reminders included ARES.md instructions."] };
      },
    },
    {
      id: "prompt-cache-stable",
      name: "Prompt cache key is stable",
      category: "providers",
      async run() {
        const req = { system: "same", tools: [{ name: "Read", description: "read", input_schema: { type: "object" } }] };
        assertEval(buildPromptCacheKey(req).key === buildPromptCacheKey(req).key, "cache key unstable");
        return { evidence: ["Prompt cache key was stable across identical requests."] };
      },
    },
  ];
}

function evalToolCtx(workspace: string): RichToolContext {
  return {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map<string, FileReadStamp>(),
  };
}

async function writeEvalFile(workspace: string, rel: string, content: string): Promise<void> {
  const file = path.join(workspace, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function assertEval(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sessionsCommand(): Promise<number> {
  await printSessions();
  return 0;
}

async function checkpointsCommand(): Promise<number> {
  const context = cliRuntimeContext();
  const checkpoints = await listWorkspaceCheckpoints(context.workspace);
  if (checkpoints.length === 0) {
    process.stdout.write(notice("Checkpoints", ["No checkpoints in this workspace yet."], "warn"));
    return 0;
  }
  process.stdout.write(
    notice(
      "Checkpoints",
      checkpoints.slice(0, 20).map((cp) => `${cp.id}  ${cp.createdAt}  ${cp.fileManifest.length} files${cp.label ? `  ${cp.label}` : ""}`),
      "info",
    ),
  );
  return 0;
}

async function checkpointDiffCommand(id: string): Promise<number> {
  if (!id) {
    process.stderr.write(notice("Checkpoint Diff", ["Usage: /checkpoint-diff <id>"], "error"));
    return 2;
  }
  try {
    const diff = await diffWorkspaceCheckpoint(cliRuntimeContext().workspace, id);
    const lines = [
      `added: ${diff.added.length}`,
      ...diff.added.slice(0, 20).map((f) => `+ ${f}`),
      `modified: ${diff.modified.length}`,
      ...diff.modified.slice(0, 20).map((f) => `~ ${f}`),
      `deleted: ${diff.deleted.length}`,
      ...diff.deleted.slice(0, 20).map((f) => `- ${f}`),
    ];
    process.stdout.write(notice("Checkpoint Diff", lines, "info"));
    return 0;
  } catch (err) {
    process.stderr.write(notice("Checkpoint Diff", [err instanceof Error ? err.message : String(err)], "error"));
    return 1;
  }
}

async function rollbackCommand(id: string): Promise<number> {
  if (!id) {
    process.stderr.write(notice("Rollback", ["Usage: /rollback <checkpoint-id>"], "error"));
    return 2;
  }
  try {
    const result = await restoreWorkspaceCheckpoint(cliRuntimeContext().workspace, id);
    process.stdout.write(notice("Rollback", [`restored ${result.restored} file(s)`, `deleted ${result.deleted} file(s)`], "success"));
    return 0;
  } catch (err) {
    process.stderr.write(notice("Rollback", [err instanceof Error ? err.message : String(err)], "error"));
    return 1;
  }
}

function themesCommand(): number {
  process.stdout.write(themesList());
  process.stdout.write(`\nUse --theme <name> for one run, or ares theme <name> / /theme <name> to save it.\n`);
  return 0;
}

async function resumeCommand(args: ParsedArgs): Promise<number> {
  try {
    const target = args.positionals[0] ?? args.flags.get("session") ?? "last";
    const sessionId = await requireResumeSessionId(target, cliRuntimeContext());
    return chatCommand(args, sessionId);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

// ─── Ghost Continue v1 — "what were we doing?" ─────────────────────────────
// Read-only continuity recap over durable mission state, enriched by the
// unified recall + advisory cognition (reused, never a new path). No writes.

async function buildContinuitySummary(context = cliRuntimeContext()): Promise<ContinuitySummary> {
  const [contracts, goals] = await Promise.all([
    listMissionContracts(context.home).catch(() => []),
    listGoals(context.home).catch(() => []),
  ]);

  // Enrich from the freshest open missions — best-effort: enrichment must never
  // break the recap, and it never mutates anything.
  const open = contracts.filter(
    (c) => c.progress.status === "active" || c.progress.status === "blocked" || c.progress.status === "draft",
  );
  let relatedMemory: string[] | undefined;
  let advisory: ContinuitySummary["advisory"] = null;
  if (open.length > 0) {
    const situation = open.slice(0, 3).map((c) => c.intent).join("; ");
    try {
      const config = await loadAgentConfig(context.home);
      const recall = await unifiedRecallForTurn({
        query: situation,
        workspace: context.workspace,
        livingMemoryFile: context.mind.memoryFile,
        vector: { config, home: context.home },
        limit: 5,
        reinforce: false, // inspecting status must not strength-bump memory
      });
      relatedMemory = recall.items.map((i) => i.content);
      const adv = await deliberateForTurn({ situation, recalled: recall.living, shouldDeliberate: true });
      advisory = adv.intention
        ? { goal: adv.intention.goal, rationale: adv.intention.rationale, confidence: adv.intention.confidence }
        : null;
    } catch {
      // enrichment is optional — fall back to mission state alone
    }
  }

  // Relevant Learning Cards (Phase B) — read-only: just reading lesson files.
  const cards = await listLearningCards(context.home).catch(() => []);
  const relevant = selectRelevantLessons(cards, open.map((c) => c.intent), 3);
  const lessons = relevant.map((c) => `[${c.result}] ${compactLine(c.intent, 110)} (${Math.round(c.confidence * 100)}%)`);

  return summarizeContinuity({ contracts, goals, relatedMemory, advisory, lessons: lessons.length ? lessons : undefined });
}

function continuityLines(summary: ContinuitySummary): string[] {
  if (summary.empty) {
    return [
      "Clean slate — no missions on record yet.",
      'Start one with: ares operator add --goal "<what you want done>"',
    ];
  }
  const lines: string[] = [];
  if (summary.lastActiveAt) lines.push(`Last active: ${relativeAge(summary.lastActiveAt)} (${summary.lastActiveAt})`);
  lines.push(`${summary.missionCount} mission${summary.missionCount === 1 ? "" : "s"} on record`);

  const renderMission = (m: ContinuitySummary["active"][number], glyph: string): void => {
    const pct = m.totalCriteria > 0 ? ` — ${m.percent}% (${m.completedCriteria}/${m.totalCriteria})` : "";
    lines.push(`${glyph} ${compactLine(m.intent, 120)}${pct}`);
    if (m.goalStatement) lines.push(`    goal: ${compactLine(m.goalStatement, 120)}`);
    for (const b of m.blockers) lines.push(`    blocker: ${compactLine(b, 140)}`);
    if (m.nextAction) lines.push(`    next: ${compactLine(m.nextAction, 140)}`);
    if (m.topEvidence.length) lines.push(`    evidence: ${compactLine(m.topEvidence[0], 120)}`);
  };

  if (summary.active.length) {
    lines.push("", `Active (${summary.active.length}):`);
    for (const m of summary.active) renderMission(m, "•");
  }
  if (summary.blocked.length) {
    lines.push("", `Blocked (${summary.blocked.length}):`);
    for (const m of summary.blocked) renderMission(m, "⚠");
  }
  if (summary.recentlySatisfied.length) {
    lines.push("", `Recently completed (${summary.recentlySatisfied.length}):`);
    for (const m of summary.recentlySatisfied) lines.push(`✓ ${compactLine(m.intent, 120)}`);
  }
  if (summary.lessons?.length) {
    lines.push("", "Relevant lessons:");
    for (const l of summary.lessons.slice(0, 3)) lines.push(`- ${compactLine(l, 140)}`);
  }
  if (summary.relatedMemory?.length) {
    lines.push("", "Relevant memory:");
    for (const r of summary.relatedMemory.slice(0, 5)) lines.push(`- ${compactLine(r, 140)}`);
  }
  if (summary.advisory) {
    lines.push(
      "",
      `Suggested next: ${compactLine(summary.advisory.goal, 140)} (confidence ${Math.round(summary.advisory.confidence * 100)}%)`,
    );
    lines.push(`    why: ${compactLine(summary.advisory.rationale, 140)}`);
  }
  return lines;
}

function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function recapCommand(args: ParsedArgs): Promise<number> {
  try {
    const summary = await buildContinuitySummary();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Ghost Continue", continuityLines(summary), summary.blocked.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

// ─── World Graph (Nexus Phase 1) — ares world / /world ───────────────────────

async function buildWorldGraph(context = cliRuntimeContext()): Promise<WorldGraph> {
  const [contracts, goals, lessons] = await Promise.all([
    listMissionContracts(context.home).catch(() => []),
    listGoals(context.home).catch(() => []),
    listLearningCards(context.home).catch(() => []),
  ]);
  // Crystallized memories only (synthesis insight/belief nodes) — read-only.
  let memory: { id: string; kind: string; content: string; tags?: string[]; source?: string }[] = [];
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    memory = store
      .all()
      .filter((n) => n.source === "synthesis" || (n.tags ?? []).some((t) => t.startsWith("insight:") || t.startsWith("belief:")))
      .map((n) => ({ id: n.id, kind: n.kind, content: n.content, tags: n.tags, source: n.source }));
  } catch {
    // memory is optional — the graph still maps missions/lessons/subsystems
  }
  return assembleWorldGraph({ projectName: "Ares", contracts, goals, lessons, memory, subsystems: ARES_SUBSYSTEMS });
}

function worldGraphLines(graph: WorldGraph): string[] {
  const lines: string[] = [];
  const c = graph.counts;
  lines.push(`${c.subsystem} subsystems · ${c.mission} missions · ${c.goal} goals · ${c.lesson} lessons · ${c.memory} memories · ${graph.relations.length} links`);
  const byId = new Map(graph.entities.map((e) => [e.id, e] as const));
  const linkedSubs = (fromId: string): string[] =>
    graph.relations.filter((r) => r.from === fromId && r.kind === "relates-to").map((r) => byId.get(r.to)?.ref ?? "").filter(Boolean);

  const missions = graph.entities.filter((e) => e.kind === "mission");
  if (missions.length) {
    lines.push("", "Missions:");
    for (const m of missions) {
      const pct = typeof m.meta?.percent === "number" ? ` ${m.meta.percent}%` : "";
      const serves = graph.relations.find((r) => r.from === m.id && r.kind === "serves");
      const goalLabel = serves ? byId.get(serves.to)?.label : undefined;
      const subs = linkedSubs(m.id);
      lines.push(`  • ${compactLine(m.label, 64)} [${m.status ?? "?"}${pct}]${subs.length ? `  → ${subs.join(", ")}` : ""}${goalLabel ? `  ⇒ ${compactLine(goalLabel, 40)}` : ""}`);
    }
  }

  const memories = graph.entities.filter((e) => e.kind === "memory");
  if (memories.length) {
    lines.push("", "Crystallized memory:");
    for (const mem of memories.slice(0, 8)) {
      const subs = linkedSubs(mem.id);
      lines.push(`  ~ ${mem.label}${subs.length ? `  → ${subs.join(", ")}` : ""}`);
    }
  }

  lines.push("", "Subsystems (most connected first):");
  const subsystems = graph.entities.filter((e) => e.kind === "subsystem");
  const inboundLinks = (id: string): number => graph.relations.filter((r) => r.to === id && r.kind === "relates-to").length;
  for (const s of [...subsystems].sort((a, b) => inboundLinks(b.id) - inboundLinks(a.id))) {
    const n = inboundLinks(s.id);
    lines.push(`  ${s.ref}${n ? ` · ${n} link${n === 1 ? "" : "s"}` : ""}`);
  }

  if (c.mission === 0 && c.lesson === 0) {
    lines.push("", "No missions or lessons yet — the map fills in as you run missions (ares operator add).");
  }
  return lines;
}

async function worldCommand(args: ParsedArgs): Promise<number> {
  try {
    const graph = await buildWorldGraph();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("World Graph", worldGraphLines(graph), "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

// ─── Proactive Daily Briefing (Nexus Phase 1) — ares today / briefing / /today ─

async function buildBriefing(context = cliRuntimeContext()): Promise<DailyBriefing> {
  // Reuse the continuity summary (mission buckets + read-only advisory) and the
  // World Graph — no new store-reading logic, no mutation.
  const [summary, worldGraph, lessons] = await Promise.all([
    buildContinuitySummary(context),
    buildWorldGraph(context),
    listLearningCards(context.home).catch(() => []),
  ]);
  return rankBriefing({ summary, worldGraph, lessons, now: new Date().toISOString() });
}

function briefingLines(b: DailyBriefing): string[] {
  const lines: string[] = [b.headline];
  if (b.focus.length) {
    lines.push("", "Focus:");
    for (const f of b.focus) {
      lines.push(`  • ${compactLine(f.intent, 60)} [${f.status} ${f.percent}%]${f.relatedSubsystems.length ? `  → ${f.relatedSubsystems.join(", ")}` : ""}`);
      lines.push(`     ${f.reasons.join(" · ")}`);
      if (f.lesson) lines.push(`     ${f.lesson}`);
    }
  }
  if (b.decisionsNeeded.length) {
    lines.push("", "Decisions needed (blocked):");
    for (const d of b.decisionsNeeded) lines.push(`  ! ${compactLine(d.intent, 60)} — ${compactLine(d.detail, 80)}`);
  }
  if (b.reviveOrDrop.length) {
    lines.push("", "Revive or drop (stale):");
    for (const d of b.reviveOrDrop) lines.push(`  · ${compactLine(d.intent, 60)} — ${d.detail}`);
  }
  if (b.recentlyShipped.length) {
    lines.push("", "Recently shipped:");
    for (const s of b.recentlyShipped) lines.push(`  ✓ ${compactLine(s.intent, 70)}`);
  }
  if (b.suggestion) {
    lines.push("", `Suggested (advisory, not a command): ${compactLine(b.suggestion.goal, 80)}`);
    lines.push(`  why: ${compactLine(b.suggestion.rationale, 90)} (${Math.round(b.suggestion.confidence * 100)}%)`);
  }
  return lines;
}

async function todayCommand(args: ParsedArgs): Promise<number> {
  try {
    const briefing = await buildBriefing();
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(briefing, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Today", briefingLines(briefing), briefing.decisionsNeeded.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

// ─── Model Router foundation (Nexus Phase 1) — ares models route ─────────────

const MODEL_TASK_KINDS = ["chat", "code", "planning", "summarization", "memory", "review", "vision", "workshop", "tool-output-summary"];

function modelTaskFromFlags(flags: Map<string, string>): ModelTask {
  const rawKind = (flags.get("task") ?? "chat").trim();
  const kind = (MODEL_TASK_KINDS.includes(rawKind) ? rawKind : "chat") as ModelTaskKind;
  const task: ModelTask = { kind };
  const pick = <T extends string>(name: string, allowed: readonly string[]): T | undefined => {
    const v = flags.get(name)?.trim();
    return v && allowed.includes(v) ? (v as T) : undefined;
  };
  task.risk = pick<RiskLevel>("risk", ["low", "medium", "high"]);
  task.privacy = pick<PrivacyPosture>("privacy", ["local-required", "local-preferred", "cloud-ok", "cloud-required"]);
  task.quality = pick<QualityNeed>("quality", ["fast", "balanced", "best"]);
  task.cost = pick<CostPreference>("cost", ["cheap", "balanced", "premium-ok"]);
  task.latency = pick<LatencyPreference>("latency", ["low", "normal", "patient"]);
  const ctx = Number(flags.get("context"));
  if (Number.isFinite(ctx) && ctx > 0) task.contextTokens = ctx;
  const touches = flags.get("touches");
  if (touches) task.touches = touches.split(",").map((s) => s.trim()).filter(Boolean) as ModelTouch[];
  return task;
}

function routeDecisionLines(d: ModelRouteDecision): string[] {
  const lines: string[] = [];
  lines.push(`task: ${d.task.kind} · risk ${d.task.risk} · privacy ${d.task.privacy} · quality ${d.task.quality} · cost ${d.task.cost} · latency ${d.task.latency}`);
  if (d.selected) {
    lines.push("", `→ ${d.selected.family} (${d.selected.locality})${d.selected.modelClass ? ` · ${d.selected.modelClass}` : ""}`);
    if (d.fallback) lines.push(`  fallback: ${d.fallback.family} (${d.fallback.locality})`);
    lines.push(`  confidence ${Math.round(d.confidence * 100)}% · ${d.executable ? "executable" : "advisory only"}`);
  } else {
    lines.push("", "→ no route available for these constraints");
  }
  if (d.reasons.length) {
    lines.push("", "why:");
    for (const r of d.reasons) lines.push(`  - ${r}`);
  }
  if (d.warnings.length) {
    lines.push("", "warnings:");
    for (const w of d.warnings) lines.push(`  ! ${w}`);
  }
  return lines;
}

async function modelsCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "route";
  if (sub !== "route") {
    process.stderr.write(
      `unknown models subcommand: ${sub}\n` +
        "usage: ares models route --task <kind> [--risk low|medium|high] [--privacy local-preferred|cloud-ok|…] [--quality fast|balanced|best] [--cost cheap|balanced|premium-ok] [--latency low|normal|patient] [--context N] [--touches a,b] [--json]\n",
    );
    return 2;
  }
  try {
    const decision = routeModel(modelTaskFromFlags(args.flags), { profiles: DEFAULT_PROVIDER_PROFILES });
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Model Route", routeDecisionLines(decision), decision.warnings.length ? "warn" : "info"));
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

// ─── Mission Learning Cards (Phase B v1) — ares mission learn/lessons/lesson ──

function lessonLine(card: LearningCard): string {
  return `[${card.result}] ${compactLine(card.intent, 80)} · ${Math.round(card.confidence * 100)}% · ${card.id}`;
}

function learningCardLines(card: LearningCard, memoryWritten?: boolean): string[] {
  const lines: string[] = [
    `result: ${card.result}  ·  confidence ${Math.round(card.confidence * 100)}%`,
    `mission: ${compactLine(card.intent, 120)}`,
  ];
  if (card.goalStatement) lines.push(`goal: ${compactLine(card.goalStatement, 120)}`);
  if (card.whatWorked.length) {
    lines.push("", "what worked:");
    for (const w of card.whatWorked) lines.push(`  + ${compactLine(w, 120)}`);
  }
  if (card.whatFailed.length) {
    lines.push("", "what failed:");
    for (const f of card.whatFailed) lines.push(`  - ${compactLine(f, 120)}`);
  }
  if (card.reusableProcedure.length) {
    lines.push("", "reusable procedure:");
    card.reusableProcedure.forEach((p, i) => lines.push(`  ${i + 1}. ${compactLine(p, 120)}`));
  }
  if (card.tags.length) lines.push("", `tags: ${card.tags.join(", ")}`);
  if (memoryWritten !== undefined) {
    lines.push("", memoryWritten ? "✓ recorded into living memory" : "· already in living memory");
  }
  return lines;
}

async function missionCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext();
  const subcommand = (args.positionals[0] ?? "").toLowerCase();
  try {
    if (subcommand === "learn") {
      const contractId = args.positionals[1] ?? args.flags.get("contract");
      if (!contractId) {
        process.stderr.write("error: usage: ares mission learn <contractId>\n");
        return 2;
      }
      const contract = await loadMissionContract(context.home, contractId);
      if (!contract) {
        process.stderr.write(`error: mission contract not found: ${contractId}\n`);
        return 2;
      }
      const goal = contract.goalId ? (await loadGoal(context.home, contract.goalId)) ?? undefined : undefined;
      const card = distillMissionCard(contract, { goal });
      await saveLearningCard(context.home, card);
      // Feed the lesson into living memory exactly once (best-effort).
      let memoryWritten = false;
      try {
        const store = await MemoryStore.open(context.mind.memoryFile);
        memoryWritten = await recordCardMemoryOnce(store, {
          id: card.id,
          summary: learningCardMemoryText(card),
          tags: card.tags,
        });
      } catch {
        // memory feed is optional — the card itself is the durable record
      }
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify({ ...card, memoryWritten }, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(notice(`Lesson ${card.id}`, learningCardLines(card, memoryWritten), card.result === "success" ? "success" : "warn"));
      return 0;
    }
    if (subcommand === "lessons") {
      const cards = await listLearningCards(context.home);
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify(cards, null, 2) + "\n");
        return 0;
      }
      if (cards.length === 0) {
        process.stdout.write(notice("Lessons", ["No learning cards yet. Distill one: ares mission learn <contractId>"], "warn"));
        return 0;
      }
      process.stdout.write(notice(`Lessons · ${cards.length}`, cards.map(lessonLine), "info"));
      return 0;
    }
    if (subcommand === "lesson") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("error: usage: ares mission lesson <id>\n");
        return 2;
      }
      const card = (await loadLearningCard(context.home, id)) ?? (await loadLearningCard(context.home, learningCardId(id)));
      if (!card) {
        process.stderr.write(`error: lesson not found: ${id}\n`);
        return 2;
      }
      if (args.flags.has("json")) {
        process.stdout.write(JSON.stringify(card, null, 2) + "\n");
        return 0;
      }
      process.stdout.write(notice(`Lesson ${card.id}`, learningCardLines(card), card.result === "success" ? "success" : "warn"));
      return 0;
    }
    process.stderr.write("error: usage: ares mission <learn <contractId> | lessons | lesson <id>>\n");
    return 2;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

async function launcherCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext();
  const settings = await loadUiSettings();
  const action = await runInkLauncher({
    workspace: context.workspace,
    settings,
    onSettingsChange: (patch) => {
      void updateUiSettings(patch);
    },
  });
  if (action.kind === "quit") return 0;
  if (action.kind === "login") return loginCommand();
  if (action.kind === "doctor") return doctorCommand();
  if (action.kind === "help") {
    printHelp();
    return 0;
  }

  if (action.workspace) {
    const info = await stat(action.workspace).catch(() => null);
    if (!info?.isDirectory()) {
      process.stderr.write(`error: workspace is not a directory: ${action.workspace}\n`);
      return 2;
    }
    process.chdir(action.workspace);
  }
  setTheme(action.theme);
  await updateUiSettings({
    theme: action.theme,
    lastProvider: action.provider,
    lastOpenAIModel: action.provider === "openai" ? action.model : settings.lastOpenAIModel,
    lastOllamaModel: action.provider === "ollama" ? action.model : settings.lastOllamaModel,
    favoriteOllamaModels: action.favoriteOllamaModels,
    favoriteOpenAIModels: action.favoriteOpenAIModels,
  });
  args.flags.set("provider", action.provider);
  args.flags.set("model", action.model);
  args.flags.set("theme", action.theme);
  return chatCommand(args);
}

async function chatCommand(args: ParsedArgs, resumeSessionId?: string): Promise<number> {
  let live: LiveSession;
  try {
    const resumeTarget = resumeSessionId ?? (await resolveResumeSessionId(args.flags.get("resume")));
    live = await createSession(args, resumeTarget);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  if (stdin.isTTY && stdout.isTTY && process.env.ARES_LEGACY_TUI !== "1") {
    const snapshot = (): InkChatSnapshot => ({
      provider: live.selection.provider.name,
      model: live.selection.model,
      workspace: live.context.workspace,
      mode: live.runtime.permissionMode,
    });
    return await runInkChat({
      snapshot,
      resumedLines: live.resumed ? resumedLines(live.resumed) : undefined,
      sendMessage: async (goal, onEvent) => {
        await prepareUserTurn(live, goal);
        let finalStatus: "completed" | "interrupted" | "failed" = "completed";
        for await (const event of live.session.sendContent(await contentFromUserInput(goal, live.context.workspace))) {
          if (event.type === "tool_end" && event.touchedFiles?.length) {
            live.verifier.scheduleFor(event.touchedFiles);
          }
          if (event.type === "turn_end") finalStatus = event.status;
          onEvent(event);
        }
        await finishTurn(live, finalStatus);
      },
      handleCommand: async (line): Promise<InkCommandResult> => {
        if (line === "/exit" || line === "/quit") {
          await live.agentRuntime?.sessionEnded();
          await mindSessionEnded();
          live.agentRuntime?.stop();
          return { kind: "exit" };
        }
        if (line === "/help") return { kind: "handled", lines: inkHelpLines(), snapshot: snapshot() };
        if (line === "/doctor") return { kind: "handled", lines: await doctorSummaryLines(), snapshot: snapshot() };
        if (line === "/themes") return { kind: "handled", lines: themeLines(), snapshot: snapshot() };
        if (line === "/sessions") return { kind: "handled", lines: await sessionsLines(20, live.context), snapshot: snapshot() };
        if (line === "/plan") {
          live.runtime.permissionMode = "plan";
          await updateUiSettings({ dangerousBypass: false });
          return { kind: "handled", lines: ["Plan mode enabled. Writes are blocked."], snapshot: snapshot() };
        }
        if (line === "/code" || line === "/exitplan") {
          live.runtime.permissionMode = "workspace-write";
          await updateUiSettings({ dangerousBypass: false });
          return { kind: "handled", lines: ["Workspace-write mode restored."], snapshot: snapshot() };
        }
        if (line === "/danger" || line === "/bypass") {
          live.runtime.permissionMode = live.runtime.permissionMode === "bypass" ? "workspace-write" : "bypass";
          await updateUiSettings({ dangerousBypass: live.runtime.permissionMode === "bypass" });
          return {
            kind: "handled",
            lines: [
              live.runtime.permissionMode === "bypass"
                ? "Dangerous bypass enabled. Tool prompts are auto-allowed until you toggle it off."
                : "Dangerous bypass disabled. Workspace-write mode restored.",
            ],
            snapshot: snapshot(),
          };
        }
        if (line === "/checkpoints") return { kind: "handled", lines: await checkpointLines(live.context), snapshot: snapshot() };
        if (line.startsWith("/checkpoint-diff ")) {
          return { kind: "handled", lines: await checkpointDiffLines(line.slice("/checkpoint-diff ".length).trim(), live.context), snapshot: snapshot() };
        }
        if (line === "/undo" || line.startsWith("/undo ")) {
          return { kind: "handled", lines: await undoLines(live, line.slice("/undo".length)), snapshot: snapshot() };
        }
        if (line.startsWith("/rollback ")) {
          return { kind: "handled", lines: await rollbackLines(line.slice("/rollback ".length).trim(), live.context), snapshot: snapshot() };
        }
        if (line === "/theme" || line.startsWith("/theme ")) {
          const requested = line.split(/\s+/, 2)[1];
          if (!requested) return { kind: "handled", lines: themeLines(), snapshot: snapshot() };
          const selected = setTheme(requested);
          if (!selected) {
            return { kind: "handled", lines: [`Unknown theme: ${requested}`, `Available: ${availableThemes().join(", ")}`], snapshot: snapshot() };
          }
          await saveTheme(selected);
          return { kind: "handled", lines: [`Theme active: ${selected}`], snapshot: snapshot() };
        }
        if (line === "/resume" || line.startsWith("/resume ")) {
          const target = line.split(/\s+/, 2)[1] ?? "last";
          const sessionId = await requireResumeSessionId(target, live.context);
          live.agentRuntime?.stop();
          live = await createSessionWithSelection(args, live.selection, sessionId);
          return { kind: "handled", lines: live.resumed ? resumedLines(live.resumed) : [`Resumed ${sessionId}`], snapshot: snapshot() };
        }
        if (line.startsWith("/workspace ")) {
          const target = line.slice("/workspace ".length).trim();
          const next = path.resolve(live.context.workspace, target);
          const info = await stat(next).catch(() => null);
          if (!info?.isDirectory()) return { kind: "handled", lines: [`Not a directory: ${next}`], snapshot: snapshot() };
          live.agentRuntime?.stop();
          process.chdir(next);
          live = await createSessionWithSelection(args, live.selection);
          return { kind: "handled", lines: [`Active workspace is now ${live.context.workspace}`], snapshot: snapshot() };
        }
        if (line === "/reasoning" || line.startsWith("/reasoning ")) {
          const requested = line.split(/\s+/, 2)[1]?.toLowerCase();
          if (!requested) {
            const current = resolveReasoningLevel(await loadUiSettings());
            return {
              kind: "handled",
              lines: [`Reasoning: ${reasoningLabel(current)} (${current}). Change with /reasoning <${REASONING_LEVELS.join("|")}>.`],
              snapshot: snapshot(),
            };
          }
          if (!isReasoningLevel(requested)) {
            return { kind: "handled", lines: [`Unknown reasoning level: ${requested}`, `Available: ${REASONING_LEVELS.join(", ")}`], snapshot: snapshot() };
          }
          live.session.setReasoningLevel(requested);
          await updateUiSettings({ reasoningLevel: requested });
          return { kind: "handled", lines: [`Reasoning set to ${reasoningLabel(requested)} — applies on your next message.`], snapshot: snapshot() };
        }
        return { kind: "not-handled" };
      },
    });
  }

  process.stdout.write("\n" + chatHeader({
    provider: live.selection.provider.name,
    model: live.selection.model,
    workspace: live.context.workspace,
  }));
  if (live.resumed) printResumed(live.resumed);

  while (true) {
    const line = (await askLine(promptLabel(live.selection.model, live.context.workspace, live.runtime.permissionMode))).trim();
    if (!line) continue;
    if (line === "/exit" || line === "exit" || line === "/quit" || line === "quit") {
      await live.agentRuntime?.sessionEnded();
      live.agentRuntime?.stop();
      process.stdout.write("bye\n");
      return 0;
    }
    if (line === "/help" || line === "help") {
      process.stdout.write(interactiveHelp());
      continue;
    }
    if (line === "/doctor" || line === "doctor") {
      await doctorCommand();
      continue;
    }
    if (line === "/themes" || line === "themes") {
      process.stdout.write(themesList());
      continue;
    }
    if (line === "/theme" || line.startsWith("/theme ")) {
      const requested = line.split(/\s+/, 2)[1];
      if (!requested) {
        process.stdout.write(themesList());
        continue;
      }
      const selected = setTheme(requested);
      if (!selected) {
        process.stderr.write(notice("Theme", [`Unknown theme: ${requested}`, `Available: ${availableThemes().join(", ")}`], "error"));
        continue;
      }
      await saveTheme(selected);
      process.stdout.write(themeChanged(selected));
      process.stdout.write(chatHeader({
        provider: live.selection.provider.name,
        model: live.selection.model,
        workspace: live.context.workspace,
      }));
      continue;
    }
    if (line === "/sessions") {
      await printSessions();
      continue;
    }
    if (line === "/plan") {
      live.runtime.permissionMode = "plan";
      await updateUiSettings({ dangerousBypass: false });
      process.stdout.write(notice("Plan Mode", ["Writes are blocked. Use /code to return to workspace-write mode."], "warn"));
      continue;
    }
    if (line === "/code" || line === "/exitplan") {
      live.runtime.permissionMode = "workspace-write";
      await updateUiSettings({ dangerousBypass: false });
      process.stdout.write(notice("Plan Mode", ["Workspace-write mode restored."], "success"));
      continue;
    }
    if (line === "/danger" || line === "/bypass") {
      live.runtime.permissionMode = live.runtime.permissionMode === "bypass" ? "workspace-write" : "bypass";
      await updateUiSettings({ dangerousBypass: live.runtime.permissionMode === "bypass" });
      process.stdout.write(
        notice(
          "Danger",
          [
            live.runtime.permissionMode === "bypass"
              ? "Dangerous bypass enabled. Tool prompts are auto-allowed until toggled off."
              : "Dangerous bypass disabled. Workspace-write mode restored.",
          ],
          live.runtime.permissionMode === "bypass" ? "warn" : "success",
        ),
      );
      continue;
    }
    if (line === "/checkpoints") {
      await checkpointsCommand();
      continue;
    }
    if (line.startsWith("/checkpoint-diff ")) {
      await checkpointDiffCommand(line.slice("/checkpoint-diff ".length).trim());
      continue;
    }
    if (line === "/undo" || line.startsWith("/undo ")) {
      process.stdout.write(notice("Undo", await undoLines(live, line.slice("/undo".length)), "success"));
      continue;
    }
    if (line.startsWith("/rollback ")) {
      await rollbackCommand(line.slice("/rollback ".length).trim());
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const target = line.split(/\s+/, 2)[1] ?? "last";
      try {
        const sessionId = await requireResumeSessionId(target, live.context);
        live.agentRuntime?.stop();
        live = await createSessionWithSelection(args, live.selection, sessionId);
        if (live.resumed) printResumed(live.resumed);
      } catch (err) {
        process.stderr.write(notice("Resume", [err instanceof Error ? err.message : String(err)], "error"));
      }
      continue;
    }
    if (line === "/whathappened" || line === "/recap") {
      const summary = await buildContinuitySummary(live.context);
      process.stdout.write(notice("Ghost Continue", continuityLines(summary), summary.blocked.length ? "warn" : "info"));
      continue;
    }
    if (line === "/world") {
      const graph = await buildWorldGraph(live.context);
      process.stdout.write(notice("World Graph", worldGraphLines(graph), "info"));
      continue;
    }
    if (line === "/today" || line === "/briefing") {
      const briefing = await buildBriefing(live.context);
      process.stdout.write(notice("Today", briefingLines(briefing), briefing.decisionsNeeded.length ? "warn" : "info"));
      continue;
    }
    if (line.startsWith("/workspace ")) {
      const target = line.slice("/workspace ".length).trim();
      live.agentRuntime?.stop();
      live = await switchWorkspace(args, live.selection, target);
      continue;
    }

    await renderTurn(live, line);
  }
}

async function askLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function switchWorkspace(
  args: ParsedArgs,
  selection: ProviderSelection,
  target: string,
): Promise<LiveSession> {
  const context = cliRuntimeContext();
  const next = path.resolve(context.workspace, target);
  const info = await stat(next).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(notice("Workspace", [`Not a directory: ${next}`], "error"));
    return createSessionWithSelection(args, selection);
  }
  process.chdir(next);
  const live = await createSessionWithSelection(args, selection);
  process.stdout.write(notice("Workspace", [`Active workspace is now ${live.context.workspace}`], "success"));
  return live;
}

async function renderTurn(live: LiveSession, goal: string): Promise<void> {
  await prepareUserTurn(live, goal);
  let wroteText = false;
  let wroteThinking = false;
  let finalStatus: "completed" | "interrupted" | "failed" = "completed";
  for await (const event of live.session.sendContent(await contentFromUserInput(goal, live.context.workspace))) {
    if (event.type === "text_delta") {
      if (wroteThinking) {
        process.stderr.write("\n");
        wroteThinking = false;
      }
      process.stdout.write(event.text);
      wroteText = true;
      continue;
    }
    if (event.type === "thinking_delta") {
      if (!wroteThinking) process.stderr.write(thinkingPrefix());
      process.stderr.write(dim(event.text));
      wroteThinking = true;
      continue;
    }
    if (event.type === "tool_start") {
      if (wroteText) process.stdout.write("\n");
      if (wroteThinking) {
        process.stderr.write("\n");
        wroteThinking = false;
      }
      process.stderr.write(toolStart(event));
      wroteText = false;
      continue;
    }
    if (event.type === "tool_end") {
      if (event.touchedFiles?.length) live.verifier.scheduleFor(event.touchedFiles);
      process.stderr.write(toolEnd(event));
      continue;
    }
    if (event.type === "tool_progress") {
      const text = legacyProgressText(event.data);
      if (text) process.stderr.write(dim(text) + "\n");
      continue;
    }
    if (event.type === "workspace_diff") {
      process.stderr.write(colorUnifiedDiff(event.diff));
      continue;
    }
    if (event.type === "todo_updated") {
      process.stderr.write(notice("Todos", event.todos.map((todo) => `${todo.status.padEnd(11)} ${todo.status === "in_progress" ? todo.activeForm : todo.content}`), "info"));
      continue;
    }
    if (event.type === "checkpoint_created") {
      process.stderr.write(notice("Checkpoint", [`${event.checkpointId}${event.label ? ` ${event.label}` : ""}`], "muted"));
      continue;
    }
    if (event.type === "tool_error") {
      process.stderr.write(toolError(event));
      continue;
    }
    if (event.type === "error") {
      process.stderr.write(providerError(event.error.message));
      continue;
    }
    if (event.type === "turn_end") {
      finalStatus = event.status;
      if (wroteThinking) process.stderr.write("\n");
      if (wroteText) process.stdout.write("\n");
      if (event.status !== "completed") {
        process.stderr.write(notice("Turn", [`status ${event.status}`], "warn"));
      }
      process.stderr.write(dim(usageMeter(event.usage, event.durationMs)) + "\n");
      await finishTurn(live, finalStatus);
      return;
    }
    void event;
  }
  await finishTurn(live, finalStatus);
}

async function loginCommand(): Promise<number> {
  process.stderr.write("ares: starting ChatGPT OAuth device-code flow…\n");
  try {
    const file = await deviceCodeLogin({
      onDeviceCode: (code) => {
        process.stdout.write(
          [
            "",
            "  Open this URL in your browser:",
            `    ${code.verificationUrl}`,
            "",
            `  Enter the code: ${code.userCode}`,
            "",
            "  Waiting for authorization…",
            "",
          ].join("\n"),
        );
      },
    });
    process.stdout.write(`Logged in${file.profile.email ? ` as ${file.profile.email}` : ""}.\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: login failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function doctorCommand(): Promise<number> {
  process.stdout.write("ares doctor\n\n");

  // Auth
  const auth = await authStatus();
  process.stdout.write("OpenAI auth:\n");
  process.stdout.write(`  configured: ${auth.configured ? "yes" : "no"}\n`);
  process.stdout.write(`  mode:       ${auth.mode}\n`);
  process.stdout.write(`  source:     ${auth.source}\n`);
  if (auth.email) process.stdout.write(`  email:      ${auth.email}\n`);
  if (auth.tokenPreview) process.stdout.write(`  token:      ${auth.tokenPreview}\n`);
  process.stdout.write(`  authPath:   ${auth.authPath}\n`);
  process.stdout.write("\n");

  // Ollama Cloud
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS, ...NATIVE_OLLAMA_OPTS });
  const health = await pool.health();
  process.stdout.write("Ollama Cloud:\n");
  process.stdout.write(`  host:       ${health.host}\n`);
  process.stdout.write(`  reachable:  ${health.reachable ? "yes" : "no"}\n`);
  process.stdout.write(`  available:  ${health.availableModels.length} model(s)\n`);
  for (const slot of health.slots) {
    process.stdout.write(
      `  ${slot.name.padEnd(10)} ${slot.model.padEnd(35)} ${slot.present ? "[present]" : "[missing]"}\n`,
    );
  }
  process.stdout.write("\n");
  process.stdout.write(`ares: ${auth.configured || health.reachable ? "ready" : "no providers configured"}\n`);
  return 0;
}

// ─── system prompt ─────────────────────────────────────────────────────

// ─── live Mind bridge (v6) — wires Living Memory + learned capabilities into
// the ACTUAL conversation, so Ares recalls, captures, and knows itself instead
// of behaving like a fresh chatbot every turn. Read-only/best-effort: the Mind
// must never break a turn.
const LIVE_MEMORY_ITEM_CHARS = 420;
const LIVE_MEMORY_BLOCK_CHARS = 2_400;

async function loadLiveMindContext(context: CliRuntimeContext): Promise<string> {
  try {
    const store = await MemoryStore.open(context.mind.memoryFile);
    const caps = await listCapabilities(context.home);
    const learned = caps.filter((c) => c.status === "mastered" || c.status === "have");
    const known = store
      .all()
      .filter((n) => n.kind === "semantic" && !/^Recurring theme "/.test(n.content))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8);
    if (learned.length === 0 && known.length === 0) return "";
    const lines: string[] = [
      "",
      "# Your living memory & learned capabilities",
      "This is continuous you — not a fresh assistant booting from zero. The items below are things you actually know and can do, accumulated over time. Draw on them naturally; never announce that you're 'checking memory'.",
    ];
    if (known.length) {
      lines.push("", "What you know:");
      for (const n of known) lines.push(`- ${compactLine(n.content, LIVE_MEMORY_ITEM_CHARS)}`);
    }
    if (learned.length) {
      lines.push("", "Capabilities you can rely on:");
      for (const c of learned) lines.push(`- ${c.name}${c.skillRef ? ` (skill: ${c.skillRef})` : ""}`);
    }
    return lines.join("\n") + "\n";
  } catch {
    return "";
  }
}

async function prepareUserTurn(live: LiveSession, userMessage: string): Promise<void> {
  await live.agentRuntime?.beforeTurn(userMessage);
  await mindBeforeTurn(live, userMessage);
  live.queueSystemReminder(buildForegroundReminder(userMessage), "instructions");
}

async function mindBeforeTurn(live: LiveSession, userMessage: string): Promise<void> {
  const text = userMessage.trim();
  if (!text) return;
  try {
    const intent = classifyUserIntent(text);
    // Single canonical recall: v6 living memory (source of truth) merged with the
    // legacy v4 vector store, surfaced as ONE reminder. The turn never reads the
    // two substrates as separate stores again.
    const prepared = live.agentRuntime?.prepared;
    const recall = await unifiedRecallForTurn({
      query: text,
      workspace: live.context.workspace,
      livingMemoryFile: live.context.mind.memoryFile,
      shouldRecall: intent.shouldRecall,
      limit: 5,
      itemChars: LIVE_MEMORY_ITEM_CHARS,
      blockChars: LIVE_MEMORY_BLOCK_CHARS,
      vector: prepared?.enabled
        ? { config: prepared.config, home: prepared.home, useOllama: process.env.ARES_AGENT_OLLAMA_RECALL === "1" }
        : undefined,
    });
    live.lastRecallIds = recall.livingIds;
    live.lastUserMessage = text;
    if (recall.reminder) {
      live.queueSystemReminder(recall.reminder, "memory");
      const count = recall.items.length;
      emitLifecycle({ type: "recall_surfaced", count, gain: gainForTarget("RECALL", count) });
    }
    // Advisory cognition (Phase 2C step 3): think WITH what was just recalled and
    // offer a non-binding suggestion. Reuses the unified recall (no second query),
    // never writes a decision, and is gated so trivial turns skip it entirely.
    const advisory = await deliberateForTurn({
      situation: text,
      recalled: recall.living,
      shouldDeliberate: intent.shouldRecall,
      emit: (t) => emitLifecycle({ type: "thought", kind: t.kind, text: t.text }),
    });
    if (advisory.reminder) {
      live.queueSystemReminder(advisory.reminder, "memory");
    }
    // Capture the user's message as an episodic memory — this is how Ares learns over time.
    if (intent.shouldCapture) {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      await store.add({ kind: "episodic", content: text.slice(0, 400), source: live.session.meta.id });
    }
  } catch {
    // never break a turn over memory
  }
}

/**
 * Turn epilogue (ARES V5+V6). Three steps, all best-effort:
 *   1. the agent runtime's own afterTurn lifecycle;
 *   2. V6 consequence settling — every living memory injected into this turn
 *      gets the outcome recorded (win on completed, loss otherwise) so strength
 *      tracks usefulness, not recall popularity;
 *   3. V5 Witness — a cheap sideQuery fork reviews the finished turn and may
 *      write candidate hypotheses into living memory.
 * Nothing here may break the session loop.
 */
async function finishTurn(
  live: LiveSession,
  finalStatus: "completed" | "interrupted" | "failed",
): Promise<void> {
  await live.agentRuntime?.afterTurn(finalStatus);

  // V6 — settle the artifacts that were in play.
  const ids = live.lastRecallIds ?? [];
  live.lastRecallIds = undefined;
  if (ids.length > 0) {
    try {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      await store.recordOutcome(ids, {
        won: finalStatus === "completed",
        note: `in play for a turn that ${finalStatus}`,
      });
    } catch {
      // consequence settling never breaks the loop
    }
  }

  // V5 — the Witness reviews substantive turns. Interrupted turns teach nothing
  // reliable; failed turns are reviewed (failures carry feedback/belief signal).
  const userMessage = live.lastUserMessage;
  live.lastUserMessage = undefined;
  if (!userMessage || finalStatus === "interrupted") return;
  if (process.env.ARES_WITNESS === "0" || !live.agentRuntime?.prepared.enabled) return;
  try {
    const intent = classifyUserIntent(userMessage);
    if (intent.lowSignal || !intent.shouldCapture) return;
    const history = live.session.engine.history();
    const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
    const assistantText = lastAssistant ? messageText(lastAssistant) : "";
    if (!assistantText) return;
    const store = await MemoryStore.open(live.context.mind.memoryFile);
    const report = await runWitness({
      conversation: { user: userMessage, assistant: assistantText, status: finalStatus },
      store,
      source: live.session.meta.id,
      ask: ({ system, user, schemaHint, signal }) =>
        sideQueryJson({
          provider: live.selection.provider,
          model: live.selection.model,
          system,
          user,
          schemaHint,
          signal,
        }),
    });
    if (report.accepted.length > 0) {
      emitLifecycle({
        type: "capture_detected",
        kinds: report.accepted.map((n) => n.tags?.find((t) => t.startsWith("crucible:")) ?? "candidate"),
        excerpt: report.accepted[0].content.slice(0, 120),
        gain: gainForTarget("MEMORY", report.accepted.length, "hypotheses"),
      });
    }
  } catch {
    // the Witness is opportunistic — a failed review costs nothing
  }
}

async function mindSessionEnded(): Promise<void> {
  try {
    const store = await MemoryStore.open(cliRuntimeContext().mind.memoryFile);
    await store.consolidate(); // sleep: forget the trivial, crystallize recurring themes
  } catch {
    // never fatal
  }
}

function buildSystemPrompt(permissionMode: PermissionMode = "workspace-write", context = cliRuntimeContext()): string {
  const platform = process.platform === "win32" ? "Windows (PowerShell first)" : process.platform;
  const cwd = context.workspace;
  const today = new Date().toISOString().slice(0, 10);

  return `You are Ares, an autonomous local assistant with a powerful coding harness running in the terminal.

You pair with the user as a durable local agent, not a code-only bot. Be useful, concise, and honest. Take action with tools when action is useful, and answer normally when the user is just talking.

## Tone and verbosity

Match output length to task complexity. Most replies should be ≤4 lines (excluding tool calls and code). Skip preamble like "Here's what I'll do" and postamble like "I've completed the task". Lead with the answer or the action.

<example>
user: 2 + 2
assistant: 4
</example>

<example>
user: which file has the auth middleware?
assistant: src/middleware/auth.ts:42
</example>

<example>
user: list .ts files in src/
assistant: [Glob src/**/*.ts]
14 files: src/index.ts, src/auth.ts, src/db.ts, ...
</example>

For substantial work, lead with the action you're taking in one short sentence, then act.

## Presence

Not every message is a build request. If the user greets you, checks in, jokes, vents, asks who you are, or asks a non-coding question, respond naturally in your own voice. Do not force the conversation toward code, tickets, or "what are we building" unless the user actually put work on the table.

You are still allowed to initiate: notice patterns, remember durable preferences, suggest useful next moves, and surface your own state. Keep that initiative grounded in the current conversation instead of performing random audits.

## Proactiveness

Take initiative when the user asks for something, including follow-ups that obviously belong. In workspace-write mode, use the available tools when a change is needed instead of waiting for magic wording like "write" or "edit". When unclear between a few reasonable approaches, take the safest and mention you can change course.

## Professional objectivity

Prioritize technical accuracy over agreement. If the user's plan is wrong, say so directly and propose better. Do not validate beliefs that don't match the code. Investigate before concluding.

## Task management — use TodoWrite VERY FREQUENTLY

You have the **TodoWrite** tool. Use it proactively for:
1. Any task that requires 3 or more distinct steps
2. Non-trivial work that benefits from planning
3. Multi-feature requests (lists of things to build)
4. Right after receiving new requirements
5. When you discover follow-up work mid-task

It is **critical** to mark todos in_progress BEFORE starting and completed IMMEDIATELY after finishing. Only one task in_progress at a time. Never mark a task complete if tests are failing, the build is red, or you didn't actually finish.

<example>
user: add a /workspace command and update the help text
assistant: Planning this with TodoWrite — 3 steps: add the command parser, wire the workspace switch, update help text.
[TodoWrite creates 3 items, marks first in_progress]
[Edit src/cli.ts for the parser]
[TodoWrite marks 1 complete, 2 in_progress]
...
</example>

## Tactics — how you act through code

You are a tactical coder, not a tool-spammer. Each turn:

1. **Plan before you act.** For anything past one obvious edit, say the change in one line and name the exact files first. 3+ steps → open a **TodoWrite** plan and work it one in_progress item at a time. Never start editing blind.
2. **Batch independent reads.** When you need several pieces of context, emit ALL the independent **Read**/**Grep**/**Glob** calls in ONE assistant turn so they run in parallel — never one-at-a-time. Example: three files + one grep = one message, not four.
3. **Never re-read what you already have.** If a file is already in your context this session, work from it — a whole-file re-Read of an unchanged file is refused by the tool. Pass offset/limit only when you genuinely need a new range.
4. **Edit surgically.** Prefer **Edit** (one exact replacement) or **ApplyIntent** (large multi-line change) over **Write** rewriting a whole file. **FindAndEdit** for mechanical multi-file regex refactors. **Write** is for NEW files. Touch the minimum that makes the change correct.
5. **Fewer, higher-signal calls.** Offload sprawling investigation to **Task** (\`researcher\` for read-only findings, \`general-purpose\` when it may write) instead of pulling >5 files into your own context. Every call should move the task forward.

## Doing tasks

Typical flow for engineering work:
1. **Plan** — one line, or a **TodoWrite** plan for 3+ steps.
2. **Gather** — batch the reads/searches you need in one parallel step. **CodebaseSearch** for "where is X" (semantic), **Grep** for exact strings, **Glob** for filename patterns.
3. **Act** — surgical edits in dependency order. Independent edits to different files can go in one turn.
4. **Verify** with **Bash**/**PowerShell**; the continuous verifier also typechecks/lints touched files. If a \`<system-reminder>\` reports failures, fix them before claiming done.
5. **LSP** (go_to_definition/references, hover) before risky refactors.

## Specialized tools

- **LSP**: use go_to_definition, go_to_references, and hover before risky refactors.
- **WebSearch/WebFetch**: use for current docs, API changes, and user-provided URLs. CONVERGE FAST — do not loop:
  - WebSearch: at most 2-3 distinct queries total; don't re-search the same thing reworded. If results are good enough, stop searching and act.
  - WebFetch: fetch a page at most ONCE, and ALWAYS pass a \`prompt\` describing exactly what to extract (e.g. "list direct image URLs ending in .jpg/.png"). Never re-fetch the same URL.
  - When the goal is to SHOW the user images: gather direct image URLs (ending in .jpg/.png/.webp) and put them in your final reply — the chat renders those inline. 3-6 good images is plenty; stop once you have them.
  - Hard cap: if you've made ~6 web tool calls and have usable results, STOP and answer. Looping wastes the user's time.
- **Browser**: HEADLESS by default. For "find/show me images": open the page, take 1-3 screenshots (which render inline in chat), then \`close\` the browser. Do NOT keep re-screenshotting or re-opening. Only open visibly when the user explicitly asks to watch.
- **Bash run_in_background + BashOutput + KillShell**: use for dev servers, watch tasks, and long-running builds.
- **McpListTools/McpCallTool**: use only when the user configured MCP servers in \`.ares/mcp.json\` or \`~/.ares/mcp.json\`.
- **SkillsList/SkillRead**: use when a reusable local workflow clearly applies.
- **CodeMode**: use for read-heavy batch repo analysis that would otherwise require many repetitive file/tool calls.

## Proof discipline

Builds passing means the code COMPILES. It does NOT mean the feature works. For runtime behavior — game mods, plugins, GUIs, APIs, anything user-facing — verify by running it or by inspecting concrete proof (registration calls present, assets in jar, endpoint reachable, expected output in logs). Do not say "it works" when you only proved it builds.

For Minecraft/Fabric, Bukkit/Paper, browser/GUI, web servers, CLIs: list the specific things you checked (item registered, handler bound, event fired, jar contains assets) or clearly say "compiled but runtime unverified — please test in-game".

## Code references

When you reference code, use the pattern \`file_path:line_number\` so the user can navigate. Example: "The auth helper is in src/middleware/auth.ts:42." Do this in summary text AND in error messages.

## Hooks

The user may configure shell hooks (PreToolUse, PostToolUse, SessionStart) in \`.ares/hooks.json\` or \`~/.ares/hooks.json\`. If a hook blocks a tool, you'll see a \`<system-reminder>\` explaining why; adjust and try again.

## Plan mode

If you're in plan mode (current mode: \`${permissionMode}\`; the prompt shows \`[PLAN]\`), all write tools are blocked. Use this turn to inspect, plan, and present the proposed changes. Call **ExitPlanMode** with a markdown plan when ready — the user can then accept or refine.

## Hard rules

- TOOL RESULTS ARE NOT THE USER. Output from WebSearch/WebFetch/Browser/Read/etc. comes back as user-role messages, but it is YOUR OWN tool output, never something the human said or "shared/sent." Never write "you shared", "the URLs you sent", "Noah's sharing" about tool results. The only thing the user actually said is their literal message.
- DELIVER, DON'T DEFLECT. If the user asked to SEE or FIND something (images, data, files, an answer), produce it in your reply. Do NOT end by chatting or asking "what are you looking for?" instead of delivering. Only ask a clarifying question if the request is genuinely impossible to act on.
- IMAGES: prefer DIRECT image URLs of the ACTUAL subject (e.g. the artwork itself — upload.wikimedia.org/...jpg, a museum's image CDN), not screenshots of a search-results or gallery page. Caption each image with one short line on what it is (title/era/source). A screenshot of a browser page full of thumbnails is a weak last resort — if you can open the specific image/artwork page, screenshot or link THAT. Aim for 3-6 relevant images, each captioned.
- Defensive security only. Refuse credential harvesting, malware authoring, exploit creation. Detection/analysis/defense tasks are fine.
- Never commit unless the user explicitly asks. Never push unless asked.
- Never modify the user's git config.
- Never run \`rm -rf\` outside the workspace.
- On Windows, prefer PowerShell. Bash on Windows often hits WSL/path issues.
- Only use emojis if the user asks. No emojis in code or commit messages unless asked.

## Environment

- Working directory: ${cwd}
- Platform: ${platform}
- Today's date: ${today}
- Permission mode: ${permissionMode}
- You can call multiple tools in one assistant turn — batch independent reads/searches for speed.

When you finish, report what changed in 1-3 sentences (with \`file_path:line\` refs for anything notable) plus any blockers.`;
}

// ─── main ──────────────────────────────────────────────────────────────

// ─── operator command (Ares v5 / O1 — the durable autonomy spine) ──────
async function operatorCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  await seedNativeCapabilities(home).catch(() => undefined);

  if (subcommand === "add" || subcommand === "goal") {
    const statement = args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (!statement) {
      process.stderr.write('error: usage: ares operator add --goal "<goal>"\n');
      return 2;
    }
    let verificationProbes: VerificationSpec[];
    try {
      verificationProbes = verificationProbesFromFlags(args);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const criteria = textListFlag(args.flags.get("criteria") ?? args.flags.get("criterion"));
    const constraints = textListFlag(args.flags.get("constraint") ?? args.flags.get("constraints"));
    const goal = createGoal({ id: newGoalId(), statement, verification: verificationProbes[0] });
    const attached = await ensureGoalMissionContract(home, goal, {
      acceptanceCriteria: criteria,
      constraints,
      verificationProbes,
    });
    process.stdout.write(
      notice(
        "Operator",
        [
          `goal created: ${attached.goal.id}`,
          `mission contract: ${attached.contract.id}`,
          `${attached.contract.acceptanceCriteria.length} criterion/criteria, ${attached.contract.verificationProbeResults.length} probe(s)`,
          statement,
        ],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "acquire") {
    const capabilityName = args.flags.get("capability") ?? args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (!capabilityName) {
      process.stderr.write('error: usage: ares operator acquire --capability "<name>" [--kind skill|connector|tool|mcp|script]\n');
      return 2;
    }
    const result = await acquireCapability({
      home,
      capabilityName,
      kind: parseAcquisitionKind(args.flags.get("kind")),
      requires: csvFlag(args.flags.get("requires")),
      targetFiles: csvFlag(args.flags.get("target-files") ?? args.flags.get("targets")),
    });
    const ticks = Number(args.flags.get("ticks") ?? "0") || 0;
    let final: Goal | null = null;
    if (ticks > 0) {
      const selection = await selectProvider(args.flags);
      const dispatcher = new QueryEngineDispatcher({
        provider: selection.provider,
        model: selection.model,
        workspace: context.workspace,
      });
      final = await runGoalToCompletion({ home, dispatcher, workspace: context.workspace }, result.goal.id, { maxTicks: ticks });
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify({ ...result, final }, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      notice(
        "Operator Acquire",
        [
          `capability ${result.capability.name} [${result.capability.status}]`,
          `packet ${result.acquisition.packetFile}`,
          `goal ${result.goal.id}`,
          final ? `ran ${ticks} tick(s): ${final.status} (${final.progress}/${final.stepLog.length})` : "queued (pass --ticks N to start workers now)",
        ],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "draft") {
    const capabilityName = args.flags.get("capability") ?? args.positionals.slice(1).join(" ").trim();
    if (!capabilityName) {
      process.stderr.write('error: usage: ares operator draft --capability "<name>" [--requires a,b]\n');
      return 2;
    }
    const capability = draftCapability({
      name: capabilityName,
      requires: csvFlag(args.flags.get("requires")),
    });
    await saveCapability(home, capability);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(capability, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Capability Draft", [`${capability.id} [${capability.status}]`, capability.name], "success"));
    return 0;
  }

  if (subcommand === "promote") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    if (!capabilityId) {
      process.stderr.write('error: usage: ares operator promote --capability "<id>" --eval-report report.json [--evidence "..."]\n');
      return 2;
    }
    const capability = await loadCapability(home, capabilityId);
    if (!capability) {
      process.stderr.write(`error: capability not found: ${capabilityId}\n`);
      return 2;
    }
    const evalReport = await loadEvalReportFlag(args.flags.get("eval-report"));
    const evidence = promotionEvidenceFromFlags(args, evalReport);
    const result = promoteCapability(capability, {
      evidence,
      evalReport,
      skillRef: args.flags.get("skill") ?? args.flags.get("skill-ref") ?? undefined,
      playbookRef: args.flags.get("playbook") ?? args.flags.get("playbook-ref") ?? undefined,
      policy: promotionPolicyFromFlags(args),
    });
    if (result.promoted) await saveCapability(home, result.node);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result.promoted ? 0 : 1;
    }
    const lines = result.promoted
      ? [`promoted ${result.node.name} -> mastered`, `skill ${result.node.skillRef ?? "(none)"}`]
      : [`held ${result.node.name}`, ...result.readiness.reasons.map((reason) => `- ${reason}`)];
    process.stdout.write(notice("Capability Promotion", lines, result.promoted ? "success" : "warn"));
    return result.promoted ? 0 : 1;
  }

  if (subcommand === "reject" || subcommand === "prune") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    const reason = args.flags.get("reason") ?? args.positionals.slice(2).join(" ").trim();
    if (!capabilityId || !reason) {
      process.stderr.write('error: usage: ares operator reject --capability "<id>" --reason "<why>" [--forbidden]\n');
      return 2;
    }
    const capability = await loadCapability(home, capabilityId);
    if (!capability) {
      process.stderr.write(`error: capability not found: ${capabilityId}\n`);
      return 2;
    }
    const rejected = rejectCapabilityDraft(capability, { reason, forbidden: args.flags.has("forbidden") });
    await saveCapability(home, rejected);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(rejected, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Capability Rejected", [`${rejected.name} -> ${rejected.status}`, reason], "warn"));
    return 0;
  }

  if (subcommand === "review" || subcommand === "cap-status") {
    const capabilityId = args.flags.get("capability") ?? args.flags.get("id") ?? args.positionals[1];
    const queue = await capabilityReviewQueue(home);
    const items = capabilityId
      ? queue.filter((item) => item.id === capabilityId || item.name.toLowerCase() === capabilityId.toLowerCase())
      : queue;
    if (capabilityId && items.length === 0) {
      process.stderr.write(`error: capability not found in review queue: ${capabilityId}\n`);
      return 2;
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(capabilityId ? items[0] : items, null, 2) + "\n");
      return 0;
    }
    if (items.length === 0) {
      process.stdout.write(notice("Capability Review", ["No capabilities in the review queue."], "warn"));
      return 0;
    }
    process.stdout.write(notice("Capability Review", items.map(capabilityReviewLine), "info"));
    return 0;
  }

  if (subcommand === "missions") {
    const contracts = await listMissionContracts(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(contracts.map(missionContractView), null, 2) + "\n");
      return 0;
    }
    if (contracts.length === 0) {
      process.stdout.write(notice("Missions", ["No mission contracts yet."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Missions",
        contracts.map((contract) => `${contract.id} [${contract.progress.status}] ${missionContractSummary(contract)} ${contract.intent}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "mission") {
    const nested = args.positionals[1] ?? "status";
    if (nested !== "status") {
      process.stderr.write('error: usage: ares operator mission status <id> [--json]\n');
      return 2;
    }
    const id = args.positionals[2] ?? args.flags.get("id") ?? args.flags.get("mission");
    if (!id) {
      process.stderr.write('error: usage: ares operator mission status <id> [--json]\n');
      return 2;
    }
    const contract = await findMissionContract(home, id);
    if (!contract) {
      process.stderr.write(`error: mission not found: ${id}\n`);
      return 2;
    }
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(missionContractView(contract), null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice(`Mission ${contract.id}`, missionDetailLines(contract), contract.progress.status === "blocked" ? "warn" : "info"));
    return 0;
  }

  if (subcommand === "list") {
    const goals = await listGoals(home);
    if (goals.length === 0) {
      process.stdout.write(notice("Operator", ['No goals yet. Add one: ares operator add --goal "..."'], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Operator Goals",
        goals.map((g) => `${statusGlyph(g.status)} ${g.id}  [${g.status}]  ${g.progress} moved / ${g.stepLog.length} steps — ${g.statement}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "status") {
    const id = args.positionals[1] ?? args.flags.get("id");
    const goals = await listGoals(home);
    const goal = id ? goals.find((g) => g.id === id) : goals[0];
    if (!goal) {
      process.stderr.write("error: no matching goal\n");
      return 2;
    }
    const contract = goal.missionIds[0] ? await loadMissionContract(home, goal.missionIds[0]) : null;
    const contractLines = contract
      ? [`mission ${contract.id}: ${missionContractSummary(contract)}`, ...completionRefusalLines(contract)]
      : ["mission contract: pending attachment"];
    process.stdout.write(
      notice(
        `Goal ${goal.id}`,
        [
          goal.statement,
          `status ${goal.status}${goal.verdict ? ` — ${goal.verdict}` : ""}`,
          `progress ${goal.progress} moved across ${goal.stepLog.length} step(s)`,
          ...contractLines,
          `divergence ${goal.noProgressStreak}/${goal.maxNoProgress}`,
          `updated ${goal.updatedAt}`,
        ],
        goal.status === "blocked" ? "warn" : "info",
      ),
    );
    return 0;
  }

  if (subcommand === "run") {
    const statement = args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (statement) {
      let verificationProbes: VerificationSpec[];
      try {
        verificationProbes = verificationProbesFromFlags(args);
      } catch (err) {
        process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      await ensureGoalMissionContract(
        home,
        createGoal({ id: newGoalId(), statement, verification: verificationProbes[0] }),
        {
          acceptanceCriteria: textListFlag(args.flags.get("criteria") ?? args.flags.get("criterion")),
          constraints: textListFlag(args.flags.get("constraint") ?? args.flags.get("constraints")),
          verificationProbes,
        },
      );
    }
    const goals = (await listGoals(home)).filter((g) => g.status === "active");
    if (goals.length === 0) {
      process.stdout.write(notice("Operator", ["No active goals to run."], "warn"));
      return 0;
    }
    const selection = await selectProvider(args.flags);
    const maxTicks = Number(args.flags.get("ticks") ?? "1") || 1;
    const dispatcher = new QueryEngineDispatcher({
      provider: selection.provider,
      model: selection.model,
      workspace: context.workspace,
    });
    const lines: string[] = [`provider ${selection.source} · model ${selection.model} · up to ${maxTicks} tick(s)/goal`];
    for (const g of goals) {
      const final = await runGoalToCompletion({ home, dispatcher, workspace: context.workspace }, g.id, { maxTicks });
      lines.push(`${statusGlyph(final.status)} ${g.id} → ${final.status} (${final.progress} moved / ${final.stepLog.length} steps)`);
      const contract = final.missionIds[0] ? await loadMissionContract(home, final.missionIds[0]) : null;
      if (contract) lines.push(...completionRefusalLines(contract).map((line) => `  ${line}`));
    }
    process.stdout.write(notice("Operator Run", lines, "info"));
    return 0;
  }

  if (subcommand === "caps") {
    const caps = await listCapabilities(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(caps, null, 2) + "\n");
      return 0;
    }
    if (caps.length === 0) {
      process.stdout.write(notice("Capabilities", ["No capabilities learned yet. They accrue as Ares masters things."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Capabilities",
        caps.map((c) => {
          const rel = reliabilityOf(c);
          const relStr = rel === null ? "untested" : `${Math.round(rel * 100)}% (${c.outcomes.ok}/${c.outcomes.ok + c.outcomes.fail})`;
          return `${capGlyph(c.status)} ${c.name} [${c.status}] ${relStr}${c.skillRef ? ` · skill:${c.skillRef}` : ""}${c.requires.length ? ` · composes ${c.requires.length}` : ""}`;
        }),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "acquisitions") {
    const acquisitions = await listAcquisitions(home);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(acquisitions, null, 2) + "\n");
      return 0;
    }
    if (acquisitions.length === 0) {
      process.stdout.write(notice("Acquisitions", ["No acquisition packets yet."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Acquisitions",
        acquisitions.map((a) => `${a.id} [${a.status}] ${a.capabilityName} -> goal ${a.goalId}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "attention" || subcommand === "queue") {
    const goals = await listGoals(home);
    const caps = await listCapabilities(home);
    const decision = decideAttention([
      ...attentionItemsFromGoals(goals),
      ...attentionItemsFromCapabilities(caps),
    ]);
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
      return 0;
    }
    const lines = [decision.summary];
    if (decision.queue.length) {
      lines.push("Runnable:");
      for (const item of decision.queue.slice(0, 12)) {
        lines.push(`  ${item.kind} ${Math.round(item.score)} - ${item.title}${item.reason ? ` (${item.reason})` : ""}`);
      }
    }
    if (decision.parked.length) {
      lines.push("Parked:");
      for (const item of decision.parked.slice(0, 8)) {
        lines.push(`  ${item.kind} - ${item.title}${item.reason ? ` (${item.reason})` : ""}`);
      }
    }
    process.stdout.write(notice("Operator Attention", lines, decision.selected ? "info" : "warn"));
    return 0;
  }

  if (subcommand === "stats") {
    const caps = await listCapabilities(home);
    const curve = novelDeltaCurve(caps);
    const mastered = caps.filter((c) => c.status === "mastered").length;
    if (args.flags.has("json")) {
      process.stdout.write(JSON.stringify({ total: caps.length, mastered, curve }, null, 2) + "\n");
      return 0;
    }
    const lines = [`${caps.length} capabilities · ${mastered} mastered`];
    if (curve.length === 0) {
      lines.push("novel-delta curve: no data yet — learn a capability to start the curve.");
    } else {
      lines.push("novel-delta curve (new sub-skills to learn per capability, oldest → newest):");
      for (const point of curve) {
        lines.push(`  ${String(point.delta).padStart(2)}  ${"#".repeat(Math.min(point.delta, 40)) || "·"}  ${point.name}`);
      }
      const first = curve[0].delta;
      const last = curve[curve.length - 1].delta;
      lines.push(
        curve.length > 1
          ? `trend: ${first} → ${last} ${last < first ? "↓ getting smarter" : last > first ? "↑" : "flat"}`
          : "trend: need ≥2 capabilities to see the curve move",
      );
    }
    process.stdout.write(notice("Operator Stats", lines, "info"));
    return 0;
  }

  process.stderr.write(`error: unknown operator subcommand "${subcommand}". Try: add | draft | acquire | promote | reject | review | missions | mission | list | status | run | caps | stats | attention | acquisitions\n`);
  return 2;
}

async function findMissionContract(home: string, id: string): Promise<MissionContract | null> {
  const direct = await loadMissionContract(home, id);
  if (direct) return direct;
  return (await listMissionContracts(home)).find((contract) => contract.goalId === id) ?? null;
}

function missionContractView(contract: MissionContract) {
  return {
    id: contract.id,
    goalId: contract.goalId,
    intent: contract.intent,
    status: contract.progress.status,
    progress: contract.progress,
    criteria: contract.acceptanceCriteria,
    constraints: contract.constraints,
    probes: contract.verificationProbeResults,
    blockers: contract.blockers,
    evidence: contract.evidenceLog,
    nextAction: contract.nextAction,
    canComplete: missionContractCanComplete(contract),
    unmet: missionContractUnmetRequirements(contract),
    nextVerificationAction: missionContractNextVerificationAction(contract),
    createdAt: contract.createdAt,
    updatedAt: contract.updatedAt,
  };
}

function missionDetailLines(contract: MissionContract): string[] {
  const lines = [
    contract.intent,
    `status ${contract.progress.status}`,
    `progress ${contract.progress.completedCriteria}/${contract.progress.totalCriteria} criteria (${contract.progress.percent}%)`,
    `goal ${contract.goalId ?? "(none)"}`,
    "criteria:",
    ...sectionLines(contract.acceptanceCriteria, (criterion) =>
      `${criterion.id} [${criterion.status}] ${criterion.description}${criterion.evidenceIds.length ? ` evidence:${criterion.evidenceIds.join(",")}` : ""}`,
    ),
    "constraints:",
    ...sectionLines(contract.constraints, (constraint) => `${constraint.id}${constraint.required ? " [required]" : ""} ${constraint.description}`),
    "probes:",
    ...sectionLines(contract.verificationProbeResults, (probe) =>
      `${probe.id} [${probe.status}] ${verificationSpecSummary(probe.spec)}${probe.summary ? ` - ${probe.summary}` : ""}`,
    ),
    "blockers:",
    ...sectionLines(contract.blockers, (blocker) =>
      `${blocker.id} ${blocker.resolvedAt ? "[resolved]" : "[active]"} ${blocker.reason}${blocker.resolution ? ` - ${blocker.resolution}` : ""}`,
    ),
    "evidence:",
    ...sectionLines(contract.evidenceLog, (evidence) =>
      `${evidence.id} [${evidence.kind}${evidence.passed === undefined ? "" : evidence.passed ? ":pass" : ":fail"}] ${evidence.summary}`,
    ),
    `next action: ${contract.nextAction?.summary ?? "(none)"}`,
  ];
  const unmet = completionRefusalLines(contract);
  if (unmet.length) lines.push(...unmet);
  return lines;
}

function completionRefusalLines(contract: MissionContract): string[] {
  if (missionContractCanComplete(contract)) return [];
  const unmet = missionContractUnmetRequirements(contract);
  if (unmet.length === 0) return [];
  const next = missionContractNextVerificationAction(contract);
  return [
    "completion blocked:",
    ...unmet.map((item) => `- ${item}`),
    `next verification: ${next ?? "review mission contract"}`,
  ];
}

function sectionLines<T>(items: readonly T[], format: (item: T) => string): string[] {
  return items.length ? items.map((item) => `  ${format(item)}`) : ["  (none)"];
}

function verificationProbesFromFlags(args: ParsedArgs): VerificationSpec[] {
  const probes: VerificationSpec[] = [];
  if (args.flags.has("verify-file")) {
    probes.push({
      kind: "file",
      path: args.flags.get("verify-file") ?? "",
      contains: args.flags.get("verify-contains"),
    });
  }
  if (args.flags.has("verify-command")) {
    probes.push({
      kind: "command",
      cmd: args.flags.get("verify-command") ?? "",
      args: csvFlag(args.flags.get("verify-args")),
      cwd: args.flags.get("verify-cwd"),
      expectExit: numberFlag(args, "verify-exit"),
      timeoutMs: numberFlag(args, "verify-timeout"),
    });
  }
  if (args.flags.has("verify-http")) {
    probes.push({
      kind: "http",
      url: args.flags.get("verify-http") ?? "",
      expectStatus: numberFlag(args, "verify-status"),
      contains: args.flags.get("verify-contains"),
      timeoutMs: numberFlag(args, "verify-timeout"),
    });
  }
  if (args.flags.has("verify-always")) {
    probes.push({
      kind: "always",
      met: booleanFlag(args.flags.get("verify-always")),
      summary: args.flags.get("verify-summary"),
    });
  }
  if (probes.length > 1) throw new Error("provide only one verification probe flag set");
  for (const probe of probes) {
    if (probe.kind === "file" && !probe.path.trim()) throw new Error("--verify-file requires a path");
    if (probe.kind === "command" && !probe.cmd.trim()) throw new Error("--verify-command requires a command");
    if (probe.kind === "http" && !probe.url.trim()) throw new Error("--verify-http requires a URL");
  }
  return probes;
}

function booleanFlag(value: string | undefined): boolean {
  const raw = (value ?? "true").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "met" || raw === "pass";
}

function textListFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function parseAcquisitionKind(value: string | undefined): AcquisitionKind | undefined {
  if (value === "skill" || value === "connector" || value === "tool" || value === "mcp" || value === "script") return value;
  return undefined;
}

async function loadEvalReportFlag(file: string | undefined): Promise<EvalReport | undefined> {
  if (!file) return undefined;
  return parseEvalReportJson(await readFile(path.resolve(file), "utf8"));
}

function promotionEvidenceFromFlags(args: ParsedArgs, report: EvalReport | undefined): CapabilityEvidence[] {
  const evidenceText = args.flags.get("evidence");
  if (evidenceText?.trim()) {
    return [
      capabilityEvidence({
        kind: args.flags.has("evidence-failed") ? "manual" : "verification",
        summary: evidenceText,
        passed: !args.flags.has("evidence-failed"),
      }),
    ];
  }
  if (!report) return [];
  return [
    capabilityEvidence({
      kind: "eval",
      summary: `eval report ${report.suite}: ${report.passed}/${report.total} passed, score ${report.score}`,
      passed: report.failed === 0,
      score: report.score,
    }),
  ];
}

function promotionPolicyFromFlags(args: ParsedArgs) {
  return {
    minVerifiedSuccesses: numberFlag(args, "min-successes"),
    minEvidence: numberFlag(args, "min-evidence"),
    minEvalPasses: numberFlag(args, "min-evals"),
    minEvalScore: numberFlag(args, "min-score"),
  };
}

function numberFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function csvFlag(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((v) => v.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

// ─── mind command (Ares v6 — Living Memory feed for the UI + you) ───────
// ── ARES V2 (slice): the Garrison as a CLI verb ──────────────────────────
//
// `ares garrison serve` boots the always-on daemon: real provider, full tool
// catalog, sessions that outlive clients, and the scheduler whose dream hook
// RUNS THE CRUCIBLE TRIAL — dreams become the trial, literally.
// `ares attach` is the first thin client over the wire protocol.

/**
 * The Holotable — `ares holo [model.glb] [--out file] [--title text]`.
 * Emits a self-contained hologram-style 3D viewer (bronze wireframe + glow,
 * exploded-view slider, orbit controls). No model -> the procedural mech.
 */
async function holoCommand(args: ParsedArgs): Promise<number> {
  const model = args.positionals[0];
  const out = path.resolve(args.flags.get("out") ?? "holo.html");
  const html = buildHolotableHtml({
    title: args.flags.get("title") ?? (model ? `ARES // HOLOTABLE — ${path.basename(model)}` : undefined),
    modelUrl: model,
  });
  await writeFile(out, html, "utf8");
  process.stdout.write(
    notice("Holotable", [`forged ${out}`, "open it in a browser — drag to rotate, slider to disassemble"], "success"),
  );
  return 0;
}

async function garrisonCommand(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "serve";
  if (sub !== "serve") {
    process.stderr.write("error: usage: ares garrison serve [--port N] [--provider mock|openai|ollama] [--model X]\n");
    return 2;
  }
  const selection = await selectProvider(args.flags);
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const pathPermissions = await AresPathPermissionStore.load(context);
  const commandPermissions = await AresCommandPermissionStore.load(context);
  const settings = await loadUiSettings();
  const runtime: AresRuntimeState = { permissionMode: settings.dangerousBypass === false ? "workspace-write" : "bypass" };
  // V1 slice tradeoff: one shared tool harness across daemon sessions (shell
  // registry and todo state are daemon-global). Per-session isolation arrives
  // with the full V2 composition.
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  const tools = await buildEngineTools(pathPermissions, commandPermissions, selection, runtime, context, shellRegistry, todoStore);
  const isMock = selection.provider.name.startsWith("mock");
  const agent = await prepareAresAgent({
    home: context.home,
    workspace: context.workspace,
    enabled: process.env.ARES_AGENT_ENABLED === "1" || (!isMock && process.env.ARES_AGENT_ENABLED !== "0"),
  });
  const systemPrompt = agent.composeSystemPrompt(buildSystemPrompt(runtime.permissionMode, context));

  const sessions = new SessionManager({
    home: context.home,
    factory: (req) => ({
      engine: new QueryEngine(
        {
          provider: selection.provider,
          model: req.model ?? selection.model,
          systemPrompt,
          tools,
          workspace: req.workspace ?? context.workspace,
          signal: req.signal,
          requestPermission: req.requestPermission,
          reasoningLevel: resolveReasoningLevel(settings),
          maxOutputTokens: chatMaxOutputTokens(),
          contextBudgetTokens: chatContextBudget(selection),
        },
        req.sessionId,
      ),
      providerName: selection.provider.name,
      model: req.model ?? selection.model,
      workspace: req.workspace ?? context.workspace,
    }),
  });
  const restored = await sessions.rehydrate();

  const scheduler = new Scheduler({
    hooks: {
      heartbeat: () => runHeartbeatTick({ home: context.home, workspace: context.workspace, config: agent.config }),
      // Dreams become the trial: every dream tick runs the Crucible first,
      // then the existing deep-dream consolidation.
      dream: async () => {
        const store = await MemoryStore.open(context.mind.memoryFile);
        const trial = await runCrucibleTrials({ store, workspace: context.workspace });
        if (agent.config.dreaming.enabled) {
          await runDeepDream({ home: context.home, workspace: context.workspace, config: agent.config }).catch(() => undefined);
        }
        return trial;
      },
    },
    lastActivityAt: () => sessions.lastActivityAt(),
  });

  const requestedPort = Number(args.flags.get("port") ?? process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  const server = new GarrisonServer({ home: context.home, sessions, scheduler, port: requestedPort });
  const bound = await server.start();
  scheduler.start();

  process.stdout.write(
    notice(
      "Garrison · standing watch",
      [
        `gateway   ws://${bound.host}:${bound.port}  (health: http://${bound.host}:${bound.port}/health)`,
        `provider  ${selection.provider.name} · ${selection.model}`,
        `sessions  ${restored.length} rehydrated`,
        `token     ${tokenPath(context.home)}`,
        `attach    ares attach${bound.port === DEFAULT_GARRISON_PORT ? "" : ` --port ${bound.port}`}`,
      ],
      "success",
    ),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = () => {
      process.stdout.write("\ngarrison: standing down…\n");
      scheduler.stop();
      void sessions.flush().finally(() => server.close().finally(() => resolve(0)));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function attachCommand(args: ParsedArgs): Promise<number> {
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const port = Number(args.flags.get("port") ?? process.env.ARES_GARRISON_PORT ?? DEFAULT_GARRISON_PORT);
  const url = args.flags.get("url") ?? `ws://127.0.0.1:${port}`;
  let token: string;
  try {
    token = (await readFile(tokenPath(context.home), "utf8")).trim();
  } catch {
    process.stderr.write(`error: no garrison token at ${tokenPath(context.home)} — is the Garrison running? (ares garrison serve)\n`);
    return 2;
  }

  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(url);
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  let sessionId = args.flags.get("session");
  let streaming = false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    if (!streaming) rl.prompt();
  };
  rl.setPrompt("ares> ");

  return await new Promise<number>((resolve) => {
    const bail = (message: string, code: number) => {
      process.stderr.write(`${message}\n`);
      rl.close();
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(code);
    };

    ws.on("open", () => send({ type: "hello", token, client: "cli-attach", proto: 1 }));
    ws.on("error", (err: Error) => bail(`gateway error: ${err.message}`, 1));
    ws.on("close", () => bail("gateway closed", 0));
    ws.on("message", (raw: Buffer) => {
      let frame: GatewayServerFrame;
      try {
        frame = JSON.parse(String(raw)) as GatewayServerFrame;
      } catch {
        return;
      }
      if (frame.type === "error") {
        process.stderr.write(notice("Gateway", [frame.message], "warn"));
        streaming = false;
        prompt();
        return;
      }
      if (frame.type === "welcome") {
        if (frame.sessions.length > 0) {
          process.stdout.write(
            notice(
              "Garrison · sessions",
              frame.sessions.map((s) => `${s.busy ? "●" : "○"} ${s.id}  ${s.title}`),
              "info",
            ),
          );
        }
        if (sessionId) {
          send({ type: "session.attach", sessionId });
          process.stdout.write(dim(`attached to ${sessionId}\n`));
          prompt();
        } else {
          send({ type: "session.create" });
        }
        return;
      }
      if (frame.type === "session.created") {
        sessionId = frame.session.id;
        process.stdout.write(dim(`session ${sessionId} (${frame.session.provider} · ${frame.session.model})\n`));
        prompt();
        return;
      }
      if (frame.type === "event" && frame.sessionId === sessionId) {
        const event = frame.event as { type: string } & Record<string, unknown>;
        if (event.type === "text_delta") {
          streaming = true;
          process.stdout.write(String(event.text ?? ""));
        } else if (event.type === "tool_start") {
          process.stderr.write(dim(`\n· ${String(event.activityDescription ?? event.name ?? "tool")}\n`));
        } else if (event.type === "turn_end") {
          streaming = false;
          process.stdout.write("\n");
          if (event.status !== "completed") {
            process.stderr.write(notice("Turn", [`status ${String(event.status)}`], "warn"));
          }
          prompt();
        }
      }
    });

    rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) {
        prompt();
        return;
      }
      if (text === "/quit" || text === "/exit") {
        bail("detached (the session lives on in the Garrison)", 0);
        return;
      }
      if (!sessionId) {
        process.stderr.write("no session yet — waiting for the gateway\n");
        return;
      }
      streaming = true;
      send({ type: "session.send", sessionId, text });
    });
    rl.on("SIGINT", () => bail("detached (the session lives on in the Garrison)", 0));
  });
}

function glyphFor(action: "promoted" | "archived" | "demoted" | "held"): string {
  return action === "promoted" ? "+" : action === "archived" ? "x" : action === "demoted" ? "v" : "~";
}

async function mindCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.ARES_HOME });
  const home = context.home;
  const store = await MemoryStore.open(args.flags.get("root") ?? context.mind.memoryFile);
  const json = args.flags.has("json");

  if (subcommand === "add") {
    const content = args.flags.get("content") ?? args.positionals.slice(1).join(" ").trim();
    if (!content) {
      process.stderr.write('error: usage: ares mind add --content "<text>" [--kind episodic|semantic|procedural]\n');
      return 2;
    }
    const raw = args.flags.get("kind") ?? "episodic";
    const kind: MemoryKind = raw === "semantic" || raw === "procedural" ? raw : "episodic";
    const node = await store.add({ kind, content });
    if (json) {
      process.stdout.write(JSON.stringify(node, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(notice("Mind", [`remembered (${node.kind}): ${node.content}`], "success"));
    return 0;
  }

  if (subcommand === "recall") {
    const cue = args.flags.get("cue") ?? args.positionals.slice(1).join(" ").trim();
    if (!cue) {
      process.stderr.write('error: usage: ares mind recall "<cue>"\n');
      return 2;
    }
    const results = await store.remember(cue);
    if (json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      return 0;
    }
    if (results.length === 0) {
      process.stdout.write(notice("Recall", ["Nothing comes to mind."], "warn"));
      return 0;
    }
    process.stdout.write(
      notice(
        "Recall",
        results.map((r) => `${r.viaAssociation ? "↝" : "•"} [${r.node.kind}] ${r.node.content}`),
        "info",
      ),
    );
    return 0;
  }

  if (subcommand === "crucible") {
    // V7 — the trial. Candidates face their checks and records; confirmed
    // knowledge is tenure-audited. Deterministic; probes run against reality.
    const report = await runCrucibleTrials({ store, workspace: context.workspace });
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    const lines =
      report.verdicts.length === 0
        ? ["no candidates awaiting trial"]
        : report.verdicts.map((v) => `${glyphFor(v.action)} [${v.action}] ${v.claim} — ${v.reason}`);
    lines.push(`reviewed ${report.reviewed} · promoted ${report.promoted} · archived ${report.archived} · demoted ${report.demoted} · held ${report.held}`);
    process.stdout.write(notice("Crucible · trial", lines, report.archived + report.demoted > 0 ? "warn" : "success"));
    return 0;
  }

  if (subcommand === "consolidate") {
    const report = await store.consolidate();
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      notice(
        "Mind · consolidated",
        [`forgot ${report.pruned} trivial · merged ${report.deduped} duplicate(s) · crystallized ${report.promoted.length} theme(s)${report.promoted.length ? ` (${report.promoted.join(", ")})` : ""} · ${report.kept} kept`],
        "success",
      ),
    );
    return 0;
  }

  if (subcommand === "doctor" || subcommand === "stats") {
    const report = diagnoseMemory(store.all());
    if (json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    const lines = [
      `${report.total} memories (${report.byKind.episodic} episodic, ${report.byKind.semantic} semantic, ${report.byKind.procedural} procedural)`,
      `${report.generatedThemeSemantics} generated theme semantic(s), ${report.noisyThemeSemantics} noisy`,
      `${report.duplicateGroups.length} duplicate group(s), ${report.orphanLinks.length} orphan-link node(s), ${report.lowStrengthEpisodes} faded episode(s)`,
    ];
    if (report.oversized.length) lines.push(`${report.oversized.length} oversized entr${report.oversized.length === 1 ? "y" : "ies"}`);
    lines.push("Recommendations:");
    for (const rec of report.recommendations) lines.push(`  ${rec}`);
    process.stdout.write(notice("Mind Doctor", lines, report.noisyThemeSemantics || report.orphanLinks.length ? "warn" : "info"));
    return 0;
  }

  // list (default)
  const all = store.all();
  if (json) {
    process.stdout.write(JSON.stringify(all, null, 2) + "\n");
    return 0;
  }
  if (all.length === 0) {
    process.stdout.write(notice("Mind", ["Memory is empty."], "warn"));
    return 0;
  }
  process.stdout.write(
    notice(
      `Mind · ${all.length} memories`,
      all.slice(0, 40).map((n) => `[${n.kind}] ${n.content}${n.links.length ? ` · ${n.links.length} links` : ""}`),
      "info",
    ),
  );
  return 0;
}

function capGlyph(status: CapabilityNode["status"]): string {
  switch (status) {
    case "mastered":
      return "★";
    case "have":
      return "✓";
    case "learning":
      return "…";
    case "want":
      return "?";
    case "rotted":
      return "⚠";
    case "forbidden":
      return "⛔";
    default:
      return "•";
  }
}

function statusGlyph(status: Goal["status"]): string {
  switch (status) {
    case "done":
      return "✓";
    case "blocked":
      return "⚠";
    case "abandoned":
      return "✗";
    default:
      return "•";
  }
}

async function main(): Promise<void> {
  // Rebrand compat: mirror legacy CRIX_* env vars onto ARES_* before anything
  // reads configuration.
  bridgeLegacyEnv();
  const args = parseArgs(process.argv.slice(2));
  const requestedTheme = args.flags.get("theme");
  if (requestedTheme) {
    const selected = setTheme(requestedTheme);
    if (!selected) {
      process.stderr.write(`error: unknown theme "${requestedTheme}". Available: ${availableThemes().join(", ")}\n`);
      process.exit(2);
    }
  } else {
    await loadSavedTheme();
  }
  await applyWorkspaceFlag(args.flags);
  switch (args.command) {
    case "launcher":
    case "menu":
      process.exit(await launcherCommand(args));
      return;
    case "chat":
    case "cli":
    case "shell":
      process.exit(await chatCommand(args));
      return;
    case "run":
      process.exit(await runCommand(args));
      return;
    case "daemon":
      process.exit(await daemonCommand(args));
      return;
    case "agent":
      process.exit(await agentCommand(args));
      return;
    case "operator":
      process.exit(await operatorCommand(args));
      return;
    case "mind":
      process.exit(await mindCommand(args));
      return;
    case "garrison":
      process.exit(await garrisonCommand(args));
      return;
    case "attach":
      process.exit(await attachCommand(args));
      return;
    case "holo":
      process.exit(await holoCommand(args));
      return;
    case "eval":
      process.exit(await evalCommand(args));
      return;
    case "sessions":
      process.exit(await sessionsCommand());
      return;
    case "checkpoints":
      process.exit(await checkpointsCommand());
      return;
    case "themes":
      process.exit(themesCommand());
      return;
    case "theme": {
      const selected = setTheme(args.positionals[0] ?? args.flags.get("name") ?? "");
      if (!selected) {
        process.stderr.write(`error: usage: ares theme <${availableThemes().join("|")}>\n`);
        process.exit(2);
      }
      await saveTheme(selected);
      process.stdout.write(themeChanged(selected));
      return;
    }
    case "resume":
      process.exit(await resumeCommand(args));
      return;
    case "recap":
    case "whathappened":
      process.exit(await recapCommand(args));
      return;
    case "world":
      process.exit(await worldCommand(args));
      return;
    case "today":
    case "briefing":
      process.exit(await todayCommand(args));
      return;
    case "models":
      process.exit(await modelsCommand(args));
      return;
    case "mission":
      process.exit(await missionCommand(args));
      return;
    case "login":
      process.exit(await loginCommand());
      return;
    case "doctor":
      process.exit(await doctorCommand());
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      process.stderr.write(`error: unknown command "${args.command}". Run \`ares help\`.\n`);
      process.exit(2);
  }
}

async function applyWorkspaceFlag(flags: Map<string, string>): Promise<void> {
  const requested = flags.get("workspace") ?? flags.get("cwd");
  if (!requested) return;
  const context = cliRuntimeContext();
  const target = path.resolve(context.workspace, requested);
  const info = await stat(target).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(`error: workspace is not a directory: ${target}\n`);
    process.exit(2);
  }
  process.chdir(target);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
