// Ghost Continue v1 — the continuity summarizer (Ares v6 / Phase A).
//
// "Ares, what were we doing?" — answered from durable mission state alone.
// This is a PURE function over MissionContracts (+ Goals for human-readable
// statements): no I/O, no mutation, no new storage. The CLI does the reading
// and the optional enrichment (unified recall + advisory cognition); this just
// shapes the durable truth into a continuity card.
//
// What it answers today: what's active, what's blocked, what just got done,
// how far along, when we last touched it, the open blockers, the next actions,
// and the freshest evidence receipts. What it deliberately does NOT answer yet:
// "why it failed / what worked / the reusable pattern" — that needs Mission
// Learning Cards (the next phase), which distill lessons this layer can't see.

import type { MissionContract, MissionContractStatus } from "./missionContract.js";
import type { Goal } from "./types.js";

export interface ContinuityMissionView {
  id: string;
  intent: string;
  /** The human-readable goal this mission serves, when one is linked. */
  goalStatement?: string;
  status: MissionContractStatus;
  percent: number;
  completedCriteria: number;
  totalCriteria: number;
  updatedAt: string;
  /** Unresolved blocker reasons (resolved blockers are dropped). */
  blockers: string[];
  nextAction?: string;
  /** Freshest evidence receipts, newest first: "kind: summary". */
  topEvidence: string[];
}

export interface ContinuityAdvisory {
  goal: string;
  rationale: string;
  confidence: number;
}

export interface ContinuitySummary {
  /** Total contracts seen (across all statuses). */
  missionCount: number;
  /** Newest updatedAt across all contracts — "last active". */
  lastActiveAt?: string;
  active: ContinuityMissionView[];
  blocked: ContinuityMissionView[];
  recentlySatisfied: ContinuityMissionView[];
  /** True when there are no missions at all — a clean slate. */
  empty: boolean;
  /** Optional enrichment from the unified recall (caller-supplied). */
  relatedMemory?: string[];
  /** Optional advisory next-step from cognition (caller-supplied). */
  advisory?: ContinuityAdvisory | null;
  /** Relevant Learning Cards (caller-supplied): "[result] intent (confidence%)". */
  lessons?: string[];
}

export interface SummarizeContinuityInput {
  contracts: MissionContract[];
  goals?: Goal[];
  /** Max missions per bucket (active/blocked/satisfied). Default 5. */
  maxPerBucket?: number;
  /** Max evidence receipts per mission. Default 3. */
  maxEvidence?: number;
  relatedMemory?: string[];
  advisory?: ContinuityAdvisory | null;
  lessons?: string[];
}

/** Build the continuity card. Pure: never reads disk, never mutates inputs. */
export function summarizeContinuity(input: SummarizeContinuityInput): ContinuitySummary {
  const maxPerBucket = input.maxPerBucket ?? 5;
  const maxEvidence = input.maxEvidence ?? 3;
  const goalById = new Map((input.goals ?? []).map((g) => [g.id, g] as const));

  // Newest first, without mutating the caller's array.
  const byRecency = [...input.contracts].sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt));

  const toView = (c: MissionContract): ContinuityMissionView => ({
    id: c.id,
    intent: c.intent,
    goalStatement: c.goalId ? goalById.get(c.goalId)?.statement : undefined,
    status: c.progress.status,
    percent: c.progress.percent,
    completedCriteria: c.progress.completedCriteria,
    totalCriteria: c.progress.totalCriteria,
    updatedAt: c.updatedAt,
    blockers: c.blockers.filter((b) => !b.resolvedAt).map((b) => b.reason),
    nextAction: c.nextAction?.summary,
    topEvidence: c.evidenceLog
      .slice(-maxEvidence)
      .reverse()
      .map((e) => `${e.kind}: ${e.summary}`),
  });

  const inBucket = (statuses: MissionContractStatus[]): ContinuityMissionView[] =>
    byRecency.filter((c) => statuses.includes(c.progress.status)).slice(0, maxPerBucket).map(toView);

  return {
    missionCount: input.contracts.length,
    lastActiveAt: byRecency[0]?.updatedAt,
    active: inBucket(["active", "draft"]),
    blocked: inBucket(["blocked"]),
    recentlySatisfied: inBucket(["satisfied"]),
    empty: input.contracts.length === 0,
    relatedMemory: input.relatedMemory,
    advisory: input.advisory ?? null,
    lessons: input.lessons,
  };
}

/** ISO-8601 strings sort lexicographically, so compare as strings (newest first). */
function compareIsoDesc(a: string, b: string): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}
