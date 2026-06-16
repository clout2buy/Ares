// The context compiler — the difference between "long memory" and "token
// landfill."
//
// Embeddings + a vector store are a search bar with better vibes; they are not a
// memory system. A memory system DECIDES, under a hard token budget, which few
// fragments actually reach the model this turn — and in what priority order when
// the budget is tight. This module is that decision, made PURE so it's testable:
//
//   fragments (tiered) + active project + token budget  ->  compact packet
//
// Tiers, highest priority first under pressure:
//   working    — current goal/task/blockers (what are we doing RIGHT NOW)
//   procedural — how the user likes things done (changes behavior → keep it)
//   project    — durable per-project state packet (only when that project is active)
//   semantic   — relevant recalled knowledge (the embedding/lexical hits)
//   recent     — rolling conversation summary (first to be cut)
//
// The compiler never exceeds the budget, drops cross-project fragments that don't
// match the active project (an unrelated task must not drag a repo's history into
// context), and renders only what survives — cited, compact, sectioned.

export type MemoryTier = "working" | "procedural" | "project" | "semantic" | "recent";

export interface MemoryFragment {
  tier: MemoryTier;
  content: string;
  /** Importance/relevance within its tier (0..1). Higher ranks first. Default 0.5. */
  score?: number;
  /** Provenance pointer kept for citation/traceability (e.g. a memory id, commit). */
  source?: string;
  /** When set, the fragment is eligible ONLY if it matches the active project. */
  project?: string;
}

export interface ContextRequest {
  /** The user's current message — drives the budget for trivial prompts. */
  userMessage: string;
  /** Active project key (e.g. "Ares"). Project-tagged fragments for other projects are dropped. */
  activeProject?: string;
  /** Hard total token ceiling for the whole packet. */
  tokenBudget: number;
  /** Optional per-tier token ceilings layered under the total. */
  tierBudgets?: Partial<Record<MemoryTier, number>>;
  fragments: readonly MemoryFragment[];
  /** Token estimator override (tests / a real tokenizer). */
  estimateTokens?: (text: string) => number;
}

export interface CompiledFragment extends MemoryFragment {
  tokens: number;
}

export interface ContextPacket {
  /** The rendered memory block, ready to inject (""= nothing fit / nothing eligible). */
  text: string;
  /** Total estimated tokens of `text`'s fragments — always <= tokenBudget. */
  tokens: number;
  included: CompiledFragment[];
  dropped: CompiledFragment[];
  byTier: Record<MemoryTier, number>;
}

const TIER_ORDER: readonly MemoryTier[] = ["working", "procedural", "project", "semantic", "recent"];
const TIER_RANK: Record<MemoryTier, number> = { working: 0, procedural: 1, project: 2, semantic: 3, recent: 4 };
const TIER_LABEL: Record<MemoryTier, string> = {
  working: "Working memory (now)",
  procedural: "How the user likes things done",
  project: "Project state",
  semantic: "Relevant knowledge",
  recent: "Recent context",
};

/** ~4 chars per token — matches the engine's own budgeting heuristic. */
export function estimateTokensDefault(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

/**
 * A trivial message (a greeting, or anything very short) earns a SMALL memory
 * budget — don't staple the autobiography to "hi". Returns a budget in
 * [floor, max]. This is the "tiny prompt gets tiny memory" rule.
 */
export function budgetForMessage(message: string, max: number, floor = 0): number {
  const trimmed = message.trim();
  if (trimmed.length === 0) return floor;
  const trivial = /^(hi|hey+|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|lol|lmao|bet|word)\b/i.test(trimmed) || trimmed.length < 24;
  if (trivial) return Math.min(max, Math.max(floor, Math.round(max * 0.25)));
  return max;
}

/**
 * Compile the memory packet for one turn under a hard token budget. PURE.
 */
export function compileContext(req: ContextRequest): ContextPacket {
  const estimate = req.estimateTokens ?? estimateTokensDefault;
  const budget = Math.max(0, Math.floor(req.tokenBudget));

  // Eligibility: a project-tagged fragment only survives when its project is the
  // active one. (Ask about dinner → the Ares repo history stays out of context.)
  // Ineligible fragments are recorded as dropped — nothing vanishes silently.
  const eligible: MemoryFragment[] = [];
  const ineligible: MemoryFragment[] = [];
  for (const f of req.fragments) {
    if (!f.project || f.project === req.activeProject) eligible.push(f);
    else ineligible.push(f);
  }

  // Rank: tier priority first, then score desc, stable by original order.
  const ranked = eligible
    .map((f, i) => ({ f, i, tokens: Math.max(0, estimate(f.content)) }))
    .sort((a, b) => {
      const t = TIER_RANK[a.f.tier] - TIER_RANK[b.f.tier];
      if (t !== 0) return t;
      const s = (b.f.score ?? 0.5) - (a.f.score ?? 0.5);
      if (s !== 0) return s;
      return a.i - b.i;
    });

  // Greedy pack under the total budget (+ optional per-tier ceilings). A
  // too-large high-priority fragment is dropped and we keep going — the budget
  // is never exceeded, and smaller lower-priority fragments can still fit.
  const included: CompiledFragment[] = [];
  const dropped: CompiledFragment[] = [];
  const byTier: Record<MemoryTier, number> = { working: 0, procedural: 0, project: 0, semantic: 0, recent: 0 };
  let used = 0;
  for (const { f, tokens } of ranked) {
    const tierCap = req.tierBudgets?.[f.tier];
    const fitsTotal = used + tokens <= budget;
    const fitsTier = tierCap === undefined || byTier[f.tier] + tokens <= tierCap;
    if (tokens > 0 && fitsTotal && fitsTier) {
      included.push({ ...f, tokens });
      used += tokens;
      byTier[f.tier] += tokens;
    } else {
      dropped.push({ ...f, tokens });
    }
  }
  // Wrong-project fragments are dropped too — visible, never silently merged in.
  for (const f of ineligible) dropped.push({ ...f, tokens: Math.max(0, estimate(f.content)) });

  return { text: render(included), tokens: used, included, dropped, byTier };
}

function render(included: readonly CompiledFragment[]): string {
  if (included.length === 0) return "";
  const sections: string[] = [];
  for (const tier of TIER_ORDER) {
    const items = included.filter((f) => f.tier === tier);
    if (items.length === 0) continue;
    const lines = items.map((f) => `- ${f.content}${f.source ? ` [${f.source}]` : ""}`).join("\n");
    sections.push(`## ${TIER_LABEL[tier]}\n${lines}`);
  }
  return sections.join("\n\n");
}
