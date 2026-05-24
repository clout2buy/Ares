import type { JsonRecord, ToolResult } from "@crix/protocol";
import type { TurnEngineCall } from "./turnEngine.js";

export type EvidenceKind = "inspection" | "change" | "verification" | "artifact" | "tool_result" | "agent" | "policy";

export interface EvidenceEntry {
  kind: EvidenceKind;
  toolName: string;
  ok: boolean;
  summary: string;
  input?: JsonRecord;
  metadata?: JsonRecord;
}

const VERIFY_TOOLS = new Set(["run_verification", "diagnostics", "browser_snapshot", "browser_console"]);
const CHANGE_TOOLS = new Set(["create_dir", "write_file", "replace_text", "multi_edit", "apply_patch", "remove_files"]);
const ARTIFACT_TOOLS = new Set(["browser_open", "proof_report", "render_mermaid"]);
const AGENT_TOOLS = new Set(["spawn_agent", "wait_agent", "send_agent_input", "cancel_agent", "agent_notifications"]);
const READ_TOOLS = new Set(["read_file", "read_partial_file", "list_dir", "glob", "grep_search", "codebase_retrieval", "file_outline", "find_references", "go_to_definition", "git_status", "git_diff", "git_commit_retrieval", "memory_search", "web_search", "web_fetch"]);

export function evidenceFromToolResult(call: TurnEngineCall, result: ToolResult): EvidenceEntry {
  return {
    kind: evidenceKindForTool(call.name),
    toolName: call.name,
    ok: result.ok,
    summary: summarizeEvidenceOutput(result.output),
    input: call.input,
    metadata: result.metadata,
  };
}

export function evidenceSummary(entries: EvidenceEntry[]): string {
  const ok = entries.filter((entry) => entry.ok);
  if (ok.length === 0) return "no successful tool evidence";
  const counts = new Map<EvidenceKind, number>();
  for (const entry of ok) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(", ");
}

export function hasVerificationEvidence(entries: EvidenceEntry[]): boolean {
  return entries.some((entry) => entry.ok && entry.kind === "verification");
}

export function guardFinalAnswerClaims(text: string, entries: EvidenceEntry[]): string {
  if (!completionClaim(text) || hasVerificationEvidence(entries)) return text;
  return [
    text,
    "",
    `Verification note: no successful verification tool evidence was recorded for this turn (${evidenceSummary(entries)}). Treat completion claims as unverified until checks run.`,
  ].join("\n");
}

function evidenceKindForTool(toolName: string): EvidenceKind {
  if (VERIFY_TOOLS.has(toolName)) return "verification";
  if (CHANGE_TOOLS.has(toolName)) return "change";
  if (ARTIFACT_TOOLS.has(toolName)) return "artifact";
  if (AGENT_TOOLS.has(toolName)) return "agent";
  if (READ_TOOLS.has(toolName)) return "inspection";
  if (toolName === "request_approval") return "policy";
  return "tool_result";
}

function summarizeEvidenceOutput(output: string): string {
  return output.replace(/\s+/g, " ").trim().slice(0, 220);
}

function completionClaim(text: string): boolean {
  return /\b(done|fixed|implemented|created|wrote|updated|verified|completed|finished|opened|built|generated)\b/i.test(text);
}
