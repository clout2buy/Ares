import {
  DEFAULT_MASTERY_SUCCESSES,
  createCapability,
  crystallize,
  markForbidden,
  markRotted,
  type CapabilityNode,
} from "./capability.js";
import { slugify } from "./graphStore.js";
import type { EvalReport } from "./evalHarness.js";

export type CapabilityEvidenceKind = "verification" | "eval" | "artifact" | "manual";

export interface CapabilityEvidence {
  id: string;
  at: string;
  kind: CapabilityEvidenceKind;
  summary: string;
  passed: boolean;
  score?: number;
}

export interface PromotionPolicy {
  minEvidence?: number;
  minEvalPasses?: number;
  minEvalScore?: number;
  minVerifiedSuccesses?: number;
}

export interface PromotionReadiness {
  ready: boolean;
  reasons: string[];
  passedEvidence: number;
  passedEvalTasks: number;
  evalScore: number;
  verifiedSuccesses: number;
}

export interface PromotionResult {
  node: CapabilityNode;
  promoted: boolean;
  readiness: PromotionReadiness;
}

export function draftCapability(input: {
  id?: string;
  name: string;
  requires?: string[];
  now?: Date;
}): CapabilityNode {
  const name = input.name.trim();
  if (!name) throw new Error("draftCapability requires name");
  return createCapability({
    id: input.id ?? `draft/${slugify(name)}`,
    name,
    requires: input.requires,
    status: "want",
    now: input.now,
  });
}

export function capabilityEvidence(input: {
  id?: string;
  kind?: CapabilityEvidenceKind;
  summary: string;
  passed?: boolean;
  score?: number;
  now?: Date;
}): CapabilityEvidence {
  const summary = input.summary.trim();
  if (!summary) throw new Error("capabilityEvidence requires summary");
  return {
    id: input.id ?? `evidence/${slugify(summary).slice(0, 48) || "item"}`,
    at: (input.now ?? new Date()).toISOString(),
    kind: input.kind ?? "manual",
    summary,
    passed: input.passed ?? true,
    score: input.score,
  };
}

export function assessPromotionReadiness(
  node: CapabilityNode,
  input: {
    evidence?: readonly CapabilityEvidence[];
    evalReport?: EvalReport;
    policy?: PromotionPolicy;
  } = {},
): PromotionReadiness {
  const policy = normalizePromotionPolicy(input.policy);
  const passedEvidence = (input.evidence ?? []).filter((item) => item.passed).length;
  const passedEvalTasks = input.evalReport?.passed ?? 0;
  const evalScore = input.evalReport?.score ?? 0;
  const verifiedSuccesses = node.outcomes.ok;
  const reasons: string[] = [];

  if (verifiedSuccesses < policy.minVerifiedSuccesses) {
    reasons.push(`needs ${policy.minVerifiedSuccesses} verified success(es), has ${verifiedSuccesses}`);
  }
  if (passedEvidence < policy.minEvidence) {
    reasons.push(`needs ${policy.minEvidence} passed evidence item(s), has ${passedEvidence}`);
  }
  if (!input.evalReport && policy.minEvalPasses > 0) {
    reasons.push("needs eval report");
  } else {
    if (passedEvalTasks < policy.minEvalPasses) {
      reasons.push(`needs ${policy.minEvalPasses} passed eval task(s), has ${passedEvalTasks}`);
    }
    if (evalScore < policy.minEvalScore) {
      reasons.push(`needs eval score >= ${policy.minEvalScore}, has ${evalScore}`);
    }
    if ((input.evalReport?.failed ?? 0) > 0) {
      reasons.push(`eval report has ${input.evalReport?.failed} failed task(s)`);
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    passedEvidence,
    passedEvalTasks,
    evalScore,
    verifiedSuccesses,
  };
}

export function promoteCapability(
  node: CapabilityNode,
  input: {
    evidence?: readonly CapabilityEvidence[];
    evalReport?: EvalReport;
    policy?: PromotionPolicy;
    skillRef?: string;
    playbookRef?: string;
    now?: Date;
  } = {},
): PromotionResult {
  const policy = normalizePromotionPolicy(input.policy);
  const readiness = assessPromotionReadiness(node, { evidence: input.evidence, evalReport: input.evalReport, policy });
  if (!readiness.ready) return { node, promoted: false, readiness };
  return {
    node: crystallize(node, {
      skillRef: input.skillRef ?? node.skillRef ?? slugify(node.name),
      playbookRef: input.playbookRef,
      minSuccesses: policy.minVerifiedSuccesses,
      now: input.now,
    }),
    promoted: true,
    readiness,
  };
}

export function rejectCapabilityDraft(
  node: CapabilityNode,
  input: { reason: string; forbidden?: boolean; now?: Date },
): CapabilityNode {
  const reason = input.reason.trim();
  if (!reason) throw new Error("rejectCapabilityDraft requires reason");
  return input.forbidden ? markForbidden(node, reason, input.now) : markRotted(node, reason, input.now);
}

function normalizePromotionPolicy(policy: PromotionPolicy = {}): Required<PromotionPolicy> {
  return {
    minEvidence: clampInteger(policy.minEvidence, 1, 100, 1),
    minEvalPasses: clampInteger(policy.minEvalPasses, 1, 1_000, 1),
    minEvalScore: clampNumber(policy.minEvalScore, 0.01, 1, 1),
    minVerifiedSuccesses: clampInteger(policy.minVerifiedSuccesses, 1, 100, DEFAULT_MASTERY_SUCCESSES),
  };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
