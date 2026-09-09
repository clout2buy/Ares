/** Context windows reported by the providers' own model listings
 *  (Anthropic max_input_tokens, OpenRouter context_length …). Filled by the
 *  catalog fetches; consulted BEFORE the regex heuristics in sessionFactory
 *  so a model released after that file was written is budgeted from what its
 *  API says, not from a 128k guess.
 *
 *  Lives in its own leaf module: providers.ts records here and
 *  sessionFactory.ts reads here. Importing sessionFactory from providers
 *  closed an import cycle that reaches ink's top-level await, which esbuild
 *  mis-emits (`await init_providers()` inside a non-async wrapper) and the
 *  bundled desktop daemon failed to parse. */
const liveModelContextWindows = new Map<string, number>();

export function recordLiveModelContextWindow(modelId: string, tokens: number): void {
  if (!modelId || !Number.isFinite(tokens) || tokens < 8_000) return;
  liveModelContextWindows.set(modelId.toLowerCase(), Math.floor(tokens));
}

export function liveModelContextWindow(modelId: string): number | undefined {
  return liveModelContextWindows.get((modelId ?? "").toLowerCase());
}
