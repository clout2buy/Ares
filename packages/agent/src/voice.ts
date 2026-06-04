// Gain calculation helpers — turn raw evolution events into accurate +N
// score deltas. The TUI renders these as weirdcore +N TARGET cards.

import type { EvolutionGain } from "./lifecycle/bus.js";

/**
 * Count the number of new bullet points / list items in an appended text
 * block. Falls back to 1 if no list markers found (still a meaningful
 * append). Used by SelfEvolve to compute accurate deltas.
 */
export function countAppendedItems(text: string): number {
  const bullets = text.split(/\r?\n/).filter((line) => /^\s*[-*+]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line));
  if (bullets.length > 0) return bullets.length;
  // No bullets — count non-empty content blocks as "1 thought".
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
  return Math.max(1, blocks.length);
}

export function gainForTarget(target: string, delta: number, kind?: string): EvolutionGain {
  return { target: target.toUpperCase(), delta, kind };
}
