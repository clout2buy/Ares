// Recurring work needs its own yes — naming the schedule.
//
// A yes to "remind me at 5" authorizes one reminder. It does not authorize
// "every day at 5, forever", and it certainly does not authorize a standing
// order that runs unattended every two hours. Before this, the agent could
// arm any of those by calling a tool, and the owner found out when it fired.
//
// So a recurring job created by the agent is not armed until the owner
// answers a permission question that NAMES the schedule. The question is an
// owner decision: bypass/YOLO and the remote-autonomy posture must not answer
// it, and an unattended run (nobody to ask) is refused. One-time jobs need no
// extra question — the tool call itself is that one authorization, and the
// scheduler removes them after their one run.

import type { ToolCallContext } from "@ares/core";

export class ScheduleApprovalError extends Error {
  constructor(message: string) {
    super(message);
    // The engine treats this exactly like any owner denial.
    this.name = "PermissionDeniedError";
  }
}

/**
 * Ask the owner to approve a recurring schedule. Resolves when approved;
 * throws a PermissionDeniedError when denied or when there is no one to ask.
 */
export async function requireScheduleApproval(
  ctx: Pick<ToolCallContext, "requestPermission">,
  request: { toolName: string; input: unknown; what: string; schedule: string },
): Promise<void> {
  if (!ctx.requestPermission) {
    throw new ScheduleApprovalError(
      `Refused: a recurring ${request.what} (${request.schedule}) needs the owner's approval of that schedule, and no owner is available to ask. Offer a one-time version, or ask the owner to set it up.`,
    );
  }
  const decision = await ctx.requestPermission({
    toolName: request.toolName,
    input: request.input,
    reason: `Approve a RECURRING ${request.what}: ${request.schedule}. It will keep running on this schedule until cancelled.`,
    suggestion: "deny",
    ownerDecision: true,
  });
  if (decision === "deny") {
    throw new ScheduleApprovalError(
      `The owner did not approve the recurring schedule (${request.schedule}). Nothing was scheduled; do not re-ask or rephrase it as a different schedule.`,
    );
  }
}
