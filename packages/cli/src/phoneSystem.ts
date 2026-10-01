// /gateway/system -- the box's health at a glance, for the phone's System screen.
// Owner bearer only (asked after the bearer check, like every phone route).
//
//   GET  /gateway/system[?fresh=1]          the snapshot (cached 5 s), see systemSnapshot.ts
//   GET  /gateway/system/events?limit=&before=   alert + housekeeping + backup feed, newest first
//   GET  /gateway/system/housekeeping       { summary, ledger[] } -- what the box deleted and why
//   POST /gateway/system/housekeeping       { dryRun? } run now; returns the full report (409 if already running)
//   GET  /gateway/system/backup             backup status
//   POST /gateway/system/backup             start a backup now (202; poll GET /backup)
//   POST /gateway/system/turns/stop         { sessionId } interrupt one running turn
//
// Hooks rather than imports so tests stub every dependency and the route works
// on a garrison that wires only some of them.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AlertEngine } from "./systemAlerts.js";
import type { BackupResult, BackupStatus } from "./systemBackup.js";
import type { Housekeeping } from "./systemHousekeeping.js";
import type { SystemService } from "./systemSnapshot.js";

export interface SystemApiDeps {
  service: SystemService;
  alerts?: AlertEngine;
  housekeeping?: Housekeeping;
  runBackup?: () => Promise<BackupResult>;
  backupStatus?: () => Promise<BackupStatus | undefined>;
  /** Interrupt one session's running turn. Returns false when it is idle or unknown. */
  stopTurn?: (sessionId: string) => boolean;
  log?: (line: string) => void;
}

const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function createSystemApi(deps: SystemApiDeps) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };
  const readJson = async (req: IncomingMessage, limit = 4 * 1024): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > limit) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (total === 0) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  };
  let backupRunning = false;

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/system" && !url.pathname.startsWith("/gateway/system/")) return false;
    const sub = url.pathname.replace(/^\/gateway\/system\/?/, "").replace(/\/$/, "");
    try {
      if (sub === "" && req.method === "GET") {
        const snapshot = await deps.service.snapshot({ fresh: url.searchParams.get("fresh") === "1" });
        return send(res, 200, snapshot), true;
      }
      if (sub === "events" && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const before = url.searchParams.get("before") ?? undefined;
        if (before && !Number.isFinite(Date.parse(before))) return send(res, 400, { error: "before must be an ISO timestamp" }), true;
        const events = (await deps.alerts?.events({ limit: Number.isFinite(limit) ? limit : 50, ...(before ? { before } : {}) })) ?? [];
        const last = events[events.length - 1];
        return send(res, 200, { events, ...(events.length >= (Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50) && last ? { nextBefore: last.at } : {}) }), true;
      }
      if (sub === "housekeeping") {
        if (!deps.housekeeping) return send(res, 501, { error: "housekeeping is not available on this box" }), true;
        if (req.method === "GET") return send(res, 200, { summary: deps.housekeeping.summary(), ledger: await deps.housekeeping.ledgerTail(30) }), true;
        if (req.method === "POST") {
          const body = await readJson(req);
          if (deps.housekeeping.isRunning) return send(res, 409, { error: "housekeeping is already running" }), true;
          const report = await deps.housekeeping.run({ dryRun: body.dryRun === true });
          return send(res, 200, { report, summary: deps.housekeeping.summary() }), true;
        }
        return send(res, 405, { error: "method not allowed" }), true;
      }
      if (sub === "backup") {
        if (req.method === "GET") return send(res, 200, { status: (await deps.backupStatus?.()) ?? null, running: backupRunning }), true;
        if (req.method === "POST") {
          if (!deps.runBackup) return send(res, 501, { error: "backups are not available on this box" }), true;
          if (backupRunning) return send(res, 409, { error: "a backup is already running" }), true;
          backupRunning = true;
          // A backup can outlast the tunnel's request timeout: answer now, the app polls GET.
          void deps
            .runBackup()
            .catch((err: unknown) => deps.log?.(`system: backup failed: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => {
              backupRunning = false;
            });
          return send(res, 202, { started: true }), true;
        }
        return send(res, 405, { error: "method not allowed" }), true;
      }
      if (sub === "turns/stop" && req.method === "POST") {
        if (!deps.stopTurn) return send(res, 501, { error: "stopping a turn is not available on this box" }), true;
        const body = await readJson(req);
        const id = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (!SESSION_ID_RE.test(id)) return send(res, 400, { error: "sessionId required" }), true;
        const stopped = deps.stopTurn(id);
        deps.log?.(`system: owner stopped a turn (${id.slice(0, 12)}): ${stopped ? "interrupted" : "was not running"}`);
        return send(res, stopped ? 200 : 409, { ok: stopped, sessionId: id, ...(stopped ? {} : { error: "that session has no running turn" }) }), true;
      }
      return send(res, 404, { error: "not found" }), true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/too large/.test(message)) return send(res, 413, { error: message }), true;
      if (err instanceof SyntaxError) return send(res, 400, { error: "invalid JSON" }), true;
      deps.log?.(`system: ${req.method} ${url.pathname} failed: ${message}`);
      return send(res, 500, { error: "internal error" }), true;
    }
  };
}
