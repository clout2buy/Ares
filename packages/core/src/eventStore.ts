import { appendFile, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessEvent, JsonRecord, Message, ProofReport, TurnItem, TurnRecord } from "@crix/protocol";
import { TurnRecorder } from "./turnEngine.js";
import { id, nowIso } from "./util.js";

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  eventPath: string;
  proofPath: string;
  eventCount: number;
  createdAt?: string;
  updatedAt?: string;
  goal?: string;
  status?: ProofReport["status"];
  summary?: string;
}

export interface SessionRead {
  summary: SessionSummary;
  events: HarnessEvent[];
  proof?: ProofReport;
  compact?: SessionCompact;
}

export interface SessionCompact {
  sessionId: string;
  createdAt: string;
  goal?: string;
  status?: ProofReport["status"];
  summary?: string;
  eventCount: number;
  lastEvents: Array<Pick<HarnessEvent, "createdAt" | "kind" | "message">>;
  proofPath?: string;
  turnId?: string;
  turnArtifactPath?: string;
  turnCount?: number;
  messageCount?: number;
}

export interface SessionForkResult {
  sourceSessionId: string;
  sessionId: string;
  sessionDir: string;
}

export interface SessionThreadHistory extends SessionRead {
  turns: TurnRecord[];
  messages: Message[];
  timeline: SessionTimelineItem[];
}

export interface SessionTimelineItem {
  createdAt: string;
  source: "event" | "turn";
  kind: string;
  title: string;
  summary?: string;
}

export class EventStore {
  readonly sessionId: string;
  readonly root: string;
  readonly sessionDir: string;

  private constructor(workspace: string, sessionId: string) {
    this.sessionId = sessionId;
    this.root = path.join(workspace, ".crix");
    this.sessionDir = path.join(this.root, "sessions", sessionId);
  }

  static async start(workspace: string): Promise<EventStore> {
    const store = new EventStore(workspace, id("session"));
    await mkdir(store.sessionDir, { recursive: true });
    return store;
  }

  static async resume(workspace: string, sessionId: string): Promise<EventStore> {
    const store = EventStore.forSession(workspace, sessionId);
    await mkdir(store.sessionDir, { recursive: true });
    await store.append("session_started", `resumed: ${sessionId}`, { resumed: true });
    return store;
  }

  static forSession(workspace: string, sessionId: string): EventStore {
    assertSafeSessionId(sessionId);
    return new EventStore(workspace, sessionId);
  }

  static async listSessions(workspace: string, limit = 20): Promise<SessionSummary[]> {
    const root = path.join(workspace, ".crix", "sessions");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => EventStore.summarizeSession(workspace, entry.name)),
    );
    return summaries
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, Math.max(0, limit));
  }

  static async readSession(workspace: string, sessionId: string): Promise<SessionRead> {
    const store = EventStore.forSession(workspace, sessionId);
    const events = await store.readEvents();
    const proof = await store.readProof();
    const compact = await store.readCompact();
    const summary = await EventStore.summarizeSession(workspace, sessionId, events, proof);
    return { summary, events, proof, compact };
  }

  static async readThreadHistory(workspace: string, sessionId: string): Promise<SessionThreadHistory> {
    const read = await EventStore.readSession(workspace, sessionId);
    const turns = await readSessionTurns(workspace, sessionId, read.proof);
    const timeline = buildTimeline(read.events, turns);
    const messages = buildRehydratedMessages(sessionId, read.events, turns);
    return { ...read, turns, messages, timeline };
  }

  static async forkSession(workspace: string, sourceSessionId: string): Promise<SessionForkResult> {
    assertSafeSessionId(sourceSessionId);
    const source = EventStore.forSession(workspace, sourceSessionId);
    const fork = await EventStore.start(workspace);
    await cp(source.sessionDir, fork.sessionDir, { recursive: true, force: true });
    const proof = await fork.readProof();
    if (proof) await fork.writeProof({ ...proof, sessionId: fork.sessionId });
    await fork.append("session_started", `forked from ${sourceSessionId}`, { forkedFrom: sourceSessionId });
    return { sourceSessionId, sessionId: fork.sessionId, sessionDir: fork.sessionDir };
  }

  static async compactSession(workspace: string, sessionId: string): Promise<SessionCompact> {
    const read = await EventStore.readThreadHistory(workspace, sessionId);
    const compact: SessionCompact = {
      sessionId,
      createdAt: nowIso(),
      goal: read.summary.goal,
      status: read.proof?.status,
      summary: read.proof?.summary,
      eventCount: read.events.length,
      lastEvents: read.events.slice(-12).map((event) => ({
        createdAt: event.createdAt,
        kind: event.kind,
        message: event.message,
      })),
      proofPath: read.proof?.proofPath,
      turnId: read.proof?.turnId,
      turnArtifactPath: read.proof?.turnArtifactPath,
      turnCount: read.turns.length,
      messageCount: read.messages.length,
    };
    const store = EventStore.forSession(workspace, sessionId);
    await writeFile(store.compactPath(), `${JSON.stringify(compact, null, 2)}\n`, "utf8");
    await store.append("proof_written", "session compact written", { compactPath: store.compactPath() });
    return compact;
  }

  private static async summarizeSession(
    workspace: string,
    sessionId: string,
    knownEvents?: HarnessEvent[],
    knownProof?: ProofReport,
  ): Promise<SessionSummary> {
    const store = EventStore.forSession(workspace, sessionId);
    const events = knownEvents ?? await store.readEvents();
    const proof = knownProof ?? await store.readProof();
    const dirStat = await stat(store.sessionDir).catch(() => undefined);
    const firstEvent = events[0];
    const lastEvent = events.at(-1);
    return {
      sessionId,
      sessionDir: store.sessionDir,
      eventPath: store.eventPath(),
      proofPath: store.proofPath(),
      eventCount: events.length,
      createdAt: firstEvent?.createdAt ?? dirStat?.birthtime.toISOString(),
      updatedAt: lastEvent?.createdAt ?? dirStat?.mtime.toISOString(),
      goal: proof?.goal ?? extractGoal(firstEvent),
      status: proof?.status,
      summary: proof?.summary,
    };
  }

  eventPath(): string {
    return path.join(this.sessionDir, "events.jsonl");
  }

  proofPath(): string {
    return path.join(this.sessionDir, "proof.json");
  }

  compactPath(): string {
    return path.join(this.sessionDir, "compact.json");
  }

  checkpointDir(stepId: string): string {
    return path.join(this.sessionDir, "checkpoints", stepId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  }

  async append(kind: HarnessEvent["kind"], message: string, data: JsonRecord = {}): Promise<HarnessEvent> {
    await mkdir(this.sessionDir, { recursive: true });
    const event: HarnessEvent = {
      id: id("event"),
      sessionId: this.sessionId,
      createdAt: nowIso(),
      kind,
      message,
      data,
    };
    await appendFile(this.eventPath(), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async readEvents(): Promise<HarnessEvent[]> {
    try {
      const text = await readFile(this.eventPath(), "utf8");
      return text
        .split(/\r?\n/g)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as HarnessEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readProof(): Promise<ProofReport | undefined> {
    try {
      return JSON.parse(await readFile(this.proofPath(), "utf8")) as ProofReport;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readCompact(): Promise<SessionCompact | undefined> {
    try {
      return JSON.parse(await readFile(this.compactPath(), "utf8")) as SessionCompact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeProof(proof: ProofReport): Promise<void> {
    await writeFile(this.proofPath(), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
}

function extractGoal(event?: HarnessEvent): string | undefined {
  if (!event || event.kind !== "session_started") return undefined;
  const match = event.message.match(/^goal:\s*(.+)$/);
  return match?.[1]?.trim() || undefined;
}

async function readSessionTurns(workspace: string, sessionId: string, proof?: ProofReport): Promise<TurnRecord[]> {
  const records = new Map<string, TurnRecord>();
  if (proof?.turnId) {
    try {
      const turn = await TurnRecorder.readArtifact(workspace, proof.turnId);
      records.set(turn.id, turn);
    } catch {
      // A forked or externally moved session may point at a missing turn artifact.
    }
  }
  for (const summary of await TurnRecorder.listArtifacts(workspace, 1000)) {
    try {
      const turn = await TurnRecorder.readArtifact(workspace, summary.turnId);
      if (turn.sessionId === sessionId) records.set(turn.id, turn);
    } catch {
      // Ignore corrupt or concurrently written artifacts in history reconstruction.
    }
  }
  return [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function buildTimeline(events: HarnessEvent[], turns: TurnRecord[]): SessionTimelineItem[] {
  const rows: SessionTimelineItem[] = [
    ...events.map((event) => ({
      createdAt: event.createdAt,
      source: "event" as const,
      kind: event.kind,
      title: event.message,
    })),
    ...turns.flatMap((turn) => turn.items.map((item) => ({
      createdAt: item.updatedAt,
      source: "turn" as const,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
    }))),
  ];
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function buildRehydratedMessages(sessionId: string, events: HarnessEvent[], turns: TurnRecord[]): Message[] {
  const messages: Message[] = [];
  const started = events.find((event) => event.kind === "session_started");
  const goal = extractGoal(started);
  if (goal) {
    messages.push({
      id: id("msg"),
      role: "user",
      content: goal,
      createdAt: started?.createdAt ?? nowIso(),
      name: "session_goal",
      metadata: { sessionId },
    });
  }
  for (const turn of turns) {
    for (const item of turn.items) {
      const message = messageFromTurnItem(sessionId, turn.id, item);
      if (message) messages.push(message);
    }
  }
  return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function messageFromTurnItem(sessionId: string, turnId: string, item: TurnItem): Message | undefined {
  const metadata = { sessionId, turnId, itemId: item.id, itemKind: item.kind, itemStatus: item.status };
  if (item.kind === "assistant_message") {
    return {
      id: id("msg"),
      role: "assistant",
      content: item.output ?? item.summary ?? item.title,
      createdAt: item.updatedAt,
      name: item.title,
      metadata,
    };
  }
  if (item.kind === "user_intervention") {
    return {
      id: id("msg"),
      role: "user",
      content: typeof item.input?.content === "string" ? item.input.content : item.summary ?? item.title,
      createdAt: item.updatedAt,
      name: "intervention",
      metadata,
    };
  }
  if (item.kind === "tool_call") {
    return {
      id: id("msg"),
      role: "tool",
      content: item.output ?? item.summary ?? "",
      createdAt: item.updatedAt,
      name: item.title,
      metadata,
    };
  }
  if (item.kind === "agent_call") {
    return {
      id: id("msg"),
      role: "agent",
      content: item.output ?? item.summary ?? "",
      createdAt: item.updatedAt,
      name: item.title,
      metadata,
    };
  }
  return undefined;
}
