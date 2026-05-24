import type { ProviderRequest } from "@crix/protocol";
import { CRIX_SKILL_PROCESSES, skillProcessSummary } from "./skillProcesses.js";
import { CRIX_TOOL_CATALOG, toolCatalogSummary } from "./toolCatalog.js";

export function buildUpgradePlanUserPrompt(request: ProviderRequest): string {
  const files = request.context.files.map((file) => `- ${file.path}: ${file.summary}`).join("\n") || "- none";
  const memories = request.context.memories.map((memory) => `- ${memory.text} [${memory.tags.join(", ")}]`).join("\n") || "- none";
  const recentInterventions = request.messages
    .filter((message) => message.name === "intervention")
    .map((message) => `- ${message.content}`)
    .join("\n") || "- none";
  const agents = request.agents.map((agent) => `- ${agent.id}: ${agent.description}`).join("\n") || "- none";

  return `Goal:
${request.goal}

Workspace:
${request.context.workspace}

Relevant files:
${files}

Durable memories:
${memories}

User interventions:
${recentInterventions}

Crix tool catalog:
${toolCatalogSummary(CRIX_TOOL_CATALOG)}

Crix skill processes:
${skillProcessSummary(CRIX_SKILL_PROCESSES)}

Available Crix agents:
${agents}

Plan rules:
- Produce a small, recoverable UpgradePlan that solves the coding task in the current repository.
- If you need one more round of read-only context before planning, return valid JSON shaped as {"text":"why context is needed","toolCalls":[{"id":"call_1","name":"read_file","input":{"path":"README.md"}}]}.
- Tool-call planning rounds are bounded and run in auto-safe mode, so prefer read-only context tools such as read_file, read_partial_file, list_dir, grep_search, glob, codebase_retrieval, file_outline, diagnostics, memory_search, git_status, and git_diff.
- Prefer direct task completion (code + tests + verification), then improve tool/runtime behavior when it is the real blocker.
- Use only supported executable step types today: create_dir, write_file, replace_text, run_verification, spawn_agent.
- Step paths must be relative to the workspace. If the user named an absolute target path, it is already represented by the workspace field above.
- Catalog tools are real runtime capabilities, but this UpgradePlan contract still mutates through safe file/edit/verification/agent steps.
- Never include destructive or external-state steps.
- Include focused verification commands whenever possible; start narrow, then widen only when needed.
- Return valid JSON only.`;
}
