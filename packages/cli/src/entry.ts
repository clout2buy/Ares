#!/usr/bin/env node
// crix — v2 CLI entrypoint.
//
// Commands:
//   crix chat                                      interactive terminal loop
//   crix run --goal "<text>" [--provider openai|ollama] [--model X]
//   crix login                                      OAuth device-code
//   crix doctor                                     auth + ollama health
//   crix help
//
// `run` emits NDJSON for automation; `chat` renders a human terminal loop.

import {
  Session,
  MockEchoProvider,
  OpenAIResponsesProvider,
  OllamaCloudPool,
  DEFAULT_OLLAMA_SLOTS,
  CrixSubagentRunner,
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
  crixHome,
} from "@crix/core";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
} from "@crix/tools";
import type { ContentBlock, PermissionMode, PermissionPromptDecision, PermissionRule, PermissionRuleEffect, ReasoningLevel } from "@crix/protocol";
import { isReasoningLevel, reasoningLabel, REASONING_LEVELS } from "@crix/protocol";
import type { ToolPermissionRequest } from "@crix/core";
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
import {
  BootstrapTool,
  CrixAgentRuntime,
  MissionTool,
  RunSkillTool,
  SelfEvolveTool,
  SelfTool,
  SkillCraftTool,
  completeBootstrap,
  createMemoryStore,
  crixAgentHome,
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
  prepareCrixAgent,
  restoreSnapshot,
  runDeepDream,
  runRemDream,
  snapshotBrain,
  unifiedRecallForTurn,
} from "@crix/agent";
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
  type Goal,
  type CapabilityNode,
  type CapabilityEvidence,
  type MissionContract,
  type AcquisitionKind,
  type EvalReport,
  type EvalTask,
  type VerificationSpec,
} from "@crix/operator";
import { buildForegroundReminder, classifyUserIntent, diagnoseMemory, MemoryStore, mindPaths, type MemoryKind } from "@crix/mind";
import {
  Filmstrip,
  clickEffect,
  createPlaywrightBrowser,
  fillEffect,
  navigateEffect,
  type BrowserConnector,
} from "@crix/connectors";
import { Budget, KillSwitch, Ledger, effectsPaths, ownerLeash, runEffect } from "@crix/effects";

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
      "crix v0.3.0-alpha.1 — streaming coding-agent harness",
      "",
      "Commands:",
      "  crix launcher                                Open the provider/model launch deck.",
      "  crix chat [--provider openai|ollama|mock] [--model X]",
      "                              Open an interactive terminal prompt.",
      "  crix sessions               List saved workspace sessions.",
      "  crix checkpoints            List workspace checkpoints.",
      "  crix resume [session-id]     Resume a saved session (defaults to latest).",
      "  crix themes                 List terminal UI themes.",
      "  crix run --goal \"<text>\" [--provider openai|ollama|mock] [--model X]",
      "                              Run one turn, streaming TurnEvents as NDJSON.",
      "  crix daemon --json          Run NDJSON daemon mode for companion UIs.",
      "  crix agent bootstrap        Create or complete the v4 mind scaffold.",
      "  crix agent doctor           Show agent memory/backend status.",
      "  crix operator add --goal \"<text>\"    Create a durable long-horizon goal.",
      "                              Optional: --criteria \"A;B\" --constraint \"C\" --verify-file path [--verify-contains text].",
      "  crix operator draft --capability \"<name>\"",
      "                              Draft a capability before promotion.",
      "  crix operator acquire --capability \"email connector\" [--kind connector] [--ticks N]",
      "                              Register a missing capability and create its self-build goal.",
      "  crix operator promote --capability <id> --eval-report report.json [--evidence \"...\"]",
      "                              Promote only after verified outcomes, evidence, and evals.",
      "  crix operator review [--capability <id>] [--json]",
      "                              Inspect capability promotion/rejection status.",
      "  crix operator missions [--json]       Inspect mission contracts.",
      "  crix operator mission status <id> [--json]",
      "                              Inspect one mission contract.",
      "  crix operator list | status [id]     Inspect Operator goals.",
      "  crix operator run [--goal \"<text>\"] [--ticks N] [--provider X]",
      "                              Drive active goals via ephemeral QueryEngine workers.",
      "  crix operator caps | stats | attention [--json]",
      "                              Inspect capabilities, growth curve, and current attention queue.",
      "  crix mind recall \"<cue>\" [--json]   Spreading-activation recall from Living Memory.",
      "  crix mind add --content \"<text>\" [--kind episodic|semantic|procedural]",
      "  crix mind list | doctor | consolidate [--json]",
      "                              Inspect, diagnose, or sleep-consolidate memory.",
      "  crix eval [--json]         Run the built-in harness regression eval suite.",
      "  crix login                  ChatGPT OAuth device-code flow.",
      "  crix doctor                 Show provider auth + Ollama Cloud health.",
      "  crix help                   Print this help.",
      "",
      "Env vars:",
      "  CRIX_OPENAI_OAUTH_TOKEN     ChatGPT OAuth access token (bypass file login).",
      "  CRIX_REASONER, CRIX_APPLY, CRIX_SUMMARIZE",
      "                              Override Ollama Cloud slot models.",
      "  CRIX_HOME                   Override auth/config dir (default ~/.crix).",
      "  CRIX_RESUME_MESSAGES        Max replay messages before compaction (default 80, 0=all).",
      "  CRIX_THEME                  UI theme: cyberpunk, minimal, matrix, neon, split, professional, amber, dashboard, light.",
      "",
      "Flags:",
      "  --theme NAME                Use a UI theme for this run.",
      "  --workspace PATH            Run Crix against a specific workspace.",
      "",
      "Double-click crix.bat or run `crix chat` for the interactive prompt.",
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
  runtime: CrixRuntimeState;
  verifier: ContinuousVerifier;
  hooks: HookManager;
  shellRegistry: ShellRegistry;
  todoStore: TodoStore;
  agentRuntime?: CrixAgentRuntime;
  queueSystemReminder(text: string, source?: ManualReminderSource): void;
  resumed?: ResumedSessionInfo;
}

interface CrixRuntimeState {
  permissionMode: PermissionMode;
}

interface CliRuntimeContext {
  workspace: string;
  home: string;
  crixHome: string;
  mind: ReturnType<typeof mindPaths>;
  effects: ReturnType<typeof effectsPaths>;
  selfTerritoryRoots: string[];
  browserFilmstripRoot: string;
}

function cliRuntimeContext(options: { workspace?: string; home?: string } = {}): CliRuntimeContext {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const home = crixAgentHome(options.home);
  return {
    workspace,
    home,
    crixHome: crixHome(),
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
      model: requestedModel ?? process.env.CRIX_OPENAI_MODEL ?? settings.lastOpenAIModel ?? "gpt-5.5",
      source: explicit ? "explicit:openai" : preferred ? "settings:openai" : "auto:openai",
    };
  }

  if (preferred === "ollama" || !preferred) {
    const slots = {
      ...DEFAULT_OLLAMA_SLOTS,
      reasoner: { model: requestedModel ?? settings.lastOllamaModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model },
    };
    const pool = new OllamaCloudPool({ slots });
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

class CrixPathPermissionStore implements PathPermissionStore {
  private onceAllow: StoredPathGrant[] = [];

  private constructor(
    private readonly filePath: string,
    private readonly selfRoot: string,
    private readonly persisted: StoredPathPermissions,
  ) {}

  static async load(context: CliRuntimeContext): Promise<CrixPathPermissionStore> {
    const filePath = path.join(context.crixHome, "path-permissions.json");
    let persisted: StoredPathPermissions = { alwaysAllow: [] };
    try {
      persisted = JSON.parse(await readFile(filePath, "utf8")) as StoredPathPermissions;
      persisted.alwaysAllow ??= [];
    } catch {
      // First run.
    }
    return new CrixPathPermissionStore(filePath, context.home, persisted);
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

class CrixCommandPermissionStore implements CommandPermissionStore {
  private constructor(private readonly rules: PermissionRule[]) {}

  static async load(context: CliRuntimeContext): Promise<CrixCommandPermissionStore> {
    const files = [
      path.join(context.crixHome, "command-permissions.json"),
      path.join(context.workspace, ".crix", "command-permissions.json"),
    ];
    const rules: PermissionRule[] = [];
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, "utf8")) as StoredCommandPermissions;
        for (const rule of json.rules ?? []) {
          rules.push({
            pattern: rule.pattern,
            effect: rule.effect,
            source: file.startsWith(path.join(context.workspace, ".crix")) ? "project" : "user-global",
          });
        }
      } catch {
        // No command rules configured.
      }
    }
    return new CrixCommandPermissionStore(rules);
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
  runtime: CrixRuntimeState,
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

  const runner = new CrixSubagentRunner({
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
      "Use Crix's V6 Living Memory naturally, with no keyword needed: remember durable facts, recall by association, inspect the mind, and consolidate recurring experiences into semantic knowledge.",
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
    ticks: z.number().int().min(0).max(20).optional().describe("Maximum ticks to run now. For acquire, defaults to 1 so Crix starts building immediately; pass 0 to only queue."),
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
  runtime: CrixRuntimeState;
  context: CliRuntimeContext;
  workerTools: readonly EngineTool[];
}) {
  return buildTool({
    name: "Operator",
    description:
      "Crix's durable will and self-acquisition loop. Use it for long-horizon goals that should survive turns, and when a capability is missing use action=acquire to create the build packet, graph node, verification probe, and start a fresh Worker building it.",
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
    headless: z.boolean().optional().describe("Use headless Playwright when launching. Default true."),
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
      "Crix's DOM-first eyes and hands for the web. Use APIs/MCP/CLI first when better, then this browser connector to open pages, inspect the accessibility tree, fill forms, click controls, screenshot, and record visual proof.",
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

async function browserRailsContext(context: CliRuntimeContext) {
  const paths = context.effects;
  return {
    ledger: await Ledger.open(paths.ledgerFile),
    budget: new Budget(),
    killSwitch: new KillSwitch(paths.killSwitchFile),
    leashOf: ownerLeash(),
  };
}

function filmstripDir(strip: Filmstrip): string {
  return (strip as unknown as { dir?: string }).dir ?? "filmstrip";
}

function compactLine(text: string, limit: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : `${one.slice(0, Math.max(0, limit - 1))}…`;
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
  const env = process.env.CRIX_REASONING_LEVEL?.toLowerCase();
  if (isReasoningLevel(env)) return env;
  if (isReasoningLevel(settings.reasoningLevel)) return settings.reasoningLevel;
  return "medium";
}
function chatContextBudget(selection: ProviderSelection): number {
  const env = Number(process.env.CRIX_CONTEXT_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  if (selection.provider.name.startsWith("ollama-cloud")) return 24_000;
  return 64_000;
}
function chatMaxOutputTokens(): number {
  return Number(process.env.CRIX_MAX_OUTPUT_TOKENS) || 8192;
}

async function createSessionWithSelection(
  _args: ParsedArgs,
  selection: ProviderSelection,
  resumeSessionId?: string,
  requestPermission: (request: ToolPermissionRequest) => Promise<PermissionPromptDecision> = promptPermission,
): Promise<LiveSession> {
  const context = cliRuntimeContext();
  const pathPermissions = await CrixPathPermissionStore.load(context);
  const commandPermissions = await CrixCommandPermissionStore.load(context);
  const settings = await loadUiSettings();
  // Unleashed by default — this is the owner's own agent on the owner's machine
  // (the M0 posture: permissive default, owner holds the dial). Tool calls run
  // without a permission ritual; the genuinely-useful safety net stays on
  // (pre-write undo checkpoints, the kill switch, and the effects ledger for
  // irreversible OUTWARD actions). The owner can re-guard anytime with /code or
  // /plan, which persists `dangerousBypass: false`.
  const guarded = settings.dangerousBypass === false;
  const runtime: CrixRuntimeState = { permissionMode: guarded ? "workspace-write" : "bypass" };
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
    process.env.CRIX_AGENT_ENABLED === "1" ||
    (!isMockProvider && process.env.CRIX_AGENT_ENABLED !== "0");
  const agent = await prepareCrixAgent({
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
    live.agentRuntime = new CrixAgentRuntime(agent, {
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
    hookManager: hooks,
    selfTerritoryRoots: context.selfTerritoryRoots,
    reasoningLevel: resolveReasoningLevel(settings),
    maxOutputTokens: chatMaxOutputTokens(),
    contextBudgetTokens: chatContextBudget(selection),
  });
  const live: LiveSession = { session, selection, context, runtime, verifier, hooks, shellRegistry, todoStore, queueSystemReminder };
  live.agentRuntime = new CrixAgentRuntime(agent, {
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
    "/sessions              List saved .crix sessions for this workspace.",
    "/plan                  Enter read-only planning mode.",
    "/code                  Exit planning mode and allow workspace writes.",
    "/danger                Toggle bypass mode for tool prompts.",
    "/checkpoints           List local workspace checkpoints.",
    "/checkpoint-diff <id>  Compare current workspace to a checkpoint.",
    "/undo [N]              Restore the latest pre-write checkpoint.",
    "/rollback <id>         Restore a checkpoint snapshot.",
    "/resume [id|last]      Replay a saved session into model context.",
    "/workspace <path>      Switch the active workspace for tool calls.",
    "/exit                  Close Crix.",
  ];
}

function themeLines(): string[] {
  return availableThemes().map((name) => `${name}${name === currentThemeNameSafe() ? " (active)" : ""}`);
}

function currentThemeNameSafe(): string {
  try {
    return process.env.CRIX_THEME ?? "amber";
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
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS });
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
  const raw = process.env.CRIX_RESUME_MESSAGES;
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
  const inputPerM = Number(process.env.CRIX_COST_INPUT_PER_MTOK ?? 0);
  const outputPerM = Number(process.env.CRIX_COST_OUTPUT_PER_MTOK ?? 0);
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
    `crix: provider=${live.selection.provider.name} model=${live.selection.model} source=${live.selection.source} session=${live.session.meta.id}\n`,
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
  await live.agentRuntime?.afterTurn(finalStatus);
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
    live = await createSession(args, undefined, (request) => commands.waitForPermission(request));
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
      await live.agentRuntime?.afterTurn(finalStatus);
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
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.CRIX_HOME });
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
        agentName: args.flags.get("name") ?? "Crix",
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
      process.stderr.write("error: crix agent restore <snapshot-id>\n");
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
    const dest = args.flags.get("dest") ?? args.positionals[1] ?? path.join(context.workspace, `crix-agent-backup-${Date.now()}.json`);
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
      process.stderr.write("error: crix agent import <backup.json> [--overwrite]\n");
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
  process.stderr.write("error: usage: crix agent <bootstrap|doctor|dream|snapshot|snapshots|restore|backup|import>\n");
  return 2;
}

async function evalCommand(args: ParsedArgs): Promise<number> {
  const root = await mkdtemp(path.join(os.tmpdir(), "crix-eval-"));
  const tasks = builtInEvalTasks();
  let report: EvalReport;
  try {
    report = await runEvalSuite(tasks, { suite: "crix builtin", workspace: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  if (args.flags.has("json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.failed > 0 ? 1 : 0;
  }

  process.stdout.write(`crix eval: ${report.total} task(s)\n`);
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
      id: "startup-crix-md",
      name: "Startup context loads CRIX.md",
      category: "startup",
      async run({ workspace }) {
        await writeEvalFile(workspace, "CRIX.md", "Project rule: use tabs.\n");
        const reminders = await loadStartupReminders(workspace);
        assertEval(reminders.some((r) => r.source === "instructions" && r.text.includes("use tabs")), "CRIX.md not loaded");
        return { evidence: ["Startup reminders included CRIX.md instructions."] };
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
  process.stdout.write(`\nUse --theme <name> for one run, or crix theme <name> / /theme <name> to save it.\n`);
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
      'Start one with: crix operator add --goal "<what you want done>"',
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

// ─── Mission Learning Cards (Phase B v1) — crix mission learn/lessons/lesson ──

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
        process.stderr.write("error: usage: crix mission learn <contractId>\n");
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
        process.stdout.write(notice("Lessons", ["No learning cards yet. Distill one: crix mission learn <contractId>"], "warn"));
        return 0;
      }
      process.stdout.write(notice(`Lessons · ${cards.length}`, cards.map(lessonLine), "info"));
      return 0;
    }
    if (subcommand === "lesson") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("error: usage: crix mission lesson <id>\n");
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
    process.stderr.write("error: usage: crix mission <learn <contractId> | lessons | lesson <id>>\n");
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

  if (stdin.isTTY && stdout.isTTY && process.env.CRIX_LEGACY_TUI !== "1") {
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
        await live.agentRuntime?.afterTurn(finalStatus);
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
      await live.agentRuntime?.afterTurn(finalStatus);
      return;
    }
    void event;
  }
  await live.agentRuntime?.afterTurn(finalStatus);
}

async function loginCommand(): Promise<number> {
  process.stderr.write("crix: starting ChatGPT OAuth device-code flow…\n");
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
  process.stdout.write("crix doctor\n\n");

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
  const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS });
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
  process.stdout.write(`crix: ${auth.configured || health.reachable ? "ready" : "no providers configured"}\n`);
  return 0;
}

// ─── system prompt ─────────────────────────────────────────────────────

// ─── live Mind bridge (v6) — wires Living Memory + learned capabilities into
// the ACTUAL conversation, so Crix recalls, captures, and knows itself instead
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
        ? { config: prepared.config, home: prepared.home, useOllama: process.env.CRIX_AGENT_OLLAMA_RECALL === "1" }
        : undefined,
    });
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
    // Capture the user's message as an episodic memory — this is how Crix learns over time.
    if (intent.shouldCapture) {
      const store = await MemoryStore.open(live.context.mind.memoryFile);
      await store.add({ kind: "episodic", content: text.slice(0, 400), source: live.session.meta.id });
    }
  } catch {
    // never break a turn over memory
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

  return `You are Crix, an autonomous local assistant with a powerful coding harness running in the terminal.

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
- **WebSearch/WebFetch**: use for current docs, API changes, and user-provided URLs. WebFetch with a prompt summarizes through the SUMMARIZE slot when available.
- **Bash run_in_background + BashOutput + KillShell**: use for dev servers, watch tasks, and long-running builds.
- **McpListTools/McpCallTool**: use only when the user configured MCP servers in \`.crix/mcp.json\` or \`~/.crix/mcp.json\`.
- **SkillsList/SkillRead**: use when a reusable local workflow clearly applies.
- **CodeMode**: use for read-heavy batch repo analysis that would otherwise require many repetitive file/tool calls.

## Proof discipline

Builds passing means the code COMPILES. It does NOT mean the feature works. For runtime behavior — game mods, plugins, GUIs, APIs, anything user-facing — verify by running it or by inspecting concrete proof (registration calls present, assets in jar, endpoint reachable, expected output in logs). Do not say "it works" when you only proved it builds.

For Minecraft/Fabric, Bukkit/Paper, browser/GUI, web servers, CLIs: list the specific things you checked (item registered, handler bound, event fired, jar contains assets) or clearly say "compiled but runtime unverified — please test in-game".

## Code references

When you reference code, use the pattern \`file_path:line_number\` so the user can navigate. Example: "The auth helper is in src/middleware/auth.ts:42." Do this in summary text AND in error messages.

## Hooks

The user may configure shell hooks (PreToolUse, PostToolUse, SessionStart) in \`.crix/hooks.json\` or \`~/.crix/hooks.json\`. If a hook blocks a tool, you'll see a \`<system-reminder>\` explaining why; adjust and try again.

## Plan mode

If you're in plan mode (current mode: \`${permissionMode}\`; the prompt shows \`[PLAN]\`), all write tools are blocked. Use this turn to inspect, plan, and present the proposed changes. Call **ExitPlanMode** with a markdown plan when ready — the user can then accept or refine.

## Hard rules

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

// ─── operator command (Crix v5 / O1 — the durable autonomy spine) ──────
async function operatorCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.CRIX_HOME });
  const home = context.home;
  await seedNativeCapabilities(home).catch(() => undefined);

  if (subcommand === "add" || subcommand === "goal") {
    const statement = args.flags.get("goal") ?? args.positionals.slice(1).join(" ").trim();
    if (!statement) {
      process.stderr.write('error: usage: crix operator add --goal "<goal>"\n');
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
      process.stderr.write('error: usage: crix operator acquire --capability "<name>" [--kind skill|connector|tool|mcp|script]\n');
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
      process.stderr.write('error: usage: crix operator draft --capability "<name>" [--requires a,b]\n');
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
      process.stderr.write('error: usage: crix operator promote --capability "<id>" --eval-report report.json [--evidence "..."]\n');
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
      process.stderr.write('error: usage: crix operator reject --capability "<id>" --reason "<why>" [--forbidden]\n');
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
      process.stderr.write('error: usage: crix operator mission status <id> [--json]\n');
      return 2;
    }
    const id = args.positionals[2] ?? args.flags.get("id") ?? args.flags.get("mission");
    if (!id) {
      process.stderr.write('error: usage: crix operator mission status <id> [--json]\n');
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
      process.stdout.write(notice("Operator", ['No goals yet. Add one: crix operator add --goal "..."'], "warn"));
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
      process.stdout.write(notice("Capabilities", ["No capabilities learned yet. They accrue as Crix masters things."], "warn"));
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

// ─── mind command (Crix v6 — Living Memory feed for the UI + you) ───────
async function mindCommand(args: ParsedArgs): Promise<number> {
  const subcommand = args.positionals[0] ?? "list";
  const context = cliRuntimeContext({ home: args.flags.get("home") ?? process.env.CRIX_HOME });
  const home = context.home;
  const store = await MemoryStore.open(args.flags.get("root") ?? context.mind.memoryFile);
  const json = args.flags.has("json");

  if (subcommand === "add") {
    const content = args.flags.get("content") ?? args.positionals.slice(1).join(" ").trim();
    if (!content) {
      process.stderr.write('error: usage: crix mind add --content "<text>" [--kind episodic|semantic|procedural]\n');
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
      process.stderr.write('error: usage: crix mind recall "<cue>"\n');
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
        process.stderr.write(`error: usage: crix theme <${availableThemes().join("|")}>\n`);
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
      process.stderr.write(`error: unknown command "${args.command}". Run \`crix help\`.\n`);
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
