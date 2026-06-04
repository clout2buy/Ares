// Auto-emit Mission Learning Cards on completion (Crix v6 / Phase B follow-up).
//
// Phase B v1 distilled lessons on demand (`crix mission learn`). This wires the
// reflex: when a mission contract reaches a TERMINAL state (satisfied/abandoned),
// the lesson is distilled, saved, and fed into living memory automatically — so
// every real mission teaches Crix without anyone asking.
//
// It does NOT change the distiller, add LLM prose, or touch the control logic.
// It is best-effort (never throws, never blocks the loop) and idempotent: the
// card id is derived from the contract id (re-completion overwrites, never
// duplicates), and the memory feed dedups by source.

import { recordCardMemoryOnce } from "@crix/agent";
import { MemoryStore, mindPaths } from "@crix/mind";
import { distillMissionCard, learningCardMemoryText, saveLearningCard, type LearningCard } from "./learningCard.js";
import type { MissionContract } from "./missionContract.js";
import { loadGoal } from "./store.js";

/** Terminal = the mission is done teaching: succeeded or was given up on. */
export function isContractTerminal(contract: MissionContract): boolean {
  return contract.progress.status === "satisfied" || contract.progress.status === "abandoned";
}

export interface AutoEmitOptions {
  now?: Date;
  /** Living-memory file. Defaults to mindPaths(home).memoryFile. */
  memoryFile?: string;
  /** Skip the memory feed (the card is still written). Default: feed. */
  feedMemory?: boolean;
}

/**
 * If the contract is terminal, distill + persist its Learning Card and feed it
 * into memory once. Returns the card, or null if non-terminal / on any error.
 * Safe to call on every save: a no-op (no I/O) for non-terminal contracts.
 */
export async function autoEmitLearningCard(
  home: string,
  contract: MissionContract,
  opts: AutoEmitOptions = {},
): Promise<LearningCard | null> {
  if (!isContractTerminal(contract)) return null;
  try {
    const goal = contract.goalId ? (await loadGoal(home, contract.goalId)) ?? undefined : undefined;
    const card = distillMissionCard(contract, { goal, now: opts.now });
    await saveLearningCard(home, card);
    if (opts.feedMemory !== false) {
      const store = await MemoryStore.open(opts.memoryFile ?? mindPaths(home).memoryFile);
      await recordCardMemoryOnce(store, { id: card.id, summary: learningCardMemoryText(card), tags: card.tags });
    }
    return card;
  } catch {
    // A lesson is a bonus, never a blocker — completion must succeed regardless.
    return null;
  }
}
