// System prompt size budget (v0.46 batch, item 3).
//
// Measured 27,095 chars on 2026-09-01 (default catalog, provisioned machine
// card). The cut: tool doctrine keyed by tool and appended only for the turn's
// catalog; Proof + Codebase + Quality merged into one contract; three reach
// sections merged into one. This pins the budget for the default coding
// catalog AND proves every hard rule survived.

import test from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../packages/cli/dist/entry/turnPipeline.js";
import { toolDoctrineFor } from "../packages/cli/dist/entry/prompt/index.js";

/** The catalog buildCodingEngineTools assembles (+ Task/Conductor). */
const CODING_CATALOG = [
  "Read", "Write", "Edit", "ApplyPatch", "ApplyIntent", "Glob", "Grep", "CodebaseSearch", "LSP",
  "PowerShell", "Bash", "FindAndEdit", "CodeMode", "TodoWrite", "BashOutput", "KillShell", "BackgroundTasks",
  "EnterPlanMode", "UpdatePlanDraft", "ExitPlanMode", "Task", "TaskOutput", "KillTask", "Conductor",
];

const BUDGET = 15_000;

const HARD_RULES = [
  [/never a bare "done/i, "verify-as-contract: no bare done"],
  [/Report faithfully/i, "faithful reporting"],
  [/Diagnose before retry/i, "diagnose before retry"],
  [/Minimum complexity/i, "minimum complexity"],
  [/Verify against the REAL thing/i, "verify the real thing"],
  [/Reading the code is NOT verification/i, "reading != verifying"],
  [/Compiling is not working/i, "compiling != working"],
  [/symptom the owner actually reported/i, "verify the reported symptom"],
  [/most expensive lie/i, "false success on long missions"],
  [/blast radius/i, "trace consumers before editing"],
  [/Fifty failures is almost never fifty problems/i, "triage doctrine"],
  [/house style is a defect/i, "match local pattern"],
  [/"Works" is not the bar/i, "quality bar"],
  [/only your eyes prove the experience/i, "look at the UI you built"],
  [/never by sleeping and re-checking/i, "time-dependent verification"],
  [/without line-number prefixes/i, "old_string copy rule"],
  [/fails SILENTLY when the pattern misses/i, "shell regex edit hazard"],
  [/That's how files get truncated/i, "never Write-rewrite after a failed Edit"],
  [/TOOL RESULTS ARE NOT THE USER/i, "tool output is not the human"],
  [/DELIVER, DON'T DEFLECT/i, "deliver what was asked"],
  [/Defensive security only/i, "security posture"],
  [/Never commit unless/i, "git discipline"],
  [/NEVER tell the owner you "can't see"/i, "no false incapacity"],
  [/OneDrive/i, "Windows desktop redirection"],
  [/PLAN MODE/i, "plan-mode boundary"],
  [/Act first\./, "act-first doctrine"],
  [/PowerShell tool description lists them/i, "PS 5.1 traps pointer"],
  [/what else does this match/i, "irreversible-action question"],
  [/file_path:line_number/i, "code reference format"],
  [/## Background work/, "background-job ownership (BashOutput in catalog)"],
];

test("budget: the default coding catalog composes under 15,000 chars", () => {
  const p = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  assert.ok(p.length <= BUDGET, `expected ≤ ${BUDGET} chars, got ${p.length}`);
  assert.ok(p.length > 9_000, `suspiciously small (${p.length}) — a section may have been dropped entirely`);
});

test("budget: every hard rule is still present for the coding catalog", () => {
  const p = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  const missing = HARD_RULES.filter(([re]) => !re.test(p)).map(([, what]) => what);
  assert.deepEqual(missing, [], `rules lost in the cut: ${missing.join(" | ")}`);
});

test("budget: LAWS injection and act-first survive", () => {
  const p = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  assert.match(p, /Act first/, "act-first doctrine");
  // lawsPromptBlock() is composed in every prompt; with no laws on this
  // machine it is empty, so prove the seam by position rather than content:
  // the doctrine precedes the surfaces exactly as before.
  assert.ok(p.indexOf("## How you work") < p.indexOf("## Environment"));
});

test("budget: tool doctrine rides only with the tools in the catalog", () => {
  const coding = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  assert.doesNotMatch(coding, /pixel space of the LAST image/, "ComputerUse contract absent without ComputerUse");
  assert.doesNotMatch(coding, /Deploy \/ Stripe \/ Email/, "reach-tool key rules absent without those tools");
  assert.doesNotMatch(coding, /## Durable missions/, "Operator workflow absent without the Operator tool");
  assert.doesNotMatch(coding, /## Environment control/, "Capability workflow absent without Capability");

  const full = buildSystemPrompt("workspace-write", undefined, {});
  assert.match(full, /pixel space of the LAST image/, "no catalog = everything (legacy callers lose nothing)");
  assert.match(full, /Deploy \/ Stripe \/ Email/);
  assert.match(full, /## Durable missions/);

  const withComputer = buildSystemPrompt("workspace-write", undefined, { tools: [...CODING_CATALOG, "ComputerUse"] });
  assert.match(withComputer, /pixel space of the LAST image/);
  assert.equal(toolDoctrineFor([]), "", "an empty catalog carries no tool doctrine at all");
});

test("budget: prefix stability — volatile fields stay in the same relative position, never last", () => {
  const a = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  const dateAt = a.indexOf("Today's date:");
  assert.ok(dateAt > 0);
  assert.ok(dateAt > a.indexOf("## Hard rules"), "date sits after the hard rules");
  assert.ok(dateAt < a.lastIndexOf("When you finish, report"), "…and is not the last thing in the prompt");
  // Everything before the environment block is byte-identical across two composes.
  const b = buildSystemPrompt("workspace-write", undefined, { tools: CODING_CATALOG });
  assert.equal(a.slice(0, a.indexOf("## Environment")), b.slice(0, b.indexOf("## Environment")));
});
