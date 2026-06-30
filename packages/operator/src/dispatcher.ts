// The Dispatcher — the bridge from the deterministic loop to clever work.
//
// QueryEngineDispatcher spawns a FRESH, scoped QueryEngine per step (this is
// the "mortal hands" rule from concept C1): durable state lives in the Goal,
// so each Worker boots clean, does one bounded step, and is thrown away before
// its context can rot. One impossible 10,000-step context becomes 10,000 fresh
// short ones.
//
// In O1 the verdict (`moved` / `goalMet`) is derived from the Worker's turn by
// `evaluate`. This is an explicit placeholder: O3 replaces it with a reality
// probe (the WorldModel), which is the only honest source of "is it actually
// done." The Dispatcher contract does not change when that lands.

import { randomUUID } from "node:crypto";
import { runForkedTurn, type EngineTool, type Provider, type ToolPermissionRequest } from "@ares/core";
import type { DispatchContext, Dispatcher, Goal, StepVerdict, VerificationSpec } from "./types.js";

/** Mirrors protocol's PermissionPromptDecision without coupling operator to it. */
type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface QueryEngineDispatcherOptions {
  provider: Provider;
  model: string;
  workspace: string;
  /** Scoped toolset for the Worker. Empty in O1 (the spine proves out first). */
  tools?: readonly EngineTool[];
  systemPrompt?: string;
  maxTurns?: number;
  /** O1 placeholder verdict derivation; O3 replaces with a reality probe. */
  evaluate?: (turnText: string, goal: Goal) => StepVerdict;
  /**
   * Permission gate for the Worker's tool calls. The operator loop runs
   * UNATTENDED, so the handler it supplies hard-denies anything that would need a
   * human (payments, credentials, sending mail, destructive shell) — nobody is
   * there to approve. Omitted ⇒ ask-tools throw, the legacy behavior.
   */
  requestPermission?: (request: ToolPermissionRequest) => Promise<PermissionDecision>;
}

export class QueryEngineDispatcher implements Dispatcher {
  constructor(private readonly opts: QueryEngineDispatcherOptions) {}

  async runStep(goal: Goal, ctx: DispatchContext): Promise<StepVerdict> {
    // Mortal hands, one loop: each step is a fresh fork of the SAME QueryEngine
    // (fresh read-stamp isolation + a work-item seed, guaranteed by runForkedTurn)
    // rather than a hand-rolled engine faking a user turn.
    const result = await runForkedTurn({
      config: {
        provider: this.opts.provider,
        model: this.opts.model,
        systemPrompt: this.opts.systemPrompt ?? DEFAULT_WORKER_PROMPT,
        tools: this.opts.tools ?? [],
        workspace: this.opts.workspace,
        signal: ctx.signal,
        maxTurns: this.opts.maxTurns ?? 8,
        requestPermission: this.opts.requestPermission,
      },
      sessionId: `wrk_${randomUUID().slice(0, 8)}`,
      seed: { kind: "work-item", text: buildStepPrompt(goal) },
    });

    // A failed/interrupted fork still returns whatever partial text it streamed.
    // Short-circuit BEFORE evaluate: otherwise defaultEvaluate sees moved=text>0
    // and a crashed fork masquerades as PROGRESS (resetting the no-progress
    // streak forever, and possibly self-certifying goalMet off partial prose).
    // 'failed' | 'interrupted' are forkedTurn's terminal-failure TurnEndStatus.
    if (result.status === "failed" || result.status === "interrupted") {
      return {
        moved: false,
        goalMet: false,
        evidence: `worker fork ${result.status}: ${result.streamedText.trim().slice(0, 200) || "(no output)"}`,
      };
    }

    return (this.opts.evaluate ?? defaultEvaluate)(result.streamedText, goal);
  }
}

const DEFAULT_WORKER_PROMPT = `You are a Ares Operator Worker. You are handed ONE goal and the progress so far.
Do the single most useful next concrete step toward the goal — no more. Then state plainly what you did and whether the goal is now fully met. Be honest: only claim the goal is met when it truly is.`;

function buildStepPrompt(goal: Goal): string {
  const moved = goal.stepLog.filter((s) => s.moved).length;
  const lines = [`Goal: ${goal.statement}`, `Steps so far: ${goal.stepLog.length} (${moved} moved the gap).`];

  // Hand the worker the actual step history — without this, day 3's worker has
  // no idea what days 1-2 did beyond a number, and repeats or contradicts them.
  const recent = goal.stepLog.slice(-6);
  if (recent.length) {
    lines.push("", "What prior steps did (most recent last):");
    for (const s of recent) {
      const tag = s.goalMet ? "✓done" : s.moved ? "→moved" : "·no-op";
      lines.push(`- [${tag}] ${s.evidence?.replace(/\s+/g, " ").slice(0, 200) ?? "(no evidence recorded)"}`);
    }
  }

  // Give the worker the acceptance criteria so "done" means reality, not say-so.
  if (goal.verification) lines.push("", `Success is measured by: ${describeVerification(goal.verification)}`);
  if (goal.noProgressStreak > 0) {
    lines.push("", `Note: ${goal.noProgressStreak} recent step(s) made NO progress — try a different approach than before.`);
  }

  lines.push(
    "",
    "Take the single next concrete step toward this goal, then report what you did and whether the goal is now fully met.",
  );
  return lines.join("\n");
}

function describeVerification(v: VerificationSpec): string {
  switch (v.kind) {
    case "always":
      return v.summary ?? (v.met ? "marked met" : "manual judgement");
    case "file":
      return `file ${v.path}${v.contains ? ` contains "${v.contains}"` : " exists"}`;
    case "command":
      return `command \`${[v.cmd, ...(v.args ?? [])].join(" ")}\`${v.contains ? ` outputs "${v.contains}"` : ` exits ${v.expectExit ?? 0}`}`;
    case "http":
      return `GET ${v.url} returns ${v.expectStatus ?? 200}${v.contains ? ` containing "${v.contains}"` : ""}`;
  }
}

/**
 * O1 placeholder: a non-empty turn counts as progress; an explicit "met"
 * signal counts as completion. Deliberately naive — replaced by O3's reality
 * probe. Real convergence must never rest on the model's say-so.
 *
 * A `goalMet` derived from a REGEX over the Worker's prose has no world
 * corroboration behind it, so we always tag it `unverified`. The control loop
 * then demands a reality probe (the goal's VerificationSpec, or the WorldModel
 * for a spec-less goal) before it lets a step certify the goal done — and where
 * no probe can corroborate, the completion is recorded as real-but-unverified
 * rather than trusted blindly. This keeps the bare regex from self-certifying.
 */
export function defaultEvaluate(turnText: string, _goal: Goal): StepVerdict {
  const text = turnText.trim();
  const moved = text.length > 0;
  const goalMet = /\bgoal\s+(?:is\s+)?(?:now\s+)?(?:fully\s+)?met\b/i.test(text);
  return { moved, goalMet, unverified: goalMet || undefined, evidence: text.slice(0, 200) || undefined };
}
