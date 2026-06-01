// Cognition types (Crix v6 / M2) — the shape of a thought.
//
// What makes Crix feel like a mind instead of a chatbot is a visible inner life:
// it observes, recalls, has ideas, doubts them, decides, and forms intentions —
// and you watch the stream. These are the beats of that monologue.

export type ThoughtKind =
  | "observe" // noticing the situation
  | "recall" // what memory surfaces
  | "question" // asking itself something
  | "idea" // a candidate option
  | "doubt" // weighing / second-guessing
  | "decide" // committing to a choice
  | "intend" // forming an intention to act
  | "reflect"; // looking back

export interface Thought {
  kind: ThoughtKind;
  text: string;
  at: string;
}

/** A formed intention — what the mind has decided it wants to do. */
export interface Intention {
  goal: string;
  rationale: string;
  confidence: number; // 0..1
}

export interface Deliberation {
  thoughts: Thought[];
  intention: Intention | null;
}
