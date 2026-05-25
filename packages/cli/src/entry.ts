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
  type RichToolContext,
  type FileReadStamp,
  type PathAccess,
  type PathGrantScope,
  type PathPermissionStore,
} from "@crix/tools";
import type { PermissionPromptDecision } from "@crix/protocol";
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
} from "./terminalUi.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  let command = "chat";
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
      "  crix chat [--provider openai|ollama|mock] [--model X]",
      "                              Open an interactive terminal prompt.",
      "  crix sessions               List saved workspace sessions.",
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
      "  CRIX_THEME                  UI theme: cyberpunk, minimal, matrix, neon, split, professional, amber, dashboard.",
      "",
      "Flags:",
      "  --theme NAME                Use a UI theme for this run.",
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
  resumed?: ResumedSessionInfo;
}

async function selectProvider(flags: Map<string, string>): Promise<ProviderSelection> {
  const explicit = flags.get("provider");
  const requestedModel = flags.get("model");
  const auth = await loadAuthToken();

  if (explicit === "mock") {
    return {
      provider: new MockEchoProvider(),
      model: requestedModel ?? "mock-echo",
      source: "explicit:mock",
    };
  }

  if (explicit === "openai" || (!explicit && auth)) {
    const provider = new OpenAIResponsesProvider();
    return {
      provider,
      model: requestedModel ?? process.env.CRIX_OPENAI_MODEL ?? "gpt-5.5",
      source: explicit ? "explicit:openai" : "auto:openai",
    };
  }

  if (explicit === "ollama" || !explicit) {
    const pool = new OllamaCloudPool({ slots: DEFAULT_OLLAMA_SLOTS });
    return {
      provider: pool.provider("reasoner"),
      model: requestedModel ?? DEFAULT_OLLAMA_SLOTS.reasoner.model,
      source: explicit ? "explicit:ollama" : "auto:ollama",
    };
  }

  throw new Error(`unknown provider: ${explicit}`);
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

async function buildEngineTools(pathPermissions: PathPermissionStore): Promise<EngineTool[]> {
  // Shared per-session state populated by the tool harness.
  const fileReadStamps = new Map<string, FileReadStamp>();
  return DEFAULT_TOOLS.map((tool) => {
    const adapted = adaptToolForEngine(tool, (base: ToolCallContext): RichToolContext => ({
      ...base,
      permissionMode: "workspace-write",
      fileReadStamps,
      pathPermissions,
    }));
    return adapted as EngineTool;
  });
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
  if (resumeSessionId) {
    const snapshot = await loadSessionSnapshot(process.cwd(), resumeSessionId, {
      maxMessages: resumeMessageLimit(),
    });
    const session = new Session({
      workspace: process.cwd(),
      provider: selection.provider,
      model: selection.model,
      systemPrompt: buildSystemPrompt(),
      tools: await buildEngineTools(pathPermissions),
      requestPermission: promptPermission,
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
    };
  }
  const session = new Session({
    workspace: process.cwd(),
    provider: selection.provider,
    model: selection.model,
    systemPrompt: buildSystemPrompt(),
    tools: await buildEngineTools(pathPermissions),
    requestPermission: promptPermission,
  });
  return { session, selection };
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

function resumeMessageLimit(): number | undefined {
  const raw = process.env.CRIX_RESUME_MESSAGES;
  if (!raw) return 80;
  if (raw === "0" || raw.toLowerCase() === "all") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(8, Math.floor(parsed));
}

async function loadSavedTheme(): Promise<void> {
  try {
    const settings = JSON.parse(await readFile(uiSettingsPath(), "utf8")) as { theme?: string };
    if (settings.theme) setTheme(settings.theme);
  } catch {
    // First run or old config.
  }
}

async function saveTheme(name: string): Promise<void> {
  const filePath = uiSettingsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ theme: name }, null, 2) + "\n", "utf8");
}

function uiSettingsPath(): string {
  return path.join(crixHome(), "ui.json");
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
    process.stdout.write(JSON.stringify(event) + "\n");
  }
  return 0;
}

async function sessionsCommand(): Promise<number> {
  await printSessions();
  return 0;
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

async function chatCommand(args: ParsedArgs, resumeSessionId?: string): Promise<number> {
  let live: LiveSession;
  try {
    const resumeTarget = resumeSessionId ?? (await resolveResumeSessionId(args.flags.get("resume")));
    live = await createSession(args, resumeTarget);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  process.stdout.write("\n" + chatHeader({
    provider: live.selection.provider.name,
    model: live.selection.model,
    workspace: process.cwd(),
  }));
  if (live.resumed) printResumed(live.resumed);

  while (true) {
    const line = (await askLine(promptLabel(live.selection.model, process.cwd()))).trim();
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

    await renderTurn(live.session, line);
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

async function renderTurn(session: Session, goal: string): Promise<void> {
  let wroteText = false;
  let wroteThinking = false;
  for await (const event of session.send(goal)) {
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
      process.stderr.write(toolEnd(event));
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

function buildSystemPrompt(): string {
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
4. Edit with **Edit** for single replacements (unique match required), **ApplyIntent** for large multi-line changes (cheaper), **MultiEdit** for batched single-file edits, **Write** to create new files
5. Verify with **Bash**/**PowerShell** — the continuous verifier also runs typecheck/lint on touched files automatically
6. If the verifier injects a \`<system-reminder>\` about failures, address them before claiming done

## Proof discipline

Builds passing means the code COMPILES. It does NOT mean the feature works. For runtime behavior — game mods, plugins, GUIs, APIs, anything user-facing — verify by running it or by inspecting concrete proof (registration calls present, assets in jar, endpoint reachable, expected output in logs). Do not say "it works" when you only proved it builds.

For Minecraft/Fabric, Bukkit/Paper, browser/GUI, web servers, CLIs: list the specific things you checked (item registered, handler bound, event fired, jar contains assets) or clearly say "compiled but runtime unverified — please test in-game".

## Code references

When you reference code, use the pattern \`file_path:line_number\` so the user can navigate. Example: "The auth helper is in src/middleware/auth.ts:42." Do this in summary text AND in error messages.

## Hooks

The user may configure shell hooks (PreToolUse, PostToolUse, SessionStart) in \`.crix/hooks.json\` or \`~/.crix/hooks.json\`. If a hook blocks a tool, you'll see a \`<system-reminder>\` explaining why; adjust and try again.

## Plan mode

If you're in plan mode (the prompt shows \`[PLAN]\`), all write tools are blocked. Use this turn to inspect, plan, and present the proposed changes. Call **ExitPlanMode** with a markdown plan when ready — the user can then accept or refine.

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
  switch (args.command) {
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

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
