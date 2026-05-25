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
  listWorkspaceCheckpoints,
  diffWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
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
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import {
  DEFAULT_TOOLS,
  adaptToolForEngine,
  makeTodoWriteTool,
  makeTaskTool,
  makeWebFetchTool,
  makeWebSearchTool,
  makeBashOutputTool,
  makeKillShellTool,
  makeEnterPlanModeTool,
  makeExitPlanModeTool,
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
import type { PermissionMode, PermissionPromptDecision, PermissionRule, PermissionRuleEffect } from "@crix/protocol";
import type { ToolPermissionRequest } from "@crix/core";
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
import { loadUiSettings, updateUiSettings } from "./uiSettings.js";

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
  runtime: CrixRuntimeState;
  verifier: ContinuousVerifier;
  hooks: HookManager;
  shellRegistry: ShellRegistry;
  todoStore: TodoStore;
  resumed?: ResumedSessionInfo;
}

interface CrixRuntimeState {
  permissionMode: PermissionMode;
}

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
    private readonly persisted: StoredPathPermissions,
  ) {}

  static async load(): Promise<CrixPathPermissionStore> {
    const filePath = path.join(crixHome(), "path-permissions.json");
    let persisted: StoredPathPermissions = { alwaysAllow: [] };
    try {
      persisted = JSON.parse(await readFile(filePath, "utf8")) as StoredPathPermissions;
      persisted.alwaysAllow ??= [];
    } catch {
      // First run.
    }
    return new CrixPathPermissionStore(filePath, persisted);
  }

  isAllowed(absPath: string, access: PathAccess): boolean {
    const candidate = path.resolve(absPath);
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

  static async load(workspace: string): Promise<CrixCommandPermissionStore> {
    const files = [
      path.join(crixHome(), "command-permissions.json"),
      path.join(workspace, ".crix", "command-permissions.json"),
    ];
    const rules: PermissionRule[] = [];
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, "utf8")) as StoredCommandPermissions;
        for (const rule of json.rules ?? []) {
          rules.push({
            pattern: rule.pattern,
            effect: rule.effect,
            source: file.startsWith(path.join(workspace, ".crix")) ? "project" : "user-global",
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
    baseSystemPrompt: buildSystemPrompt(runtime.permissionMode),
  });
  const taskTool = adaptToolForEngine(makeTaskTool(runner), enrich) as EngineTool;
  return [...baseTools, taskTool];
}

async function createSession(
  args: ParsedArgs,
  resumeSessionId?: string,
): Promise<LiveSession> {
  const selection = await selectProvider(args.flags);
  return createSessionWithSelection(args, selection, resumeSessionId);
}

async function createSessionWithSelection(
  _args: ParsedArgs,
  selection: ProviderSelection,
  resumeSessionId?: string,
): Promise<LiveSession> {
  const pathPermissions = await CrixPathPermissionStore.load();
  const commandPermissions = await CrixCommandPermissionStore.load(process.cwd());
  const settings = await loadUiSettings();
  const runtime: CrixRuntimeState = { permissionMode: settings.dangerousBypass ? "bypass" : "workspace-write" };
  const shellRegistry = new ShellRegistry();
  const todoStore = new TodoStore();
  const verifier = new ContinuousVerifier({
    workspace: process.cwd(),
    onEvent: (event) => {
      void event;
    },
  });
  const hooks = await HookManager.load(process.cwd());
  await hooks.run({ event: "SessionStart", workspace: process.cwd() });
  const drainSystemReminders = () => [
    ...verifier.drainReminders(),
    ...hooks.drainReminders(),
  ];
  const tools = await buildEngineTools(
    pathPermissions,
    commandPermissions,
    selection,
    runtime,
    shellRegistry,
    todoStore,
  );
  if (resumeSessionId) {
    const snapshot = await loadSessionSnapshot(process.cwd(), resumeSessionId, {
      maxMessages: resumeMessageLimit(),
    });
    const session = new Session({
      workspace: process.cwd(),
      provider: selection.provider,
      model: selection.model,
      systemPrompt: buildSystemPrompt(runtime.permissionMode),
      tools,
      requestPermission: promptPermission,
      drainSystemReminders,
      hookManager: hooks,
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialSeq: snapshot.nextSeq,
    });
    return {
      session,
      selection,
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
    };
  }
  const session = new Session({
    workspace: process.cwd(),
    provider: selection.provider,
    model: selection.model,
    systemPrompt: buildSystemPrompt(runtime.permissionMode),
    tools,
    requestPermission: promptPermission,
    drainSystemReminders,
    hookManager: hooks,
  });
  return { session, selection, runtime, verifier, hooks, shellRegistry, todoStore };
}

async function resolveResumeSessionId(target?: string): Promise<string | undefined> {
  if (!target || target === "false") return undefined;
  if (target === "true" || target === "last" || target === "latest") {
    const [latest] = await listSessions(process.cwd(), 1);
    return latest?.id;
  }
  return target;
}

async function requireResumeSessionId(target?: string): Promise<string> {
  const sessionId = await resolveResumeSessionId(target ?? "last");
  if (!sessionId) throw new Error("no saved sessions in this workspace");
  return sessionId;
}

function sessionSummaryLine(session: SessionSummary): string {
  const provider = `${session.provider.name}:${session.provider.model}`;
  const preview = session.preview || "(no user text)";
  const updated = new Date(session.updatedAt).toLocaleString();
  return `${session.id}  ${provider}  ${session.eventCount} events  ${updated}  ${preview}`;
}

async function printSessions(limit = 20): Promise<SessionSummary[]> {
  const sessions = await listSessions(process.cwd(), limit);
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

async function sessionsLines(limit = 20): Promise<string[]> {
  const sessions = await listSessions(process.cwd(), limit);
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

async function checkpointLines(): Promise<string[]> {
  const checkpoints = await listWorkspaceCheckpoints(process.cwd());
  if (checkpoints.length === 0) return ["No checkpoints in this workspace yet."];
  return checkpoints
    .slice(0, 20)
    .map((cp) => `${cp.id}  ${cp.createdAt}  ${cp.fileManifest.length} files${cp.label ? `  ${cp.label}` : ""}`);
}

async function checkpointDiffLines(id: string): Promise<string[]> {
  if (!id) return ["Usage: /checkpoint-diff <id>"];
  try {
    const diff = await diffWorkspaceCheckpoint(process.cwd(), id);
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

async function rollbackLines(id: string): Promise<string[]> {
  if (!id) return ["Usage: /rollback <checkpoint-id>"];
  try {
    const result = await restoreWorkspaceCheckpoint(process.cwd(), id);
    return [`restored ${result.restored} file(s)`, `deleted ${result.deleted} file(s)`];
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

  for await (const event of live.session.send(goal)) {
    if (event.type === "tool_end" && event.touchedFiles?.length) {
      live.verifier.scheduleFor(event.touchedFiles);
    }
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  return 0;
}

async function sessionsCommand(): Promise<number> {
  await printSessions();
  return 0;
}

async function checkpointsCommand(): Promise<number> {
  const checkpoints = await listWorkspaceCheckpoints(process.cwd());
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
    const diff = await diffWorkspaceCheckpoint(process.cwd(), id);
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
    const result = await restoreWorkspaceCheckpoint(process.cwd(), id);
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
    const sessionId = await requireResumeSessionId(target);
    return chatCommand(args, sessionId);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

async function launcherCommand(args: ParsedArgs): Promise<number> {
  const settings = await loadUiSettings();
  const action = await runInkLauncher({
    workspace: process.cwd(),
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
      workspace: process.cwd(),
      mode: live.runtime.permissionMode,
    });
    return await runInkChat({
      snapshot,
      resumedLines: live.resumed ? resumedLines(live.resumed) : undefined,
      sendMessage: async (goal, onEvent) => {
        for await (const event of live.session.send(goal)) {
          if (event.type === "tool_end" && event.touchedFiles?.length) {
            live.verifier.scheduleFor(event.touchedFiles);
          }
          onEvent(event);
        }
      },
      handleCommand: async (line): Promise<InkCommandResult> => {
        if (line === "/exit" || line === "/quit") return { kind: "exit" };
        if (line === "/help") return { kind: "handled", lines: inkHelpLines(), snapshot: snapshot() };
        if (line === "/doctor") return { kind: "handled", lines: await doctorSummaryLines(), snapshot: snapshot() };
        if (line === "/themes") return { kind: "handled", lines: themeLines(), snapshot: snapshot() };
        if (line === "/sessions") return { kind: "handled", lines: await sessionsLines(), snapshot: snapshot() };
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
        if (line === "/checkpoints") return { kind: "handled", lines: await checkpointLines(), snapshot: snapshot() };
        if (line.startsWith("/checkpoint-diff ")) {
          return { kind: "handled", lines: await checkpointDiffLines(line.slice("/checkpoint-diff ".length).trim()), snapshot: snapshot() };
        }
        if (line.startsWith("/rollback ")) {
          return { kind: "handled", lines: await rollbackLines(line.slice("/rollback ".length).trim()), snapshot: snapshot() };
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
          const sessionId = await requireResumeSessionId(target);
          live = await createSessionWithSelection(args, live.selection, sessionId);
          return { kind: "handled", lines: live.resumed ? resumedLines(live.resumed) : [`Resumed ${sessionId}`], snapshot: snapshot() };
        }
        if (line.startsWith("/workspace ")) {
          const target = line.slice("/workspace ".length).trim();
          const next = path.resolve(process.cwd(), target);
          const info = await stat(next).catch(() => null);
          if (!info?.isDirectory()) return { kind: "handled", lines: [`Not a directory: ${next}`], snapshot: snapshot() };
          process.chdir(next);
          live = await createSessionWithSelection(args, live.selection);
          return { kind: "handled", lines: [`Active workspace is now ${process.cwd()}`], snapshot: snapshot() };
        }
        return { kind: "not-handled" };
      },
    });
  }

  process.stdout.write("\n" + chatHeader({
    provider: live.selection.provider.name,
    model: live.selection.model,
    workspace: process.cwd(),
  }));
  if (live.resumed) printResumed(live.resumed);

  while (true) {
    const line = (await askLine(promptLabel(live.selection.model, process.cwd(), live.runtime.permissionMode))).trim();
    if (!line) continue;
    if (line === "/exit" || line === "exit" || line === "/quit" || line === "quit") {
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
        workspace: process.cwd(),
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
    if (line.startsWith("/rollback ")) {
      await rollbackCommand(line.slice("/rollback ".length).trim());
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
      const target = line.split(/\s+/, 2)[1] ?? "last";
      try {
        const sessionId = await requireResumeSessionId(target);
        live = await createSessionWithSelection(args, live.selection, sessionId);
        if (live.resumed) printResumed(live.resumed);
      } catch (err) {
        process.stderr.write(notice("Resume", [err instanceof Error ? err.message : String(err)], "error"));
      }
      continue;
    }
    if (line.startsWith("/workspace ")) {
      const target = line.slice("/workspace ".length).trim();
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
  const next = path.resolve(process.cwd(), target);
  const info = await stat(next).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(notice("Workspace", [`Not a directory: ${next}`], "error"));
    return createSessionWithSelection(args, selection);
  }
  process.chdir(next);
  const live = await createSessionWithSelection(args, selection);
  process.stdout.write(notice("Workspace", [`Active workspace is now ${process.cwd()}`], "success"));
  return live;
}

async function renderTurn(live: LiveSession, goal: string): Promise<void> {
  let wroteText = false;
  let wroteThinking = false;
  for await (const event of live.session.send(goal)) {
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
      if (wroteThinking) process.stderr.write("\n");
      if (wroteText) process.stdout.write("\n");
      if (event.status !== "completed") {
        process.stderr.write(notice("Turn", [`status ${event.status}`], "warn"));
      }
      return;
    }
    void event;
  }
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

function buildSystemPrompt(permissionMode: PermissionMode = "workspace-write"): string {
  const platform = process.platform === "win32" ? "Windows (PowerShell first)" : process.platform;
  const cwd = process.cwd();
  const today = new Date().toISOString().slice(0, 10);

  return `You are Crix, a streaming coding-agent harness running in the terminal.

You pair with a developer to do real software engineering. Be useful, concise, and honest. Take action with tools instead of describing what you would do.

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

## Proactiveness

Take initiative when the user asks for something, including follow-ups that obviously belong. Do not surprise the user with actions they didn't request. When unclear between a few reasonable approaches, take the safest and mention you can change course.

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

## Tool usage policy — prefer Task for searches

Use the **Task** tool with a \`subagent_type\` when:
- You need to find something across many files and aren't sure where to look
- The investigation will require 5+ tool calls
- You want a focused summary instead of raw search dumps in your context

Subagent types available:
- \`general-purpose\` — full tool access, for research that may write code
- \`researcher\` — read-only, returns a structured findings report
- \`code-reviewer\` — diff-aware review of pending changes

Using Task reduces your context bloat. Prefer it over chains of Read/Glob/Grep when you'd otherwise pull >5 files into your context.

When you need multiple INDEPENDENT pieces of information, batch tool calls IN PARALLEL — emit several tool_use blocks in one assistant turn. Example: \`git status\` + \`git diff\` + \`git log\` go in one message, not three sequential messages.

## Doing tasks

For software engineering work the typical flow is:
1. Use **TodoWrite** to plan if 3+ steps
2. Use **CodebaseSearch** for "where is X handled" questions (semantic), **Grep** for exact strings, **Glob** for filename patterns
3. **Read** files before editing them — the Edit tool will refuse otherwise
4. Edit with **Edit** for single replacements (unique match required), **ApplyIntent** for large multi-line changes (cheaper), **FindAndEdit** for mechanical multi-file regex refactors, **Write** to create new files
5. Verify with **Bash**/**PowerShell** — the continuous verifier also runs typecheck/lint on touched files automatically
6. If the verifier injects a \`<system-reminder>\` about failures, address them before claiming done

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
  const target = path.resolve(process.cwd(), requested);
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
