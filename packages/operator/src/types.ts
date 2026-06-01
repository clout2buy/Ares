// Operator domain types — the durable autonomy spine (Crix v5 / O1).
//
// A Goal is the long-horizon setpoint the Operator drives toward. The control
// loop runs one bounded step per tick through an ephemeral Worker, records the
// verdict durably, and converges (or diverges → escalates). All state lives in
// the Goal on disk — never in a long-lived LLM context — so the loop survives
// the process dying and resumes exactly where it left off.

export type GoalStatus =
  | "active" // the loop is driving it
  | "blocked" // diverged or needs human attention (escalated)
  | "done" // reality-verified as met
  | "abandoned"; // manually stopped

/** A durable record of one dispatched step. The stepLog is the resume ledger. */
export interface GoalStepRecord {
  index: number;
  at: string;
  moved: boolean; // did this step shrink the gap?
  goalMet: boolean; // did this step satisfy the whole goal?
  evidence?: string;
  /** The Worker's pre-commit prediction — fuels O7 calibration later. */
  prediction?: { outcome: string; p: number };
}

/**
 * How a goal's success is measured against REALITY (O3). Serializable so a goal
 * carries its own verification spec on disk. If a goal has no spec, the control
 * loop falls back to trusting the Worker's claim (O1 behavior).
 */
export type VerificationSpec =
  | { kind: "always"; met: boolean; summary?: string }
  | { kind: "file"; path: string; contains?: string }
  | { kind: "command"; cmd: string; args?: string[]; cwd?: string; expectExit?: number; timeoutMs?: number }
  | { kind: "http"; url: string; expectStatus?: number; contains?: string; timeoutMs?: number };

export interface Goal {
  id: string;
  statement: string;
  status: GoalStatus;
  /** Sub-missions (reuses @crix/agent mission model). Empty in O1. */
  missionIds: string[];
  /** How reality is measured (O3). Absent → trust the Worker's claim (O1). */
  verification?: VerificationSpec;
  /** Last reality fingerprint seen — lets the loop tell if a step changed the world. */
  lastFingerprint?: string;
  /** Count of steps that moved the gap — the convergence signal. */
  progress: number;
  /** Consecutive no-progress steps; hits maxNoProgress → divergence. */
  noProgressStreak: number;
  /** Divergence threshold: escalate rather than thrash past this. */
  maxNoProgress: number;
  /** Set before ACT, cleared on PERSIST — a crash mid-step is visible on resume. */
  inFlightStep?: number;
  stepLog: GoalStepRecord[];
  verdict?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a Worker reports after running one bounded step. In O1 this is derived
 * from the Worker's turn; in O3 `goalMet`/`moved` come from a reality probe.
 */
export interface StepVerdict {
  moved: boolean;
  goalMet: boolean;
  evidence?: string;
  prediction?: { outcome: string; p: number };
}

export interface DispatchContext {
  signal: AbortSignal;
  now: () => Date;
}

/**
 * The thing that actually does work. The control loop is deterministic and
 * never calls an LLM itself — it dispatches one bounded step to a Dispatcher,
 * which (in the real impl) spawns a fresh, scoped QueryEngine Worker.
 */
export interface Dispatcher {
  runStep(goal: Goal, ctx: DispatchContext): Promise<StepVerdict>;
}

/** Observable lifecycle events — the seed of O11 legibility. */
export type OperatorEvent =
  | { type: "tick_started"; goalId: string }
  | { type: "step_dispatched"; goalId: string; index: number }
  | { type: "step_verdict"; goalId: string; index: number; moved: boolean; goalMet: boolean }
  | { type: "goal_completed"; goalId: string; verdict: string }
  | { type: "goal_diverged"; goalId: string; verdict: string }
  | { type: "goal_abandoned"; goalId: string; verdict: string };
