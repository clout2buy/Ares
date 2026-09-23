// /gateway/connections — the phone's Connections screen.
//
// Until now the only way to connect an account was to ask Ares in chat and
// tap the card its Connect tool raised. The Connections screen lists every
// connectable service with its state, starts a connect directly (the same
// ConnectHub flow the Connect tool uses, so the owner lands on the same
// OAuth page / setup form / key form / live browser), and disconnects.
//
// Mounted inside RemoteAgentServer.handlePhoneApi AFTER its bearer check, so
// every route here is owner-only. Shapes (the app is built against these):
//
//   GET  /gateway/connections
//        200 {services:[{id,label,kind,domain?,blurb,connected,category?}]}
//   POST /gateway/connections/start       {service}
//        200 {url, flowId, kind, service, label, instructions}
//        400 no service · 404 unknown service · 503 no connect broker
//        502 the broker refused (no public address, registration failed…)
//   POST /gateway/connections/disconnect  {service}
//        200 {ok, service, connected, removed} — ok is false only when the
//            service still reads as connected (an env-provided key)
//        400 no service · 404 unknown service
//
// Disconnect mirrors how each kind was stored: MCP → its registry entry and
// vault token; oauth-app → the provider's tokens (the registered app's client
// id/secret stay, so reconnecting is one tap, not the setup form again);
// api-key → every field's credential; browser → the saved session file.
// Credentials that come from the process environment can't be removed from
// here — the service then still reads as connected, which is the truth.

import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CONNECT_SERVICES,
  OAUTH_PROVIDERS,
  browserSessionFile,
  catalogById,
  deleteCredential,
  disconnectMcpServer,
  getConnectBroker,
  isServiceConnected,
  resolveConnectService,
  serviceDomain,
  type ConnectService,
} from "@ares/core";

export interface PhoneConnection {
  id: string;
  label: string;
  kind: ConnectService["kind"];
  domain?: string;
  blurb: string;
  connected: boolean;
  category?: string;
}

/** Categories for the services that aren't in the MCP catalog (which carries its own). */
const HANDWRITTEN_CATEGORIES: Record<string, string> = {
  google: "productivity",
  outlook: "productivity",
  spotify: "media",
  twilio: "comms",
  "stripe-key": "payments",
  resend: "comms",
};

function categoryOf(service: ConnectService): string | undefined {
  if (HANDWRITTEN_CATEGORIES[service.id]) return HANDWRITTEN_CATEGORIES[service.id];
  const entry = catalogById(service.id);
  if (entry) return entry.category;
  return service.kind === "browser" ? "commerce" : undefined;
}

export async function listPhoneConnections(home?: string): Promise<PhoneConnection[]> {
  return Promise.all(
    CONNECT_SERVICES.filter((s) => !s.id.startsWith("site:")).map(async (service) => {
      const domain = serviceDomain(service);
      const category = categoryOf(service);
      return {
        id: service.id,
        label: service.label,
        kind: service.kind,
        ...(domain ? { domain } : {}),
        blurb: service.blurb,
        connected: await isServiceConnected(service, home).catch(() => false),
        ...(category ? { category } : {}),
      };
    }),
  );
}

/** Exact registry id first (the app sends ids it listed); then the same
 *  plain-language / domain resolution the Connect tool uses. */
function findService(query: string): ConnectService | null {
  const q = query.trim();
  if (!q) return null;
  return CONNECT_SERVICES.find((s) => s.id === q) ?? resolveConnectService(q);
}

/** Remove whatever connects `service`. True when something was removed. */
export async function disconnectService(service: ConnectService, home?: string): Promise<boolean> {
  switch (service.kind) {
    case "mcp-oauth":
    case "mcp-key": {
      const removed = await disconnectMcpServer(service.id, home);
      const key = await deleteCredential(`mcp.key.${service.id}`, { home }).catch(() => false);
      return removed || key;
    }
    case "oauth-app": {
      const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
      if (!cfg) return false;
      return deleteCredential(`oauth/${cfg.provider}`, { home });
    }
    case "api-key": {
      let removed = false;
      for (const field of service.fields ?? []) removed = (await deleteCredential(field.credential, { home })) || removed;
      return removed;
    }
    case "browser": {
      try {
        await fs.unlink(browserSessionFile(service.id, home));
        return true;
      } catch {
        return false;
      }
    }
  }
}

async function readJsonBody(req: IncomingMessage, limit = 4 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export interface ConnectionsApiOptions {
  /** Vault/state home override (tests). */
  home?: string;
  log?: (line: string) => void;
}

/**
 * Handle a /gateway/connections* request. Returns false when the path isn't
 * ours. The caller has ALREADY verified the bearer token.
 */
export async function handleConnectionsApi(req: IncomingMessage, res: ServerResponse, url: URL, opts: ConnectionsApiOptions = {}): Promise<boolean> {
  if (url.pathname !== "/gateway/connections" && !url.pathname.startsWith("/gateway/connections/")) return false;
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    switch (`${req.method} ${url.pathname.replace(/\/+$/, "")}`) {
      case "GET /gateway/connections":
        json(200, { services: await listPhoneConnections(opts.home) });
        return true;

      case "POST /gateway/connections/start": {
        const body = await readJsonBody(req);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = findService(asked);
        if (!service) { json(404, { error: `unknown service: ${asked.slice(0, 80)}` }); return true; }
        const broker = getConnectBroker();
        if (!broker) { json(503, { error: "this machine has no connect hub (it needs a public address)" }); return true; }
        try {
          const prompt = await broker.start(service, { reason: "from the Connections screen" });
          opts.log?.(`connections: ${service.id} flow started from the phone`);
          json(200, { url: prompt.url, flowId: prompt.flowId, kind: prompt.kind, service: prompt.service, label: prompt.label, instructions: prompt.instructions });
        } catch (err) {
          json(502, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      case "POST /gateway/connections/disconnect": {
        const body = await readJsonBody(req);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = findService(asked);
        if (!service) { json(404, { error: `unknown service: ${asked.slice(0, 80)}` }); return true; }
        const removed = await disconnectService(service, opts.home);
        const connected = await isServiceConnected(service, opts.home).catch(() => false);
        opts.log?.(`connections: ${service.id} disconnected from the phone (${removed ? "removed" : "nothing stored"})`);
        json(200, { ok: !connected, service: service.id, connected, removed });
        return true;
      }

      default:
        json(404, { error: "not found" });
        return true;
    }
  } catch (err) {
    opts.log?.(`connections ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
