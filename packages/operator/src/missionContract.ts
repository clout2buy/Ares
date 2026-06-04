import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { writeFileAtomic } from "@crix/agent";
import { operatorPaths } from "./paths.js";
import type { Goal, VerificationSpec } from "./types.js";

export const MISSION_CONTRACT_SCHEMA_VERSION = 1;

export type MissionContractStatus = "draft" | "active" | "blocked" | "satisfied" | "abandoned";
export type AcceptanceCriterionStatus = "pending" | "met" | "failed";
export type MissionEvidenceKind = "observation" | "verification" | "eval" | "artifact" | "decision";
export type MissionVerificationProbeStatus = "pending" | "passed" | "failed";

export interface AcceptanceCriterion {
  id: string;
  description: string;
  status: AcceptanceCriterionStatus;
  evidenceIds: string[];
}

export interface MissionConstraint {
  id: string;
  description: string;
  required: boolean;
}

export interface MissionEvidence {
  id: string;
  at: string;
  kind: MissionEvidenceKind;
  summary: string;
  detail?: string;
  passed?: boolean;
  criterionIds: string[];
  probe?: VerificationSpec;
}

export interface MissionBlocker {
  id: string;
  at: string;
  reason: string;
  evidenceId?: string;
  resolvedAt?: string;
  resolution?: string;
}

export interface MissionVerificationProbe {
  id: string;
  spec: VerificationSpec;
  status: MissionVerificationProbeStatus;
  summary?: string;
  evidenceId?: string;
  lastRunAt?: string;
  fingerprint?: string;
}

export interface MissionProgressState {
  status: MissionContractStatus;
  completedCriteria: number;
  totalCriteria: number;
  percent: number;
  updatedAt: string;
}

export interface MissionNextAction {
  summary: string;
  reason?: string;
  dueAt?: string;
}

export interface MissionContract {
  schemaVersion: number;
  id: string;
  goalId?: string;
  intent: string;
  acceptanceCriteria: AcceptanceCriterion[];
  constraints: MissionConstraint[];
  verificationProbes: VerificationSpec[];
  verificationProbeResults: MissionVerificationProbe[];
  progress: MissionProgressState;
  blockers: MissionBlocker[];
  nextAction?: MissionNextAction;
  evidenceLog: MissionEvidence[];
  createdAt: string;
  updatedAt: string;
}

export function newMissionContractId(now = new Date()): string {
  return `mc_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

export function createMissionContract(input: {
  id?: string;
  goalId?: string;
  intent: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  verificationProbes?: VerificationSpec[];
  nextAction?: MissionNextAction | string;
  now?: Date;
}): MissionContract {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const intent = input.intent.trim();
  if (!intent) throw new Error("createMissionContract requires intent");
  const contract: MissionContract = {
    schemaVersion: MISSION_CONTRACT_SCHEMA_VERSION,
    id: input.id ?? newMissionContractId(now),
    goalId: input.goalId,
    intent,
    acceptanceCriteria: (input.acceptanceCriteria ?? []).map((description, index) => ({
      id: `ac_${index + 1}`,
      description: description.trim(),
      status: "pending" as const,
      evidenceIds: [],
    })).filter((criterion) => criterion.description),
    constraints: (input.constraints ?? []).map((description, index) => ({
      id: `con_${index + 1}`,
      description: description.trim(),
      required: true,
    })).filter((constraint) => constraint.description),
    verificationProbes: input.verificationProbes ?? [],
    verificationProbeResults: (input.verificationProbes ?? []).map((spec, index) => ({
      id: `vp_${index + 1}`,
      spec,
      status: "pending" as const,
    })),
    progress: { status: "draft", completedCriteria: 0, totalCriteria: 0, percent: 0, updatedAt: at },
    blockers: [],
    nextAction: normalizeNextAction(input.nextAction),
    evidenceLog: [],
    createdAt: at,
    updatedAt: at,
  };
  return refreshMissionProgress(contract, now);
}

export function missionContractFromGoal(
  goal: Goal,
  input: {
    acceptanceCriteria?: string[];
    constraints?: string[];
    verificationProbes?: VerificationSpec[];
    nextAction?: MissionNextAction | string;
    now?: Date;
  } = {},
): MissionContract {
  return createMissionContract({
    goalId: goal.id,
    intent: goal.statement,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    verificationProbes: input.verificationProbes ?? (goal.verification ? [goal.verification] : []),
    nextAction: input.nextAction,
    now: input.now,
  });
}

export function addMissionEvidence(
  contract: MissionContract,
  input: {
    kind?: MissionEvidenceKind;
    summary: string;
    detail?: string;
    passed?: boolean;
    criterionIds?: string[];
    probe?: VerificationSpec;
    now?: Date;
  },
): MissionContract {
  const now = input.now ?? new Date();
  const summary = input.summary.trim();
  if (!summary) throw new Error("addMissionEvidence requires summary");
  const criterionIds = [...new Set(input.criterionIds ?? [])];
  const validCriterionIds = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
  const unknownCriterionIds = criterionIds.filter((id) => !validCriterionIds.has(id));
  if (unknownCriterionIds.length) {
    throw new Error(`unknown mission criterion id(s): ${unknownCriterionIds.join(", ")}`);
  }
  const evidence: MissionEvidence = {
    id: `ev_${randomUUID().slice(0, 8)}`,
    at: now.toISOString(),
    kind: input.kind ?? "observation",
    summary,
    detail: input.detail?.trim() || undefined,
    passed: input.passed,
    criterionIds,
    probe: input.probe,
  };
  const acceptanceCriteria = contract.acceptanceCriteria.map((criterion) => {
    if (!criterionIds.includes(criterion.id)) return criterion;
    const status: AcceptanceCriterionStatus =
      input.passed === false ? "failed" : input.passed === true ? "met" : criterion.status;
    return {
      ...criterion,
      status,
      evidenceIds: [...new Set([...criterion.evidenceIds, evidence.id])],
    };
  });
  return refreshMissionProgress(
    {
      ...contract,
      acceptanceCriteria,
      evidenceLog: [...contract.evidenceLog, evidence],
      updatedAt: evidence.at,
    },
    now,
  );
}

export function addMissionBlocker(
  contract: MissionContract,
  input: { reason: string; evidenceId?: string; now?: Date },
): MissionContract {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!reason) throw new Error("addMissionBlocker requires reason");
  const blocker: MissionBlocker = {
    id: `blk_${randomUUID().slice(0, 8)}`,
    at: now.toISOString(),
    reason,
    evidenceId: input.evidenceId,
  };
  return refreshMissionProgress(
    { ...contract, blockers: [...contract.blockers, blocker], updatedAt: blocker.at },
    now,
  );
}

export function resolveMissionBlocker(
  contract: MissionContract,
  blockerId: string,
  resolution: string,
  now = new Date(),
): MissionContract {
  const resolvedAt = now.toISOString();
  const blockers = contract.blockers.map((blocker) =>
    blocker.id === blockerId
      ? { ...blocker, resolvedAt, resolution: resolution.trim() || "resolved" }
      : blocker,
  );
  return refreshMissionProgress({ ...contract, blockers, updatedAt: resolvedAt }, now);
}

export function setMissionNextAction(
  contract: MissionContract,
  nextAction: MissionNextAction | string | undefined,
  now = new Date(),
): MissionContract {
  return refreshMissionProgress(
    { ...contract, nextAction: normalizeNextAction(nextAction), updatedAt: now.toISOString() },
    now,
  );
}

export function markMissionProbePending(
  contract: MissionContract,
  probe: VerificationSpec,
  now = new Date(),
): MissionContract {
  const at = now.toISOString();
  const results = upsertProbeResult(contract, probe, (result) => ({
    ...result,
    status: "pending",
    lastRunAt: at,
    summary: undefined,
    evidenceId: undefined,
    fingerprint: undefined,
  }));
  return refreshMissionProgress({ ...contract, verificationProbeResults: results, updatedAt: at }, now);
}

export function recordMissionProbeResult(
  contract: MissionContract,
  input: {
    probe: VerificationSpec;
    met: boolean;
    summary: string;
    fingerprint?: string;
    criterionIds?: string[];
    now?: Date;
  },
): MissionContract {
  const now = input.now ?? new Date();
  const withEvidence = addMissionEvidence(contract, {
    kind: "verification",
    summary: input.summary,
    passed: input.met,
    criterionIds: input.met ? input.criterionIds : [],
    probe: input.probe,
    now,
  });
  const evidenceId = withEvidence.evidenceLog[withEvidence.evidenceLog.length - 1]?.id;
  const results = upsertProbeResult(withEvidence, input.probe, (result) => ({
    ...result,
    status: input.met ? "passed" : "failed",
    summary: input.summary,
    evidenceId,
    lastRunAt: now.toISOString(),
    fingerprint: input.fingerprint,
  }));
  return refreshMissionProgress({ ...withEvidence, verificationProbeResults: results }, now);
}

export function missionContractCanComplete(contract: MissionContract): boolean {
  const criteriaMet =
    contract.acceptanceCriteria.length === 0 ||
    contract.acceptanceCriteria.every((criterion) => criterion.status === "met");
  const probes = normalizeProbeResults(contract);
  const probesPassed = probes.length === 0 || probes.every((probe) => probe.status === "passed");
  const noActiveBlockers = contract.blockers.every((blocker) => blocker.resolvedAt);
  return criteriaMet && probesPassed && noActiveBlockers && contract.progress.status !== "abandoned";
}

export function missionContractUnmetRequirements(contract: MissionContract): string[] {
  const requirements: string[] = [];
  for (const criterion of contract.acceptanceCriteria) {
    if (criterion.status !== "met") {
      requirements.push(`${criterion.status} criterion ${criterion.id}: ${criterion.description}`);
    }
  }
  for (const probe of normalizeProbeResults(contract)) {
    if (probe.status !== "passed") {
      requirements.push(`${probe.status} probe ${probe.id}: ${verificationSpecSummary(probe.spec)}${probe.summary ? ` (${probe.summary})` : ""}`);
    }
  }
  for (const blocker of contract.blockers) {
    if (!blocker.resolvedAt) requirements.push(`active blocker ${blocker.id}: ${blocker.reason}`);
  }
  return requirements;
}

export function missionContractNextVerificationAction(contract: MissionContract): string | undefined {
  const probe = normalizeProbeResults(contract).find((item) => item.status !== "passed");
  if (probe) return `run ${verificationSpecSummary(probe.spec)}`;
  const criterion = contract.acceptanceCriteria.find((item) => item.status !== "met");
  if (criterion) return `collect evidence for ${criterion.id}: ${criterion.description}`;
  const blocker = contract.blockers.find((item) => !item.resolvedAt);
  if (blocker) return `resolve blocker ${blocker.id}: ${blocker.reason}`;
  return contract.nextAction?.summary;
}

export function verificationSpecSummary(spec: VerificationSpec): string {
  switch (spec.kind) {
    case "always":
      return `always ${spec.met}${spec.summary ? ` (${spec.summary})` : ""}`;
    case "file":
      return `file ${spec.path}${spec.contains !== undefined ? ` contains ${JSON.stringify(spec.contains)}` : " exists"}`;
    case "command":
      return `command ${[spec.cmd, ...(spec.args ?? [])].join(" ")} exits ${spec.expectExit ?? 0}`;
    case "http":
      return `http ${spec.url} status ${spec.expectStatus ?? 200}${spec.contains !== undefined ? ` contains ${JSON.stringify(spec.contains)}` : ""}`;
  }
}

export function abandonMissionContract(contract: MissionContract, reason: string, now = new Date()): MissionContract {
  const evidence = addMissionEvidence(contract, {
    kind: "decision",
    summary: reason.trim() || "abandoned",
    passed: false,
    now,
  });
  return {
    ...evidence,
    progress: { ...evidence.progress, status: "abandoned", updatedAt: now.toISOString() },
    updatedAt: now.toISOString(),
  };
}

export function missionContractSummary(contract: MissionContract): string {
  const blocked = contract.blockers.filter((blocker) => !blocker.resolvedAt).length;
  const next = contract.nextAction ? ` Next: ${contract.nextAction.summary}` : "";
  const blockers = blocked ? ` ${blocked} blocker(s).` : "";
  return `${contract.progress.status}: ${contract.progress.completedCriteria}/${contract.progress.totalCriteria} criteria (${contract.progress.percent}%).${blockers}${next}`;
}

export async function saveMissionContract(home: string, contract: MissionContract): Promise<string> {
  const file = contractFile(home, contract.id);
  await writeFileAtomic(file, JSON.stringify(contract, null, 2) + "\n");
  return file;
}

export async function loadMissionContract(home: string, id: string): Promise<MissionContract | null> {
  try {
    return normalizeMissionContract(JSON.parse(await fs.readFile(contractFile(home, id), "utf8")) as MissionContract);
  } catch {
    return null;
  }
}

export async function listMissionContracts(home: string): Promise<MissionContract[]> {
  const dir = operatorPaths(home).contractsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const contracts: MissionContract[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      contracts.push(normalizeMissionContract(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as MissionContract));
    } catch {
      // skip corrupt contract
    }
  }
  contracts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return contracts;
}

export function normalizeMissionContract(contract: MissionContract): MissionContract {
  return {
    ...contract,
    schemaVersion: contract.schemaVersion ?? MISSION_CONTRACT_SCHEMA_VERSION,
    verificationProbeResults: normalizeProbeResults(contract),
  };
}

function refreshMissionProgress(contract: MissionContract, now: Date): MissionContract {
  const totalCriteria = contract.acceptanceCriteria.length;
  const completedCriteria = contract.acceptanceCriteria.filter((criterion) => criterion.status === "met").length;
  const activeBlockers = contract.blockers.filter((blocker) => !blocker.resolvedAt).length;
  const anyFailed = contract.acceptanceCriteria.some((criterion) => criterion.status === "failed");
  const status: MissionContractStatus =
    contract.progress.status === "abandoned"
      ? "abandoned"
      : activeBlockers > 0 || anyFailed
        ? "blocked"
        : totalCriteria > 0 && completedCriteria === totalCriteria
          ? "satisfied"
          : "active";
  return {
    ...contract,
    verificationProbeResults: normalizeProbeResults(contract),
    progress: {
      status,
      completedCriteria,
      totalCriteria,
      percent: totalCriteria === 0 ? 0 : Math.round((completedCriteria / totalCriteria) * 100),
      updatedAt: now.toISOString(),
    },
    updatedAt: now.toISOString(),
  };
}

function normalizeProbeResults(contract: MissionContract): MissionVerificationProbe[] {
  const existing = contract.verificationProbeResults ?? [];
  const byKey = new Map(existing.map((result) => [probeKey(result.spec), result]));
  const used = new Set<string>();
  const normalized = contract.verificationProbes.map((spec, index) => {
    const key = probeKey(spec);
    used.add(key);
    const current = byKey.get(probeKey(spec));
    return current ?? { id: `vp_${index + 1}`, spec, status: "pending" as const };
  });
  return [...normalized, ...existing.filter((result) => !used.has(probeKey(result.spec)))];
}

function upsertProbeResult(
  contract: MissionContract,
  probe: VerificationSpec,
  update: (result: MissionVerificationProbe) => MissionVerificationProbe,
): MissionVerificationProbe[] {
  const results = normalizeProbeResults(contract);
  const key = probeKey(probe);
  const index = results.findIndex((result) => probeKey(result.spec) === key);
  if (index >= 0) {
    return results.map((result, itemIndex) => (itemIndex === index ? update(result) : result));
  }
  return [...results, update({ id: `vp_${results.length + 1}`, spec: probe, status: "pending" })];
}

function probeKey(probe: VerificationSpec): string {
  return JSON.stringify(probe);
}

function normalizeNextAction(nextAction: MissionNextAction | string | undefined): MissionNextAction | undefined {
  if (!nextAction) return undefined;
  if (typeof nextAction !== "string") {
    const summary = nextAction.summary.trim();
    return summary ? { ...nextAction, summary } : undefined;
  }
  const summary = nextAction.trim();
  return summary ? { summary } : undefined;
}

function contractFile(home: string, id: string): string {
  return path.join(operatorPaths(home).contractsDir, `${sanitizeId(id)}.json`);
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
