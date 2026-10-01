// Goals — the owner's life goals, with progress Ares keeps current.
//
// Not the Operator's goals (autonomous engineering missions). These are the
// phone's Goals tab: "save $500 a month", "run a 5k by March". The owner picks
// a category, refines it with Ares in chat (or fills in the phone's goal
// sheet), and Ares records it here and updates progress at each check-in.
// Stored at <ARES_HOME>/goals.json, written atomically; the phone reads and
// edits it through /gateway/goals (phoneGoals.ts).
//
// A goal with an agent assigned (agentId) is WORKED: the garrison's goal
// runner (cli/goalRunner.ts) wakes that agent in its own thread when the
// goal's nextCheckIn falls due, and the progress note the agent leaves
// lands in `notes`, the timeline the phone shows.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";

export const GOAL_CATEGORIES = ["health", "relationships", "finance", "career", "interests", "productivity", "other"] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export const GOAL_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type LifeGoalStatus = (typeof GOAL_STATUSES)[number];
export const GOAL_CADENCES = ["daily", "weekly", "monthly"] as const;
export type GoalCadence = (typeof GOAL_CADENCES)[number];
export const CADENCE_MS: Record<GoalCadence, number> = {
  daily: 24 * 3_600_000,
  weekly: 7 * 24 * 3_600_000,
  monthly: 30 * 24 * 3_600_000,
};
export type GoalNoteBy = "owner" | "agent" | "checkin" | "system";
const NOTE_BY: readonly GoalNoteBy[] = ["owner", "agent", "checkin", "system"];

/** One line of a goal's timeline: a progress note, a check-in's result, or a
 *  status change. Oldest first on disk. */
export interface GoalNote {
  id: string;
  at: string;
  text: string;
  by: GoalNoteBy;
  /** Which agent wrote it, for by:"agent" | "checkin". */
  agentId?: string;
  /** 0..1 at the time of the note, when it moved. */
  progress?: number;
  /** The app's idempotency token: a retried note carrying the same one is the same note. */
  clientId?: string;
}

export interface LifeGoal {
  id: string;
  title: string;
  category: GoalCategory;
  status: LifeGoalStatus;
  /** 0..1 */
  progress?: number;
  /** The measurable target in the owner's words, e.g. "$6,000 saved by Dec 31". */
  target?: string;
  /** The plan Ares and the owner agreed, short. */
  plan?: string;
  /** Latest note from a check-in. */
  note?: string;
  nextCheckIn?: string;
  createdAt: string;
  updatedAt: string;
  /** The owner's own description, free text. */
  detail?: string;
  /** When the owner wants it done (ISO). */
  dueAt?: string;
  /** The agent working on it: a persona id, or "ares" for the default assistant.
   *  Absent = nobody works it; the owner (and chat) drive it. */
  agentId?: string;
  /** How often the assigned agent checks in. */
  cadence?: GoalCadence;
  /** The timeline, oldest first, capped at MAX_NOTES. */
  notes?: GoalNote[];
  /** The last scheduled check-in and whether it produced a result. */
  lastCheckIn?: { at: string; ok: boolean; detail?: string };
  checkIns?: number;
  /** Who made it: the owner on the phone, or the agent in chat. */
  createdBy?: "owner" | "agent";
  /** The app's idempotency token for a create that may be retried. */
  clientId?: string;
}

export const MAX_GOAL_TITLE = 200;
export const MAX_GOAL_DETAIL = 2_000;
export const MAX_GOAL_FIELD = 1_500;
export const MAX_GOAL_NOTE = 600;
export const MAX_GOAL_NOTES = 100;

export function goalsPath(home?: string): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "goals.json");
}

const chains = new Map<string, Promise<unknown>>();

// ── Validation ───────────────────────────────────────────────────────────────

export class GoalInputError extends Error {}

function flat(value: unknown, max: number, field: string, opts: { multiline?: boolean } = {}): string {
  if (typeof value !== "string") throw new GoalInputError(`${field} must be text`);
  const text = opts.multiline ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim() : value.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new GoalInputError(`${field} must be at most ${max} characters`);
  return text;
}

function isoOrThrow(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new GoalInputError(`${field} must be a date`);
  const t = Date.parse(value.trim());
  if (!Number.isFinite(t)) throw new GoalInputError(`${field} must be a date`);
  return new Date(t).toISOString();
}

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export interface GoalFields {
  title?: string;
  detail?: string | null;
  category?: GoalCategory;
  dueAt?: string | null;
  target?: string | null;
  plan?: string | null;
  /** null / "" = unassign. */
  agentId?: string | null;
  cadence?: GoalCadence;
  nextCheckIn?: string | null;
  progress?: number | null;
}

/** Validate the editable fields present in `body`. Unknown keys are ignored;
 *  a known key with a bad value throws GoalInputError. */
export function parseGoalFields(body: Record<string, unknown>): GoalFields {
  const out: GoalFields = {};
  if (body.title !== undefined) {
    const title = flat(body.title, MAX_GOAL_TITLE, "title");
    if (!title) throw new GoalInputError("title required");
    out.title = title;
  }
  if (body.detail !== undefined) out.detail = body.detail === null ? null : flat(body.detail, MAX_GOAL_DETAIL, "detail", { multiline: true }) || null;
  if (body.category !== undefined) {
    const category = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
    if (!(GOAL_CATEGORIES as readonly string[]).includes(category)) throw new GoalInputError(`category must be one of: ${GOAL_CATEGORIES.join(", ")}`);
    out.category = category as GoalCategory;
  }
  if (body.dueAt !== undefined) out.dueAt = body.dueAt === null || body.dueAt === "" ? null : isoOrThrow(body.dueAt, "dueAt");
  if (body.target !== undefined) out.target = body.target === null ? null : flat(body.target, 300, "target") || null;
  if (body.plan !== undefined) out.plan = body.plan === null ? null : flat(body.plan, MAX_GOAL_FIELD, "plan", { multiline: true }) || null;
  if (body.agentId !== undefined) {
    if (body.agentId === null || body.agentId === "") out.agentId = null;
    else {
      const id = flat(body.agentId, 80, "agentId");
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new GoalInputError("agentId is not a valid agent id");
      out.agentId = id;
    }
  }
  if (body.cadence !== undefined) {
    if (typeof body.cadence !== "string" || !(GOAL_CADENCES as readonly string[]).includes(body.cadence)) {
      throw new GoalInputError(`cadence must be one of: ${GOAL_CADENCES.join(", ")}`);
    }
    out.cadence = body.cadence as GoalCadence;
  }
  if (body.nextCheckIn !== undefined) out.nextCheckIn = body.nextCheckIn === null || body.nextCheckIn === "" ? null : isoOrThrow(body.nextCheckIn, "nextCheckIn");
  if (body.progress !== undefined) {
    if (body.progress === null) out.progress = null;
    else if (typeof body.progress === "number" && Number.isFinite(body.progress) && body.progress >= 0 && body.progress <= 1) out.progress = body.progress;
    else throw new GoalInputError("progress must be a number from 0 to 1");
  }
  return out;
}

export function parseNoteText(value: unknown): string {
  const text = flat(value, MAX_GOAL_NOTE, "note", { multiline: true });
  if (!text) throw new GoalInputError("note required");
  return text;
}

// ── Pure operations on one goal ──────────────────────────────────────────────

function newGoalId(): string {
  return `g_${randomUUID().slice(0, 8)}`;
}

function newNoteId(): string {
  return `n_${randomUUID().slice(0, 8)}`;
}

/** Append to the timeline (capped, oldest dropped) and keep `note` current. */
export function appendGoalNote(goal: LifeGoal, input: { text: string; by: GoalNoteBy; agentId?: string; progress?: number; clientId?: string }, now: Date): GoalNote {
  const note: GoalNote = {
    id: newNoteId(),
    at: now.toISOString(),
    text: input.text.slice(0, MAX_GOAL_NOTE),
    by: input.by,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.progress !== undefined ? { progress: input.progress } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
  };
  const notes = [...(goal.notes ?? []), note];
  goal.notes = notes.length > MAX_GOAL_NOTES ? notes.slice(notes.length - MAX_GOAL_NOTES) : notes;
  // "note" is the latest word FROM a check-in or the owner; status lines are not.
  if (input.by !== "system") goal.note = note.text.slice(0, 500);
  goal.updatedAt = note.at;
  return note;
}

export interface GoalCreateInput extends GoalFields {
  title: string;
  clientId?: string;
  createdBy?: "owner" | "agent";
}

export function buildGoal(input: GoalCreateInput, now: Date): LifeGoal {
  const at = now.toISOString();
  const goal: LifeGoal = {
    id: newGoalId(),
    title: input.title,
    category: input.category ?? "other",
    status: "active",
    createdAt: at,
    updatedAt: at,
    createdBy: input.createdBy ?? "owner",
  };
  if (input.detail) goal.detail = input.detail;
  if (input.dueAt) goal.dueAt = input.dueAt;
  if (input.target) goal.target = input.target;
  if (input.plan) goal.plan = input.plan;
  if (input.progress !== undefined && input.progress !== null) goal.progress = input.progress;
  if (input.clientId) goal.clientId = input.clientId;
  if (input.agentId) assignAgent(goal, input.agentId, input.cadence, input.nextCheckIn ?? undefined, now);
  else if (input.nextCheckIn) goal.nextCheckIn = input.nextCheckIn;
  appendGoalNote(goal, { text: input.agentId ? "Goal created and handed to an agent" : "Goal created", by: "system" }, now);
  return goal;
}

/** Give a goal to an agent: it checks in on `cadence` starting at `firstAt`
 *  (default: as soon as the runner next looks). */
function assignAgent(goal: LifeGoal, agentId: string, cadence: GoalCadence | undefined, firstAt: string | undefined, now: Date): void {
  goal.agentId = agentId;
  goal.cadence = cadence ?? goal.cadence ?? "daily";
  if (firstAt) goal.nextCheckIn = firstAt;
  else if (!goal.nextCheckIn) goal.nextCheckIn = now.toISOString();
}

/** Apply an edit. Returns the changed field names (for the audit line). */
export function applyGoalPatch(goal: LifeGoal, patch: GoalFields, now: Date): string[] {
  const rec = goal as unknown as Record<string, unknown>;
  const before = { ...rec };
  const set = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) delete rec[key];
    else rec[key] = value;
  };
  set("title", patch.title);
  set("detail", patch.detail);
  set("category", patch.category);
  set("dueAt", patch.dueAt);
  set("target", patch.target);
  set("plan", patch.plan);
  set("progress", patch.progress);
  set("cadence", patch.cadence);
  if (patch.agentId === null) {
    delete rec.agentId;
    // Nobody is going to check in: a stale schedule would only mislead.
    if (before.agentId !== undefined) delete rec.nextCheckIn;
  } else if (patch.agentId !== undefined) {
    assignAgent(goal, patch.agentId, patch.cadence, patch.nextCheckIn ?? undefined, now);
  } else {
    set("nextCheckIn", patch.nextCheckIn);
  }
  const changed = Object.keys({ ...before, ...rec }).filter((key) => key !== "updatedAt" && before[key] !== rec[key]);
  if (changed.length > 0) goal.updatedAt = now.toISOString();
  return changed;
}

export type GoalStatusInput = LifeGoalStatus | "reopen";
export const STATUS_INPUTS: readonly GoalStatusInput[] = [...GOAL_STATUSES, "reopen"];

const STATUS_LINE: Record<LifeGoalStatus, string> = {
  active: "Resumed",
  paused: "Paused",
  done: "Marked done",
  dropped: "Dropped",
};

/** Move a goal between states. Returns false when it is already there. */
export function applyGoalStatus(goal: LifeGoal, input: GoalStatusInput, now: Date): boolean {
  const to: LifeGoalStatus = input === "reopen" ? "active" : input;
  if (goal.status === to) return false;
  const from = goal.status;
  goal.status = to;
  if (to === "done") {
    goal.progress = 1;
    delete goal.nextCheckIn;
  } else if (to === "dropped") {
    delete goal.nextCheckIn;
  } else if (to === "active") {
    // Reopening something finished must not keep claiming 100%.
    if (from === "done" && goal.progress === 1) delete goal.progress;
    if (goal.agentId && (!goal.nextCheckIn || Date.parse(goal.nextCheckIn) < now.getTime())) goal.nextCheckIn = now.toISOString();
  }
  const line = from === "done" || from === "dropped" ? (to === "active" ? "Reopened" : STATUS_LINE[to]) : STATUS_LINE[to];
  appendGoalNote(goal, { text: line, by: "system" }, now);
  return true;
}

export const isOpenGoal = (g: { status: string }): boolean => g.status === "active" || g.status === "paused";

// ── Views ────────────────────────────────────────────────────────────────────

export type GoalSummary = Omit<LifeGoal, "notes" | "clientId"> & { notes: GoalNote[]; noteCount: number };

/** What a list response carries: the timeline's newest few, never the whole
 *  thing (that is GET /gateway/goals/notes, paged). */
export function goalSummary(goal: LifeGoal, keepNotes = 3): GoalSummary {
  const { notes, clientId: _clientId, ...rest } = goal;
  const all = notes ?? [];
  return { ...rest, notes: all.slice(Math.max(0, all.length - keepNotes)), noteCount: all.length };
}

/** A page of the timeline, newest first. `before` is the id (or the ISO `at`) of
 *  the last row of the previous page; an id that has aged out ends the paging
 *  rather than repeating rows. */
export function goalNotesPage(goal: LifeGoal, opts: { limit?: number; before?: string } = {}): { notes: GoalNote[]; total: number; nextBefore?: string } {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 30), 1), 100);
  const all = goal.notes ?? [];
  const newestFirst = [...all].reverse();
  let from = 0;
  if (opts.before) {
    const byId = newestFirst.findIndex((n) => n.id === opts.before);
    if (byId >= 0) from = byId + 1;
    else if (Number.isFinite(Date.parse(opts.before))) {
      const older = newestFirst.findIndex((n) => n.at < opts.before!);
      from = older < 0 ? newestFirst.length : older;
    } else from = newestFirst.length;
  }
  const page = newestFirst.slice(from, from + limit);
  const more = from + limit < newestFirst.length;
  return { notes: page, total: all.length, ...(more && page.length ? { nextBefore: page[page.length - 1]!.id } : {}) };
}

function sanitize(goal: LifeGoal): LifeGoal {
  if (!(GOAL_STATUSES as readonly string[]).includes(goal.status)) goal.status = "active";
  if (goal.notes) goal.notes = goal.notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string" && NOTE_BY.includes(n.by));
  return goal;
}

// ── The store ────────────────────────────────────────────────────────────────

export class GoalsStore {
  readonly file: string;
  constructor(home?: string) {
    this.file = goalsPath(home);
  }

  async load(): Promise<LifeGoal[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { goals?: unknown };
      return Array.isArray(parsed.goals) ? (parsed.goals as LifeGoal[]).filter((g) => g && typeof g.id === "string").map(sanitize) : [];
    } catch {
      return [];
    }
  }

  /** Open goals first (soonest check-in first), then recently finished. */
  async list(): Promise<LifeGoal[]> {
    const goals = await this.load();
    const open = goals.filter(isOpenGoal).sort((a, b) => (a.nextCheckIn ?? "~").localeCompare(b.nextCheckIn ?? "~"));
    const rest = goals.filter((g) => !isOpenGoal(g)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
    return [...open, ...rest];
  }

  async get(id: string): Promise<LifeGoal | undefined> {
    return (await this.load()).find((g) => g.id === id);
  }

  mutate<T>(fn: (goals: LifeGoal[]) => T): Promise<T> {
    const prior = chains.get(this.file) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      const goals = await this.load();
      const result = fn(goals);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, goals }, null, 2) + "\n", "utf8");
      await fs.rename(tmp, this.file);
      return result;
    });
    chains.set(this.file, next);
    return next;
  }

  /** Create a goal. A retried create carrying the same clientId returns the
   *  goal the first one made (`created: false`) instead of a second. */
  create(input: GoalCreateInput, now = new Date()): Promise<{ goal: LifeGoal; created: boolean }> {
    return this.mutate((goals) => {
      if (input.clientId) {
        const same = goals.find((g) => g.clientId === input.clientId);
        if (same) return { goal: { ...same }, created: false };
      }
      const goal = buildGoal(input, now);
      goals.push(goal);
      return { goal: { ...goal }, created: true };
    });
  }

  /** null when no goal has that id. */
  patch(id: string, patch: GoalFields, now = new Date()): Promise<{ goal: LifeGoal; changed: string[] } | null> {
    return this.mutate((goals) => {
      const goal = goals.find((g) => g.id === id);
      if (!goal) return null;
      const changed = applyGoalPatch(goal, patch, now);
      return { goal: { ...goal }, changed };
    });
  }

  setStatus(id: string, status: GoalStatusInput, now = new Date()): Promise<{ goal: LifeGoal; changed: boolean } | null> {
    return this.mutate((goals) => {
      const goal = goals.find((g) => g.id === id);
      if (!goal) return null;
      const changed = applyGoalStatus(goal, status, now);
      return { goal: { ...goal }, changed };
    });
  }

  /** A retried note carrying the same clientId returns the one already written (`created: false`). */
  addNote(id: string, input: { text: string; by: GoalNoteBy; agentId?: string; progress?: number; clientId?: string }, now = new Date()): Promise<{ goal: LifeGoal; note: GoalNote; created: boolean } | null> {
    return this.mutate((goals) => {
      const goal = goals.find((g) => g.id === id);
      if (!goal) return null;
      const same = input.clientId ? (goal.notes ?? []).find((n) => n.clientId === input.clientId) : undefined;
      if (same) return { goal: { ...goal }, note: same, created: false };
      if (input.progress !== undefined) goal.progress = input.progress;
      const note = appendGoalNote(goal, input, now);
      return { goal: { ...goal }, note, created: true };
    });
  }

  /** The removed goal, or null. */
  remove(id: string): Promise<LifeGoal | null> {
    return this.mutate((goals) => {
      const at = goals.findIndex((g) => g.id === id);
      if (at < 0) return null;
      const [removed] = goals.splice(at, 1);
      return removed ?? null;
    });
  }
}

// ── The tool ─────────────────────────────────────────────────────────────────

const inputSchema = z
  .object({
    action: z.enum(["add", "update", "list", "close"]).describe(
      "add: record a goal once it's refined with the owner. update: progress/note/next check-in. list: current goals. close: done or dropped.",
    ),
    id: z.string().optional(),
    title: z.string().max(200).optional().describe("add: the goal in one line, e.g. 'Save $500 a month'."),
    category: z.enum(GOAL_CATEGORIES).optional(),
    target: z.string().max(300).optional(),
    plan: z.string().max(1500).optional(),
    progress: z.number().min(0).max(1).optional().describe("0..1 toward the target."),
    note: z.string().max(500).optional().describe("One or two sentences for the goal's timeline: what you did, what's next."),
    next_check_in: z.string().optional().describe("ISO date/time of the next check-in."),
    status: z.enum(["done", "dropped"]).optional().describe("close: how it ended."),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface GoalsOutput {
  goal?: LifeGoal;
  goals?: LifeGoal[];
  message: string;
}

export const GoalsTool = buildTool<typeof inputSchema, GoalsOutput>({
  name: "Goals",
  description:
    "The owner's life goals shown on their phone's Goals tab (health, relationships, finance, career, interests, productivity). " +
    "After refining a goal with the owner in chat, add it with a measurable target, a short plan and the next check-in; at each check-in update progress (0..1) and a one-line note, which lands on the goal's timeline; close it when done or dropped.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (input) => (input.action === "list" ? "Reviewing goals" : "Updating goals"),
  async call(input: Input): Promise<ToolResult<GoalsOutput>> {
    const store = new GoalsStore();
    const now = new Date();
    const fail = (message: string): ToolResult<GoalsOutput> => ({ output: { message }, display: message, failure: message });
    switch (input.action) {
      case "list": {
        const goals = await store.list();
        const message = goals.length ? goals.map((g) => `${g.title} [${g.status}${g.progress !== undefined ? ` ${Math.round(g.progress * 100)}%` : ""}] (${g.id})`).join("; ") : "No goals yet.";
        return { output: { goals: goals.map((g) => ({ ...g, notes: (g.notes ?? []).slice(-3) })), message }, display: `${goals.length} goal(s)` };
      }
      case "add": {
        if (!input.title?.trim()) return fail("add needs a title.");
        const { goal } = await store.create({
          title: input.title.replace(/\s+/g, " ").trim(),
          category: input.category ?? "other",
          createdBy: "agent",
          ...(input.progress !== undefined ? { progress: input.progress } : {}),
          ...(input.target ? { target: input.target } : {}),
          ...(input.plan ? { plan: input.plan } : {}),
          ...(iso(input.next_check_in) ? { nextCheckIn: iso(input.next_check_in) } : {}),
        }, now);
        if (input.note) await store.addNote(goal.id, { text: input.note, by: "agent" }, now);
        return { output: { goal, message: `Goal added: ${goal.title} (${goal.id}). It's on the owner's Goals tab now.` }, display: `Goal: ${goal.title}` };
      }
      case "update":
      case "close": {
        if (!input.id) return fail(`${input.action} needs an id.`);
        const goal = await store.mutate((goals) => {
          const g = goals.find((x) => x.id === input.id);
          if (!g) return undefined;
          if (input.title) g.title = input.title;
          if (input.category) g.category = input.category;
          if (input.target) g.target = input.target;
          if (input.plan) g.plan = input.plan;
          if (input.progress !== undefined) g.progress = input.progress;
          const next = iso(input.next_check_in);
          if (next) g.nextCheckIn = next;
          if (input.note) appendGoalNote(g, { text: input.note, by: "agent", ...(input.progress !== undefined ? { progress: input.progress } : {}) }, now);
          if (input.action === "close") applyGoalStatus(g, input.status ?? "done", now);
          g.updatedAt = now.toISOString();
          return { ...g };
        });
        if (!goal) return fail(`No goal ${input.id}.`);
        return { output: { goal, message: `${goal.title}: ${goal.status}${goal.progress !== undefined ? `, ${Math.round(goal.progress * 100)}%` : ""}.` }, display: `Goal updated` };
      }
    }
  },
});
