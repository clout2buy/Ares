export interface SkillProcess {
  id: string;
  title: string;
  goal: string;
  references: string[];
  triggers: string[];
  steps: string[];
  buildsTools: string[];
  proof: string[];
}

export const CRIX_SKILL_PROCESSES: SkillProcess[] = [
  {
    id: "context-scout",
    title: "Context Scout",
    goal: "Understand a code area quickly before planning edits.",
    references: ["Cursor Agent style", "Amp/Augment style", "VSCode Agent style"],
    triggers: ["unknown codebase", "bug hunt", "before editing unfamiliar files"],
    steps: [
      "Read durable memory and repo status.",
      "List likely directories and search exact symbols first.",
      "Read narrow file ranges around matching code.",
      "Summarize relevant modules, tests, risks, and missing context.",
    ],
    buildsTools: ["read_partial_file", "glob", "codebase_retrieval", "diagnostics", "file_outline", "find_references", "go_to_definition"],
    proof: ["context summary", "files inspected", "open questions"],
  },
  {
    id: "spec-plan-implement",
    title: "Spec Plan Implement",
    goal: "Turn an ambiguous upgrade into reviewable phases.",
    references: ["Kiro/Antigravity style", "Qoder/Traycer style", "Codex CLI style"],
    triggers: ["large feature", "self-upgrade", "architecture change"],
    steps: [
      "Write requirements in concrete acceptance criteria.",
      "Draft a design that names modules and boundaries.",
      "Split into phases that compile and verify independently.",
      "Execute only the current phase unless the user asks for more.",
    ],
    buildsTools: ["tasklist_view", "tasklist_add", "tasklist_update", "skill_load"],
    proof: ["requirements", "design notes", "phase checklist", "verification command"],
  },
  {
    id: "safe-edit-checkpoint",
    title: "Safe Edit Checkpoint",
    goal: "Make code changes without losing user work.",
    references: ["Claude Code style", "VSCode Agent style", "Codex CLI style"],
    triggers: ["write_file", "replace_text", "multi-file edit"],
    steps: [
      "Read target files and surrounding conventions.",
      "Create checkpoint metadata before any write.",
      "Apply smallest precise edit.",
      "Run focused tests and keep rollback information in proof.",
    ],
    buildsTools: ["multi_edit", "apply_patch", "remove_files"],
    proof: ["changed files", "checkpoint path", "test result", "rollback path"],
  },
  {
    id: "quality-gate",
    title: "Quality Gate",
    goal: "Prove a change works with the narrowest useful verification.",
    references: ["Codex CLI style", "VSCode Agent style", "Kiro/Antigravity style"],
    triggers: ["after edit", "before final answer", "provider-generated plan"],
    steps: [
      "Run syntax/type check for touched language.",
      "Run focused regression tests.",
      "Run broader package verification when shared runtime changed.",
      "Record exact commands and failures.",
    ],
    buildsTools: ["diagnostics"],
    proof: ["commands", "pass/fail", "stdout tail", "stderr tail"],
  },
  {
    id: "process-control",
    title: "Managed Process Control",
    goal: "Safely operate long-running local processes for dev servers and interactive commands.",
    references: ["Amp/Augment style", "Devin style", "Manus style"],
    triggers: ["dev server", "interactive shell", "watch mode", "browser QA"],
    steps: [
      "Launch only allowlisted local commands inside the workspace.",
      "Capture process id, cwd, command, and log tails.",
      "Read output before deciding next action.",
      "Kill only Crix-managed processes unless the user approves otherwise.",
    ],
    buildsTools: ["launch_process", "read_process", "write_process", "kill_process", "list_processes"],
    proof: ["process id", "log tail", "exit status", "cleanup state"],
  },
  {
    id: "subagent-split-review",
    title: "Subagent Split Review",
    goal: "Use agents without duplicated work or write conflicts.",
    references: ["Claude Code style", "Cursor Agent style", "Same.dev style"],
    triggers: ["parallelizable investigation", "review pass", "isolated implementation slice"],
    steps: [
      "Identify the immediate critical-path task to keep local.",
      "Delegate only independent side tasks.",
      "Assign ownership and disjoint write scopes.",
      "Integrate results and verify in the main run.",
    ],
    buildsTools: ["wait_agent", "send_agent_input"],
    proof: ["agent id", "scope", "summary", "integration result"],
  },
  {
    id: "tasklist-control",
    title: "Tasklist Control",
    goal: "Track multi-step work without losing the active slice.",
    references: ["Amp/Augment style", "VSCode Agent style", "Codex CLI style"],
    triggers: ["multi-step task", "parallel agents", "self-upgrade roadmap"],
    steps: [
      "Create tasks only when the work has real ordering or risk.",
      "Keep one task active while implementation is in progress.",
      "Update statuses immediately after meaningful progress or blockers.",
      "Do not use tasklists for trivial one-step answers.",
    ],
    buildsTools: ["tasklist_view", "tasklist_add", "tasklist_update"],
    proof: ["task ids", "active task", "completed tasks", "blocked tasks"],
  },
  {
    id: "memory-capture",
    title: "Memory Capture",
    goal: "Persist decisions that should affect future Crix runs.",
    references: ["Amp/Augment style", "Windsurf style", "Manus style"],
    triggers: ["architecture decision", "user preference", "provider blocker", "verification result"],
    steps: [
      "Decide if the fact will matter in future sessions.",
      "Never store secrets or one-time auth codes.",
      "Write concise memory with tags.",
      "Supersede stale memory instead of piling contradictions.",
    ],
    buildsTools: ["memory_forget"],
    proof: ["memory id", "tags", "reason"],
  },
  {
    id: "skill-orchestration",
    title: "Skill Orchestration",
    goal: "Load specialized Crix workflows only when they materially improve execution.",
    references: ["Kiro/Antigravity style", "Amp/Augment style", "Friend TypeScript CLI repo"],
    triggers: ["known workflow", "frontend QA", "provider work", "release verification"],
    steps: [
      "Match the user request to the smallest relevant skill.",
      "Load only the process instructions needed for the current slice.",
      "Run the skill workflow with explicit inputs and proof outputs.",
      "Record weak skill capabilities as toolsmith improvement targets.",
    ],
    buildsTools: ["skill_list", "skill_load", "skill_run"],
    proof: ["skill id", "inputs", "outputs", "verification"],
  },
  {
    id: "plugin-marketplace",
    title: "Plugin Marketplace",
    goal: "Discover installed plugins and MCP server declarations before loading runtime extensions.",
    references: ["Claude Code style", "Kiro/Antigravity style", "VSCode Agent style"],
    triggers: ["plugin discovery", "MCP server inventory", "tool extension planning"],
    steps: [
      "Read workspace and user plugin marketplace manifests.",
      "Validate plugin id, root, enabled state, skills, tools, and MCP server declarations.",
      "Expose discovery as read-only runtime tools.",
      "Hand runnable MCP declarations to the MCP runtime rather than pretending declarations are already tools.",
    ],
    buildsTools: ["plugin_list", "mcp_list"],
    proof: ["plugin ids", "manifest roots", "MCP server names", "enabled state"],
  },
  {
    id: "mcp-runtime",
    title: "MCP Runtime",
    goal: "Connect to plugin-declared stdio MCP servers and execute their tools with explicit approval.",
    references: ["Claude Code style", "Cursor Agent style", "VSCode Agent style"],
    triggers: ["MCP tool call", "plugin-provided tool", "external connector", "runtime extension"],
    steps: [
      "Resolve a server from plugin declarations or an explicit inline command.",
      "Initialize JSON-RPC over stdio using the MCP handshake.",
      "List tools/resources before selecting a call.",
      "Run calls under external-state permission gating and record server, tool, output, and stderr tail.",
    ],
    buildsTools: ["mcp_tools", "mcp_call", "mcp_resources", "mcp_read_resource"],
    proof: ["server id", "tool name", "JSON-RPC result", "stderr tail"],
  },
  {
    id: "browser-runtime-qa",
    title: "Browser Runtime QA",
    goal: "Verify local UI/runtime behavior with browser evidence.",
    references: ["Manus style", "Replit style", "v0 style"],
    triggers: ["web app", "local server", "visual check", "console error"],
    steps: [
      "Start or identify the local app target.",
      "Open the target and capture screenshot plus console state.",
      "Exercise the changed interaction path.",
      "Record artifact paths and console errors in proof.",
    ],
    buildsTools: ["browser_open", "browser_snapshot", "browser_console"],
    proof: ["url", "screenshot path", "console result", "interaction notes"],
  },
  {
    id: "external-research",
    title: "External Research",
    goal: "Use web/docs only when current external facts affect correctness.",
    references: ["Amp/Augment style", "Claude Code style", "Perplexity style"],
    triggers: ["latest docs", "API version", "product/model availability"],
    steps: [
      "Prefer official or primary sources.",
      "Fetch only relevant pages.",
      "Summarize conclusions without copying long text.",
      "Do not use fetched content as code unless licensing is clear.",
    ],
    buildsTools: ["web_search", "web_fetch"],
    proof: ["source links", "date checked", "decision affected"],
  },
  {
    id: "repo-state-control",
    title: "Repo State Control",
    goal: "Understand local repository state without hiding user changes.",
    references: ["OpenAI Codex local repo", "Cursor Agent style", "Friend TypeScript CLI repo"],
    triggers: ["before edits", "review", "self-upgrade", "proof report"],
    steps: [
      "Read local status before editing when a VCS is present.",
      "Use diffs to separate Crix changes from user/unrelated changes.",
      "Never reset, checkout, or clean user work unless explicitly requested.",
      "Include relevant diff/status facts in proof.",
    ],
    buildsTools: ["git_status", "git_diff", "git_commit_retrieval"],
    proof: ["status summary", "touched files", "unrelated changes", "diff check"],
  },
  {
    id: "artifact-proof",
    title: "Artifact Proof",
    goal: "Leave durable evidence for self-upgrade and review.",
    references: ["Codex CLI style", "Kiro/Antigravity style", "Amp/Augment style"],
    triggers: ["completed phase", "architecture diagram", "verification summary"],
    steps: [
      "Write proof.json for every run.",
      "Include changed files, tests, blockers, and rollback data.",
      "Create diagrams only when they clarify architecture.",
      "Keep artifacts in workspace-owned state directories.",
    ],
    buildsTools: ["render_mermaid"],
    proof: ["proof path", "artifact paths", "verification result"],
  },
  {
    id: "approval-gate",
    title: "Approval Gate",
    goal: "Pause before unsafe or external state-changing actions.",
    references: ["Codex CLI style", "Claude Code style", "Replit style"],
    triggers: ["credential use", "public posting", "remote push", "purchase", "destructive filesystem action"],
    steps: [
      "Classify the action by safety class and reversibility.",
      "Prefer a local read-only or dry-run substitute.",
      "Ask for explicit user approval only when required.",
      "Record the approval reason and exact action in proof.",
    ],
    buildsTools: ["request_approval"],
    proof: ["safety class", "approval text", "approved action", "dry-run substitute"],
  },
];

export function skillProcessSummary(processes: SkillProcess[] = CRIX_SKILL_PROCESSES): string {
  return processes
    .map((process) => `- ${process.id}: ${process.goal} Builds: ${process.buildsTools.join(", ") || "none"}`)
    .join("\n");
}

export function referenceSummary(): string {
  const references = new Map<string, string>();
  for (const process of CRIX_SKILL_PROCESSES) {
    for (const reference of process.references) references.set(reference, "Referenced by Crix skill processes.");
  }
  return [...references.entries()].map(([name, useFor]) => `- ${name}: ${useFor}`).join("\n");
}
