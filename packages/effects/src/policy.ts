// Approval policy + risk classifier (Nexus / Approval Rail Phase 1).
//
// A PURE risk brain: given an action (a category + domain) and an optional
// ActionPolicy, classify the action's risk and decide how it should be handled
// — allow / ask (stage for approval) / deny / preview-only / log-only — with
// cited reasons and warnings. No I/O, no mutation, no runtime wiring yet.
//
// This bridges the two risk vocabularies Ares already has: protocol's
// SafetyClass (read-only/workspace-write/destructive/external-state) and the
// effects layer's Irreversibility (reversible/recoverable/irreversible).
//
// NAMING / POSTURE: when NO ActionPolicy is configured, the evaluator preserves
// Ares's CURRENT behavior (permit) — but this is treated and labeled as
// "legacy / current behavior preserved for compatibility", NOT as the
// recommended long-term default. The recommended posture is Assist or Act.
// Explicit Bypass remains a loud, audited power-user mode.

import type { PermissionMode, SafetyClass } from "@ares/protocol";
import type { Irreversibility } from "./types.js";

/** The four explicit owner-chosen postures. "legacy" is the unset/compat state. */
export type ActionMode = "observe" | "assist" | "act" | "bypass";
export type EffectiveMode = ActionMode | "legacy";

export interface ActionPolicy {
  mode: ActionMode;
  /** Per-domain leash overrides (e.g. {"spend": 1}). Reserved for later wiring. */
  perDomainLeash?: Record<string, number>;
}

export type ActionCategory =
  | "file_read"
  | "file_write"
  | "file_delete"
  | "shell_readonly"
  | "shell_mutating"
  | "shell_destructive"
  | "dependency_install"
  | "git_commit"
  | "git_push"
  | "browser_navigate"
  | "browser_fill"
  | "browser_submit"
  | "email_draft"
  | "email_send"
  | "payment_or_purchase"
  | "credential_or_secret"
  | "external_account"
  | "unknown";

export type BlastRadius = "none" | "workspace" | "machine" | "external";

/** allow = run; ask = stage for human approval; deny = refuse; preview-only =
 *  simulate, never commit; log-only = permit but record (bypass auditing). */
export type PolicyDecision = "allow" | "ask" | "deny" | "preview-only" | "log-only";

export interface RiskAssessment {
  category: ActionCategory;
  domain: string;
  safetyClass: SafetyClass;
  irreversibility: Irreversibility;
  blastRadius: BlastRadius;
  touchesCredentials: boolean;
  touchesExternalWorld: boolean;
  touchesMoney: boolean;
  touchesGitRemote: boolean;
  touchesUserFiles: boolean;
  rollbackAvailable: boolean;
  previewAvailable: boolean;
}

export interface ActionDescriptor {
  category: ActionCategory;
  domain?: string;
  detail?: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  effectiveMode: EffectiveMode;
  risk: RiskAssessment;
  reasons: string[];
  warnings: string[];
  /** Denied by a v1 hard block (credential/payment/email_send/external_account), regardless of mode. */
  hardBlocked: boolean;
}

type RiskBase = Omit<RiskAssessment, "category" | "domain">;

// Per-category risk profile. Every flag is explicit (no inheritance) so the
// classifier is auditable at a glance.
const CATEGORY_RISK: Record<ActionCategory, RiskBase> = {
  file_read: { safetyClass: "read-only", irreversibility: "reversible", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: true, rollbackAvailable: true, previewAvailable: true },
  file_write: { safetyClass: "workspace-write", irreversibility: "recoverable", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: true, rollbackAvailable: true, previewAvailable: true },
  file_delete: { safetyClass: "destructive", irreversibility: "recoverable", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: true, rollbackAvailable: true, previewAvailable: true },
  shell_readonly: { safetyClass: "read-only", irreversibility: "reversible", blastRadius: "none", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: true, previewAvailable: false },
  shell_mutating: { safetyClass: "workspace-write", irreversibility: "recoverable", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: true, rollbackAvailable: false, previewAvailable: false },
  shell_destructive: { safetyClass: "destructive", irreversibility: "irreversible", blastRadius: "machine", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: true, rollbackAvailable: false, previewAvailable: false },
  dependency_install: { safetyClass: "external-state", irreversibility: "recoverable", blastRadius: "machine", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: true },
  git_commit: { safetyClass: "workspace-write", irreversibility: "recoverable", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: true, previewAvailable: true },
  git_push: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: true, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: true },
  browser_navigate: { safetyClass: "external-state", irreversibility: "reversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: true, previewAvailable: true },
  browser_fill: { safetyClass: "external-state", irreversibility: "reversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: true, previewAvailable: true },
  browser_submit: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: true },
  email_draft: { safetyClass: "workspace-write", irreversibility: "reversible", blastRadius: "workspace", touchesCredentials: false, touchesExternalWorld: false, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: true, previewAvailable: true },
  email_send: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: true },
  payment_or_purchase: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: true, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: true },
  credential_or_secret: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: true, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: false },
  external_account: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: false },
  unknown: { safetyClass: "external-state", irreversibility: "irreversible", blastRadius: "external", touchesCredentials: false, touchesExternalWorld: true, touchesMoney: false, touchesGitRemote: false, touchesUserFiles: false, rollbackAvailable: false, previewAvailable: false },
};

const CATEGORY_DOMAIN: Record<ActionCategory, string> = {
  file_read: "fs", file_write: "fs", file_delete: "fs",
  shell_readonly: "shell", shell_mutating: "shell", shell_destructive: "shell",
  dependency_install: "deps", git_commit: "git", git_push: "git",
  browser_navigate: "browser", browser_fill: "browser", browser_submit: "browser",
  email_draft: "email", email_send: "email",
  payment_or_purchase: "spend", credential_or_secret: "credential", external_account: "account",
  unknown: "unknown",
};

/** v1 hard blocks — denied in EVERY mode (including Bypass) until later phases. */
const HARD_BLOCKED: ReadonlySet<ActionCategory> = new Set([
  "credential_or_secret",
  "payment_or_purchase",
  "email_send",
  "external_account",
]);

/** Coarse SafetyClass → Irreversibility default (per-category profiles refine it). */
export function safetyClassToIrreversibility(safetyClass: SafetyClass): Irreversibility {
  switch (safetyClass) {
    case "read-only":
      return "reversible";
    case "workspace-write":
      return "recoverable";
    case "destructive":
    case "external-state":
      return "irreversible";
    default:
      return "irreversible";
  }
}

/** Map an ActionMode (or unset → legacy) onto Ares's existing PermissionMode. */
export function permissionModeFor(mode: EffectiveMode): PermissionMode {
  switch (mode) {
    case "observe":
      return "plan";
    case "assist":
      return "auto-safe";
    case "act":
      return "workspace-write";
    case "bypass":
    case "legacy":
    default:
      return "bypass";
  }
}

/** Does this decision permit the action to run? (allow or log-only). */
export function permits(decision: PolicyDecision): boolean {
  return decision === "allow" || decision === "log-only";
}

/** Classify an action into a structured risk assessment. Pure. */
export function classifyAction(action: ActionDescriptor): RiskAssessment {
  const base = CATEGORY_RISK[action.category] ?? CATEGORY_RISK.unknown;
  return { category: action.category, domain: action.domain ?? CATEGORY_DOMAIN[action.category] ?? "unknown", ...base };
}

function hardBlockReason(category: ActionCategory): string {
  switch (category) {
    case "credential_or_secret":
      return "credential/secret handling is blocked in v1";
    case "payment_or_purchase":
      return "payments/purchases are blocked in v1";
    case "email_send":
      return "sending email is design-only in v1 (drafting is allowed)";
    case "external_account":
      return "external-account actions are blocked in v1";
    default:
      return "blocked in v1";
  }
}

/**
 * Evaluate how an action should be handled under a policy. PURE: deterministic,
 * no I/O, inputs untouched. An unset policy is treated as the LEGACY posture
 * (preserve current behavior) — permitted, but flagged as compatibility-only.
 */
export function evaluateAction(action: ActionDescriptor, policy?: ActionPolicy): PolicyEvaluation {
  const risk = classifyAction(action);
  const effectiveMode: EffectiveMode = policy ? policy.mode : "legacy";
  const reasons: string[] = [];
  const warnings: string[] = [];

  // Hard blocks override every mode in v1.
  if (HARD_BLOCKED.has(action.category)) {
    return {
      decision: "deny",
      effectiveMode,
      risk,
      reasons: [hardBlockReason(action.category)],
      warnings: [`${action.category} cannot run in v1 — design-only / blocked`],
      hardBlocked: true,
    };
  }

  const risky =
    risk.irreversibility === "irreversible" ||
    risk.touchesExternalWorld ||
    risk.touchesMoney ||
    risk.touchesCredentials ||
    action.category === "unknown";

  let decision: PolicyDecision;
  switch (effectiveMode) {
    case "observe": {
      decision = risk.safetyClass === "read-only" ? "allow" : "preview-only";
      reasons.push(decision === "allow" ? "read-only — safe to inspect" : "observe never commits — preview only");
      break;
    }
    case "assist": {
      const safeLocal =
        risk.safetyClass === "read-only" ||
        (risk.safetyClass === "workspace-write" && risk.irreversibility !== "irreversible") ||
        (risk.irreversibility === "reversible" && !risk.touchesExternalWorld);
      decision = safeLocal ? "allow" : "ask";
      reasons.push(safeLocal ? "safe local/reversible work — auto-allowed in assist" : "destructive/external/irreversible — staged for your approval");
      break;
    }
    case "act": {
      const mustStage = risk.irreversibility === "irreversible" || (risk.touchesExternalWorld && risk.irreversibility !== "reversible");
      decision = mustStage ? "ask" : "allow";
      reasons.push(mustStage ? "irreversible/external — staged for your approval" : "recoverable/local — auto-allowed in act");
      break;
    }
    case "bypass":
    case "legacy":
    default: {
      // Preserve current behavior (permit), but risky actions are log-only — never
      // SILENTLY allowed — so future ledger metadata + warnings still apply.
      decision = risky ? "log-only" : "allow";
      if (risky) warnings.push("risky action permitted under bypass — recorded for audit; Act/Assist would stage it");
      reasons.push(
        effectiveMode === "legacy"
          ? "no ActionPolicy set — legacy/current behavior preserved for compatibility (recommended: assist or act)"
          : "explicit bypass (power-user) — current behavior preserved, fully logged",
      );
      break;
    }
  }

  if (action.category === "unknown") warnings.push("unknown action — treated conservatively, never silently allowed");
  if (effectiveMode === "legacy") warnings.push("ActionPolicy unset: legacy posture, not the recommended default — set assist or act");

  return { decision, effectiveMode, risk, reasons, warnings, hardBlocked: false };
}
