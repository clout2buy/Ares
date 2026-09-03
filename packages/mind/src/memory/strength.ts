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

/** Weight of the recency term in {@link livenessScore}. ARES_MEMORY_RECENCY_WEIGHT. */
export function recencyWeight(): number {
  const raw = Number(process.env.ARES_MEMORY_RECENCY_WEIGHT);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.5;
}

/**
 * Ranking score for "what you know" style surfaces: decayed strength PLUS a
 * recency bonus for the last activation. Raw `strength` never decays, so a
 * node reinforced fifty times in March out-ranked everything learned since
 * and stuck to the prompt forever; currentStrength() alone still lets a huge
 * stored magnitude outlive weeks of silence. The additive recency term
 * (0..weight, halving with HALF_LIFE_MS) is what lets a fresh node win.
 */
export function livenessScore(node: MemoryNode, now: Date, weight = recencyWeight()): number {
  const ref = Date.parse(node.lastActivatedAt || node.at);
  const elapsed = Math.max(0, now.getTime() - (Number.isNaN(ref) ? now.getTime() : ref));
  const recency = Math.pow(0.5, elapsed / HALF_LIFE_MS);
  return currentStrength(node, now) + weight * recency;
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

/**
 * An outcome went AGAINST this memory: debit its strength (floored, never
 * negative) and reset the clock so the loss is felt now. The deliberate
 * asymmetry with reinforce(): losses do not bump activations — being wrong
 * is not "use".
 */
export function weaken(node: MemoryNode, now: Date, factor = 0.6): MemoryNode {
  // Multiplicative, not additive: a loss must out-debit the additive bump a
  // recall gives (+0.5), or a popular-but-wrong memory could stay strong by
  // being recalled often — exactly the failure mode V6 exists to kill. With
  // x0.6-0.05, three recall+loss cycles land a node ~30% below where it
  // started; a single loss is felt but never catastrophic.
  return {
    ...node,
    strength: Math.max(0.05, node.strength * factor - 0.05),
    lastActivatedAt: now.toISOString(),
  };
}
