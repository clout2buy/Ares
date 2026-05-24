export type Role = "system" | "user" | "assistant" | "tool" | "agent";

export type PermissionMode = "ask" | "auto-safe" | "workspace-write" | "danger-full-access";
export type SafetyClass = "read-only" | "workspace-write" | "destructive" | "external-state";
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ProviderKind = "mock" | "plan-file" | "openai-oauth" | "ollama-cloud";
export type ToolStatus = "available";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  name?: string;
  metadata?: JsonRecord;
}

export interface MemoryRecord {
  id: string;
  text: string;
  scope: "global" | "project" | "agent";
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  maxTurns?: number;
  background?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  safety: SafetyClass;
  concurrency: "exclusive" | "parallel-safe";
  inputSchema: JsonRecord;
  status?: ToolStatus;
  category?: string;
  process?: string;
  references?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: JsonRecord;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
  metadata?: JsonRecord;
}

export type WorkspaceGrantSource = "startup" | "explicit-path" | "session" | "tool";

export interface WorkspaceGrant {
  root: string;
  read: boolean;
  write: boolean;
  source: WorkspaceGrantSource;
  createdAt: string;
}

export interface ToolUseRequest {
  id: string;
  name: string;
  input: JsonRecord;
  kind?: "tool" | "agent";
}

export interface ToolUseResult extends ToolResult {
  requestId?: string;
}

export type PermissionPromptDecision = "allow-once" | "allow-session" | "deny";

export interface AgentSessionState {
  id: string;
  workspace: string;
  provider: string;
  model?: string;
  permissionMode: PermissionMode;
  grants: WorkspaceGrant[];
  messages: Message[];
  queuedMessages: Message[];
  turnIds: string[];
  toolUseCount: number;
  finalAnswer?: string;
  updatedAt: string;
}

export type AgentTurnEvent =
  | { type: "session_started"; state: AgentSessionState }
  | { type: "grant_added"; grant: WorkspaceGrant }
  | { type: "tool_start"; call: ToolUseRequest }
  | { type: "tool_result"; call: ToolUseRequest; result: ToolUseResult }
  | { type: "intervention"; messages: Message[] }
  | { type: "assistant"; text: string; toolCallCount: number }
  | { type: "final"; text: string; state: AgentSessionState; turnArtifactPath: string }
  | { type: "error"; message: string };

export type TurnStatus = "in_progress" | "completed" | "failed" | "cancelled";
export type TurnItemKind =
  | "assistant_message"
  | "user_intervention"
  | "policy_decision"
  | "tool_call"
  | "agent_call"
  | "command_execution"
  | "file_change"
  | "todo_list"
  | "proof"
  | "error";
export type TurnItemStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export interface TurnItem {
  id: string;
  turnId: string;
  kind: TurnItemKind;
  status: TurnItemStatus;
  title: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  input?: JsonRecord;
  output?: string;
  summary?: string;
  error?: string;
  metadata?: JsonRecord;
}

export interface TurnRecord {
  id: string;
  sessionId?: string;
  status: TurnStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  items: TurnItem[];
  metadata?: JsonRecord;
}

export interface VerificationCommand {
  program: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export type PlanStep =
  | {
      id: string;
      title: string;
      safety: SafetyClass;
      type: "create_dir";
      path: string;
    }
  | {
      id: string;
      title: string;
      safety: SafetyClass;
      type: "write_file";
      path: string;
      content: string;
    }
  | {
      id: string;
      title: string;
      safety: SafetyClass;
      type: "replace_text";
      path: string;
      oldText: string;
      newText: string;
    }
  | {
      id: string;
      title: string;
      safety: SafetyClass;
      type: "run_verification";
      command: VerificationCommand;
    }
  | {
      id: string;
      title: string;
      safety: SafetyClass;
      type: "spawn_agent";
      agent: string;
      prompt: string;
      background?: boolean;
    };

export interface UpgradePlan {
  goal: string;
  summary: string;
  steps: PlanStep[];
  verification: VerificationCommand[];
}

export interface HarnessEvent {
  id: string;
  sessionId: string;
  createdAt: string;
  kind:
    | "session_started"
    | "context_built"
    | "memory_loaded"
    | "plan_created"
    | "step_started"
    | "step_applied"
    | "step_denied"
    | "agent_spawned"
    | "agent_completed"
    | "verification_started"
    | "verification_finished"
    | "proof_written"
    | "message_intervention"
    | "error";
  message: string;
  data?: JsonRecord;
}

export interface ExecutionReport {
  command: string;
  ok: boolean;
  code: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  blockedReason?: string;
}

export interface ProofReport {
  sessionId: string;
  turnId?: string;
  goal: string;
  status: "passed" | "failed" | "blocked" | "dry-run";
  summary: string;
  appliedSteps: string[];
  deniedSteps: string[];
  agentReports: AgentRunResult[];
  verification: ExecutionReport[];
  proofPath: string;
  turnArtifactPath?: string;
}

export interface ContextBundle {
  workspace: string;
  goal: string;
  messages: Message[];
  memories: MemoryRecord[];
  files: Array<{ path: string; summary: string }>;
  budget: { maxChars: number; usedChars: number };
}

export interface ProviderRequest {
  goal: string;
  systemPrompt: string;
  context: ContextBundle;
  tools: ToolDefinition[];
  agents: AgentDefinition[];
  messages: Message[];
}

export interface ProviderResponse {
  text: string;
  plan?: UpgradePlan;
  toolCalls?: ToolCall[];
}

export interface AgentRunRequest {
  agent: AgentDefinition;
  prompt: string;
  context: ContextBundle;
  messages: Message[];
}

export interface AgentRunResult {
  id: string;
  agentId: string;
  status: AgentStatus;
  summary: string;
  messages: Message[];
  startedAt: string;
  finishedAt?: string;
  metadata?: JsonRecord;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonRecord;
export interface JsonRecord {
  [key: string]: JsonValue;
}
