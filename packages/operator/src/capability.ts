// Capability nodes — the units of compounding competence (Ares v5 / O4 / C3).
//
// A capability is something Ares can do, composed from reusable sub-skills.
// Mastering a capability factors it into those sub-skills (graph.ts), so the
// NEXT capability mostly reuses what already exists and only has to learn the
// novel delta. The shrinking novel-delta curve is the literal proof that a
// 500-session Ares beats a fresh one on the same model — competence is an asset
// that compounds, and it lives here in the durable graph, not in the model.
//
// Pure transitions only (mirrors agent/mission/loop.ts and operator/goal.ts).

export type CapabilityStatus =
  | "want" // a flagged gap, no method wired yet, not yet started
  | "available" // a real tool/skill backs it and it's wired, but NOT yet reality-verified
  | "learning" // actively acquiring, no verified success yet
  | "have" // works (>=1 verified success), not yet crystallized
  | "mastered" // crystallized into a reusable skill + reliably verified
  | "rotted" // was working, now failing its health check (O13)
  | "forbidden"; // not allowed (ToS/KYC/policy) — distinct from "can't yet"

/**
 * Where a capability node came from. Native dev primitives are the verified
 * floor (seeded mastered). Tool/skill/business nodes are REGISTERED from real
 * code Ares already ships but has not yet PROVEN — they seed `available`, never
 * mastered, so "I can charge money" requires evidence, not a confident JSON row.
 */
export type CapabilitySource = "native" | "tool" | "skill" | "business";

/** A way to satisfy a capability (O5). api > mcp > cli > skill > browser. */
export type MethodKind = "api" | "mcp" | "cli" | "skill" | "browser";

export interface MethodRung {
  kind: MethodKind;
  ref: string; // "stripe", "shopify-mcp", "gh", "make-email", "playwright"
  reliability?: number; // earned over time (O7)
  lastCheckedAt?: string;
}

export interface CapabilityOutcomes {
  ok: number;
  fail: number;
  lastError?: string;
  lastUsedAt?: string;
}

export interface CapabilityNode {
  id: string;
  name: string;
  status: CapabilityStatus;
  /** Sub-skill ids this capability composes from — the DAG edges. */
  requires: string[];
  /** Crystallized executable skill name (under ~/.ares/skills/<skillRef>/). */
  skillRef?: string;
  /** Crystallized judgment (a playbook in durable memory). */
  playbookRef?: string;
  /** Ranked ways to do this capability — the method ladder (O5). */
  methods?: MethodRung[];
  outcomes: CapabilityOutcomes;
  /** Novel sub-skills at first encounter — the data point for the shrink curve. */
  novelDeltaAtBirth?: number;
  /** Coarse area this capability belongs to ("payments", "communications", …). */
  domain?: string;
  /** Provenance — native floor vs registered tool/skill vs business op. */
  source?: CapabilitySource;
  /** Gate side effects (charging money, prod deploys, live email) on a human
   *  ok before the operator may run this unsupervised, regardless of leash. */
  requiresHumanApproval?: boolean;
  /** Evidence ids/summaries justifying this node's status — the durable audit
   *  trail. EMPTY until a real verification event is logged (no proof, no claim). */
  evidence?: string[];
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_MASTERY_SUCCESSES = 3;

export function createCapability(input: {
  id: string;
  name: string;
  requires?: string[];
  status?: CapabilityStatus;
  skillRef?: string;
  novelDeltaAtBirth?: number;
  domain?: string;
  source?: CapabilitySource;
  requiresHumanApproval?: boolean;
  now?: Date;
}): CapabilityNode {
  const at = (input.now ?? new Date()).toISOString();
  const name = input.name.trim();
  if (!name) throw new Error("createCapability requires a name");
  return {
    id: input.id,
    name,
    status: input.status ?? "learning",
    requires: input.requires ?? [],
    skillRef: input.skillRef,
    outcomes: { ok: 0, fail: 0 },
    novelDeltaAtBirth: input.novelDeltaAtBirth,
    domain: input.domain,
    source: input.source,
    requiresHumanApproval: input.requiresHumanApproval,
    evidence: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** want → learning, when research has started the acquisition. */
export function beginLearning(node: CapabilityNode, now = new Date()): CapabilityNode {
  if (node.status !== "want") return node;
  return { ...node, status: "learning", updatedAt: now.toISOString() };
}

/**
 * Record a verified attempt outcome. Reality-verified successes (O3) advance
 * the capability from learning → have; failures stick the last error for O13's
 * immune system. NEVER call this on an unverified worker claim.
 */
export function recordOutcome(
  node: CapabilityNode,
  ok: boolean,
  opts: { error?: string; now?: Date } = {},
): CapabilityNode {
  const at = (opts.now ?? new Date()).toISOString();
  const outcomes: CapabilityOutcomes = {
    ok: node.outcomes.ok + (ok ? 1 : 0),
    fail: node.outcomes.fail + (ok ? 0 : 1),
    lastError: ok ? node.outcomes.lastError : opts.error?.trim() || node.outcomes.lastError,
    lastUsedAt: at,
  };
  // First verified success promotes an unproven capability to "have" — this is
  // the ONLY door from `available` (registered tool) to a reusable building
  // block: reality has to confirm it before the planner may compose on it.
  let status = node.status;
  if (ok && (status === "learning" || status === "want" || status === "available")) status = "have";
  return { ...node, outcomes, status, updatedAt: at };
}

export function reliabilityOf(node: CapabilityNode): number | null {
  const decided = node.outcomes.ok + node.outcomes.fail;
  return decided === 0 ? null : node.outcomes.ok / decided;
}

export function canCrystallize(node: CapabilityNode, minSuccesses = DEFAULT_MASTERY_SUCCESSES): boolean {
  return node.outcomes.ok >= minSuccesses;
}

/**
 * Crystallize verified, REPEATED success into mastery. Refuses on a single
 * lucky run (the O4 gotcha + O13 immune system) — a lesson is only crystallized
 * once reality has confirmed it enough times.
 */
export function crystallize(
  node: CapabilityNode,
  opts: { skillRef?: string; playbookRef?: string; minSuccesses?: number; now?: Date } = {},
): CapabilityNode {
  const min = opts.minSuccesses ?? DEFAULT_MASTERY_SUCCESSES;
  if (node.outcomes.ok < min) {
    throw new Error(`cannot crystallize "${node.name}": needs ${min} verified successes, has ${node.outcomes.ok}`);
  }
  return {
    ...node,
    status: "mastered",
    skillRef: opts.skillRef ?? node.skillRef,
    playbookRef: opts.playbookRef ?? node.playbookRef,
    updatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

/** A capability whose health check now fails (O13) — flag for repair/prune. */
export function markRotted(node: CapabilityNode, reason: string, now = new Date()): CapabilityNode {
  return { ...node, status: "rotted", outcomes: { ...node.outcomes, lastError: reason.trim() || node.outcomes.lastError }, updatedAt: now.toISOString() };
}

export function markForbidden(node: CapabilityNode, reason: string, now = new Date()): CapabilityNode {
  return { ...node, status: "forbidden", outcomes: { ...node.outcomes, lastError: reason.trim() || undefined }, updatedAt: now.toISOString() };
}

/** Present and reusable as a building block for other capabilities. */
export function isReusable(node: CapabilityNode): boolean {
  return node.status === "have" || node.status === "mastered";
}

/** Attach (or refresh) a method rung on the capability's ladder, deduped by kind+ref. */
export function addMethod(node: CapabilityNode, rung: MethodRung, now = new Date()): CapabilityNode {
  const methods = [
    ...(node.methods ?? []).filter((m) => !(m.kind === rung.kind && m.ref === rung.ref)),
    rung,
  ];
  return { ...node, methods, updatedAt: now.toISOString() };
}
