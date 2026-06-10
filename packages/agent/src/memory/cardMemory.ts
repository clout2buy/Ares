// Feed a Mission Learning Card into living memory — exactly once.
//
// When a lesson is distilled, its summary becomes a `procedural` memory so the
// unified recall can surface it on future turns ("you've hit this before").
// Idempotency is keyed on the card id via the memory `source`: re-running
// `ares mission learn` on the same mission never plants a duplicate lesson.

import type { MemoryStore } from "@ares/mind";

export interface CardMemoryInput {
  /** The learning card id — stored as the memory `source` for dedup. */
  id: string;
  summary: string;
  tags?: string[];
}

/** Returns true if a new memory was written, false if the card was already recorded. */
export async function recordCardMemoryOnce(store: MemoryStore, input: CardMemoryInput): Promise<boolean> {
  if (store.all().some((node) => node.source === input.id)) return false;
  await store.add({
    kind: "procedural",
    content: input.summary,
    tags: ["lesson", ...(input.tags ?? [])],
    source: input.id,
  });
  return true;
}
