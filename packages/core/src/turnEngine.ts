import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition, JsonRecord, PermissionMode, ToolResult, TurnItem, TurnItemKind, TurnItemStatus, TurnRecord, TurnStatus, WorkspaceGrant } from "@crix/protocol";
import { resolveWorkspace } from "./paths.js";
import { defaultAgents, type ModelProvider } from "./provider.js";
import { CRIX_TOOL_CATALOG } from "./toolCatalog.js";
import { runScheduledToolCalls, toolConcurrencyByName } from "./toolScheduler.js";
import { ToolRuntime } from "./toolRuntime.js";
import type { ToolPermissionPrompt } from "./toolRuntime.js";
import { id, nowIso } from "./util.js";

export interface TurnRecorderOptions {
  turnId?: string;
  sessionId?: string;
  metadata?: JsonRecord;
}

export interface StartTurnItemInput {
  kind: TurnItemKind;
  title: string;
  status?: TurnItemStatus;
  input?: JsonRecord;
  metadata?: JsonRecord;
}

export interface CompleteTurnItemInput {
  status?: Extract<TurnItemStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  output?: string;
  error?: string;
  metadata?: JsonRecord;
}

export interface TurnArtifactSummary {
  turnId: string;
  artifactPath: string;
  status: TurnStatus;
  itemCount: number;
  startedAt: string;
  updatedAt: string;
  source?: string;
}

export type TurnEngineCallKind = "tool" | "agent";

export interface TurnEngineCall {
  kind?: TurnEngineCallKind;
  name: string;
  input: JsonRecord;
}

export interface TurnEngineOptions {
  workspace: string;
  permissionMode?: PermissionMode;
  allowExternal?: boolean;
  allowDestructive?: boolean;
  provider?: ModelProvider;
  agents?: AgentDefinition[];
  permissionPrompt?: ToolPermissionPrompt;
  workspaceGrants?: WorkspaceGrant[];
  approvalPersistence?: "once" | "session";
  readPolicy?: "workspace-only" | "explicit-path-broad";
  turn?: TurnRecorder;
  sessionId?: string;
  metadata?: JsonRecord;
}

export interface TurnEngineObserver {
  onCallStart?(event: { item: TurnItem; call: TurnEngineCall; kind: TurnEngineCallKind; title: string }): void;
  onCallComplete?(event: { item: TurnItem; call: TurnEngineCall; kind: TurnEngineCallKind; title: string; result: ToolResult; durationMs: number }): void;
  onCallError?(event: { item: TurnItem; call: TurnEngineCall; kind: TurnEngineCallKind; title: string; error: Error; durationMs: number }): void;
  onInterventionQueued?(event: QueuedIntervention): void;
  onInterventionsDrained?(event: { interventions: QueuedIntervention[] }): void;
}

export interface QueuedIntervention {
  id: string;
  itemId: string;
  content: string;
  createdAt: string;
  metadata?: JsonRecord;
}

export class TurnEngine {
  readonly recorder: TurnRecorder;
  private readonly interventions: QueuedIntervention[] = [];

  private constructor(
    readonly workspace: string,
    private readonly runtime: ToolRuntime,
    recorder: TurnRecorder,
  ) {
    this.recorder = recorder;
  }

  static async create(options: TurnEngineOptions): Promise<TurnEngine> {
    const workspace = await resolveWorkspace(options.workspace);
    const recorder = options.turn ?? new TurnRecorder({
      sessionId: options.sessionId,
      metadata: options.metadata,
    });
    const runtime = await ToolRuntime.create(workspace, {
      permissionMode: options.permissionMode,
      allowExternal: options.allowExternal,
      allowDestructive: options.allowDestructive,
      provider: options.provider,
      agents: options.agents ?? defaultAgents(),
      permissionPrompt: options.permissionPrompt,
      workspaceGrants: options.workspaceGrants,
      approvalPersistence: options.approvalPersistence,
      readPolicy: options.readPolicy,
    });
    return new TurnEngine(workspace, runtime, recorder);
  }

  queueIntervention(content: string, metadata: JsonRecord = {}, observer?: TurnEngineObserver): QueuedIntervention {
    const item = this.recorder.startItem({
      kind: "user_intervention",
      title: "user intervention",
      status: "queued",
      input: { content },
      metadata,
    });
    const intervention: QueuedIntervention = {
      id: id("intervention"),
      itemId: item.id,
      content,
      createdAt: item.createdAt,
      metadata,
    };
    this.interventions.push(intervention);
    observer?.onInterventionQueued?.(intervention);
    return intervention;
  }

  drainInterventions(observer?: TurnEngineObserver): QueuedIntervention[] {
    const drained = this.interventions.splice(0);
    for (const intervention of drained) {
      this.recorder.completeItem(intervention.itemId, {
        status: "completed",
        summary: intervention.content,
      });
    }
    if (drained.length > 0) observer?.onInterventionsDrained?.({ interventions: drained });
    return drained;
  }

  async runCall(call: TurnEngineCall, observer?: TurnEngineObserver): Promise<ToolResult> {
    const kind = call.kind ?? "tool";
    const title = callTitle(call, kind);
    const item = this.recorder.startItem({
      kind: kind === "agent" ? "agent_call" : "tool_call",
      title,
      input: call.input,
      metadata: { toolName: call.name, displayKind: kind },
    });
    observer?.onCallStart?.({ item, call, kind, title });
    const started = Date.now();
    try {
      const result = await this.runtime.execute(call.name, call.input);
      const durationMs = Date.now() - started;
      this.recorder.completeItem(item.id, {
        status: result.ok ? "completed" : "failed",
        summary: summarizeEngineResult(result),
        output: result.output,
        error: result.ok ? undefined : result.output,
        metadata: { durationMs, ok: result.ok, result: result.metadata ?? {} },
      });
      observer?.onCallComplete?.({ item: this.recorder.item(item.id), call, kind, title, result, durationMs });
      return result;
    } catch (error) {
      const durationMs = Date.now() - started;
      const typed = error instanceof Error ? error : new Error(String(error));
      this.recorder.failItem(item.id, typed.message, { durationMs });
      observer?.onCallError?.({ item: this.recorder.item(item.id), call, kind, title, error: typed, durationMs });
      throw typed;
    }
  }

  async runCalls(calls: TurnEngineCall[], observer?: TurnEngineObserver): Promise<ToolResult[]> {
    const concurrencyOfTool = toolConcurrencyByName(CRIX_TOOL_CATALOG);
    return await runScheduledToolCalls(
      calls,
      (call) => call.kind === "agent" ? "exclusive" : concurrencyOfTool(call.name),
      async (call) => await this.runCall(call, observer),
    );
  }

  async writeArtifact(workspace = this.workspace): Promise<string> {
    return await this.recorder.writeArtifact(workspace);
  }
}

export class TurnRecorder {
  readonly turnId: string;
  readonly sessionId?: string;
  readonly startedAt: string;
  private readonly metadata?: JsonRecord;
  private readonly items: TurnItem[] = [];
  private status: TurnStatus = "in_progress";
  private updatedAt: string;
  private completedAt?: string;

  constructor(options: TurnRecorderOptions = {}) {
    this.turnId = options.turnId ?? id("turn");
    this.sessionId = options.sessionId;
    this.startedAt = nowIso();
    this.updatedAt = this.startedAt;
    this.metadata = options.metadata;
  }

  startItem(input: StartTurnItemInput): TurnItem {
    const now = nowIso();
    const item: TurnItem = {
      id: id("item"),
      turnId: this.turnId,
      kind: input.kind,
      status: input.status ?? "in_progress",
      title: input.title,
      createdAt: now,
      updatedAt: now,
      input: input.input,
      metadata: input.metadata,
    };
    this.items.push(item);
    this.touch(now);
    return item;
  }

  item(itemId: string): TurnItem {
    const item = this.findItem(itemId);
    return { ...item, metadata: item.metadata ? { ...item.metadata } : undefined };
  }

  completeItem(itemId: string, input: CompleteTurnItemInput = {}): TurnItem {
    const item = this.findItem(itemId);
    const now = nowIso();
    item.status = input.status ?? "completed";
    item.summary = input.summary;
    item.output = input.output;
    item.error = input.error;
    item.metadata = { ...(item.metadata ?? {}), ...(input.metadata ?? {}) };
    item.updatedAt = now;
    item.completedAt = now;
    this.touch(now);
    if (item.status === "failed") this.status = "failed";
    return item;
  }

  failItem(itemId: string, error: string, metadata: JsonRecord = {}): TurnItem {
    return this.completeItem(itemId, { status: "failed", error, summary: error, metadata });
  }

  finish(status?: TurnStatus): TurnRecord {
    const now = nowIso();
    this.status = status ?? this.inferStatus();
    this.updatedAt = now;
    this.completedAt = now;
    return this.snapshot();
  }

  snapshot(): TurnRecord {
    return {
      id: this.turnId,
      sessionId: this.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
      items: this.items.map((item) => ({ ...item, metadata: item.metadata ? { ...item.metadata } : undefined })),
      metadata: this.metadata ? { ...this.metadata } : undefined,
    };
  }

  async writeArtifact(workspace: string): Promise<string> {
    const outDir = turnArtifactDir(workspace);
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${this.turnId}.json`);
    await writeFile(outPath, `${JSON.stringify(this.finish(), null, 2)}\n`, "utf8");
    return outPath;
  }

  static async listArtifacts(workspace: string, limit = 20): Promise<TurnArtifactSummary[]> {
    const outDir = turnArtifactDir(workspace);
    let entries;
    try {
      entries = await readdir(outDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const artifactPath = path.join(outDir, entry.name);
          const record = await readTurnArtifact(artifactPath);
          const fileStat = await stat(artifactPath);
          return {
            turnId: record.id,
            artifactPath,
            status: record.status,
            itemCount: record.items.length,
            startedAt: record.startedAt,
            updatedAt: record.updatedAt || fileStat.mtime.toISOString(),
            source: typeof record.metadata?.source === "string" ? record.metadata.source : undefined,
          };
        }),
    );
    return summaries
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(0, limit));
  }

  static async readArtifact(workspace: string, turnId: string): Promise<TurnRecord> {
    assertSafeTurnId(turnId);
    return await readTurnArtifact(path.join(turnArtifactDir(workspace), `${turnId}.json`));
  }

  private findItem(itemId: string): TurnItem {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`unknown turn item ${itemId}`);
    return item;
  }

  private touch(now = nowIso()): void {
    this.updatedAt = now;
  }

  private inferStatus(): TurnStatus {
    if (this.items.some((item) => item.status === "failed")) return "failed";
    if (this.items.some((item) => item.status === "cancelled")) return "cancelled";
    return "completed";
  }
}

function turnArtifactDir(workspace: string): string {
  return path.join(workspace, ".crix", "artifacts", "turns");
}

async function readTurnArtifact(artifactPath: string): Promise<TurnRecord> {
  return JSON.parse(await readFile(artifactPath, "utf8")) as TurnRecord;
}

function assertSafeTurnId(turnId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(turnId)) throw new Error(`invalid turn id: ${turnId}`);
}

function callTitle(call: TurnEngineCall, kind: TurnEngineCallKind): string {
  return kind === "agent" && typeof call.input.agent === "string" ? `${call.name}:${call.input.agent}` : call.name;
}

function summarizeEngineResult(result: ToolResult): string {
  if (!result.ok) return result.output.slice(0, 500);
  if (typeof result.metadata?.command === "string") return `${result.metadata.command}: ${result.ok}`;
  return result.output.replace(/\s+/g, " ").trim().slice(0, 500) || "completed";
}
