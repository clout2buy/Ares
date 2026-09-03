// Trimmed system prompt for subagent children.
//
// Children used to receive the FULL owner composition (~6.9k tokens of persona,
// Stripe/Deploy/ComputerUse doctrine, the Operator, the machine card…) under
// their type prompt — for a Grep task. This builds only what a child can act
// on: the environment block, the craft doctrine its tools make relevant
// (edit discipline only when it can edit, blast-radius only when it can
// destroy), the project's instruction files, and the tool doctrine for the
// tools it actually holds. No persona, no reach, no owner workflows.
//
// The type→whitelist intersection uses core's built-in registry so an
// "explorer" gets Read/Glob/Grep doctrine even when the caller hands over the
// whole child catalog. Unknown (persona) types keep the full catalog.

import { BUILT_IN_SUBAGENT_TYPES } from "@ares/core";
import type { PermissionMode } from "@ares/protocol";
import { CODE_REFERENCES, EDITS_THAT_LAND, HOW_YOU_WORK, IRREVERSIBLE_ACTIONS, TASK_MANAGEMENT, TOOL_CALLS, proofContract } from "./craft.js";
import { environmentBlock } from "./surfaces.js";
import { toolDoctrineFor } from "./toolDoctrine.js";

export interface ChildPromptContext {
  permissionMode: PermissionMode;
  workspace: string;
  /** Names of the tools the child may call (the parent's child-scoped catalog
   *  is fine — it is intersected with the type's whitelist). */
  tools: readonly string[];
  /** Project instruction text (ARES.md / AGENTS.md / CLAUDE.md), already loaded. */
  projectInstructions?: string;
  /** Test seam for the date. */
  now?: Date;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "ApplyPatch", "ApplyIntent", "FindAndEdit", "CodeMode"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Cap on inlined project instructions. ARES_CHILD_INSTRUCTIONS_CHARS (default 6000). */
function instructionsCap(): number {
  const raw = Number(process.env.ARES_CHILD_INSTRUCTIONS_CHARS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 6_000;
}

/** The tools a child of `type` really holds out of `parentTools`. */
export function childToolCatalog(type: string, parentTools: readonly string[]): string[] {
  const whitelist = BUILT_IN_SUBAGENT_TYPES.find((t) => t.name === type)?.toolWhitelist;
  if (!whitelist) return [...parentTools];
  const allowed = new Set(whitelist);
  return parentTools.filter((name) => allowed.has(name));
}

export function buildChildSystemPrompt(type: string, ctx: ChildPromptContext): string {
  const tools = childToolCatalog(type, ctx.tools);
  const canEdit = tools.some((t) => EDIT_TOOLS.has(t));
  const canShell = tools.some((t) => SHELL_TOOLS.has(t));
  const producesChanges = canEdit || canShell;

  const blocks: string[] = [
    HOW_YOU_WORK,
    proofContract({ producesChanges }),
    ...(canEdit ? [EDITS_THAT_LAND] : []),
    ...(tools.includes("TodoWrite") ? [TASK_MANAGEMENT] : []),
    TOOL_CALLS,
    ...(producesChanges ? [IRREVERSIBLE_ACTIONS] : []),
    CODE_REFERENCES,
    toolDoctrineFor(tools),
  ];

  const instructions = (ctx.projectInstructions ?? "").trim();
  if (instructions) {
    const cap = instructionsCap();
    const body = instructions.length > cap ? `${instructions.slice(0, cap)}\n[truncated: ${instructions.length - cap} chars omitted]` : instructions;
    blocks.push(`## Project instructions\n\nThe owner's standing rules for this workspace — they outrank the doctrine above.\n\n${body}`);
  }

  const platform = process.platform === "win32" ? "Windows (PowerShell first)" : process.platform;
  const today = (ctx.now ?? new Date()).toISOString().slice(0, 10);
  blocks.push(environmentBlock(ctx.permissionMode, ctx.workspace, platform, today));
  blocks.push("You are a subagent: your final message goes to the caller that launched you, not the owner. Report what you found or changed with `file_path:line` refs, what you verified, and anything you could not do.");

  return blocks.map((b) => b.trim()).filter(Boolean).join("\n\n");
}
