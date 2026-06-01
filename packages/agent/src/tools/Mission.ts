// Mission — the agent's hands on its own autonomy loop.
//
// Lets Crix set a goal, draft a plan, work the steps, self-verify, and loop
// until the goal is met — all persisted under ~/.crix/missions/ so a mission
// survives across sessions. This is the spine of autonomous behaviour: the
// agent drives the loop itself, and every transition emits a lifecycle event
// so the UI shows meaningful mission-progress notifications.

import { z } from "zod";
import { buildTool } from "@crix/tools";
import { crixAgentHome } from "../paths.js";
import { emitLifecycle } from "../lifecycle/bus.js";
import { gainForTarget } from "../voice.js";
import { recordOutcome } from "../self/store.js";
import {
  abandonMission,
  completeStep,
  createMission,
  failStep,
  nextDirective,
  noteMission,
  planMission,
  startNextStep,
  statusLabel,
  verifyMission,
} from "../mission/loop.js";
import {
  activeMission,
  listMissions,
  loadMission,
  newMissionId,
  saveMission,
} from "../mission/store.js";
import type { Mission, MissionDirective, MissionSummary } from "../mission/types.js";
import { summarize } from "../mission/types.js";

const ACTIONS = [
  "create",
  "plan",
  "next",
  "step_done",
  "step_failed",
  "verify",
  "note",
  "status",
  "list",
  "abandon",
] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS).describe(
      "create: start a mission from a goal. plan: set/revise the step list. next: get the loop's next directive (and start the next step). step_done: mark the current/given step complete. step_failed: mark it failed. verify: self-check whether the goal is met (pass true completes, pass false loops). note: log an observation. status: read one mission. list: summarize all. abandon: stop a mission.",
    ),
    goal: z.string().optional().describe("The mission goal. Required for create."),
    missionId: z.string().optional().describe("Target mission id. Defaults to the active (most-recent open) mission when omitted."),
    steps: z.array(z.string()).optional().describe("Ordered step titles. Used by create and plan."),
    stepId: z.string().optional().describe("Specific step id for step_done/step_failed. Defaults to the current open step."),
    result: z.string().optional().describe("Outcome text for step_done, or the verification verdict for verify."),
    reason: z.string().optional().describe("Reason for step_failed / abandon, or a free note."),
    passed: z.boolean().optional().describe("For verify: true if the goal is genuinely met, false to loop and try again."),
    maxIterations: z.number().int().optional().describe("Loop budget for create (1-20, default 6)."),
  })
  .strict();

export interface MissionToolOutput {
  action: string;
  missionId?: string;
  status?: string;
  directive?: MissionDirective;
  mission?: Mission;
  missions?: MissionSummary[];
}

export const MissionTool = buildTool({
  name: "Mission",
  description:
    "Drive an autonomous mission loop: goal -> plan -> execute -> self-verify -> loop. Use this for any multi-step objective so progress persists across sessions and you can resume it later. Self-territory under ~/.crix/missions/ — no permission ritual. Actions: create, plan, next, step_done, step_failed, verify, note, status, list, abandon.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Mission ${i.action}${i.goal ? ` — ${i.goal.slice(0, 48)}` : ""}`,

  async call(input): Promise<{ output: MissionToolOutput; touchedFiles?: string[]; display: string }> {
    const home = crixAgentHome(process.env.CRIX_HOME);

    if (input.action === "list") {
      const missions = await listMissions(home);
      return {
        output: { action: "list", missions },
        display: `${missions.length} mission(s)`,
      };
    }

    if (input.action === "create") {
      if (!input.goal || !input.goal.trim()) throw new Error("Mission.create requires a goal");
      const mission = createMission({
        id: newMissionId(),
        goal: input.goal,
        steps: input.steps,
        maxIterations: input.maxIterations,
      });
      const file = await saveMission(home, mission);
      emitLifecycle({
        type: "mission_started",
        missionId: mission.id,
        goal: mission.goal,
        gain: gainForTarget("MISSION", 1, "started"),
      });
      const directive = nextDirective(mission);
      return {
        output: { action: "create", missionId: mission.id, status: mission.status, directive, mission },
        touchedFiles: [file],
        display: `+1 MISSION — "${trim(mission.goal)}" [${mission.id}]`,
      };
    }

    // All remaining actions operate on an existing mission.
    const mission = input.missionId ? await loadMission(home, input.missionId) : await activeMission(home);
    if (!mission) {
      throw new Error(
        input.missionId
          ? `Mission ${input.missionId} not found`
          : "no active mission — create one first or pass missionId",
      );
    }

    switch (input.action) {
      case "status": {
        const directive = nextDirective(mission);
        return {
          output: { action: "status", missionId: mission.id, status: mission.status, directive, mission },
          display: `${statusLabel(mission.status)} — ${doneCount(mission)} [${mission.id}]`,
        };
      }

      case "plan": {
        if (!input.steps || input.steps.length === 0) throw new Error("Mission.plan requires steps");
        const planned = planMission(mission, input.steps);
        const file = await saveMission(home, planned);
        const directive = nextDirective(planned);
        return {
          output: { action: "plan", missionId: planned.id, status: planned.status, directive, mission: planned },
          touchedFiles: [file],
          display: `Mission planned — ${input.steps.length} step(s) [${planned.id}]`,
        };
      }

      case "next": {
        const { mission: started, step } = startNextStep(mission);
        if (step) await saveMission(home, started);
        const directive = nextDirective(started);
        return {
          output: { action: "next", missionId: started.id, status: started.status, directive },
          display: `${directive.phase}: ${trim(directive.instruction, 64)}`,
        };
      }

      case "step_done": {
        const done = completeStep(mission, input.result ?? "", input.stepId);
        const file = await saveMission(home, done);
        const remaining = done.steps.filter((s) => s.status === "pending" || s.status === "active").length;
        emitLifecycle({
          type: "mission_step_completed",
          missionId: done.id,
          step: input.stepId ?? "current",
          remaining,
          gain: gainForTarget("MISSION", 1, "step"),
        });
        const directive = nextDirective(done);
        return {
          output: { action: "step_done", missionId: done.id, status: done.status, directive, mission: done },
          touchedFiles: [file],
          display: `+1 MISSION — step done, ${remaining} left [${done.id}]`,
        };
      }

      case "step_failed": {
        const failed = failStep(mission, input.reason ?? input.result ?? "failed", input.stepId);
        const file = await saveMission(home, failed);
        const directive = nextDirective(failed);
        return {
          output: { action: "step_failed", missionId: failed.id, status: failed.status, directive, mission: failed },
          touchedFiles: [file],
          display: `Mission blocked — step failed [${failed.id}]`,
        };
      }

      case "verify": {
        if (typeof input.passed !== "boolean") throw new Error("Mission.verify requires passed: true|false");
        const verdict = input.result ?? input.reason ?? "";
        const { mission: verified, outcome } = verifyMission(mission, { passed: input.passed, verdict });
        const file = await saveMission(home, verified);
        emitLifecycle({
          type: "mission_verified",
          missionId: verified.id,
          passed: input.passed,
          iteration: verified.iterations,
          gain: gainForTarget("MISSION", 1, input.passed ? "verified" : "loop"),
        });
        if (outcome === "completed") {
          emitLifecycle({
            type: "mission_completed",
            missionId: verified.id,
            goal: verified.goal,
            steps: verified.steps.filter((s) => s.status === "done").length,
            gain: gainForTarget("MISSION", verified.steps.filter((s) => s.status === "done").length || 1, "completed"),
          });
        }
        // Feed terminal mission outcomes into the self-model as an aggregate
        // "how reliably do I finish what I start" signal. Best-effort.
        if (outcome === "completed" || outcome === "abandoned") {
          try {
            await recordOutcome(home, {
              id: "mission/_aggregate",
              kind: "mission",
              name: "missions",
              ok: outcome === "completed",
              ms: Date.now() - Date.parse(verified.createdAt),
              error: outcome === "abandoned" ? `abandoned: ${trim(verified.goal)}` : undefined,
            });
          } catch {
            // self-model is best-effort
          }
        }
        const directive = nextDirective(verified);
        const display =
          outcome === "completed"
            ? `MISSION COMPLETE — "${trim(verified.goal)}" [${verified.id}]`
            : outcome === "abandoned"
              ? `Mission abandoned — budget spent [${verified.id}]`
              : `Mission loop — iteration ${verified.iterations}/${verified.maxIterations} [${verified.id}]`;
        return {
          output: { action: "verify", missionId: verified.id, status: verified.status, directive, mission: verified },
          touchedFiles: [file],
          display,
        };
      }

      case "note": {
        const noted = noteMission(mission, input.reason ?? input.result ?? "");
        const file = await saveMission(home, noted);
        return {
          output: { action: "note", missionId: noted.id, status: noted.status },
          touchedFiles: [file],
          display: `note logged [${noted.id}]`,
        };
      }

      case "abandon": {
        const stopped = abandonMission(mission, input.reason ?? "manual stop");
        const file = await saveMission(home, stopped);
        return {
          output: { action: "abandon", missionId: stopped.id, status: stopped.status, mission: stopped },
          touchedFiles: [file],
          display: `Mission abandoned [${stopped.id}]`,
        };
      }

      default:
        throw new Error(`Mission: unsupported action ${String(input.action)}`);
    }
  },
});

function doneCount(mission: Mission): string {
  const s = summarize(mission);
  return `${s.done}/${s.total}`;
}

function trim(text: string, max = 40): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
