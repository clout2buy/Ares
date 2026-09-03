// Subagent children get a TRIMMED prompt (v0.46 batch, item 2).
//
// A Grep-only explorer used to receive the whole owner composition — persona,
// Stripe/Deploy/ComputerUse doctrine, the Operator, the machine card. The
// child prompt carries only what its tools make relevant, plus the environment
// and the project's instruction files.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { buildChildSystemPrompt, childToolCatalog } from "../packages/cli/dist/entry/prompt/index.js";
import { buildSystemPrompt } from "../packages/cli/dist/entry/turnPipeline.js";

const FULL_CHILD_CATALOG = [
  "Read", "Write", "Edit", "ApplyPatch", "ApplyIntent", "Glob", "Grep", "CodebaseSearch", "LSP",
  "PowerShell", "Bash", "FindAndEdit", "CodeMode", "TodoWrite", "WebSearch", "ImageSearch", "WebFetch",
  "BashOutput", "KillShell", "BackgroundTasks", "ComputerUse", "Deploy", "Stripe", "Email", "Operator",
  "Capability", "Browser", "RequestUserAction",
];

const workspace = path.join(os.tmpdir(), "ares-child-prompt-ws");
const ctx = (tools = FULL_CHILD_CATALOG, extra = {}) => ({
  permissionMode: "workspace-write",
  workspace,
  tools,
  projectInstructions: "Loaded project instructions from ARES.md:\n\nUse pnpm for scripts. Tests import from dist.",
  now: new Date("2026-09-01T00:00:00Z"),
  ...extra,
});

test("child: the explorer prompt is small and carries none of the owner-only doctrine", () => {
  const p = buildChildSystemPrompt("explorer", ctx());
  assert.ok(p.length < 6_000, `explorer prompt should be under 6k chars, got ${p.length}`);
  for (const banned of [/Stripe/, /Deploy/, /ComputerUse/, /god of war/, /Mr\. Doing/, /Operator/, /machine card/i, /Reach —/]) {
    assert.doesNotMatch(p, banned, `explorer prompt must not carry ${banned}`);
  }
});

test("child: environment block and workspace instructions survive the trim", () => {
  const p = buildChildSystemPrompt("explorer", ctx());
  assert.match(p, /## Environment/);
  assert.match(p, new RegExp(`Working directory: ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(p, /Today's date: 2026-09-01/);
  assert.match(p, /Permission mode: workspace-write/);
  assert.match(p, /## Project instructions/);
  assert.match(p, /Use pnpm for scripts/);
  assert.match(p, /outrank the doctrine above/, "instructions are stated to outrank the trimmed doctrine");
});

test("child: doctrine follows the tools the type actually has", () => {
  const explorer = buildChildSystemPrompt("explorer", ctx());
  assert.deepEqual(childToolCatalog("explorer", FULL_CHILD_CATALOG), ["Read", "Glob", "Grep", "CodebaseSearch", "LSP"]);
  assert.match(explorer, /\*\*LSP\*\*/, "LSP doctrine rides with an LSP-holding child");
  assert.doesNotMatch(explorer, /## Edits that land/, "a read-only child gets no edit discipline");
  assert.doesNotMatch(explorer, /## Irreversible actions/, "…and no blast-radius doctrine");
  assert.doesNotMatch(explorer, /## Background work/);
  assert.match(explorer, /Report faithfully/, "faithful reporting is universal");
  assert.doesNotMatch(explorer, /"Works" is not the bar/, "the quality bar is about shipping edits");

  const general = buildChildSystemPrompt("general-purpose", ctx());
  assert.match(general, /## Edits that land/);
  assert.match(general, /## Irreversible actions/);
  assert.match(general, /## Background work/);
  assert.match(general, /"Works" is not the bar/);
  assert.match(general, /PowerShell tool description lists them/, "the PS 5.1 traps pointer rides with a PowerShell-holding child");
  assert.match(general, /Deploy \/ Stripe \/ Email/, "a full-catalog child keeps the reach doctrine for tools it holds");
  assert.doesNotMatch(general, /god of war/, "no persona for any child");
});

test("child: an unknown (persona) type keeps the full catalog it was handed", () => {
  assert.deepEqual(childToolCatalog("my-persona", ["Read", "Bash"]), ["Read", "Bash"]);
});

test("child: the trimmed prompt is a fraction of the owner prompt", () => {
  const owner = buildSystemPrompt("workspace-write", undefined, {});
  const child = buildChildSystemPrompt("explorer", ctx());
  assert.ok(child.length < owner.length / 2, `child ${child.length} vs owner ${owner.length}`);
});

test("child: oversized project instructions are capped, not dropped", () => {
  const prev = process.env.ARES_CHILD_INSTRUCTIONS_CHARS;
  process.env.ARES_CHILD_INSTRUCTIONS_CHARS = "200";
  try {
    const p = buildChildSystemPrompt("explorer", ctx(FULL_CHILD_CATALOG, { projectInstructions: "RULE ".repeat(200) }));
    assert.match(p, /\[truncated: \d+ chars omitted\]/);
    assert.match(p, /RULE RULE/);
  } finally {
    if (prev === undefined) delete process.env.ARES_CHILD_INSTRUCTIONS_CHARS;
    else process.env.ARES_CHILD_INSTRUCTIONS_CHARS = prev;
  }
});
