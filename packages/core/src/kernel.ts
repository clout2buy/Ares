import { mkdir, readFile } from "node:fs/promises";
import type { AgentRunResult, ExecutionReport, JsonRecord, Message, PermissionMode, PlanStep, ProofReport, SafetyClass, ToolResult, UpgradePlan, VerificationCommand } from "@crix/protocol";
import { parseUpgradePlan } from "@crix/protocol";
import { ContextBuilder } from "./context.js";
import { EventStore } from "./eventStore.js";
import { MemoryStore } from "./memory.js";
import { SafetyPolicy } from "./policy.js";
import { defaultAgents, defaultTools, type ModelProvider, MockProvider, PlanFileProvider } from "./provider.js";
import { runProviderToolLoop } from "./providerToolLoop.js";
import { ShellExecutor } from "./executor.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { TurnEngine, TurnRecorder, type TurnEngineCall } from "./turnEngine.js";
import { id, nowIso } from "./util.js";
import { resolveWorkspace } from "./paths.js";

export interface KernelOptions {
  workspace: string;
  provider?: ModelProvider;
  permissionMode?: PermissionMode;
}

export interface RunGoalOptions {
  goal: string;
  dryRun?: boolean;
  planFile?: string;
  verification?: VerificationCommand[];
  interventions?: string[];
  onEvent?: (event: RunGoalEvent) => void | Promise<void>;
}

export type RunGoalEvent =
  | { type: "preflight_tool_start"; call: TurnEngineCall }
  | { type: "preflight_tool_result"; call: TurnEngineCall; result: ToolResult }
  | { type: "plan_tool_start"; call: TurnEngineCall }
  | { type: "plan_tool_result"; call: TurnEngineCall; result: ToolResult }
  | { type: "plan_created"; plan: UpgradePlan }
  | { type: "step_start"; step: PlanStep; effectiveSafety: SafetyClass; allowed: boolean; reason: string }
  | { type: "apply_tool_start"; step: PlanStep; call: TurnEngineCall }
  | { type: "apply_tool_result"; step: PlanStep; call: TurnEngineCall; result: ToolResult; durationMs: number }
  | { type: "step_result"; step: PlanStep; message: string }
  | { type: "verification_start"; command: VerificationCommand }
  | { type: "verification_result"; command: VerificationCommand; report: ExecutionReport };

export class CrixKernel {
  private constructor(
    private readonly workspace: string,
    private readonly provider: ModelProvider,
    private readonly permissionMode: PermissionMode,
  ) {}

  static async create(options: KernelOptions): Promise<CrixKernel> {
    return new CrixKernel(await resolveWorkspace(options.workspace), options.provider ?? new MockProvider(), options.permissionMode ?? "auto-safe");
  }

  async runGoal(options: RunGoalOptions): Promise<ProofReport> {
    const store = await EventStore.start(this.workspace);
    const turn = new TurnRecorder({
      sessionId: store.sessionId,
      metadata: {
        source: "run-goal",
        goal: options.goal,
        mode: this.permissionMode,
        dryRun: Boolean(options.dryRun),
      },
    });
    const memory = new MemoryStore(this.workspace);
    const context = await new ContextBuilder(this.workspace, memory).build(options.goal);
    const agents = defaultAgents();
    const tools = defaultTools();
    const messages: Message[] = [
      { id: id("msg"), role: "system", content: buildSystemPrompt({ tools, agents, mode: "plan", goal: options.goal }), createdAt: nowIso() },
      { id: id("msg"), role: "user", content: options.goal, createdAt: nowIso() },
      ...(options.interventions ?? []).map((content) => ({ id: id("msg"), role: "user" as const, content, createdAt: nowIso(), name: "intervention" })),
    ];
    await store.append("session_started", `goal: ${options.goal}`, { mode: this.permissionMode });
    await store.append("context_built", `loaded ${context.files.length} files and ${context.memories.length} memories`, { usedChars: context.budget.usedChars });
    for (const content of options.interventions ?? []) {
      const item = turn.startItem({ kind: "user_intervention", title: "run intervention", status: "queued", input: { content } });
      turn.completeItem(item.id, { summary: content });
    }

    await this.preflight(options, turn);
    const plan = await this.plan(options, context, tools, agents, messages, turn);
    await options.onEvent?.({ type: "plan_created", plan });
    await store.append("plan_created", plan.summary, { planJson: JSON.stringify(plan) });
    const planItem = turn.startItem({
      kind: "assistant_message",
      title: "plan created",
      input: { goal: options.goal },
      metadata: { provider: this.provider.kind, steps: plan.steps.length, verification: plan.verification.length },
    });
    turn.completeItem(planItem.id, {
      summary: plan.summary,
      output: JSON.stringify(plan, null, 2),
    });

    const policy = new SafetyPolicy(this.permissionMode);
    const shell = new ShellExecutor(this.workspace);
    const applyEngine = await TurnEngine.create({
      workspace: this.workspace,
      permissionMode: this.permissionMode,
      provider: this.provider,
      agents,
      turn,
      metadata: { source: "apply-tool-loop", goal: options.goal },
    });
    const appliedSteps: string[] = [];
    const deniedSteps: string[] = [];
    const agentReports: AgentRunResult[] = [];
    const verificationReports = [];

    for (const step of plan.steps) {
      await store.append("step_started", step.title, { stepJson: JSON.stringify(step) });
      const effectiveSafety = effectiveStepSafety(step);
      const decision = policy.evaluateSafety(effectiveSafety);
      recordPolicyDecision(turn, `allow ${step.id}`, decision, { stepId: step.id, stepType: step.type, declaredSafety: step.safety, effectiveSafety, mode: this.permissionMode });
      await options.onEvent?.({ type: "step_start", step, effectiveSafety, allowed: decision.allowed, reason: decision.reason });
      const stepItem = turn.startItem({
        kind: turnKindForStep(step),
        title: step.title || step.id,
        input: { step: toJsonRecord(step) },
        metadata: { stepId: step.id, stepType: step.type, declaredSafety: step.safety, effectiveSafety },
      });
      if (!decision.allowed) {
        deniedSteps.push(`${step.id}: ${decision.reason}`);
        await store.append("step_denied", decision.reason, { stepJson: JSON.stringify(step) });
        turn.completeItem(stepItem.id, {
          status: "cancelled",
          summary: `denied: ${decision.reason}`,
          metadata: { decision: policyDecisionJson(decision) },
        });
        continue;
      }
      if (options.dryRun && step.safety !== "read-only") {
        appliedSteps.push(`${step.id}: dry-run skipped`);
        turn.completeItem(stepItem.id, {
          summary: "dry-run skipped",
          metadata: { decision: policyDecisionJson(decision), dryRun: true },
        });
        continue;
      }
      try {
        const result = await this.applyStep(step, applyEngine, options);
        if (result.agent) agentReports.push(result.agent);
        if (result.verification) verificationReports.push(result.verification);
        appliedSteps.push(`${step.id}: ${result.message}`);
        await options.onEvent?.({ type: "step_result", step, message: result.message });
        await store.append("step_applied", result.message, { stepJson: JSON.stringify(step) });
        turn.completeItem(stepItem.id, {
          summary: result.message,
          output: JSON.stringify({ agent: result.agent, verification: result.verification }, null, 2),
          metadata: { decision: policyDecisionJson(decision), ok: true },
        });
      } catch (error) {
        deniedSteps.push(`${step.id}: ${(error as Error).message}`);
        await store.append("error", (error as Error).message, { stepJson: JSON.stringify(step) });
        turn.failItem(stepItem.id, (error as Error).message, { decision: policyDecisionJson(decision) });
      }
    }

    if (!options.dryRun) {
      for (const command of plan.verification) {
        await store.append("verification_started", [command.program, ...command.args].join(" "));
        await options.onEvent?.({ type: "verification_start", command });
        const verificationItem = turn.startItem({
          kind: "command_execution",
          title: [command.program, ...command.args].join(" "),
          input: { command: toJsonRecord(command) },
          metadata: { phase: "final_verification" },
        });
        const report = await shell.verify(command);
        verificationReports.push(report);
        await options.onEvent?.({ type: "verification_result", command, report });
        await store.append("verification_finished", `${report.command}: ${report.ok}`, { reportJson: JSON.stringify(report) });
        turn.completeItem(verificationItem.id, {
          status: report.ok ? "completed" : "failed",
          summary: `${report.command}: ${report.ok ? "passed" : "failed"}`,
          output: [report.stdoutTail.trimEnd(), report.stderrTail.trimEnd()].filter(Boolean).join("\n"),
          error: report.ok ? undefined : report.blockedReason ?? report.stderrTail,
          metadata: { report: toJsonRecord(report) },
        });
      }
    }

    const status = options.dryRun ? "dry-run" : deniedSteps.length > 0 ? "blocked" : verificationReports.every((report) => report.ok) ? "passed" : "failed";
    const proofItem = turn.startItem({
      kind: "proof",
      title: "proof report",
      input: { status, proofPath: store.proofPath() },
    });
    const proof: ProofReport = {
      sessionId: store.sessionId,
      turnId: turn.turnId,
      goal: plan.goal,
      status,
      summary: plan.summary,
      appliedSteps,
      deniedSteps,
      agentReports,
      verification: verificationReports,
      proofPath: store.proofPath(),
    };
    await store.writeProof(proof);
    await store.append("proof_written", proof.proofPath, { status });
    turn.completeItem(proofItem.id, {
      status: status === "failed" || status === "blocked" ? "failed" : "completed",
      summary: `${status}: ${proof.summary}`,
      output: JSON.stringify(proof, null, 2),
    });
    proof.turnArtifactPath = await turn.writeArtifact(this.workspace);
    await store.writeProof(proof);
    return proof;
  }

  private async plan(options: RunGoalOptions, context: Awaited<ReturnType<ContextBuilder["build"]>>, tools: ReturnType<typeof defaultTools>, agents: ReturnType<typeof defaultAgents>, messages: Message[], turn: TurnRecorder): Promise<UpgradePlan> {
    if (options.planFile) {
      const text = await readFile(options.planFile, "utf8");
      const plan = parseUpgradePlan(JSON.parse(text.trimStart().replace(/^\uFEFF/, "")));
      if (plan.verification.length === 0 && options.verification) plan.verification = options.verification;
      return plan;
    }
    const systemPrompt = buildSystemPrompt({ tools, agents, mode: "plan", goal: options.goal });
    const currentMessages = [...messages];
    const engine = await TurnEngine.create({
      workspace: this.workspace,
      permissionMode: "auto-safe",
      provider: this.provider,
      agents,
      turn,
      metadata: { source: "provider-tool-loop", goal: options.goal },
    });
    const result = await runProviderToolLoop({
      goal: options.goal,
      systemPrompt,
      context,
      tools,
      agents,
      messages: currentMessages,
      provider: this.provider,
      engine,
      maxRounds: 6,
      mode: "plan",
      async onEvent(event) {
        if (event.type === "tool_start") await options.onEvent?.({ type: "plan_tool_start", call: event.call });
        if (event.type === "tool_result") await options.onEvent?.({ type: "plan_tool_result", call: event.call, result: event.result });
      },
    });
    const response = result.response;
    const plan = response.plan ?? { goal: options.goal, summary: response.text, steps: [], verification: options.verification ?? [] };
    if (plan.verification.length === 0 && options.verification) plan.verification = options.verification;
    return plan;
  }

  private async preflight(options: RunGoalOptions, turn: TurnRecorder): Promise<void> {
    const engine = await TurnEngine.create({
      workspace: this.workspace,
      permissionMode: "auto-safe",
      provider: this.provider,
      turn,
      metadata: { source: "repo-edit-preflight", goal: options.goal },
    });
    const listCall: TurnEngineCall = { name: "list_dir", input: { path: ".", recursive: false } };
    await options.onEvent?.({ type: "preflight_tool_start", call: listCall });
    const list = await engine.runCall(listCall);
    await options.onEvent?.({ type: "preflight_tool_result", call: listCall, result: list });
    if (!list.ok || !list.output.includes("\"package.json\"")) return;
    const readCall: TurnEngineCall = { name: "read_file", input: { path: "package.json" } };
    await options.onEvent?.({ type: "preflight_tool_start", call: readCall });
    const read = await engine.runCall(readCall);
    await options.onEvent?.({ type: "preflight_tool_result", call: readCall, result: read });
  }

  private async applyStep(step: PlanStep, engine: TurnEngine, options: RunGoalOptions): Promise<{ message: string; agent?: AgentRunResult; verification?: ExecutionReport }> {
    const call = callForStep(step);
    const result = await engine.runCall(call, {
      onCallStart: () => {
        void options.onEvent?.({ type: "apply_tool_start", step, call });
      },
      onCallComplete: ({ result, durationMs }) => {
        void options.onEvent?.({ type: "apply_tool_result", step, call, result, durationMs });
      },
    });
    if (!result.ok) throw new Error(result.output);
    if (step.type === "run_verification") {
      const verification = verificationFromToolResult(step.command, result);
      return { message: `${verification.command}: ${verification.ok}`, verification };
    }
    if (step.type === "spawn_agent") {
      const agent = agentFromToolResult(result);
      return { message: `agent ${step.agent} ${agent?.status ?? "completed"}`, agent };
    }
    return { message: result.output };
  }
}

function callForStep(step: PlanStep): TurnEngineCall {
  switch (step.type) {
    case "create_dir":
      return { name: "create_dir", input: { path: step.path } };
    case "write_file":
      return { name: "write_file", input: { path: step.path, content: step.content } };
    case "replace_text":
      return { name: "replace_text", input: { path: step.path, oldText: step.oldText, newText: step.newText } };
    case "run_verification":
      return { name: "run_verification", input: { command: toJsonRecord(step.command) } };
    case "spawn_agent":
      return { kind: "agent", name: "spawn_agent", input: { agent: step.agent, prompt: step.prompt, background: Boolean(step.background) } };
  }
}

function verificationFromToolResult(command: VerificationCommand, result: ToolResult): ExecutionReport {
  return {
    command: typeof result.metadata?.command === "string" ? result.metadata.command : [command.program, ...command.args].join(" "),
    ok: result.ok,
    code: typeof result.metadata?.code === "number" ? result.metadata.code : null,
    durationMs: typeof result.metadata?.durationMs === "number" ? result.metadata.durationMs : 0,
    stdoutTail: result.ok ? result.output : "",
    stderrTail: result.ok ? "" : result.output,
    blockedReason: result.ok ? undefined : result.output,
  };
}

function agentFromToolResult(result: ToolResult): AgentRunResult | undefined {
  try {
    const parsed = JSON.parse(result.output) as unknown;
    if (!isRecord(parsed)) return undefined;
    return parsed as unknown as AgentRunResult;
  } catch {
    return undefined;
  }
}

function effectiveStepSafety(step: PlanStep): SafetyClass {
  if (step.safety === "external-state" || step.safety === "destructive") return step.safety;
  if (step.type === "create_dir" || step.type === "write_file" || step.type === "replace_text") return "workspace-write";
  return step.safety;
}

function turnKindForStep(step: PlanStep): "file_change" | "command_execution" | "agent_call" {
  if (step.type === "run_verification") return "command_execution";
  if (step.type === "spawn_agent") return "agent_call";
  return "file_change";
}

function recordPolicyDecision(turn: TurnRecorder, title: string, decision: { allowed: boolean; reason: string }, metadata: JsonRecord): void {
  const item = turn.startItem({
    kind: "policy_decision",
    title,
    input: { decision: policyDecisionJson(decision), metadata },
    metadata,
  });
  turn.completeItem(item.id, {
    status: decision.allowed ? "completed" : "cancelled",
    summary: decision.reason,
    metadata: { allowed: decision.allowed },
  });
}

function policyDecisionJson(decision: { allowed: boolean; reason: string }): JsonRecord {
  return { allowed: decision.allowed, reason: decision.reason };
}

function toJsonRecord(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function providerFromPlanFile(planFile?: string): ModelProvider {
  return planFile ? new PlanFileProvider(planFile) : new MockProvider();
}

