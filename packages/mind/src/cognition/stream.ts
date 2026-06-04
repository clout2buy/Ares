// The thought stream — what the UI renders so you watch Crix think (M2 × M3).
//
// Each thought kind has a glyph so the narrated stream reads like a mind at
// work, not a log. The Tauri face animates these as they arrive (thoughts type
// in, doubts wobble, decisions land).

import type { Thought, ThoughtKind } from "./types.js";

const GLYPH: Record<ThoughtKind, string> = {
  observe: "👁",
  recall: "💭",
  question: "❓",
  idea: "💡",
  doubt: "🤔",
  decide: "✓",
  intend: "→",
  reflect: "↻",
};

export class ThoughtStream {
  private readonly thoughts: Thought[] = [];

  record(thought: Thought): void {
    this.thoughts.push(thought);
  }

  all(): Thought[] {
    return [...this.thoughts];
  }

  last(): Thought | undefined {
    return this.thoughts[this.thoughts.length - 1];
  }

  clear(): void {
    this.thoughts.length = 0;
  }

  /** Human-readable narration of the stream — the inner monologue, rendered. */
  narrate(): string {
    return this.thoughts.map((t) => `${GLYPH[t.kind]}  ${t.text}`).join("\n");
  }
}

export function thoughtGlyph(kind: ThoughtKind): string {
  return GLYPH[kind];
}
