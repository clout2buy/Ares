// Approval Rail types (Phase 2) — the request/decision/proof/rollback shapes the
// rail passes around, plus pure helpers (redaction, expiry, rollback derivation).
//
// These build on the Phase-1 policy brain (RiskAssessment) and the effects
// Irreversibility/cost model. No I/O, no wiring yet — Phase 3 makes a staged
// effect actually emit an ApprovalRequest and resume on an ApprovalDecision.

import type { ActionCategory, RiskAssessment } from "./policy.js";
import type { EffectCost, Irreversibility } from "./types.js";

/** What the rails hand to a requestApproval callback when an effect is staged. */
export interface StagedApproval {
  /** The effect's idempotency key — stable id for this pending approval. */
  id: string;
  kind: string;
  domain: string;
  irreversibility: Irreversibility;
  cost?: EffectCost;
  reason: string;
  /** simulate() output — the "what would happen" preview. */
  preview?: unknown;
}

/** Mirrors protocol's PermissionPromptDecision so the existing card/transport is reused. */
export type ApprovalVerb = "allow_once" | "allow_always" | "deny";

export interface ActionPreview {
  kind: "diff" | "command" | "url" | "recipient" | "amount" | "raw";
  /** Human one-liner ("push 3 commits to origin/main"). */
  summary: string;
  /** The diff / command / url / payload — already redacted. */
  payload?: string;
  redacted: boolean;
}

export interface RollbackHint {
  kind: "undo" | "checkpoint" | "none";
  /** A checkpoint id or effect idempotency key the rollback targets. */
  ref?: string;
  reversible: boolean;
  note?: string;
}

export interface ApprovalRequest {
  id: string;
  category: ActionCategory;
  domain: string;
  risk: RiskAssessment;
  preview: ActionPreview;
  reason: string;
  /** The rail's recommended default button. */
  suggestion?: ApprovalVerb;
  cost?: EffectCost;
  createdAt: string;
  /** When set and passed, the request auto-denies (safety on a lost approver). */
  expiresAt?: string;
}

export interface ApprovalDecision {
  id: string;
  verb: ApprovalVerb;
  at: string;
  /** Who decided — the owner. */
  approver?: string;
  note?: string;
}

export interface ProofCard {
  at: string;
  category: ActionCategory;
  /** The effect kind that ran. */
  action: string;
  domain: string;
  preview: ActionPreview;
  outcome?: string;
  /** Filmstrip manifest reference (browser) and/or a workspace checkpoint id. */
  filmstripRef?: string;
  checkpointId?: string;
  /** The effect's idempotency key — links this proof to its ledger entry. */
  ledgerKey: string;
  rollback: RollbackHint;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  /\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** Redact obvious secrets from a preview payload before it's shown/logged. Pure. */
export function redactPreview(preview: ActionPreview): ActionPreview {
  if (!preview.payload) return { ...preview };
  let payload = preview.payload;
  let hit = false;
  for (const re of SECRET_PATTERNS) {
    payload = payload.replace(re, () => {
      hit = true;
      return "[redacted]";
    });
  }
  return { ...preview, payload, redacted: preview.redacted || hit };
}

/** Has this request passed its expiry as of `nowIso`? Pure. */
export function isApprovalExpired(req: ApprovalRequest, nowIso: string): boolean {
  if (!req.expiresAt) return false;
  const now = Date.parse(nowIso);
  const exp = Date.parse(req.expiresAt);
  return Number.isFinite(now) && Number.isFinite(exp) && now >= exp;
}

/** Derive a rollback hint from a risk assessment. Pure. */
export function defaultRollbackHint(risk: RiskAssessment): RollbackHint {
  if (!risk.rollbackAvailable) {
    return { kind: "none", reversible: false, note: "no automatic rollback for this action" };
  }
  if (risk.touchesUserFiles || risk.domain === "fs" || risk.domain === "git") {
    return { kind: "checkpoint", reversible: true, note: "restore the pre-action workspace checkpoint" };
  }
  return { kind: "undo", reversible: true, note: "run the effect's undo()" };
}
