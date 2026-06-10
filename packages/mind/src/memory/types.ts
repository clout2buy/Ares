// Living Memory types (Ares v6 / M1).
//
// One substrate, three kinds of memory (like a brain):
//   episodic   — what happened (sessions, missions, decisions, frames)
//   semantic   — what I know (facts, and how they connect)
//   procedural — what I can do (links to the v5 skill graph)
//
// Every node carries a STRENGTH that grows with use and fades when ignored, and
// LINKS to associated nodes — so recall can spread along associations and
// consolidation can forget the trivial and crystallize the recurring.

export type MemoryKind = "episodic" | "semantic" | "procedural";

/**
 * Current on-disk schema version for a {@link MemoryNode}. Bump this whenever the
 * node shape changes in a way that needs a migration. The store backfills any
 * record missing `v` to version 1 (the pre-versioned shape) and quarantines —
 * never deletes — records written by a *newer* version it doesn't understand.
 */
// v2 (additive, forward+backward safe): added optional `confidence` and
// `derivedFrom` for synthesized belief/insight nodes the deep dream crystallizes.
// Older binaries quarantine v2 nodes (never destroy them); same-version round-trip
// is unaffected because the new fields are optional.
export const MEMORY_SCHEMA_VERSION = 2;

export interface MemoryNode {
  /** Schema version this record was written with. See {@link MEMORY_SCHEMA_VERSION}. */
  v: number;
  id: string;
  kind: MemoryKind;
  content: string;
  /** When the memory was formed. */
  at: string;
  /** Stored salience magnitude (grows on reinforce). Decays from lastActivatedAt. */
  strength: number;
  activations: number;
  lastActivatedAt: string;
  /** Associated node ids — the association graph (Hebbian: fire together, wire together). */
  links: string[];
  tags?: string[];
  /** Origin: a session/mission/skill id, etc. */
  source?: string;
  /** Confidence (0..1) for a synthesized belief/insight. Absent on raw episodes. */
  confidence?: number;
  /** Provenance: member node ids a synthesis was distilled from. */
  derivedFrom?: string[];
}
