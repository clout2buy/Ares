// Proactive Daily Briefing (Nexus Phase 1) — "what should I work on today?"
//
// A PURE ranking/framing layer over the things Ares already assembled: the
// continuity summary (mission buckets + read-only advisory), the World Graph
// (which subsystems each mission touches), and the learning cards (prior
// lessons). It reads nothing and mutates nothing — the CLI loads, this shapes.
//
// Deterministic only — no LLM ranking, no fake deadlines, no invented urgency.
// Every focus item carries CITED signals (facts from the mission), and the
// advisory is surfaced as a labeled suggestion, never as fact.

import type { ContinuityMissionView, ContinuitySummary } from "./continuity.js";
import { selectRelevantLessons, type LearningCard } from "./learningCard.js";
import type { WorldGraph } from "./worldGraph.js";

export interface BriefingFocusItem {
  missionId: string;
  intent: string;
  status: string;
  percent: number;
  nextAction?: string;
  /** Cited, factual signals behind the ranking (no urgency wording). */
  reasons: string[];
  /** Subsystems this mission touches, from the World Graph. */
  relatedSubsystems: string[];
  /** A prior lesson that bears on this work, when one is relevant. */
  lesson?: string;
  score: number;
}

export interface BriefingDecisionItem {
  missionId: string;
  intent: string;
  kind: "blocked" | "stale";
  detail: string;
}

export interface BriefingShippedItem {
  missionId: string;
  intent: string;
  updatedAt: string;
}

export interface BriefingSuggestion {
  goal: string;
  rationale: string;
  confidence: number;
}

export interface DailyBriefing {
  headline: string;
  focus: BriefingFocusItem[];
  /** Blocked missions — a call you have to make, not work to grind. */
  decisionsNeeded: BriefingDecisionItem[];
  /** Stale missions — revive or drop, never faked into urgent work. */
  reviveOrDrop: BriefingDecisionItem[];
  recentlyShipped: BriefingShippedItem[];
  /** Non-binding advisory next-step (label as "suggested", never fact). */
  suggestion?: BriefingSuggestion | null;
  empty: boolean;
}

export interface RankBriefingInput {
  summary: ContinuitySummary;
  lessons?: LearningCard[];
  worldGraph?: WorldGraph;
  /** ISO timestamp the caller supplies, so staleness is deterministic/testable. */
  now: string;
  /** Max focus items. Default 3. */
  focusLimit?: number;
  /** Days untouched before an open mission is "stale". Default 14. */
  staleDays?: number;
}

const DAY_MS = 86_400_000;

function ageDays(updatedAt: string, now: number): number {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, (now - then) / DAY_MS);
}

function recencyPhrase(age: number): string {
  if (age < 1) return "touched today";
  if (age < 7) return `touched ${Math.round(age)}d ago`;
  return `idle ${Math.round(age)}d`;
}

/** Score an open mission: actionable + near-done + recently-touched ranks high. */
function score(view: ContinuityMissionView, now: number): number {
  const nearness = clamp01(view.percent / 100);
  const hasAction = view.nextAction ? 1 : 0;
  const recency = clamp01(1 - ageDays(view.updatedAt, now) / 14);
  const statusBoost = view.status === "active" ? 0.1 : 0;
  return 0.4 * hasAction + 0.35 * nearness + 0.25 * recency + statusBoost;
}

function reasonsFor(view: ContinuityMissionView, now: number): string[] {
  const reasons: string[] = [];
  if (view.totalCriteria > 0) reasons.push(`${view.percent}% done (${view.completedCriteria}/${view.totalCriteria} criteria)`);
  reasons.push(view.nextAction ? `next: ${view.nextAction}` : "needs a plan (no next action set)");
  reasons.push(recencyPhrase(ageDays(view.updatedAt, now)));
  reasons.push(view.status);
  return reasons;
}

function relatedSubsystems(graph: WorldGraph | undefined, missionId: string): string[] {
  if (!graph) return [];
  const refById = new Map(graph.entities.map((e) => [e.id, e.ref] as const));
  return graph.relations
    .filter((r) => r.from === `mission:${missionId}` && r.kind === "relates-to")
    .map((r) => refById.get(r.to) ?? "")
    .filter(Boolean);
}

function lessonFor(lessons: LearningCard[] | undefined, intent: string): string | undefined {
  if (!lessons || lessons.length === 0) return undefined;
  const [match] = selectRelevantLessons(lessons, [intent], 1);
  if (!match) return undefined;
  return `prior: [${match.result}] ${clip(match.intent, 60)} (${Math.round(match.confidence * 100)}%)`;
}

/** Build the briefing. PURE: never reads disk, never mutates inputs. */
export function rankBriefing(input: RankBriefingInput): DailyBriefing {
  const now = Date.parse(input.now);
  const focusLimit = input.focusLimit ?? 3;
  const staleDays = input.staleDays ?? 14;
  const { summary } = input;

  if (summary.empty) {
    return {
      headline: "Clean slate — no active missions. Start one with `ares operator add`.",
      focus: [],
      decisionsNeeded: [],
      reviveOrDrop: [],
      recentlyShipped: [],
      suggestion: summary.advisory ?? null,
      empty: true,
    };
  }

  // summary.active = active + draft; split off the stale ones (revive-or-drop),
  // rank the rest into focus.
  const fresh: ContinuityMissionView[] = [];
  const stale: ContinuityMissionView[] = [];
  for (const view of summary.active) {
    (ageDays(view.updatedAt, now) >= staleDays ? stale : fresh).push(view);
  }

  const focus: BriefingFocusItem[] = fresh
    .map((view) => ({
      missionId: view.id,
      intent: view.intent,
      status: view.status,
      percent: view.percent,
      nextAction: view.nextAction,
      reasons: reasonsFor(view, now),
      relatedSubsystems: relatedSubsystems(input.worldGraph, view.id),
      lesson: lessonFor(input.lessons, view.intent),
      score: score(view, now),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, focusLimit);

  const reviveOrDrop: BriefingDecisionItem[] = stale.map((view) => ({
    missionId: view.id,
    intent: view.intent,
    kind: "stale",
    detail: `untouched ${Math.round(ageDays(view.updatedAt, now))}d at ${view.percent}%`,
  }));

  const decisionsNeeded: BriefingDecisionItem[] = summary.blocked.map((view) => ({
    missionId: view.id,
    intent: view.intent,
    kind: "blocked",
    detail: view.blockers.length ? view.blockers.join("; ") : "blocked (no reason recorded)",
  }));

  const recentlyShipped: BriefingShippedItem[] = summary.recentlySatisfied.map((view) => ({
    missionId: view.id,
    intent: view.intent,
    updatedAt: view.updatedAt,
  }));

  const headline = focus.length
    ? `${focus.length} in focus, ${decisionsNeeded.length} blocked, ${reviveOrDrop.length} stale. Top — ${clip(focus[0].intent, 56)} (${focus[0].percent}%).`
    : decisionsNeeded.length
      ? `Nothing fresh to push — ${decisionsNeeded.length} blocked need a decision.`
      : reviveOrDrop.length
        ? `No active work — ${reviveOrDrop.length} stale mission(s) to revive or drop.`
        : "No open missions right now.";

  return {
    headline,
    focus,
    decisionsNeeded,
    reviveOrDrop,
    recentlyShipped,
    suggestion: summary.advisory ?? null,
    empty: false,
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
