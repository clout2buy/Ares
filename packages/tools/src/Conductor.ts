// Conductor.ts — the model-facing shell over the deterministic runFleet runtime.
//
// The Ares agent AUTHORS a flat FleetSpec (the hardest element it faces is a
// shape-EXAMPLE object, not a JSON-Schema) and the runtime executes it
// start-to-finish. All the stateful failure modes — concurrency caps, abort
// cascade, schema retry, budget abort, pipeline barrier, journaling — live in
// runFleet, which the model never touches. Robust on ANY provider because every
// leaf inherits the parent's provider/model via runForkedTurn.
//
// This file owns the zod binding (the @ares/core runtime is deliberately
// zod-free). The schema seam is derived from a shape-EXAMPLE object so weak
// models can express "I want {summary:'...', score: 0}" without authoring a JSON
// Schema.

import { z } from "zod";
import type { EngineTool, Provider } from "@ares/core";
import {
  runFleet,
  type ConductorDeps,
  type FleetSpec,
  type LeafValidator,
  type SchemaHinter,
  type ValidatorResult,
} from "@ares/core";
import { buildTool } from "./_shared.js";

export interface ConductorToolDeps {
  provider: Provider;
  model: string;
  /** The parent catalog children are scoped from. MUST exclude the Conductor
   *  itself (and Task/Operator) to block recursive fleets — runFleet also rejects
   *  any whitelist naming those, but keep them out of the catalog too. */
  parentTools: readonly EngineTool[];
  baseSystemPrompt: string;
  subModel?: { summarize(req: { input: string; instructions?: string }): Promise<string> };
  defaultMaxTurns?: number;
  /** Unattended posture (default): non-read-only tools are stripped from each
   *  leaf's catalog so a child can't deny-loop on a human-gated tool. Set true
   *  only when the host arranged non-interactive auto-approve for writers. */
  allowWriteTools?: boolean;
}

// ─── Shape-example → validator + hint ──────────────────────────────────────
//
// A shape-example is a plain object whose VALUES illustrate the expected types:
//   { "summary": "a one-line gist", "score": 0, "risks": ["..."] }
// We validate a candidate by structural type-match per key (string/number/
// boolean/array/object), tolerating extra keys (weak models add noise) and
// requiring every example key to be present with a type-compatible value.

type JsonType = "string" | "number" | "boolean" | "array" | "object" | "null";

function typeOfValue(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t as JsonType;
  return "string";
}

function matchShape(example: unknown, candidate: unknown, pathStr: string, issues: string[]): void {
  const et = typeOfValue(example);
  const ct = typeOfValue(candidate);
  if (et === "object") {
    if (ct !== "object") {
      issues.push(`${pathStr || "root"}: expected object, got ${ct}`);
      return;
    }
    const ex = example as Record<string, unknown>;
    const ca = candidate as Record<string, unknown>;
    for (const key of Object.keys(ex)) {
      if (!(key in ca)) {
        issues.push(`${pathStr ? pathStr + "." : ""}${key}: missing`);
        continue;
      }
      matchShape(ex[key], ca[key], `${pathStr ? pathStr + "." : ""}${key}`, issues);
    }
    return;
  }
  if (et === "array") {
    if (ct !== "array") {
      issues.push(`${pathStr || "root"}: expected array, got ${ct}`);
      return;
    }
    const exArr = example as unknown[];
    if (exArr.length > 0) {
      for (let i = 0; i < (candidate as unknown[]).length; i++) {
        matchShape(exArr[0], (candidate as unknown[])[i], `${pathStr}[${i}]`, issues);
      }
    }
    return;
  }
  // primitive: number↔number, boolean↔boolean; everything coerces to string OK.
  if (et === "number" && ct !== "number") issues.push(`${pathStr || "root"}: expected number, got ${ct}`);
  else if (et === "boolean" && ct !== "boolean") issues.push(`${pathStr || "root"}: expected boolean, got ${ct}`);
}

export const exampleValidator: LeafValidator = (
  schema: Record<string, unknown>,
  parsed: unknown,
): ValidatorResult => {
  const issues: string[] = [];
  matchShape(schema, parsed, "", issues);
  return issues.length === 0 ? { ok: true, value: parsed } : { ok: false, issues: issues.join("; ") };
};

export const exampleHinter: SchemaHinter = (schema) => JSON.stringify(schema, null, 2);

// ─── Input schema (the FleetSpec the model fills in) ───────────────────────

const agentSchema = z
  .object({
    role: z.string().min(1).describe("Short role label, e.g. 'security-angle'."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Self-contained instructions. The agent sees NONE of your context. In a pipeline phase you may reference the prior stage with {{prev}} or {{prev.field}}.",
      ),
    tools: z
      .array(z.string())
      .optional()
      .describe("Optional tool-name whitelist. Omit for full (read-only) access."),
    schema: z
      .record(z.any())
      .optional()
      .describe(
        'Optional shape-EXAMPLE object (NOT JSON-Schema), e.g. {"summary":"...","score":0}. The leaf output is validated to match it.',
      ),
    maxTurns: z.number().int().positive().optional().describe("Per-agent turn ceiling."),
  })
  .strict();

const phaseSchema = z
  .object({
    id: z.string().min(1).describe("Stable phase id (used for templates + journaling)."),
    kind: z
      .enum(["parallel", "pipeline"])
      .describe(
        "'parallel' = fan out all agents at once; 'pipeline' = run them in order, each seeded with the prior stage output.",
      ),
    agents: z.array(agentSchema).min(1).max(32),
    reduce: z
      .enum(["concat", "first", "judge"])
      .optional()
      .describe(
        "parallel only: 'concat' joins all outputs (default), 'first' keeps the first success, " +
          "'judge' runs ONE extra synthesis fork over all outputs (use for review/options PANELS).",
      ),
    judgeInstruction: z
      .string()
      .optional()
      .describe("'judge' only: how the synthesis fork should weigh the candidates (e.g. 'rank by severity, keep the top 3')."),
    build: z
      .boolean()
      .optional()
      .describe("BUILD phase: leaves get write tools (Bash/Edit/Write) to create files. MUST be kind:'pipeline' (serial writers). Dangerous tools (payment/email/deploy/account/desktop) are still stripped."),
  })
  .strict();

const inputSchema = z
  .object({
    goal: z.string().optional().describe("Optional human label for the fleet."),
    plan: z
      .string()
      .optional()
      .describe("EASY MODE: a one-line goal (e.g. 'build a multiplayer FPS in the browser'). The planner expands it into a WIDE research→plan→build→verify fleet for you. Use this instead of authoring phases when you want a full build — omit 'phases' when you set 'plan'."),
    phases: z.array(phaseSchema).min(1).optional().describe("Phases run sequentially. Omit when you set 'plan' (the planner authors them)."),
    concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max in-flight forks in a parallel phase. Default 3 (clamped to 8); lower for local models."),
    maxTotalTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Hard ceiling on summed tokens across ALL forks. New forks stop being admitted on breach. Omit for a size-derived default."),
    maxWallClockMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Wall-clock backstop (ms). Aborts the whole fleet if it runs longer — catches a hung fork. Omit for a size-derived default."),
    resumeFleetId: z
      .string()
      .optional()
      .describe("Resume a prior fleet by its fleetId: completed leaves are reused from disk; only failed/missing ones re-run."),
  })
  .strict();

export function makeConductorTool(deps: ConductorToolDeps) {
  return buildTool({
    name: "Conductor",
    description: CONDUCTOR_DESCRIPTION,
    // The wrapper is read-only; child forks enforce their own per-tool
    // permissions inside their scoped engines (and the runtime strips
    // human-gated tools from a leaf's catalog under the unattended posture).
    safety: "read-only",
    // It owns its own internal fan-out, so it must solo (no engine-level batching).
    concurrency: "exclusive",
    // Fleets legitimately run minutes; bounded by the parent's deadline signal.
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    activityDescription: (i) =>
      i.plan
        ? `Conductor: planning a fleet for "${i.plan.slice(0, 60)}"`
        : `Conductor: ${i.goal ?? `${i.phases?.length ?? 0} phase(s)`} (${(i.phases ?? []).reduce((n, p) => n + p.agents.length, 0)} agents)`,
    async call(i, ctx) {
      const runtimeDeps: ConductorDeps = {
        provider: deps.provider,
        model: deps.model,
        parentTools: deps.parentTools,
        baseSystemPrompt: deps.baseSystemPrompt,
        workspace: ctx.workspace,
        signal: ctx.signal,
        emitProgress: ctx.emitProgress,
        subModel: deps.subModel ?? ctx.subModel,
        defaultMaxTurns: deps.defaultMaxTurns,
        allowWriteTools: deps.allowWriteTools,
        validate: exampleValidator,
        schemaHint: exampleHinter,
      };
      const result = await runFleet(i as FleetSpec, runtimeDeps);
      // Corrective hints — turn the runtime's failure signals into one-line advice
      // the model will actually read and apply next time (closes the learning loop).
      const stripped = result.phases.flatMap((p) => p.leaves.flatMap((l) => l.strippedTools));
      const unresolved = result.phases.reduce((n, p) => n + p.unresolvedTemplates, 0);
      const hints: string[] = [];
      if (stripped.length > 0)
        hints.push(
          `${stripped.length} write tool(s) were stripped (unattended posture). Serialize writers into ONE pipeline stage, or don't whitelist write tools in a fleet.`,
        );
      if (unresolved > 0)
        hints.push(
          `${unresolved} {{template}} ref(s) didn't resolve — a hand-off broke. Check that the referenced phase/field exists and the upstream stage emitted a schema.`,
        );
      if (result.budgetExceeded)
        hints.push("The token budget was hit; later forks were skipped. Raise maxTotalTokens or split into smaller fleets — then resumeFleetId to finish.");
      if (result.status !== "completed")
        hints.push(`Fleet ${result.status}. Re-run with resumeFleetId: "${result.fleetId}" to reuse completed leaves and only retry the rest.`);
      return {
        output: {
          fleetId: result.fleetId,
          status: result.status,
          budgetExceeded: result.budgetExceeded,
          ...(hints.length > 0 ? { hints } : {}),
          summary: result.summary,
          usage: result.usage,
          phases: result.phases.map((p) => ({
            id: p.id,
            kind: p.kind,
            status: p.status,
            failureReason: p.failureReason,
            unresolvedTemplates: p.unresolvedTemplates,
            agents: p.leaves.map((l) => ({
              role: l.role,
              status: l.status,
              schemaValid: l.schemaValid,
              unresolvedTemplates: l.unresolvedTemplates,
              strippedTools: l.strippedTools,
              structured: l.structured,
            })),
          })),
          manifestPath: result.manifestPath,
        },
        display: `Fleet ${result.status} — ${result.phases.length} phase(s), ${result.phases.reduce((n, p) => n + p.leaves.length, 0)} agents`,
      };
    },
  });
}

const CONDUCTOR_DESCRIPTION = `Author and run a deterministic agent FLEET for work with structure the model-driven Task tool can't guarantee: capped parallel fan-out, typed multi-stage pipelines, schema-validated outputs, build phases that write code, and a token budget.

EASY MODE (preferred for builds): set "plan" to a ONE-LINE goal — e.g. {"plan":"build a browser multiplayer FPS with Node/Vite"} — and the planner expands it into a WIDE research→plan→build→verify fleet for you. Omit "phases" when you use "plan". This is the right call for "build me X": you get a deep, tooled, self-verifying fleet without hand-authoring it.

ADVANCED: emit "phases" yourself. Either way a deterministic runtime executes it start-to-finish — it owns concurrency, cancellation, schema retries, the pipeline hand-off barrier, build-phase write tools, and the budget. You do NOT manage the fan-out turn-by-turn.

REACH FOR THIS for any non-trivial BUILD or research task. DECOMPOSE DEEPLY — fan
5-16 agents across phases, not 3-4. A 3-agent fleet is a review panel, NOT a build:
for "build me X", structure it as research (parallel, wide) → plan (pipeline) →
build (parallel, file-disjoint modules) → verify (a stage that runs the build/tests
and fails closed). Under-decomposing into a few agents is the #1 way a fleet
underdelivers — when in doubt, fan WIDER and add a verify phase.

WHEN TO USE:
- Build something real: research the stack in parallel, then build modules in parallel, then verify.
- Survey N angles in parallel then JUDGE them into one answer (research, design options, code-review panels).
- A pipeline where each stage consumes the PREVIOUS stage's structured output (extract → transform → write).
- Any fan-out where you need a concurrency cap, a token budget, or schema-valid leaf outputs.

WORKED EXAMPLE — a review panel that fans out, then synthesizes:
{ "goal": "review the diff",
  "phases": [
    { "id": "review", "kind": "parallel", "reduce": "judge",
      "judgeInstruction": "Merge into one deduplicated list ranked by severity; drop anything two reviewers didn't both raise.",
      "agents": [
        { "role": "correctness", "prompt": "Review the staged diff for correctness bugs. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "security",    "prompt": "Review the staged diff for security issues. Return findings.", "tools": ["Read","Grep","Bash"], "schema": {"findings":[{"title":"...","severity":0}]} },
        { "role": "perf",        "prompt": "Review the staged diff for performance issues. Return findings.", "tools": ["Read","Grep"], "schema": {"findings":[{"title":"...","severity":0}]} } ] } ],
  "concurrency": 3 }

NOTES:
- 'schema' is a shape-EXAMPLE object (values illustrate types), NOT JSON-Schema.
- reduce: 'judge' adds one synthesis fork over all siblings — far better than 'concat' for panels (you get a merged answer, not N raw opinions to digest yourself).
- In a pipeline, reference the prior stage with {{prev}} / {{prev.field}}; reference an earlier phase with {{phaseId.reduced}}. If a stage's schema fails OR a downstream {{prev.field}} doesn't resolve, the pipeline FAILS CLOSED — it does not run the next stage on garbage.
- Each agent is STATELESS — make every prompt self-contained.
- Children run UNATTENDED but CAN research: read-only tools (Read/Grep/Glob/CodebaseSearch/LSP) AND safe research tools (WebFetch/WebSearch/ImageSearch) are available — whitelist them freely on research agents. Write/destructive/credential/payment/account tools are stripped unless the host enabled write mode; serialize writers into a single pipeline stage.
- If a fleet aborts (budget/time/crash), re-run with resumeFleetId: <the returned fleetId> — completed leaves are reused, only the rest re-runs. The result's 'hints' tell you what to fix.`;
