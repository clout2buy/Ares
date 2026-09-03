// Process-wide "is any turn running?" signal for background reflection.
//
// The periodic consolidation tick must never rewrite memory.jsonl underneath
// a live turn (recall reinforces + persists mid-turn; a concurrent consolidate
// would clobber that write). The daemon hosts many sessions in one process,
// so this is a counter, not a flag — a turn is active while ANY session has
// one in flight. Marked from AresAgentRuntime.beforeTurn/afterTurn; a runtime
// that was never enabled still marks, so the gate holds even without an agent.

let active = 0;

export function markTurnStarted(): void {
  active++;
}

export function markTurnEnded(): void {
  active = Math.max(0, active - 1);
}

export function isAnyTurnActive(): boolean {
  return active > 0;
}

/** Test seam: reset the counter between cases. */
export function resetTurnActivity(): void {
  active = 0;
}
