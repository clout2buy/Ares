// Google Tasks — the owner's to-do lists (the ones in Gmail's and Calendar's
// side panel, and the Google Tasks app).
//
// "@default" is the owner's primary list, so "add milk to my list" needs no
// list lookup first. Tasks' `due` is DATE-only (Google discards the time),
// so a bare YYYY-MM-DD is widened to the RFC 3339 midnight the API expects.

import { z } from "zod";
import { buildTool, type ToolResult } from "./_shared.js";
import { GOOGLE_API, googleJson } from "./googleApi.js";

const inputSchema = z.object({
  action: z.enum(["lists", "list", "add", "complete"]).describe(
    "lists: the owner's task lists. list: tasks in a list (default list if list_id omitted). " +
    "add: a new task (title, optional notes and due date). complete: mark a task done.",
  ),
  list_id: z.string().optional().describe("Task list id (default: the owner's primary list)."),
  task_id: z.string().optional().describe("complete: the task's id."),
  title: z.string().optional().describe("add: the task."),
  notes: z.string().optional().describe("add: details."),
  due: z.string().optional().describe("add: due date, YYYY-MM-DD (the time is ignored by Google)."),
  show_completed: z.boolean().optional().describe("list: include completed tasks (default false)."),
});

type Input = z.infer<typeof inputSchema>;

interface Task { id: string; title?: string; notes?: string; due?: string; status?: string; completed?: string }

export interface GoogleTasksOutput {
  lists?: Array<{ id: string; title: string }>;
  tasks?: Array<{ id: string; title: string; due?: string; status?: string; notes?: string }>;
  task?: { id: string; title: string };
  message: string;
}

export function tasksDue(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due.trim()) ? `${due.trim()}T00:00:00.000Z` : new Date(due).toISOString();
}

export const GoogleTasksTool = buildTool<typeof inputSchema, GoogleTasksOutput>({
  name: "GoogleTasks",
  description: "Google Tasks: see the owner's task lists and tasks, add a task (with notes and a due date), or mark one complete. Requires Google connected via Connect.",
  safety: "workspace-write",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (input) => {
    switch (input.action) {
      case "lists": return "Listing task lists";
      case "list": return "Checking tasks";
      case "add": return `Adding task: ${input.title ?? ""}`;
      case "complete": return "Completing a task";
      default: return "Google Tasks";
    }
  },
  async call(input: Input): Promise<ToolResult<GoogleTasksOutput>> {
    const fail = (message: string): ToolResult<GoogleTasksOutput> => ({ output: { message }, display: message });
    const list = encodeURIComponent(input.list_id ?? "@default");
    switch (input.action) {
      case "lists": {
        const data = await googleJson<{ items?: Array<{ id: string; title: string }> }>("Tasks", `${GOOGLE_API.tasks}/users/@me/lists?maxResults=100`);
        const lists = (data.items ?? []).map((l) => ({ id: l.id, title: l.title }));
        return { output: { lists, message: lists.map((l) => `${l.title} [${l.id}]`).join("\n") || "No task lists." }, display: `${lists.length} lists` };
      }
      case "list": {
        const params = new URLSearchParams({ maxResults: "100", showCompleted: String(Boolean(input.show_completed)), showHidden: String(Boolean(input.show_completed)) });
        const data = await googleJson<{ items?: Task[] }>("Tasks", `${GOOGLE_API.tasks}/lists/${list}/tasks?${params}`);
        const tasks = (data.items ?? []).map((t) => ({ id: t.id, title: t.title ?? "", ...(t.due ? { due: t.due.slice(0, 10) } : {}), ...(t.status ? { status: t.status } : {}), ...(t.notes ? { notes: t.notes } : {}) }));
        const lines = tasks.map((t) => `${t.status === "completed" ? "✓" : "○"} ${t.title}${t.due ? ` (due ${t.due})` : ""} [${t.id}]`);
        return { output: { tasks, message: lines.join("\n") || "No open tasks." }, display: `${tasks.length} tasks` };
      }
      case "add": {
        if (!input.title) return fail("title is required for add.");
        const body = { title: input.title, ...(input.notes ? { notes: input.notes } : {}), ...(input.due ? { due: tasksDue(input.due) } : {}) };
        const task = await googleJson<Task>("Tasks", `${GOOGLE_API.tasks}/lists/${list}/tasks`, { method: "POST", body: JSON.stringify(body) });
        return { output: { task: { id: task.id, title: task.title ?? input.title }, message: `Added "${input.title}"${input.due ? ` due ${input.due}` : ""}.` }, display: "Task added" };
      }
      case "complete": {
        if (!input.task_id) return fail("task_id is required for complete.");
        const task = await googleJson<Task>("Tasks", `${GOOGLE_API.tasks}/lists/${list}/tasks/${encodeURIComponent(input.task_id)}`, { method: "PATCH", body: JSON.stringify({ status: "completed" }) });
        return { output: { task: { id: task.id, title: task.title ?? "" }, message: `Completed "${task.title ?? input.task_id}".` }, display: "Task completed" };
      }
      default:
        return fail("Unknown action.");
    }
  },
});
