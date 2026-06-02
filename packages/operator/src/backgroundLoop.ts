import { decideAttention, attentionItemsFromGoals, type AttentionDecision } from "./attention.js";
import { tickGoal, type ControlLoopContext } from "./controlLoop.js";
import { Scheduler } from "./scheduler.js";
import { activeGoals } from "./store.js";
import type { Goal } from "./types.js";

export type OperatorWakeReason = "manual" | "interval" | "event";

export interface OperatorBackgroundTick {
  reason: OperatorWakeReason;
  decision: AttentionDecision;
  ran: Goal[];
}

export type OperatorBackgroundEvent =
  | { type: "attention_selected"; reason: OperatorWakeReason; summary: string; selectedId?: string }
  | { type: "background_goal_tick"; goalId: string; status: Goal["status"] };

export interface OperatorBackgroundLoopOptions {
  everyMs?: number;
  emit?: (event: OperatorBackgroundEvent) => void;
  onError?: (err: unknown) => void;
}

/**
 * Always-on driver for the Operator.
 *
 * Scheduler wakes are event-first and interval-second; this loop adds the
 * missing attention decision before it spends a worker tick. One wake advances
 * exactly one selected goal, which keeps background autonomy responsive without
 * stealing the foreground turn.
 */
export class OperatorBackgroundLoop {
  private controller = new AbortController();
  private readonly scheduler: Scheduler;

  constructor(
    private readonly ctx: ControlLoopContext,
    private readonly opts: OperatorBackgroundLoopOptions = {},
  ) {
    this.scheduler = new Scheduler({
      everyMs: opts.everyMs ?? 60_000,
      onTick: async (reason) => {
        await this.tickOnce(reason);
      },
      onError: opts.onError,
    });
  }

  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
    this.controller.abort();
  }

  get started(): boolean {
    return this.scheduler.started;
  }

  enqueueEvent(event: unknown): void {
    this.scheduler.enqueueEvent(event);
  }

  pendingEvents(): number {
    return this.scheduler.pendingEvents();
  }

  async tickOnce(reason: OperatorWakeReason = "manual"): Promise<OperatorBackgroundTick> {
    const goals = await activeGoals(this.ctx.home);
    const decision = decideAttention(attentionItemsFromGoals(goals));
    this.opts.emit?.({
      type: "attention_selected",
      reason,
      summary: decision.summary,
      selectedId: decision.selected?.id,
    });

    const selectedGoalId = decision.selected?.id.startsWith("goal:")
      ? decision.selected.id.slice("goal:".length)
      : undefined;
    const goal = selectedGoalId ? goals.find((g) => g.id === selectedGoalId) : undefined;
    if (!goal) return { reason, decision, ran: [] };

    const next = await tickGoal(
      {
        ...this.ctx,
        signal: this.ctx.signal ?? this.controller.signal,
      },
      goal,
    );
    this.opts.emit?.({ type: "background_goal_tick", goalId: next.id, status: next.status });
    return { reason, decision, ran: [next] };
  }
}
