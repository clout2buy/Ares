// Conversation reflection — the "learn from talking, not just from commits" loop.
//
// reflectAfterTurn already distills CODING runs (commits → war-map). But most of
// what matters about the owner surfaces in plain conversation: preferences,
// personal facts, standing decisions, relationships. This module distills those
// durable facts from a chat transcript and writes them to Living Memory ONCE,
// deduped — so Ares remembers "Crix welds 12-hour shifts" without ever re-reading
// the transcript. Token-smart by construction: the digest is distilled to a few
// short facts, recalled compactly later, never the raw history.
//
// The distillation itself is an LLM call (the daemon supplies it via sideQueryJson);
// everything here is pure + testable: build the digest, dedup, write.

import { jaccard, tokenizeSalient } from "./idf.js";

export type DurableFactKind = "preference" | "fact" | "decision" | "relationship" | "skill";

export interface DurableFact {
  /** A single, self-contained, durably-true statement. */
  content: string;
  kind: DurableFactKind;
  /** 0..1 — how worth-remembering this is. Below the floor we drop it. */
  importance: number;
}

/** The system prompt for the distiller. Kept stable so the side-call shares the
 *  parent's cached prefix economics. */
export const CONVERSATION_REFLECT_SYSTEM =
  "You are Ares's memory distiller. From a conversation, extract ONLY durable facts " +
  "worth remembering for months: the owner's stable preferences, personal facts, " +
  "standing decisions, relationships, and hard-won knowledge. " +
  "IGNORE the ephemeral — greetings, one-off questions, transient task state, anything " +
  "already obvious. Each fact must be a single self-contained sentence that stays true " +
  "out of context (write the owner's name/subject explicitly, never 'he'/'it'). " +
  "Return an empty array if nothing is durable. Be ruthless: 0-5 facts, never filler.";

export const DURABLE_FACTS_SCHEMA_HINT =
  '[{"content": "<one durable sentence>", "kind": "preference|fact|decision|relationship|skill", "importance": 0.0-1.0}]';

/** Collapse session-replay/tool noise into a compact role-tagged transcript the
 *  distiller can read, newest-last, bounded by char budget. */
export function buildConversationDigest(
  turns: ReadonlyArray<{ role: string; text: string }>,
  maxChars = 6000,
): string {
  const lines: string[] = [];
  for (const t of turns) {
    const text = (t.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const who = t.role === "assistant" ? "Ares" : "Owner";
    lines.push(`${who}: ${text}`);
  }
  // Keep the most RECENT content when over budget (the tail carries the latest
  // facts; old turns were already reflected on their own pass).
  let digest = lines.join("\n");
  if (digest.length > maxChars) digest = digest.slice(digest.length - maxChars);
  return digest;
}

/** Normalize for dedup: lowercase, strip punctuation, collapse whitespace. */
function normalizeFact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** True when `fact` says substantially the same thing as something already stored
 *  (salient-token Jaccard over the threshold). Cheap, no embeddings. */
function isDuplicate(factContent: string, existing: readonly string[], threshold = 0.55): boolean {
  const a = tokenizeSalient(normalizeFact(factContent));
  if (a.length === 0) return true; // nothing salient → not worth storing
  const aSet = new Set(a);
  for (const prior of existing) {
    const b = new Set(tokenizeSalient(normalizeFact(prior)));
    if (b.size === 0) continue;
    if (jaccard(aSet, b) >= threshold) return true;
  }
  return false;
}

/** Minimal structural shape of MemoryStore that we need (keeps mind decoupled). */
export interface ReflectStoreLike {
  all(): ReadonlyArray<{ content: string }>;
  add(input: { kind: "semantic"; content: string; tags?: string[]; source?: string; strength?: number }): Promise<unknown>;
}

export interface MergeFactsResult {
  added: number;
  skipped: number;
  addedFacts: string[];
}

/** Write distilled facts to Living Memory, skipping near-duplicates and anything
 *  below the importance floor. Idempotent across runs: a fact already remembered
 *  (or paraphrased) is not re-added. */
export async function mergeDurableFacts(
  store: ReflectStoreLike,
  facts: ReadonlyArray<DurableFact>,
  opts: { minImportance?: number } = {},
): Promise<MergeFactsResult> {
  const minImportance = opts.minImportance ?? 0.4;
  const existing = store.all().map((n) => n.content);
  const accepted = [...existing];
  const result: MergeFactsResult = { added: 0, skipped: 0, addedFacts: [] };

  for (const fact of facts) {
    const content = (fact.content ?? "").trim();
    if (!content || content.length < 6) { result.skipped++; continue; }
    if ((fact.importance ?? 0) < minImportance) { result.skipped++; continue; }
    if (isDuplicate(content, accepted)) { result.skipped++; continue; }
    await store.add({
      kind: "semantic",
      content,
      tags: ["reflected", "conversation", fact.kind],
      source: "conversation-reflection",
      strength: Math.max(1, Math.round((fact.importance ?? 0.5) * 3)),
    });
    accepted.push(content); // a later fact in the same batch dedups against this one
    result.added++;
    result.addedFacts.push(content);
  }
  return result;
}
