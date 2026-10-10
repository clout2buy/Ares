// /gateway/maintainer — the phone's window on Ares improving itself.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check (phoneApi.maintainer), so
// every route is owner-only. Shapes (the app is built against these; docs/ELITE-SELFIMPROVE.md):
//
//   GET  /gateway/maintainer
//        200 {enabled, time, running, forgeReady, lastRun, nextRunAt, budget, proposals:[Proposal…],
//             deploys:[DeploySummary…], activeTurns, liveSha}
//   GET  /gateway/maintainer/proposals/<id>
//        200 {proposal} · 404
//   POST /gateway/maintainer/run
//        202 {started:true, runId} · 409 {error, reason}
//   POST /gateway/maintainer/proposals/<id>/approve   {ackHighRisk?:boolean}
//        202 {proposal}  (deploy starts; poll GET /gateway/maintainer) · 404 · 409 (not pending, another
//        deploy running, or a HIGH-RISK proposal without ackHighRisk:true)
//   POST /gateway/maintainer/proposals/<id>/reject    {reason?}
//        200 {proposal} · 404 · 409
//   POST /gateway/maintainer/notify                   {title, body, data?, id?}   (ares-deploy -> phone)
//        200 {ok:true, pushed:boolean}
//
// Every owner decision lands in the audit trail (actor "owner", action maintainer.*).

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, clipText, readJsonObject, sendJson } from "../phoneCommon.js";
import { isProposalId, type Maintainer } from "./maintainer.js";

export interface MaintainerApiDeps {
  maintainer: Maintainer;
  push?: (message: { title: string; body: string; data?: Record<string, unknown>; collapseId?: string }) => Promise<unknown>;
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string }) => void;
  log?: (line: string) => void;
}

const PROPOSAL_ROUTE = /^\/gateway\/maintainer\/proposals\/([^/]+)(?:\/(approve|reject))?\/?$/;
const NOTIFY_DATA_KEYS = ["kind", "deployId", "status", "sha", "reason"] as const;

export function createMaintainerApi(deps: MaintainerApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const audit = (action: string, target: string | undefined, params: unknown, result = "ok") => {
    try { deps.audit?.({ actor: "owner", action, ...(target ? { target } : {}), ...(params !== undefined ? { params } : {}), result }); } catch { /* an observer never breaks a route */ }
  };

  return async (req, res, url) => {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    if (p !== "/gateway/maintainer" && !p.startsWith("/gateway/maintainer/")) return false;
    try {
      if (p === "/gateway/maintainer" && method === "GET") {
        sendJson(res, 200, await deps.maintainer.status());
        return true;
      }
      if (p === "/gateway/maintainer/run" && method === "POST") {
        await readJsonObject(req, 1024);
        const r = deps.maintainer.runNow();
        audit("maintainer.run.request", undefined, {}, r.started ? "started" : `refused: ${r.reason}`);
        if (!r.started) return sendJson(res, 409, { error: r.reason, reason: r.reason }), true;
        sendJson(res, 202, r);
        return true;
      }
      if (p === "/gateway/maintainer/notify" && method === "POST") {
        const body = await readJsonObject(req, 4 * 1024);
        const title = clipText(body.title, 120);
        const text = clipText(body.body, 300);
        if (!title || !text) throw new HttpError(400, "title and body are required");
        const data: Record<string, unknown> = {};
        const given = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {};
        for (const k of NOTIFY_DATA_KEYS) if (typeof given[k] === "string") data[k] = clipText(given[k], 60);
        let pushed = false;
        if (deps.push) {
          try { await deps.push({ title, body: text, data, collapseId: `deploy-${String(data.deployId ?? "x")}` }); pushed = true; } catch (err) { deps.log?.(`maintainer: push failed: ${err instanceof Error ? err.message : String(err)}`); }
        }
        sendJson(res, 200, { ok: true, pushed });
        return true;
      }
      const m = PROPOSAL_ROUTE.exec(p);
      if (m) {
        const id = m[1]!;
        if (!isProposalId(id)) return sendJson(res, 404, { error: "unknown proposal" }), true;
        const action = m[2];
        if (!action && method === "GET") {
          const proposal = await deps.maintainer.getProposal(id);
          if (!proposal) return sendJson(res, 404, { error: "unknown proposal" }), true;
          sendJson(res, 200, { proposal });
          return true;
        }
        if (action === "approve" && method === "POST") {
          const body = await readJsonObject(req, 1024);
          const r = await deps.maintainer.approve(id, { via: "owner-api", ackHighRisk: body.ackHighRisk === true });
          audit("maintainer.approve.request", id, { ackHighRisk: body.ackHighRisk === true }, r.ok ? "approved" : `refused: ${r.error}`);
          if (!r.ok) return sendJson(res, r.status, { error: r.error }), true;
          sendJson(res, 202, { proposal: r.proposal });
          return true;
        }
        if (action === "reject" && method === "POST") {
          const body = await readJsonObject(req, 2048);
          const r = await deps.maintainer.reject(id, clipText(body.reason, 200));
          audit("maintainer.reject.request", id, {}, r.ok ? "rejected" : `refused: ${r.error}`);
          if (!r.ok) return sendJson(res, r.status, { error: r.error }), true;
          sendJson(res, 200, { proposal: r.proposal });
          return true;
        }
      }
      sendJson(res, 404, { error: "not found" });
      return true;
    } catch (err) {
      if (err instanceof HttpError) { sendJson(res, err.status, { error: err.message }); return true; }
      deps.log?.(`maintainer api: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { error: "internal error" });
      return true;
    }
  };
}
