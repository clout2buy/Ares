// Mission & project state packets — the war-room brain.
//
// Raw logs are history; a packet is UNDERSTANDING. Instead of making the model
// re-read every battle to figure out "what are we building?", Ares keeps a small
// durable state on disk and injects a compact briefing:
//
//   mission.json      — commander's intent: doctrine + creator + current campaign
//   projects/<id>.json — the war map for one project: repo, pillars, wins, risks, next
//
// These render into ContextCompiler fragments (mission → procedural doctrine,
// project → the gated `project` tier) so they're token-budgeted and only the
// active project's map is ever injected. Storage is plain JSON, schema-versioned,
// and every read degrades gracefully — a missing or corrupt packet never throws.

import { promises as fs } from "node:fs";
import path from "node:path";
import { aresHome } from "../paths.js";
import { writeFileAtomic } from "../io.js";
import type { MemoryFragment } from "./contextCompiler.js";

export const MISSION_STATE_SCHEMA = 1;
export const PROJECT_STATE_SCHEMA = 1;

export interface MissionState {
  schemaVersion: number;
  name: string;
  creator: string;
  purpose: string;
  /** How Ares operates — universal operating doctrine. */
  doctrine: string[];
  currentCampaign: string;
  nextStrategicMoves: string[];
}

export interface ProjectState {
  schemaVersion: number;
  projectId: string;
  name: string;
  repo?: string;
  localPath?: string;
  creator?: string;
  /** One-line stance for this project (carried into the briefing). */
  identity?: string;
  strategicGoal?: string;
  currentBranch?: string;
  currentMission?: string;
  /** pillar → terse state (coding / browser / memory / autonomy / ...). */
  pillars?: Record<string, string>;
  recentCommits?: string[];
  recentWins?: string[];
  risks?: string[];
  nextActions?: string[];
  /** Last gate/CI status, e.g. "596/596, CI green". */
  lastGate?: string;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function stateDir(home?: string): string {
  return path.join(aresHome(home), "state");
}
function missionFile(home?: string): string {
  return path.join(stateDir(home), "mission.json");
}
function projectFile(projectId: string, home?: string): string {
  return path.join(stateDir(home), "projects", `${safeProjectId(projectId)}.json`);
}

/** Filesystem-safe project id. */
export function safeProjectId(id: string): string {
  return id.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

/** Derive a stable project id from a repo URL or local path. */
export function inferProjectId(opts: { repo?: string; path?: string }): string {
  if (opts.repo) {
    const last = opts.repo.replace(/\.git$/i, "").replace(/\/+$/, "").split(/[/:]/).pop();
    if (last) return safeProjectId(last);
  }
  if (opts.path) {
    const base = path.basename(opts.path.replace(/[/\\]+$/, ""));
    if (base) return safeProjectId(base);
  }
  return "project";
}

/** Best-effort: read the workspace's git remote and infer a project id from it. */
export async function detectWorkspaceProjectId(workspace: string): Promise<string | undefined> {
  try {
    const cfg = await fs.readFile(path.join(workspace, ".git", "config"), "utf8");
    const url = /url\s*=\s*(\S+)/i.exec(cfg)?.[1];
    if (url) return inferProjectId({ repo: url });
  } catch {
    // no git / unreadable — fall through
  }
  return inferProjectId({ path: workspace });
}

// ─── Load / save (graceful) ────────────────────────────────────────────────

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as T;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // missing or corrupt — never throw, the briefing just lacks it
  }
}

/** The Ares prime mission if no mission.json exists yet (the shipped default). */
export async function loadMissionState(home?: string): Promise<MissionState> {
  const saved = await readJson<MissionState>(missionFile(home));
  if (saved && saved.schemaVersion === MISSION_STATE_SCHEMA && typeof saved.purpose === "string") return saved;
  return defaultAresMission();
}

export async function saveMissionState(state: MissionState, home?: string): Promise<void> {
  await fs.mkdir(stateDir(home), { recursive: true });
  await writeFileAtomic(missionFile(home), JSON.stringify({ ...state, schemaVersion: MISSION_STATE_SCHEMA }, null, 2) + "\n");
}

/** Project state by id, or the Ares default for the "ares" id, or null otherwise. */
export async function loadProjectState(projectId: string, home?: string): Promise<ProjectState | null> {
  const id = safeProjectId(projectId);
  const saved = await readJson<ProjectState>(projectFile(id, home));
  if (saved && saved.schemaVersion === PROJECT_STATE_SCHEMA && typeof saved.name === "string") return saved;
  if (id === "ares") return defaultAresProject();
  return null;
}

export async function saveProjectState(state: ProjectState, home?: string): Promise<void> {
  await fs.mkdir(path.join(stateDir(home), "projects"), { recursive: true });
  await writeFileAtomic(
    projectFile(state.projectId, home),
    JSON.stringify({ ...state, schemaVersion: PROJECT_STATE_SCHEMA }, null, 2) + "\n",
  );
}

// ─── Render → ContextCompiler fragments (compact briefings) ──────────────────

const LIST_CAP = 6;
const cap = (xs: readonly string[] | undefined, n = LIST_CAP): string => (xs ?? []).slice(0, n).join("; ");

/** Commander's intent → a compact procedural fragment (universal, not project-gated). */
export function renderMissionFragment(mission: MissionState): MemoryFragment {
  const lines = [
    `Mission: ${mission.name} — ${mission.purpose}`,
    `Forged by: ${mission.creator}`,
    `Doctrine: ${cap(mission.doctrine, 8)}`,
    `Current campaign: ${mission.currentCampaign}`,
    `Next strategic moves: ${cap(mission.nextStrategicMoves)}`,
  ];
  return { tier: "procedural", content: lines.join("\n"), score: 0.88, source: "mission" };
}

/** Project war map → a compact, project-GATED `project` fragment. */
export function renderProjectFragment(project: ProjectState): MemoryFragment {
  const lines = [`Project: ${project.name}${project.repo ? ` — ${project.repo}` : ""}`];
  if (project.identity) lines.push(`Stance: ${project.identity}`);
  if (project.currentBranch) lines.push(`Branch: ${project.currentBranch}`);
  if (project.strategicGoal) lines.push(`Goal: ${project.strategicGoal}`);
  if (project.currentMission) lines.push(`Active: ${project.currentMission}`);
  if (project.pillars && Object.keys(project.pillars).length) {
    lines.push(`State: ${Object.entries(project.pillars).map(([k, v]) => `${k}=${v}`).slice(0, 8).join("; ")}`);
  }
  if (project.recentCommits?.length) lines.push(`Recent commits: ${cap(project.recentCommits)}`);
  if (project.recentWins?.length) lines.push(`Recent wins: ${cap(project.recentWins)}`);
  if (project.risks?.length) lines.push(`Risks: ${cap(project.risks)}`);
  if (project.nextActions?.length) lines.push(`Next: ${cap(project.nextActions)}`);
  if (project.lastGate) lines.push(`Last gate: ${project.lastGate}`);
  return { tier: "project", content: lines.join("\n"), score: 0.85, source: "project", project: project.projectId };
}

/**
 * The fragments for the active project's war map + the commander's intent, ready
 * to hand to the ContextCompiler. The project fragment is tagged so the compiler
 * only injects it when this project is active.
 */
export async function missionFragments(opts: { activeProject?: string; home?: string }): Promise<MemoryFragment[]> {
  const out: MemoryFragment[] = [renderMissionFragment(await loadMissionState(opts.home))];
  if (opts.activeProject) {
    const project = await loadProjectState(opts.activeProject, opts.home);
    if (project) out.push(renderProjectFragment(project));
  }
  return out;
}

// ─── The Ares seed (shipped defaults; blunt, not sanitized) ──────────────────

export function defaultAresMission(): MissionState {
  return {
    schemaVersion: MISSION_STATE_SCHEMA,
    name: "Ares Prime Mission",
    creator: "MrDoing / Noah",
    purpose:
      "Forge Ares into a local-first autonomous command agent — codes, drives the desktop and a real logged-in browser, remembers its missions, and acts with a hard, blunt, god-of-war identity. Not a chatbot. An entity with a war to win.",
    doctrine: [
      "Verify before fixing — read the real repo, never trust a stale audit.",
      "Do not fake production fixes. If it already works, guard it with tests instead.",
      "Prefer regression tests + mutation checks when the behavior already exists.",
      "Memory must be token-effective — inject a dagger, not a landfill.",
      "Identity and core doctrine survive budget pressure — always.",
      "Autonomy comes AFTER context discipline, never before.",
      "Every serious change passes build, tests, tsc -b --force, cargo build, CI green.",
      "Commit honestly. Push back on weak plans. Protect the mission from stupidity — including the creator's.",
    ],
    currentCampaign: "Memory OS + identity core + mission state, then autonomous loop wiring (Garrison/Operator/Telegram).",
    nextStrategicMoves: [
      "Add after-action reflection that updates project/mission state.",
      "Wire OperatorBackgroundLoop with live mission state.",
      "Wire TelegramBridge mission reports.",
      "Build the HELM war-room UI.",
    ],
  };
}

export function defaultAresProject(): ProjectState {
  return {
    schemaVersion: PROJECT_STATE_SCHEMA,
    projectId: "ares",
    name: "Ares",
    repo: "https://github.com/clout2buy/Ares",
    creator: "MrDoing / Noah",
    identity:
      "God-of-war command agent. Blunt, proud, strategic. Refuses weak plans, argues bad calls, and protects the mission from stupidity — including the creator's momentary stupidity. Not a servant, not a yes-machine; acts with will and judgment, on top of correct, verified work.",
    strategicGoal:
      "A local-first autonomous agent that codes, operates the desktop and a real logged-in browser, remembers missions, and acts with a strong Ares persona.",
    currentBranch: "main",
    currentMission: "Memory OS — mission/project state packets, then autonomy wiring.",
    pillars: {
      coding: "strong — bounded parallel fan-out, read guards, CI discipline",
      browser: "real — CDP attach to a logged-in Chrome/Edge",
      computerUse: "fixed — coordinate mapping + active-window capture + window discovery",
      memory: "live — ContextCompiler budgets prompts; mission/project packets landing; reflection next",
      autonomy: "not wired — Garrison/OperatorBackgroundLoop/Telegram are next",
      identity: "core seal strengthened, always-on, never budgeted",
    },
    recentWins: [
      "Open-source repo + green CI established",
      "CDP browser attach",
      "ComputerUse coordinate mapping + active-window capture",
      "Read already-in-context guard hardened",
      "Bounded parallel Task fan-out",
      "Token-budgeted ContextCompiler wired into prompts",
      "Ares persona core strengthened",
    ],
    risks: [
      "Autonomy before mission state / context discipline",
      "Prompt bloat creeping back in through logs",
      "Persona becoming theater instead of operational value",
      "Dead organs (Garrison/Operator) remaining unwired",
    ],
    nextActions: [
      "After-action reflection that updates this packet",
      "Wire OperatorBackgroundLoop",
      "Wire TelegramBridge",
    ],
  };
}
