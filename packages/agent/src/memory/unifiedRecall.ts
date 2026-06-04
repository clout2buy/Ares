// The one canonical recall interface (Crix Phase 2C — "Live Brain Wiring").
//
// Crix has two memory substrates:
//   • v6 "living memory" (@crix/mind MemoryStore) — episodic/semantic/procedural,
//     strength-weighted, self-associating. This is the SOURCE OF TRUTH.
//   • v4 vector store (sqlite/embeddings, this package) — legacy, still fed by
//     the offline dreaming pipeline.
//
// Before this, a live turn recalled from BOTH independently and queued two
// separate "recalled from memory" reminders from stores that never shared a
// thing. unifiedRecallForTurn collapses that into ONE read: v6 is primary, v4 is
// a read-only legacy adapter, results are merged + deduped by content, and a
// single reminder block comes back.
//
// Non-destructive by construction: v6 reinforces what it surfaces (its normal
// behavior) and v4 only bumps recall hit-counts — exactly as each did before.
// Neither store is migrated or rewritten here.

import { MemoryStore as LivingMemoryStore, type RecalledMemory } from "@crix/mind";
import type { CrixAgentConfig } from "../config.js";
import { recallForTurn } from "../recall.js";

export type UnifiedRecallOrigin = "living" | "vector";

export interface UnifiedRecallItem {
  content: string;
  origin: UnifiedRecallOrigin;
  /** v6 only: surfaced by spreading activation from an associated memory. */
  viaAssociation?: boolean;
}

export interface UnifiedRecallResult {
  items: UnifiedRecallItem[];
  /** Single ready-to-inject reminder block ("" when nothing surfaced). */
  reminder: string;
  /** How many items each substrate contributed (post-dedup). */
  sources: { living: number; vector: number };
  /**
   * The v6 living-memory constellation, in the minimal shape cognition needs.
   * Handed to advisory cognition so it reasons over what was ALREADY recalled —
   * never re-querying the store (preserves the single recall path).
   */
  living: RecalledMemory[];
}

/** Legacy v4 vector-store recall — optional, so v6 works standalone. */
export interface VectorRecallConfig {
  config: CrixAgentConfig;
  home?: string;
  useOllama?: boolean;
}

/** Minimal shape the unified interface needs from a living-memory store. */
export interface LivingRecaller {
  remember(
    cue: string,
    opts?: { limit?: number },
  ): Promise<Array<{ node: { content: string }; viaAssociation?: boolean }>>;
  /** Read-only recall (no reinforce/persist). Used when `reinforce: false`. */
  peek?(
    cue: string,
    opts?: { limit?: number },
  ): Array<{ node: { content: string }; viaAssociation?: boolean }> | Promise<Array<{ node: { content: string }; viaAssociation?: boolean }>>;
}

export interface UnifiedRecallOptions {
  query: string;
  workspace: string;
  /** Path to the v6 living-memory file (the source of truth). */
  livingMemoryFile?: string;
  /** Legacy v4 vector store; omit to recall from living memory only. */
  vector?: VectorRecallConfig;
  /** Max items in the merged result. */
  limit?: number;
  /** Per-item / total character budgets for the reminder block. */
  itemChars?: number;
  blockChars?: number;
  /** When false, recall is skipped entirely (e.g. a bare "hi"). */
  shouldRecall?: boolean;
  /**
   * Whether surfacing memories should reinforce them (recall's normal "use makes
   * it stick" behavior). Default true for live turns. Set false for read-only
   * inspection (status recaps) so looking never mutates memory strength.
   */
  reinforce?: boolean;
  // ── Seams for tests (avoid touching the real filesystem / sqlite) ───────────
  openLiving?: (file?: string) => Promise<LivingRecaller>;
  recallVector?: typeof recallForTurn;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_ITEM_CHARS = 420;
const DEFAULT_BLOCK_CHARS = 2_400;

const EMPTY: UnifiedRecallResult = { items: [], reminder: "", sources: { living: 0, vector: 0 }, living: [] };

export async function unifiedRecallForTurn(opts: UnifiedRecallOptions): Promise<UnifiedRecallResult> {
  if (opts.shouldRecall === false) return EMPTY;
  const query = opts.query.trim();
  if (!query) return EMPTY;

  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const items: UnifiedRecallItem[] = [];
  const living: RecalledMemory[] = [];
  const seen = new Set<string>();

  // 1. v6 living memory — primary, source of truth.
  if (opts.livingMemoryFile || opts.openLiving) {
    try {
      const open = opts.openLiving ?? ((file?: string) => LivingMemoryStore.open(file));
      const store = await open(opts.livingMemoryFile);
      // Read-only when reinforce === false and the store supports peek(); else
      // remember() (which reinforces — the normal live-turn behavior).
      const entries =
        opts.reinforce === false && store.peek
          ? await store.peek(query, { limit })
          : await store.remember(query, { limit });
      for (const r of entries) {
        const key = normalize(r.node.content);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({ content: r.node.content, origin: "living", viaAssociation: r.viaAssociation });
        living.push({ node: { content: r.node.content }, viaAssociation: r.viaAssociation });
      }
    } catch {
      // never break a turn over memory
    }
  }

  // 2. v4 vector store — legacy adapter, read-only top-up for what v6 lacks.
  if (opts.vector) {
    try {
      const recall = opts.recallVector ?? recallForTurn;
      const res = await recall({
        home: opts.vector.home,
        workspace: opts.workspace,
        query,
        config: opts.vector.config,
        useOllama: opts.vector.useOllama,
      });
      for (const r of res.results) {
        const key = normalize(r.memory.content);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push({ content: r.memory.content, origin: "vector" });
      }
    } catch {
      // never break a turn over memory
    }
  }

  const merged = items.slice(0, limit);
  return {
    items: merged,
    reminder: formatReminder(merged, opts.itemChars ?? DEFAULT_ITEM_CHARS, opts.blockChars ?? DEFAULT_BLOCK_CHARS),
    sources: { living: countOrigin(merged, "living"), vector: countOrigin(merged, "vector") },
    living,
  };
}

function countOrigin(items: readonly UnifiedRecallItem[], origin: UnifiedRecallOrigin): number {
  return items.reduce((n, it) => (it.origin === origin ? n + 1 : n), 0);
}

function formatReminder(items: readonly UnifiedRecallItem[], itemChars: number, blockChars: number): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const prefix = `- ${it.viaAssociation ? "<- " : ""}`;
    const remaining = blockChars - used - prefix.length;
    if (remaining <= 80) break;
    const line = `${prefix}${compact(it.content, Math.min(itemChars, remaining))}`;
    used += line.length + 1;
    lines.push(line);
  }
  if (lines.length === 0) return "";
  return `Recalled from your memory for this message — weave in what's relevant, don't recite it:\n${lines.join("\n")}`;
}

function normalize(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function compact(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
