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

/** The lifecycle vocabulary the daemon surfaces for the background loop. */
export type OperatorBackgroundEvent =
  | { type: "operator_started"; everyMs: number }
  | { type: "operator_tick"; reason: OperatorWakeReason; goalId: string; status: Goal["status"]; summary: string }
  | { type: "operator_idle"; reason: OperatorWakeReason; summary: string; suggestions: string[] }
  | { type: "operator_error"; message: string }
  | { type: "operator_stopped" };

export interface OperatorBackgroundLoopOptions {
  everyMs?: number;
  emit?: (event: OperatorBackgroundEvent) => void;
  onError?: (err: unknown) => void;
  /**
   * Mission-aware idle: when there's no active goal to advance, the loop surfaces
   * these as SUGGESTIONS (logged, never auto-executed) — e.g. the active project
   * packet's nextActions. Keeps idle ticks aware of the war map without turning
   * into a 3 AM chaos goblin.
   */
  nextActions?: () => readonly string[] | Promise<readonly string[]>;
}

/**
 * Opt-IN gate for the background loop. It runs ONLY when ARES_OPERATOR_LOOP=1,
 * and an emergency kill (ARES_OPERATOR_AUTOTICK=0) always wins. Default: OFF —
 * autonomy is deliberate, never a surprise.
 */
export function operatorLoopEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ARES_OPERATOR_AUTOTICK === "0") return false;
  return env.ARES_OPERATOR_LOOP === "1";
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 240);
}

/**
 * Always-on driver for the Operator.
 *
 * Scheduler wakes are event-first and interval-second; this loop adds the
 * missing attention decision before it spends a worker tick. One wake advances
 * exactly one ATTENTION-SELECTED goal (never naive active[0]), which keeps
 * background autonomy responsive without stealing the foreground turn. A failing
 * goal tick is isolated — it surfaces operator_error and the loop keeps running.
 */
export class OperatorBackgroundLoop {
  private controller = new AbortController();
  private readonly scheduler: Scheduler;
  private readonly everyMs: number;
  private ticking = false;

  constructor(
    private readonly ctx: ControlLoopContext,
    private readonly opts: OperatorBackgroundLoopOptions = {},
  ) {
    this.everyMs = opts.everyMs ?? 60_000;
    this.scheduler = new Scheduler({
      everyMs: this.everyMs,
      onTick: async (reason) => {
        await this.tickOnce(reason);
      },
      onError: (err) => {
        this.emit({ type: "operator_error", message: errMessage(err) });
        this.opts.onError?.(err);
      },
    });
  }

  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.scheduler.start();
    this.emit({ type: "operator_started", everyMs: this.everyMs });
  }

  stop(): void {
    this.scheduler.stop();
    this.controller.abort();
    this.emit({ type: "operator_stopped" });
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
    // Backpressure: one tick at a time. A second wake while a tick is in flight
    // is dropped (the Scheduler also guards interval/event overlap).
    if (this.ticking) return { reason, decision: decideAttention([]), ran: [] };
    this.ticking = true;
    try {
      const goals = await activeGoals(this.ctx.home);
      const decision = decideAttention(attentionItemsFromGoals(goals));

      const selectedGoalId = decision.selected?.id.startsWith("goal:")
        ? decision.selected.id.slice("goal:".length)
        : undefined;
      const goal = selectedGoalId ? goals.find((g) => g.id === selectedGoalId) : undefined;

      if (!goal) {
        // Nothing urgent to advance — stay mission-aware: surface (don't run) the
        // next strategic moves, so idle time still knows the war map.
        const suggestions = (await this.resolveNextActions()).slice(0, 5);
        this.emit({ type: "operator_idle", reason, summary: decision.summary, suggestions });
        return { reason, decision, ran: [] };
      }

      try {
        const next = await tickGoal({ ...this.ctx, signal: this.ctx.signal ?? this.controller.signal }, goal);
        this.emit({ type: "operator_tick", reason, goalId: next.id, status: next.status, summary: decision.summary });
        return { reason, decision, ran: [next] };
      } catch (err) {
        // A failed worker tick never kills the loop — record it and move on.
        this.emit({ type: "operator_error", message: errMessage(err) });
        return { reason, decision, ran: [] };
      }
    } finally {
      this.ticking = false;
    }
  }

  private async resolveNextActions(): Promise<readonly string[]> {
    if (!this.opts.nextActions) return [];
    try {
      return (await this.opts.nextActions()) ?? [];
    } catch {
      return [];
    }
  }

  private emit(event: OperatorBackgroundEvent): void {
    try {
      this.opts.emit?.(event);
    } catch {
      // a bad emitter never breaks the loop
    }
  }
}
