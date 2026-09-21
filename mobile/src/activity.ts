// The activity card — what Ares is DOING, live. A port of
// packages/channels/src/telegram/activity.ts: same step model, same receipt,
// so the phone and Telegram tell the same story about a turn.

export type ActivityStepState = "running" | "ok" | "failed";

export interface ActivityStep {
  id: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  state: ActivityStepState;
  detail?: string;
}

export interface ActivityCardState {
  startedAt: number;
  steps: ActivityStep[];
  steering: boolean;
  done: boolean;
}

const MAX_DETAIL_CHARS = 120;

export function newActivityCard(startedAt: number): ActivityCardState {
  return { startedAt, steps: [], steering: false, done: false };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

export function shortFailureDetail(error: unknown): string | undefined {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const flat = line.replace(/^(Error|tool_use_error):\s*/i, "");
  return flat.length <= MAX_DETAIL_CHARS ? flat : `${flat.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

export function finishStep(card: ActivityCardState, id: string, state: "ok" | "failed", now: number, detail?: string): void {
  for (let i = card.steps.length - 1; i >= 0; i--) {
    const step = card.steps[i];
    if (step.id !== id || step.state !== "running") continue;
    step.state = state;
    step.endedAt = now;
    if (detail) step.detail = detail;
    return;
  }
}

/** Close a turn: anything still open never finished. */
export function sealCard(card: ActivityCardState, now: number): void {
  for (const step of card.steps) {
    if (step.state === "running") {
      step.state = "failed";
      step.endedAt = now;
      step.detail ??= "never finished";
    }
  }
  card.done = true;
}

export function cardSummary(card: ActivityCardState, now: number): { headline: string; failed: number } {
  const count = card.steps.length;
  const took = formatDuration((card.done ? (card.steps[card.steps.length - 1]?.endedAt ?? now) : now) - card.startedAt);
  const failed = card.steps.filter((s) => s.state === "failed").length;
  const plural = count === 1 ? "step" : "steps";
  if (!card.done) return { headline: `${card.steering ? "Steering" : "Working"} · ${took}`, failed };
  return { headline: failed === 0 ? `${count} ${plural} · ${took}` : `${count} ${plural} · ${took} · ${failed} failed`, failed };
}
