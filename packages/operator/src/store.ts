// Goal persistence — one JSON file per goal under ~/.ares/operator/goals/.
//
// Goals outlive the process. Writes are atomic (shared writeFileAtomic); reads
// are tolerant (a corrupt file is skipped, never fatal). This is what makes the
// control loop resume-safe: kill the Operator mid-goal and the next start picks
// up the exact durable state.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@ares/agent";
import { operatorPaths } from "./paths.js";
import type { Goal } from "./types.js";

export function newGoalId(now = new Date()): string {
  return `g_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

function goalFile(home: string, id: string): string {
  return path.join(operatorPaths(home).goalsDir, `${sanitizeId(id)}.json`);
}

export async function saveGoal(home: string, goal: Goal): Promise<string> {
  const file = goalFile(home, goal.id);
  await writeFileAtomic(file, JSON.stringify(goal, null, 2) + "\n");
  return file;
}

export async function loadGoal(home: string, id: string): Promise<Goal | null> {
  try {
    return JSON.parse(await fs.readFile(goalFile(home, id), "utf8")) as Goal;
  } catch {
    return null;
  }
}

export async function listGoals(home: string): Promise<Goal[]> {
  const dir = operatorPaths(home).goalsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goals: Goal[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      goals.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Goal);
    } catch {
      // skip corrupt goal file
    }
  }
  goals.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return goals;
}

/** The goals the control loop should be driving right now. */
export async function activeGoals(home: string): Promise<Goal[]> {
  return (await listGoals(home)).filter((g) => g.status === "active");
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
