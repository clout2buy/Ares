// Plan mode tools — let the model explicitly enter/exit read-only planning.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { PermissionMode } from "@crix/protocol";

export interface PlanModeState {
  permissionMode: PermissionMode;
}

const enterSchema = z
  .object({
    reason: z.string().default("Planning requested."),
  })
  .strict();

const exitSchema = z
  .object({
    plan: z.string().min(1).describe("Markdown plan for the user to approve or refine."),
  })
  .strict();

export function makeEnterPlanModeTool(state: PlanModeState) {
  return buildTool({
    name: "EnterPlanMode",
    description:
      "Switch Crix into plan mode. In plan mode, write tools are blocked and the UI shows [PLAN]. Use when the user asks to plan before coding.",
    safety: "read-only",
    concurrency: "exclusive",
    inputZod: enterSchema,
    activityDescription: () => "Entering plan mode",
    async call(i): Promise<{ output: { mode: PermissionMode; reason: string }; display: string }> {
      state.permissionMode = "plan";
      return { output: { mode: state.permissionMode, reason: i.reason }, display: "[PLAN] enabled" };
    },
  });
}

export function makeExitPlanModeTool(state: PlanModeState) {
  return buildTool({
    name: "ExitPlanMode",
    description:
      "Present the completed markdown plan and switch back to normal workspace-write mode. Use after plan-mode investigation is ready for approval.",
    safety: "read-only",
    concurrency: "exclusive",
    inputZod: exitSchema,
    activityDescription: () => "Exiting plan mode",
    async call(i): Promise<{ output: { mode: PermissionMode; plan: string }; display: string }> {
      state.permissionMode = "workspace-write";
      return { output: { mode: state.permissionMode, plan: i.plan }, display: "[PLAN] disabled" };
    },
  });
}
