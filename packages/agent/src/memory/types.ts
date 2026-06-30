export type MemoryCategory = "SELF" | "USER" | "PROJECT" | "DECISION" | "FEEDBACK";

export interface MemoryEntry {
  id: number;
  category: MemoryCategory;
  workspace: string | null;
  content: string;
  source: "manual" | "light-dreaming" | "deep-dreaming" | "rem-dreaming" | "capture-hook" | "import";
  score: number;
  hits: number;
  contradicts: number;
  embeddingModel: string;
  embeddingDim: number;
  embedding: number[];
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  promotedToSoul: boolean;
}

export interface AddMemoryInput {
  category: MemoryCategory;
  workspace?: string | null;
  content: string;
  source?: MemoryEntry["source"];
  score?: number;
  embedding?: number[];
  embeddingModel?: string;
  embeddingDim?: number;
}

export interface RecallInput {
  query: string;
  embedding?: number[];
  workspace?: string | null;
  category?: MemoryCategory;
  limit?: number;
}

export interface RecallResult {
  memory: MemoryEntry;
  distance: number;
}

export interface MemoryStoreStatus {
  backend: "sqlite" | "json";
  vectorEnabled: boolean;
  path: string;
  warning?: string;
}

// ── v4 → v6 bridge ───────────────────────────────────────────────────────────
//
// The canonical memory schema is @ares/mind's `MemoryNode` (the live substrate
// the turn recalls from). This v4 `MemoryEntry` is the legacy vector-store row —
// retained only behind the migration + read-only legacy adapter. Until the full
// unification (rewrite the v4 store onto MemoryNode) lands, this adapter is the
// ONE place that maps a v4 row into the shape @ares/mind's `store.add()` accepts,
// so every v4→v6 fold goes through a single, typed translation rather than ad-hoc
// field-picking. Category is demoted to a tag (MemoryNode has no category axis);
// score becomes strength. Embeddings are intentionally dropped — v6 re-embeds in
// its own vector space (see migrateVectorStore.ts).

/** A v6 `store.add()` input distilled from a v4 `MemoryEntry`. Shape matches
 *  @ares/mind's AddInput without importing it here (keeps the type seam thin). */
export interface CanonicalMemoryInput {
  kind: "semantic" | "episodic" | "procedural";
  content: string;
  tags: string[];
  source?: string;
  strength: number;
}

/** Map a legacy v4 entry to the canonical v6 add-input. The single typed bridge
 *  between the two schemas; full unification (retire MemoryEntry) is follow-up. */
export function memoryEntryToCanonical(entry: MemoryEntry): CanonicalMemoryInput {
  const tags = [`v4-category:${entry.category.toLowerCase()}`];
  if (entry.workspace) tags.push(`workspace:${entry.workspace}`);
  return {
    kind: "semantic",
    content: entry.content,
    tags,
    source: entry.source,
    strength: Number.isFinite(entry.score) ? Math.min(3, Math.max(0.5, entry.score)) : 1,
  };
}

