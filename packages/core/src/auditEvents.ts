// Turning the event stream into audit entries — what Ares did, not what it said.
//
// Every tool call already surfaces as TurnEvents (tool_start → tool_end |
// tool_error, permission_request → permission_response). The audit trail
// (audit.ts) needs ONE line per outcome: which action, on what, with which
// parameters, and how it ended. This file is the mapping, kept pure so the
// garrison's session loop, the subagent runner and tests all derive entries
// the same way. Progress and deltas are deliberately never logged: the trail
// is a ledger of actions, not a transcript.
//
// The process-wide sink exists because subagents and operator workers do not
// run through the garrison's session table. The garrison installs the sink at
// boot; anywhere else (tests, the desktop, a one-shot CLI) recordAudit is a
// no-op, so nothing ever writes into a home that did not ask for it.

import type { TurnEvent } from "@ares/protocol";
import { redactForAudit, type AuditEntry } from "./audit.js";

export type AuditDraft = Omit<AuditEntry, "ts">;

let sink: ((entry: AuditDraft) => void) | null = null;

/** Install (or clear with null) the process-wide audit sink. */
export function setAuditSink(next: ((entry: AuditDraft) => void) | null): void {
  sink = next;
}

/** Record through the installed sink. Never throws; a no-op without a sink. */
export function recordAudit(entry: AuditDraft): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    // the audit trail must never break the action it records
  }
}

const TARGET_KEYS = [
  "url",
  "href",
  "to",
  "recipient",
  "recipients",
  "email",
  "phone",
  "number",
  "file_path",
  "notebook_path",
  "path",
  "cwd",
  "service",
  "provider",
  "server",
  "repo",
  "domain",
  "site",
  "pc",
  "pcId",
  "alarm_id",
  "id",
] as const;

/** Best-effort "what it acted on": a URL, recipient, path or service —
 *  redacted by value shape like params (a command can carry a token). */
export function auditTargetOf(toolName: string, input: unknown): string | undefined {
  const target = rawTargetOf(toolName, input);
  return target === undefined ? undefined : clip(String(redactForAudit(target)), 200);
}

function rawTargetOf(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
      return (value as string[]).join(", ");
    }
  }
  // A shell's target is the command itself — the one thing the owner needs
  // to read to know what happened. (Params still carry it in full, redacted.)
  if ((toolName === "Bash" || toolName === "PowerShell") && typeof record.command === "string") {
    return record.command.replace(/\s+/g, " ").trim();
  }
  if (typeof record.query === "string" && record.query.trim()) return record.query.trim();
  return undefined;
}

/** "Browser.click", "Gmail.send", or the bare tool name. */
export function auditActionOf(toolName: string, input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const action = (input as Record<string, unknown>).action;
    if (typeof action === "string" && /^[\w.-]{1,40}$/.test(action)) return `${toolName}.${action}`;
  }
  return toolName;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const MAX_TRACKED = 500;

/**
 * Pairs starts with outcomes for ONE event stream. tool_start and
 * permission_request carry the input; the terminal event does not, so the
 * tracker holds the input by id until the outcome arrives. Bounded: an
 * outcome that never comes (a crashed turn) is evicted oldest-first.
 */
export class ToolAuditTracker {
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private readonly prompts = new Map<string, { toolName: string; input: unknown }>();

  /** The entry this event completes, or null (starts, progress, text…). */
  observe(event: TurnEvent): Omit<AuditDraft, "actor"> | null {
    switch (event.type) {
      case "tool_start":
        remember(this.tools, event.id, { name: event.name, input: event.input });
        return null;
      case "permission_request":
        remember(this.prompts, event.id, { toolName: event.toolName, input: event.input });
        return null;
      case "tool_end":
      case "tool_error": {
        const started = this.tools.get(event.id);
        if (!started) return null;
        this.tools.delete(event.id);
        const result = event.type === "tool_end" ? "ok" : `error: ${clip(String(redactForAudit(String(event.error ?? "").replace(/\s+/g, " ").trim())), 200)}`;
        return entryFor(started.name, started.input, result);
      }
      case "permission_response": {
        const asked = this.prompts.get(event.id);
        if (!asked) return null;
        this.prompts.delete(event.id);
        const result = event.decision === "deny" ? "denied" : event.decision === "allow_always" ? "approved (always)" : "approved";
        return { ...entryFor(asked.toolName, asked.input, result), action: `permission:${auditActionOf(asked.toolName, asked.input)}` };
      }
      default:
        return null;
    }
  }
}

function entryFor(toolName: string, input: unknown, result: string): Omit<AuditDraft, "actor"> {
  const target = auditTargetOf(toolName, input);
  return {
    action: auditActionOf(toolName, input),
    ...(target ? { target } : {}),
    ...(input !== undefined ? { params: input } : {}),
    result,
  };
}

function remember<T>(map: Map<string, T>, id: string, value: T): void {
  map.set(id, value);
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
