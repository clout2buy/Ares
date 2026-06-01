// Living Memory types (Crix v6 / M1).
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

export interface MemoryNode {
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
}
