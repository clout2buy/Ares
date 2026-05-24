import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentDefinition, AgentSessionState, AgentTurnEvent, ContextBundle, JsonRecord, Message, PermissionMode, ToolDefinition, ToolResult, ToolUseRequest, WorkspaceGrant } from "@crix/protocol";
import { ContextBuilder } from "./context.js";
import { evidenceFromToolResult, guardFinalAnswerClaims, type EvidenceEntry } from "./evidence.js";
import { MemoryStore } from "./memory.js";
import { defaultAgents, defaultTools, MockProvider, type ModelProvider } from "./provider.js";
import { runProviderToolLoop } from "./providerToolLoop.js";
import { resolveWorkspace } from "./paths.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { TurnEngine, TurnRecorder, type TurnEngineCall } from "./turnEngine.js";
import type { ToolPermissionPrompt } from "./toolRuntime.js";
import { extractLocalPath } from "./turnIntent.js";
import { id, nowIso, tail } from "./util.js";

export interface AgentRuntimeOptions {
  workspace: string;
  provider?: ModelProvider;
  model?: string;
  permissionMode?: PermissionMode;
  tools?: ToolDefinition[];
  agents?: AgentDefinition[];
  permissionPrompt?: ToolPermissionPrompt;
  grants?: WorkspaceGrant[];
}

export interface AgentSubmitOptions {
  maxRounds?: number;
  preflight?: boolean;
}

export interface AgentRuntimeResumeOptions extends Omit<AgentRuntimeOptions, "grants"> {
  sessionId?: string;
}

export class AgentRuntime {
  private readonly provider: ModelProvider;
  private readonly permissionMode: PermissionMode;
  private readonly tools: ToolDefinition[];
  private readonly agents: AgentDefinition[];
  private readonly permissionPrompt?: ToolPermissionPrompt;
  private state: AgentSessionState;
  private activeEngine?: TurnEngine;

  private constructor(
    workspace: string,
    options: Omit<AgentRuntimeOptions, "workspace">,
  ) {
    this.provider = options.provider ?? new MockProvider();
    this.permissionMode = options.permissionMode ?? "auto-safe";
    this.tools = options.tools ?? defaultTools();
    this.agents = options.agents ?? defaultAgents();
    this.permissionPrompt = options.permissionPrompt;
    const startupGrant = grant(workspace, true, this.permissionMode === "workspace-write" || this.permissionMode === "danger-full-access", "startup");
    const grants = mergeGrants([startupGrant, ...(options.grants ?? [])]);
    this.state = {
      id: id("agent_session"),
      workspace,
      provider: this.provider.kind,
      model: options.model,
      permissionMode: this.permissionMode,
      grants,
      messages: [],
      queuedMessages: [],
      turnIds: [],
      toolUseCount: 0,
      updatedAt: nowIso(),
    };
  }

  static async create(options: AgentRuntimeOptions): Promise<AgentRuntime> {
    return new AgentRuntime(await resolveWorkspace(options.workspace), options);
  }

  static async resume(options: AgentRuntimeResumeOptions): Promise<AgentRuntime> {
    const workspace = await resolveWorkspace(options.workspace);
    const state = await readAgentState(workspace, options.sessionId);
    const runtime = new AgentRuntime(state.workspace, { ...options, grants: state.grants });
    runtime.state = {
      ...state,
      provider: runtime.provider.kind,
      model: options.model ?? state.model,
      permissionMode: options.permissionMode ?? state.permissionMode,
      updatedAt: nowIso(),
    };
    return runtime;
  }

  get sessionState(): AgentSessionState {
    return cloneState(this.state);
  }

  queueIntervention(content: string, metadata: JsonRecord = {}): Message {
    const message: Message = {
      id: id("msg"),
      role: "user",
      content,
      createdAt: nowIso(),
      metadata: { intervention: true, ...metadata },
    };
    this.state.queuedMessages.push(message);
    this.state.updatedAt = message.createdAt;
    this.activeEngine?.queueIntervention(content, metadata);
    return { ...message, metadata: message.metadata ? { ...message.metadata } : undefined };
  }

  async *submit(input: string, options: AgentSubmitOptions = {}): AsyncGenerator<AgentTurnEvent, AgentSessionState, unknown> {
    const targetWorkspace = await this.resolveTargetWorkspace(input);
    if (targetWorkspace !== this.state.workspace) this.state.workspace = targetWorkspace;
    const explicitGrant = grant(targetWorkspace, true, false, targetWorkspace === this.state.workspace ? "explicit-path" : "session");
    this.addGrant(explicitGrant);

    const turn = new TurnRecorder({
      sessionId: this.state.id,
      metadata: {
        source: "agent-runtime",
        provider: this.provider.kind,
        model: this.state.model ?? "auto",
        grants: this.state.grants as unknown as JsonRecord[],
      },
    });
    this.state.turnIds.push(turn.turnId);
    const engine = await TurnEngine.create({
      workspace: targetWorkspace,
      permissionMode: this.permissionMode,
      provider: this.provider,
      agents: this.agents,
      permissionPrompt: this.permissionPrompt,
      workspaceGrants: this.state.grants,
      readPolicy: "explicit-path-broad",
      turn,
      metadata: { source: "agent-runtime", goal: input },
    });
    this.activeEngine = engine;
    let queuedInterventionCount = 0;
    const priorMessages = compactMessagesForTurn(this.state.messages);
    const userMessage: Message = { id: id("msg"), role: "user", content: input, createdAt: nowIso() };
    const messages: Message[] = [...priorMessages, userMessage];
    this.state.messages.push(userMessage);
    await this.writeState();
    yield { type: "session_started", state: this.sessionState };
    yield { type: "grant_added", grant: explicitGrant };

    const allowLocalTools = shouldAllowLocalTools(input);
    const preflight = options.preflight === false || !allowLocalTools || !shouldRunLocalPreflight(input)
      ? { events: [], messages: [], results: [], toolUseCount: 0 }
      : await this.runPreflight(input, engine);
    for (const event of preflight.events) yield event;
    messages.push(...preflight.messages);
    this.state.messages.push(...preflight.messages);

    const context = await new ContextBuilder(targetWorkspace, new MemoryStore(targetWorkspace)).build(input, messages);
    const providerEvents = new AsyncEventBuffer<AgentTurnEvent>();
    const toolRequests = new Map<TurnEngineCall, ToolUseRequest>();
    const providerEvidence: EvidenceEntry[] = [];
    let providerLoopError: unknown;
    const taskRequirement = taskToolRequirement(input, preflight.toolUseCount, allowLocalTools);
    const providerLoop = runProviderToolLoop({
      goal: input,
      systemPrompt: agentSystemPrompt(input, this.tools, this.agents),
      context: contextForAgent(context, input, targetWorkspace),
      tools: allowLocalTools ? this.tools : [],
      agents: this.agents,
      messages,
      provider: this.provider,
      engine,
      maxRounds: options.maxRounds ?? 6,
      mode: "chat",
      requireToolUse: taskRequirement.requireProviderToolUse,
      toolUseCorrection: taskRequirement.correction,
      drainQueuedMessages: () => {
        const drained = this.drainQueuedMessages();
        if (drained.length > 0) queuedInterventionCount += drained.length;
        return drained;
      },
      onEvent: async (event) => {
        if (event.type === "assistant") {
          const msg: Message = { id: id("msg"), role: "assistant", content: event.text, createdAt: nowIso(), metadata: { toolCallCount: event.toolCallCount } };
          this.state.messages.push(msg);
          if (event.toolCallCount > 0) providerEvents.push({ type: "assistant", text: event.text, toolCallCount: event.toolCallCount });
        } else if (event.type === "tool_start") {
          const request = toToolUseRequest(event.call);
          toolRequests.set(event.call, request);
          providerEvents.push({ type: "tool_start", call: request });
        } else if (event.type === "tool_result") {
          const request = toolRequests.get(event.call) ?? toToolUseRequest(event.call);
          providerEvidence.push(evidenceFromToolResult(event.call, event.result));
          providerEvents.push({ type: "tool_result", call: request, result: { ...event.result, requestId: request.id } });
        } else if (event.type === "intervention") {
          providerEvents.push({ type: "intervention", messages: event.messages });
        }
      },
    }).then((result) => {
      providerEvents.close();
      return result;
    }, (error: unknown) => {
      providerLoopError = error;
      providerEvents.fail(error);
      return undefined;
    });

    let result: Awaited<ReturnType<typeof runProviderToolLoop>> | undefined;
    try {
      for await (const event of providerEvents.drain()) yield event;
      result = await providerLoop;
    } finally {
      this.activeEngine = undefined;
    }
    if (!result) throw providerLoopError instanceof Error ? providerLoopError : new Error(String(providerLoopError ?? "provider tool loop failed"));

    for (const message of result.messages) {
      if (!this.state.messages.some((existing) => existing.id === message.id)) this.state.messages.push(message);
    }
    this.state.toolUseCount += preflight.toolUseCount + result.toolCallCount;
    const evidence = [...preflight.results.map((item) => evidenceFromToolResult(item.call, item.result)), ...providerEvidence];
    const assistantText = guardedFinalAnswer(result.response.text, preflight.results, input, targetWorkspace, this.provider.kind, evidence);
    const finalItem = turn.startItem({
      kind: "assistant_message",
      title: "final answer",
      input: { text: input },
      metadata: {
        finalAnswer: assistantText,
        toolUseCount: this.state.toolUseCount,
        grants: this.state.grants as unknown as JsonRecord[],
        queuedInterventions: queuedInterventionCount,
        verificationSummary: "",
      },
    });
    turn.completeItem(finalItem.id, { summary: tail(assistantText, 500), output: assistantText });
    this.state.finalAnswer = assistantText;
    this.state.updatedAt = nowIso();
    this.state.messages.push({ id: id("msg"), role: "assistant", content: assistantText, createdAt: nowIso(), metadata: { final: true } });
    const artifactPath = await turn.writeArtifact(targetWorkspace);
    await this.writeState();
    yield { type: "assistant", text: assistantText, toolCallCount: result.toolCallCount };
    yield { type: "final", text: assistantText, state: this.sessionState, turnArtifactPath: artifactPath };
    return this.sessionState;
  }

  private async resolveTargetWorkspace(input: string): Promise<string> {
    const localPath = extractLocalPath(input);
    if (!localPath) return this.state.workspace;
    const resolved = path.resolve(localPath);
    try {
      const info = await stat(resolved);
      return await resolveWorkspace(info.isDirectory() ? resolved : path.dirname(resolved));
    } catch {
      return this.state.workspace;
    }
  }

  private addGrant(next: WorkspaceGrant): void {
    this.state.grants = mergeGrants([...this.state.grants, next]);
    this.state.updatedAt = nowIso();
  }

  private async runPreflight(input: string, engine: TurnEngine): Promise<{ events: AgentTurnEvent[]; messages: Message[]; results: Array<{ call: TurnEngineCall; result: ToolResult }>; toolUseCount: number }> {
    const events: AgentTurnEvent[] = [];
    const messages: Message[] = [];
    const results: Array<{ call: TurnEngineCall; result: ToolResult }> = [];
    const run = async (call: TurnEngineCall): Promise<ToolResult> => {
      const request = toToolUseRequest(call);
      events.push({ type: "tool_start", call: request });
      const result = await engine.runCall(call);
      events.push({ type: "tool_result", call: request, result });
      results.push({ call, result });
      messages.push({ id: id("msg"), role: "tool", name: call.name, content: result.output, createdAt: nowIso(), metadata: { ok: result.ok, preflight: true } });
      return result;
    };

    const list = await run({ name: "list_dir", input: { path: ".", recursive: false } });
    const present = listedPaths(list);
    for (const file of prioritizedPreflightReads(present, this.state.workspace)) {
      await run({ name: "read_file", input: { path: file } });
    }
    if (present.has(".git")) {
      await run({ name: "git_status", input: {} });
      await run({ name: "git_diff", input: {} });
    }
    return { events, messages, results, toolUseCount: results.length };
  }

  private async writeState(): Promise<void> {
    const outDir = path.join(this.state.workspace, ".crix", "artifacts", "agent-sessions");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${this.state.id}.json`), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await writeFile(path.join(outDir, "latest.json"), `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  private drainQueuedMessages(): Message[] {
    const drained = this.state.queuedMessages.splice(0);
    if (drained.length === 0) return [];
    this.state.messages.push(...drained);
    this.activeEngine?.drainInterventions();
    this.state.updatedAt = nowIso();
    return drained;
  }
}

function agentSystemPrompt(goal: string, tools: ToolDefinition[], agents: AgentDefinition[]): string {
  return `${buildSystemPrompt({ tools, agents, mode: "chat", goal })}

Agent-first Crix runtime:
- You are inside a local coding agent with real tool results in the conversation.
- If the user asks about a local repo, folder, path, project, or codebase, inspect first and answer from evidence.
- Never say you lack filesystem access when tool results are present.
- If more context is needed, request tools with valid JSON toolCalls or inline tool_name({...}) syntax.
- Keep answers concise, grounded in files/tools, and state blockers only when a real tool result failed.`;
}

function contextForAgent(context: ContextBundle, goal: string, workspace: string): ContextBundle {
  return { ...context, goal, workspace };
}

function prioritizedPreflightReads(present: Set<string>, workspace: string): string[] {
  const candidates = [
    "README.md",
    "README.MD",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "crix.bat",
    "crix.ps1",
    "src/index.ts",
    "packages/core/src/index.ts",
    "packages/cli/src/index.ts",
  ];
  return candidates.filter((item) => present.has(item) || existsSync(path.join(workspace, item))).slice(0, 6);
}

function listedPaths(result: ToolResult): Set<string> {
  try {
    const parsed = JSON.parse(result.output) as Array<{ path?: unknown }>;
    return new Set(parsed.map((row) => typeof row.path === "string" ? row.path.replaceAll("\\", "/") : "").filter(Boolean));
  } catch {
    return new Set();
  }
}

function guardedFinalAnswer(text: string, results: Array<{ call: TurnEngineCall; result: ToolResult }>, goal: string, workspace: string, providerKind: string, evidence: EvidenceEntry[]): string {
  const inspected = results.filter((item) => item.result.ok);
  if (inspected.length === 0) {
    const trimmed = text.trim();
    return guardFinalAnswerClaims(trimmed || `No local tools were run for this turn.\nAsked: ${goal}`, evidence);
  }
  const weak = /don'?t have|do not have|no automatic opinion|with your permission|let me know|can't access|cannot access|unable to access/i.test(text);
  if (providerKind !== "mock" && text.trim() && inspected.length > 0 && !weak) return guardFinalAnswerClaims(text, evidence);
  const files = new Set<string>();
  let packageName = "";
  let readme = "";
  for (const { call, result } of inspected) {
    if (call.name !== "read_file") continue;
    try {
      const rows = JSON.parse(result.output) as Array<{ path?: string; content?: string }>;
      for (const row of rows) {
        if (row.path) files.add(row.path);
        if (row.path === "package.json" && row.content) {
          const pkg = JSON.parse(row.content) as { name?: string; packageManager?: string; scripts?: Record<string, string> };
          packageName = [pkg.name, pkg.packageManager ? `via ${pkg.packageManager}` : ""].filter(Boolean).join(" ");
        }
        if (/^readme/i.test(row.path ?? "") && row.content) readme = firstMarkdownHeading(row.content);
      }
    } catch {
      // Ignore malformed tool output and keep the evidence summary from other tools.
    }
  }
  const lines = [
    `I inspected ${workspace} with ${inspected.length} real tool call${inspected.length === 1 ? "" : "s"} before answering.`,
    packageName ? `Package: ${packageName}.` : "",
    readme ? `README: ${readme}.` : "",
    files.size ? `Key files read: ${Array.from(files).slice(0, 6).join(", ")}.` : "",
    `Asked: ${goal}`,
  ].filter(Boolean);
  return guardFinalAnswerClaims(lines.join("\n"), evidence);
}

function firstMarkdownHeading(content: string): string {
  return content.split(/\r?\n/g).find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim() || content.split(/\r?\n/g).find((line) => line.trim())?.trim().slice(0, 120) || "present";
}

function shouldRunLocalPreflight(input: string): boolean {
  const normalized = input.toLowerCase();
  if (!shouldAllowLocalTools(input)) return false;
  if (extractLocalPath(input)) return true;
  if (isHarnessSelfImprovementRequest(normalized)) return true;
  const asksForRepoContext = /\b(inspect|learn|scout|understand|review|look|check|audit|analy[sz]e|map|debug|diagnose|troubleshoot)\b/.test(normalized);
  const namesLocalTarget = /\b(this|current|active|the|my|our)\s+(repo|repository|codebase|workspace|project|folder|directory)\b/.test(normalized)
    || /\b(repo|repository|codebase|workspace|project|folder|directory)\b.*\b(here|current|active)\b/.test(normalized);
  return asksForRepoContext && namesLocalTarget;
}

function shouldAllowLocalTools(input: string): boolean {
  return !isConversationOnly(input) && !isCurrentExternalInfoQuestion(input);
}

function isConversationOnly(input: string): boolean {
  return isCasualLocalStatus(input) || isAgentBehaviorMetaQuestion(input) || isNoWorkPriorToolQuestion(input);
}

function isNoWorkPriorToolQuestion(input: string): boolean {
  const normalized = input.toLowerCase();
  const asksNoWork = /\b(don'?t|dont|do not)\b.*\b(work|run|execute|call|use|touch|inspect|read)\b/.test(normalized);
  const asksAboutPriorOutput = /\b(when i said|prior|previous|fake|real|instance response|output|tool output|tools? were)\b/.test(normalized);
  return asksNoWork && asksAboutPriorOutput;
}

function isAgentBehaviorMetaQuestion(input: string): boolean {
  const normalized = input.toLowerCase();
  const aboutAgent = /\b(u|you|your|ur|agent|crix|coding|code|prompt|instructions|behavior|tools?|scan|inspect)\b/.test(normalized);
  if (!aboutAgent) return false;
  return /\b(i never asked|never asked|why did (u|you)|why are (u|you)|what made (u|you)|makes (u|you) do|made (u|you) do|supposed to|is it something in (ur|your) (coding|code|prompt|instructions)|what caused (it|that)|trying to trouble\s*shoot|trouble\s*shoot)\b/.test(normalized);
}

function isHarnessSelfImprovementRequest(normalized: string): boolean {
  return /\b(make|fix|change|update|upgrade|improve|refactor|debug|diagnose|troubleshoot)\b/.test(normalized)
    && /\b(yourself|crix|harness|agent|runtime|tooling|tools?|coding-agent)\b/.test(normalized);
}

function taskToolRequirement(input: string, preflightToolUseCount: number, allowLocalTools = true): { requireProviderToolUse: boolean; correction?: string } {
  if (!allowLocalTools) return { requireProviderToolUse: false };
  const normalized = input.toLowerCase();
  const asksForArtifactOrEdit = /\b(make|create|build|write|generate|implement|add|fix|change|update|upgrade|refactor|scaffold|set up|setup)\b/.test(normalized)
    && /\b(file|html|app|application|website|site|webpage|page|game|notes?|todo|dashboard|script|feature|bug|issue|ui|code|repo|project)\b/.test(normalized);
  const asksForCurrentExternalInfo = isCurrentExternalInfoQuestion(input);
  if (asksForArtifactOrEdit) {
    return {
      requireProviderToolUse: true,
      correction: [
        "Crix harness correction: this is an implementation/artifact task.",
        "Before any final answer, request real Crix tool calls for the work: inspect as needed, then write_file/replace_text/multi_edit/apply_patch/create_dir, and run_verification or browser tools when relevant.",
        "Do not provide a canned artifact or claim completion without tool results.",
      ].join("\n"),
    };
  }
  if (asksForCurrentExternalInfo) {
    return {
      requireProviderToolUse: true,
      correction: [
        "Crix harness correction: this asks for current external information.",
        "Before answering, request web_search or web_fetch tool calls if those tools are available in this turn. If the tool is blocked, report that blocker instead of guessing.",
      ].join("\n"),
    };
  }
  return { requireProviderToolUse: preflightToolUseCount === 0 && /\b(repo|codebase|workspace|folder|file|inspect|read|audit|review|debug|diagnose)\b/.test(normalized) };
}

function isCasualLocalStatus(input: string): boolean {
  return /^(hi|hey|hello|yo|sup|how are you|hows it going|how's it going|oh|ok|okay|thanks|thank you|cool|nice)\b[.!?\s]*$/i.test(input.trim());
}

function isCurrentExternalInfoQuestion(input: string): boolean {
  const normalized = input.toLowerCase();
  return /\b(latest|today|current|right now|up to date|news|price|score|schedule|best|meta|tier list|recommend)\b/.test(normalized)
    && !extractLocalPath(input)
    && !/\b(repo|codebase|workspace|folder|file|local|this project|this code)\b/.test(normalized);
}

function toToolUseRequest(call: TurnEngineCall): ToolUseRequest {
  return { id: id("tool_req"), name: call.name, kind: call.kind ?? "tool", input: call.input };
}

function grant(root: string, read: boolean, write: boolean, source: WorkspaceGrant["source"]): WorkspaceGrant {
  return { root: path.resolve(root), read, write, source, createdAt: nowIso() };
}

function mergeGrants(grants: WorkspaceGrant[]): WorkspaceGrant[] {
  const byRoot = new Map<string, WorkspaceGrant>();
  for (const item of grants) {
    const root = path.resolve(item.root);
    const existing = byRoot.get(root);
    byRoot.set(root, existing ? { ...existing, read: existing.read || item.read, write: existing.write || item.write } : { ...item, root });
  }
  return [...byRoot.values()];
}

async function readAgentState(workspace: string, sessionId?: string): Promise<AgentSessionState> {
  const file = path.join(workspace, ".crix", "artifacts", "agent-sessions", sessionId ? `${sessionId}.json` : "latest.json");
  return JSON.parse(await readFile(file, "utf8")) as AgentSessionState;
}

function cloneState(state: AgentSessionState): AgentSessionState {
  return JSON.parse(JSON.stringify(state)) as AgentSessionState;
}

function compactMessagesForTurn(messages: Message[], maxMessages = 36, maxChars = 28_000): Message[] {
  const tailMessages = messages.slice(-maxMessages).map((message) => ({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined }));
  while (tailMessages.length > 8 && messageChars(tailMessages) > maxChars) tailMessages.shift();
  const omitted = messages.length - tailMessages.length;
  if (omitted <= 0) return tailMessages;
  return [
    {
      id: id("msg"),
      role: "system",
      content: `Compacted prior Crix session context: ${omitted} older message${omitted === 1 ? "" : "s"} omitted. Continue from the visible recent transcript and durable tool artifacts when needed.`,
      createdAt: nowIso(),
      metadata: { compacted: true, omittedMessages: omitted },
    },
    ...tailMessages,
  ];
}

function messageChars(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

class AsyncEventBuffer<T> {
  private readonly items: T[] = [];
  private waiter?: () => void;
  private closed = false;
  private failure?: unknown;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.closed = true;
    this.wake();
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }
}
