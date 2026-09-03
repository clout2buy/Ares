// Plan pressure — the host-side half of the engine's structural
// plan-before-edit gate (QueryEngineConfig.planBeforeEdit).
//
// Roadmap C3 asked for "substantial prompt → a plan exists before the first
// write tool call; trivial prompt → zero scaffolding". The prompt-only version
// (`tacticsDirective`) was advice the model could skip; the engine can now
// force TodoWrite as the first tool call of a turn, but it has no opinion on
// WHICH turns deserve that ceremony — that is a judgement about the user's
// message, which lives in the mind's intent classifier. This module is the
// bridge: the pipeline calls `shouldPlanBeforeEdit` on the raw user text and
// the session's plan-pressure holder is read by the engine at its first model
// call. Keeping it a plain function keeps it testable without a session.

import { classifyUserIntent, type UserIntentKind } from "@ares/mind";

/** Intent kinds whose "substantial" grade means multi-step WORK, not a long
 *  question. External actions are deliberately excluded: forcing a todo list
 *  before "send the email" is ceremony, not safety (the effect gate covers it). */
const PLAN_WORTHY: ReadonlySet<UserIntentKind> = new Set<UserIntentKind>([
  "coding_task",
  "self_architecture",
  "autonomous_mission",
]);

/** Mutable per-session holder the engine's `planBeforeEdit` callback reads.
 *  A holder (not a value) because the Session is constructed once and the
 *  verdict changes every turn. */
export interface PlanPressure {
  next: boolean;
  /** Why the last verdict was what it was — surfaces in diagnostics. */
  reason: string;
}

export function createPlanPressure(): PlanPressure {
  return { next: false, reason: "no turn yet" };
}

/**
 * Should the NEXT turn be forced to open with a plan? True only for messages
 * the classifier grades `substantial` in a plan-worthy kind. Slash commands,
 * greetings, questions and one-line fixes stay instant. ARES_PLAN_BEFORE_EDIT=0
 * is honoured by the engine itself; this stays pure.
 */
export function shouldPlanBeforeEdit(text: string): { plan: boolean; reason: string } {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return { plan: false, reason: "empty or slash command" };
  const intent = classifyUserIntent(trimmed);
  if (intent.complexity !== "substantial") return { plan: false, reason: `complexity ${intent.complexity}` };
  if (!PLAN_WORTHY.has(intent.kind)) return { plan: false, reason: `kind ${intent.kind} is not plan-worthy` };
  return { plan: true, reason: `substantial ${intent.kind}` };
}

/** Convenience for the pipeline: grade the message and record it on the holder. */
export function applyPlanPressure(holder: PlanPressure | undefined, text: string): void {
  if (!holder) return;
  const verdict = shouldPlanBeforeEdit(text);
  holder.next = verdict.plan;
  holder.reason = verdict.reason;
}
