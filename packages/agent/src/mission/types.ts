// Mission domain — the autonomy spine.
//
// A Mission is a goal the agent drives to completion through an explicit
// goal -> plan -> execute -> self-verify -> loop state machine. Missions are
// persisted under ~/.crix/missions/ so they survive across sessions and the
// agent (or, later, a background executor) can resume them autonomously.

export type MissionStatus =
  | "planning" // created, goal known, no plan yet
  | "executing" // working through the plan
  | "verifying" // every step done, checking the goal is truly met
  | "blocked" // a step failed or needs attention before continuing
  | "completed" // goal verified as met
  | "abandoned"; // gave up (iteration budget exhausted or manual stop)

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface MissionStep {
  id: string;
  title: string;
  status: StepStatus;
  result?: string;
}

export type MissionLogKind =
  | "created"
  | "planned"
  | "step_started"
  | "step_done"
  | "step_failed"
  | "verified"
  | "looped"
  | "blocked"
  | "completed"
  | "abandoned"
  | "note";

export interface MissionLogEntry {
  at: string;
  kind: MissionLogKind;
  detail: string;
}

export interface Mission {
  id: string;
  goal: string;
  status: MissionStatus;
  steps: MissionStep[];
  log: MissionLogEntry[];
  iterations: number;
  maxIterations: number;
  verdict?: string;
  createdAt: string;
  updatedAt: string;
}

export type MissionPhase = "plan" | "execute" | "verify" | "loop" | "done" | "blocked";

/**
 * The next concrete action the loop wants. This is what makes a mission a
 * real loop rather than a checklist: at any moment the engine can tell the
 * driver (the agent today, a background executor tomorrow) exactly what to
 * do next to push the goal forward.
 */
export interface MissionDirective {
  phase: MissionPhase;
  instruction: string;
  step?: MissionStep;
}

export interface MissionSummary {
  id: string;
  goal: string;
  status: MissionStatus;
  done: number;
  total: number;
  iterations: number;
  updatedAt: string;
}

export function isTerminal(status: MissionStatus): boolean {
  return status === "completed" || status === "abandoned";
}

export function summarize(mission: Mission): MissionSummary {
  return {
    id: mission.id,
    goal: mission.goal,
    status: mission.status,
    done: mission.steps.filter((s) => s.status === "done").length,
    total: mission.steps.length,
    iterations: mission.iterations,
    updatedAt: mission.updatedAt,
  };
}
