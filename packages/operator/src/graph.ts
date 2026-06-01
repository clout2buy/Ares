// Capability graph math — the compounding engine (Crix v5 / O4 / C3).
//
// The graph is a DAG: capabilities point at the sub-skills they require. The
// two functions that matter:
//   novelDelta — how much of a new capability is genuinely NEW vs. already
//                owned. This is the number that trends DOWN over time.
//   factor     — when a capability is mastered, split out its sub-skills as
//                reusable nodes so future capabilities inherit them.

import { createCapability, isReusable, type CapabilityNode } from "./capability.js";

/** Sub-skill ids already owned (have/mastered) and thus reusable. */
function ownedIds(nodes: readonly CapabilityNode[]): Set<string> {
  return new Set(nodes.filter(isReusable).map((n) => n.id));
}

/**
 * How many of `requires` are NOT yet owned — the work that must be learned
 * fresh. On an empty graph this equals requires.length; as the graph grows it
 * shrinks toward zero. THE metric of getting-smarter-over-time.
 */
export function novelDelta(requires: readonly string[], nodes: readonly CapabilityNode[]): number {
  const owned = ownedIds(nodes);
  return requires.filter((r) => !owned.has(r)).length;
}

/** The sub-skills a new capability can reuse outright. */
export function reusedSubskills(requires: readonly string[], nodes: readonly CapabilityNode[]): string[] {
  const owned = ownedIds(nodes);
  return requires.filter((r) => owned.has(r));
}

/**
 * Factor a freshly mastered capability into its sub-skills: create a reusable,
 * mastered node for each required id that doesn't already exist. Mastering a
 * composite means its components are acquired — so future capabilities that
 * need them see them as already-owned (their novel delta drops).
 */
export function factor(parent: CapabilityNode, nodes: readonly CapabilityNode[], now = new Date()): CapabilityNode[] {
  const present = new Set(nodes.map((n) => n.id));
  const created: CapabilityNode[] = [];
  for (const reqId of parent.requires) {
    if (present.has(reqId)) continue;
    created.push(
      createCapability({
        id: reqId,
        name: reqId,
        requires: [],
        status: "mastered", // acquired as a component of the mastered parent
        now,
      }),
    );
    present.add(reqId);
  }
  return created;
}

/** The novel-delta curve, oldest → newest — the literal smarter-over-time graph. */
export function novelDeltaCurve(nodes: readonly CapabilityNode[]): Array<{ name: string; delta: number; at: string }> {
  return nodes
    .filter((n) => n.novelDeltaAtBirth !== undefined)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((n) => ({ name: n.name, delta: n.novelDeltaAtBirth as number, at: n.createdAt }));
}
