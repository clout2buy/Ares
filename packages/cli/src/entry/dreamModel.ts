// The model behind a deep dream — shared by the desktop daemon and the
// garrison, so both distill staged notes and propose self-file rewrites the
// same way. `distill` is only ever called when light dreaming staged
// something (runDeepDream checks first), so an idle night costs no call.

import { sideQuery, sideQueryJson, type Provider } from "@ares/core";
import { CONVERSATION_REFLECT_SYSTEM, DURABLE_FACTS_SCHEMA_HINT, type DurableFact } from "@ares/mind";
import { SELF_FILE_REWRITE_SYSTEM, selfFileRewritePrompt, type DreamModel } from "@ares/agent";

export function dreamModelFor(selection: { provider: Provider; model: string }): DreamModel {
  return {
    distill: (notes) =>
      sideQueryJson<DurableFact[]>({
        provider: selection.provider,
        model: selection.model,
        system: CONVERSATION_REFLECT_SYSTEM,
        user: `Notes staged from the owner's recent sessions (their own words, not facts yet):\n${notes.map((n) => `- ${n}`).join("\n").slice(-6000)}`,
        schemaHint: DURABLE_FACTS_SCHEMA_HINT,
        maxOutputTokens: 800,
      }),
    rewriteSelfFile: (input) =>
      sideQuery({
        provider: selection.provider,
        model: selection.model,
        system: SELF_FILE_REWRITE_SYSTEM,
        user: selfFileRewritePrompt(input),
        maxOutputTokens: 6000,
        timeoutMs: 180_000,
      }),
  };
}
