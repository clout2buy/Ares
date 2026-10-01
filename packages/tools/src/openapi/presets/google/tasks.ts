// Google Tasks API v1 operations of the Google preset. Curated from the discovery
// document https://tasks.googleapis.com/$discovery/rest?version=v1 (fetched 2026-09-30).
// Host https://tasks.googleapis.com. The task-list collection is /tasks/v1/users/@me/lists;
// tasks live under /tasks/v1/lists/{tasklist}/tasks.

import { JSON_BODY, bool, del, get, int, obj, p, patch, post, str, type JsonObject, type OpRow } from "../_kit.js";
import { HOST, pageToken } from "./_common.js";

const server = HOST.tasks;
const list = (): JsonObject => p("tasklist", "path", str("Task list id from tasksListTaskLists (the default list is also reachable as @default)"));
const task = (): JsonObject => p("task", "path", str("Task id from tasksListTasks"));

const TASK = {
  title: str("What to do"),
  notes: str("Details"),
  due: str("Due date as RFC 3339, e.g. 2026-10-02T00:00:00.000Z (Tasks keeps only the date)"),
  status: str("needsAction or completed (completing sets the completed time)", { enum: ["needsAction", "completed"] }),
} as Record<string, JsonObject>;

export const tasksOps: OpRow[] = [
  get(
    "/tasks/v1/users/@me/lists",
    "tasksListTaskLists",
    "The owner's task lists (id and title)",
    [p("maxResults", "query", int("How many (default 1000)")), pageToken()],
    {
      server,
      tags: ["tasks"],
      keywords: ["my task lists", "my to-do lists"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" },
      vendor: "GET /tasks/v1/users/@me/lists",
    },
  ),
  get(
    "/tasks/v1/lists/{tasklist}/tasks",
    "tasksListTasks",
    "Tasks of one list: title, notes, due date, status. Completed ones are hidden unless showCompleted and showHidden are both true",
    [
      list(),
      p("showCompleted", "query", bool("Include completed tasks (needs showHidden=true as well)")),
      p("showHidden", "query", bool("Include hidden (completed and cleared) tasks")),
      p("dueMin", "query", str("Only tasks due after this RFC 3339 time")),
      p("dueMax", "query", str("Only tasks due before this RFC 3339 time")),
      p("updatedMin", "query", str("Only tasks changed after this RFC 3339 time")),
      p("maxResults", "query", int("How many (default 20, max 100)")),
      pageToken(),
    ],
    {
      server,
      tags: ["tasks"],
      keywords: ["my tasks", "my to-do list", "what do I need to do", "open tasks", "tasks due today", "my reminders"],
      paginate: { style: "token", param: "pageToken", next: "nextPageToken", items: "items", limitParam: "maxResults" },
      vendor: "GET /tasks/v1/lists/{tasklist}/tasks",
    },
  ),
  get("/tasks/v1/lists/{tasklist}/tasks/{task}", "tasksGetTask", "One task with its notes, due date, parent and links", [list(), task()], {
    server,
    tags: ["tasks"],
    vendor: "GET /tasks/v1/lists/{tasklist}/tasks/{task}",
  }),

  // ── changes ──
  post("/tasks/v1/lists/{tasklist}/tasks", "tasksCreateTask", "Add a task to a list (parent makes it a subtask); asks the owner", [list(), p("parent", "query", str("Make it a subtask of this task id")), p("previous", "query", str("Place it after this sibling task id"))], {
    server,
    tags: ["tasks"],
    risk: "write",
    keywords: ["add a task", "add to my to-do list", "remind me to", "create a task"],
    vendor: "POST /tasks/v1/lists/{tasklist}/tasks",
    body: JSON_BODY(obj("The task", TASK, ["title"])),
  }),
  patch("/tasks/v1/lists/{tasklist}/tasks/{task}", "tasksUpdateTask", "Change a task's title, notes, due date or status (status completed ticks it off); asks the owner", [list(), task()], {
    server,
    tags: ["tasks"],
    risk: "write",
    keywords: ["mark the task done", "complete the task", "tick off", "change the due date", "rename the task"],
    vendor: "PATCH /tasks/v1/lists/{tasklist}/tasks/{task}",
    body: JSON_BODY(obj("The fields to change", TASK)),
  }),
  post(
    "/tasks/v1/lists/{tasklist}/tasks/{task}/move",
    "tasksMoveTask",
    "Reorder a task, make it a subtask, or move it to another list; asks the owner",
    [list(), task(), p("parent", "query", str("New parent task id (omit for top level)")), p("previous", "query", str("New previous sibling task id (omit for first)")), p("destinationTasklist", "query", str("Move into this other list"))],
    { server, tags: ["tasks"], risk: "write", keywords: ["move the task to another list", "reorder tasks"], vendor: "POST /tasks/v1/lists/{tasklist}/tasks/{task}/move" },
  ),
  post("/tasks/v1/users/@me/lists", "tasksCreateTaskList", "Create a task list; asks the owner", [], {
    server,
    tags: ["tasks"],
    risk: "write",
    keywords: ["new task list", "create a to-do list"],
    vendor: "POST /tasks/v1/users/@me/lists",
    body: JSON_BODY(obj("The list", { title: str("The list's name") }, ["title"])),
  }),
  del("/tasks/v1/lists/{tasklist}/tasks/{task}", "tasksDeleteTask", "Delete a task; the owner decides", [list(), task()], {
    server,
    tags: ["tasks"],
    keywords: ["delete the task", "remove the task"],
    vendor: "DELETE /tasks/v1/lists/{tasklist}/tasks/{task}",
  }),
  post("/tasks/v1/lists/{tasklist}/clear", "tasksClearCompleted", "Hide every completed task of a list (clears them from view); the owner decides", [list()], {
    server,
    tags: ["tasks"],
    risk: "destructive",
    keywords: ["clear completed tasks"],
    vendor: "POST /tasks/v1/lists/{tasklist}/clear",
  }),
  del("/tasks/v1/users/@me/lists/{tasklist}", "tasksDeleteTaskList", "Delete a whole task list and its tasks; the owner decides", [list()], {
    server,
    tags: ["tasks"],
    keywords: ["delete the list"],
    vendor: "DELETE /tasks/v1/users/@me/lists/{tasklist}",
  }),
];
