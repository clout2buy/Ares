import {
  addMissionBlocker,
  markMissionProbePending,
  missionContractCanComplete,
  missionContractFromGoal,
  recordMissionProbeResult,
  saveMissionContract,
  setMissionNextAction,
  loadMissionContract,
  listMissionContracts,
  type MissionContract,
} from "./missionContract.js";
import { saveGoal } from "./store.js";
import { autoEmitLearningCard } from "./learningEmit.js";
import type { Goal, VerificationSpec } from "./types.js";
import type { ProbeResult } from "./probe.js";

export interface GoalMissionAttachment {
  goal: Goal;
  contract: MissionContract;
  created: boolean;
}

export interface EnsureGoalMissionOptions {
  acceptanceCriteria?: string[];
  constraints?: string[];
  verificationProbes?: VerificationSpec[];
  nextAction?: string;
  now?: Date;
}

export async function ensureGoalMissionContract(
  home: string,
  goal: Goal,
  options: EnsureGoalMissionOptions | Date = {},
): Promise<GoalMissionAttachment> {
  const opts = options instanceof Date ? { now: options } : options;
  const now = opts.now ?? new Date();
  const existing = await findMissionContractForGoal(home, goal);
  if (existing) {
    const attachedGoal = attachContractId(goal, existing.id, now);
    if (attachedGoal !== goal) await saveGoal(home, attachedGoal);
    return { goal: attachedGoal, contract: existing, created: false };
  }

  const contract = missionContractFromGoal(goal, {
    acceptanceCriteria: opts.acceptanceCriteria ?? defaultAcceptanceCriteria(goal),
    constraints: opts.constraints,
    verificationProbes: opts.verificationProbes ?? (goal.verification ? [goal.verification] : []),
    nextAction: opts.nextAction ?? "run next operator tick",
    now,
  });
  await saveMissionContract(home, contract);
  const attachedGoal = attachContractId(goal, contract.id, now);
  await saveGoal(home, attachedGoal);
  return { goal: attachedGoal, contract, created: true };
}

export async function markGoalProbePending(
  home: string,
  contract: MissionContract,
  probe: VerificationSpec,
  now = new Date(),
): Promise<MissionContract> {
  const next = markMissionProbePending(contract, probe, now);
  await saveMissionContract(home, next);
  return next;
}

export async function recordGoalProbeResult(
  home: string,
  contract: MissionContract,
  probe: VerificationSpec,
  result: ProbeResult,
  now = new Date(),
): Promise<MissionContract> {
  const criterionIds = result.met ? pendingCriterionIds(contract) : [];
  const next = recordMissionProbeResult(contract, {
    probe,
    met: result.met,
    summary: result.summary,
    fingerprint: result.fingerprint,
    criterionIds,
    now,
  });
  await saveMissionContract(home, next);
  // Reaching all criteria flips the contract to "satisfied" — auto-distill the
  // lesson when that happens (no-op + no I/O while still in progress).
  await autoEmitLearningCard(home, next, { now });
  return next;
}

export async function recordGoalStepProgress(
  home: string,
  contract: MissionContract,
  evidence: string | undefined,
  now = new Date(),
): Promise<MissionContract> {
  const next = setMissionNextAction(
    contract,
    evidence ? { summary: "verify next operator step", reason: evidence.slice(0, 240) } : "verify next operator step",
    now,
  );
  await saveMissionContract(home, next);
  return next;
}

export async function recordGoalBlocker(
  home: string,
  contract: MissionContract,
  reason: string,
  now = new Date(),
): Promise<MissionContract> {
  const next = addMissionBlocker(contract, { reason, now });
  await saveMissionContract(home, next);
  return next;
}

export function goalCanCompleteFromMission(contract: MissionContract): boolean {
  return missionContractCanComplete(contract);
}

async function findMissionContractForGoal(home: string, goal: Goal): Promise<MissionContract | null> {
  for (const id of goal.missionIds) {
    const contract = await loadMissionContract(home, id);
    if (contract) return contract;
  }
  const byGoal = (await listMissionContracts(home)).find((contract) => contract.goalId === goal.id);
  return byGoal ?? null;
}

function attachContractId(goal: Goal, contractId: string, now: Date): Goal {
  if (goal.missionIds.includes(contractId)) return goal;
  return {
    ...goal,
    missionIds: [...goal.missionIds, contractId],
    updatedAt: now.toISOString(),
  };
}

function defaultAcceptanceCriteria(goal: Goal): string[] {
  return goal.verification ? [`Verification passes for goal: ${goal.statement}`] : [];
}

function pendingCriterionIds(contract: MissionContract): string[] {
  const pending = contract.acceptanceCriteria.filter((criterion) => criterion.status !== "met").map((criterion) => criterion.id);
  return pending.length ? pending : contract.acceptanceCriteria.map((criterion) => criterion.id);
}
