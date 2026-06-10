// Mission persistence — one JSON file per mission under ~/.ares/missions/.
//
// Missions outlive sessions so the agent can resume a goal it set days ago.
// Reads are tolerant (a corrupt file is skipped, never fatal); writes are
// atomic via the shared writeFileAtomic helper.

import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { agentPaths, aresAgentHome } from "../paths.js";
import { writeFileAtomic } from "../files.js";
import type { Mission, MissionSummary } from "./types.js";
import { isTerminal, summarize } from "./types.js";

export function newMissionId(now = new Date()): string {
  return `m_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 8)}`;
}

function missionFile(home: string, id: string): string {
  return path.join(agentPaths(home).missionsDir, `${sanitizeId(id)}.json`);
}

export async function saveMission(home: string, mission: Mission): Promise<string> {
  const file = missionFile(home, mission.id);
  await writeFileAtomic(file, JSON.stringify(mission, null, 2) + "\n");
  return file;
}

export async function loadMission(home: string, id: string): Promise<Mission | null> {
  const file = missionFile(home, id);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as Mission;
  } catch {
    return null;
  }
}

export async function listMissions(home: string): Promise<MissionSummary[]> {
  const dir = agentPaths(home).missionsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const missions: Mission[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, name), "utf8");
      missions.push(JSON.parse(raw) as Mission);
    } catch {
      // skip corrupt mission file
    }
  }
  missions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return missions.map(summarize);
}

/**
 * The mission the agent is most likely talking about when no id is given:
 * the most recently updated non-terminal mission. Returns null if there are
 * zero or many candidates that can't be disambiguated.
 */
export async function activeMission(home: string): Promise<Mission | null> {
  const dir = agentPaths(home).missionsDir;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const open: Mission[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Mission;
      if (!isTerminal(m.status)) open.push(m);
    } catch {
      // skip
    }
  }
  if (open.length === 0) return null;
  open.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return open[0];
}

export async function resolveMission(home: string, id?: string): Promise<Mission | null> {
  if (id) return loadMission(aresAgentHome(home), id);
  return activeMission(aresAgentHome(home));
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
