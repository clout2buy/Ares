// Mission loop engine — pure state transitions for the autonomy spine.
//
// No I/O here. Every function takes a Mission and returns a new Mission so
// the store can persist and lifecycle observers can diff. The engine encodes
// the loop: plan -> execute steps -> verify the goal -> (loop if not met) ->
// complete. Iteration budget guards against infinite looping.

import type {
  Mission,
  MissionDirective,
  MissionLogKind,
  MissionStep,
  MissionStatus,
} from "./types.js";
import { isTerminal } from "./types.js";

const DEFAULT_MAX_ITERATIONS = 6;

export function createMission(input: {
  id: string;
  goal: string;
  steps?: string[];
  maxIterations?: number;
  now?: Date;
}): Mission {
  const at = (input.now ?? new Date()).toISOString();
  const steps = (input.steps ?? []).map((title, index) => toStep(title, index));
  const mission: Mission = {
    id: input.id,
    goal: input.goal.trim(),
    status: steps.length > 0 ? "executing" : "planning",
    steps,
    log: [{ at, kind: "created", detail: input.goal.trim() }],
    iterations: 0,
    maxIterations: clampBudget(input.maxIterations),
    createdAt: at,
    updatedAt: at,
  };
  if (steps.length > 0) {
    mission.log.push({ at, kind: "planned", detail: `${steps.length} step(s)` });
  }
  return mission;
}

export function planMission(mission: Mission, stepTitles: string[], now = new Date()): Mission {
  if (isTerminal(mission.status)) throw new Error(`mission ${mission.id} is ${mission.status}; cannot re-plan`);
  const cleaned = stepTitles.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) throw new Error("planMission requires at least one step");
  // Preserve already-completed steps; replace the open tail with the new plan.
  const kept = mission.steps.filter((s) => s.status === "done");
  const fresh = cleaned.map((title, index) => toStep(title, kept.length + index));
  return touch(
    {
      ...mission,
      steps: [...kept, ...fresh],
      status: "executing",
    },
    now,
    "planned",
    `${fresh.length} step(s)`,
  );
}

export function startNextStep(mission: Mission, now = new Date()): { mission: Mission; step?: MissionStep } {
  if (mission.status !== "executing") return { mission };
  const idx = mission.steps.findIndex((s) => s.status === "pending");
  if (idx === -1) return { mission };
  const steps = mission.steps.map((s, i) => (i === idx ? { ...s, status: "active" as const } : s));
  const step = steps[idx];
  return {
    mission: touch({ ...mission, steps }, now, "step_started", step.title),
    step,
  };
}

export function completeStep(mission: Mission, result: string, stepId?: string, now = new Date()): Mission {
  const target = resolveStep(mission, stepId, ["active", "pending"]);
  if (!target) throw new Error("no open step to complete");
  const steps = mission.steps.map((s) =>
    s.id === target.id ? { ...s, status: "done" as const, result: result.trim() || undefined } : s,
  );
  const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
  const next: Mission = { ...mission, steps, status: allDone ? "verifying" : "executing" };
  return touch(next, now, "step_done", `${target.title}${result ? ` — ${truncate(result)}` : ""}`);
}

export function failStep(mission: Mission, reason: string, stepId?: string, now = new Date()): Mission {
  const target = resolveStep(mission, stepId, ["active", "pending"]);
  if (!target) throw new Error("no open step to fail");
  const steps = mission.steps.map((s) =>
    s.id === target.id ? { ...s, status: "failed" as const, result: reason.trim() || undefined } : s,
  );
  return touch({ ...mission, steps, status: "blocked" }, now, "step_failed", `${target.title} — ${truncate(reason)}`);
}

export interface VerifyResult {
  mission: Mission;
  outcome: "completed" | "looped" | "abandoned";
}

export function verifyMission(
  mission: Mission,
  input: { passed: boolean; verdict: string },
  now = new Date(),
): VerifyResult {
  if (isTerminal(mission.status)) throw new Error(`mission ${mission.id} is already ${mission.status}`);
  const verdict = input.verdict.trim();
  if (input.passed) {
    const next = touch(
      { ...mission, status: "completed", verdict },
      now,
      "completed",
      verdict || "goal met",
    );
    return { mission: next, outcome: "completed" };
  }

  const iterations = mission.iterations + 1;
  if (iterations >= mission.maxIterations) {
    const next = touch(
      { ...mission, status: "abandoned", iterations, verdict },
      now,
      "abandoned",
      `iteration budget (${mission.maxIterations}) exhausted: ${truncate(verdict)}`,
    );
    return { mission: next, outcome: "abandoned" };
  }

  // Loop: re-open for another planning pass so the agent can close the gap.
  const next = touch(
    { ...mission, status: "planning", iterations, verdict },
    now,
    "looped",
    `iteration ${iterations}: ${truncate(verdict)}`,
  );
  return { mission: next, outcome: "looped" };
}

export function abandonMission(mission: Mission, reason: string, now = new Date()): Mission {
  if (isTerminal(mission.status)) return mission;
  return touch({ ...mission, status: "abandoned" }, now, "abandoned", truncate(reason) || "manual stop");
}

export function noteMission(mission: Mission, note: string, now = new Date()): Mission {
  return touch(mission, now, "note", truncate(note));
}

/**
 * What the loop wants next. The single source of truth that turns mission
 * state into a concrete next action for whoever is driving.
 */
export function nextDirective(mission: Mission): MissionDirective {
  switch (mission.status) {
    case "completed":
    case "abandoned":
      return { phase: "done", instruction: `Mission ${mission.status}: ${mission.goal}` };
    case "blocked": {
      const failed = mission.steps.find((s) => s.status === "failed");
      return {
        phase: "blocked",
        instruction: failed
          ? `Step "${failed.title}" failed${failed.result ? ` (${failed.result})` : ""}. Resolve it or re-plan, then continue.`
          : `Mission blocked. Re-plan to continue toward: ${mission.goal}`,
        step: failed,
      };
    }
    case "verifying":
      return {
        phase: "verify",
        instruction: `All steps done. Self-verify the goal is truly met, then call Mission verify (passed true/false): ${mission.goal}`,
      };
    case "planning":
      return {
        phase: mission.iterations > 0 ? "loop" : "plan",
        instruction:
          mission.iterations > 0
            ? `Verification failed (iteration ${mission.iterations}/${mission.maxIterations}). Revise the plan to close the gap${mission.verdict ? `: ${mission.verdict}` : ""}, then call Mission plan.`
            : `Draft a concrete step plan via Mission plan for: ${mission.goal}`,
      };
    case "executing": {
      const active = mission.steps.find((s) => s.status === "active");
      const pending = mission.steps.find((s) => s.status === "pending");
      const step = active ?? pending;
      return {
        phase: "execute",
        instruction: step
          ? `Execute step "${step.title}". When done, call Mission step_done with the result.`
          : `No open steps but status is executing — call Mission verify for: ${mission.goal}`,
        step,
      };
    }
  }
}

export const lifecycleKindForOutcome: Record<VerifyResult["outcome"], MissionLogKind> = {
  completed: "completed",
  looped: "looped",
  abandoned: "abandoned",
};

function toStep(title: string, index: number): MissionStep {
  return { id: `step-${index + 1}`, title: title.trim(), status: "pending" };
}

function resolveStep(mission: Mission, stepId: string | undefined, openStates: MissionStep["status"][]): MissionStep | undefined {
  if (stepId) return mission.steps.find((s) => s.id === stepId);
  return mission.steps.find((s) => openStates.includes(s.status));
}

function touch(mission: Mission, now: Date, kind: MissionLogKind, detail: string): Mission {
  const at = now.toISOString();
  return {
    ...mission,
    updatedAt: at,
    log: [...mission.log, { at, kind, detail }].slice(-200),
  };
}

function clampBudget(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return DEFAULT_MAX_ITERATIONS;
  return Math.min(20, Math.max(1, Math.floor(value)));
}

function truncate(text: string, max = 160): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function statusLabel(status: MissionStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
