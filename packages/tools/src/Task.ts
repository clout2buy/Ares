// Task — spawn a subagent with a scoped tool whitelist.
//
// The model sees `subagent_type` as one of the registered types (e.g.
// general-purpose, researcher, code-reviewer). Each type has its own
// tool whitelist and system prompt. The subagent runs to completion in
// isolation and returns ONE summary string — the parent context stays
// clean.
//
// Tool description aggressively pushes the model to use Task for
// search-heavy or context-heavy tasks (the goal: subagents used
// NATURALLY without explicit user prompting).

import { z } from "zod";
import { buildTool } from "./_shared.js";

export interface SubagentRunner {
  run(req: {
    subagent_type: string;
    description: string;
    prompt: string;
    parentSessionId?: string;
    workspace: string;
    signal?: AbortSignal;
    /** Forward child activity (tool_start/tool_end) so the UI isn't a silent
     *  "Delegating…" for up to 40 inner turns. */
    onProgress?: (data: unknown) => void;
  }): Promise<{
    id: string;
    type: string;
    status: "completed" | "failed" | "cancelled";
    summary: string;
    toolCallCount: number;
    durationMs: number;
    transcriptPath: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
  listTypes(): Array<{ name: string; description: string }>;
  has(name: string): boolean;
}

export interface TaskOutput {
  agentId: string;
  type: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  toolCallCount: number;
  durationMs: number;
  transcriptPath: string;
}

const inputSchema = z
  .object({
    description: z
      .string()
      .min(1)
      .describe("3-5 word task label shown in the UI (e.g. 'Find auth handler')."),
    prompt: z
      .string()
      .min(1)
      .describe(
        "Self-contained instructions for the subagent. Be DETAILED — the subagent has none of your conversation context. Include exactly what to research/produce.",
      ),
    subagent_type: z
      .string()
      .min(1)
      .describe(
        "Which subagent type to spawn. Common: 'general-purpose' (full tools, can edit), 'researcher' (read-only investigation), 'code-reviewer' (review pending diff).",
      ),
  })
  .strict();

export function makeTaskTool(runner: SubagentRunner) {
  return buildTool({
    name: "Task",
    description: buildTaskDescription(runner),
    // The Task wrapper itself is read-only from the parent's perspective.
    // Child tool calls still enforce their own permissions through the
    // scoped QueryEngine, including plan-mode write blocking.
    safety: "read-only",
    // Parallel-safe so adjacent Task calls batch and fan out concurrently
    // (subagents are isolated engines; researcher/code-reviewer are read-only).
    // The engine now solos any tool that declares "exclusive", so this is the
    // explicit opt-in to concurrent fan-out.
    concurrency: "parallel-safe",
    // Uncapped: a subagent legitimately runs for minutes. It still inherits the
    // parent's (now deadline-bearing) signal, so a truly hung child is bounded
    // by the parent's own watchdog rather than an arbitrary subagent cap.
    watchdogTimeoutMs: 0,
    inputZod: inputSchema,
    activityDescription: (i) => `Task[${i.subagent_type}] ${i.description}`,
    async checkPermissions(i, ctx) {
      if (!runner.has(i.subagent_type)) {
        return {
          kind: "deny",
          reason: `unknown subagent_type: ${i.subagent_type}. Available: ${runner
            .listTypes()
            .map((t) => t.name)
            .join(", ")}`,
        };
      }
      if (ctx.permissionMode === "plan" && i.subagent_type === "general-purpose") {
        return {
          kind: "deny",
          reason: "general-purpose subagents are disabled in plan mode; use researcher or code-reviewer.",
        };
      }
      return { kind: "allow" };
    },
    async call(i, ctx): Promise<{ output: TaskOutput; display: string }> {
      const result = await runner.run({
        subagent_type: i.subagent_type,
        description: i.description,
        prompt: i.prompt,
        workspace: ctx.workspace,
        signal: ctx.signal,
        onProgress: ctx.emitProgress,
      });
      // A subagent that did NOT complete is a FAILURE, not a result. Surface it
      // as a tool error (is_error) so the parent can't read a dead subagent as
      // success — the exact bug where a fleet died 8/8 yet reported "done".
      if (result.status !== "completed") {
        throw new Error(
          `subagent ${result.type} ${result.status}: ${result.summary || "no summary"}` +
            (result.transcriptPath ? ` (transcript: ${result.transcriptPath})` : ""),
        );
      }
      return {
        output: {
          agentId: result.id,
          type: result.type,
          status: result.status,
          summary: result.summary,
          toolCallCount: result.toolCallCount,
          durationMs: result.durationMs,
          transcriptPath: result.transcriptPath,
        },
        display: `${result.type} → ${result.status} (${result.toolCallCount} tool calls, ${(result.durationMs / 1000).toFixed(1)}s)`,
      };
    },
  });
}

function buildTaskDescription(runner: SubagentRunner): string {
  const types = runner.listTypes();
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return `Spawn a subagent to handle a focused sub-task autonomously. The subagent has its OWN context (no shared memory with you) and returns a single summary string when done.

WHEN TO USE (use this VERY frequently):
- "find all uses of X" / "where is Y handled" / "how does Z work" — use 'researcher'
- Review pending changes — use 'code-reviewer'
- Tasks needing 5+ tool calls — use 'general-purpose' to keep your context clean
- Anything where the raw tool output would otherwise bloat YOUR context

WHEN NOT TO USE:
- Reading a single known file (use Read directly)
- One-off Grep with a known pattern
- Simple edits in the current conversation

Each subagent invocation is STATELESS. Make the prompt SELF-CONTAINED — the subagent cannot see your conversation. Tell it exactly what to investigate/build and what format to return in.

Available subagent types:
${typeList}

Subagent results come back as one summary message; YOUR context never sees the intermediate tool calls. This is the cheapest way to keep your context window healthy on large repos.`;
}
