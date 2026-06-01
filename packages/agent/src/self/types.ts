// The self-model — Crix's structured, machine-readable picture of itself.
//
// Until now Crix could *act* on itself (SelfEvolve, SkillCraft, RunSkill,
// Mission) but could not *know* itself: CAPABILITIES.md was freeform prose it
// could not reason over. This model turns "what can I do, how well, and what
// should I become next" from a vibe into queryable data. Every capability the
// agent has or wants is a node; every time it acts, the outcome is recorded
// against that node. Reflection (see reflect.ts) reasons over this graph.

export type CapabilityKind = "skill" | "tool" | "package" | "mission";

export type CapabilityStatus = "have" | "want" | "acquiring" | "removed";

export interface CapabilityOutcomes {
  runs: number;
  ok: number;
  fail: number;
  avgMs: number;
  lastMs?: number;
  lastError?: string;
  lastUsedAt?: string;
}

export interface Capability {
  id: string;
  name: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  provenance?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  outcomes: CapabilityOutcomes;
  tags?: string[];
}

export interface SelfModel {
  version: 1;
  updatedAt: string;
  capabilities: Record<string, Capability>;
}

export interface CapabilityReliability {
  id: string;
  name: string;
  reliability: number; // 0..1 over runs with an outcome
  runs: number;
  lastError?: string;
}

export interface SelfSummary {
  total: number;
  have: number;
  want: number;
  acquiring: number;
  skills: number;
  totalRuns: number;
  reliability: number | null; // overall ok / (ok + fail); null if no runs yet
  topReliable: CapabilityReliability[];
  flaky: CapabilityReliability[];
}

export function emptyOutcomes(): CapabilityOutcomes {
  return { runs: 0, ok: 0, fail: 0, avgMs: 0 };
}

/** ok / (ok + fail) over runs that produced a pass/fail, or null if none. */
export function reliabilityOf(o: CapabilityOutcomes): number | null {
  const decided = o.ok + o.fail;
  if (decided === 0) return null;
  return o.ok / decided;
}
