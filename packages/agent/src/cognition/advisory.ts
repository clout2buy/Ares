// Advisory cognition for the live turn (Crix v6 / M2, Phase 2C step 3).
//
// After the single unified recall runs, Crix takes a beat to *think* about the
// request WITH what it just recalled — and offers itself a suggestion. The key
// word is advisory: this whispers in the model's ear, it never grabs the
// keyboard. The deliberation:
//   • reuses the already-recalled constellation (no second store query),
//   • never writes a "Decided to…" memory (commitDecision stays false),
//   • is gated so trivial turns ("hi") never pay for it,
//   • returns a clearly-labeled, non-binding reminder — never a tool call.
//
// The reasoner (`propose`) is intentionally a cheap, memory-grounded heuristic
// for now: it prioritizes the strongest recalled memory and flags any past
// failure. It is pluggable, so an LLM-backed reasoner can replace it later
// without touching this wiring. We deliberately avoid an LLM round-trip here —
// that would be an always-on cost on every substantive turn.

import { consider, type Intention, type ReasonOption, type RecalledMemory, type Thought } from "@crix/mind";

export interface AdvisoryResult {
  /** The non-binding suggestion, or null when nothing useful surfaced. */
  intention: Intention | null;
  /** Ready-to-inject advisory reminder block ("" when there's nothing to say). */
  reminder: string;
  /** The inner-monologue beats (for streaming / the UI). */
  thoughts: Thought[];
}

export interface DeliberateOptions {
  /** The user's request — the situation to think about. */
  situation: string;
  /** The constellation the unified recall already surfaced (v6 living memory). */
  recalled: RecalledMemory[];
  /**
   * Gate: false on trivial turns (greetings, acks) so `propose()` never runs.
   * The live turn passes the intent classifier's verdict here.
   */
  shouldDeliberate: boolean;
  /** Override the reasoner (tests inject a spy / fake). Defaults to the heuristic. */
  propose?: (situation: string, recalled: RecalledMemory[]) => Promise<ReasonOption[]> | ReasonOption[];
  /**
   * Optional flag-gated LLM micro-pass. When provided it BECOMES the reasoner
   * (takes precedence over `propose`); on any empty/failed result it degrades to
   * the memory-grounded heuristic, so it can never hollow out a useful turn.
   */
  reason?: (situation: string, recalled: RecalledMemory[]) => Promise<ReasonOption[]>;
  /** Receives each thought as it forms — wire to a lifecycle/UI stream. */
  emit?: (thought: Thought) => void;
  now?: () => Date;
}

const FAILURE_SIGNAL = /\b(fail|failed|failing|broke|broken|error|errored|blocked|regress|regression|crash|crashed|bug)\b/i;

const EMPTY: AdvisoryResult = { intention: null, reminder: "", thoughts: [] };

export async function deliberateForTurn(opts: DeliberateOptions): Promise<AdvisoryResult> {
  // Gate FIRST — trivial turns and turns with nothing recalled never reason.
  if (!opts.shouldDeliberate) return EMPTY;
  if (opts.recalled.length === 0) return EMPTY;

  // The LLM reasoner wins when present, but always degrades to the heuristic so
  // the deliberation can never come back empty on a turn that recalled memory.
  // When `reason` is undefined this is byte-identical to the previous behavior.
  const propose = opts.reason
    ? async (s: string, r: RecalledMemory[]) => {
        const out = await opts.reason!(s, r);
        return out.length > 0 ? out : memoryGroundedPropose(s, r);
      }
    : (opts.propose ?? memoryGroundedPropose);

  const deliberation = await consider(opts.situation, {
    recalled: opts.recalled, // reuse the unified recall — no second store query
    commitDecision: false, // advisory: never write a decision the model may not act on
    propose,
    emit: opts.emit,
    now: opts.now,
  });

  return {
    intention: deliberation.intention,
    reminder: deliberation.intention ? advisoryReminder(deliberation.intention) : "",
    thoughts: deliberation.thoughts,
  };
}

/**
 * A cheap reasoner that thinks with memory alone: lean on the most salient
 * recalled memory, and surface a caution if any related memory records a past
 * failure. No model call — this is the always-safe default.
 */
export function memoryGroundedPropose(_situation: string, recalled: RecalledMemory[]): ReasonOption[] {
  if (recalled.length === 0) return [];
  const top = recalled[0]; // recall is already strength-ranked by the living store
  const failures = recalled.filter((r) => FAILURE_SIGNAL.test(r.node.content));
  const score = Math.min(0.9, 0.45 + recalled.length * 0.1);
  return [
    {
      action: `Lean on what you already know: ${compact(top.node.content, 200)}`,
      pro: `${recalled.length} related memory${recalled.length === 1 ? "" : "ies"} bear on this; this is the most salient`,
      con: failures.length
        ? `${failures.length} related memory${failures.length === 1 ? "" : "ies"} note a past failure — check it doesn't apply here`
        : undefined,
      score,
    },
  ];
}

function advisoryReminder(intention: Intention): string {
  const pct = Math.round(intention.confidence * 100);
  return [
    "Your own advisory read on this — a suggestion drawn from your memory. Weigh it; you are NOT obligated to follow it, and it is NOT a command. Do not auto-run anything because of it.",
    `→ ${intention.goal}`,
    `Why: ${intention.rationale} (confidence ${pct}%)`,
  ].join("\n");
}

function compact(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
