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
// v3 (additive): the Crucible — optional `status` (hypothesis lifecycle),
// `check` (a falsifiable probe spec the trial can run), and `evidence`
// (win/loss outcome records). A node with no status is an ordinary memory.
export const MEMORY_SCHEMA_VERSION = 3;

/** Hypothesis lifecycle. Absent status = ordinary memory outside the Crucible. */
export type HypothesisStatus = "candidate" | "confirmed" | "archived";

/** A falsifiable check the Crucible trial can run deterministically. */
export interface CrucibleCheck {
  type: "command" | "file_exists";
  /** For "command": a read-only shell command whose success/expect decides the trial. */
  cmd?: string;
  /** For "file_exists": path (workspace-relative or absolute). */
  path?: string;
  /** Optional substring the command output must contain. */
  expect?: string;
}

/** One outcome record: was this memory in play when reality moved (or didn't)? */
export interface EvidenceEntry {
  at: string;
  won: boolean;
  note: string;
  /** Probe fingerprint when the outcome came from a reality probe. */
  fingerprint?: string;
}

/**
 * The ONE shape every reflection surface conforms to. Ares has many reflection
 * passes — self-model reflect(), after-action reflectOnRun(), conversation
 * mergeDurableFacts(), the store's consolidate()/synthesize(), the revise signal —
 * that historically each had a bespoke return shape and ad-hoc substrate, with no
 * way to drive them uniformly. A ReflectionSurface takes an input bundle and
 * returns the directives it produced and where (if anywhere) it persisted, so a
 * caller can run any surface and report on it identically.
 *
 * Behavior is unchanged: this is a uniform *envelope* over the existing passes,
 * not a new policy. `directives` are human-readable lines (a fix to make, a fact
 * learned, a theme promoted); `persistedTo` names the substrate written (e.g.
 * "memory.jsonl", "after-action", or undefined when the surface only advises).
 */
export interface ReflectionResult {
  /** Human-readable directives/observations this pass produced. */
  directives: string[];
  /** Substrate the pass wrote to, or undefined when it only advises (writes nothing). */
  persistedTo?: string;
}

export interface ReflectionSurface<I = unknown> {
  /** A stable name for the surface (for logging / dispatch). */
  readonly name: string;
  run(inputs: I): Promise<ReflectionResult> | ReflectionResult;
}

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
  /** Owning tenant for multi-user isolation (e.g. per-Telegram-user). Absent =
   *  the owner. Additive + optional, so no schema-version bump: older binaries
   *  ignore it, newer ones default it to the owner. Recall/write filtering is
   *  wired in Phase 2 (memory unification); inert until then. */
  scope?: string;
  /** Confidence (0..1) for a synthesized belief/insight. Absent on raw episodes. */
  confidence?: number;
  /** Provenance: member node ids a synthesis was distilled from. */
  derivedFrom?: string[];
  /** Crucible lifecycle. Absent = ordinary memory. */
  status?: HypothesisStatus;
  /** Falsifiable check for the trial (V7). */
  check?: CrucibleCheck;
  /** Outcome win/loss records (V6 consequence wiring). Capped, newest last. */
  evidence?: EvidenceEntry[];
}
