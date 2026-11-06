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

import { MemoryRouter, type RouterStoreLike } from "./router.js";
import { curatedTypeOf, isRawQuote } from "./curated.js";
import type { ReflectionResult, ReflectionSurface } from "./types.js";

/** The four curated types (user / feedback / project / reference) — what
 *  MEMORY.md is made of — plus the distiller's older labels, still accepted
 *  and mapped by curatedTypeOf. */
export type DurableFactKind = "user" | "feedback" | "project" | "reference" | "preference" | "fact" | "decision" | "relationship" | "skill";

export interface DurableFact {
  /** A single, self-contained, durably-true statement. */
  content: string;
  kind: DurableFactKind;
  /** 0..1 — how worth-remembering this is. Below the floor we drop it. */
  importance: number;
  /** Why it matters: the owner's reason, or the mistake it prevents. */
  why?: string;
}

/** The system prompt for the distiller. Kept stable so the side-call shares the
 *  parent's cached prefix economics. */
export const CONVERSATION_REFLECT_SYSTEM =
  "You are Ares's memory distiller. From a conversation, extract ONLY durable facts " +
  "worth remembering for months, each typed: user (who the owner is, their preferences, " +
  "people, machines), feedback (a standing rule or correction about how to work), project " +
  "(a decision or state of ongoing work), reference (where something lives, how to reach it). " +
  "IGNORE the ephemeral — greetings, one-off questions, transient task state, what was built or " +
  "fixed today, which file was edited, which tool ran, anything already obvious. A fact is only " +
  "durable if the owner would still want it known in a new conversation next month. " +
  "Each fact must be a single self-contained sentence that stays true " +
  "out of context (write the owner's name/subject explicitly, never 'he'/'it'), in your own " +
  "words — NEVER a quote of what the owner typed. Give a short why for each. " +
  "Return an empty array if nothing is durable. Be ruthless: 0-5 facts, never filler.";

export const DURABLE_FACTS_SCHEMA_HINT =
  '[{"content": "<one durable sentence>", "kind": "user|feedback|project|reference", "why": "<why it matters>", "importance": 0.0-1.0}]';

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

/** One semantic-fact add input — what mergeDurableFacts hands the store. */
type DurableAddInput = { kind: "semantic"; content: string; tags?: string[]; source?: string; strength?: number };

/** Minimal structural shape of MemoryStore that we need (keeps mind decoupled). */
export interface ReflectStoreLike {
  all(): ReadonlyArray<{ content: string }>;
  add(input: DurableAddInput): Promise<unknown>;
  /** Optional batch add — when present, all accepted facts flush in ONE persist()
   *  instead of one full-file rewrite per fact (O(N²) → O(N)). */
  addMany?(inputs: readonly DurableAddInput[]): Promise<unknown>;
}

export interface MergeFactsResult {
  added: number;
  skipped: number;
  addedFacts: string[];
}

/** Write distilled facts to Living Memory, skipping near-duplicates and anything
 *  below the importance floor. Idempotent across runs: a fact already remembered
 *  (or paraphrased) is not re-added. Dedupe + salience gating live in the ONE
 *  write spine (MemoryRouter "conversation" channel); this pass only shapes the
 *  facts into typed writes. */
export async function mergeDurableFacts(
  store: ReflectStoreLike,
  facts: ReadonlyArray<DurableFact>,
  opts: { minImportance?: number } = {},
): Promise<MergeFactsResult> {
  const router = new MemoryRouter(store as RouterStoreLike);
  // A quote of the owner is a log line, not a fact (MEMORY.md field report,
  // 2026-11-02) — refused here even when a weak model returns one.
  const typed = facts.filter((fact) => !isRawQuote(fact.content ?? ""));
  const report = await router.write(
    "conversation",
    typed.map((fact) => ({
      kind: "semantic" as const,
      content: (fact.content ?? "").trim(),
      tags: [
        "reflected",
        "conversation",
        fact.kind,
        `type:${curatedTypeOf(fact.kind)}`,
        ...(typeof fact.why === "string" && fact.why.trim() ? [`why:${fact.why.replace(/\s+/g, " ").trim().slice(0, 240)}`] : []),
      ],
      source: "conversation-reflection",
      strength: Math.max(1, Math.round((fact.importance ?? 0.5) * 3)),
      salience: fact.importance ?? 0,
    })),
    opts.minImportance === undefined ? {} : { policy: { minSalience: opts.minImportance } },
  );
  return {
    added: report.written.length,
    skipped: report.skipped.length + (facts.length - typed.length),
    addedFacts: report.written.map((w) => w.input.content),
  };
}

/** This pass as a {@link ReflectionSurface}: same mergeDurableFacts(), uniform envelope. */
export const conversationReflectionSurface: ReflectionSurface<{
  store: ReflectStoreLike;
  facts: ReadonlyArray<DurableFact>;
  minImportance?: number;
}> = {
  name: "conversation-reflection",
  async run({ store, facts, minImportance }): Promise<ReflectionResult> {
    const merged = await mergeDurableFacts(store, facts, minImportance === undefined ? {} : { minImportance });
    return {
      directives: merged.addedFacts,
      ...(merged.added > 0 ? { persistedTo: "memory.jsonl" } : {}),
    };
  },
};
