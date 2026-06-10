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
import { QueryEngine, type EngineTool, type Provider } from "@ares/core";
import type { DispatchContext, Dispatcher, Goal, StepVerdict } from "./types.js";

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
}

export class QueryEngineDispatcher implements Dispatcher {
  constructor(private readonly opts: QueryEngineDispatcherOptions) {}

  async runStep(goal: Goal, ctx: DispatchContext): Promise<StepVerdict> {
    const engine = new QueryEngine(
      {
        provider: this.opts.provider,
        model: this.opts.model,
        systemPrompt: this.opts.systemPrompt ?? DEFAULT_WORKER_PROMPT,
        tools: this.opts.tools ?? [],
        workspace: this.opts.workspace,
        signal: ctx.signal,
        maxTurns: this.opts.maxTurns ?? 8,
      },
      `wrk_${randomUUID().slice(0, 8)}`,
    );
    engine.appendUserMessage(buildStepPrompt(goal));

    let text = "";
    for await (const event of engine.streamTurn()) {
      if (event.type === "text_delta") text += event.text;
    }

    return (this.opts.evaluate ?? defaultEvaluate)(text, goal);
  }
}

const DEFAULT_WORKER_PROMPT = `You are a Ares Operator Worker. You are handed ONE goal and the progress so far.
Do the single most useful next concrete step toward the goal — no more. Then state plainly what you did and whether the goal is now fully met. Be honest: only claim the goal is met when it truly is.`;

function buildStepPrompt(goal: Goal): string {
  const moved = goal.stepLog.filter((s) => s.moved).length;
  return [
    `Goal: ${goal.statement}`,
    `Steps that have moved the gap so far: ${moved}.`,
    `Take the single next concrete step toward this goal, then report what you did and whether the goal is now fully met.`,
  ].join("\n");
}

/**
 * O1 placeholder: a non-empty turn counts as progress; an explicit "met"
 * signal counts as completion. Deliberately naive — replaced by O3's reality
 * probe. Real convergence must never rest on the model's say-so.
 */
export function defaultEvaluate(turnText: string, _goal: Goal): StepVerdict {
  const text = turnText.trim();
  const moved = text.length > 0;
  const goalMet = /\bgoal\s+(?:is\s+)?(?:now\s+)?(?:fully\s+)?met\b/i.test(text);
  return { moved, goalMet, evidence: text.slice(0, 200) || undefined };
}
