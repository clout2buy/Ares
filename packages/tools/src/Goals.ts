// Goals — the owner's life goals, with progress Ares keeps current.
//
// Not the Operator's goals (autonomous engineering missions). These are the
// phone's Goals tab: "save $500 a month", "run a 5k by March". The owner picks
// a category, refines it with Ares in chat, and Ares records it here and
// updates progress at each check-in. Stored at <ARES_HOME>/goals.json,
// written atomically; GET /gateway/goals serves it to the app.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";

export const GOAL_CATEGORIES = ["health", "relationships", "finance", "career", "interests", "productivity", "other"] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];
export type LifeGoalStatus = "active" | "done" | "dropped";

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
}

export function goalsPath(home?: string): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "goals.json");
}

const chains = new Map<string, Promise<unknown>>();

export class GoalsStore {
  readonly file: string;
  constructor(home?: string) {
    this.file = goalsPath(home);
  }

  async load(): Promise<LifeGoal[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { goals?: unknown };
      return Array.isArray(parsed.goals) ? (parsed.goals as LifeGoal[]).filter((g) => g && typeof g.id === "string") : [];
    } catch {
      return [];
    }
  }

  /** Active first (soonest check-in first), then recently finished. */
  async list(): Promise<LifeGoal[]> {
    const goals = await this.load();
    const active = goals.filter((g) => g.status === "active").sort((a, b) => (a.nextCheckIn ?? "~").localeCompare(b.nextCheckIn ?? "~"));
    const rest = goals.filter((g) => g.status !== "active").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
    return [...active, ...rest];
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
}

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
    note: z.string().max(500).optional(),
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

function iso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export const GoalsTool = buildTool<typeof inputSchema, GoalsOutput>({
  name: "Goals",
  description:
    "The owner's life goals shown on their phone's Goals tab (health, relationships, finance, career, interests, productivity). " +
    "After refining a goal with the owner in chat, add it with a measurable target, a short plan and the next check-in; at each check-in update progress (0..1) and a one-line note; close it when done or dropped.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (input) => (input.action === "list" ? "Reviewing goals" : "Updating goals"),
  async call(input: Input): Promise<ToolResult<GoalsOutput>> {
    const store = new GoalsStore();
    const now = new Date().toISOString();
    const fail = (message: string): ToolResult<GoalsOutput> => ({ output: { message }, display: message, failure: message });
    switch (input.action) {
      case "list": {
        const goals = await store.list();
        const message = goals.length ? goals.map((g) => `${g.title} [${g.status}${g.progress !== undefined ? ` ${Math.round(g.progress * 100)}%` : ""}] (${g.id})`).join("; ") : "No goals yet.";
        return { output: { goals, message }, display: `${goals.length} goal(s)` };
      }
      case "add": {
        if (!input.title?.trim()) return fail("add needs a title.");
        const goal: LifeGoal = {
          id: `g_${randomUUID().slice(0, 8)}`,
          title: input.title.trim(),
          category: input.category ?? "other",
          status: "active",
          ...(input.progress !== undefined ? { progress: input.progress } : {}),
          ...(input.target ? { target: input.target } : {}),
          ...(input.plan ? { plan: input.plan } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(iso(input.next_check_in) ? { nextCheckIn: iso(input.next_check_in) } : {}),
          createdAt: now,
          updatedAt: now,
        };
        await store.mutate((goals) => goals.push(goal));
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
          if (input.note) g.note = input.note;
          const next = iso(input.next_check_in);
          if (next) g.nextCheckIn = next;
          if (input.action === "close") {
            g.status = input.status ?? "done";
            if (g.status === "done") g.progress = 1;
            delete g.nextCheckIn;
          }
          g.updatedAt = now;
          return { ...g };
        });
        if (!goal) return fail(`No goal ${input.id}.`);
        return { output: { goal, message: `${goal.title}: ${goal.status}${goal.progress !== undefined ? `, ${Math.round(goal.progress * 100)}%` : ""}.` }, display: `Goal updated` };
      }
    }
  },
});
