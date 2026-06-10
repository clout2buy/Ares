// The learning loop — how Ares teaches itself (Ares v5 / O4 / concept C4).
//
//   ENCOUNTER → RESEARCH → ATTEMPT → DRILL → CRYSTALLIZE → (FACTOR) → done
//
// Research is the seed skill and universal bootstrap. Attempts accrue
// reality-verified successes; once there are enough (never just one), the
// capability is CRYSTALLIZED into a real skill and FACTORED into reusable
// sub-skills so the next capability inherits them. The `attempt` function does
// the real work for each phase — in production it dispatches a Worker (O1)
// whose success is reality-verified (O3); in tests it's a fake. The loop logic
// is identical either way.

import {
  beginLearning,
  crystallize,
  recordOutcome,
  DEFAULT_MASTERY_SUCCESSES,
  type CapabilityNode,
} from "./capability.js";
import { factor } from "./graph.js";
import { listCapabilities, saveCapability, writeCrystallizedSkill } from "./graphStore.js";

export type LearningPhase = "research" | "attempt" | "drill" | "crystallize" | "done";

/** Pure directive: what the loop should do next for this capability. */
export function nextLearningPhase(node: CapabilityNode, minSuccesses = DEFAULT_MASTERY_SUCCESSES): LearningPhase {
  if (node.status === "forbidden" || node.status === "mastered") return "done";
  if (node.status === "want") return "research";
  if (node.outcomes.ok === 0) return "attempt";
  if (node.outcomes.ok < minSuccesses) return "drill";
  return "crystallize";
}

export interface LearnAttemptResult {
  ok: boolean;
  error?: string;
  /** Produced at the crystallize phase: the runnable skill to persist. */
  skill?: { name: string; handler: string; doc?: string };
  playbookRef?: string;
}

export type LearnEvent =
  | { type: "phase"; capabilityId: string; phase: LearningPhase }
  | { type: "outcome"; capabilityId: string; ok: boolean; ok_total: number }
  | { type: "crystallized"; capabilityId: string; skillRef?: string; factored: number }
  | { type: "mastered"; capabilityId: string };

export interface LearnDeps {
  home: string;
  /** Does the real work for a phase. Production: a reality-verified Worker. */
  attempt: (node: CapabilityNode, phase: LearningPhase) => Promise<LearnAttemptResult>;
  minSuccesses?: number;
  maxAttempts?: number;
  emit?: (event: LearnEvent) => void;
  now?: () => Date;
}

export async function driveLearning(node0: CapabilityNode, deps: LearnDeps): Promise<CapabilityNode> {
  const min = deps.minSuccesses ?? DEFAULT_MASTERY_SUCCESSES;
  const maxAttempts = deps.maxAttempts ?? 30;
  const now = deps.now ?? (() => new Date());
  let node = node0;
  let attempts = 0;

  while (attempts < maxAttempts) {
    const phase = nextLearningPhase(node, min);
    deps.emit?.({ type: "phase", capabilityId: node.id, phase });
    if (phase === "done") break;
    attempts++;

    if (phase === "research") {
      await deps.attempt(node, "research");
      node = beginLearning(node, now());
      await saveCapability(deps.home, node);
      continue;
    }

    if (phase === "attempt" || phase === "drill") {
      const result = await deps.attempt(node, phase);
      node = recordOutcome(node, result.ok, { error: result.error, now: now() });
      deps.emit?.({ type: "outcome", capabilityId: node.id, ok: result.ok, ok_total: node.outcomes.ok });
      await saveCapability(deps.home, node);
      continue;
    }

    // crystallize: write the runnable skill, mark mastered, factor sub-skills.
    const result = await deps.attempt(node, "crystallize");
    let skillRef = node.skillRef;
    if (result.skill) {
      await writeCrystallizedSkill(deps.home, result.skill.name, result.skill.handler, result.skill.doc);
      skillRef = result.skill.name;
    }
    node = crystallize(node, { skillRef, playbookRef: result.playbookRef, minSuccesses: min, now: now() });

    const existing = await listCapabilities(deps.home);
    const created = factor(node, existing, now());
    for (const sub of created) await saveCapability(deps.home, sub);
    await saveCapability(deps.home, node);

    deps.emit?.({ type: "crystallized", capabilityId: node.id, skillRef, factored: created.length });
    deps.emit?.({ type: "mastered", capabilityId: node.id });
  }

  return node;
}
