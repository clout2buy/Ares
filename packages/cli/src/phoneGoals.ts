// /gateway/goals — the phone's Goals tab, now able to create, edit, finish,
// pause and delete goals, to leave a progress note, and to ask the assigned
// agent to check in right now.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check (via
// the phoneApi.goals hook), so every route is owner-only. Shapes (the app is
// built against these):
//
//   GET  /gateway/goals
//        200 {goals:[Goal…], agents:[{id,name}], canRun:boolean}
//        Goal = {id,title,category,status:"active"|"paused"|"done"|"dropped",
//                progress?,target?,plan?,note?,nextCheckIn?,createdAt,updatedAt,
//                detail?,dueAt?,agentId?,agentName?,cadence?,lastCheckIn?,checkIns?,
//                running?,notes:[GoalNote…newest 3],noteCount}
//        Open goals first (soonest check-in first), then the 30 newest finished.
//   POST /gateway/goals               {title,detail?,category?,dueAt?,agentId?,cadence?,
//                                      nextCheckIn?,target?,plan?,clientId?}
//        201 {goal} · 200 {goal,duplicate:true} for a clientId already created
//        400 invalid field · unknown agent
//   POST /gateway/goals/update        {id, ...any of the create fields (null clears)}
//        200 {goal} · 400 · 404 unknown goal
//   POST /gateway/goals/status        {id, status:"active"|"paused"|"done"|"dropped"|"reopen"}
//        200 {goal} · 400 · 404
//   POST /gateway/goals/close         {id, status?:"done"|"dropped"}   (the original route)
//        200 {ok:true,goal} · 404
//   POST /gateway/goals/note          {id, text, progress?, clientId?}
//        200 {goal,note} · 200 {goal,note,duplicate:true} for a clientId already noted · 400 · 404
//   POST /gateway/goals/delete        {id}
//        200 {ok:true} · 404
//   GET  /gateway/goals/notes?id=&limit=&before=
//        200 {notes:[GoalNote…] newest first, total, nextBefore?} · 404
//        `before` is the id of the last row already shown.
//   POST /gateway/goals/checkin       {id}
//        202 {started:true} · 404 · 409 {error,reason} (no agent, not active, busy,
//        paused, already running) · 501 when this box cannot run goals
//
// Every change lands in the audit trail (actor "owner", action goal.*).
// All the garrison coupling arrives as hooks so this is testable with fakes.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GoalInputError,
  GoalsStore,
  STATUS_INPUTS,
  goalNotesPage,
  goalSummary,
  parseGoalFields,
  parseNoteText,
  type GoalFields,
  type GoalStatusInput,
  type LifeGoal,
} from "@ares/tools";

export interface GoalAgent {
  id: string;
  name: string;
}

export type CheckInRefusal = "unknown" | "no-agent" | "not-active" | "busy" | "paused" | "running" | "no-thread";

export interface GoalsApiDeps {
  home?: string;
  /** Who can be assigned a goal: the default "ares" plus the owner's personas. */
  agents: () => GoalAgent[];
  /** The goal runner, when this garrison runs one. Absent: goals can be kept
   *  here but nothing wakes an agent for them. */
  runner?: {
    /** Claim and start one check-in now; resolves once it is underway. */
    checkInNow(id: string): Promise<{ started: true } | { started: false; reason: CheckInRefusal }>;
    isRunning(id: string): boolean;
  };
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => void;
  log?: (line: string) => void;
  now?: () => Date;
}

class BadRequest extends Error {}

async function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new BadRequest("body must be JSON"); }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

const GOAL_ROUTES = new Set([
  "GET /gateway/goals",
  "POST /gateway/goals",
  "POST /gateway/goals/update",
  "POST /gateway/goals/status",
  "POST /gateway/goals/close",
  "POST /gateway/goals/note",
  "POST /gateway/goals/delete",
  "GET /gateway/goals/notes",
  "POST /gateway/goals/checkin",
]);

const REFUSAL_TEXT: Record<CheckInRefusal, string> = {
  unknown: "unknown goal",
  "no-agent": "assign an agent to this goal first",
  "not-active": "only an active goal can be checked in on",
  busy: "that agent is in the middle of a conversation; try again in a moment",
  paused: "Ares is paused",
  running: "a check-in is already running for this goal",
  "no-thread": "that agent has no conversation yet; open it once first",
};

export function createGoalsApi(deps: GoalsApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const store = new GoalsStore(deps.home);
  const audit = (action: string, target: string | undefined, params: unknown, result = "ok") => {
    try { deps.audit?.({ actor: "owner", action, ...(target ? { target } : {}), ...(params !== undefined ? { params } : {}), result }); } catch { /* an observer never breaks a route */ }
  };

  const nameOf = (id: string | undefined): string | undefined => (id ? deps.agents().find((a) => a.id === id)?.name : undefined);
  const view = (goal: LifeGoal, keepNotes = 3) => {
    const summary = goalSummary(goal, keepNotes);
    const agentName = nameOf(goal.agentId);
    const running = goal.agentId ? deps.runner?.isRunning(goal.id) === true : false;
    return { ...summary, ...(agentName ? { agentName } : {}), ...(running ? { running: true } : {}) };
  };
  const knownAgent = (id: string): boolean => deps.agents().some((a) => a.id === id);

  return async (req, res, url) => {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (!GOAL_ROUTES.has(route)) return false;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (route === "GET /gateway/goals") {
        const goals = await store.list();
        json(200, { goals: goals.map((g) => view(g)), agents: deps.agents(), canRun: deps.runner !== undefined });
        return true;
      }

      if (route === "GET /gateway/goals/notes") {
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!id) { json(400, { error: "id required" }); return true; }
        const goal = await store.get(id);
        if (!goal) { json(404, { error: "unknown goal" }); return true; }
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const before = (url.searchParams.get("before") ?? "").trim();
        json(200, goalNotesPage(goal, { limit: Number.isFinite(limit) ? limit : 30, ...(before ? { before: before.slice(0, 64) } : {}) }));
        return true;
      }

      const body = await readBody(req);
      const id = typeof body.id === "string" ? body.id.trim() : "";

      if (route === "POST /gateway/goals") {
        const fields = parseGoalFields(body);
        if (!fields.title) throw new BadRequest("title required");
        if (fields.agentId && !knownAgent(fields.agentId)) throw new BadRequest("unknown agent");
        if (fields.agentId === null) delete fields.agentId;
        let clientId: string | undefined;
        if (body.clientId !== undefined) {
          if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.clientId)) throw new BadRequest("clientId must be 1-64 letters, digits, - or _");
          clientId = body.clientId;
        }
        const { goal, created } = await store.create({ ...fields, title: fields.title, ...(clientId ? { clientId } : {}), createdBy: "owner" }, now());
        if (created) audit("goal.create", goal.id, { title: goal.title, category: goal.category, ...(goal.agentId ? { agentId: goal.agentId, cadence: goal.cadence } : {}) });
        json(created ? 201 : 200, { goal: view(goal), ...(created ? {} : { duplicate: true }) });
        return true;
      }

      if (!id) { json(400, { error: "id required" }); return true; }

      if (route === "POST /gateway/goals/update") {
        const fields: GoalFields = parseGoalFields(body);
        if (Object.keys(fields).length === 0) throw new BadRequest("nothing to change");
        if (fields.agentId && !knownAgent(fields.agentId)) throw new BadRequest("unknown agent");
        const result = await store.patch(id, fields, now());
        if (!result) { json(404, { error: "unknown goal" }); return true; }
        if (result.changed.length > 0) audit("goal.update", id, { fields: result.changed });
        json(200, { goal: view(result.goal) });
        return true;
      }

      if (route === "POST /gateway/goals/status" || route === "POST /gateway/goals/close") {
        const legacy = route.endsWith("/close");
        const raw = body.status;
        const status = (legacy ? (raw === "dropped" ? "dropped" : "done") : raw) as GoalStatusInput;
        if (!STATUS_INPUTS.includes(status)) throw new BadRequest(`status must be one of: ${STATUS_INPUTS.join(", ")}`);
        const result = await store.setStatus(id, status, now());
        if (!result) { json(404, { error: "unknown goal" }); return true; }
        if (result.changed) audit("goal.status", id, { status: result.goal.status });
        json(200, { ...(legacy ? { ok: true } : {}), goal: view(result.goal) });
        return true;
      }

      if (route === "POST /gateway/goals/note") {
        const text = parseNoteText(body.text);
        let progress: number | undefined;
        if (body.progress !== undefined && body.progress !== null) {
          if (typeof body.progress !== "number" || !Number.isFinite(body.progress) || body.progress < 0 || body.progress > 1) throw new BadRequest("progress must be a number from 0 to 1");
          progress = body.progress;
        }
        let clientId: string | undefined;
        if (body.clientId !== undefined) {
          if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.clientId)) throw new BadRequest("clientId must be 1-64 letters, digits, - or _");
          clientId = body.clientId;
        }
        const result = await store.addNote(id, { text, by: "owner", ...(progress !== undefined ? { progress } : {}), ...(clientId ? { clientId } : {}) }, now());
        if (!result) { json(404, { error: "unknown goal" }); return true; }
        if (result.created) audit("goal.note", id, { chars: text.length, ...(progress !== undefined ? { progress } : {}) });
        json(200, { goal: view(result.goal), note: result.note, ...(result.created ? {} : { duplicate: true }) });
        return true;
      }

      if (route === "POST /gateway/goals/delete") {
        const removed = await store.remove(id);
        if (!removed) { json(404, { error: "unknown goal" }); return true; }
        audit("goal.delete", id, { title: removed.title });
        json(200, { ok: true });
        return true;
      }

      // POST /gateway/goals/checkin
      if (!deps.runner) { json(501, { error: "this machine does not run goals" }); return true; }
      const outcome = await deps.runner.checkInNow(id);
      if (!outcome.started) {
        const status = outcome.reason === "unknown" ? 404 : 409;
        json(status, { error: REFUSAL_TEXT[outcome.reason], reason: outcome.reason });
        return true;
      }
      audit("goal.checkin", id, { requested: "owner" });
      json(202, { started: true });
      return true;
    } catch (err) {
      if (err instanceof BadRequest || err instanceof GoalInputError) {
        json(err instanceof BadRequest && err.message === "body too large" ? 413 : 400, { error: err.message });
      } else {
        deps.log?.(`goals ${route} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(500, { error: "internal error" });
      }
      return true;
    }
  };
}
