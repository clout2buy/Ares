// System-prompt composition.
//
//   persona (configurable)  →  craft core (shared)  →  provider overlay  →  surfaces
//
// Before this split the whole thing was one 33,819-char string — larger than
// opencode's biggest per-model prompt by more than 2×, and 4× their Anthropic
// one — with six sections restating the same doctrine and one 4,660-char block
// paraphrasing tool descriptions the model already receives. The split brought
// it to 27,095 chars measured (2026-09-01, default catalog, provisioned machine
// card); the cut after that brought the default coding catalog under 15,000
// (tests/prompt-size-budget.test.mjs pins it). What went: tool doctrine is now
// keyed by tool and rides only with the tools in the turn's catalog
// (toolDoctrine.ts); Proof/Codebase/Quality became one contract; three reach
// sections became one. Nothing here is softened; it is de-duplicated, and the
// parts that vary by owner (voice) or by model (failure mode) live where they
// can actually vary.

import { craftCore } from "./craft.js";
import { renderPersona, type PersonaConfig } from "./persona.js";
import { providerOverlay, type ProviderFamily } from "./providerOverlay.js";

export { renderPersona, type PersonaConfig, type PersonaStyle } from "./persona.js";
export { providerOverlay, type ProviderFamily } from "./providerOverlay.js";
export { craftCore, proofContract } from "./craft.js";
export { toolDoctrineFor, TOOL_DOCTRINE, type ToolDoctrineEntry } from "./toolDoctrine.js";
export { buildChildSystemPrompt, childToolCatalog, type ChildPromptContext } from "./child.js";
export { environmentBlock, promptEnvironment, promptWorkflowSurfaces } from "./surfaces.js";

export interface PromptSurfaces {
  /** Tool-specific operational doctrine that is NOT in the tool schemas. */
  tools: string;
  /** Workflow surfaces: app loop, plan mode, hooks. */
  workflows: string;
  /** Reach, hard rules, environment block. */
  environment: string;
}

export interface ComposePromptOptions {
  persona?: PersonaConfig;
  providerFamily?: ProviderFamily;
  model?: string;
  surfaces: PromptSurfaces;
  /** The owner's LAWS block (lawsPromptBlock). ALWAYS-ON by design — it rides
   *  the system prompt itself, after the doctrine it outranks, and is never
   *  part of any budgeted context. Empty string when no laws exist. */
  laws?: string;
}

/** Join non-empty blocks with exactly one blank line between them. */
function join(blocks: Array<string | undefined>): string {
  return blocks.map((b) => b?.trim()).filter((b): b is string => Boolean(b)).join("\n\n");
}

export function composeSystemPrompt(opts: ComposePromptOptions): string {
  return join([
    renderPersona(opts.persona),
    craftCore(),
    providerOverlay(opts.providerFamily, opts.model),
    // Laws sit AFTER the doctrine they outrank — recency reinforces the
    // precedence the block itself states — and BEFORE the surfaces, so tool
    // doctrine and environment can still reference them.
    opts.laws,
    opts.surfaces.tools,
    opts.surfaces.workflows,
    opts.surfaces.environment,
  ]);
}
