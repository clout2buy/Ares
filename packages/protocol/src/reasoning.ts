// Unified reasoning levels — one dial the owner controls, translated per provider.
//
// Different backends express "think harder" differently: OpenAI's Responses API
// takes reasoning.effort (a string); Anthropic-shaped reasoners (Ollama Cloud)
// take thinking.budget_tokens (a number). Crix exposes ONE concept — a level —
// and each provider translates it at the wire edge, so the same setting works on
// OpenAI and Ollama alike.

export type ReasoningLevel = "low" | "medium" | "high" | "max";

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["low", "medium", "high", "max"];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Human-facing label. "max" reads as "Extra High". */
export function reasoningLabel(level: ReasoningLevel): string {
  return level === "max" ? "Extra High" : level.charAt(0).toUpperCase() + level.slice(1);
}

/** OpenAI Responses `reasoning.effort`. "max" → "xhigh" (the deepest tier). */
export function openAIReasoningEffort(level: ReasoningLevel): "low" | "medium" | "high" | "xhigh" {
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
  }
}

/**
 * Anthropic / Ollama-reasoner `thinking.budget_tokens`. Must stay below the
 * request's max_tokens — the provider bumps max_tokens to fit (see ollamaCloud).
 */
export function thinkingBudgetTokens(level: ReasoningLevel): number {
  switch (level) {
    case "low":
      return 2_048;
    case "medium":
      return 8_192;
    case "high":
      return 16_384;
    case "max":
      return 32_768;
  }
}
