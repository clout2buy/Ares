// Spreading-activation recall (Crix v6 / M1) — the part no shipped agent does.
//
// A cue doesn't fetch one chunk. It lights up the most relevant, strongest
// memories (the seeds), then ACTIVATION SPREADS along association links to pull
// in connected memories — even ones the cue never matched. You get back a
// constellation of related context, the way one memory reminds you of another.
//
// Relevance is dependency-light token overlap (embeddings can plug in later);
// the scoring weights relevance by each memory's current strength, so vivid,
// recently-used memories surface first.

import { currentStrength } from "./strength.js";
import type { MemoryNode } from "./types.js";

export interface RecallResult {
  node: MemoryNode;
  score: number;
  /** True if it surfaced by association, not by matching the cue directly. */
  viaAssociation?: boolean;
}

export interface RecallOptions {
  limit?: number;
  /** Follow association links from the seeds (default true). */
  spread?: boolean;
  now?: Date;
}

// Common words carry no associative signal — drop them so recall keys on
// meaningful tokens, not "the"/"about"/"is".
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "you", "your", "with", "about", "this", "that",
  "tell", "what", "how", "where", "when", "who", "does", "did", "from", "into", "out",
  "its", "his", "her", "they", "them", "has", "have", "had", "will", "would", "can",
  "could", "should", "than", "then", "there", "here", "some", "any", "all", "not",
  "but", "our", "their", "been", "were", "via", "let", "get", "got",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function relevance(cue: string, content: string): number {
  const cueTokens = tokenize(cue);
  if (cueTokens.length === 0) return 0;
  const have = new Set(tokenize(content));
  let hits = 0;
  for (const t of cueTokens) if (have.has(t)) hits++;
  return hits / cueTokens.length;
}

export function recall(cue: string, nodes: readonly MemoryNode[], opts: RecallOptions = {}): RecallResult[] {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 8;

  // Seeds: directly relevant memories, weighted by how vivid they are right now.
  const seeds = nodes
    .map((node) => ({ node, score: relevance(cue, node.content) * (0.2 + currentStrength(node, now)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (opts.spread === false) return seeds;

  // Spreading activation: follow links out of the seeds.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chosen = new Map<string, RecallResult>(seeds.map((s) => [s.node.id, s]));
  for (const seed of seeds) {
    for (const linkId of seed.node.links) {
      if (chosen.has(linkId)) continue;
      const linked = byId.get(linkId);
      if (!linked) continue;
      chosen.set(linkId, {
        node: linked,
        score: seed.score * 0.4 * (0.2 + currentStrength(linked, now)),
        viaAssociation: true,
      });
    }
  }

  return [...chosen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
