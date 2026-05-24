import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition, AgentRunRequest, AgentRunResult, JsonRecord, Message, ToolCall, ToolDefinition, ToolResult } from "@crix/protocol";
import type { ModelProvider } from "./provider.js";
import { CRIX_TOOL_CATALOG } from "./toolCatalog.js";
import { runScheduledToolCalls, toolConcurrencyByName } from "./toolScheduler.js";
import { providerResponseToolCalls } from "./providerResponse.js";
import { id, nowIso } from "./util.js";

export type AgentToolExecutor = (name: string, input: JsonRecord) => Promise<ToolResult>;

export class AgentOrchestrator {
  private readonly runs = new Map<string, AgentRunResult>();
  private readonly pending = new Map<string, Promise<AgentRunResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly notified = new Set<string>();

  constructor(
    private readonly provider: ModelProvider,
    private readonly agents: AgentDefinition[],
    private readonly tools: ToolDefinition[] = CRIX_TOOL_CATALOG,
    private readonly toolExecutor?: AgentToolExecutor,
    private readonly workspace?: string,
  ) {}

  listAgents(): AgentDefinition[] {
    return this.agents;
  }

  getRun(runId: string): AgentRunResult | undefined {
    return this.runs.get(runId);
  }

  static async listNotifications(workspace: string, limit = 20): Promise<AgentCompletionNotification[]> {
    let text = "";
    try {
      text = await readFile(notificationPath(workspace), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AgentCompletionNotification)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit));
  }

  static async readRun(workspace: string, runId: string): Promise<AgentRunResult | undefined> {
    try {
      return JSON.parse(await readFile(transcriptPath(workspace, runId), "utf8")) as AgentRunResult;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async spawn(request: AgentRunRequest, background = false): Promise<AgentRunResult> {
    const runId = id("agent");
    const running: AgentRunResult = {
      id: runId,
      agentId: request.agent.id,
      status: "running",
      summary: "agent started",
      messages: [],
      startedAt: nowIso(),
      metadata: { tools: request.agent.tools, transcriptPath: transcriptPath(request.context.workspace, runId), workspace: request.context.workspace, background },
    };
    this.runs.set(runId, running);
    await writeTranscript(request.context.workspace, running);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const promise = this.execute(runId, request, controller.signal);
    this.pending.set(runId, promise);
    if (background) return running;
    return await promise;
  }

  async wait(runId: string): Promise<AgentRunResult> {
    const pending = this.pending.get(runId);
    if (pending) return await pending;
    const run = this.runs.get(runId);
    if (run) return run;
    const persisted = await this.readPersistedRun(runId);
    if (persisted) return persisted;
    throw new Error(`unknown agent run ${runId}`);
  }

  async sendInput(runId: string, content: string): Promise<void> {
    const run = this.runs.get(runId) ?? await this.readPersistedRun(runId);
    if (!run) throw new Error(`unknown agent run ${runId}`);
    run.messages.push({ id: id("msg"), role: "user", content, createdAt: nowIso(), name: "intervention" });
    run.summary = "input queued";
    this.runs.set(runId, run);
    await writeTranscriptFromRun(run);
  }

  async cancel(runId: string, reason = "cancelled by user"): Promise<AgentRunResult> {
    const run = this.runs.get(runId) ?? await this.readPersistedRun(runId);
    if (!run) throw new Error(`unknown agent run ${runId}`);
    this.cancelled.add(runId);
    this.controllers.get(runId)?.abort(new Error(reason));
    const cancelled: AgentRunResult = {
      ...run,
      status: "cancelled",
      summary: reason,
      finishedAt: nowIso(),
      messages: [...run.messages, { id: id("msg"), role: "user", content: reason, createdAt: nowIso(), name: "cancel" }],
      metadata: { ...(run.metadata ?? {}), cancelled: true },
    };
    this.runs.set(runId, cancelled);
    await writeTranscriptFromRun(cancelled);
    return cancelled;
  }

  private async readPersistedRun(runId: string): Promise<AgentRunResult | undefined> {
    if (this.workspace) {
      const persisted = await AgentOrchestrator.readRun(this.workspace, runId);
      if (persisted) {
        this.runs.set(runId, persisted);
        return persisted;
      }
    }
    for (const run of this.runs.values()) {
      const workspace = typeof run.metadata?.workspace === "string" ? run.metadata.workspace : undefined;
      if (!workspace) continue;
      const persisted = await AgentOrchestrator.readRun(workspace, runId);
      if (persisted) {
        this.runs.set(runId, persisted);
        return persisted;
      }
    }
    return undefined;
  }

  private async execute(runId: string, request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunResult> {
    const started = this.runs.get(runId)!;
    try {
      const messages: Message[] = [
        { id: id("msg"), role: "system", content: request.agent.systemPrompt, createdAt: nowIso(), name: request.agent.name },
        { id: id("msg"), role: "user", content: request.prompt, createdAt: nowIso() },
        ...request.messages,
      ];
      const knownMessageIds = new Set(messages.map((message) => message.id));
      const scopedTools = this.toolsForAgent(request.agent);
      const scopedToolNames = scopedTools.map((tool) => tool.name);
      const scopedToolNameSet = new Set(scopedToolNames);
      const concurrencyOfTool = toolConcurrencyByName(scopedTools);
      const maxTurns = Math.max(1, request.agent.maxTurns ?? 4);

      for (let turn = 0; turn < maxTurns; turn += 1) {
        appendNewRunMessages(this.runs.get(runId), messages, knownMessageIds);
        const response = await this.provider.complete({
          goal: request.prompt,
          systemPrompt: request.agent.systemPrompt,
          context: request.context,
          tools: scopedTools,
          agents: this.agents,
          messages,
        }, { signal });
        if (this.cancelled.has(runId)) {
          const cancelled = this.runs.get(runId)!;
          await writeTranscript(request.context.workspace, cancelled);
          return cancelled;
        }

        const toolCalls = providerResponseToolCalls(response, scopedToolNames);
        const assistantMessage: Message = {
          id: id("msg"),
          role: "assistant",
          content: response.text || (toolCalls.length ? `requested ${toolCalls.length} tool call(s)` : "completed"),
          createdAt: nowIso(),
          name: request.agent.name,
          metadata: { agentRunId: runId, agentTurn: turn, toolCallCount: toolCalls.length },
        };
        messages.push(assistantMessage);
        knownMessageIds.add(assistantMessage.id);

        if (toolCalls.length === 0) {
          const latest = this.runs.get(runId) ?? started;
          const completed: AgentRunResult = {
            ...latest,
            status: "completed",
            summary: response.text,
            messages: [...messages],
            finishedAt: nowIso(),
            metadata: { ...(latest.metadata ?? {}), tools: scopedToolNames, turns: turn + 1 },
          };
          this.runs.set(runId, completed);
          await writeTranscript(request.context.workspace, completed);
          await this.notifyCompletion(request.context.workspace, completed);
          return completed;
        }

        if (!this.toolExecutor) throw new Error(`agent ${request.agent.id} requested tools but no executor is configured`);

        const results = await runScheduledToolCalls(
          toolCalls,
          (call) => scopedToolNameSet.has(call.name) ? concurrencyOfTool(call.name) : "exclusive",
          async (call) => scopedToolNameSet.has(call.name)
            ? await this.toolExecutor!(call.name, call.input)
            : deniedAgentToolResult(request.agent.id, call),
        );

        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]!;
          const call = toolCalls[index]!;
          const toolMessage: Message = {
            id: id("msg"),
            role: "tool",
            name: call.name,
            content: result.output,
            createdAt: nowIso(),
            metadata: { callId: result.callId, ok: result.ok, agentRunId: runId, agentTurn: turn },
          };
          messages.push(toolMessage);
          knownMessageIds.add(toolMessage.id);
        }

        const latest = this.runs.get(runId) ?? started;
        const running: AgentRunResult = {
          ...latest,
          summary: response.text || `completed tool round ${turn + 1}`,
          messages: [...messages],
          metadata: { ...(latest.metadata ?? {}), tools: scopedToolNames, turns: turn + 1, lastToolCallCount: toolCalls.length },
        };
        this.runs.set(runId, running);
        await writeTranscript(request.context.workspace, running);
      }

      throw new Error(`agent ${request.agent.id} exceeded ${maxTurns} bounded tool turn(s)`);
    } catch (error) {
      if (this.cancelled.has(runId) || signal.aborted) {
        const cancelled = this.runs.get(runId) ?? started;
        const final: AgentRunResult = {
          ...cancelled,
          status: "cancelled",
          summary: cancelled.summary === "agent started" ? abortReason(signal) : cancelled.summary,
          finishedAt: cancelled.finishedAt ?? nowIso(),
          metadata: { ...(cancelled.metadata ?? {}), cancelled: true },
        };
        this.runs.set(runId, final);
        await writeTranscript(request.context.workspace, final);
        await this.notifyCompletion(request.context.workspace, final);
        return final;
      }
      const failed: AgentRunResult = {
        ...started,
        status: "failed",
        summary: (error as Error).message,
        finishedAt: nowIso(),
      };
      this.runs.set(runId, failed);
      await writeTranscript(request.context.workspace, failed);
      await this.notifyCompletion(request.context.workspace, failed);
      return failed;
    } finally {
      this.pending.delete(runId);
      this.controllers.delete(runId);
    }
  }

  private toolsForAgent(agent: AgentDefinition): ToolDefinition[] {
    const allowed = new Set(agent.tools);
    return this.tools.filter((tool) => allowed.has(tool.name));
  }

  private async notifyCompletion(workspace: string, run: AgentRunResult): Promise<void> {
    if (this.notified.has(run.id)) return;
    if (run.status === "running" || run.status === "queued") return;
    this.notified.add(run.id);
    const notification: AgentCompletionNotification = {
      id: id("agent_note"),
      runId: run.id,
      agentId: run.agentId,
      status: run.status,
      summary: run.summary,
      createdAt: nowIso(),
      transcriptPath: typeof run.metadata?.transcriptPath === "string" ? run.metadata.transcriptPath : undefined,
      background: run.metadata?.background === true,
    };
    await appendNotification(workspace, notification);
  }
}

function appendNewRunMessages(run: AgentRunResult | undefined, messages: Message[], knownMessageIds: Set<string>): void {
  if (!run) return;
  for (const message of run.messages) {
    if (knownMessageIds.has(message.id)) continue;
    messages.push(message);
    knownMessageIds.add(message.id);
  }
}

function deniedAgentToolResult(agentId: string, call: ToolCall): ToolResult {
  return {
    callId: call.id,
    ok: false,
    output: `agent ${agentId} is not allowed to use tool ${call.name}`,
    metadata: { denied: true, agentId, toolName: call.name },
  };
}

export interface AgentCompletionNotification {
  id: string;
  runId: string;
  agentId: string;
  status: AgentRunResult["status"];
  summary: string;
  createdAt: string;
  transcriptPath?: string;
  background?: boolean;
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : "cancelled";
}

async function writeTranscript(workspace: string, run: AgentRunResult): Promise<void> {
  const file = transcriptPath(workspace, run.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

async function writeTranscriptFromRun(run: AgentRunResult): Promise<void> {
  const file = typeof run.metadata?.transcriptPath === "string" ? run.metadata.transcriptPath : undefined;
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, "utf8");
}

function transcriptPath(workspace: string, runId: string): string {
  return path.join(workspace, ".crix", "agents", `${runId}.json`);
}

function notificationPath(workspace: string): string {
  return path.join(workspace, ".crix", "agents", "notifications.jsonl");
}

async function appendNotification(workspace: string, notification: AgentCompletionNotification): Promise<void> {
  const file = notificationPath(workspace);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(notification)}\n`, "utf8");
}
