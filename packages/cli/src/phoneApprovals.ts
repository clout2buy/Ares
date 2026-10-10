// Approving from the lock screen — the server half.
//
//   GET  /gateway/approvals          { approvals: [Row…], count }
//   POST /gateway/approvals/respond  { id | (sessionId, requestId) | approvalId,
//                                      decision: "allow_once" | "deny",
//                                      via?: "notification" | "widget" | "app" }
//        200 { result: "applied", decision, … }
//        200 { result: "already_resolved", decision, by, at }   (a double tap, or answered elsewhere)
//        403 { result: "needs_app" }                           (a decision that must be made in the app)
//        404 { result: "not_found" }                           (never seen, or long forgotten)
//        400 bad body
//
// Why HTTP and not the gateway socket: a notification action runs when the app
// is suspended or not running at all, for a few seconds, with no socket. One
// POST with the stored bearer is what a background launch can reliably do.
//
// What may be answered from a notification is decided HERE, not trusted from
// the phone: money, credentials, mail, publishing, irreversible shell, and any
// per-call owner decision get Deny and Open on the banner, never Allow. The
// route enforces the same wall, so a stale or hand-built request cannot cross it.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ActionCategory } from "@ares/effects";
import type { StagedApproval } from "@ares/effects";
import type { PendingPermissionInfo, PermissionOutcome, ApprovalOutcome } from "@ares/garrison";
import { classifyToolRequest } from "./policyGate.js";

// ─── Classification ──────────────────────────────────────────────────────

/** quick = Allow once / Deny / Open on the banner. strict = Deny / Open only. */
export type ApprovalGate = "quick" | "strict";
export type ApprovalRisk = "low" | "medium" | "high";

export interface ApprovalClass {
  gate: ApprovalGate;
  risk: ApprovalRisk;
  category: ActionCategory | null;
  /** One line, for logs and tests — never shown to the owner. */
  why: string;
}

/**
 * Categories that always need the owner to open the app. The remote-autonomy
 * gate's own list (money, mail, publishing, credentials, destructive shell,
 * git push) plus the categories the policy table marks irreversible: deleting
 * files, an outward account action, and "unknown" (driving the real desktop).
 */
const STRICT_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  "payment_or_purchase",
  "credential_or_secret",
  "email_send",
  "external_account",
  "shell_destructive",
  "file_delete",
  "git_push",
  "browser_submit",
  "unknown",
]);

const MEDIUM_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  "file_write",
  "shell_mutating",
  "dependency_install",
  "git_commit",
  "browser_fill",
  "email_draft",
]);

/** Tools whose approval is a decision about a plan or a purchase, whatever their input says. */
const STRICT_TOOLS: ReadonlySet<string> = new Set(["ExitPlanMode", "Checkout", "Stripe", "Deploy"]);

export interface ApprovalFacts {
  toolName: string;
  input: unknown;
  reason?: string;
  ownerDecision?: boolean;
}

/** Decide what the banner for a tool permission prompt may offer. PURE. */
export function classifyApproval(facts: ApprovalFacts): ApprovalClass {
  const toolName = typeof facts.toolName === "string" ? facts.toolName : "";
  let category: ActionCategory | null = null;
  try {
    category = classifyToolRequest({ toolName, input: facts.input, reason: facts.reason ?? "" });
  } catch {
    // A classifier that throws on odd input must fail toward asking in the app.
    return { gate: "strict", risk: "high", category: null, why: "unclassifiable request" };
  }
  if (facts.ownerDecision === true) {
    return { gate: "strict", risk: "high", category, why: "per-call owner decision" };
  }
  if (STRICT_TOOLS.has(toolName)) {
    return { gate: "strict", risk: "high", category, why: `${toolName} is a plan or purchase decision` };
  }
  if (category !== null && STRICT_CATEGORIES.has(category)) {
    return { gate: "strict", risk: "high", category, why: `${category} needs the app` };
  }
  return {
    gate: "quick",
    risk: category !== null && MEDIUM_CATEGORIES.has(category) ? "medium" : "low",
    category,
    why: category ?? "benign tool",
  };
}

const SENSITIVE_DOMAINS: ReadonlySet<string> = new Set(["spend", "credential", "email", "account", "git", "unknown"]);

/** The same wall for a staged effect (browser submit, connector effect, watcher execution). PURE. */
export function classifyStaged(staged: Pick<StagedApproval, "kind" | "domain" | "irreversibility">): ApprovalClass {
  const irreversible = staged.irreversibility === "irreversible";
  const sensitive = SENSITIVE_DOMAINS.has(String(staged.domain ?? "").toLowerCase());
  if (irreversible || sensitive) {
    return { gate: "strict", risk: "high", category: null, why: irreversible ? "irreversible effect" : `sensitive domain ${staged.domain}` };
  }
  return { gate: "quick", risk: staged.irreversibility === "recoverable" ? "medium" : "low", category: null, why: "recoverable effect" };
}

// ─── What the banner says (and never says) ───────────────────────────────

const SECRET_RULES: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]"],
  [/(\bhttps?:\/\/)[^\s/@]+@/gi, "$1"],
  [/(\bhttps?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?…"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]"],
  [/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|passphrase|api[_-]?key|apikey|auth|credential|private[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]"],
  [/(\s--?(?:token|secret|password|passwd|pass|api-?key|auth|key)\b)[ =]+("[^"]*"|'[^']*'|\S+)/gi, "$1 [redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
];

/** Strip anything that looks like a credential from a line shown on a lock screen. PURE. */
export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
  return out;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const flat = (s: string): string => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

export interface ApprovalSummary {
  /** The tool's name, sanitised. */
  tool: string;
  /** What it is about to act on — empty when showing it would be unsafe. */
  target: string;
}

const TARGET_KEYS = ["command", "url", "file_path", "path", "to", "query", "action", "capability"];

/**
 * Tool name + target for the banner, the Live Activity and the widget: short,
 * single-line, secrets redacted. A credential or a purchase shows the tool and
 * nothing else — the lock screen is a public surface.
 */
export function approvalSummary(toolName: string, input: unknown, cls?: ApprovalClass): ApprovalSummary {
  const tool = clip(flat(String(toolName ?? "")) || "a tool", 40);
  const hide = cls?.category === "credential_or_secret" || cls?.category === "payment_or_purchase" || cls?.why === "per-call owner decision";
  if (hide || !input || typeof input !== "object") return { tool, target: "" };
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return { tool, target: clip(flat(redactSecrets(value)), 80) };
  }
  return { tool, target: "" };
}

/** "Bash — npm test", or just "Bash". */
export function approvalLine(summary: ApprovalSummary): string {
  return summary.target ? `${summary.tool} — ${summary.target}` : summary.tool;
}

// ─── Ids ─────────────────────────────────────────────────────────────────

export const permissionApprovalId = (sessionId: string, requestId: string): string => `perm:${sessionId}:${requestId}`;
export const stagedApprovalId = (approvalId: string): string => `stg:${approvalId}`;

export type ParsedApprovalId =
  | { kind: "permission"; sessionId: string; requestId: string }
  | { kind: "staged"; approvalId: string };

export function parseApprovalId(id: unknown): ParsedApprovalId | null {
  if (typeof id !== "string") return null;
  if (id.startsWith("stg:") && id.length > 4) return { kind: "staged", approvalId: id.slice(4) };
  if (id.startsWith("perm:")) {
    const rest = id.slice(5);
    const cut = rest.lastIndexOf(":");
    if (cut > 0 && cut < rest.length - 1) return { kind: "permission", sessionId: rest.slice(0, cut), requestId: rest.slice(cut + 1) };
  }
  return null;
}

// ─── The rows ────────────────────────────────────────────────────────────

export interface ApprovalRow {
  /** Stable id: pass it back to /respond. */
  id: string;
  kind: "permission" | "staged";
  sessionId?: string;
  requestId?: string;
  approvalId?: string;
  agent: string;
  tool: string;
  target: string;
  gate: ApprovalGate;
  risk: ApprovalRisk;
  createdAt?: number;
  expiresAt?: number;
}

export interface ApprovalsApiDeps {
  sessions: {
    pendingPermissionList(): PendingPermissionInfo[];
    permissionOutcome(sessionId: string, requestId: string): PermissionOutcome | undefined;
    respondPermission(sessionId: string, requestId: string, decision: "allow_once" | "allow_always" | "deny"): boolean;
  };
  /** The staged-effect queue (ApprovalQueue). Optional: a garrison without one lists only prompts. */
  staged?: {
    pending(): StagedApproval[];
    outcome(id: string): ApprovalOutcome | undefined;
    respond(decision: { approvalId: string; verb: "allow_once" | "allow_always" | "deny"; note?: string }): void | Promise<void>;
  };
  agentName?: (sessionId: string) => string;
  /** Fired after a decision lands, so the Live Activity and the widgets can follow. */
  onResolved?: (info: { id: string; decision: "allow_once" | "deny"; via: string }) => void;
  now?: () => number;
  log?: (line: string) => void;
}

export function listApprovals(deps: ApprovalsApiDeps): ApprovalRow[] {
  const agentName = deps.agentName ?? (() => "Ares");
  const rows: ApprovalRow[] = [];
  for (const p of deps.sessions.pendingPermissionList()) {
    const cls = classifyApproval({ toolName: p.toolName, input: p.input, reason: p.reason, ownerDecision: p.ownerDecision });
    const sum = approvalSummary(p.toolName, p.input, cls);
    rows.push({
      id: permissionApprovalId(p.sessionId, p.requestId),
      kind: "permission",
      sessionId: p.sessionId,
      requestId: p.requestId,
      agent: agentName(p.sessionId),
      tool: sum.tool,
      target: sum.target,
      gate: cls.gate,
      risk: cls.risk,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    });
  }
  for (const s of deps.staged?.pending() ?? []) {
    const cls = classifyStaged(s);
    rows.push({
      id: stagedApprovalId(s.id),
      kind: "staged",
      approvalId: s.id,
      agent: "Ares",
      tool: clip(flat(String(s.kind || "action")), 40),
      target: clip(flat(redactSecrets(String(s.reason ?? ""))), 80),
      gate: cls.gate,
      risk: cls.risk,
    });
  }
  return rows;
}

// ─── The respond decision (pure of HTTP) ─────────────────────────────────

export type RespondResult =
  | { status: 200; body: { result: "applied"; id: string; decision: "allow_once" | "deny"; agent: string; tool: string; target: string } }
  | { status: 200; body: { result: "already_resolved"; id?: string; decision?: "allow_once" | "allow_always" | "deny"; by?: string; at?: number } }
  | { status: 403; body: { result: "needs_app"; id: string; gate: "strict"; message: string } }
  | { status: 404; body: { result: "not_found"; message: string } }
  | { status: 400; body: { error: string } };

const VIAS = new Set(["notification", "widget", "watch", "app"]);

/** Answer one approval. Never throws; every outcome is a clear result. */
export async function respondToApproval(deps: ApprovalsApiDeps, raw: Record<string, unknown>): Promise<RespondResult> {
  const decision = raw.decision;
  if (decision !== "allow_once" && decision !== "deny") {
    return { status: 400, body: { error: 'decision must be "allow_once" or "deny"' } };
  }
  // Absent or unknown means "from a notification": the stricter wall.
  const via = typeof raw.via === "string" && VIAS.has(raw.via) ? raw.via : "notification";
  const fromApp = via === "app";

  let target: ParsedApprovalId | null = parseApprovalId(raw.id);
  if (!target && typeof raw.sessionId === "string" && typeof raw.requestId === "string" && raw.sessionId && raw.requestId) {
    target = { kind: "permission", sessionId: raw.sessionId, requestId: raw.requestId };
  }
  if (!target && typeof raw.approvalId === "string" && raw.approvalId) target = { kind: "staged", approvalId: raw.approvalId };
  if (!target) return { status: 400, body: { error: "id (or sessionId + requestId, or approvalId) is required" } };

  const agentName = deps.agentName ?? (() => "Ares");

  if (target.kind === "permission") {
    const { sessionId, requestId } = target;
    const id = permissionApprovalId(sessionId, requestId);
    const pending = deps.sessions.pendingPermissionList().find((p) => p.sessionId === sessionId && p.requestId === requestId);
    if (!pending) {
      const done = deps.sessions.permissionOutcome(sessionId, requestId);
      if (done) return { status: 200, body: { result: "already_resolved", id, decision: done.decision, by: done.by, at: done.at } };
      return { status: 404, body: { result: "not_found", message: "That request is gone. It may have timed out." } };
    }
    const cls = classifyApproval({ toolName: pending.toolName, input: pending.input, reason: pending.reason, ownerDecision: pending.ownerDecision });
    if (decision === "allow_once" && cls.gate === "strict" && !fromApp) {
      deps.log?.(`approvals: refused a notification Allow for a strict request (${cls.why})`);
      return { status: 403, body: { result: "needs_app", id, gate: "strict", message: "Open Ares to approve this one." } };
    }
    const handled = deps.sessions.respondPermission(sessionId, requestId, decision);
    if (!handled) {
      // Lost a race with another answer between the list and the respond.
      const done = deps.sessions.permissionOutcome(sessionId, requestId);
      return { status: 200, body: { result: "already_resolved", id, ...(done ? { decision: done.decision, by: done.by, at: done.at } : {}) } };
    }
    const sum = approvalSummary(pending.toolName, pending.input, cls);
    deps.log?.(`approvals: ${decision} for ${sum.tool} via ${via}`);
    deps.onResolved?.({ id, decision, via });
    return { status: 200, body: { result: "applied", id, decision, agent: agentName(sessionId), tool: sum.tool, target: sum.target } };
  }

  // A staged effect.
  const queue = deps.staged;
  const id = stagedApprovalId(target.approvalId);
  if (!queue) return { status: 404, body: { result: "not_found", message: "This garrison has no approval queue." } };
  const pending = queue.pending().find((s) => s.id === target.approvalId);
  if (!pending) {
    const done = queue.outcome(target.approvalId);
    if (done) return { status: 200, body: { result: "already_resolved", id, decision: done.verb, by: done.by, at: done.at } };
    return { status: 404, body: { result: "not_found", message: "That request is gone. It may have timed out." } };
  }
  const cls = classifyStaged(pending);
  if (decision === "allow_once" && cls.gate === "strict" && !fromApp) {
    deps.log?.(`approvals: refused a notification Allow for a strict staged effect (${cls.why})`);
    return { status: 403, body: { result: "needs_app", id, gate: "strict", message: "Open Ares to approve this one." } };
  }
  try {
    await queue.respond({ approvalId: target.approvalId, verb: decision, note: `via ${via}` });
  } catch {
    const done = queue.outcome(target.approvalId);
    return { status: 200, body: { result: "already_resolved", id, ...(done ? { decision: done.verb, by: done.by, at: done.at } : {}) } };
  }
  deps.log?.(`approvals: ${decision} for a staged ${pending.kind} via ${via}`);
  deps.onResolved?.({ id, decision, via });
  return {
    status: 200,
    body: { result: "applied", id, decision, agent: "Ares", tool: clip(flat(String(pending.kind || "action")), 40), target: clip(flat(redactSecrets(String(pending.reason ?? ""))), 80) },
  };
}

// ─── HTTP ────────────────────────────────────────────────────────────────

const BODY_LIMIT = 4 * 1024;

export function createApprovalsApi(deps: ApprovalsApiDeps) {
  const send = (res: ServerResponse, status: number, body: unknown): true => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
    return true;
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > BODY_LIMIT) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (total === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/approvals" && !url.pathname.startsWith("/gateway/approvals/")) return false;
    const sub = url.pathname.slice("/gateway/approvals".length).replace(/^\/|\/$/g, "");
    try {
      if (sub === "" && req.method === "GET") {
        const approvals = listApprovals(deps);
        return send(res, 200, { approvals, count: approvals.length, at: (deps.now ?? Date.now)() });
      }
      if (sub === "respond" && req.method === "POST") {
        const reply = await respondToApproval(deps, await readJson(req));
        return send(res, reply.status, reply.body);
      }
      const known = sub === "" || sub === "respond";
      return send(res, known ? 405 : 404, { error: known ? "method not allowed" : "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/too large/.test(message)) return send(res, 413, { error: message });
      if (err instanceof SyntaxError) return send(res, 400, { error: "invalid JSON" });
      deps.log?.(`approvals: ${req.method} ${url.pathname} failed: ${message}`);
      return send(res, 500, { error: "internal error" });
    }
  };
}
