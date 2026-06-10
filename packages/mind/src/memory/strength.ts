// Salience + forgetting — what makes memory alive (Ares v6 / M1).
//
// A memory's effective strength decays over time since it was last used, and
// jumps back up when it's used again. So important/recurring memories stay
// sharp and one-off noise quietly fades — no infinite junk drawer. This is the
// human property no filing-cabinet vector store has.

import type { MemoryNode } from "./types.js";

/** Time for an un-reinforced memory's effective strength to halve. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // one week

/** Effective strength right now: stored magnitude decayed since last activation. */
export function currentStrength(node: MemoryNode, now: Date): number {
  const ref = Date.parse(node.lastActivatedAt || node.at);
  const elapsed = Math.max(0, now.getTime() - (Number.isNaN(ref) ? now.getTime() : ref));
  const decay = Math.pow(0.5, elapsed / HALF_LIFE_MS);
  return node.strength * decay;
}

/** Using a memory strengthens it and resets its forgetting clock. */
export function reinforce(node: MemoryNode, now: Date, amount = 0.5): MemoryNode {
  return {
    ...node,
    strength: node.strength + amount,
    activations: node.activations + 1,
    lastActivatedAt: now.toISOString(),
  };
}
