#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { AgentOrchestrator, AgentRuntime, completeOpenAIChat, CRIX_SKILL_PROCESSES, CRIX_TOOL_CATALOG, CrixKernel, EventStore, OLLAMA_CLOUD_MODELS, PluginMarketplace, ToolRuntime, TurnEngine, TurnRecorder, crixHome, defaultAgents, defaultTools, extractLocalPath, hasUsableOllamaCloudAuth, hasUsableOpenAIAuth, JavaBridge, MemoryStore, OllamaCloudAuthStore, OllamaCloudClient, OllamaCloudProvider, OpenAIAuthStore, OpenAIOAuthProvider, OpenAIResponsesClient, ReversibleEditor, ShellExecutor, buildSystemPrompt, parseProviderJsonResponse, planTurnIntent, resolveOllamaModel, runProviderToolLoop, toolCatalogSummary } from "@crix/core";
import type { ModelProvider, RunGoalEvent, ToolPermissionPrompt, ToolPermissionRequest } from "@crix/core";
import type { AgentSessionState, AgentTurnEvent, JsonRecord, PermissionMode, PermissionPromptDecision, ToolResult, UpgradePlan, VerificationCommand } from "@crix/protocol";
import { FullscreenTurnRenderer, shouldUseFullscreen } from "./fullscreenRenderer.js";
import { TuiRenderer } from "./tuiRenderer.js";

interface ParsedArgs {
  command: string;
  flags: Map<string, string[]>;
  rest: string[];
}

type InteractiveInput = { kind: "command"; args: ParsedArgs } | { kind: "chat"; text: string };
type ChatProviderChoice = "auto" | "openai" | "ollama";
type ToolCardKind = "tool" | "agent";
type RepoScanMode = "scout" | "deep";

interface ToolCardSpec {
  kind?: ToolCardKind;
  name: string;
  input: JsonRecord;
}

interface InteractiveSession {
  provider: ChatProviderChoice;
  model?: string;
  prompt: string;
  workspace: string;
  activeTurn?: ActiveInteractiveTurn;
  agentRuntime?: ActiveAgentRuntime;
}

interface ActiveInteractiveTurn {
  label: string;
  queue(content: string): void;
}

interface ActiveAgentRuntime {
  provider: "openai" | "ollama" | "local";
  model?: string;
  runtime: AgentRuntime;
}

interface CliProfile {
  provider?: ChatProviderChoice;
  model?: string;
}

const OPENAI_CHAT_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1",
  "gpt-5-codex",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
];

const OLLAMA_LOCAL_MODELS = [
  "qwen3-coder",
  "qwen3",
  "devstral",
  "deepseek-coder-v2",
  "llama3.3",
  "gpt-oss:120b",
  "gpt-oss:20b",
];

const OLLAMA_CLOUD_PICKER_MODELS = Object.values(OLLAMA_CLOUD_MODELS);
const OLLAMA_PICKER_MODELS = process.env.CRIX_SHOW_OLLAMA_CLOUD_MODELS === "1"
  ? [...OLLAMA_LOCAL_MODELS, ...OLLAMA_CLOUD_PICKER_MODELS]
  : OLLAMA_LOCAL_MODELS;
const tui = new TuiRenderer(output);

const INTERACTIVE_COMMANDS = new Set([
  "help",
  "h",
  "run",
  "upgrade",
  "login",
  "logout",
  "status",
  "sessions",
  "turns",
  "provider",
  "model",
  "agents",
  "agent",
  "test",
  "dry",
  "apply",
  "plan",
  "verify",
  "memory",
  "auth",
  "ollama",
  "ask",
  "prompt",
  "tools",
  "tool",
  "skills",
  "plugins",
  "inspect",
  "rollback",
  "java",
  "doctor",
  "cli",
  "shell",
  "exit",
  "quit",
  "q",
]);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "cli":
    case "shell":
      await interactiveCli(args);
      return;
    case "help":
    case "":
      printHelp();
      return;
    case "run":
      await runGoal(args, false);
      return;
    case "upgrade":
      await upgrade(args);
      return;
    case "login":
      await auth({ ...args, command: "auth", rest: ["login", ...args.rest] });
      return;
    case "logout":
      await auth({ ...args, command: "auth", rest: ["logout", ...args.rest] });
      return;
    case "status":
      await doctor(args);
      return;
    case "sessions":
      await sessions(args);
      return;
    case "turns":
      await turns(args);
      return;
    case "test":
      await verify({ ...args, command: "verify", rest: ["pnpm", "test"] });
      return;
    case "dry":
      await runGoal(args, true, "examples/self-upgrade-plan.json");
      return;
    case "apply":
      await runGoal(args, false, "examples/self-upgrade-plan.json");
      return;
    case "plan":
      await writePlan(args);
      return;
    case "verify":
      await verify(args);
      return;
    case "memory":
      await memory(args);
      return;
    case "auth":
      await auth(args);
      return;
    case "ollama":
      await ollama(args);
      return;
    case "ask":
      await ask(args);
      return;
    case "prompt":
      await prompt(args);
      return;
    case "tools":
      await tools(args);
      return;
    case "tool":
      await tool(args);
      return;
    case "skills":
      await skills(args);
      return;
    case "plugins":
      await plugins(args);
      return;
    case "inspect":
      await inspect(args);
      return;
    case "rollback":
      await rollback(args);
      return;
    case "java":
      await javaProbe(args);
      return;
    case "doctor":
      await doctor(args);
      return;
    default:
      throw new Error(`unknown command ${args.command}. Run crix help.`);
  }
}

async function interactiveCli(args: ParsedArgs): Promise<void> {
  const session = await configureInteractiveSession(args);
  printInteractiveHeader(session);
  const rl = createInterface({ input, output, prompt: sessionPrompt(session) });
  const queuedLines: string[] = [];
  let active: Promise<void> | undefined;
  let closing = false;

  const startQueuedLine = (line: string): void => {
    rl.setPrompt(sessionPrompt(session));
    output.write(sessionPrompt(session));
    startLine(line);
  };

  const startLine = (line: string): void => {
    active = (async () => {
      const shouldExit = await handleInteractiveLine(line, session);
      if (shouldExit || closing) {
        closing = true;
        rl.close();
        return;
      }
      const next = queuedLines.shift();
      if (next) {
        startQueuedLine(next);
        return;
      }
      active = undefined;
      rl.setPrompt(sessionPrompt(session));
      rl.prompt();
    })().catch((error) => {
      console.error(formatCliError(error));
      const next = queuedLines.shift();
      if (next && !closing) {
        startQueuedLine(next);
        return;
      }
      active = undefined;
      if (!closing) {
        rl.setPrompt(sessionPrompt(session));
        rl.prompt();
      }
    });
  };

  try {
    rl.prompt();
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        if (!active) rl.prompt();
        continue;
      }
      if (active) {
        if (["exit", "quit", "q"].includes(line.toLowerCase())) {
          queuedLines.push(line);
          console.log("exit queued after active turn");
        } else if (isQueuedIntervention(line) && queueActiveIntervention(session, line)) {
          console.log(`intervention queued for ${session.activeTurn?.label}: ${shorten(line, 90)}`);
        } else {
          queuedLines.push(line);
          const queueLabel = session.activeTurn ? "active turn" : "active command";
          console.log(`queued after ${queueLabel}: ${shorten(line, 90)}`);
        }
        continue;
      }
      startLine(line);
    }
  } finally {
    if (active) await active.catch(() => undefined);
    rl.close();
  }
}

async function handleInteractiveLine(line: string, session: InteractiveSession): Promise<boolean> {
  if (!line) return false;
  if (["exit", "quit", "q"].includes(line.toLowerCase())) return true;
  try {
    const parsed = parseInteractiveInput(line);
    if (parsed.kind === "chat") {
      await chat(parsed.text, session);
      return false;
    }
    if (["exit", "quit", "q"].includes(parsed.args.command)) return true;
    if (await handleLiveInteractiveCommand(parsed.args, session)) return false;
    await runParsedCommand(parsed.args);
  } catch (error) {
    console.error(formatCliError(error));
  }
  return false;
}

async function handleLiveInteractiveCommand(args: ParsedArgs, session: InteractiveSession): Promise<boolean> {
  switch (args.command) {
    case "provider":
      await liveProvider(args, session);
      return true;
    case "model":
      await liveModel(args, session);
      return true;
    case "agents":
      if (args.rest[0]?.toLowerCase() === "run") {
        await liveAgentRun(args.rest[1], args.rest.slice(2).join(" "), session);
      } else if (args.rest[0]?.toLowerCase() === "notifications") {
        await liveAgentNotifications(session.workspace);
      } else {
        liveAgents();
      }
      return true;
    case "agent":
      await liveAgentRun(args.rest[0], args.rest.slice(1).join(" "), session);
      return true;
    case "tools":
      if (["demo", "flex", "run"].includes(args.rest[0]?.toLowerCase() ?? "")) {
        await liveToolAudit(session, "flex");
        return true;
      }
      return false;
    case "inspect": {
      const target = args.rest.join(" ").trim() || session.workspace;
      await liveRepoScanTask(target, session.workspace, "scout", session);
      return true;
    }
    case "status":
      await liveStatus(session);
      return true;
    default:
      return false;
  }
}

async function runParsedCommand(args: ParsedArgs): Promise<void> {
  switch (args.command) {
    case "cli":
    case "shell":
      console.log("already in interactive CLI");
      return;
    case "h":
    case "help":
    case "":
      printHelp();
      return;
    case "run":
      await runGoal(args, false);
      return;
    case "upgrade":
      await upgrade(args);
      return;
    case "login":
      await auth({ ...args, command: "auth", rest: ["login", ...args.rest] });
      return;
    case "logout":
      await auth({ ...args, command: "auth", rest: ["logout", ...args.rest] });
      return;
    case "status":
      await doctor(args);
      return;
    case "sessions":
      await sessions(args);
      return;
    case "turns":
      await turns(args);
      return;
    case "test":
      await verify({ ...args, command: "verify", rest: ["pnpm", "test"] });
      return;
    case "dry":
      await runGoal(args, true, "examples/self-upgrade-plan.json");
      return;
    case "apply":
      await runGoal(args, false, "examples/self-upgrade-plan.json");
      return;
    case "plan":
      await writePlan(args);
      return;
    case "verify":
      await verify(args);
      return;
    case "memory":
      await memory(args);
      return;
    case "auth":
      await auth(args);
      return;
    case "ollama":
      await ollama(args);
      return;
    case "ask":
      await ask(args);
      return;
    case "prompt":
      await prompt(args);
      return;
    case "tools":
      await tools(args);
      return;
    case "tool":
      await tool(args);
      return;
    case "skills":
      await skills(args);
      return;
    case "inspect":
      await inspect(args);
      return;
    case "rollback":
      await rollback(args);
      return;
    case "java":
      await javaProbe(args);
      return;
    case "doctor":
      await doctor(args);
      return;
    default:
      throw new Error(`unknown command ${args.command}. Type help.`);
  }
}

function parseInteractiveInput(line: string): InteractiveInput {
  const parts = splitCommandLine(line);
  const crixPrefixed = (parts[0]?.toLowerCase() ?? "") === "crix";
  if (crixPrefixed) parts.shift();
  const slashCommand = Boolean(parts[0]?.startsWith("/"));
  if (slashCommand) parts[0] = parts[0]!.slice(1);
  const command = parts[0]?.toLowerCase() ?? "help";
  if (!crixPrefixed && !slashCommand && command === "inspect" && parts.length > 1) {
    return { kind: "chat", text: line };
  }
  if (INTERACTIVE_COMMANDS.has(command)) {
    return { kind: "command", args: parseArgs(parts) };
  }
  return { kind: "chat", text: line };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand = "help", ...tail] = argv;
  const command = rawCommand.toLowerCase();
  const flags = new Map<string, string[]>();
  const rest: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const item = tail[index]!;
    if (item.startsWith("--")) {
      const key = item.slice(2);
      const next = tail[index + 1];
      if (next && !next.startsWith("--")) {
        index += 1;
        flags.set(key, [...(flags.get(key) ?? []), next]);
      } else {
        flags.set(key, [...(flags.get(key) ?? []), "true"]);
      }
    } else {
      rest.push(item);
    }
  }
  return { command, flags, rest };
}

function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

async function configureInteractiveSession(args: ParsedArgs): Promise<InteractiveSession> {
  const profile = await loadCliProfile();
  const defaultProvider = normalizeProviderChoice(flag(args, "provider")) ?? profile.provider ?? "auto";
  const defaultModel = flag(args, "model") ?? profile.model;
  const interactivePicker = input.isTTY && output.isTTY && !has(args, "no-picker");
  const provider = interactivePicker ? await chooseProvider(defaultProvider) : defaultProvider;
  const model = interactivePicker ? await chooseModel(provider, defaultModel) : defaultModel;
  const session: InteractiveSession = {
    provider,
    model,
    workspace: process.cwd(),
    prompt: buildSystemPrompt({ tools: defaultTools(), agents: defaultAgents(), mode: "chat" }),
  };
  await saveCliProfile({ provider, model });
  return session;
}

async function chooseProvider(defaultProvider: ChatProviderChoice): Promise<ChatProviderChoice> {
  const rl = createInterface({ input, output });
  try {
    console.log("Select provider:");
    console.log("  1) Auto (prefer configured provider)");
    console.log("  2) OpenAI");
    console.log("  3) Ollama (local)");
    const answer = (await rl.question(`Provider [${providerChoiceLabel(defaultProvider)}]: `)).trim().toLowerCase();
    if (!answer) return defaultProvider;
    if (["1", "auto", "a"].includes(answer)) return "auto";
    if (["2", "openai", "o"].includes(answer)) return "openai";
    if (["3", "ollama", "ollama-local", "local"].includes(answer)) return "ollama";
    return defaultProvider;
  } finally {
    rl.close();
  }
}

async function chooseModel(provider: ChatProviderChoice, current?: string): Promise<string | undefined> {
  const rl = createInterface({ input, output });
  try {
    if (provider === "openai") {
      console.log("Select model:");
      for (let index = 0; index < OPENAI_CHAT_MODELS.length; index += 1) {
        console.log(`  ${index + 1}) ${OPENAI_CHAT_MODELS[index]}`);
      }
      const fallback = current && isOpenAIModel(current) ? current.trim() : OPENAI_CHAT_MODELS[0];
      const answer = (await rl.question(`Model [${fallback}]: `)).trim();
      if (!answer) return fallback;
      const choice = Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= OPENAI_CHAT_MODELS.length) {
        return OPENAI_CHAT_MODELS[choice - 1];
      }
      return answer;
    }
    if (provider === "ollama") {
      console.log("Select model:");
      const models = OLLAMA_PICKER_MODELS;
      for (let index = 0; index < models.length; index += 1) {
        console.log(`  ${index + 1}) ${models[index]}`);
      }
      const fallback = current && isOllamaPickerModel(current) ? current.trim() : OLLAMA_PICKER_MODELS[0];
      const answer = (await rl.question(`Model [${fallback}]: `)).trim();
      if (!answer) return fallback;
      const choice = Number(answer);
      if (Number.isInteger(choice) && choice >= 1 && choice <= models.length) return models[choice - 1];
      return answer;
    }
    return current;
  } finally {
    rl.close();
  }
}

function normalizeProviderChoice(value?: string): ChatProviderChoice | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "openai") return "openai";
  if (normalized === "ollama" || normalized === "ollama-cloud") return "ollama";
  return undefined;
}

function providerChoiceLabel(provider: ChatProviderChoice): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "ollama") return "Ollama";
  return "Auto";
}

function cliProfilePath(): string {
  return path.join(crixHome(), "cli-profile.json");
}

async function loadCliProfile(): Promise<CliProfile> {
  try {
    const raw = await readFile(cliProfilePath(), "utf8");
    const parsed = JSON.parse(raw) as CliProfile;
    return {
      provider: normalizeProviderChoice(parsed.provider),
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model : undefined,
    };
  } catch {
    return {};
  }
}

async function saveCliProfile(profile: CliProfile): Promise<void> {
  const outputProfile: CliProfile = {
    provider: normalizeProviderChoice(profile.provider),
    model: profile.model?.trim() ? profile.model.trim() : undefined,
  };
  await mkdir(path.dirname(cliProfilePath()), { recursive: true });
  await writeFile(cliProfilePath(), `${JSON.stringify(outputProfile, null, 2)}\n`, "utf8");
}

async function liveProvider(args: ParsedArgs, session: InteractiveSession): Promise<void> {
  const requested = args.rest[0];
  if (!requested) {
    console.log(`provider: ${providerChoiceLabel(session.provider)}`);
    console.log("choices: auto, openai, ollama");
    return;
  }
  const provider = providerFromChoice(requested);
  if (!provider) throw new Error("provider choices: auto, openai, ollama");
  session.provider = provider;
  session.model = defaultModelForProvider(provider, session.model);
  await saveCliProfile({ provider: session.provider, model: session.model });
  console.log(`provider: ${providerChoiceLabel(session.provider)}`);
  console.log(`model: ${session.model ?? "auto"}`);
}

async function liveModel(args: ParsedArgs, session: InteractiveSession): Promise<void> {
  const models = modelsForProvider(session.provider);
  const requested = args.rest[0];
  if (!requested || requested === "list") {
    console.log(`provider: ${providerChoiceLabel(session.provider)}`);
    console.log(`current model: ${session.model ?? "auto"}`);
    if (models.length === 0) {
      console.log("model choices follow the configured provider automatically.");
      return;
    }
    for (let index = 0; index < models.length; index += 1) console.log(`  ${index + 1}) ${models[index]}`);
    console.log("Say `model <number-or-id>` to switch without restarting.");
    return;
  }
  const choice = Number(requested);
  const model = Number.isInteger(choice) && choice >= 1 && choice <= models.length ? models[choice - 1] : requested;
  session.model = model;
  await saveCliProfile({ provider: session.provider, model: session.model });
  console.log(`model: ${session.model}`);
}

function liveAgents(): void {
  for (const agent of defaultAgents()) {
    console.log(`${agent.id}: ${agent.name}`);
    console.log(`  ${agent.description}`);
    console.log(`  tools: ${agent.tools.join(", ") || "none"}`);
  }
    console.log("Say `agent researcher inspect current repo` or ask Crix to inspect agent orchestration.");
}

async function liveAgentNotifications(workspace: string): Promise<void> {
  const notifications = await AgentOrchestrator.listNotifications(workspace, 10);
  if (notifications.length === 0) {
    console.log("agent notifications: none");
    return;
  }
  console.log(`agent notifications: ${notifications.length}`);
  for (const note of notifications) {
    const when = note.createdAt.replace(/\.\d{3}Z$/, "Z");
    console.log(`- ${when} ${note.agentId} ${note.status}: ${shorten(note.summary, 160)}`);
    console.log(`  run: ${note.runId}`);
    if (note.transcriptPath) console.log(`  transcript: ${note.transcriptPath}`);
  }
}

function bindActiveTurn(session: InteractiveSession | undefined, engine: TurnEngine, label: string): () => void {
  if (!session) return () => undefined;
  const previous = session.activeTurn;
  session.activeTurn = {
    label,
    queue(content: string): void {
      engine.queueIntervention(content, { label });
    },
  };
  return () => {
    session.activeTurn = previous;
  };
}

function queueActiveIntervention(session: InteractiveSession, content: string): boolean {
  if (!session.activeTurn) return false;
  session.activeTurn.queue(content);
  return true;
}

function isQueuedIntervention(line: string): boolean {
  if (parseInteractiveInput(line).kind !== "chat") return false;
  const normalized = line.trim().toLowerCase();
  return /^(actually|wait|stop|cancel|pause|instead|also|btw|note:|correction:|change that|use |make sure)\b/.test(normalized);
}

function drainTurnInterventions(engine: TurnEngine): void {
  const drained = engine.drainInterventions();
  for (const intervention of drained) {
    printChatLine("intervention", shorten(intervention.content, 120));
  }
}

async function liveAgentRun(agent = "researcher", prompt = "", session?: InteractiveSession): Promise<void> {
  const selectedAgent = agent.trim() || "researcher";
  const selectedPrompt = prompt.trim() || "Inspect the active workspace and summarize one concrete improvement.";
  const engine = await TurnEngine.create({ workspace: process.cwd(), permissionMode: "workspace-write", provider: await providerFromSession(session), metadata: { source: "live-agent-run" } });
  const unbind = bindActiveTurn(session, engine, "agent run");
  try {
    await runToolCard(engine, { kind: "agent", name: "spawn_agent", input: { agent: selectedAgent, prompt: selectedPrompt, background: false } });
    drainTurnInterventions(engine);
    await printTurnArtifact(engine, process.cwd());
  } finally {
    unbind();
  }
}

async function liveToolAudit(session?: InteractiveSession, mode: "audit" | "flex" = "audit"): Promise<void> {
  const workspace = session?.workspace ?? process.cwd();
  const engine = await TurnEngine.create({ workspace, permissionMode: "workspace-write", metadata: { source: `tool-${mode}`, workspace } });
  const tools = buildToolFlexCards(workspace, mode);
  let passed = 0;
  const unbind = bindActiveTurn(session, engine, mode === "flex" ? "tool flex" : "tool audit");
  printSection(mode === "flex" ? "Tool flex" : "Workspace tool audit", `${tools.length} real calls against ${workspace}`);
  try {
    const results = new Map<string, ToolResult[]>();
    for (const spec of tools) {
      const result = await runToolCard(engine, spec);
      results.set(spec.name, [...(results.get(spec.name) ?? []), result]);
      if (result.ok) passed += 1;
      drainTurnInterventions(engine);
    }
    printToolFlexEvidence(results);
    const proof = await runToolCard(engine, {
      name: "proof_report",
      input: {
        name: mode === "flex" ? "tool-flex" : "live-tool-run",
        summary: `${mode} executed ${passed}/${tools.length} real tool calls`,
        data: { mode, workspace, tools: tools.map((tool) => tool.name), passed, total: tools.length },
      },
    });
    if (proof.ok) passed += 1;
    drainTurnInterventions(engine);
    console.log(`tool audit complete: ${passed}/${tools.length + 1} passed`);
    await printTurnArtifact(engine, workspace);
  } finally {
    unbind();
  }
}

function buildToolFlexCards(workspace: string, mode: "audit" | "flex"): ToolCardSpec[] {
  const cards: ToolCardSpec[] = [{ name: "list_dir", input: { path: ".", recursive: false } }];
  for (const file of ["package.json", "README.md", "tsconfig.json", "pyproject.toml", "Cargo.toml"]) {
    if (existsSync(path.join(workspace, file))) cards.push({ name: "read_file", input: { path: file } });
  }
  const keyDirs = ["src", "app", "apps", "packages", "crates", "docs", "tests"].filter((dir) => existsSync(path.join(workspace, dir)));
  for (const dir of keyDirs.slice(0, mode === "flex" ? 5 : 3)) cards.push({ name: "list_dir", input: { path: dir, recursive: false } });
  for (const dir of selectOutlineDirs(workspace, keyDirs).slice(0, mode === "flex" ? 5 : 3)) cards.push({ name: "file_outline", input: { path: dir } });
  for (const pattern of selectCodePatterns(workspace).slice(0, mode === "flex" ? 4 : 2)) cards.push({ name: "glob", input: { pattern } });
  cards.push({ name: "grep_search", input: { regex: "TODO|FIXME|HACK|placeholder|hardcoded|not implemented", includePattern: "**/*" } });
  if (mode === "flex") cards.push({ name: "codebase_retrieval", input: { query: "entrypoints tool runtime agent provider ui", maxResults: 8 } });
  cards.push({ name: "skill_list", input: {} });
  if (mode === "flex") {
    const stamp = Date.now().toString(36);
    const scratchFile = `.crix/artifacts/tool-flex/flex-${stamp}.js`;
    const taskId = `tool-flex-${stamp}`;
    cards.push({ name: "tasklist_add", input: { tasks: [{ id: taskId, title: "Prove write/read/verify tool execution", status: "in_progress", owner: "tool-flex" }] } });
    cards.push({ name: "write_file", input: { path: scratchFile, content: "export function crixToolFlex() { return 'real tool execution'; }\n" } });
    cards.push({ name: "read_file", input: { path: scratchFile } });
    cards.push({ name: "run_verification", input: { program: "node", args: ["--check", scratchFile], timeoutMs: 120_000 } });
    cards.push({ name: "tasklist_update", input: { taskId, status: "completed" } });
  }
  cards.push({ name: "tasklist_view", input: {} });
  cards.push({ name: "memory_search", input: { query: "coding harness tool agent verification", limit: 5 } });
  return cards;
}

function selectCodePatterns(workspace: string): string[] {
  const candidates = [
    ["packages", "**/*.ts"],
    ["src", "**/*.ts"],
    ["app", "**/*.tsx"],
    ["apps", "**/*.tsx"],
    ["crates", "**/*.rs"],
    ["tests", "**/*.mjs"],
  ] as const;
  const patterns = candidates.filter(([dir]) => existsSync(path.join(workspace, dir))).map(([, pattern]) => pattern);
  return patterns.length ? patterns : ["**/*.ts", "**/*.js"];
}

function printToolFlexEvidence(results: Map<string, ToolResult[]>): void {
  const total = [...results.values()].reduce((count, rows) => count + rows.length, 0);
  const names = [...results.keys()].join(", ");
  const hits = (results.get("grep_search") ?? []).reduce((count, result) => count + parseJsonArray(result.output).length, 0);
  const outlines = (results.get("file_outline") ?? []).reduce((count, result) => count + parseJsonArray(result.output).length, 0);
  printSection("Evidence", `${total} calls: ${names}`);
  console.log(`  outlines  ${outlines} file outline rows`);
  console.log(`  markers   ${hits} risk-marker hits`);
}

async function liveAgentOrchestration(session?: InteractiveSession): Promise<void> {
  const engine = await TurnEngine.create({ workspace: process.cwd(), permissionMode: "workspace-write", provider: await providerFromSession(session), metadata: { source: "agent-orchestration" } });
  const agents = [
    { id: "researcher", prompt: "Map the active workspace and identify one real architecture gap with evidence." },
    { id: "reviewer", prompt: "Review the active workspace execution path for one correctness or proof gap." },
  ];
  let passed = 0;
  const unbind = bindActiveTurn(session, engine, "agent orchestration");
  printSection("Agent orchestration", "bounded subagent runs with scoped tools");
  try {
    for (const agent of agents) {
      const result = await runToolCard(engine, { kind: "agent", name: "spawn_agent", input: { agent: agent.id, prompt: agent.prompt, background: false } });
      if (result.ok) passed += 1;
      drainTurnInterventions(engine);
    }
    console.log(`agent orchestration complete: ${passed}/${agents.length} passed`);
    await printTurnArtifact(engine, process.cwd());
  } finally {
    unbind();
  }
}

async function liveGoalRunTask(goal: string, session: InteractiveSession, targetPath?: string): Promise<void> {
  const provider = await providerFromSession(session);
  let workspace = await prepareGoalWorkspace(targetPath ?? session.workspace);
  if (targetPath) session.workspace = workspace;
  const executableGoal = goalForWorkspace(goal, workspace, Boolean(targetPath));

  printSection("Goal run", goal);
  console.log(`  workspace ${workspace}`);

  if (!provider) {
    console.log("  provider  unavailable");
    if (isArtifactOrCodeTask(goal)) {
      console.log("  blocked   artifact/code tasks require provider-driven Crix tool calls");
      console.log("No canned scaffold fallback was used. Connect OpenAI with `login`, pick Ollama with `provider ollama`, or pass an explicit plan file.");
      return;
    }
    console.log("Connect OpenAI with `login`, pick Ollama with `provider ollama`, or pass an explicit plan file.");
    return;
  }

  try {
    const kernel = await CrixKernel.create({ workspace, permissionMode: "workspace-write", provider });
    const proof = await kernel.runGoal({ goal: executableGoal, onEvent: (event) => renderRunGoalEvent(event) });
    printProof(proof);
    if (shouldOpenAfterGoal(goal)) await openGoalArtifact(goal, workspace, session);
  } catch (error) {
    const message = formatCliError(error);
    console.error(`goal run failed: ${message}`);
    if (isArtifactOrCodeTask(goal)) {
      console.log("  fallback  disabled");
      console.log("Provider/tool failure must be fixed or retried; Crix will not generate a canned local artifact.");
      return;
    }
    throw error;
  }
}

async function prepareGoalWorkspace(workspace: string): Promise<string> {
  const resolved = path.resolve(workspace);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

function goalForWorkspace(goal: string, workspace: string, targetWasExplicit: boolean): string {
  if (!targetWasExplicit) return goal;
  return [
    goal,
    "",
    `Target workspace: ${workspace}`,
    "Create or edit files inside that workspace. Use relative file paths in every plan step; the absolute target path is already the workspace root.",
  ].join("\n");
}

function isArtifactOrCodeTask(goal: string): boolean {
  const normalized = goal.toLowerCase();
  return /\b(html|website|site|webpage|page|app|application|notes?|todo|game|file|script|code|project|ui|feature)\b/.test(normalized)
    && /\b(make|create|build|write|generate|scaffold|set up|setup)\b/.test(normalized);
}

async function liveLocalScaffoldTask(goal: string, workspace: string, session?: InteractiveSession): Promise<void> {
  const engine = await TurnEngine.create({ workspace, permissionMode: "workspace-write", allowExternal: true, metadata: { source: "local-static-scaffold", goal } });
  const unbind = bindActiveTurn(session, engine, "local scaffold");
  const runId = Date.now().toString(36);
  const createTaskId = `scaffold-create-${runId}`;
  const openTaskId = `scaffold-open-${runId}`;
  const html = /\b(game|play|arcade|snake|pong|runner|tetris|clicker)\b/i.test(goal)
    ? generatedGameHtml(goal)
    : generatedNotesAppHtml(goal);
  const fileUrl = pathToFileURL(path.join(workspace, "index.html")).href;
  const cards: ToolCardSpec[] = [
    {
      name: "tasklist_add",
      input: {
        tasks: [
          { id: createTaskId, title: "Create static app files", status: "in_progress", owner: "main" },
          { id: openTaskId, title: "Open generated app", status: shouldOpenAfterGoal(goal) ? "pending" : "skipped", owner: "browser" },
        ],
      },
    },
    { name: "write_file", input: { path: "index.html", content: html } },
    { name: "write_file", input: { path: "README.md", content: localScaffoldReadme(goal) } },
    { name: "read_file", input: { path: "index.html" } },
    { name: "tasklist_update", input: { taskId: createTaskId, status: "completed" } },
    {
      name: "proof_report",
      input: {
        name: "local-static-scaffold",
        summary: `created index.html in ${workspace}`,
        data: { goal, workspace, fileUrl },
      },
    },
  ];
  if (shouldOpenAfterGoal(goal)) {
    cards.push({ name: "browser_open", input: { url: fileUrl } });
    cards.push({ name: "tasklist_update", input: { taskId: openTaskId, status: "completed" } });
  }

  let passed = 0;
  printSection("Task: local app scaffold", goal);
  try {
    for (const card of cards) {
      const result = await runToolCard(engine, card);
      if (result.ok) passed += 1;
      drainTurnInterventions(engine);
    }
    console.log(`task complete: ${passed}/${cards.length} toolcards passed`);
    console.log(`html: ${path.join(workspace, "index.html")}`);
    if (shouldOpenAfterGoal(goal)) console.log(`url: ${fileUrl}`);
    await printTurnArtifact(engine, workspace);
  } finally {
    unbind();
  }
}

async function openGoalArtifact(goal: string, workspace: string, session?: InteractiveSession): Promise<void> {
  const artifact = await findOpenableArtifact(workspace);
  if (!artifact) {
    console.log("open skipped: no HTML artifact found in the workspace root or app tree.");
    return;
  }
  const engine = await TurnEngine.create({ workspace, permissionMode: "workspace-write", allowExternal: true, metadata: { source: "goal-open-artifact", goal, artifact } });
  const unbind = bindActiveTurn(session, engine, "open artifact");
  try {
    const url = pathToFileURL(path.join(workspace, artifact)).href;
    await runToolCard(engine, { name: "browser_open", input: { url } });
    console.log(`opened: ${url}`);
    await printTurnArtifact(engine, workspace);
  } finally {
    unbind();
  }
}

async function findOpenableArtifact(workspace: string): Promise<string | undefined> {
  const matches: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4 || matches.length > 80) return;
    let entries;
    try {
      entries = await readdir(path.join(workspace, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      const normalized = relative.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if ([".crix", ".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;
        await walk(relative, depth + 1);
      } else if (/\.html?$/i.test(entry.name)) {
        matches.push(normalized);
      }
    }
  }
  await walk("", 0);
  return matches.find((file) => file.toLowerCase() === "index.html")
    ?? matches.find((file) => /\/index\.html?$/i.test(file))
    ?? matches[0];
}

function shouldOpenAfterGoal(goal: string): boolean {
  return /\b(open|launch|show|view)\b.*\b(it|browser|page|site|app|html)\b/i.test(goal)
    || /\b(open|launch|show|view)\b.*\bwhen done\b/i.test(goal)
    || /\bwhen done\b/i.test(goal);
}

function renderRunGoalEvent(event: RunGoalEvent): void {
  if (event.type === "preflight_tool_start" || event.type === "plan_tool_start" || event.type === "apply_tool_start") {
    const kind = event.call.kind ?? "tool";
    const title = kind === "agent" && typeof event.call.input.agent === "string" ? `${event.call.name}:${event.call.input.agent}` : event.call.name;
    tui.startToolCard(kind, title, event.call.name, event.call.input);
    return;
  }
  if (event.type === "preflight_tool_result" || event.type === "plan_tool_result" || event.type === "apply_tool_result") {
    tui.finishToolCard(event.call.name, event.call.input, event.result, "durationMs" in event ? event.durationMs : undefined);
    return;
  }
  if (event.type === "plan_created") {
    printSection("Plan", `${event.plan.steps.length} steps, ${event.plan.verification.length} verification command(s)`);
    console.log(`  ${event.plan.summary}`);
    return;
  }
  if (event.type === "step_start") {
    printSection("Step", `${event.step.id}: ${event.step.title}`);
    console.log(`  type      ${event.step.type}`);
    console.log(`  policy    ${event.allowed ? "allowed" : "blocked"} - ${event.reason}`);
    return;
  }
  if (event.type === "step_result") {
    console.log(`  result    ${shorten(event.message, 180)}`);
    return;
  }
  if (event.type === "verification_start") {
    const input: JsonRecord = { command: toJsonRecord(event.command) };
    tui.startToolCard("tool", "run_verification", "run_verification", input);
    return;
  }
  if (event.type === "verification_result") {
    const input: JsonRecord = { command: toJsonRecord(event.command) };
    const result: ToolResult = {
      callId: "final_verification",
      ok: event.report.ok,
      output: [event.report.stdoutTail.trimEnd(), event.report.stderrTail.trimEnd(), event.report.blockedReason ? `blocked: ${event.report.blockedReason}` : ""].filter(Boolean).join("\n"),
      metadata: { command: event.report.command, code: event.report.code, durationMs: event.report.durationMs },
    };
    tui.finishToolCard("run_verification", input, result, event.report.durationMs);
  }
}

function toJsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

async function liveRepoScanTask(goal: string, fallbackWorkspace?: string, mode: RepoScanMode = "scout", session?: InteractiveSession): Promise<void> {
  const target = extractLocalPath(goal) ?? fallbackWorkspace;
  if (!target) {
    console.log("Repo scan needs a local path, for example: `learn D:\\Repo and pitch improvements`.");
    return;
  }
  const workspace = path.resolve(target);
  if (!existsSync(workspace)) {
    console.log(`Repo scan blocked: path not found: ${workspace}`);
    console.log("No files were read or changed.");
    return;
  }

  const engine = await TurnEngine.create({ workspace, permissionMode: "auto-safe", metadata: { source: `repo-${mode}`, workspace } });
  const cards = buildRepoScanCards(workspace, mode);
  const unbind = bindActiveTurn(session, engine, mode === "deep" ? "repo deep scan" : "repo scout");

  printSection(mode === "deep" ? "Repo deep scan" : "Repo scout", workspace);
  console.log(`  mode      read-only`);

  try {
    const results = new Map<string, ToolResult[]>();
    for (const card of cards) {
      const result = await runToolCard(engine, card);
      results.set(card.name, [...(results.get(card.name) ?? []), result]);
      drainTurnInterventions(engine);
    }
    printRepoScanFindings(workspace, results, mode);
    if (workspace === process.cwd()) await printTurnArtifact(engine, process.cwd());
  } finally {
    unbind();
  }
}

function buildRepoScanCards(workspace: string, mode: RepoScanMode): ToolCardSpec[] {
  const cards: ToolCardSpec[] = [{ name: "list_dir", input: { path: ".", recursive: false } }];
  for (const file of ["package.json", "README.md", "tsconfig.json", "Cargo.toml"]) {
    if (existsSync(path.join(workspace, file))) cards.push({ name: "read_file", input: { path: file } });
  }
  const keyDirs = ["src", "packages", "apps", "crates", "codex-rs", "docs"].filter((dir) => existsSync(path.join(workspace, dir)));
  for (const dir of keyDirs) cards.push({ name: "list_dir", input: { path: dir, recursive: false } });
  if (mode === "deep") {
    for (const dir of selectOutlineDirs(workspace, keyDirs).slice(0, 6)) cards.push({ name: "file_outline", input: { path: dir } });
    for (const dir of keyDirs.slice(0, 4)) {
      cards.push({
        name: "grep_search",
        input: {
          cwd: dir,
          regex: "TODO|FIXME|HACK|not implemented|placeholder|hardcoded|demo|throw new Error",
          ignoreCase: true,
        },
      });
    }
  }
  return cards;
}

function selectOutlineDirs(workspace: string, keyDirs: string[]): string[] {
  const candidates = [
    "packages/cli/src",
    "packages/core/src",
    "packages/protocol/src",
    "src",
    "app",
    "apps",
    "crates",
    "codex-rs/core/src",
    "codex-rs/tui/src",
    ...keyDirs,
  ];
  return [...new Set(candidates)].filter((dir) => existsSync(path.join(workspace, dir)));
}

async function runToolCard(engine: TurnEngine, spec: ToolCardSpec): Promise<ToolResult> {
  return await tui.runToolCard(engine, spec);
}

async function printTurnArtifact(turn: TurnRecorder | TurnEngine, workspace: string): Promise<void> {
  await tui.printTurnArtifact(turn, workspace);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shorten(value: string, max = 120): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function printRepoScanFindings(workspace: string, results: Map<string, ToolResult[]>, mode: RepoScanMode): void {
  const packageResult = results.get("read_file")?.find((result) => result.output.includes("\"package.json\""));
  const pkg = packageResult ? parsePackageJsonFromReadFile(packageResult.output) : undefined;
  const readResults = results.get("read_file") ?? [];
  const packageJsons = readResults.filter((result) => result.output.includes("\"package.json\"")).length;
  const readmes = readResults.filter((result) => result.output.includes("\"README.md\"")).length;
  const tsconfigs = readResults.filter((result) => result.output.includes("\"tsconfig.json\"")).length;
  const listedDirs = (results.get("list_dir") ?? []).length;
  const outlineRows = (results.get("file_outline") ?? []).flatMap((result) => parseJsonArray(result.output));
  const outlinedFiles = outlineRows.length;
  const outlinedSymbols = outlineRows.flatMap((row) => isRecord(row) && Array.isArray(row.symbols) ? row.symbols : []).length;
  const riskHits = (results.get("grep_search") ?? []).reduce((count, result) => count + parseJsonArray(result.output).length, 0);
  const scripts = pkg?.scripts ? Object.keys(pkg.scripts) : [];
  const hasVerify = scripts.some((script) => /^(verify|check|test|lint|build)$/.test(script));

  printSection("Findings", workspace);
  console.log(`  package   ${pkg?.name ?? "not detected"}${pkg?.packageManager ? ` via ${pkg.packageManager}` : ""}`);
  console.log(`  scripts   ${scripts.length ? scripts.slice(0, 8).join(", ") : "none detected"}`);
  console.log(`  files     package.json=${packageJsons} README=${readmes} tsconfig=${tsconfigs}`);
  console.log(`  dirs      ${listedDirs} shallow inspected`);
  if (mode === "deep") {
    console.log(`  outlines  ${outlinedFiles} files, ${outlinedSymbols} symbols`);
    console.log(`  risks     ${riskHits} marker hits`);
  }
  printSection("Pitch");
  if (mode === "deep" && riskHits > 0) {
    console.log("  Add a follow-up risk review lane: group marker hits by subsystem, then decide which are real bugs versus harmless guardrails.");
  } else if (!hasVerify) {
    console.log("  Add a repo verification contract first: one command the harness can run before/after any edit.");
  } else {
    console.log("  Add a repo scout cache: persist entrypoints, scripts, architecture notes, and verification commands before edits.");
  }
  console.log("  This improves coding reliability by grounding every run in local facts instead of provider guesses.");
  console.log("  No files changed.");
}

function parsePackageJsonFromReadFile(outputText: string): { name?: string; packageManager?: string; scripts?: Record<string, string> } | undefined {
  const rows = parseJsonArray(outputText);
  const first = rows.find((row) => isRecord(row) && row.path === "package.json");
  if (!isRecord(first) || typeof first.content !== "string") return undefined;
  try {
    const parsed = JSON.parse(first.content.trimStart().replace(/^\uFEFF/, "")) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      packageManager: typeof parsed.packageManager === "string" ? parsed.packageManager : undefined,
      scripts: isRecord(parsed.scripts) ? Object.fromEntries(Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string")) as Record<string, string> : undefined,
    };
  } catch {
    return undefined;
  }
}

async function liveStatus(session: InteractiveSession): Promise<void> {
  console.log(`active: ${sessionLabel(session)}`);
  console.log(`workspace: ${session.workspace}`);
  const openai = await new OpenAIAuthStore().status();
  const ollama = await new OllamaCloudAuthStore().status();
  console.log(`openai: ${openai.configured ? `${openai.mode}; ${openai.source}` : "not configured"}`);
  console.log(`ollama: ${ollama.model}; ${ollama.host}; ${ollama.source}`);
}

function sessionLabel(session: Pick<InteractiveSession, "provider" | "model">): string {
  return session.provider === "auto" ? "auto" : session.model ? `${session.provider}:${session.model}` : session.provider;
}

function sessionPrompt(session: InteractiveSession): string {
  return `${styleText("crix", "brand")} ${styleText(sessionLabel(session), "muted")} ${styleText(">", "accent")} `;
}

function providerFromChoice(value: string): ChatProviderChoice | undefined {
  const normalized = value.trim().toLowerCase();
  if (["1", "auto", "a"].includes(normalized)) return "auto";
  if (["2", "openai", "o", "gpt"].includes(normalized)) return "openai";
  if (["3", "ollama", "ollama-cloud", "cloud"].includes(normalized)) return "ollama";
  return undefined;
}

function modelsForProvider(provider: ChatProviderChoice): string[] {
  if (provider === "openai") return OPENAI_CHAT_MODELS;
  if (provider === "ollama") return OLLAMA_PICKER_MODELS;
  return [];
}

function defaultModelForProvider(provider: ChatProviderChoice, current?: string): string | undefined {
  if (provider === "openai") return current && isOpenAIModel(current) ? current : OPENAI_CHAT_MODELS[0];
  if (provider === "ollama") return current && isOllamaPickerModel(current) ? current : OLLAMA_PICKER_MODELS[0];
  return current;
}

async function chat(text: string, session: InteractiveSession): Promise<void> {
  const turn = planTurnIntent(text, {
    activeWorkspace: session.workspace,
    pathExists: (candidate) => existsSync(path.resolve(candidate)),
  });
  if (turn.targetPath && existsSync(path.resolve(turn.targetPath))) session.workspace = path.resolve(turn.targetPath);

  switch (turn.kind) {
    case "goal_run":
      await liveGoalRunTask(text, session, turn.targetPath);
      return;
    case "workspace_capture":
      console.log(`workspace: ${session.workspace}`);
      console.log("Say `inspect` or `learn it` to scout it read-only.");
      return;
    case "tool_audit":
      await liveToolAudit(session, /flex/i.test(text) ? "flex" : "audit");
      return;
    case "agent_orchestration":
      await liveAgentOrchestration(session);
      return;
    case "repo_scan":
      await liveRepoScanTask(text, session.workspace, turn.repoScanMode ?? "scout", session);
      return;
    case "local_status":
      await liveLocalStatus(text, session);
      return;
    case "provider_chat":
      break;
  }

  if (isConversationOnlyChat(text)) {
    if (await tryRunPlainConfiguredProviderChat(session, text)) return;
    livePlainConversationFallback(text);
    return;
  }

  if (await tryRunConfiguredProviderChat(session, text)) return;

  const goal = text.trim();
  await runAgentRuntimeChat(session, goal, "local");
}

async function tryRunPlainConfiguredProviderChat(session: InteractiveSession, text: string): Promise<boolean> {
  const instructions = [
    "You are Crix, a concise terminal coding assistant.",
    "This is a plain conversation turn. Do not request or imply local file/tool access.",
    "Answer the user's immediate message directly and briefly.",
  ].join("\n");
  if ((session.provider === "openai" || session.provider === "auto") && await hasUsableOpenAIAuth()) {
    try {
      printChatLine("openai", await completeOpenAIChat(text, { instructions, model: session.model }));
      return true;
    } catch (error) {
      if (session.provider === "openai") console.error(`OpenAI chat failed: ${formatCliError(error)}`);
    }
  }
  if (session.provider === "ollama" || (session.provider === "auto" && await hasUsableOllamaCloudAuth())) {
    try {
      printChatLine("ollama", await new OllamaCloudClient({ model: session.model }).completeText(text, instructions));
      return true;
    } catch (error) {
      if (session.provider === "ollama") console.error(`Ollama chat failed: ${formatCliError(error)}`);
    }
  }
  return false;
}

function livePlainConversationFallback(_text: string): void {
  console.log("No local tools or repo scan ran.");
  console.log("This is a conversation turn; type an explicit task when you want Crix to work in the repo.");
}

async function tryRunConfiguredProviderChat(session: InteractiveSession, text: string): Promise<boolean> {
  if (session.provider === "openai" || session.provider === "auto") {
    const openaiConfigured = await hasUsableOpenAIAuth();
    if (session.provider === "openai" || openaiConfigured) {
      try {
        await runAgentRuntimeChat(session, text, "openai");
        return true;
      } catch (error) {
        const message = formatCliError(error);
        console.error(`OpenAI chat failed: ${message}`);
      }
    }
  }
  if (session.provider === "ollama" || session.provider === "auto") {
    if (session.provider === "ollama" || await hasUsableOllamaCloudAuth()) {
      try {
        await runAgentRuntimeChat(session, text, "ollama");
        return true;
      } catch (error) {
        const message = formatCliError(error);
        console.error(`Ollama chat failed: ${message}`);
      }
    }
  }
  return false;
}

async function liveLocalStatus(text: string, session: InteractiveSession): Promise<void> {
  const reaction = isShortReaction(text);
  const openaiConfigured = await hasUsableOpenAIAuth();
  console.log(reaction ? "No local tools or repo scan ran." : "Crix is idle and ready for a natural request.");
  const setup = openaiConfigured
    ? "OpenAI auth exists, but local Ollama is the practical fallback when OAuth/provider calls fail."
    : "For local models, start Ollama on 127.0.0.1:11434 and say `provider ollama`.";
  if (!reaction) console.log(setup);
  console.log("Type the task normally; Crix will route tools when the task needs them.");
}

function isShortReaction(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/g, "").trim();
  return /^(man\s+tf|wtf|tf|bruh|bro|bro what|huh|what|nah|no|nope|yikes|ugh|dang|damn|lol|lmao)\s*$/.test(normalized);
}

function isConversationOnlyChat(text: string): boolean {
  if (extractLocalPath(text)) return false;
  const normalized = text.trim().toLowerCase();
  if (/\b(don'?t|dont|do not)\b.*\b(work|run|execute|call|use|touch|inspect|read)\b/.test(normalized)
    && /\b(when i said|prior|previous|fake|real|instance response|output|tool output|tools? were)\b/.test(normalized)) return true;
  const aboutAgent = /\b(u|you|your|ur|agent|crix|coding|code|prompt|instructions|behavior|tools?|scan|inspect)\b/.test(normalized);
  if (aboutAgent && /\b(i never asked|never asked|why did (u|you)|why are (u|you)|what made (u|you)|makes (u|you) do|made (u|you) do|supposed to|is it something in (ur|your) (coding|code|prompt|instructions)|what caused (it|that)|trying to trouble\s*shoot|trouble\s*shoot)\b/.test(normalized)) return true;
  return /^(what do you think|what do u think|thoughts|wdyt)\??$/.test(normalized);
}

async function runAgentRuntimeChat(session: InteractiveSession, text: string, provider: "openai" | "ollama" | "local"): Promise<void> {
  const runtime = await agentRuntimeForSession(session, provider);
  const previousTurn = session.activeTurn;
  session.activeTurn = {
    label: "agent runtime",
    queue(content: string): void {
      runtime.queueIntervention(content, { provider, model: session.model ?? "auto" });
    },
  };
  let finalText = "";
  let turnArtifact = "";
  const activeCards = new Map<string, ToolCardSpec>();
  const fullscreen = shouldUseFullscreen();
  const frame = fullscreen ? new FullscreenTurnRenderer(output, {
    provider,
    model: session.model,
    workspace: session.workspace,
    goal: text,
  }) : undefined;
  if (frame) frame.begin();
  else tui.turnStart(text, [`provider=${provider}`, `workspace=${session.workspace}`]);
  try {
    for await (const event of runtime.submit(text)) {
      if (frame) frame.event(event);
      else renderAgentRuntimeEvent(event, provider, activeCards);
      if (event.type === "final") {
        finalText = event.text;
        session.workspace = event.state.workspace;
        turnArtifact = path.relative(session.workspace, event.turnArtifactPath);
        if (!frame) console.log(`turn saved ${turnArtifact}`);
      }
    }
  } finally {
    session.activeTurn = previousTurn;
  }
  if (frame) frame.finish(finalText, turnArtifact);
  else tui.turnEnd(finalText ? "completed" : "no final answer", turnArtifact);
  if (!finalText) printChatLine(provider === "local" ? "agent" : provider, "No final answer was produced.");
}

async function agentRuntimeForSession(session: InteractiveSession, provider: "openai" | "ollama" | "local"): Promise<AgentRuntime> {
  const existing = session.agentRuntime;
  if (existing && existing.provider === provider && existing.model === session.model && existing.runtime.sessionState.workspace === session.workspace) {
    return existing.runtime;
  }
  const providerInstance = provider === "local" ? undefined : chatLoopProvider(session, provider);
  try {
    const resumed = await AgentRuntime.resume({
      workspace: session.workspace,
      provider: providerInstance,
      model: session.model,
      permissionMode: "auto-safe",
      permissionPrompt: interactivePermissionPrompt(),
    });
    session.agentRuntime = { provider, model: session.model, runtime: resumed };
    return resumed;
  } catch {
    // No durable agent session exists yet for this workspace/provider.
  }
  const runtime = await AgentRuntime.create({
    workspace: session.workspace,
    provider: providerInstance,
    model: session.model,
    permissionMode: "auto-safe",
    permissionPrompt: interactivePermissionPrompt(),
  });
  session.agentRuntime = { provider, model: session.model, runtime };
  return runtime;
}

function renderAgentRuntimeEvent(event: AgentTurnEvent, provider: "openai" | "ollama" | "local", activeCards: Map<string, ToolCardSpec>): void {
  if (event.type === "grant_added") {
    tui.line(`  grant ${event.grant.read ? "read" : ""}${event.grant.write ? "+write" : ""} ${event.grant.root}`);
    return;
  }
  if (event.type === "tool_start") {
    const spec = { kind: event.call.kind ?? "tool", name: event.call.name, input: event.call.input };
    activeCards.set(event.call.id, spec);
    tui.startToolCard(spec.kind, event.call.kind === "agent" ? `${event.call.name}:${String(event.call.input.agent ?? "")}` : event.call.name, event.call.name, event.call.input);
    return;
  }
  if (event.type === "tool_result") {
    const spec = activeCards.get(event.call.id) ?? { kind: event.call.kind ?? "tool", name: event.call.name, input: event.call.input };
    activeCards.delete(event.call.id);
    tui.finishToolCard(spec.name, spec.input, event.result);
    return;
  }
  if (event.type === "assistant" && event.toolCallCount > 0) {
    printChatLine("assistant", `requested ${event.toolCallCount} tool call${event.toolCallCount === 1 ? "" : "s"}`);
    return;
  }
  if (event.type === "intervention") {
    for (const message of event.messages) printChatLine("intervention", shorten(message.content, 120));
    return;
  }
  if (event.type === "final") {
    printChatLine(provider === "local" ? "agent" : provider, event.text);
  }
}

async function runProviderChatToolLoop(engine: TurnEngine, session: InteractiveSession, text: string, provider: "openai" | "ollama"): Promise<void> {
  const item = engine.recorder.startItem({
    kind: "assistant_message",
    title: `${provider} chat`,
    input: { text, model: session.model ?? "auto" },
    metadata: { provider, loop: "tool-use" },
  });
  const modelProvider = chatLoopProvider(session, provider);
  try {
    const result = await runProviderToolLoop({
      goal: text,
      systemPrompt: chatToolLoopSystemPrompt(session.prompt),
      context: {
        workspace: session.workspace,
        goal: text,
        messages: [],
        memories: [],
        files: [],
        budget: { maxChars: 0, usedChars: 0 },
      },
      tools: defaultTools(),
      agents: defaultAgents(),
      messages: [{ id: `msg_chat_${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() }],
      provider: modelProvider,
      engine,
      maxRounds: 5,
      mode: "chat",
      onEvent(event) {
        if (event.type === "assistant" && event.toolCallCount > 0) {
          printChatLine("assistant", `requested ${event.toolCallCount} tool call${event.toolCallCount === 1 ? "" : "s"}`);
        }
        if (event.type === "tool_start") {
          printChatLine("tool", event.call.name);
        }
        if (event.type === "tool_result") {
          printChatLine(event.result.ok ? "ok" : "failed", shorten(event.result.output, 120));
        }
      },
    });
    const response = result.response.text;
    printChatLine(provider, response);
    engine.recorder.completeItem(item.id, {
      summary: shorten(response, 240),
      output: response,
      metadata: { provider, rounds: result.rounds, toolCallCount: result.toolCallCount },
    });
  } catch (error) {
    engine.recorder.failItem(item.id, formatCliError(error), { provider });
    throw error;
  }
}

function chatLoopProvider(session: InteractiveSession, provider: "openai" | "ollama"): ModelProvider {
  return {
    kind: provider === "openai" ? "openai-oauth" : "ollama-cloud",
    async complete(request) {
      const prompt = renderChatToolLoopPrompt(request.messages);
      const text = provider === "openai"
        ? await completeOpenAIChat(prompt, { instructions: request.systemPrompt, model: session.model })
        : await new OllamaCloudClient({ model: session.model }).completeText(prompt, request.systemPrompt);
      try {
        return parseProviderJsonResponse(text);
      } catch {
        return { text };
      }
    },
  };
}

function chatToolLoopSystemPrompt(basePrompt: string): string {
  return `${basePrompt}

You are in provider-chat tool-use mode.
- If you need local context or verification before answering, return only valid JSON shaped as {"text":"why you need the tool","toolCalls":[{"id":"call_1","name":"read_file","input":{"path":"README.md"}}]}.
- Prefer read-only tools: read_file, read_partial_file, list_dir, glob, grep_search, codebase_retrieval, diagnostics, file_outline, memory_search, git_status, git_diff.
- Tool rounds are bounded and policy-gated. Do not request destructive or external-state tools.
- When you have enough information, answer normally in plain text.`;
}

function renderChatToolLoopPrompt(messages: Array<{ role: string; name?: string; content: string }>): string {
  return messages
    .slice(-12)
    .map((message) => `${message.role}${message.name ? `(${message.name})` : ""}: ${message.content}`)
    .join("\n\n");
}

function localScaffoldReadme(goal: string): string {
  return [
    "# Crix Static App",
    "",
    "Crix created this local static app as a no-provider fallback.",
    "",
    "Open `index.html` in a browser. Notes are stored in localStorage on this machine.",
    "",
    "Original request:",
    "",
    goal.trim() || "Create a static app.",
    "",
  ].join("\n");
}

function generatedNotesAppHtml(goal: string): string {
  const safeGoal = escapeHtml(goal.trim() || "make a simple notes app");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nuts Notes</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --ink: #1e2930;
      --muted: #66747c;
      --panel: #ffffff;
      --line: #d8ddd8;
      --accent: #236f5a;
      --accent-2: #d1495b;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); }
    .app { min-height: 100vh; display: grid; grid-template-columns: 320px minmax(0, 1fr); }
    aside { border-right: 1px solid var(--line); background: #ebe8df; padding: 18px; display: grid; grid-template-rows: auto auto 1fr; gap: 14px; }
    main { padding: clamp(18px, 3vw, 34px); display: grid; grid-template-rows: auto 1fr; gap: 16px; }
    h1 { margin: 0; font-size: 1.55rem; letter-spacing: 0; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    button, input, textarea { font: inherit; }
    button { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 7px; min-height: 38px; padding: 0 12px; cursor: pointer; }
    button.primary { background: var(--accent); border-color: var(--accent); color: white; font-weight: 700; }
    button.danger { color: var(--accent-2); }
    input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--ink); padding: 11px 12px; outline: none; }
    input:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px #236f5a20; }
    #search { min-height: 40px; }
    .list { display: grid; align-content: start; gap: 8px; overflow: auto; padding-right: 2px; }
    .note { text-align: left; display: grid; gap: 4px; min-height: 64px; padding: 10px; background: #fffdf8; border-color: transparent; }
    .note.active { border-color: var(--accent); box-shadow: 0 0 0 2px #236f5a18; }
    .note b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .note span { color: var(--muted); font-size: .86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .editor { display: grid; grid-template-rows: auto 1fr auto; gap: 12px; min-height: 0; }
    textarea { min-height: 360px; resize: vertical; line-height: 1.55; }
    .meta { color: var(--muted); font-size: .9rem; display: flex; gap: 10px; flex-wrap: wrap; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; display: grid; place-items: center; min-height: 260px; color: var(--muted); text-align: center; padding: 24px; }
    @media (max-width: 760px) {
      .app { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); max-height: 46vh; }
      textarea { min-height: 300px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside>
      <div class="toolbar">
        <h1>Nuts Notes</h1>
        <button class="primary" id="newNote">New</button>
      </div>
      <input id="search" placeholder="Search notes" autocomplete="off">
      <div class="list" id="noteList" aria-label="Saved notes"></div>
    </aside>
    <main>
      <div class="toolbar">
        <input id="title" placeholder="Untitled note" aria-label="Note title">
        <button id="save" class="primary">Save</button>
        <button id="delete" class="danger">Delete</button>
      </div>
      <section class="editor" id="editor">
        <textarea id="body" placeholder="Write a note..." aria-label="Note body"></textarea>
        <div class="meta"><span id="status">Ready</span><span>Request: ${safeGoal}</span></div>
      </section>
      <section class="empty" id="empty" hidden>No note selected.</section>
    </main>
  </div>
  <script>
    const storeKey = "crix.nuts.notes.v1";
    const listEl = document.getElementById("noteList");
    const titleEl = document.getElementById("title");
    const bodyEl = document.getElementById("body");
    const searchEl = document.getElementById("search");
    const statusEl = document.getElementById("status");
    const editorEl = document.getElementById("editor");
    const emptyEl = document.getElementById("empty");
    let notes = loadNotes();
    let activeId = notes[0]?.id || null;

    function loadNotes() {
      try {
        const parsed = JSON.parse(localStorage.getItem(storeKey) || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    function persist() {
      localStorage.setItem(storeKey, JSON.stringify(notes));
      statusEl.textContent = "Saved " + new Date().toLocaleTimeString();
    }
    function createNote() {
      const note = { id: crypto.randomUUID(), title: "Untitled note", body: "", updatedAt: Date.now() };
      notes = [note, ...notes];
      activeId = note.id;
      persist();
      render();
      titleEl.focus();
      titleEl.select();
    }
    function activeNote() {
      return notes.find(note => note.id === activeId) || null;
    }
    function saveActive() {
      const note = activeNote();
      if (!note) return;
      note.title = titleEl.value.trim() || "Untitled note";
      note.body = bodyEl.value;
      note.updatedAt = Date.now();
      notes = [note, ...notes.filter(item => item.id !== note.id)];
      activeId = note.id;
      persist();
      renderList();
    }
    function deleteActive() {
      const note = activeNote();
      if (!note) return;
      notes = notes.filter(item => item.id !== note.id);
      activeId = notes[0]?.id || null;
      persist();
      render();
    }
    function renderList() {
      const query = searchEl.value.trim().toLowerCase();
      const filtered = notes.filter(note => (note.title + " " + note.body).toLowerCase().includes(query));
      listEl.innerHTML = "";
      for (const note of filtered) {
        const button = document.createElement("button");
        button.className = "note" + (note.id === activeId ? " active" : "");
        button.innerHTML = "<b></b><span></span>";
        button.querySelector("b").textContent = note.title || "Untitled note";
        button.querySelector("span").textContent = note.body.trim() || new Date(note.updatedAt).toLocaleString();
        button.addEventListener("click", () => { saveActive(); activeId = note.id; render(); });
        listEl.append(button);
      }
    }
    function renderEditor() {
      const note = activeNote();
      editorEl.hidden = !note;
      emptyEl.hidden = Boolean(note);
      titleEl.disabled = !note;
      bodyEl.disabled = !note;
      document.getElementById("save").disabled = !note;
      document.getElementById("delete").disabled = !note;
      titleEl.value = note?.title || "";
      bodyEl.value = note?.body || "";
      statusEl.textContent = note ? "Last changed " + new Date(note.updatedAt).toLocaleString() : "Ready";
    }
    function render() {
      renderList();
      renderEditor();
    }
    document.getElementById("newNote").addEventListener("click", createNote);
    document.getElementById("save").addEventListener("click", saveActive);
    document.getElementById("delete").addEventListener("click", deleteActive);
    searchEl.addEventListener("input", renderList);
    titleEl.addEventListener("input", () => { statusEl.textContent = "Unsaved changes"; });
    bodyEl.addEventListener("input", () => { statusEl.textContent = "Unsaved changes"; });
    window.addEventListener("keydown", event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActive();
      }
    });
    if (notes.length === 0) createNote();
    render();
  </script>
</body>
</html>
`;
}

function generatedGameHtml(goal: string): string {
  const safeGoal = escapeHtml(goal.trim() || "make a game html and open it");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neon Drift</title>
  <style>
    :root { color-scheme: dark; font-family: "Bahnschrift", "Segoe UI", sans-serif; background: #06110e; color: #f4ffe8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 18% 16%, #62ffa633, transparent 30%), radial-gradient(circle at 85% 80%, #2dd4ff28, transparent 32%), linear-gradient(140deg, #06110e, #101923 58%, #201507); }
    main { width: min(980px, calc(100vw - 28px)); display: grid; gap: 18px; }
    header { display: flex; justify-content: space-between; align-items: end; gap: 18px; }
    .eyebrow { color: #9cffc8; letter-spacing: .18em; text-transform: uppercase; font-size: .78rem; font-weight: 800; }
    h1 { margin: 4px 0 0; font-size: clamp(2.4rem, 8vw, 5.8rem); line-height: .86; }
    .hud { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; min-width: min(380px, 100%); }
    .stat { border: 1px solid #ffffff24; border-radius: 18px; padding: 10px 14px; background: #ffffff0b; }
    .stat b { display: block; font-size: 1.45rem; color: #e8ff8f; }
    .panel { border: 1px solid #c9ffad38; background: #06110ecc; box-shadow: 0 24px 80px #000a, inset 0 1px 0 #ffffff18; border-radius: 28px; padding: clamp(16px, 3vw, 28px); }
    canvas { width: 100%; aspect-ratio: 16 / 9; display: block; border-radius: 22px; border: 1px solid #95ffcb38; background: #020807; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; color: #d6e8de; }
    kbd { border: 1px solid #ffffff3a; background: #ffffff12; border-radius: 8px; padding: 3px 8px; color: #f7ffe8; }
    button { cursor: pointer; border: 0; border-radius: 999px; padding: 11px 18px; color: #04110a; font-weight: 800; background: linear-gradient(135deg, #e8ff8f, #69f0ae); }
    @media (max-width: 720px) { header { display: grid; } .hud { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><div class="eyebrow">Playable HTML artifact</div><h1>Neon Drift</h1></div>
      <div class="hud">
        <div class="stat">Score <b id="score">0</b></div>
        <div class="stat">Best <b id="best">0</b></div>
        <div class="stat">Speed <b id="speed">1x</b></div>
      </div>
    </header>
    <section class="panel">
      <canvas id="game" width="960" height="540" aria-label="Neon Drift playable canvas"></canvas>
      <p class="controls"><span><kbd>Left</kbd> <kbd>Right</kbd> or <kbd>A</kbd> <kbd>D</kbd> to drift.</span><span><kbd>Space</kbd> restarts after a crash.</span><button id="restart">Restart</button></p>
      <p class="controls">Request: ${safeGoal}</p>
    </section>
  </main>
  <script>
    const canvas = document.getElementById("game");
    const ctx = canvas.getContext("2d");
    const scoreEl = document.getElementById("score");
    const bestEl = document.getElementById("best");
    const speedEl = document.getElementById("speed");
    const keys = new Set();
    let player, gates, sparks, score, best = 0, speed, alive, last;
    function reset() {
      player = { x: 480, y: 445, vx: 0, r: 15 };
      gates = [];
      sparks = [];
      score = 0;
      speed = 1;
      alive = true;
      last = performance.now();
      for (let i = 0; i < 7; i++) gates.push(newGate(-i * 95));
      updateHud();
    }
    function newGate(y) {
      const gap = 145 - Math.min(55, score * 0.7);
      const center = 150 + Math.random() * 660;
      return { y, left: center - gap, right: center + gap, passed: false };
    }
    function updateHud() {
      scoreEl.textContent = String(Math.floor(score));
      bestEl.textContent = String(Math.floor(best));
      speedEl.textContent = speed.toFixed(1) + "x";
    }
    function step(now) {
      const dt = Math.min(32, now - last) / 16.67;
      last = now;
      if (alive) {
        const steer = (keys.has("ArrowRight") || keys.has("d") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("a") ? 1 : 0);
        player.vx = player.vx * 0.86 + steer * 1.9;
        player.x += player.vx * dt * 7;
        player.x = Math.max(28, Math.min(canvas.width - 28, player.x));
        speed = 1 + Math.min(2.8, score / 120);
        for (const gate of gates) {
          gate.y += (4.2 * speed) * dt;
          if (!gate.passed && gate.y > player.y) {
            gate.passed = true;
            score += 10;
            best = Math.max(best, score);
            for (let i = 0; i < 10; i++) sparks.push({ x: player.x, y: player.y, vx: (Math.random() - .5) * 7, vy: -Math.random() * 5, life: 28 });
          }
          if (Math.abs(gate.y - player.y) < 18 && (player.x < gate.left || player.x > gate.right)) alive = false;
        }
        while (gates[0] && gates[0].y > canvas.height + 40) { gates.shift(); gates.push(newGate(gates[gates.length - 1].y - 95)); }
      }
      for (const spark of sparks) { spark.x += spark.vx * dt; spark.y += spark.vy * dt; spark.life -= dt; }
      sparks = sparks.filter(spark => spark.life > 0);
      draw();
      updateHud();
      requestAnimationFrame(step);
    }
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, "#071815"); gradient.addColorStop(1, "#050708");
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#69f0ae22"; ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - 120, canvas.height); ctx.stroke(); }
      for (const gate of gates) {
        ctx.lineWidth = 10; ctx.lineCap = "round"; ctx.strokeStyle = gate.passed ? "#69f0ae55" : "#e8ff8f";
        ctx.beginPath(); ctx.moveTo(44, gate.y); ctx.lineTo(gate.left, gate.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gate.right, gate.y); ctx.lineTo(canvas.width - 44, gate.y); ctx.stroke();
      }
      for (const spark of sparks) { ctx.fillStyle = "rgba(232,255,143," + (spark.life / 28) + ")"; ctx.beginPath(); ctx.arc(spark.x, spark.y, 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.shadowColor = alive ? "#69f0ae" : "#ff5d73"; ctx.shadowBlur = 24; ctx.fillStyle = alive ? "#e8ff8f" : "#ff5d73";
      ctx.beginPath(); ctx.arc(player.x, player.y, player.r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      if (!alive) {
        ctx.fillStyle = "rgba(0,0,0,.58)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#f2ffe8"; ctx.textAlign = "center"; ctx.font = "800 54px Bahnschrift, Segoe UI"; ctx.fillText("CRASHED", canvas.width / 2, 245);
        ctx.font = "24px Bahnschrift, Segoe UI"; ctx.fillText("Press Space or Restart", canvas.width / 2, 288);
      }
    }
    addEventListener("keydown", event => { keys.add(event.key); if (event.code === "Space" && !alive) reset(); });
    addEventListener("keyup", event => keys.delete(event.key));
    document.getElementById("restart").addEventListener("click", reset);
    reset();
    requestAnimationFrame(step);
  </script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

async function upgrade(args: ParsedArgs): Promise<void> {
  const goal = flag(args, "goal") ?? (args.rest.join(" ") || "Improve the target project safely. Pick one small high-value improvement, implement it, add or update focused tests, and run verification.");
  await runGoal({ ...args, command: "run", flags: withFlag(args.flags, "goal", goal), rest: [] }, false);
}

async function runGoal(args: ParsedArgs, dryRunDefault: boolean, defaultPlan?: string): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const goal = flag(args, "goal") ?? (args.rest.join(" ") || (dryRunDefault ? "dry-run sample self-upgrade" : "run Crix goal"));
  const planFile = flag(args, "plan") ?? defaultPlan;
  const dryRun = dryRunDefault || has(args, "dry-run");
  const mode = (flag(args, "mode") ?? "workspace-write") as PermissionMode;
  const provider = planFile ? undefined : await providerFromArgs(args);
  try {
    const kernel = await CrixKernel.create({ workspace, permissionMode: mode, provider });
    const proof = await kernel.runGoal({ goal, dryRun, planFile, verification: parseVerifyFlags(args), interventions: args.flags.get("intervention") });
    printProof(proof);
  } catch (error) {
    throw new Error(formatCliError(error));
  }
}

async function writePlan(args: ParsedArgs): Promise<void> {
  const out = flag(args, "out") ?? "crix-plan.json";
  const goal = flag(args, "goal") ?? (args.rest.join(" ") || "Improve the target project");
  const plan: UpgradePlan = {
    goal,
    summary: "Fill this plan with model-generated scoped steps. Crix will checkpoint, apply, verify, and write proof.",
    steps: [],
    verification: parseVerifyFlags(args),
  };
  await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  console.log(`plan written: ${out}`);
}

async function verify(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const command = commandFromParts(args.rest.length > 0 ? args.rest : ["pnpm", "test"]);
  const report = await new ShellExecutor(workspace).verify(command);
  console.log(`${report.command}: ${report.ok ? "passed" : "failed"}`);
  if (report.blockedReason) console.log(`blocked: ${report.blockedReason}`);
  if (report.stdoutTail.trim()) console.log(report.stdoutTail.trimEnd());
  if (report.stderrTail.trim()) console.error(report.stderrTail.trimEnd());
  if (!report.ok) process.exitCode = 1;
}

async function sessions(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const action = args.rest[0] ?? "list";
  if (action === "agent" || action === "agent-show" || action === "agent-history") {
    await showAgentSession(workspace, args.rest[1] ?? flag(args, "id") ?? "latest", action === "agent-history" || has(args, "history"));
    return;
  }
  if (action === "list") {
    const limit = positiveInteger(flag(args, "limit") ?? args.rest[1], 20);
    const rows = await EventStore.listSessions(workspace, limit);
    if (rows.length === 0) {
      console.log("sessions: none");
      return;
    }
    console.log(`sessions: ${rows.length}`);
    for (const row of rows) {
      const status = row.status ?? "open";
      const goal = row.goal ?? "(no goal recorded)";
      const updated = row.updatedAt ? row.updatedAt.replace(/\.\d{3}Z$/, "Z") : "unknown time";
      console.log(`- ${row.sessionId} [${status}] ${updated}`);
      console.log(`  goal: ${goal}`);
      console.log(`  events: ${row.eventCount}`);
      if (row.summary) console.log(`  summary: ${row.summary}`);
    }
    return;
  }
  if (["show", "read", "history"].includes(action)) {
    const requested = flag(args, "id") ?? args.rest[1] ?? "latest";
    const sessionId = requested === "latest" ? (await EventStore.listSessions(workspace, 1))[0]?.sessionId : requested;
    if (!sessionId) {
      console.log("sessions: none");
      return;
    }
    const includeHistory = action === "history" || has(args, "history");
    const read = includeHistory ? await EventStore.readThreadHistory(workspace, sessionId) : await EventStore.readSession(workspace, sessionId);
    console.log(`session: ${read.summary.sessionId}`);
    console.log(`status: ${read.summary.status ?? "open"}`);
    console.log(`goal: ${read.summary.goal ?? "(no goal recorded)"}`);
    console.log(`events: ${read.summary.eventCount}`);
    console.log(`proof: ${read.proof ? read.summary.proofPath : "(not written)"}`);
    if (read.proof?.turnId) console.log(`turn: ${read.proof.turnId}`);
    if (read.proof?.turnArtifactPath) console.log(`turn artifact: ${read.proof.turnArtifactPath}`);
    if (read.compact) console.log(`compact: ${EventStore.forSession(workspace, sessionId).compactPath()}`);
    if (includeHistory) {
      const history = await EventStore.readThreadHistory(workspace, sessionId);
      console.log(`rehydrated turns: ${history.turns.length}`);
      console.log(`rehydrated messages: ${history.messages.length}`);
    }
    if (read.summary.summary) console.log(`summary: ${read.summary.summary}`);
    const limit = positiveInteger(flag(args, "events"), 12);
    if (includeHistory) {
      const history = await EventStore.readThreadHistory(workspace, sessionId);
      const timeline = history.timeline.slice(-limit);
      if (timeline.length > 0) {
        console.log("");
        console.log(`last timeline: ${timeline.length}`);
        for (const item of timeline) {
          const when = item.createdAt.replace(/\.\d{3}Z$/, "Z");
          console.log(`- ${when} ${item.source}/${item.kind}: ${shorten(item.title, 180)}`);
          if (item.summary) console.log(`  summary: ${shorten(item.summary, 180)}`);
        }
      }
      return;
    }
    const events = read.events.slice(-limit);
    if (events.length > 0) {
      console.log("");
      console.log(`last events: ${events.length}`);
      for (const event of events) {
        const when = event.createdAt.replace(/\.\d{3}Z$/, "Z");
        console.log(`- ${when} ${event.kind}: ${event.message}`);
      }
    }
    return;
  }
  if (action === "compact") {
    const requested = flag(args, "id") ?? args.rest[1] ?? "latest";
    const sessionId = requested === "latest" ? (await EventStore.listSessions(workspace, 1))[0]?.sessionId : requested;
    if (!sessionId) {
      console.log("sessions: none");
      return;
    }
    const compact = await EventStore.compactSession(workspace, sessionId);
    console.log(`compact: ${EventStore.forSession(workspace, sessionId).compactPath()}`);
    console.log(`session: ${compact.sessionId}`);
    console.log(`events: ${compact.eventCount}`);
    console.log(`turns: ${compact.turnCount ?? 0}`);
    console.log(`messages: ${compact.messageCount ?? 0}`);
    if (compact.status) console.log(`status: ${compact.status}`);
    if (compact.turnId) console.log(`turn: ${compact.turnId}`);
    return;
  }
  if (action === "fork") {
    const requested = flag(args, "id") ?? args.rest[1] ?? "latest";
    const sessionId = requested === "latest" ? (await EventStore.listSessions(workspace, 1))[0]?.sessionId : requested;
    if (!sessionId) {
      console.log("sessions: none");
      return;
    }
    const fork = await EventStore.forkSession(workspace, sessionId);
    console.log(`forked: ${fork.sourceSessionId} -> ${fork.sessionId}`);
    console.log(`session dir: ${fork.sessionDir}`);
    return;
  }
  if (action === "resume") {
    const requested = flag(args, "id") ?? args.rest[1] ?? "latest";
    const sessionId = requested === "latest" ? (await EventStore.listSessions(workspace, 1))[0]?.sessionId : requested;
    if (!sessionId) {
      console.log("sessions: none");
      return;
    }
    const history = await EventStore.readThreadHistory(workspace, sessionId);
    await EventStore.resume(workspace, sessionId);
    console.log(`resumed: ${sessionId}`);
    console.log(`rehydrated turns: ${history.turns.length}`);
    console.log(`rehydrated messages: ${history.messages.length}`);
    if (history.messages.at(-1)) console.log(`last message: ${shorten(history.messages.at(-1)!.content, 180)}`);
    return;
  }
  throw new Error("sessions commands: list, show [session-id|latest], history [session-id|latest], compact [session-id|latest], fork [session-id|latest], resume [session-id|latest]");
}

async function showAgentSession(workspace: string, requested: string, includeHistory: boolean): Promise<void> {
  const state = await readAgentSessionState(workspace, requested);
  if (!state) {
    console.log("agent sessions: none");
    return;
  }
  console.log(`agent session: ${state.id}`);
  console.log(`provider: ${state.provider}${state.model ? `:${state.model}` : ""}`);
  console.log(`workspace: ${state.workspace}`);
  console.log(`permission: ${state.permissionMode}`);
  console.log(`grants: ${state.grants.length}`);
  for (const grant of state.grants) {
    console.log(`- ${grant.read ? "read" : ""}${grant.write ? "+write" : ""} ${grant.root} (${grant.source})`);
  }
  console.log(`messages: ${state.messages.length}`);
  console.log(`queued: ${state.queuedMessages.length}`);
  console.log(`turns: ${state.turnIds.length}`);
  console.log(`tool uses: ${state.toolUseCount}`);
  if (state.finalAnswer) console.log(`final: ${shorten(state.finalAnswer, 220)}`);
  if (!includeHistory) return;
  const messages = state.messages.slice(-12);
  if (messages.length === 0) return;
  console.log("");
  console.log(`last messages: ${messages.length}`);
  for (const message of messages) {
    const name = message.name ? `(${message.name})` : "";
    console.log(`- ${message.role}${name}: ${shorten(message.content.replace(/\s+/g, " "), 180)}`);
  }
}

async function readAgentSessionState(workspace: string, requested: string): Promise<AgentSessionState | undefined> {
  const file = requested === "latest" ? "latest.json" : `${safeAgentSessionId(requested)}.json`;
  const full = path.join(workspace, ".crix", "artifacts", "agent-sessions", file);
  try {
    return JSON.parse(await readFile(full, "utf8")) as AgentSessionState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function safeAgentSessionId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`invalid agent session id: ${value}`);
  return value;
}

async function turns(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const action = args.rest[0] ?? "list";
  if (action === "list") {
    const limit = positiveInteger(flag(args, "limit") ?? args.rest[1], 20);
    const rows = await TurnRecorder.listArtifacts(workspace, limit);
    if (rows.length === 0) {
      console.log("turns: none");
      return;
    }
    console.log(`turns: ${rows.length}`);
    for (const row of rows) {
      const updated = row.updatedAt.replace(/\.\d{3}Z$/, "Z");
      console.log(`- ${row.turnId} [${row.status}] ${updated}`);
      console.log(`  source: ${row.source ?? "unknown"}`);
      console.log(`  items: ${row.itemCount}`);
      console.log(`  artifact: ${row.artifactPath}`);
    }
    return;
  }
  if (["show", "read"].includes(action)) {
    const requested = flag(args, "id") ?? args.rest[1] ?? "latest";
    const turnId = requested === "latest" ? (await TurnRecorder.listArtifacts(workspace, 1))[0]?.turnId : requested;
    if (!turnId) {
      console.log("turns: none");
      return;
    }
    const turn = await TurnRecorder.readArtifact(workspace, turnId);
    console.log(`turn: ${turn.id}`);
    console.log(`status: ${turn.status}`);
    console.log(`items: ${turn.items.length}`);
    if (turn.metadata?.source) console.log(`source: ${turn.metadata.source}`);
    const limit = positiveInteger(flag(args, "items"), 12);
    const items = turn.items.slice(-limit);
    if (items.length > 0) {
      console.log("");
      console.log(`last items: ${items.length}`);
      for (const item of items) {
        const when = item.updatedAt.replace(/\.\d{3}Z$/, "Z");
        console.log(`- ${when} ${item.kind} ${item.status}: ${item.title}`);
        if (item.summary) console.log(`  summary: ${shorten(item.summary, 180)}`);
        if (item.error) console.log(`  error: ${shorten(item.error, 180)}`);
      }
    }
    return;
  }
  throw new Error("turns commands: list, show [turn-id|latest]");
}

async function memory(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const store = new MemoryStore(workspace);
  const action = args.rest[0] ?? "search";
  if (action === "add") {
    const text = args.rest.slice(1).join(" ");
    if (!text) throw new Error("memory add needs text");
    const memory = await store.remember(text, args.flags.get("tag") ?? []);
    console.log(`remembered: ${memory.id}`);
    return;
  }
  const query = args.rest.slice(action === "search" ? 1 : 0).join(" ");
  const hits = await store.search(query || "crix");
  for (const hit of hits) console.log(`- ${hit.text} [${hit.tags.join(", ")}]`);
}

async function auth(args: ParsedArgs): Promise<void> {
  const store = new OpenAIAuthStore();
  const action = args.rest[0] ?? "status";
  switch (action) {
    case "status": {
      const status = await store.status();
      console.log(`openai-auth: ${status.configured ? "configured" : "not configured"}`);
      console.log(`source: ${status.source}`);
      console.log(`mode: ${status.mode}`);
      console.log(`auth-file: ${status.authPath}`);
      if (status.email) console.log(`email: ${status.email}`);
      if (status.planType) console.log(`plan: ${status.planType}`);
      if (status.accountId) console.log(`account: ${status.accountId}`);
      if (status.tokenPreview) console.log(`token: ${status.tokenPreview}`);
      return;
    }
    case "login": {
      const status = await store.status();
      if (status.configured && !has(args, "force")) {
        console.log(`openai-auth: already configured (${status.mode}; ${status.source})`);
        if (status.email) console.log(`email: ${status.email}`);
        console.log("Use `login --force` to replace the saved auth.");
        return;
      }
      console.log("Starting OpenAI ChatGPT device-code login.");
      console.log("Crix will store tokens outside the repo under your user .crix directory.");
      const auth = await store.loginWithDeviceCode({
        maxWaitMs: Number(flag(args, "timeout-ms") ?? 15 * 60 * 1000),
        onDeviceCode: (code) => {
          console.log("");
          console.log("Open this URL in your browser:");
          console.log(`  ${code.verificationUrl}`);
          console.log("Enter this one-time code:");
          console.log(`  ${code.userCode}`);
          console.log("");
          console.log("Never paste this code into a chat or share it with another person.");
          openBrowser(code.verificationUrl);
        },
      });
      console.log(`openai-auth: logged in${auth.profile.email ? ` as ${auth.profile.email}` : ""}`);
      return;
    }
    case "logout": {
      const removed = await store.logout();
      console.log(removed ? "openai-auth: removed local Crix auth file" : "openai-auth: no local auth file found");
      return;
    }
    default:
      throw new Error("auth commands: status, login, logout");
  }
}

async function ollama(args: ParsedArgs): Promise<void> {
  const store = new OllamaCloudAuthStore();
  const action = args.rest[0] ?? "status";
  switch (action) {
    case "status": {
      const status = await store.status();
      console.log("ollama: configured for local-first use");
      console.log(`source: ${status.source}`);
      console.log(`host: ${status.host}`);
      console.log(`model: ${status.model}`);
      console.log(`settings-file: ${status.authPath}`);
      if (status.tokenPreview) console.log(`token: ${status.tokenPreview}`);
      return;
    }
    case "host": {
      const host = flag(args, "host") ?? args.rest[1];
      if (!host) throw new Error("ollama host needs a URL, for example: ollama host http://127.0.0.1:11434");
      await store.saveHost(host);
      console.log(`ollama host: ${host}`);
      return;
    }
    case "login": {
      console.log("ollama: no Crix login is needed.");
      console.log("Crix talks to your local Ollama app/server at 127.0.0.1:11434.");
      return;
    }
    case "use": {
      const model = flag(args, "model") ?? args.rest[1];
      if (!model) throw new Error("ollama use needs a model, for example: qwen3-coder.");
      await store.saveModel(model);
      console.log(`ollama model: ${resolveOllamaModel(model)}`);
      return;
    }
    case "models": {
      console.log("Ollama local-first model suggestions:");
      for (const model of OLLAMA_PICKER_MODELS) console.log(`- ${model}`);
      if (process.env.CRIX_SHOW_OLLAMA_CLOUD_MODELS !== "1") {
        console.log("");
        console.log("Cloud aliases are hidden by default. Set CRIX_SHOW_OLLAMA_CLOUD_MODELS=1 if your local Ollama setup supports them.");
      }
      console.log("");
      console.log("Installed local models come from: ollama list");
      return;
    }
    case "list": {
      const models = await new OllamaCloudClient().listModels();
      console.log(models.join("\n") || "no models returned by local Ollama");
      return;
    }
    case "ask": {
      const maybeModel = args.rest[1];
      const model = flag(args, "model") ?? (modelIsOllama(maybeModel) ? maybeModel : undefined);
      const textStart = model && maybeModel === model ? 2 : 1;
      const text = args.rest.slice(textStart).join(" ") || flag(args, "prompt");
      if (!text?.trim()) throw new Error('ollama ask needs text, for example: ollama ask deepseek "hello"');
      const response = await recordProviderTextTurn({
        source: "ollama-ask",
        title: "ollama ask",
        text,
        metadata: { provider: "ollama", model: model ?? "auto" },
        run: () => new OllamaCloudClient({ model }).completeText(text),
      });
      console.log(response);
      return;
    }
    case "logout": {
      const removed = await store.logout();
      console.log(removed ? "ollama: removed local Crix Ollama settings" : "ollama: no local Crix Ollama settings found");
      return;
    }
    default:
      throw new Error("ollama commands: status, host, use, models, list, ask, login, logout");
  }
}

async function ask(args: ParsedArgs): Promise<void> {
  const text = flag(args, "prompt") ?? args.rest.join(" ");
  if (!text.trim()) throw new Error('ask needs text, for example: crix ask "what should we build next?"');
  const provider = (flag(args, "provider") ?? "").toLowerCase();
  const model = flag(args, "model");
  if (provider === "ollama" || modelIsOllama(model)) {
    const response = await recordProviderTextTurn({
      source: "ask",
      title: "ollama ask",
      text,
      metadata: { provider: "ollama", model: model ?? "auto" },
      run: () => new OllamaCloudClient({ model }).completeText(text),
    });
    console.log(response);
    return;
  }
  if (await hasUsableOpenAIAuth()) {
    const response = await recordProviderTextTurn({
      source: "ask",
      title: "openai ask",
      text,
      metadata: { provider: "openai", model: model ?? "auto" },
      run: () => completeOpenAIChat(text),
    });
    console.log(response);
    return;
  }
  if (await hasUsableOllamaCloudAuth()) {
    const response = await recordProviderTextTurn({
      source: "ask",
      title: "ollama ask",
      text,
      metadata: { provider: "ollama", model: model ?? "auto" },
      run: () => new OllamaCloudClient({ model }).completeText(text),
    });
    console.log(response);
    return;
  }
  await recordProviderTextTurn({
    source: "ask",
    title: "provider unavailable",
    text,
    metadata: { provider: provider || "auto", model: model ?? "auto" },
    run: () => {
      throw new Error("No model provider responded. Type `login` for OpenAI or start local Ollama on 127.0.0.1:11434.");
    },
  });
}

async function recordProviderTextTurn(input: {
  source: string;
  title: string;
  text: string;
  metadata: JsonRecord;
  run: () => Promise<string> | string;
}): Promise<string> {
  const turn = new TurnRecorder({ metadata: { source: input.source, ...input.metadata } });
  const item = turn.startItem({
    kind: "assistant_message",
    title: input.title,
    input: { text: input.text },
    metadata: input.metadata,
  });
  try {
    const response = await input.run();
    turn.completeItem(item.id, {
      summary: shorten(response, 240),
      output: response,
      metadata: input.metadata,
    });
    return response;
  } catch (error) {
    turn.failItem(item.id, formatCliError(error), input.metadata);
    throw error;
  } finally {
    await turn.writeArtifact(process.cwd());
  }
}

async function prompt(args: ParsedArgs): Promise<void> {
  const goal = flag(args, "goal") ?? args.rest.join(" ");
  const mode = (flag(args, "mode") ?? "plan") as "chat" | "plan" | "subagent";
  const text = buildSystemPrompt({ tools: defaultTools(), agents: defaultAgents(), mode, goal: goal || undefined });
  if (has(args, "summary")) {
    console.log("Crix prompt pack:");
    console.log("- layered original behavior prompt");
    console.log("- includes tool catalog, skill processes, subagents, safety, memory, and proof rules");
    console.log(`- chars: ${text.length}`);
    console.log(`- tools: ${CRIX_TOOL_CATALOG.length}`);
    console.log(`- skill-processes: ${CRIX_SKILL_PROCESSES.length}`);
    return;
  }
  console.log(text);
}

async function tools(args: ParsedArgs): Promise<void> {
  const status = flag(args, "status");
  const category = flag(args, "category");
  const rows = CRIX_TOOL_CATALOG.filter((toolDef) => (!status || toolDef.status === status) && (!category || toolDef.category === category));
  if (has(args, "backlog")) {
    console.log("all catalog tools are runtime-backed; no placeholder backlog remains");
    return;
  }
  console.log(toolCatalogSummary(rows));
  console.log("");
  console.log(`tools: ${rows.length}`);
  console.log("Run one with: tool run read_file --path README.md");
}

async function tool(args: ParsedArgs): Promise<void> {
  const action = args.rest[0] ?? "list";
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const runtime = await ToolRuntime.create(workspace, {
    permissionMode: (flag(args, "mode") ?? "workspace-write") as PermissionMode,
    allowExternal: has(args, "allow-external"),
    allowDestructive: has(args, "allow-destructive"),
    provider: await explicitProviderFromArgs(args),
    permissionPrompt: permissionPromptFromArgs(args),
  });
  if (action === "list") {
    console.log(toolCatalogSummary(runtime.listTools()));
    return;
  }
  if (action !== "run") throw new Error("tool commands: list, run <name> --path README.md or --json <object>");
  const name = args.rest[1];
  if (!name) throw new Error("tool run needs a tool name");
  const inputValue = parseToolInput(args);
  if (!isJsonRecord(inputValue)) throw new Error("--json must be a JSON object");
  const result = await runtime.execute(name, inputValue);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function permissionPromptFromArgs(args: ParsedArgs): ToolPermissionPrompt | undefined {
  if (has(args, "yes") || has(args, "approve")) return async (request) => {
    console.log(`permission approved: ${request.toolName} (${request.safety})`);
    return "allow-session";
  };
  return interactivePermissionPrompt();
}

function interactivePermissionPrompt(): ToolPermissionPrompt | undefined {
  if (!input.isTTY || !output.isTTY) return undefined;
  return async (request) => {
    console.log("");
    console.log("Permission request");
    console.log(`  tool      ${request.toolName}`);
    console.log(`  safety    ${request.safety}`);
    console.log(`  workspace ${request.workspace}`);
    console.log(`  reason    ${request.reason}`);
    console.log(`  input     ${shorten(JSON.stringify(request.input), 220)}`);
    const rl = createInterface({ input, output });
    try {
      const answer = (await rl.question("Approve this tool call? [o]nce / [s]ession / [N]o ")).trim().toLowerCase();
      return parsePermissionDecision(answer);
    } finally {
      rl.close();
    }
  };
}

function parsePermissionDecision(answer: string): PermissionPromptDecision {
  if (["o", "once", "y", "yes"].includes(answer)) return "allow-once";
  if (["s", "session", "always"].includes(answer)) return "allow-session";
  return "deny";
}

async function skills(args: ParsedArgs): Promise<void> {
  const id = args.rest[0] ?? flag(args, "id");
  const rows = id ? CRIX_SKILL_PROCESSES.filter((process) => process.id === id) : CRIX_SKILL_PROCESSES;
  if (rows.length === 0) throw new Error(`unknown skill process ${id}`);
  for (const process of rows) {
    console.log(`${process.id}: ${process.title}`);
    console.log(`goal: ${process.goal}`);
    console.log(`triggers: ${process.triggers.join(", ")}`);
    console.log(`builds: ${process.buildsTools.join(", ") || "none"}`);
    if (has(args, "full") || id) {
      console.log("steps:");
      for (const step of process.steps) console.log(`- ${step}`);
      console.log(`proof: ${process.proof.join(", ")}`);
      console.log(`references: ${process.references.join(", ")}`);
    }
    console.log("");
  }
}

async function plugins(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const action = args.rest[0] ?? "list";
  const marketplace = new PluginMarketplace({ workspace });
  if (action === "mcp") {
    const servers = await marketplace.mcpServerConfigs();
    console.log(`mcp servers: ${servers.length}`);
    for (const server of servers) {
      console.log(`- ${server.name} (${server.pluginId})`);
      console.log(`  root: ${server.root}`);
      if (server.command) console.log(`  command: ${[server.command, ...(server.args ?? [])].join(" ")}`);
      if (server.url) console.log(`  url: ${server.url}`);
    }
    return;
  }
  if (!["list", "show"].includes(action)) throw new Error("plugins commands: list, show <id>, mcp");
  const rows = await marketplace.list();
  if (action === "list") {
    console.log(`plugins: ${rows.length}`);
    for (const plugin of rows) {
      console.log(`- ${plugin.id} ${plugin.enabled ? "[enabled]" : "[disabled]"} ${plugin.version ?? ""}`.trimEnd());
      console.log(`  source: ${plugin.source}`);
      if (plugin.description) console.log(`  ${plugin.description}`);
      if (plugin.mcpServers.length) console.log(`  mcp: ${plugin.mcpServers.join(", ")}`);
      if (plugin.skills.length) console.log(`  skills: ${plugin.skills.join(", ")}`);
      if (plugin.tools.length) console.log(`  tools: ${plugin.tools.join(", ")}`);
    }
    return;
  }
  const id = args.rest[1] ?? flag(args, "id");
  if (!id) throw new Error("plugins show needs a plugin id");
  const plugin = rows.find((candidate) => candidate.id === id);
  if (!plugin) throw new Error(`unknown plugin ${id}`);
  console.log(`plugin: ${plugin.id}`);
  console.log(`name: ${plugin.name}`);
  console.log(`enabled: ${plugin.enabled}`);
  console.log(`source: ${plugin.source}`);
  console.log(`root: ${plugin.root}`);
  if (plugin.version) console.log(`version: ${plugin.version}`);
  if (plugin.description) console.log(`description: ${plugin.description}`);
  if (plugin.mcpServers.length) console.log(`mcp: ${plugin.mcpServers.join(", ")}`);
  if (plugin.skills.length) console.log(`skills: ${plugin.skills.join(", ")}`);
  if (plugin.tools.length) console.log(`tools: ${plugin.tools.join(", ")}`);
}

async function inspect(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  console.log(`workspace: ${workspace}`);
  console.log(`sessions: ${path.join(workspace, ".crix", "sessions")}`);
  console.log(`memory: ${path.join(workspace, ".crix", "memory", "memory.jsonl")}`);
}

async function rollback(args: ParsedArgs): Promise<void> {
  const checkpoint = flag(args, "checkpoint") ?? args.rest[0];
  if (!checkpoint) throw new Error("rollback needs --checkpoint <path>");
  await ReversibleEditor.rollback(path.resolve(checkpoint));
  console.log(`rolled back: ${checkpoint}`);
}

async function javaProbe(args: ParsedArgs): Promise<void> {
  const workspace = path.resolve(flag(args, "workspace") ?? ".");
  const result = await new JavaBridge(workspace).probe();
  console.log(result.available ? "java worker: available" : "java worker: unavailable");
  console.log(result.raw ?? result.message);
}

async function doctor(args: ParsedArgs): Promise<void> {
  await inspect(args);
  await javaProbe(args);
  const openai = await new OpenAIAuthStore().status();
  const ollamaStatus = await new OllamaCloudAuthStore().status();
  console.log(`provider-openai: ${openai.configured ? `ready (${openai.mode}; ${openai.source})` : "not configured; type login"}`);
  console.log(`provider-ollama: ready (${ollamaStatus.model}; ${ollamaStatus.host}; ${ollamaStatus.source})`);
}

async function providerFromArgs(args: ParsedArgs): Promise<ModelProvider | undefined> {
  const provider = (flag(args, "provider") ?? process.env.CRIX_PROVIDER ?? "").toLowerCase();
  const model = flag(args, "model");
  if (["ollama", "ollama-cloud"].includes(provider) || modelIsOllama(model)) return new OllamaCloudProvider(new OllamaCloudClient({ model }));
  if (["openai", "gpt", "oauth", "openai-oauth"].includes(provider)) return new OpenAIOAuthProvider(new OpenAIResponsesClient({ model }));
  if (provider === "mock") return undefined;
  if (await hasUsableOpenAIAuth()) return new OpenAIOAuthProvider(new OpenAIResponsesClient({ model }));
  if (await hasUsableOllamaCloudAuth()) return new OllamaCloudProvider(new OllamaCloudClient({ model }));
  return undefined;
}

async function providerFromSession(session?: InteractiveSession): Promise<ModelProvider | undefined> {
  if (!session) return undefined;
  if (session.provider === "openai") return new OpenAIOAuthProvider(new OpenAIResponsesClient({ model: session.model }));
  if (session.provider === "ollama") return new OllamaCloudProvider(new OllamaCloudClient({ model: session.model }));
  if (await hasUsableOpenAIAuth()) return new OpenAIOAuthProvider(new OpenAIResponsesClient({ model: session.model }));
  if (await hasUsableOllamaCloudAuth()) return new OllamaCloudProvider(new OllamaCloudClient({ model: session.model }));
  return undefined;
}

function explicitProviderFromArgs(args: ParsedArgs): ModelProvider | undefined {
  const provider = (flag(args, "provider") ?? "").toLowerCase();
  const model = flag(args, "model");
  if (["ollama", "ollama-cloud"].includes(provider) || modelIsOllama(model)) return new OllamaCloudProvider(new OllamaCloudClient({ model }));
  if (["openai", "gpt", "oauth", "openai-oauth"].includes(provider)) return new OpenAIOAuthProvider(new OpenAIResponsesClient({ model }));
  return undefined;
}

function parseVerifyFlags(args: ParsedArgs): VerificationCommand[] {
  return (args.flags.get("verify") ?? []).map((value) => commandFromParts(value.split(/\s+/g).filter(Boolean)));
}

function commandFromParts(parts: string[]): VerificationCommand {
  const [program, ...cmdArgs] = parts;
  if (!program) throw new Error("empty command");
  return { program, args: cmdArgs, timeoutMs: 120_000 };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function withFlag(flags: Map<string, string[]>, name: string, value: string): Map<string, string[]> {
  const next = new Map(flags);
  next.set(name, [value]);
  return next;
}

function escapeForDisplay(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function modelIsOllama(model?: string): boolean {
  if (!model) return false;
  const value = model.toLowerCase();
  return (
    OLLAMA_LOCAL_MODELS.includes(value)
    || value.endsWith(":cloud")
  );
}

function isOllamaPickerModel(model?: string): boolean {
  if (!model) return false;
  return (OLLAMA_PICKER_MODELS as readonly string[]).includes(model.toLowerCase());
}

function isOpenAIModel(model?: string): boolean {
  if (!model) return false;
  return OPENAI_CHAT_MODELS.includes(model.toLowerCase());
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInput(args: ParsedArgs): unknown {
  const explicitJson = flag(args, "json");
  if (explicitJson) return JSON.parse(explicitJson);
  const input: JsonRecord = {};
  for (const [key, values] of args.flags.entries()) {
    if (["workspace", "mode", "allow-external", "allow-destructive"].includes(key)) continue;
    input[key] = values.length === 1 ? coerceFlagValue(values[0]!) : values.map(coerceFlagValue);
  }
  const positional = args.rest.slice(2);
  if (positional.length === 1 && !input.path && !input.query && !input.url) {
    input.path = positional[0]!;
  }
  return input;
}

function coerceFlagValue(value: string): JsonRecord[string] {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    try {
      return JSON.parse(value) as JsonRecord[string];
    } catch {
      return value;
    }
  }
  return value;
}

async function promptSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("api.responses.write")) {
    return [
      "That token hit the OpenAI Platform endpoint without API scopes.",
      "Crix now routes ChatGPT OAuth through the Codex backend automatically.",
      "Try again. If it still fails: type `logout`, then `login`.",
    ].join("\n");
  }
  return message;
}

function openBrowser(url: string): void {
  try {
    const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The URL is still printed when launching a browser is unavailable.
  }
}

function printInteractiveHeader(session: InteractiveSession): void {
  tui.shellHeader({
    title: "CRIX agent",
    provider: session.provider,
    model: session.model,
    workspace: session.workspace,
    profile: "natural language, tool-first, evidence guarded",
    guidance: "type the task normally; say provider/model/status only when needed",
  });
}

function printChatLine(role: string, text: string): void {
  const width = Math.min(92, terminalWidth());
  const label = styleText(role.padEnd(12), role === "ok" ? "ok" : role === "failed" ? "bad" : role === "tool" ? "tool" : role === "openai" || role === "ollama" ? "agent" : "muted");
  for (const line of wrapDisplay(text, width - 16)) {
    console.log(`  ${label}${line}`);
  }
}

function printSection(title: string, detail = ""): void {
  const width = Math.min(92, terminalWidth());
  const heading = detail ? `${title} - ${detail}` : title;
  console.log("");
  console.log(`  ${styleText(fitDisplay(heading, width), "accent")}`);
  console.log(`  ${styleText("-".repeat(Math.min(width, Math.max(18, stripAnsi(heading).length))), "muted")}`);
}

function terminalWidth(): number {
  return Math.max(72, Math.min(120, output.columns || 88));
}

function wrapDisplay(value: string, width: number): string[] {
  const words = shorten(value, 900).split(/\s+/g).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fitDisplay(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 3))}...` : compact;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function styleText(value: string, tone: "brand" | "accent" | "muted" | "tool" | "agent" | "ok" | "bad"): string {
  if (!output.isTTY || process.env.NO_COLOR) return value;
  const codes = {
    brand: ["\x1b[1;38;5;81m", "\x1b[0m"],
    accent: ["\x1b[38;5;111m", "\x1b[0m"],
    muted: ["\x1b[2m", "\x1b[0m"],
    tool: ["\x1b[38;5;81m", "\x1b[0m"],
    agent: ["\x1b[38;5;214m", "\x1b[0m"],
    ok: ["\x1b[38;5;120m", "\x1b[0m"],
    bad: ["\x1b[38;5;203m", "\x1b[0m"],
  } as const;
  const [open, close] = codes[tone];
  return `${open}${value}${close}`;
}

function printProof(proof: Awaited<ReturnType<CrixKernel["runGoal"]>>): void {
  console.log(`status: ${proof.status}`);
  console.log(`session: ${proof.sessionId}`);
  if (proof.turnId) console.log(`turn: ${proof.turnId}`);
  console.log(`proof: ${proof.proofPath}`);
  if (proof.turnArtifactPath) console.log(`turn artifact: ${proof.turnArtifactPath}`);
  console.log(`applied: ${proof.appliedSteps.length}`);
  console.log(`denied: ${proof.deniedSteps.length}`);
  console.log(`agents: ${proof.agentReports.length}`);
  console.log(`verification: ${proof.verification.every((report) => report.ok)}`);
}

function printHelp(): void {
  console.log(`Crix TypeScript agent harness

Usage:
  cli                           Open the natural language agent shell
  login                         Sign in with ChatGPT OAuth
  ollama use qwen3-coder        Pick a local Ollama model
  ollama models                 Show local-first model suggestions
  ollama list                   List models from local Ollama API
  run --goal "fix bug in x"     Plan and execute a coding task with proof
  upgrade                       Alias of run with harness-improvement goal text
  ask "hello"                   Ask the active provider
  prompt --summary              Inspect Crix layered prompt pack
      sessions                      List recent Crix run sessions
      sessions show latest          Inspect latest run events and proof path
      sessions agent latest         Inspect latest durable agent loop state
      sessions history latest       Inspect rehydrated events, turn items, and messages
  sessions compact latest       Write a compact resume summary
  sessions fork latest          Fork a prior session directory
  turns                         List recent structured turn artifacts
  turns show latest             Inspect latest tool/agent turn items
      tools                         List functional Crix tool catalog
      tool run read_file --path README.md Run a Crix tool directly
      skills --full                 List Crix skill processes
      plugins                       List local plugin marketplace manifests
      plugins mcp                   List MCP servers declared by plugins
      test                          Run pnpm test
  status                        Show runtime/provider status
  provider openai               Switch active shell provider
  provider ollama               Use local Ollama
  model qwen3-coder             Switch active shell model
  agents                        Show available subagent roles
  agents notifications          Show durable subagent completion notifications
  agent researcher inspect repo Run one visible subagent
  tools run                     Execute a live read-only tool run
  inspect the tool runtime      Natural trigger for live tool calls
  inspect agent orchestration   Natural trigger for visible agent runs
  status                        Show active provider/auth state
  help                          Show this screen
  exit                          Close

Simple wrappers:
  .\\crix.bat
  .\\crix.bat dry
  .\\crix.bat apply
  .\\crix.bat test
`);
}

main().catch((error) => {
  console.error(formatCliError(error));
  process.exitCode = 1;
});

