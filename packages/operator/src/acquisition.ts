// Acquisition — turning "I can't do X yet" into a durable build job (Crix v5 / O4–O5).
//
// When Crix hits a capability it doesn't have, it doesn't shrug or ask for magic
// words: it ACQUIRES. acquireCapability() mints three durable artifacts that
// survive the process dying, then hands them to the Operator's Worker loop:
//
//   1. a capability-graph node (status "learning") — the competence asset,
//   2. a reality-verifiable Goal — what "done" actually means,
//   3. a build packet on disk — the brief the Worker reads to build it.
//
// The Worker (QueryEngineDispatcher) drives the Goal; reality verification (O3)
// decides if it worked; recordOutcome() promotes the node learning → have. This
// is the self-extension loop made concrete: a gap becomes a job becomes a skill.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@crix/agent";
import { operatorPaths } from "./paths.js";
import { createGoal } from "./goal.js";
import { newGoalId, saveGoal } from "./store.js";
import { createCapability, type CapabilityNode } from "./capability.js";
import { saveCapability, slugify } from "./graphStore.js";
import type { Goal, VerificationSpec } from "./types.js";

/** How Crix intends to satisfy the capability — the method ladder, cheapest first. */
export type AcquisitionKind = "skill" | "connector" | "tool" | "mcp" | "script";

export type AcquisitionStatus = "queued" | "building" | "acquired" | "blocked";

export interface Acquisition {
  id: string;
  capabilityName: string;
  capabilityId: string;
  kind: AcquisitionKind;
  goalId: string;
  /** Path to the human/Worker-readable build brief. */
  packetFile: string;
  /** Sub-capabilities this one composes from (graph edges). */
  requires: string[];
  /** Files the Worker is expected to create/modify. */
  targetFiles: string[];
  status: AcquisitionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AcquisitionResult {
  capability: CapabilityNode;
  acquisition: Acquisition;
  goal: Goal;
}

export interface AcquireCapabilityInput {
  home: string;
  capabilityName: string;
  kind?: AcquisitionKind;
  requires?: string[];
  targetFiles?: string[];
  /** What reality must show for the acquisition to count as done (O3). */
  verification?: VerificationSpec;
  now?: Date;
}

function acquisitionFile(home: string, id: string): string {
  return path.join(operatorPaths(home).acquisitionsDir, `${id}.json`);
}

function newAcquisitionId(): string {
  return `acq_${randomUUID().slice(0, 8)}`;
}

/**
 * Acquire a capability Crix doesn't have yet: mint the graph node, a verifiable
 * goal, and a build packet, then persist all three. Pass the result's goal to a
 * QueryEngineDispatcher (via runGoalToCompletion) to actually build it.
 */
export async function acquireCapability(input: AcquireCapabilityInput): Promise<AcquisitionResult> {
  const name = input.capabilityName.trim();
  if (!name) throw new Error("acquireCapability requires a capabilityName");

  const home = input.home;
  const kind: AcquisitionKind = input.kind ?? "skill";
  const requires = (input.requires ?? []).filter(Boolean);
  const targetFiles = (input.targetFiles ?? []).filter(Boolean);
  const at = (input.now ?? new Date()).toISOString();

  // 1. The competence asset, in the durable graph.
  const capabilityId = `${kind}/${slugify(name)}`;
  const capability = createCapability({
    id: capabilityId,
    name,
    requires,
    status: "learning",
    now: input.now,
  });
  await saveCapability(home, capability);

  // 2. The reality-verifiable goal the Worker drives.
  const goal = createGoal({
    id: newGoalId(),
    statement: buildGoalStatement(name, kind, requires, targetFiles),
    verification: input.verification,
  });
  await saveGoal(home, goal);

  // 3. The build packet — the brief the Worker reads.
  const id = newAcquisitionId();
  const packetFile = path.join(operatorPaths(home).acquisitionsDir, `${id}.packet.md`);
  await writeFileAtomic(packetFile, buildPacket({ id, name, kind, capabilityId, goalId: goal.id, requires, targetFiles }));

  const acquisition: Acquisition = {
    id,
    capabilityName: name,
    capabilityId,
    kind,
    goalId: goal.id,
    packetFile,
    requires,
    targetFiles,
    status: "queued",
    createdAt: at,
    updatedAt: at,
  };
  await writeFileAtomic(acquisitionFile(home, id), JSON.stringify(acquisition, null, 2) + "\n");

  return { capability, acquisition, goal };
}

export async function listAcquisitions(home: string): Promise<Acquisition[]> {
  const dir = operatorPaths(home).acquisitionsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Acquisition[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Acquisition);
    } catch {
      // skip corrupt record
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
  return out;
}

function buildGoalStatement(name: string, kind: AcquisitionKind, requires: string[], targetFiles: string[]): string {
  const parts = [`Acquire the "${name}" capability, implemented as a ${kind}.`];
  if (requires.length) parts.push(`Compose it from existing sub-capabilities: ${requires.join(", ")}.`);
  if (targetFiles.length) parts.push(`Expected artifacts: ${targetFiles.join(", ")}.`);
  parts.push("Build the smallest working version, then prove it runs against reality before claiming done.");
  return parts.join(" ");
}

function buildPacket(p: {
  id: string;
  name: string;
  kind: AcquisitionKind;
  capabilityId: string;
  goalId: string;
  requires: string[];
  targetFiles: string[];
}): string {
  return `# Acquisition packet — ${p.name}

- **acquisition**: ${p.id}
- **kind**: ${p.kind}
- **capability id**: ${p.capabilityId}
- **goal id**: ${p.goalId}
- **composes**: ${p.requires.length ? p.requires.join(", ") : "(nothing yet — novel)"}
- **target files**: ${p.targetFiles.length ? p.targetFiles.join(", ") : "(Worker decides)"}

## Brief
Acquire the ability to **${p.name}** as a \`${p.kind}\`. Take the cheapest, most
grounded method that works, escalating only if it must:

1. **Reuse** — can existing sub-capabilities (${p.requires.join(", ") || "none registered"}) already compose this?
2. **CLI / API** — is there a tool already on PATH or an API with creds present?
3. **Skill** — write a \`handler.js\` skill under \`~/.crix/skills/\` and run it.
4. **Tool / connector** — only if a new primitive in \`packages/\` is truly required.

Build the smallest version that works, then **verify against reality** — run it,
read the output, confirm the goal's verification probe passes. Do not claim the
capability is acquired on a hopeful guess.
`;
}
