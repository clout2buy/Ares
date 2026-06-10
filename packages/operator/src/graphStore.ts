// Capability graph persistence — one JSON file per node under
// ~/.ares/operator/graph/, plus the writer that turns a crystallized capability
// into a REAL skill on disk (~/.ares/skills/<name>/), so mastery produces an
// executable artifact the existing skill runtime (agent/skills) can run — not
// just a database row. Atomic writes, tolerant reads.

import path from "node:path";
import { promises as fs } from "node:fs";
import { agentPaths, writeFileAtomic } from "@ares/agent";
import { operatorPaths } from "./paths.js";
import type { CapabilityNode } from "./capability.js";

export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "cap"
  );
}

function capFile(home: string, id: string): string {
  return path.join(operatorPaths(home).graphDir, `${slugify(id)}.json`);
}

export async function saveCapability(home: string, node: CapabilityNode): Promise<string> {
  const file = capFile(home, node.id);
  await writeFileAtomic(file, JSON.stringify(node, null, 2) + "\n");
  return file;
}

export async function loadCapability(home: string, id: string): Promise<CapabilityNode | null> {
  try {
    return JSON.parse(await fs.readFile(capFile(home, id), "utf8")) as CapabilityNode;
  } catch {
    return null;
  }
}

export async function listCapabilities(home: string): Promise<CapabilityNode[]> {
  const dir = operatorPaths(home).graphDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const nodes: CapabilityNode[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      nodes.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as CapabilityNode);
    } catch {
      // skip corrupt node
    }
  }
  nodes.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return nodes;
}

/**
 * Write a crystallized capability as a runnable skill under ~/.ares/skills/.
 * This is the line between "documented" and "executable" — the skill runtime
 * can now run what the learning loop just learned.
 */
export async function writeCrystallizedSkill(
  home: string,
  name: string,
  handlerSource: string,
  doc?: string,
): Promise<string> {
  const dir = path.join(agentPaths(home).skillsDir, slugify(name));
  const handler = handlerSource.endsWith("\n") ? handlerSource : handlerSource + "\n";
  await writeFileAtomic(path.join(dir, "handler.js"), handler);
  await writeFileAtomic(
    path.join(dir, "SKILL.md"),
    doc ?? `# ${name}\n\nCrystallized by the Ares learning loop after repeated, reality-verified success.\n`,
  );
  return dir;
}
