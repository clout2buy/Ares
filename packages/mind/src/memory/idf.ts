// Corpus salience for recall + clustering (Ares v6 / M1).
//
// Inverse-document-frequency weighting so recall keys on rare, meaningful tokens
// instead of common filler — a cue word seen in 1 of 50 memories outweighs one
// seen in 40 of 50. Pure, zero-dependency, no I/O: fits @ares/mind's leaf rule.

import type { MemoryNode } from "./types.js";

const STOP = new Set([
  "the", "and", "for", "are", "was", "you", "your", "with", "about", "this",
  "that", "from", "into", "has", "have", "will", "can", "but", "not", "all",
]);

/** Lowercased, stop-filtered alphanumeric tokens of length > 2. */
export function tokenizeSalient(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}

export interface IdfMap {
  idf: Map<string, number>;
  docs: number;
}

export function buildIdf(nodes: readonly MemoryNode[]): IdfMap {
  const df = new Map<string, number>();
  for (const n of nodes) {
    for (const t of new Set(tokenizeSalient(n.content))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const docs = nodes.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((docs + 1) / (d + 1)) + 1);
  return { idf, docs };
}

/** Unknown tokens are treated as maximally salient (as if seen in zero docs). */
export function idfWeight(map: IdfMap, token: string): number {
  return map.idf.get(token) ?? Math.log(map.docs + 1) + 1;
}

/** Set-overlap affinity used to weight association edges during spreading. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
