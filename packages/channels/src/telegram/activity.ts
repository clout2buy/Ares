// The activity card — what Ares is actually DOING, live, in one message.
//
// Before this, a turn showed a single "⚙ <latest tool>" line that was
// overwritten by the next tool and abandoned at turn_end: no history, no
// durations, no failures (tool_error had no renderer at all), and a stale
// "⚙ Reading foo.ts" left sitting in the chat forever. The card replaces it
// with an accumulating checklist that finalizes into a one-line receipt.
//
// Pure functions over plain state so the bridge stays testable and the
// rendering can be asserted without a Telegram fake.

export type ActivityStepState = "running" | "ok" | "failed";

export interface ActivityStep {
  /** tool_use id — how tool_end/tool_error find their step again. */
  id: string;
  /** The tool's own activityDescription ("Reading bridge.ts"). */
  label: string;
  startedAt: number;
  endedAt?: number;
  state: ActivityStepState;
  /** One short line of why a step failed. */
  detail?: string;
}

export interface ActivityCardState {
  startedAt: number;
  steps: ActivityStep[];
  /** Set once a mid-turn correction has been routed into this turn. */
  steering: boolean;
}

/** Steps rendered in full; older ones collapse into a "+N earlier" line. */
export const MAX_VISIBLE_STEPS = 8;
/** Failure detail is a hint, not a stack trace. */
const MAX_DETAIL_CHARS = 90;
const MAX_LABEL_CHARS = 60;

export function newActivityCard(startedAt: number): ActivityCardState {
  return { startedAt, steps: [], steering: false };
}

/** "0.4s", "12s", "3m 20s" — short enough to sit at the end of a line. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** First meaningful line of an error, stripped of the noise that precedes it. */
export function shortFailureDetail(error: unknown): string | undefined {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  return clip(line.replace(/^(Error|tool_use_error):\s*/i, ""), MAX_DETAIL_CHARS);
}

function stepLine(step: ActivityStep, now: number): string {
  const label = clip(step.label, MAX_LABEL_CHARS);
  if (step.state === "running") {
    const elapsed = now - step.startedAt;
    // A fast tool doesn't need a clock; a slow one is exactly when you want it.
    return elapsed >= 2000 ? `⚙ ${label}… ${formatDuration(elapsed)}` : `⚙ ${label}…`;
  }
  const took = formatDuration((step.endedAt ?? now) - step.startedAt);
  if (step.state === "ok") return `✓ ${label} · ${took}`;
  return `✗ ${label} · ${took}${step.detail ? ` — ${step.detail}` : ""}`;
}

/** The live card, rendered fresh on every edit. */
export function renderActivityCard(card: ActivityCardState, now: number): string {
  const head = `${card.steering ? "↪ Steering" : "🜂 Working"} · ${formatDuration(now - card.startedAt)}`;
  if (card.steps.length === 0) return head;
  const lines: string[] = [head];
  const hidden = card.steps.length - MAX_VISIBLE_STEPS;
  if (hidden > 0) lines.push(`… +${hidden} earlier`);
  for (const step of card.steps.slice(-MAX_VISIBLE_STEPS)) lines.push(stepLine(step, now));
  return lines.join("\n");
}

/**
 * The receipt the card becomes at turn_end. Collapsing to one line keeps the
 * chat scrollable while still leaving a record of what ran — and, when
 * something broke, which step broke and why.
 */
export function renderActivitySummary(card: ActivityCardState, now: number): string {
  const count = card.steps.length;
  const took = formatDuration(now - card.startedAt);
  const plural = count === 1 ? "step" : "steps";
  const failed = card.steps.filter((s) => s.state === "failed");
  if (failed.length === 0) return `✓ ${count} ${plural} · ${took}`;
  const first = failed[0];
  const detail = first.detail ? ` — ${first.detail}` : "";
  return [
    `⚠ ${count} ${plural} · ${took} · ${failed.length} failed`,
    `✗ ${clip(first.label, MAX_LABEL_CHARS)}${detail}`,
  ].join("\n");
}
