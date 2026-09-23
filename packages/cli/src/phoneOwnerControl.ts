// The phone's control-plane routes — kill switch, pause, jobs and the audit
// log, on the same Bearer-guarded /gateway origin as everything else the app
// uses. Split out of remoteAgentServer.ts so that file only gains one
// dispatch line; the shapes live here with their reasons.
//
//   POST /gateway/control/stop    {}        → {stopped:{turns,subagents,jobs,browsers,prompts,queued}}
//   POST /gateway/control/pause   {}        → {paused:true, pausedAt}
//   POST /gateway/control/resume  {}        → {paused:false}
//   GET  /gateway/jobs                      → {jobs:[OwnerJobView…]}
//   POST /gateway/jobs/cancel     {id}      → {ok, id, detail}
//   POST /gateway/jobs/resume     {id}      → {ok, id}    (held system jobs)
//   GET  /gateway/audit?limit=&sessionId=   → {entries:[AuditEntry…]} newest first
//
// GET /gateway/control (the settings cockpit) is NOT here: it already exists
// and gains {paused, pausedAt?, running} from status() in place.

import type { AuditEntry } from "@ares/core";
import type { ControlStatus, OwnerJobView, StopAllResult } from "./entry/ownerControlPlane.js";

export interface OwnerControlHooks {
  stopAll(): Promise<StopAllResult>;
  pause(): { paused: true; pausedAt: string; changed: boolean };
  resume(): { paused: false; changed: boolean };
  status(): ControlStatus;
  listJobs(): Promise<{ jobs: OwnerJobView[] }>;
  cancelJob(id: string): Promise<{ ok: boolean; id: string; detail: string }>;
  resumeJob(id: string): { ok: boolean; id: string };
  readAudit(opts: { limit?: number; sessionId?: string }): Promise<AuditEntry[]>;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

/** Handle one control-plane route, or return null when the path isn't ours. */
export async function handleOwnerControlRoute(
  method: string | undefined,
  url: URL,
  readBody: () => Promise<Record<string, unknown>>,
  hooks: OwnerControlHooks,
): Promise<RouteReply | null> {
  switch (`${method} ${url.pathname}`) {
    case "POST /gateway/control/stop":
      return { status: 200, body: await hooks.stopAll() };
    case "POST /gateway/control/pause": {
      const { paused, pausedAt } = hooks.pause();
      return { status: 200, body: { paused, pausedAt } };
    }
    case "POST /gateway/control/resume": {
      const { paused } = hooks.resume();
      return { status: 200, body: { paused } };
    }
    case "GET /gateway/jobs":
      return { status: 200, body: await hooks.listJobs() };
    case "POST /gateway/jobs/cancel":
    case "POST /gateway/jobs/resume": {
      const body = await readBody();
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return { status: 400, body: { error: "id required" } };
      const result = url.pathname.endsWith("/cancel") ? await hooks.cancelJob(id) : hooks.resumeJob(id);
      return { status: result.ok ? 200 : 404, body: result };
    }
    case "GET /gateway/audit": {
      const rawLimit = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 1_000) : 100;
      const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
      const entries = await hooks.readAudit({ limit, ...(sessionId ? { sessionId } : {}) });
      return { status: 200, body: { entries } };
    }
    default:
      return null;
  }
}
