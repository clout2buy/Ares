// /gateway/shortcuts — the owner's iPhone Shortcuts as skills, and the
// Shortcuts Ares proposes. Mounted AFTER the owner bearer check (phoneApi.shortcuts).
//
//   GET    /gateway/shortcuts[?device=<id>]
//          200 {device?, updatedAt?, devices:[id], shortcuts:[meta], proposals:[view],
//               history:[entry], limits}
//   POST   /gateway/shortcuts            {device, shortcuts:[meta]}  (full replace; the phone is the source of truth)
//          200 {ok, device, updatedAt, shortcuts}      400 {error}
//   GET    /gateway/shortcuts/history[?limit=]         200 {history:[entry]}  newest first
//   POST   /gateway/shortcuts/history    {device, name, outcome, ms?, summary?}
//          200 {ok}  -- the owner's own run from the app: audited, kept in the history, stamped on the Shortcut
//   GET    /gateway/shortcuts/proposals                200 {proposals:[view]}
//   GET    /gateway/shortcuts/proposals/<id>/file      the UNSIGNED .shortcut (iOS may refuse it); 409 when a step has no encoding
//   DELETE /gateway/shortcuts/proposals/<id>           200 {ok, removed}
//
// meta = {name, alias?, whenToUse?, description?, acceptsInput?, sensitive?, lastRun?}
// Sensitivity is opt-out: only `sensitive: false` makes a Shortcut routine.
// Running a Shortcut is NOT here: it stays an iPhone capability behind the gate.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SHORTCUT_LIST_MAX,
  ShortcutValidationError,
  buildShortcutFile,
  normalizeSteps,
  sanitizeShortcutList,
  shortcutFileName,
  validDeviceKey,
  type ShortcutDirectory,
  type ShortcutOutcome,
  type StoredProposal,
} from "@ares/tools";

const BODY_LIMIT = 256 * 1024;
const OUTCOMES = new Set<ShortcutOutcome>(["ok", "error", "declined", "timeout", "unavailable"]);

export interface ShortcutsApiOptions {
  directory: ShortcutDirectory;
  log?: (line: string) => void;
}

function view(p: StoredProposal) {
  return { id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), recipe: p.recipe, createdAt: p.createdAt, file: p.file };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > BODY_LIMIT) throw new ShortcutValidationError("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ShortcutValidationError("body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ShortcutValidationError("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function createShortcutsApi(opts: ShortcutsApiOptions) {
  const dir = opts.directory;
  const log = opts.log ?? (() => {});
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
    res.end(text);
  };

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname.replace(/\/+$/, "");
    if (p !== "/gateway/shortcuts" && !p.startsWith("/gateway/shortcuts/")) return false;
    const method = req.method ?? "GET";
    const rest = p.slice("/gateway/shortcuts".length).replace(/^\//, "");
    try {
      if (rest === "") {
        if (method === "GET") {
          const lib = dir.get(url.searchParams.get("device") ?? undefined);
          send(res, 200, {
            ...(lib ? { device: lib.device, updatedAt: lib.updatedAt } : {}),
            devices: dir.devices(),
            shortcuts: lib?.shortcuts ?? [],
            proposals: dir.proposals().map(view),
            history: dir.history(20),
            limits: { shortcuts: SHORTCUT_LIST_MAX },
          });
          return true;
        }
        if (method === "POST") {
          const body = await readJson(req);
          if (!validDeviceKey(body.device)) throw new ShortcutValidationError("device (the phone's id) is required");
          const list = sanitizeShortcutList(body.shortcuts, { strict: true });
          const stored = await dir.put(body.device, list);
          log(`shortcuts: ${stored.shortcuts.length} synced from the phone (${stored.shortcuts.filter((s) => s.alias).length} with aliases)`);
          send(res, 200, { ok: true, ...stored });
          return true;
        }
        send(res, 405, { error: "method not allowed" }, { allow: "GET, POST" });
        return true;
      }
      if (rest === "history") {
        if (method === "GET") {
          send(res, 200, { history: dir.history(Number(url.searchParams.get("limit")) || 30) });
          return true;
        }
        if (method === "POST") {
          const body = await readJson(req);
          if (!validDeviceKey(body.device)) throw new ShortcutValidationError("device (the phone's id) is required");
          if (typeof body.name !== "string" || !body.name.trim()) throw new ShortcutValidationError("name is required");
          const outcome = OUTCOMES.has(body.outcome as ShortcutOutcome) ? (body.outcome as ShortcutOutcome) : undefined;
          if (!outcome) throw new ShortcutValidationError("outcome must be ok, error, declined, timeout or unavailable");
          await dir.recordRun(body.device, {
            name: body.name,
            outcome,
            actor: "owner",
            ...(typeof body.ms === "number" && Number.isFinite(body.ms) ? { ms: body.ms } : {}),
            ...(typeof body.summary === "string" ? { summary: body.summary } : {}),
          });
          send(res, 200, { ok: true });
          return true;
        }
        send(res, 405, { error: "method not allowed" }, { allow: "GET, POST" });
        return true;
      }
      if (rest === "proposals") {
        if (method !== "GET") {
          send(res, 405, { error: "method not allowed" }, { allow: "GET" });
          return true;
        }
        send(res, 200, { proposals: dir.proposals().map(view) });
        return true;
      }
      const m = /^proposals\/(scp_[0-9a-f]{8})(?:\/(file))?$/.exec(rest);
      if (m) {
        const proposal = dir.proposal(m[1]!);
        if (!proposal) {
          send(res, 404, { error: "no such proposal" });
          return true;
        }
        if (m[2] === "file") {
          if (method !== "GET") {
            send(res, 405, { error: "method not allowed" }, { allow: "GET" });
            return true;
          }
          const bytes = buildShortcutFile(normalizeSteps(proposal.steps));
          if (!bytes) {
            send(res, 409, { error: proposal.file.reason ?? "this Shortcut has no importable file; follow the recipe" });
            return true;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": bytes.length,
            "content-disposition": `attachment; filename="${shortcutFileName(proposal.name)}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            // Unsigned: Shortcuts on iOS 15+ imports signed files only, so this may be refused.
            "x-ares-signed": "false",
          });
          res.end(bytes);
          return true;
        }
        if (method === "DELETE") {
          const removed = await dir.removeProposal(proposal.id);
          send(res, 200, { ok: true, removed });
          return true;
        }
        if (method === "GET") {
          send(res, 200, { proposal: view(proposal) });
          return true;
        }
        send(res, 405, { error: "method not allowed" }, { allow: "GET, DELETE" });
        return true;
      }
      send(res, 404, { error: "not found" });
      return true;
    } catch (err) {
      if (err instanceof ShortcutValidationError) {
        send(res, /too large/.test(err.message) ? 413 : 400, { error: err.message });
        return true;
      }
      log(`shortcuts ${method} ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
      return true;
    }
  };
}
