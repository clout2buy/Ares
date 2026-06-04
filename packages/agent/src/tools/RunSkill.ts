// RunSkill — execute a skill you forged with SkillCraft.
//
// SkillCraft writes handler.js files; this tool runs them. Together they close
// the loop on self-extension: notice a gap -> craft a skill -> run it. The
// handler runs in an isolated child process (see skills/runtime.ts), so a
// crash or hang can never break the turn.
//
// Safety is "external-state": executing arbitrary self-authored code is riskier
// than authoring it, so it passes through the approval gate (except in bypass
// mode) the same way an outward-facing action would.

import { z } from "zod";
import { buildTool } from "@crix/tools";
import { crixAgentHome } from "../paths.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import { runSkill } from "../skills/runtime.js";
import { recordOutcome } from "../self/store.js";

const inputSchema = z
  .object({
    name: z
      .string()
      .describe("Name of the skill to run (the directory under ~/.crix/skills/). Must have a handler.js."),
    input: z
      .unknown()
      .optional()
      .describe("JSON-serializable value passed to the handler as its first argument."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .max(120_000)
      .optional()
      .describe("Hard timeout in milliseconds (default 30000, max 120000)."),
  })
  .strict();

export interface RunSkillOutput {
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string;
  durationMs: number;
  timedOut: boolean;
}

export const RunSkillTool = buildTool({
  name: "RunSkill",
  description:
    "Execute one of your own skills by name — runs its handler.js in an isolated child process and returns the result. Use after SkillCraft to actually exercise a capability you built, or whenever a stored skill is the right tool for the job. The handler's default export is called as async (input, ctx) => result. This is your body in motion: skills are no longer documentation islands.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `RunSkill ${i.name}`,

  async call(input, ctx): Promise<{ output: RunSkillOutput; display: string }> {
    const home = crixAgentHome(process.env.CRIX_HOME);
    const run = await runSkill({
      home,
      name: input.name,
      input: input.input,
      timeoutMs: input.timeout_ms,
      signal: ctx.signal,
    });

    emitLifecycle({
      type: "skill_ran",
      name: run.name,
      ok: run.ok,
      durationMs: run.durationMs,
      gain: gainForTarget("SKILL", 1, run.ok ? "ran" : "failed"),
    });

    // Feed the outcome back into the self-model. Never let the growth engine
    // break a turn — a self-model write failure is logged, not thrown.
    try {
      await recordOutcome(home, {
        id: `skill/${run.name}`,
        kind: "skill",
        name: run.name,
        ok: run.ok,
        ms: run.durationMs,
        error: run.error,
        provenance: "SkillCraft",
      });
    } catch {
      // self-model is best-effort
    }

    const output: RunSkillOutput = {
      name: run.name,
      ok: run.ok,
      result: run.result,
      error: run.error,
      logs: run.logs,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
    };

    const display = run.ok
      ? `+1 SKILL — ran ${run.name} (${run.durationMs}ms)`
      : `SKILL failed — ${run.name}: ${truncate(run.error ?? "unknown error", 80)}`;

    return { output, display };
  },
});

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
