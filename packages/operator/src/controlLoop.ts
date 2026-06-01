// The control loop — the convergent spine (Crix v5 / O1 / concept C1).
//
// One tick = SENSE → ORIENT → DECIDE → ACT → VERIFY → LEARN → PERSIST. The
// loop is DETERMINISTIC: it never calls an LLM to decide policy. It reloads
// durable state, dispatches exactly one bounded step to an ephemeral Worker,
// records the verdict, and converges — or, after a run of no-progress steps,
// diverges and escalates instead of thrashing forever.
//
// In O1 the gap/verification is carried by the Worker's StepVerdict; O3 swaps
// in a real WorldModel re-derived from reality. The loop logic doesn't change.

import { applyVerdict, completeGoal, isActive, isTerminal, markInFlight } from "./goal.js";
import { activeGoals, loadGoal, saveGoal } from "./store.js";
import { runProbe, type ProbeResult } from "./probe.js";
import type { Dispatcher, Goal, OperatorEvent, VerificationSpec } from "./types.js";

export interface ControlLoopContext {
  home: string;
  dispatcher: Dispatcher;
  emit?: (event: OperatorEvent) => void;
  signal?: AbortSignal;
  now?: () => Date;
  /** Workspace for reality probes (file/command). Defaults to process.cwd(). */
  workspace?: string;
  /** Override the reality probe (tests). Defaults to runProbe against the workspace. */
  probe?: (spec: VerificationSpec, signal: AbortSignal) => Promise<ProbeResult>;
}

/** Drive one goal one step forward. Reloads durable state first (resume-safe). */
export async function tickGoal(ctx: ControlLoopContext, goalRef: Goal): Promise<Goal> {
  const now = ctx.now ?? (() => new Date());
  // Reload the canonical durable state — never trust the caller's in-memory copy.
  const goal = (await loadGoal(ctx.home, goalRef.id)) ?? goalRef;
  if (!isActive(goal)) return goal;

  const signal = ctx.signal ?? new AbortController().signal;
  const probe = ctx.probe ?? ((spec, sig) => runProbe(spec, { workspace: ctx.workspace, signal: sig }));

  ctx.emit?.({ type: "tick_started", goalId: goal.id });

  // SENSE / ORIENT: ask reality first. If the goal is already met, finish with
  // no wasted step. (No verification spec → fall through to O1 behavior.)
  let pre: ProbeResult | null = null;
  if (goal.verification) {
    pre = await probe(goal.verification, signal);
    if (pre.met) {
      const done = withFingerprint(completeGoal(goal, pre.summary, now()), pre.fingerprint);
      await saveGoal(ctx.home, done);
      ctx.emit?.({ type: "goal_completed", goalId: goal.id, verdict: done.verdict ?? "goal met" });
      return done;
    }
  }

  // Mark in-flight + persist so a crash mid-ACT is visible on the next start.
  const flighted = markInFlight(goal, now());
  await saveGoal(ctx.home, flighted);

  const index = flighted.stepLog.length;
  ctx.emit?.({ type: "step_dispatched", goalId: goal.id, index });

  // ACT — a fresh, ephemeral Worker. No transcript persists across steps.
  const claim = await ctx.dispatcher.runStep(flighted, { signal, now });

  // VERIFY: reality wins over the Worker's claim. With a verification spec,
  // re-measure — goalMet comes from the probe, and "moved" from whether the
  // world's fingerprint actually changed, not from the Worker's say-so.
  let verdict = claim;
  let fingerprint = goal.lastFingerprint;
  if (goal.verification) {
    const post = await probe(goal.verification, signal);
    const moved =
      pre && pre.fingerprint !== undefined && post.fingerprint !== undefined
        ? pre.fingerprint !== post.fingerprint
        : claim.moved;
    verdict = { moved, goalMet: post.met, evidence: post.summary, prediction: claim.prediction };
    fingerprint = post.fingerprint ?? fingerprint;
  }
  ctx.emit?.({ type: "step_verdict", goalId: goal.id, index, moved: verdict.moved, goalMet: verdict.goalMet });

  // LEARN → PERSIST.
  const next = withFingerprint(applyVerdict(flighted, verdict, now()), fingerprint);
  await saveGoal(ctx.home, next);

  if (next.status === "done") {
    ctx.emit?.({ type: "goal_completed", goalId: goal.id, verdict: next.verdict ?? "goal met" });
  } else if (next.status === "blocked") {
    ctx.emit?.({ type: "goal_diverged", goalId: goal.id, verdict: next.verdict ?? "diverged" });
  }
  return next;
}

function withFingerprint(goal: Goal, fingerprint: string | undefined): Goal {
  return fingerprint !== undefined ? { ...goal, lastFingerprint: fingerprint } : goal;
}

/** One full sweep across every active goal. */
export async function tickAll(ctx: ControlLoopContext): Promise<Goal[]> {
  const goals = await activeGoals(ctx.home);
  const out: Goal[] = [];
  for (const goal of goals) {
    if (ctx.signal?.aborted) break;
    out.push(await tickGoal(ctx, goal));
  }
  return out;
}

/**
 * Dev/test driver: drive a single goal until it reaches a terminal/blocked
 * state or the tick ceiling is hit. The ceiling is a backstop; real divergence
 * is caught earlier by the no-progress streak inside applyVerdict.
 */
export async function runGoalToCompletion(
  ctx: ControlLoopContext,
  goalId: string,
  opts: { maxTicks?: number } = {},
): Promise<Goal> {
  const maxTicks = opts.maxTicks ?? 100;
  let goal = await loadGoal(ctx.home, goalId);
  if (!goal) throw new Error(`goal not found: ${goalId}`);
  let ticks = 0;
  while (isActive(goal) && ticks < maxTicks) {
    if (ctx.signal?.aborted) break;
    goal = await tickGoal(ctx, goal);
    ticks++;
  }
  return goal;
}

export { isActive, isTerminal };
