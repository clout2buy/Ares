import type { ToolDefinition, ToolStatus } from "@crix/protocol";

export type ToolCategory =
  | "context"
  | "edit"
  | "shell"
  | "verification"
  | "memory"
  | "agent"
  | "browser"
  | "web"
  | "task"
  | "skill"
  | "plugin"
  | "vcs"
  | "artifact"
  | "approval";

export interface CrixToolDefinition extends ToolDefinition {
  status: ToolStatus;
  category: ToolCategory;
  process: string;
  references: string[];
}

const COMMON_SAFE_READ = { safety: "read-only", concurrency: "parallel-safe" } as const;
const COMMON_WRITE = { safety: "workspace-write", concurrency: "exclusive" } as const;

export const CRIX_TOOL_CATALOG: CrixToolDefinition[] = [
  tool("read_file", "Read one or more workspace files with line metadata.", "context", "available", COMMON_SAFE_READ, { paths: "string[]", ranges: "optional line ranges" }, "context-scout", ["Claude Code", "Cursor", "Cline", "VSCode Agent"]),
  tool("read_partial_file", "Read targeted line ranges after a large file summary.", "context", "available", COMMON_SAFE_READ, { path: "string", startLine: "number", numberOfLines: "number" }, "context-scout", ["Traycer", "VSCode Agent"]),
  tool("list_dir", "List directory contents before deeper reads.", "context", "available", COMMON_SAFE_READ, { path: "string", recursive: "boolean" }, "context-scout", ["Claude Code", "Cursor", "Cline"]),
  tool("glob", "Find files by glob pattern.", "context", "available", COMMON_SAFE_READ, { pattern: "string", cwd: "string" }, "context-scout", ["Claude Code", "RooCode"]),
  tool("grep_search", "Fast exact-text or regex search across the workspace.", "context", "available", COMMON_SAFE_READ, { query: "string", includePattern: "string" }, "context-scout", ["Cursor", "Amp", "Traycer"]),
  tool("codebase_retrieval", "Retrieve semantically relevant code chunks for vague goals.", "context", "available", COMMON_SAFE_READ, { query: "string", maxResults: "number" }, "context-scout", ["Amp", "Cursor"]),
  tool("diagnostics", "Collect compiler, linter, or language-server diagnostics.", "verification", "available", COMMON_SAFE_READ, { paths: "string[]", severity: "string" }, "quality-gate", ["Amp", "VSCode Agent", "Traycer"]),
  tool("file_outline", "Extract symbol outlines for files or directories.", "context", "available", COMMON_SAFE_READ, { path: "string" }, "context-scout", ["Traycer", "VSCode Agent"]),
  tool("find_references", "Find references to a symbol using language-aware lookup.", "context", "available", COMMON_SAFE_READ, { symbol: "string", path: "string", line: "number" }, "context-scout", ["Traycer", "VSCode Agent"]),
  tool("go_to_definition", "Jump to a symbol definition using language-aware lookup.", "context", "available", COMMON_SAFE_READ, { symbol: "string", path: "string", line: "number" }, "context-scout", ["Traycer", "VSCode Agent"]),

  tool("create_dir", "Create a workspace directory with checkpoint metadata.", "edit", "available", COMMON_WRITE, { path: "string" }, "safe-edit-checkpoint", ["Claude Code", "Codex CLI"]),
  tool("write_file", "Write a workspace file with checkpointing.", "edit", "available", COMMON_WRITE, { path: "string", content: "string" }, "safe-edit-checkpoint", ["Claude Code", "Cursor", "Cline"]),
  tool("replace_text", "Replace a unique text span with checkpointing.", "edit", "available", COMMON_WRITE, { path: "string", oldText: "string", newText: "string" }, "safe-edit-checkpoint", ["Claude Code", "Cline", "Devin"]),
  tool("multi_edit", "Apply multiple ordered replacements to one file atomically.", "edit", "available", COMMON_WRITE, { path: "string", edits: "array" }, "safe-edit-checkpoint", ["Claude Code", "RooCode"]),
  tool("apply_patch", "Apply a unified patch with validation and rollback metadata.", "edit", "available", COMMON_WRITE, { patch: "string" }, "safe-edit-checkpoint", ["Codex CLI", "VSCode Agent"]),
  tool("remove_files", "Remove explicitly named workspace files after approval or safe policy check.", "edit", "available", { safety: "destructive", concurrency: "exclusive" }, { paths: "string[]" }, "safe-edit-checkpoint", ["Amp", "Cursor"]),

  tool("run_verification", "Run an allowlisted local verification command.", "verification", "available", { safety: "read-only", concurrency: "exclusive" }, { program: "string", args: "string[]" }, "quality-gate", ["Codex CLI", "VSCode Agent"]),
  tool("launch_process", "Start a long-running local process with captured output.", "shell", "available", { safety: "workspace-write", concurrency: "exclusive" }, { program: "string", args: "string[]", cwd: "string" }, "process-control", ["Amp", "Devin", "Manus"]),
  tool("read_process", "Read buffered output from a managed process.", "shell", "available", COMMON_SAFE_READ, { processId: "string" }, "process-control", ["Amp", "Devin", "Manus"]),
  tool("write_process", "Send input to a managed interactive process.", "shell", "available", { safety: "workspace-write", concurrency: "exclusive" }, { processId: "string", input: "string" }, "process-control", ["Amp", "Devin", "Manus"]),
  tool("kill_process", "Terminate a managed process started by Crix.", "shell", "available", { safety: "workspace-write", concurrency: "exclusive" }, { processId: "string" }, "process-control", ["Claude Code", "Amp", "Manus"]),
  tool("list_processes", "List Crix-managed background processes.", "shell", "available", COMMON_SAFE_READ, {}, "process-control", ["Amp", "Devin"]),

  tool("remember", "Store durable project memory with tags.", "memory", "available", { safety: "workspace-write", concurrency: "parallel-safe" }, { text: "string", tags: "string[]" }, "memory-capture", ["Amp", "Windsurf", "Manus"]),
  tool("memory_search", "Search durable Crix memories before planning.", "memory", "available", COMMON_SAFE_READ, { query: "string" }, "memory-capture", ["Amp", "Windsurf", "Manus"]),
  tool("memory_forget", "Remove or supersede stale memory records with audit trail.", "memory", "available", { safety: "workspace-write", concurrency: "exclusive" }, { id: "string", reason: "string" }, "memory-capture", ["Windsurf", "Manus"]),

  tool("spawn_agent", "Spawn a scoped Crix subagent role.", "agent", "available", COMMON_SAFE_READ, { agent: "string", prompt: "string" }, "subagent-split-review", ["Claude Code", "Cursor", "Same.dev"]),
  tool("wait_agent", "Wait for a background subagent and collect its result.", "agent", "available", COMMON_SAFE_READ, { runId: "string" }, "subagent-split-review", ["Claude Code", "Amp"]),
  tool("send_agent_input", "Send an intervention or new instruction to a running subagent.", "agent", "available", COMMON_SAFE_READ, { runId: "string", content: "string" }, "subagent-split-review", ["Claude Code", "Codex CLI"]),
  tool("cancel_agent", "Cancel a Crix-managed subagent run and persist its transcript.", "agent", "available", COMMON_SAFE_READ, { runId: "string", reason: "string" }, "subagent-split-review", ["Claude Code", "Codex CLI"]),
  tool("agent_notifications", "Read durable completion notifications for background and foreground subagent runs.", "agent", "available", COMMON_SAFE_READ, { limit: "number" }, "subagent-split-review", ["Claude Code", "Codex CLI"]),

  tool("tasklist_view", "View the active task list for a run.", "task", "available", COMMON_SAFE_READ, {}, "tasklist-control", ["Amp", "VSCode Agent"]),
  tool("tasklist_add", "Add scoped tasks with status and ownership.", "task", "available", { safety: "workspace-write", concurrency: "parallel-safe" }, { tasks: "array" }, "tasklist-control", ["Amp", "VSCode Agent"]),
  tool("tasklist_update", "Update task status as the run progresses.", "task", "available", { safety: "workspace-write", concurrency: "parallel-safe" }, { taskId: "string", status: "string" }, "tasklist-control", ["Amp", "VSCode Agent"]),

  tool("browser_open", "Open a local or web target for smoke testing.", "browser", "available", { safety: "external-state", concurrency: "exclusive" }, { url: "string" }, "browser-runtime-qa", ["Manus", "Replit", "v0"]),
  tool("browser_snapshot", "Capture screenshot, console errors, and page state.", "browser", "available", COMMON_SAFE_READ, { target: "string" }, "browser-runtime-qa", ["Manus", "Replit", "v0"]),
  tool("browser_console", "Read or execute browser console commands during QA.", "browser", "available", { safety: "workspace-write", concurrency: "exclusive" }, { target: "string", script: "string" }, "browser-runtime-qa", ["Manus", "Replit"]),

  tool("web_search", "Search the web when current external information is required.", "web", "available", { safety: "external-state", concurrency: "parallel-safe" }, { query: "string" }, "external-research", ["Amp", "Manus", "Perplexity"]),
  tool("web_fetch", "Fetch a URL for documentation or source inspection.", "web", "available", { safety: "external-state", concurrency: "parallel-safe" }, { url: "string" }, "external-research", ["Amp", "Claude Code"]),

  tool("skill_list", "List installed Crix skills and their triggers.", "skill", "available", COMMON_SAFE_READ, {}, "skill-orchestration", ["Kiro", "Amp", "Claude Code"]),
  tool("skill_load", "Load one skill process into the active prompt context.", "skill", "available", COMMON_SAFE_READ, { skill: "string" }, "skill-orchestration", ["Kiro", "Amp", "Claude Code"]),
  tool("skill_run", "Run a skill-defined local workflow with proof capture.", "skill", "available", { safety: "workspace-write", concurrency: "exclusive" }, { skill: "string", input: "object" }, "skill-orchestration", ["Kiro", "Amp", "Claude Code"]),

  tool("plugin_list", "List installed workspace/user plugins and marketplace manifests.", "plugin", "available", COMMON_SAFE_READ, {}, "plugin-marketplace", ["Claude Code", "Kiro", "VSCode Agent"]),
  tool("mcp_list", "List MCP server declarations exposed by installed plugins.", "plugin", "available", COMMON_SAFE_READ, {}, "plugin-marketplace", ["Claude Code", "Cursor", "VSCode Agent"]),
  tool("mcp_tools", "Initialize a stdio MCP server and list its exposed tools.", "plugin", "available", { safety: "external-state", concurrency: "exclusive" }, { server: "string" }, "mcp-runtime", ["Claude Code", "Cursor"]),
  tool("mcp_call", "Call a tool on a configured stdio MCP server through JSON-RPC.", "plugin", "available", { safety: "external-state", concurrency: "exclusive" }, { server: "string", tool: "string", input: "object" }, "mcp-runtime", ["Claude Code", "Cursor"]),
  tool("mcp_resources", "Initialize a stdio MCP server and list resources.", "plugin", "available", { safety: "external-state", concurrency: "exclusive" }, { server: "string" }, "mcp-runtime", ["Claude Code", "Cursor"]),
  tool("mcp_read_resource", "Read one resource from a configured stdio MCP server.", "plugin", "available", { safety: "external-state", concurrency: "exclusive" }, { server: "string", uri: "string" }, "mcp-runtime", ["Claude Code", "Cursor"]),

  tool("git_status", "Read repository status without mutating remotes.", "vcs", "available", COMMON_SAFE_READ, {}, "repo-state-control", ["Codex CLI", "Cursor"]),
  tool("git_diff", "Read unstaged/staged diffs for review and proof.", "vcs", "available", COMMON_SAFE_READ, { path: "string" }, "repo-state-control", ["Codex CLI", "Cursor"]),
  tool("git_commit_retrieval", "Retrieve local commit history relevant to a change.", "vcs", "available", COMMON_SAFE_READ, { query: "string" }, "repo-state-control", ["Amp"]),

  tool("render_mermaid", "Render a Mermaid diagram for architecture or flow proof.", "artifact", "available", { safety: "workspace-write", concurrency: "parallel-safe" }, { diagram: "string", out: "string" }, "artifact-proof", ["Amp", "Qoder"]),
  tool("proof_report", "Write a structured proof report for the current run.", "artifact", "available", { safety: "workspace-write", concurrency: "exclusive" }, { summary: "string" }, "artifact-proof", ["Codex CLI", "Kiro"]),
  tool("request_approval", "Ask the user before external-state, credential, destructive, or ambiguous actions.", "approval", "available", COMMON_SAFE_READ, { reason: "string", action: "string" }, "approval-gate", ["Codex CLI", "Claude Code", "Replit"]),
];

export function availableTools(): CrixToolDefinition[] {
  return CRIX_TOOL_CATALOG;
}

export function toolCatalogSummary(tools: CrixToolDefinition[] = CRIX_TOOL_CATALOG): string {
  return tools
    .map((toolDef) => `- ${toolDef.name} [${toolDef.status}/${toolDef.category}/${toolDef.safety}]: ${toolDef.description}`)
    .join("\n");
}

export function toolBacklogSummary(tools: CrixToolDefinition[] = CRIX_TOOL_CATALOG): string {
  if (tools.every((toolDef) => toolDef.status === "available")) return "";
  return tools.map((toolDef) => `- ${toolDef.name} [${toolDef.status}]: build via ${toolDef.process}`).join("\n");
}

function tool(
  name: string,
  description: string,
  category: ToolCategory,
  status: ToolStatus,
  safetyConcurrency: Pick<ToolDefinition, "safety" | "concurrency">,
  inputSchema: ToolDefinition["inputSchema"],
  process: string,
  references: string[],
): CrixToolDefinition {
  return {
    name,
    description,
    category,
    status,
    safety: safetyConcurrency.safety,
    concurrency: safetyConcurrency.concurrency,
    inputSchema,
    process,
    references,
  };
}

