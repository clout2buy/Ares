// /gateway/device — the phone's side of Phone Hands over plain HTTP.
//
//   GET  /gateway/device                         { devices:[{ id, name, model?, os?, appVersion?, connected,
//                                                             lastSeenAt, capabilities[], shortcuts[] }] }
//   POST /gateway/device/test {device?, capability?:"device.info"}
//                                                { ok, device?, result?|error:{code,message}, durationMs }
//   GET  /gateway/device/pending?device=<id>[&includeClaimed=1]
//                                                { requests:[{ id, capability, args, deadlineMs, reason? }] }
//   POST /gateway/device/respond {id, ok, result?, error?:{code,message}}
//                                                { accepted }   (idempotent: unknown/late ids are ignored)
//
// The pending/respond pair is the fallback for a phone with no live socket —
// it is woken by a silent push, pulls what is waiting, runs it and answers
// here. They resolve the SAME correlation table as the WebSocket frames.
// Pending delivery is at-most-once per request (a pull claims it); a phone
// that crashed mid-run re-lists with includeClaimed=1 and dedupes by id.
//
// Everything is behind the owner's bearer (the dispatch site in
// remoteAgentServer.ts) — guests never reach this origin's phone routes.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeviceBridge } from "@ares/garrison";

const RESPOND_LIMIT = 320 * 1024;

export function createDeviceApi(bridge: DeviceBridge, log: (line: string) => void = () => {}) {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };

  const readJson = async (req: IncomingMessage, limit: number): Promise<Record<string, unknown>> => {
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

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/device" && !url.pathname.startsWith("/gateway/device/")) return false;
    const sub = url.pathname.slice("/gateway/device".length).replace(/^\/|\/$/g, "");
    try {
      if (sub === "") return false; // the synced-data kinds route (deviceSync.ts) owns the bare path
      if (sub === "list" && req.method === "GET") {
        return send(res, 200, { devices: bridge.list() }), true;
      }
      if (sub === "test" && req.method === "POST") {
        const body = await readJson(req, 4 * 1024);
        const capability = typeof body.capability === "string" && body.capability ? body.capability : "device.info";
        // A health check must never act: it is a round trip, nothing more.
        if (capability !== "device.info") return send(res, 400, { error: "only device.info may be used for a connection test" }), true;
        const device = typeof body.device === "string" && body.device ? body.device : "default";
        const r = await bridge.invoke(device, "device.info", {}, { actor: "owner", reason: "Connection test from the Ares app", timeoutMs: 20_000 });
        return send(res, 200, r.ok ? { ok: true, device: r.device, result: r.result, durationMs: r.durationMs } : { ok: false, ...(r.device ? { device: r.device } : {}), error: r.error, durationMs: r.durationMs }), true;
      }
      if (sub === "pending" && req.method === "GET") {
        const device = (url.searchParams.get("device") ?? "").trim();
        if (!device) return send(res, 400, { error: "device is required" }), true;
        const requests = bridge.pollPending(device, { includeClaimed: url.searchParams.get("includeClaimed") === "1" });
        return send(res, 200, { requests }), true;
      }
      if (sub === "respond" && req.method === "POST") {
        const body = await readJson(req, RESPOND_LIMIT);
        if (typeof body.id !== "string" || !body.id || typeof body.ok !== "boolean") return send(res, 400, { error: "id and ok are required" }), true;
        return send(res, 200, bridge.httpRespond(body)), true;
      }
      const known = ["test", "pending", "respond", "list"];
      return send(res, known.includes(sub) ? 405 : 404, { error: known.includes(sub) ? "method not allowed" : "not found" }), true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/too large/.test(message)) return send(res, 413, { error: message }), true;
      if (err instanceof SyntaxError) return send(res, 400, { error: "invalid JSON" }), true;
      log(`device: ${req.method} ${url.pathname} failed: ${message}`);
      return send(res, 500, { error: message.slice(0, 400) }), true;
    }
  };
}
