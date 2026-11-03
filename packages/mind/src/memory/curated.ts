// Curated long-term memory (MEMORY.md) as TYPED FACTS, never raw quotes.
//
// Field evidence, 2026-11-02: the owner's MEMORY.md held 45 entries and every
// one was a verbatim chat line — "[USER#41] User asked: just login lol i dont
// remember my login" — the same line up to six times under different ids.
// Nothing was distilled, so nothing read as knowledge: the agent saw a pile of
// old requests, not "Noah's box is doingbox at .237". Light dreaming staged
// whatever the owner typed; deep dreaming promoted it verbatim; the v4 store
// gave every repeat a fresh id, so the same line came back again and again.
//
// The rules this module enforces, in one place:
//   - a curated entry is a short fact with a TYPE (user / feedback / project /
//     reference) and, when known, a WHY — written by a model, never a quote;
//   - a "User asked: ..." line is a log entry, not memory (isRawQuote);
//   - the same fact twice is ONE record: a deterministic normalized signature
//     (factSignature) decides, and the newer phrasing wins the merge.
//
// Pure, no I/O: dreaming renders with it, `ares mind tidy` migrates with it.

export type CuratedType = "user" | "feedback" | "project" | "reference";

export const CURATED_TYPES: readonly CuratedType[] = ["user", "feedback", "project", "reference"];

export interface CuratedFact {
  type: CuratedType;
  content: string;
  /** Why this is worth knowing (the owner's reason, or what it prevents). */
  why?: string;
  /** Owner said "remember this": never capped away. */
  pinned?: boolean;
}

/**
 * Map any kind label the writers have used onto the four curated types:
 * the distiller's old kinds (preference/fact/relationship/decision/skill),
 * the v4 categories (USER/SELF/PROJECT/DECISION/FEEDBACK), or a type itself.
 */
export function curatedTypeOf(kind: string | undefined): CuratedType {
  switch ((kind ?? "").trim().toLowerCase()) {
    case "user":
    case "preference":
    case "fact":
    case "relationship":
      return "user";
    case "feedback":
    case "self":
    case "rule":
    case "correction":
      return "feedback";
    case "reference":
    case "skill":
      return "reference";
    default:
      return "project";
  }
}

/**
 * A chat line, not a fact: "User asked: ...", "Owner said: ...". These were
 * light dreaming's whole output and the bulk of the field MEMORY.md. They
 * belong in the daily log (memory/YYYY-MM-DD.md), where history lives.
 */
export function isRawQuote(content: string): boolean {
  return /^\s*(?:the\s+)?(?:user|owner)\s+(?:asked|said|wrote|requested|told me)\s*:/i.test(content);
}

const SIGNATURE_STOP = new Set([
  "the", "and", "for", "are", "was", "you", "your", "with", "about", "this", "that", "from", "into",
  "has", "have", "had", "will", "can", "but", "not", "all", "its", "it's", "they", "them", "their",
  "there", "then", "than", "just", "also", "very", "really", "some", "any", "our", "who", "what",
  "when", "where", "which", "should", "would", "could", "does", "did", "been", "being", "were",
]);

/**
 * The dedupe key: lowercase, punctuation stripped, a trailing "..." elision
 * dropped, stopwords and 1-2 letter words removed, the remaining tokens
 * de-duplicated and SORTED. Deterministic — the same fact reworded with a
 * different word order, case or punctuation maps to the same key; a fact with
 * a different salient word does not. An all-stopword line keys on its whole
 * normalized text so it still dedupes against itself.
 */
export function factSignature(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(/(?:\.\.\.|…)\s*$/, "")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = [...new Set(normalized.split(" ").filter((t) => t.length > 2 && !SIGNATURE_STOP.has(t)))].sort();
  return tokens.length > 0 ? tokens.join(" ") : normalized;
}

export interface MergeCuratedResult {
  facts: CuratedFact[];
  /** Entries folded into an earlier record with the same signature. */
  merged: number;
  /** Raw quotes refused (they are log lines, not memory). */
  quotes: string[];
}

/**
 * Fold a list of facts (oldest first) into one record per signature. A later
 * duplicate UPDATES the record — its phrasing, type and why win (newest
 * knowledge), it keeps the record's place, and pinned is sticky. Raw quotes
 * and empty lines never become records.
 */
export function mergeCuratedFacts(facts: readonly CuratedFact[]): MergeCuratedResult {
  const bySignature = new Map<string, CuratedFact>();
  const quotes: string[] = [];
  let merged = 0;
  for (const fact of facts) {
    const content = fact.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    if (isRawQuote(content)) {
      quotes.push(content);
      continue;
    }
    const why = fact.why?.replace(/\s+/g, " ").trim();
    const signature = factSignature(content);
    const prior = bySignature.get(signature);
    if (prior) {
      merged++;
      bySignature.set(signature, {
        type: fact.type,
        content,
        ...(why || prior.why ? { why: why || prior.why } : {}),
        ...(prior.pinned || fact.pinned ? { pinned: true } : {}),
      });
      continue;
    }
    bySignature.set(signature, { type: fact.type, content, ...(why ? { why } : {}), ...(fact.pinned ? { pinned: true } : {}) });
  }
  return { facts: [...bySignature.values()], merged, quotes };
}

export const CURATED_MEMORY_HEADER = ["# Memory", "", "_(Curated long-term memory: typed facts, one per line. Only DEEP dreaming writes here.)_", ""];

/** One rendered line: `- [type] fact — why: reason`. */
export function renderCuratedLine(fact: CuratedFact, maxChars = 420): string {
  const body = fact.why ? `${fact.content} — why: ${fact.why}` : fact.content;
  const clipped = body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 3))}...` : body;
  return `- [${fact.type}${fact.pinned ? ", pinned" : ""}] ${clipped}`;
}

/** Render MEMORY.md. Pinned facts always; the rest newest-last up to `max`. */
export function renderCuratedMemory(facts: readonly CuratedFact[], opts: { max?: number; itemChars?: number } = {}): string {
  const max = opts.max ?? 120;
  const pinned = facts.filter((f) => f.pinned);
  const rest = facts.filter((f) => !f.pinned);
  const room = Math.max(0, max - pinned.length);
  const kept = [...pinned, ...(room > 0 ? rest.slice(-room) : [])];
  return [...CURATED_MEMORY_HEADER, ...kept.map((f) => renderCuratedLine(f, opts.itemChars))].join("\n") + "\n";
}

/**
 * Read MEMORY.md entries back, whatever generation wrote them:
 *   `- [USER#31] text`            (v4 deep dream / pinOwnerMemory)
 *   `- [user] text — why: reason` (this module)
 *   `- [user, pinned] text`
 *   `- text`                      (hand-written)
 * Non-bullet lines (headers, notes) are not entries.
 */
export function parseCuratedMemory(text: string): CuratedFact[] {
  const out: CuratedFact[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    let rest = line.slice(2).trim();
    let label: string | undefined;
    let pinned = false;
    const tag = /^\[([^\]]*)\]\s*/.exec(rest);
    if (tag) {
      const parts = tag[1].split(",").map((p) => p.trim().toLowerCase());
      label = parts[0]?.replace(/#.*$/, "");
      pinned = parts.includes("pinned");
      rest = rest.slice(tag[0].length);
    }
    const whyAt = rest.indexOf(" — why: ");
    const content = (whyAt >= 0 ? rest.slice(0, whyAt) : rest).trim();
    const why = whyAt >= 0 ? rest.slice(whyAt + " — why: ".length).trim() : undefined;
    if (!content) continue;
    out.push({ type: curatedTypeOf(label), content, ...(why ? { why } : {}), ...(pinned ? { pinned: true } : {}) });
  }
  return out;
}

export interface TidyReport {
  /** The rewritten MEMORY.md. */
  text: string;
  /** Facts kept (after dedupe). */
  kept: number;
  /** Duplicate entries folded away. */
  deduped: number;
  /** Raw "User asked:" entries moved out, de-duplicated, oldest first. */
  quotes: string[];
  /** False when the file was already tidy. */
  changed: boolean;
}

/**
 * The one-shot migration for a MEMORY.md written before typed facts: identical
 * lines collapse to one, raw quotes move out (the caller appends `quotes` to
 * the daily log), every surviving entry is re-rendered as `- [type] fact`.
 * Nothing is capped — tidying never drops a fact.
 */
export function tidyCuratedMemory(text: string): TidyReport {
  const entries = parseCuratedMemory(text);
  const result = mergeCuratedFacts(entries);
  const quotes = [...new Set(result.quotes)];
  const next = renderCuratedMemory(result.facts, { max: Number.MAX_SAFE_INTEGER, itemChars: Number.MAX_SAFE_INTEGER });
  return {
    text: next,
    kept: result.facts.length,
    deduped: result.merged + (result.quotes.length - quotes.length),
    quotes,
    changed: next.trim() !== text.trim(),
  };
}
