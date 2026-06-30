// After-action reflection records — the recursive loop, the useful kind.
//
//   a run / commit / CI result
//     → a compact STRUCTURED after-action record (stored, never injected raw)
//     → a deterministic update to the project war map (recentWins / lastGate / next)
//     → future prompts get the updated map, not the transcript.
//
// "Recursive" here is not magic self-evolution; it's a closed loop that turns
// raw events into compact state. Records keep RECEIPTS (commit SHAs, CI status,
// session/rollout paths) so the detail is fetchable — but the model is shown the
// digest, not the landfill. Deterministic for now; a cheap-model summarizer that
// produces these records is the next commit.

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../io.js";
import { stateDir, safeProjectId, inferProjectId, loadProjectState, saveProjectState, type ProjectState } from "./missionState.js";
import type { MemoryFragment } from "./contextCompiler.js";
import type { ReflectionResult, ReflectionSurface } from "./types.js";

export const AFTER_ACTION_SCHEMA = 1;

export type AfterActionResult = "success" | "partial" | "failed";

export interface AfterActionRecord {
  schemaVersion: number;
  /** ISO timestamp; also picks the YYYY-MM-DD storage folder. */
  timestamp: string;
  projectId: string;
  task: string;
  result: AfterActionResult;
  summary: string;
  importantChanges?: string[];
  commits?: string[];
  tests?: string[];
  ciStatus?: string;
  lessons?: string[];
  risks?: string[];
  nextActions?: string[];
  /** Receipts: commit SHAs, CI run url, rollout/session path — fetch detail on demand. */
  sourcePointers?: string[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function afterActionDir(home?: string): string {
  return path.join(stateDir(home), "after-action");
}

function dayOf(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "0000-00-00";
}

/** A stable, sortable, project-scoped filename within a day's folder (so two
 *  projects logging the same task at the same instant don't collide). */
function recordFileName(record: AfterActionRecord): string {
  const time = (record.timestamp.slice(11, 19) || "000000").replace(/[^0-9]/g, "");
  const slug = safeProjectId(record.task).slice(0, 40);
  return `${time}-${safeProjectId(record.projectId)}-${slug || "run"}.json`;
}

// ─── Save / load (graceful) ──────────────────────────────────────────────────

function normalizeRecord(record: AfterActionRecord): AfterActionRecord {
  return {
    ...record,
    schemaVersion: AFTER_ACTION_SCHEMA,
    timestamp: record.timestamp || new Date().toISOString(),
    projectId: safeProjectId(record.projectId),
  };
}

export async function saveAfterAction(record: AfterActionRecord, home?: string): Promise<AfterActionRecord> {
  const normalized = normalizeRecord(record);
  const dir = path.join(afterActionDir(home), dayOf(normalized.timestamp));
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, recordFileName(normalized)), JSON.stringify(normalized, null, 2) + "\n");
  return normalized;
}

/** Most recent after-action records for a project, newest first. Missing dir or
 *  corrupt files are skipped — never throws. */
export async function loadRecentAfterActions(projectId: string, limit = 10, home?: string): Promise<AfterActionRecord[]> {
  const id = safeProjectId(projectId);
  const root = afterActionDir(home);
  const out: AfterActionRecord[] = [];
  let days: string[];
  try {
    days = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  } catch {
    return [];
  }
  for (const day of days) {
    let files: string[];
    try {
      files = await fs.readdir(path.join(root, day));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(path.join(root, day, file), "utf8")) as AfterActionRecord;
        if (rec && typeof rec === "object" && rec.projectId === id && typeof rec.summary === "string") out.push(rec);
      } catch {
        // corrupt/torn file — skip it, the timeline stays usable
      }
    }
  }
  out.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return out.slice(0, Math.max(0, limit));
}

// ─── Deterministic update of the project war map ─────────────────────────────

const WINS_CAP = 8;
const RISKS_CAP = 8;
const NEXT_CAP = 6;
const COMMITS_CAP = 8;

function capList(items: readonly string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = (raw ?? "").trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Fold an after-action record into a project's state. PURE. Only success/partial
 * promote a win and move the gate forward; a FAILED run records risk/lesson but
 * never becomes a win (we don't lie to ourselves in the war map).
 */
export function applyAfterActionToProjectState(project: ProjectState, record: AfterActionRecord): ProjectState {
  const next: ProjectState = { ...project };
  const receipt = record.commits?.[0] ? ` (${record.commits[0]})` : "";

  if (record.result === "success" || record.result === "partial") {
    const win = `${record.summary}${receipt}`.trim();
    next.recentWins = capList([win, ...(project.recentWins ?? [])], WINS_CAP);
    if (record.commits?.length) next.recentCommits = capList([...record.commits, ...(project.recentCommits ?? [])], COMMITS_CAP);
    if (record.ciStatus) next.lastGate = record.ciStatus;
    else if (record.tests?.length) next.lastGate = record.tests[record.tests.length - 1];
    if (record.nextActions?.length) next.nextActions = capList(record.nextActions, NEXT_CAP);
  } else {
    // Failed: log it as risk + lessons, do NOT touch wins / gate / commits.
    const failNote = `Failed: ${record.summary}${receipt}`.trim();
    next.risks = capList([failNote, ...(record.risks ?? []), ...(record.lessons ?? []), ...(project.risks ?? [])], RISKS_CAP);
  }
  return next;
}

/**
 * Save the record AND, on success/partial, fold it into the project packet on
 * disk — the recursive loop's entry point. Returns what was written.
 */
export async function recordAfterAction(
  record: AfterActionRecord,
  home?: string,
): Promise<{ record: AfterActionRecord; project?: ProjectState }> {
  const saved = await saveAfterAction(record, home);
  if (saved.result === "failed") return { record: saved };
  const project = await loadProjectState(saved.projectId, home);
  if (!project) return { record: saved };
  const updated = applyAfterActionToProjectState(project, saved);
  await saveProjectState(updated, home);
  return { record: saved, project: updated };
}

// ─── Deterministic session summarizer + live trigger ────────────────────────

/** Known facts about a finished run — gathered by the caller (git, the gate),
 *  NOT a transcript. The summarizer extracts a record from these, no model. */
export interface RunFacts {
  workspace?: string;
  projectId?: string;
  repo?: string;
  /** What the run was about (a goal, or the commit subject). */
  task?: string;
  result?: AfterActionResult;
  summary?: string;
  commits?: string[];
  changedFiles?: string[];
  tests?: string[];
  ciStatus?: string;
  lessons?: string[];
  risks?: string[];
  nextActions?: string[];
  sourcePointers?: string[];
  timestamp?: string;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * Build a compact after-action record from KNOWN FACTS — deterministic, no model
 * (so memory gets "commit 55b8ebd2 added after-action records, 615/615, CI green",
 * never "the warrior conquered the TypeScript dragon"). A model-based summarizer
 * can produce richer RunFacts later; this is the floor.
 */
export function summarizeRun(facts: RunFacts): AfterActionRecord {
  const result: AfterActionResult = facts.result ?? (facts.commits?.length ? "success" : "partial");
  const task = clip((facts.task ?? facts.summary ?? "work").trim(), 120) || "work";
  const summary = clip((facts.summary ?? task).trim(), 200);
  const changed = facts.changedFiles ?? [];
  const importantChanges = changed.length
    ? [`changed ${changed.length} file(s): ${changed.slice(0, 6).join(", ")}${changed.length > 6 ? ", …" : ""}`]
    : undefined;
  const pointers = capList([...(facts.sourcePointers ?? []), ...(facts.commits ?? [])], 8);
  return {
    schemaVersion: AFTER_ACTION_SCHEMA,
    timestamp: facts.timestamp ?? new Date().toISOString(),
    projectId: safeProjectId(facts.projectId ?? inferProjectId({ repo: facts.repo, path: facts.workspace })),
    task,
    result,
    summary,
    importantChanges,
    commits: facts.commits?.length ? facts.commits : undefined,
    tests: facts.tests?.length ? facts.tests : undefined,
    ciStatus: facts.ciStatus,
    lessons: facts.lessons?.length ? facts.lessons : undefined,
    risks: facts.risks?.length ? facts.risks : undefined,
    nextActions: facts.nextActions?.length ? facts.nextActions : undefined,
    sourcePointers: pointers.length ? pointers : undefined,
  };
}

export interface ReflectOutcome {
  recorded: boolean;
  record?: AfterActionRecord;
  project?: ProjectState;
  /** Why nothing new was written, when recorded === false. */
  skipped?: "duplicate";
}

/**
 * The live trigger: summarize a finished run and fold it in — but never twice for
 * the same commit (a re-fired trigger is a no-op, not duplicate sludge). Returns
 * what happened so a caller can log it; throws nothing it can avoid.
 */
export async function reflectOnRun(facts: RunFacts, home?: string): Promise<ReflectOutcome> {
  const record = summarizeRun(facts);
  const sha = record.commits?.[0];
  if (sha) {
    const recent = await loadRecentAfterActions(record.projectId, 50, home).catch(() => []);
    if (recent.some((r) => r.commits?.includes(sha))) return { recorded: false, skipped: "duplicate" };
  }
  const { record: saved, project } = await recordAfterAction(record, home);
  return { recorded: true, record: saved, project };
}

/** This pass as a {@link ReflectionSurface}: same reflectOnRun(), uniform envelope. */
export const afterActionReflectionSurface: ReflectionSurface<{ facts: RunFacts; home?: string }> = {
  name: "after-action",
  async run({ facts, home }): Promise<ReflectionResult> {
    const outcome = await reflectOnRun(facts, home);
    if (!outcome.recorded || !outcome.record) {
      return { directives: [] };
    }
    const r = outcome.record;
    return {
      directives: [`${r.result}: ${r.summary}`, ...(r.nextActions ?? [])],
      persistedTo: "after-action",
    };
  },
};

// ─── Render (compact; receipts kept, logs never) ─────────────────────────────

const RESULT_GLYPH: Record<AfterActionResult, string> = { success: "✓", partial: "≈", failed: "✗" };

/** A compact recent-timeline fragment — last few records, one terse line each. */
export function renderAfterActionFragment(records: readonly AfterActionRecord[], limit = 5): MemoryFragment | null {
  const recent = records.slice(0, limit);
  if (recent.length === 0) return null;
  const lines = recent.map((r) => {
    const receipt = r.commits?.[0] ?? r.sourcePointers?.[0];
    return `- ${RESULT_GLYPH[r.result] ?? "·"} ${r.summary}${receipt ? ` [${receipt}]` : ""}`;
  });
  return {
    tier: "recent",
    content: `Recent after-action:\n${lines.join("\n")}`,
    score: 0.55,
    source: "after-action",
    project: recent[0].projectId,
  };
}
