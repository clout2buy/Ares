import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, JsonRecord, JsonValue, PermissionMode, PermissionPromptDecision, ToolResult, VerificationCommand, WorkspaceGrant } from "@crix/protocol";
import { AgentOrchestrator } from "./agents.js";
import { ContextBuilder } from "./context.js";
import { ReversibleEditor } from "./editor.js";
import { MemoryStore } from "./memory.js";
import { McpStdioClient, type McpServerDeclaration } from "./mcpClient.js";
import { PluginMarketplace } from "./pluginMarketplace.js";
import { SafetyPolicy } from "./policy.js";
import { defaultAgents, MockProvider, type ModelProvider } from "./provider.js";
import { analyzeShellCommand } from "./shellSafety.js";
import { CRIX_SKILL_PROCESSES } from "./skillProcesses.js";
import { CRIX_TOOL_CATALOG, type CrixToolDefinition } from "./toolCatalog.js";
import { resolveInside, resolveWorkspace, toRelative } from "./paths.js";
import { ShellExecutor } from "./executor.js";
import { id, nowIso, scoreText, tail } from "./util.js";

const IGNORE_DIRS = new Set(["node_modules", ".git", ".crix", "dist", "build", "target", ".next", "coverage"]);
const TEXT_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|java|xml|html|css|scss|yaml|yml|toml|ps1|bat|cmd|sh|py|rs|go|c|cpp|h|hpp)$/i;

interface RuntimeProcess {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  startedAt: string;
  exitedAt?: string;
  code?: number | null;
}

export interface ToolRuntimeOptions {
  permissionMode?: PermissionMode;
  allowExternal?: boolean;
  allowDestructive?: boolean;
  provider?: ModelProvider;
  agents?: AgentDefinition[];
  permissionPrompt?: ToolPermissionPrompt;
  workspaceGrants?: WorkspaceGrant[];
  approvalPersistence?: "once" | "session";
  readPolicy?: "workspace-only" | "explicit-path-broad";
}

export interface ToolPermissionRequest {
  toolName: string;
  safety: string;
  reason: string;
  workspace: string;
  input: JsonRecord;
}

export type ToolPermissionPrompt = (request: ToolPermissionRequest) => Promise<boolean | PermissionPromptDecision>;

export class ToolRuntime {
  private static readonly processes = new Map<string, RuntimeProcess>();
  private readonly policy: SafetyPolicy;
  private readonly provider: ModelProvider;
  private readonly agents: AgentDefinition[];
  private readonly orchestrator: AgentOrchestrator;
  private readonly sessionApprovals = new Set<string>();

  private constructor(
    private readonly workspace: string,
    private readonly options: Required<Pick<ToolRuntimeOptions, "permissionMode" | "allowExternal" | "allowDestructive" | "approvalPersistence" | "readPolicy">> & Pick<ToolRuntimeOptions, "provider" | "agents" | "permissionPrompt" | "workspaceGrants">,
  ) {
    this.policy = new SafetyPolicy(options.permissionMode);
    this.provider = options.provider ?? new MockProvider();
    this.agents = options.agents ?? defaultAgents();
    this.orchestrator = new AgentOrchestrator(this.provider, this.agents, CRIX_TOOL_CATALOG, async (name, input) => await this.execute(name, input), this.workspace);
  }

  static async create(workspace: string, options: ToolRuntimeOptions = {}): Promise<ToolRuntime> {
    return new ToolRuntime(await resolveWorkspace(workspace), {
      permissionMode: options.permissionMode ?? "workspace-write",
      allowExternal: options.allowExternal ?? false,
      allowDestructive: options.allowDestructive ?? false,
      provider: options.provider,
      agents: options.agents,
      permissionPrompt: options.permissionPrompt,
      workspaceGrants: options.workspaceGrants ?? [],
      approvalPersistence: options.approvalPersistence ?? "once",
      readPolicy: options.readPolicy ?? "workspace-only",
    });
  }

  listTools(): CrixToolDefinition[] {
    return CRIX_TOOL_CATALOG;
  }

  async execute(name: string, input: JsonRecord = {}): Promise<ToolResult> {
    const tool = CRIX_TOOL_CATALOG.find((candidate) => candidate.name === name);
    if (!tool) return this.result(name, false, `unknown tool ${name}`);
    const gate = await this.gate(tool, input);
    if (gate) return this.result(name, false, gate, { safety: tool.safety });

    try {
      switch (name) {
        case "read_file":
          return await this.readFileTool(input);
        case "read_partial_file":
          return await this.readPartialFileTool(input);
        case "list_dir":
          return await this.listDirTool(input);
        case "glob":
          return await this.globTool(input);
        case "grep_search":
          return await this.grepTool(input);
        case "codebase_retrieval":
          return await this.codebaseRetrievalTool(input);
        case "diagnostics":
          return await this.diagnosticsTool(input);
        case "file_outline":
          return await this.fileOutlineTool(input);
        case "find_references":
          return await this.findReferencesTool(input);
        case "go_to_definition":
          return await this.goToDefinitionTool(input);
        case "create_dir":
          return await this.createDirTool(input);
        case "write_file":
          return await this.writeFileTool(input);
        case "replace_text":
          return await this.replaceTextTool(input);
        case "multi_edit":
          return await this.multiEditTool(input);
        case "apply_patch":
          return await this.applyPatchTool(input);
        case "remove_files":
          return await this.removeFilesTool(input);
        case "run_verification":
          return await this.runVerificationTool(input);
        case "launch_process":
          return await this.launchProcessTool(input);
        case "read_process":
          return this.readProcessTool(input);
        case "write_process":
          return this.writeProcessTool(input);
        case "kill_process":
          return this.killProcessTool(input);
        case "list_processes":
          return this.listProcessesTool();
        case "remember":
          return await this.rememberTool(input);
        case "memory_search":
          return await this.memorySearchTool(input);
        case "memory_forget":
          return await this.memoryForgetTool(input);
        case "spawn_agent":
          return await this.spawnAgentTool(input);
        case "wait_agent":
          return await this.waitAgentTool(input);
        case "send_agent_input":
          return await this.sendAgentInputTool(input);
        case "cancel_agent":
          return await this.cancelAgentTool(input);
        case "agent_notifications":
          return await this.agentNotificationsTool(input);
        case "tasklist_view":
          return await this.tasklistViewTool();
        case "tasklist_add":
          return await this.tasklistAddTool(input);
        case "tasklist_update":
          return await this.tasklistUpdateTool(input);
        case "browser_open":
          return await this.browserOpenTool(input);
        case "browser_snapshot":
          return await this.browserSnapshotTool(input);
        case "browser_console":
          return await this.browserConsoleTool(input);
        case "web_search":
          return await this.webSearchTool(input);
        case "web_fetch":
          return await this.webFetchTool(input);
        case "skill_list":
          return this.result(name, true, JSON.stringify(CRIX_SKILL_PROCESSES, null, 2));
        case "skill_load":
          return this.skillLoadTool(input);
        case "skill_run":
          return this.skillRunTool(input);
        case "plugin_list":
          return await this.pluginListTool();
        case "mcp_list":
          return await this.mcpListTool();
        case "mcp_tools":
          return await this.mcpToolsTool(input);
        case "mcp_call":
          return await this.mcpCallTool(input);
        case "mcp_resources":
          return await this.mcpResourcesTool(input);
        case "mcp_read_resource":
          return await this.mcpReadResourceTool(input);
        case "git_status":
          return await this.gitTool(name, ["status", "--short", "--branch"]);
        case "git_diff":
          return await this.gitTool(name, ["diff", ...optionalPathArgs(input)]);
        case "git_commit_retrieval":
          return await this.gitCommitRetrievalTool(input);
        case "render_mermaid":
          return await this.renderMermaidTool(input);
        case "proof_report":
          return await this.proofReportTool(input);
        case "request_approval":
          return this.requestApprovalTool(input);
        default:
          return this.result(name, false, `tool ${name} has no executor`);
      }
    } catch (error) {
      return this.result(name, false, (error as Error).message);
    }
  }

  private async gate(tool: CrixToolDefinition, input: JsonRecord): Promise<string | undefined> {
    if (tool.safety === "external-state" && !this.options.allowExternal) {
      return await this.requestPermission(tool, input, `${tool.name} requires explicit external access approval`);
    }
    if (tool.safety === "destructive" && !this.options.allowDestructive) {
      return await this.requestPermission(tool, input, `${tool.name} requires explicit destructive-action approval`);
    }
    if (tool.safety === "external-state" && this.options.allowExternal) return undefined;
    if (tool.safety === "destructive" && this.options.allowDestructive) return undefined;
    const decision = this.policy.evaluateSafety(tool.safety);
    if (decision.allowed) return undefined;
    return await this.requestPermission(tool, input, decision.reason);
  }

  private async requestPermission(tool: CrixToolDefinition, input: JsonRecord, reason: string): Promise<string | undefined> {
    const key = permissionKey(tool, input);
    if (this.sessionApprovals.has(key)) return undefined;
    if (!this.options.permissionPrompt) return reason;
    const decision = await this.options.permissionPrompt({ toolName: tool.name, safety: tool.safety, reason, workspace: this.workspace, input });
    if (decision === true || decision === "allow-once") {
      if (decision === true && this.options.approvalPersistence === "session") this.sessionApprovals.add(key);
      return undefined;
    }
    if (decision === "allow-session") {
      this.sessionApprovals.add(key);
      return undefined;
    }
    return reason;
  }

  private resolveReadPath(requested: string): string {
    if (!path.isAbsolute(requested)) return resolveInside(this.workspace, requested);
    const candidate = path.resolve(requested);
    const workspaceRelative = path.relative(this.workspace, candidate);
    if (!workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative)) return candidate;
    if (this.options.readPolicy !== "explicit-path-broad") throw new Error(`path escapes workspace: ${requested}`);
    const grant = (this.options.workspaceGrants ?? []).find((item) => item.read && isInsideRoot(candidate, item.root));
    if (!grant) throw new Error(`read path is outside granted workspaces: ${requested}`);
    return candidate;
  }

  private displayPath(resolved: string, requested?: string): string {
    if (requested && !path.isAbsolute(requested)) return requested;
    const relative = path.relative(this.workspace, resolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative || ".";
    return resolved;
  }

  private async readFileTool(input: JsonRecord): Promise<ToolResult> {
    const paths = inputStringArray(input, "paths", inputString(input, "path"));
    const out = [];
    for (const item of paths) {
      const resolved = this.resolveReadPath(item);
      const text = await readFile(resolved, "utf8");
      out.push({ path: this.displayPath(resolved, item), content: applyLineRange(text, numberInput(input, "startLine"), numberInput(input, "endLine")) });
    }
    return this.result("read_file", true, JSON.stringify(out, null, 2));
  }

  private async readPartialFileTool(input: JsonRecord): Promise<ToolResult> {
    const target = inputString(input, "path", true);
    const start = numberInput(input, "startLine") ?? 1;
    const count = numberInput(input, "numberOfLines") ?? 200;
    const text = await readFile(this.resolveReadPath(target), "utf8");
    return this.result("read_partial_file", true, applyLineRange(text, start, start + count - 1));
  }

  private async listDirTool(input: JsonRecord): Promise<ToolResult> {
    const target = inputString(input, "path") ?? ".";
    const recursive = booleanInput(input, "recursive") ?? false;
    const root = this.resolveReadPath(target);
    const rows: JsonRecord[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const info = await stat(full);
        rows.push({ path: this.displayPath(full), type: entry.isDirectory() ? "dir" : "file", size: info.size });
        if (recursive && entry.isDirectory() && depth < 8) await visit(full, depth + 1);
      }
    };
    await visit(root, 0);
    return this.result("list_dir", true, JSON.stringify(rows, null, 2));
  }

  private async globTool(input: JsonRecord): Promise<ToolResult> {
    const pattern = inputString(input, "pattern", true);
    const cwd = this.resolveReadPath(inputString(input, "cwd") ?? ".");
    const regex = globToRegExp(pattern);
    const files = await this.walk(cwd);
    return this.result("glob", true, JSON.stringify(files.map((file) => this.displayPath(file).replaceAll("\\", "/")).filter((file) => regex.test(file)), null, 2));
  }

  private async grepTool(input: JsonRecord): Promise<ToolResult> {
    const query = inputString(input, "regex") ?? inputString(input, "query", true);
    const include = inputString(input, "includePattern");
    const regex = new RegExp(query, booleanInput(input, "ignoreCase") === false ? "g" : "gi");
    const includeRegex = include ? globToRegExp(include) : undefined;
    const matches: JsonRecord[] = [];
    for (const file of await this.walk(this.workspace)) {
      const relative = toRelative(this.workspace, file).replaceAll("\\", "/");
      if (includeRegex && !includeRegex.test(relative)) continue;
      if (!TEXT_FILE.test(file)) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      const lines = text.split(/\r?\n/g);
      for (let index = 0; index < lines.length; index += 1) {
        if (regex.test(lines[index]!)) matches.push({ path: relative, line: index + 1, text: lines[index]!.slice(0, 500) });
        regex.lastIndex = 0;
        if (matches.length >= 80) return this.result("grep_search", true, JSON.stringify(matches, null, 2));
      }
    }
    return this.result("grep_search", true, JSON.stringify(matches, null, 2));
  }

  private async codebaseRetrievalTool(input: JsonRecord): Promise<ToolResult> {
    const query = inputString(input, "query", true);
    const maxResults = numberInput(input, "maxResults") ?? 8;
    const scored = [];
    for (const file of await this.walk(this.workspace)) {
      if (!TEXT_FILE.test(file)) continue;
      const text = await readFile(file, "utf8").catch(() => "");
      const score = scoreText(query, `${toRelative(this.workspace, file)} ${text.slice(0, 20_000)}`);
      if (score > 0) scored.push({ path: toRelative(this.workspace, file), score, preview: text.slice(0, 1000) });
    }
    scored.sort((a, b) => b.score - a.score);
    return this.result("codebase_retrieval", true, JSON.stringify(scored.slice(0, maxResults), null, 2));
  }

  private async diagnosticsTool(input: JsonRecord): Promise<ToolResult> {
    const packageJson = path.join(this.workspace, "package.json");
    if (existsSync(packageJson)) {
      const pkg = JSON.parse(await readFile(packageJson, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.check) return this.executionToResult("diagnostics", await new ShellExecutor(this.workspace).verify({ program: "pnpm", args: ["check"], timeoutMs: numberInput(input, "timeoutMs") ?? 120_000 }));
    }
    const files = inputStringArray(input, "paths");
    const reports = [];
    for (const file of files.filter((item) => /\.(js|mjs|cjs)$/i.test(item))) {
      reports.push(await new ShellExecutor(this.workspace).verify({ program: "node", args: ["--check", file], timeoutMs: 120_000 }));
    }
    return this.result("diagnostics", reports.every((report) => report.ok), JSON.stringify(reports, null, 2));
  }

  private async fileOutlineTool(input: JsonRecord): Promise<ToolResult> {
    const target = this.resolveReadPath(inputString(input, "path") ?? ".");
    const files = (await stat(target)).isDirectory() ? (await this.walk(target)).filter((file) => TEXT_FILE.test(file)).slice(0, 40) : [target];
    const outlines = [];
    const pattern = /^\s*(export\s+)?(class|interface|type|function|const|let|var|async function)\s+([A-Za-z0-9_$]+)/gm;
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      const symbols = [...text.matchAll(pattern)].map((match) => ({ kind: match[2], name: match[3] }));
      outlines.push({ path: this.displayPath(file), symbols });
    }
    return this.result("file_outline", true, JSON.stringify(outlines, null, 2));
  }

  private async findReferencesTool(input: JsonRecord): Promise<ToolResult> {
    const symbol = inputString(input, "symbol", true);
    return await this.grepTool({ regex: `\\b${escapeRegExp(symbol)}\\b`, includePattern: inputString(input, "includePattern") ?? "**/*" });
  }

  private async goToDefinitionTool(input: JsonRecord): Promise<ToolResult> {
    const symbol = inputString(input, "symbol", true);
    const regex = `\\b(class|interface|type|function|const|let|var)\\s+${escapeRegExp(symbol)}\\b|\\b${escapeRegExp(symbol)}\\s*[:=]\\s*`;
    return await this.grepTool({ regex, includePattern: inputString(input, "includePattern") ?? "**/*" });
  }

  private async writeFileTool(input: JsonRecord): Promise<ToolResult> {
    const editor = await this.editor("write_file");
    const result = await editor.writeFile(inputString(input, "path", true), inputString(input, "content") ?? "");
    return this.result("write_file", true, result.message, { checkpointDir: result.checkpointDir });
  }

  private async createDirTool(input: JsonRecord): Promise<ToolResult> {
    const editor = await this.editor("create_dir");
    const result = await editor.createDir(inputString(input, "path", true));
    return this.result("create_dir", true, result.message, { checkpointDir: result.checkpointDir });
  }

  private async replaceTextTool(input: JsonRecord): Promise<ToolResult> {
    const editor = await this.editor("replace_text");
    const result = await editor.replaceText(inputString(input, "path", true), inputString(input, "oldText", true), inputString(input, "newText") ?? "");
    return this.result("replace_text", true, result.message, { checkpointDir: result.checkpointDir });
  }

  private async multiEditTool(input: JsonRecord): Promise<ToolResult> {
    const target = inputString(input, "path", true);
    const edits = arrayInput(input, "edits");
    const editor = await this.editor("multi_edit");
    const normalized = edits.map((edit) => {
      const item = recordInput(edit);
      return { oldText: inputString(item, "oldText", true), newText: inputString(item, "newText") ?? "" };
    });
    const result = await editor.multiReplaceText(target, normalized);
    return this.result("multi_edit", true, result.message, { checkpointDir: result.checkpointDir });
  }

  private async applyPatchTool(input: JsonRecord): Promise<ToolResult> {
    const directPath = inputString(input, "path");
    if (directPath) {
      return await this.replaceTextTool({ path: directPath, oldText: inputString(input, "oldText", true), newText: inputString(input, "newText") ?? "" });
    }
    const patch = inputString(input, "patch", true);
    const messages = await this.applySimplePatch(patch);
    return this.result("apply_patch", true, messages.join("\n"));
  }

  private async removeFilesTool(input: JsonRecord): Promise<ToolResult> {
    const paths = inputStringArray(input, "paths", inputString(input, "path"));
    const checkpointDir = await this.checkpointDir("remove_files");
    const manifest: Array<{ file: string; backup: string; existed: boolean }> = [];
    await mkdir(path.join(checkpointDir, "files"), { recursive: true });
    for (const item of paths) {
      const resolved = resolveInside(this.workspace, item);
      const backup = path.join(checkpointDir, "files", `${manifest.length}.bak`);
      let existed = true;
      try {
        await copyFile(resolved, backup);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
        await writeFile(backup, "", "utf8");
      }
      manifest.push({ file: resolved, backup, existed });
      await rm(resolved, { recursive: true, force: true });
    }
    await writeFile(path.join(checkpointDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return this.result("remove_files", true, `removed ${paths.length} path(s)`, { checkpointDir });
  }

  private async runVerificationTool(input: JsonRecord): Promise<ToolResult> {
    const command = commandInput(input);
    return this.executionToResult("run_verification", await new ShellExecutor(this.workspace).verify(command));
  }

  private async launchProcessTool(input: JsonRecord): Promise<ToolResult> {
    const command = commandInput(input);
    assertSafeProgram(command.program, command.args);
    if (booleanInput(input, "background")) {
      const cwd = command.cwd ? resolveInside(this.workspace, command.cwd) : this.workspace;
      const spawnTarget = resolveProcessSpawnTarget(command.program, command.args);
      const child = spawn(spawnTarget.program, spawnTarget.args, { cwd, shell: false, stdio: "pipe" });
      const processId = id("proc");
      const record: RuntimeProcess = { id: processId, child, command: [command.program, ...command.args].join(" "), cwd, stdout: "", stderr: "", startedAt: nowIso() };
      child.stdout.on("data", (chunk) => { record.stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { record.stderr += chunk.toString(); });
      child.on("close", (code) => { record.code = code; record.exitedAt = nowIso(); });
      ToolRuntime.processes.set(processId, record);
      return this.result("launch_process", true, `started ${processId}`, { processId, pid: child.pid ?? null });
    }
    return this.executionToResult("launch_process", await runRaw(this.workspace, command, numberInput(input, "timeoutMs") ?? 120_000));
  }

  private readProcessTool(input: JsonRecord): ToolResult {
    const processId = inputString(input, "processId", true);
    const record = ToolRuntime.processes.get(processId);
    if (!record) return this.result("read_process", false, `unknown process ${processId}`);
    return this.result("read_process", true, JSON.stringify(processSnapshot(record), null, 2));
  }

  private writeProcessTool(input: JsonRecord): ToolResult {
    const processId = inputString(input, "processId", true);
    const record = ToolRuntime.processes.get(processId);
    if (!record) return this.result("write_process", false, `unknown process ${processId}`);
    if (!record.child.stdin.writable) return this.result("write_process", false, `stdin is closed for ${processId}`);
    record.child.stdin.write(inputString(input, "input") ?? "");
    if (booleanInput(input, "pressEnter")) record.child.stdin.write(os.EOL);
    return this.result("write_process", true, `wrote input to ${processId}`);
  }

  private killProcessTool(input: JsonRecord): ToolResult {
    const processId = inputString(input, "processId", true);
    const record = ToolRuntime.processes.get(processId);
    if (!record) return this.result("kill_process", false, `unknown process ${processId}`);
    record.child.kill();
    ToolRuntime.processes.delete(processId);
    return this.result("kill_process", true, `killed ${processId}`);
  }

  private listProcessesTool(): ToolResult {
    return this.result("list_processes", true, JSON.stringify([...ToolRuntime.processes.values()].map(processSnapshot), null, 2));
  }

  private async rememberTool(input: JsonRecord): Promise<ToolResult> {
    const memory = await new MemoryStore(this.workspace).remember(inputString(input, "text", true), inputStringArray(input, "tags"), "project", "tool_runtime");
    return this.result("remember", true, JSON.stringify(memory, null, 2), { memoryId: memory.id });
  }

  private async memorySearchTool(input: JsonRecord): Promise<ToolResult> {
    const rows = await new MemoryStore(this.workspace).search(inputString(input, "query") ?? "", numberInput(input, "limit") ?? 8);
    return this.result("memory_search", true, JSON.stringify(rows, null, 2));
  }

  private async memoryForgetTool(input: JsonRecord): Promise<ToolResult> {
    const result = await new MemoryStore(this.workspace).forget(inputString(input, "id", true), inputString(input, "reason") ?? "superseded");
    return this.result("memory_forget", result.removed, JSON.stringify(result, null, 2), { memoryId: result.tombstone.id });
  }

  private async spawnAgentTool(input: JsonRecord): Promise<ToolResult> {
    const agentId = inputString(input, "agent", true);
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return this.result("spawn_agent", false, `unknown agent ${agentId}`);
    const prompt = inputString(input, "prompt") ?? "";
    const context = await new ContextBuilder(this.workspace, new MemoryStore(this.workspace)).build(prompt, [], numberInput(input, "contextChars") ?? 16_000);
    const report = await this.orchestrator.spawn({ agent, prompt, context, messages: [] }, booleanInput(input, "background") ?? false);
    return this.result("spawn_agent", true, JSON.stringify(report, null, 2), { runId: report.id });
  }

  private async waitAgentTool(input: JsonRecord): Promise<ToolResult> {
    const report = await this.orchestrator.wait(inputString(input, "runId", true));
    return this.result("wait_agent", true, JSON.stringify(report, null, 2));
  }

  private async sendAgentInputTool(input: JsonRecord): Promise<ToolResult> {
    await this.orchestrator.sendInput(inputString(input, "runId", true), inputString(input, "content", true));
    return this.result("send_agent_input", true, "input sent");
  }

  private async cancelAgentTool(input: JsonRecord): Promise<ToolResult> {
    const report = await this.orchestrator.cancel(inputString(input, "runId", true), inputString(input, "reason") ?? "cancelled by user");
    return this.result("cancel_agent", true, JSON.stringify(report, null, 2), { runId: report.id, transcriptPath: report.metadata?.transcriptPath ?? null });
  }

  private async agentNotificationsTool(input: JsonRecord): Promise<ToolResult> {
    const rows = await AgentOrchestrator.listNotifications(this.workspace, numberInput(input, "limit") ?? 20);
    return this.result("agent_notifications", true, JSON.stringify(rows, null, 2));
  }

  private async tasklistViewTool(): Promise<ToolResult> {
    return this.result("tasklist_view", true, JSON.stringify(await this.readTasks(), null, 2));
  }

  private async tasklistAddTool(input: JsonRecord): Promise<ToolResult> {
    const tasks = await this.readTasks();
    const incoming = arrayInput(input, "tasks").map((task) => recordInput(task));
    for (const task of incoming) tasks.push({ id: inputString(task, "id") ?? id("task"), title: inputString(task, "title", true), status: inputString(task, "status") ?? "pending", owner: inputString(task, "owner") ?? "main", createdAt: nowIso(), updatedAt: nowIso() });
    await this.writeTasks(tasks);
    return this.result("tasklist_add", true, JSON.stringify(tasks, null, 2));
  }

  private async tasklistUpdateTool(input: JsonRecord): Promise<ToolResult> {
    const tasks = await this.readTasks();
    const taskId = inputString(input, "taskId", true);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) return this.result("tasklist_update", false, `unknown task ${taskId}`);
    task.status = inputString(input, "status") ?? task.status;
    task.owner = inputString(input, "owner") ?? task.owner;
    task.updatedAt = nowIso();
    await this.writeTasks(tasks);
    return this.result("tasklist_update", true, JSON.stringify(task, null, 2));
  }

  private async browserOpenTool(input: JsonRecord): Promise<ToolResult> {
    const url = inputString(input, "url", true);
    assertSafeBrowserTarget(url, this.workspace);
    if (process.env.CRIX_DISABLE_BROWSER_OPEN === "1") return this.result("browser_open", true, `browser open disabled; would open ${url}`);
    openBrowser(url);
    return this.result("browser_open", true, `opened ${url}`);
  }

  private async browserSnapshotTool(input: JsonRecord): Promise<ToolResult> {
    const url = inputString(input, "url") ?? inputString(input, "target", true);
    const artifacts = await this.artifactDir("browser");
    const base = path.join(artifacts, safeName(`snapshot_${Date.now()}`));
    const screenshot = `${base}.png`;
    const htmlPath = `${base}.html`;
    const chrome = findChrome();
    const report = await runRaw(this.workspace, {
      program: chrome,
      args: ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--window-size=${inputString(input, "windowSize") ?? "1365,900"}`, `--screenshot=${screenshot}`, "--dump-dom", url],
      timeoutMs: numberInput(input, "timeoutMs") ?? 45_000,
    }, numberInput(input, "timeoutMs") ?? 45_000);
    await writeFile(htmlPath, report.stdoutTail, "utf8");
    return this.result("browser_snapshot", report.ok, JSON.stringify({ url, screenshot, htmlPath, stderr: report.stderrTail }, null, 2), { screenshot, htmlPath });
  }

  private async browserConsoleTool(input: JsonRecord): Promise<ToolResult> {
    const url = inputString(input, "url") ?? inputString(input, "target", true);
    const expression = inputString(input, "script") ?? "document.title";
    const value = await evaluateInChrome(url, expression, numberInput(input, "timeoutMs") ?? 30_000);
    return this.result("browser_console", true, JSON.stringify(value, null, 2));
  }

  private async webSearchTool(input: JsonRecord): Promise<ToolResult> {
    const query = encodeURIComponent(inputString(input, "query", true));
    const endpoint = (inputString(input, "endpoint") ?? process.env.CRIX_WEB_SEARCH_URL ?? "https://duckduckgo.com/html/").replace(/[?&]$/, "");
    const response = await fetch(`${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${query}`);
    const text = await response.text();
    const matches = [...text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 8).map((match) => ({ url: decodeHtml(match[1] ?? ""), title: stripTags(match[2] ?? "") }));
    return this.result("web_search", response.ok, JSON.stringify(matches, null, 2));
  }

  private async webFetchTool(input: JsonRecord): Promise<ToolResult> {
    const url = inputString(input, "url", true);
    const response = await fetch(url);
    const text = await response.text();
    return this.result("web_fetch", response.ok, tail(text, numberInput(input, "maxChars") ?? 20_000), { status: response.status });
  }

  private skillLoadTool(input: JsonRecord): ToolResult {
    const skill = inputString(input, "skill", true);
    const process = CRIX_SKILL_PROCESSES.find((candidate) => candidate.id === skill);
    if (!process) return this.result("skill_load", false, `unknown skill ${skill}`);
    return this.result("skill_load", true, JSON.stringify(process, null, 2));
  }

  private skillRunTool(input: JsonRecord): ToolResult {
    const skill = inputString(input, "skill", true);
    const process = CRIX_SKILL_PROCESSES.find((candidate) => candidate.id === skill);
    if (!process) return this.result("skill_run", false, `unknown skill ${skill}`);
    return this.result("skill_run", true, JSON.stringify({ skill: process.id, steps: process.steps, proofRequired: process.proof, input: input.input ?? null }, null, 2));
  }

  private async pluginListTool(): Promise<ToolResult> {
    const plugins = await new PluginMarketplace({ workspace: this.workspace }).list();
    return this.result("plugin_list", true, JSON.stringify(plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version ?? null,
      enabled: plugin.enabled,
      source: plugin.source,
      root: plugin.root,
      skills: plugin.skills,
      mcpServers: plugin.mcpServers,
      tools: plugin.tools,
      description: plugin.description ?? "",
    })), null, 2));
  }

  private async mcpListTool(): Promise<ToolResult> {
    const marketplace = new PluginMarketplace({ workspace: this.workspace });
    const servers = await marketplace.mcpServerConfigs();
    if (servers.length > 0) {
      return this.result("mcp_list", true, JSON.stringify(servers.map(mcpServerSummary), null, 2));
    }
    return this.result("mcp_list", true, JSON.stringify(await marketplace.mcpServers(), null, 2));
  }

  private async mcpToolsTool(input: JsonRecord): Promise<ToolResult> {
    const server = await this.resolveMcpServer(input);
    const response = await new McpStdioClient(server, mcpOptions(input)).listTools();
    return this.mcpResponseResult("mcp_tools", server, response);
  }

  private async mcpResourcesTool(input: JsonRecord): Promise<ToolResult> {
    const server = await this.resolveMcpServer(input);
    const response = await new McpStdioClient(server, mcpOptions(input)).listResources();
    return this.mcpResponseResult("mcp_resources", server, response);
  }

  private async mcpReadResourceTool(input: JsonRecord): Promise<ToolResult> {
    const server = await this.resolveMcpServer(input);
    const uri = inputString(input, "uri", true);
    const response = await new McpStdioClient(server, mcpOptions(input)).readResource(uri);
    return this.mcpResponseResult("mcp_read_resource", server, response);
  }

  private async mcpCallTool(input: JsonRecord): Promise<ToolResult> {
    const server = await this.resolveMcpServer(input);
    const toolName = inputString(input, "tool", true);
    const toolInput = recordMaybe(input.input) ?? {};
    const response = await new McpStdioClient(server, mcpOptions(input)).callTool(toolName, toolInput);
    return this.mcpResponseResult("mcp_call", server, response, { tool: toolName });
  }

  private async resolveMcpServer(input: JsonRecord): Promise<McpServerDeclaration> {
    const inlineCommand = inputString(input, "command");
    if (inlineCommand) {
      const serverName = inputString(input, "server") ?? inputString(input, "name") ?? "inline";
      return {
        pluginId: "inline",
        id: serverName,
        name: serverName,
        root: this.workspace,
        command: inlineCommand,
        args: inputStringArray(input, "args"),
        cwd: inputString(input, "cwd"),
        env: envInput(input.env),
        raw: input,
      };
    }
    const requested = inputString(input, "server", true);
    const servers = await new PluginMarketplace({ workspace: this.workspace }).mcpServerConfigs();
    const server = servers.find((candidate) => candidate.id === requested || candidate.name === requested || `${candidate.pluginId}:${candidate.name}` === requested);
    if (!server) throw new Error(`unknown MCP server ${requested}`);
    return server;
  }

  private mcpResponseResult(name: string, server: McpServerDeclaration, response: { ok: boolean; result?: JsonValue; error?: string; stderrTail?: string }, metadata: JsonRecord = {}): ToolResult {
    return this.result(name, response.ok, response.ok ? JSON.stringify(response.result ?? null, null, 2) : response.error ?? "MCP request failed", {
      pluginId: server.pluginId,
      server: server.name,
      command: server.command ?? "",
      stderrTail: response.stderrTail ?? "",
      ...metadata,
    });
  }

  private async gitTool(name: string, args: string[]): Promise<ToolResult> {
    return this.executionToResult(name, await runRaw(this.workspace, { program: "git", args, timeoutMs: 120_000 }, 120_000));
  }

  private async gitCommitRetrievalTool(input: JsonRecord): Promise<ToolResult> {
    const query = inputString(input, "query");
    const args = ["log", "--oneline", "--decorate", "-n", "50"];
    const report = await runRaw(this.workspace, { program: "git", args, timeoutMs: 120_000 }, 120_000);
    if (!query) return this.executionToResult("git_commit_retrieval", report);
    const filtered = report.stdoutTail.split(/\r?\n/g).filter((line) => line.toLowerCase().includes(query.toLowerCase())).join("\n");
    return this.result("git_commit_retrieval", report.ok, filtered);
  }

  private async renderMermaidTool(input: JsonRecord): Promise<ToolResult> {
    const diagram = inputString(input, "diagram", true);
    const out = inputString(input, "out") ?? path.join(".crix", "artifacts", "mermaid", `${safeName(inputString(input, "name") ?? "diagram")}.svg`);
    const resolved = resolveInside(this.workspace, out);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, renderSimpleMermaidSvg(diagram), "utf8");
    return this.result("render_mermaid", true, `rendered ${out}`, { path: resolved });
  }

  private async proofReportTool(input: JsonRecord): Promise<ToolResult> {
    const dir = await this.artifactDir("proof");
    const proofPath = path.join(dir, `${safeName(inputString(input, "name") ?? "tool-proof")}-${Date.now()}.json`);
    const proof = { createdAt: nowIso(), summary: inputString(input, "summary") ?? "", data: input.data ?? null };
    await writeFile(proofPath, JSON.stringify(proof, null, 2), "utf8");
    return this.result("proof_report", true, `proof written: ${proofPath}`, { proofPath });
  }

  private requestApprovalTool(input: JsonRecord): ToolResult {
    if (booleanInput(input, "approved")) return this.result("request_approval", true, "approval recorded");
    return this.result("request_approval", false, `approval required: ${inputString(input, "reason") ?? inputString(input, "action") ?? "unspecified action"}`);
  }

  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) out.push(full);
      }
    };
    await visit(root);
    return out;
  }

  private async editor(label: string): Promise<ReversibleEditor> {
    return new ReversibleEditor(this.workspace, await this.checkpointDir(label));
  }

  private async checkpointDir(label: string): Promise<string> {
    const dir = path.join(this.workspace, ".crix", "tool-checkpoints", `${safeName(label)}_${Date.now()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async artifactDir(label: string): Promise<string> {
    const dir = path.join(this.workspace, ".crix", "artifacts", safeName(label));
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async readTasks(): Promise<Array<Record<string, string>>> {
    const file = this.tasksFile();
    try {
      return JSON.parse(await readFile(file, "utf8")) as Array<Record<string, string>>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeTasks(tasks: Array<Record<string, string>>): Promise<void> {
    const file = this.tasksFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(tasks, null, 2), "utf8");
  }

  private tasksFile(): string {
    return path.join(this.workspace, ".crix", "tasks", "tasks.json");
  }

  private async applySimplePatch(patch: string): Promise<string[]> {
    const lines = patch.split(/\r?\n/g);
    const messages: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.startsWith("*** Add File: ")) {
        const target = line.slice("*** Add File: ".length).trim();
        const content: string[] = [];
        index += 1;
        while (index < lines.length && !lines[index]!.startsWith("*** ")) {
          content.push(lines[index]!.startsWith("+") ? lines[index]!.slice(1) : lines[index]!);
          index += 1;
        }
        index -= 1;
        messages.push((await (await this.editor("apply_patch")).writeFile(target, `${content.join("\n")}\n`)).message);
      } else if (line.startsWith("*** Delete File: ")) {
        messages.push((await this.removeFilesTool({ path: line.slice("*** Delete File: ".length).trim() })).output);
      } else if (line.startsWith("*** Update File: ")) {
        const target = line.slice("*** Update File: ".length).trim();
        const oldLines: string[] = [];
        const newLines: string[] = [];
        index += 1;
        while (index < lines.length && !lines[index]!.startsWith("*** ")) {
          const current = lines[index]!;
          if (current.startsWith("-")) oldLines.push(current.slice(1));
          else if (current.startsWith("+")) newLines.push(current.slice(1));
          else if (current.startsWith(" ")) {
            oldLines.push(current.slice(1));
            newLines.push(current.slice(1));
          }
          index += 1;
        }
        index -= 1;
        if (oldLines.length === 0) throw new Error(`patch update for ${target} had no removable/context lines`);
        messages.push((await (await this.editor("apply_patch")).replaceText(target, oldLines.join("\n"), newLines.join("\n"))).message);
      }
    }
    if (messages.length === 0) throw new Error("patch contained no supported file operations");
    return messages;
  }

  private executionToResult(name: string, report: { ok: boolean; stdoutTail: string; stderrTail: string; command: string; code: number | null; durationMs: number; blockedReason?: string }): ToolResult {
    return this.result(name, report.ok, [report.stdoutTail.trimEnd(), report.stderrTail.trimEnd(), report.blockedReason ? `blocked: ${report.blockedReason}` : ""].filter(Boolean).join("\n"), {
      command: report.command,
      code: report.code,
      durationMs: report.durationMs,
    });
  }

  private result(name: string, ok: boolean, output: string, metadata: JsonRecord = {}): ToolResult {
    return { callId: id(`tool_${name}`), ok, output, metadata };
  }
}

async function runRaw(workspace: string, command: VerificationCommand, timeoutMs: number): Promise<{ command: string; ok: boolean; code: number | null; durationMs: number; stdoutTail: string; stderrTail: string }> {
  const started = Date.now();
  const cwd = command.cwd ? resolveInside(workspace, command.cwd) : workspace;
  const display = [command.program, ...command.args].join(" ");
  return await new Promise((resolve) => {
    const spawnTarget = resolveProcessSpawnTarget(command.program, command.args);
    const child = spawn(spawnTarget.program, spawnTarget.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ command: display, ok: false, code: null, durationMs: Date.now() - started, stdoutTail: tail(stdout), stderrTail: tail(`timed out after ${timeoutMs}ms\n${stderr}`) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: display, ok: false, code: null, durationMs: Date.now() - started, stdoutTail: tail(stdout), stderrTail: tail(error.message) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: display, ok: code === 0, code, durationMs: Date.now() - started, stdoutTail: tail(stdout), stderrTail: tail(stderr) });
    });
  });
}

function commandInput(input: JsonRecord): VerificationCommand {
  const command = recordMaybe(input.command);
  if (command) return { program: inputString(command, "program", true), args: inputStringArray(command, "args"), cwd: inputString(command, "cwd"), timeoutMs: numberInput(command, "timeoutMs") };
  return { program: inputString(input, "program", true), args: inputStringArray(input, "args"), cwd: inputString(input, "cwd"), timeoutMs: numberInput(input, "timeoutMs") };
}

function inputString(input: JsonRecord, key: string, required: true): string;
function inputString(input: JsonRecord, key: string, required?: false): string | undefined;
function inputString(input: JsonRecord, key: string, required = false): string | undefined {
  const value = input[key];
  if (typeof value === "string") return value;
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

function inputStringArray(input: JsonRecord, key: string, fallback?: string): string[] {
  const value = input[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return fallback ? [fallback] : [];
}

function numberInput(input: JsonRecord, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function booleanInput(input: JsonRecord, key: string): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

function arrayInput(input: JsonRecord, key: string): JsonValue[] {
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function recordInput(value: JsonValue): JsonRecord {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  throw new Error("expected object input");
}

function recordMaybe(value: JsonValue | undefined): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function envInput(value: JsonValue | undefined): Record<string, string> | undefined {
  const record = recordMaybe(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function mcpOptions(input: JsonRecord): { timeoutMs?: number; maxOutputChars?: number } {
  return {
    timeoutMs: numberInput(input, "timeoutMs"),
    maxOutputChars: numberInput(input, "maxOutputChars"),
  };
}

function mcpServerSummary(server: McpServerDeclaration): JsonRecord {
  return {
    pluginId: server.pluginId,
    id: server.id,
    name: server.name,
    root: server.root,
    command: server.command ?? null,
    args: server.args ?? [],
    cwd: server.cwd ?? null,
    url: server.url ?? null,
  };
}

function applyLineRange(text: string, startLine?: number, endLine?: number): string {
  if (!startLine && !endLine) return text;
  const lines = text.split(/\r?\n/g);
  return lines.slice(Math.max((startLine ?? 1) - 1, 0), endLine ?? lines.length).join("\n");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let out = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      out += ".*";
      index += 1;
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += ".";
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`${out}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function optionalPathArgs(input: JsonRecord): string[] {
  const item = inputString(input, "path");
  return item ? ["--", item] : [];
}

function isInsideRoot(candidate: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function permissionKey(tool: CrixToolDefinition, input: JsonRecord): string {
  return `${tool.name}:${tool.safety}:${stableStringify(input)}`;
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function processSnapshot(record: RuntimeProcess): JsonRecord {
  return {
    id: record.id,
    command: record.command,
    cwd: record.cwd,
    startedAt: record.startedAt,
    exitedAt: record.exitedAt ?? null,
    code: record.code ?? null,
    stdoutTail: tail(record.stdout),
    stderrTail: tail(record.stderr),
  };
}

function assertSafeProgram(program: string, args: string[]): void {
  const analysis = analyzeShellCommand({ program, args });
  if (analysis.denied) throw new Error(analysis.reason ?? "blocked unsafe process command");
}

function resolveProcessSpawnTarget(program: string, args: string[]): { program: string; args: string[] } {
  if (process.platform === "win32" && ["npm", "pnpm", "npx", "yarn"].includes(program.toLowerCase())) {
    return { program: "cmd.exe", args: ["/d", "/s", "/c", program, ...args] };
  }
  return { program, args };
}

function assertSafeBrowserTarget(rawUrl: string, workspace: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`browser_open requires an absolute http, https, or file URL: ${rawUrl}`);
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw new Error(`browser_open blocked unsupported URL protocol: ${parsed.protocol}`);
  }
  if (parsed.protocol !== "file:") return;
  const target = path.resolve(fileURLToPath(parsed));
  const base = path.resolve(workspace);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`browser_open blocked file outside workspace: ${rawUrl}`);
  }
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "google-chrome",
    "chromium",
    "chrome",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => candidate.includes("\\") ? existsSync(candidate) : true) ?? "chrome";
}

async function evaluateInChrome(url: string, expression: string, timeoutMs: number): Promise<unknown> {
  const port = await freePort();
  const userDataDir = await mkTempDir("crix-chrome-");
  const chrome = spawn(findChrome(), ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    const tab = await createChromeTarget(port, url, timeoutMs);
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
    if (!WebSocketCtor) throw new Error("global WebSocket is unavailable in this Node runtime");
    return await new Promise((resolve, reject) => {
      const ws = new WebSocketCtor(tab.webSocketDebuggerUrl);
      const timer = setTimeout(() => reject(new Error("browser console evaluation timed out")), timeoutMs);
      let evaluated = false;
      const sendEvaluation = () => {
        if (evaluated) return;
        evaluated = true;
        ws.send(JSON.stringify({ id: 4, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      };
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
        ws.send(JSON.stringify({ id: 2, method: "Page.enable" }));
        setTimeout(sendEvaluation, 2_000);
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        const data = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: { result?: { value?: unknown; description?: string } }; error?: unknown };
        if (data.method === "Page.loadEventFired") {
          setTimeout(sendEvaluation, 50);
          return;
        }
        if (data.id !== 4) return;
        clearTimeout(timer);
        ws.close();
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result?.result?.value ?? data.result?.result?.description ?? null);
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("browser websocket failed"));
      });
    });
  } finally {
    chrome.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function createChromeTarget(port: number, url: string, timeoutMs: number): Promise<{ webSocketDebuggerUrl: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const tab = await response.json() as { webSocketDebuggerUrl?: string };
      if (tab.webSocketDebuggerUrl) return { webSocketDebuggerUrl: tab.webSocketDebuggerUrl };
    } catch {
      // Retry until Chrome opens the debugging endpoint.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("could not allocate port")));
    });
  });
}

async function mkTempDir(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function decodeHtml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", "\"").replaceAll("&#x27;", "'");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80) || "artifact";
}

function renderSimpleMermaidSvg(diagram: string): string {
  const lines = diagram.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  const edges = lines.flatMap((line) => {
    const match = line.match(/^"?([^"-]+?)"?\s*-+>+\s*"?([^"]+?)"?$/);
    return match ? [{ from: match[1]!.trim(), to: match[2]!.trim() }] : [];
  });
  const nodes = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  const width = Math.max(420, nodes.length * 180);
  const height = 220;
  const positions = new Map(nodes.map((node, index) => [node, { x: 90 + index * 170, y: 90 }]));
  const nodeSvg = nodes.map((node) => {
    const pos = positions.get(node)!;
    return `<rect x="${pos.x - 60}" y="${pos.y - 25}" width="120" height="50" rx="10" fill="#111827"/><text x="${pos.x}" y="${pos.y + 5}" text-anchor="middle" font-family="Arial" font-size="12" fill="white">${xml(node)}</text>`;
  }).join("");
  const edgeSvg = edges.map((edge) => {
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
    return `<line x1="${from.x + 60}" y1="${from.y}" x2="${to.x - 60}" y2="${to.y}" stroke="#2563eb" stroke-width="2" marker-end="url(#arrow)"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#2563eb"/></marker></defs><rect width="100%" height="100%" fill="#f8fafc"/>${edgeSvg}${nodeSvg}<text x="20" y="${height - 20}" font-family="Arial" font-size="11" fill="#475569">${xml(lines[0] ?? "mermaid")}</text></svg>`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
