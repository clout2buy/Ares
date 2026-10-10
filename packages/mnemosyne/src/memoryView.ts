// Read-only selection over the living memory, for the owner-facing "what do
// you remember about me" surface (the phone's Memory screen). Pure: nodes in,
// a page out. It never reinforces, links or persists — looking at memory must
// not change it (the same doctrine as MemoryStore.overview / peek).
//
// Scope is the owner's pool by default: unscoped nodes plus "owner". A guest
// tenant's nodes (guest:<chatId>) never appear unless that scope is asked for
// by name, so a shared screen cannot leak a stranger's memories — or the
// owner's to one.

import { OWNER_SCOPE, nodesInScope, type MemoryKind, type MemoryNode } from "@ares/mind";

export interface MemoryQuery {
  scope?: string;
  kinds?: readonly MemoryKind[];
  /** Words that must ALL appear (case-insensitive) in the text, tags or source. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryPage {
  nodes: MemoryNode[];
  /** Matches before paging. */
  total: number;
  /** Every node in the scope by kind, before any filter: the honest size of memory. */
  counts: Record<MemoryKind, number>;
}

export const MEMORY_PAGE_DEFAULT = 50;
export const MEMORY_PAGE_MAX = 200;

export function selectMemories(all: readonly MemoryNode[], q: MemoryQuery = {}): MemoryPage {
  const pool = nodesInScope(all, q.scope ?? OWNER_SCOPE);
  const counts: Record<MemoryKind, number> = { semantic: 0, procedural: 0, episodic: 0 };
  for (const node of pool) if (node.kind in counts) counts[node.kind] += 1;
  const kinds = q.kinds && q.kinds.length > 0 ? new Set<MemoryKind>(q.kinds) : undefined;
  const words = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const matches = pool.filter((node) => {
    if (kinds && !kinds.has(node.kind)) return false;
    if (words.length === 0) return true;
    const hay = `${node.content}\n${(node.tags ?? []).join(" ")}\n${node.source ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  // Newest first; a correction the owner made counts as fresh.
  const stamp = (n: MemoryNode): string => (n.editedAt && n.editedAt > n.at ? n.editedAt : n.at);
  const ordered = [...matches].sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.id.localeCompare(b.id));
  const limit = Math.min(Math.max(Math.floor(q.limit ?? MEMORY_PAGE_DEFAULT), 1), MEMORY_PAGE_MAX);
  const offset = Math.max(Math.floor(q.offset ?? 0), 0);
  return { nodes: ordered.slice(offset, offset + limit), total: ordered.length, counts };
}
