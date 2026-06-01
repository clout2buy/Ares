// @crix/operator — the durable autonomy spine (Crix v5).
//
// The Operator is the WILL: a small, boring, always-on supervisor that holds
// long-horizon goals and drives them to reality-verified completion through
// ephemeral QueryEngine Workers (the HANDS), surviving the process dying.
//
// O1 ships the spine on a software world: GoalStore + Scheduler + ControlLoop
// + Dispatcher. Effects/rails (O2), reality verification (O3), and the
// compounding capability graph (O4) bolt on above this without changing it.
//
// Boundary: like @crix/agent, nothing in @crix/core or @crix/tools imports
// this package — the will sits on top of the hands, never the reverse.

export {
  createGoal,
  applyVerdict,
  completeGoal,
  markInFlight,
  abandonGoal,
  isActive,
  isTerminal,
  nextStepIndex,
} from "./goal.js";

export { newGoalId, saveGoal, loadGoal, listGoals, activeGoals } from "./store.js";

export {
  tickGoal,
  tickAll,
  runGoalToCompletion,
  type ControlLoopContext,
} from "./controlLoop.js";

export {
  QueryEngineDispatcher,
  defaultEvaluate,
  type QueryEngineDispatcherOptions,
} from "./dispatcher.js";

export { Scheduler, type SchedulerOptions } from "./scheduler.js";

export { operatorPaths, type OperatorPaths } from "./paths.js";

export { runProbe, type ProbeResult, type ProbeContext } from "./probe.js";

export { WorldModel, type WorldSource, type WorldSnapshot } from "./worldModel.js";

// ── O4: the compounding capability graph ──────────────────────────────────
export {
  createCapability,
  beginLearning,
  recordOutcome,
  reliabilityOf,
  canCrystallize,
  crystallize,
  markRotted,
  markForbidden,
  isReusable,
  addMethod,
  DEFAULT_MASTERY_SUCCESSES,
  type CapabilityNode,
  type CapabilityStatus,
  type CapabilityOutcomes,
  type MethodKind,
  type MethodRung,
} from "./capability.js";

export { novelDelta, reusedSubskills, factor, novelDeltaCurve } from "./graph.js";

export {
  slugify,
  saveCapability,
  loadCapability,
  listCapabilities,
  writeCrystallizedSkill,
} from "./graphStore.js";

export {
  driveLearning,
  nextLearningPhase,
  type LearningPhase,
  type LearnDeps,
  type LearnAttemptResult,
  type LearnEvent,
} from "./learn.js";

// ── O5: the two ladders (method + perception) ─────────────────────────────
export {
  resolveMethod,
  acquireMethod,
  isAvailable,
  METHOD_RANK,
  type MethodEnvironment,
  type MethodResolution,
  type AcquireDeps,
  type AcquireResult,
} from "./method.js";

export { routePerception, PERCEPTION_RANK, type PerceptionRung, type PerceptionNeed } from "./perception.js";

export type {
  Goal,
  GoalStatus,
  GoalStepRecord,
  StepVerdict,
  VerificationSpec,
  Dispatcher,
  DispatchContext,
  OperatorEvent,
} from "./types.js";
