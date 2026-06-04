// The thought process (Crix v6 / M2).
//
// Above the Operator's mechanical control loop sits a real deliberation:
//   OBSERVE → RECALL (think WITH memory) → weigh options → DECIDE → INTEND →
//   remember the decision.
// The *content* of the options comes from a reasoner (production: an LLM; tests:
// a fake) — but the STRUCTURE is the cognition: it always consults memory first,
// narrates its reasoning, commits a choice, and writes the decision back to
// memory so the next deliberation is wiser. Plus drives: it notices gaps in
// itself and *wants* to close them.

import type { MemoryStore } from "../memory/store.js";
import type { Deliberation, Intention, RecalledMemory, Thought, ThoughtKind } from "./types.js";

export interface ReasonOption {
  action: string;
  pro: string;
  con?: string;
  score: number; // 0..1, higher = better
}

export interface ConsiderDeps {
  /** Living Memory — cognition thinks with it. */
  memory?: MemoryStore;
  /**
   * Pre-recalled constellation (e.g. from the unified recall). When provided,
   * cognition REUSES it and does NOT call `memory.remember()` — preserving the
   * single recall path the live turn already ran.
   */
  recalled?: RecalledMemory[];
  /** Propose candidate actions given the situation + what memory recalled. */
  propose: (situation: string, recalled: RecalledMemory[]) => Promise<ReasonOption[]> | ReasonOption[];
  /**
   * Persist the chosen decision back to memory. Default false: advisory
   * deliberation must NOT write "Decided to…" memories for choices the model
   * may never act on. Only an act-on-it path should set this true.
   */
  commitDecision?: boolean;
  now?: () => Date;
  emit?: (thought: Thought) => void;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export async function consider(situation: string, deps: ConsiderDeps): Promise<Deliberation> {
  const now = deps.now ?? (() => new Date());
  const compactSituation = compactForMemory(situation, 800);
  const thoughts: Thought[] = [];
  const think = (kind: ThoughtKind, text: string): void => {
    const thought: Thought = { kind, text: compactForMemory(text, 1_000), at: now().toISOString() };
    thoughts.push(thought);
    deps.emit?.(thought);
  };

  think("observe", `Considering: ${compactSituation}`);

  // RECALL — think with memory first (the M1 × M2 integration). Prefer a
  // constellation handed in by the caller (the unified recall) so cognition
  // never re-queries the store; fall back to its own remember() only when no
  // recall was provided.
  let recalled: RecalledMemory[] = deps.recalled ?? [];
  if (deps.memory && deps.recalled === undefined) {
    recalled = await deps.memory.remember(compactSituation, { now: now() });
  }
  if (deps.recalled !== undefined || deps.memory) {
    if (recalled.length > 0) {
      think("recall", `This reminds me of: ${recalled.slice(0, 3).map((r) => compactForMemory(r.node.content, 240)).join("; ")}`);
    } else {
      think("recall", "Nothing in memory bears on this yet.");
    }
  }

  // DELIBERATE — weigh the options.
  const options = await deps.propose(situation, recalled);
  if (options.length === 0) {
    think("doubt", "I don't see a good way to do this yet — I should research it or ask.");
    return { thoughts, intention: null };
  }
  for (const option of options) {
    think("idea", `Option: ${option.action} — ${option.pro}${option.con ? ` (but ${option.con})` : ""}`);
  }
  if (options.length > 1) think("doubt", `Weighing ${options.length} options…`);

  // DECIDE — commit to the best and form an intention.
  const best = [...options].sort((a, b) => b.score - a.score)[0];
  const bestAction = compactForMemory(best.action, 500);
  const bestRationale = compactForMemory(best.pro, 500);
  think("decide", `Going with: ${bestAction}`);
  const intention: Intention = { goal: bestAction, rationale: bestRationale, confidence: clamp01(best.score) };
  think("intend", `Intention: ${bestAction} (confidence ${Math.round(intention.confidence * 100)}%)`);

  // REMEMBER the decision so future deliberation is wiser — but ONLY when the
  // caller opts in. Advisory cognition (commitDecision !== true) must not write
  // "Decided to…" memories for choices the model may never act on.
  if (deps.memory && deps.commitDecision) {
    await deps.memory.add({
      kind: "episodic",
      content: `Decided to ${bestAction} when considering "${compactSituation}"`,
      at: now(),
    });
  }

  return { thoughts, intention };
}

function compactForMemory(text: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 32)).trimEnd()} [truncated]`;
}

/** Curiosity: gaps the agent flagged in itself become intentions to pursue. */
export interface CapabilityGap {
  name: string;
  status: string;
}

export function detectDrives(gaps: readonly CapabilityGap[]): Intention[] {
  return gaps
    .filter((g) => g.status === "want")
    .map((g) => ({
      goal: `acquire "${g.name}"`,
      rationale: `I flagged "${g.name}" as something I'll need but don't have yet`,
      confidence: 0.6,
    }));
}
