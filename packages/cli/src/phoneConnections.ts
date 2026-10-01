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
//        200 {services:[{id,label,kind,domain?,blurb,connected,category?,
//            account?,connectedAt?,lastUsedAt?,health?,healthDetail?,scopes?,
//            capabilities?,usedBy?,custom?}]} — the extras are optional and
//            only present when knowable (connectionsEnrich.ts says how each is
//            derived); no secret ever appears in any field
//   POST /gateway/connections/start       {service}
//        200 {url, flowId, kind, service, label, instructions}
//        400 no service · 404 unknown service · 503 no connect broker
//        502 the broker refused (no public address, registration failed…)
//   POST /gateway/connections/test        {service}
//        200 {ok, detail?, checkedAt} — a bounded (<=10s), side-effect-free
//            liveness check (connectionsTest.ts) · 400 no service · 404 unknown
//   GET  /gateway/connections/custom
//        200 {supported, servers:[{id,name,url,status,toolCount?,detail?}]}
//   POST /gateway/connections/custom      {name, url}
//        200 {id, status:"connected"|"needs_auth", authUrl?} · 400 invalid
//            input · 409 name taken / limit · 502 unreachable · 503 no hub
//   POST /gateway/connections/custom/remove {id}
//        200 {ok} · 400 · 404 (customConnectors.ts has the safety rules)
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
  loadRemoteMcpServers,
  type ConnectBroker,
  type RemoteMcpEntry,
  OAUTH_PROVIDERS,
  browserSessionFile,
  catalogById,
  deleteCredential,
  disconnectMcpServer,
  getConnectBroker,
  isBrokerV2,
  isServiceConnected,
  matrixFor,
  planConnect,
  resolveOAuthClient,
  clientRequiresSecret,
  revokeAndForgetTokens,
  callbackParamsFromUrl,
  resolveConnectService,
  serviceDomain,
  uninstallStdioConnector,
  type ConnectService,
} from "@ares/core";
import { disconnectPlaid, syncApiConnectServices } from "@ares/tools";
import { extrasFor, loadEnrichContext, type ConnectionExtras } from "./connectionsEnrich.js";
import { forgetTest, safeText } from "./connectionsSafe.js";
import { testConnection, type FetchLike } from "./connectionsTest.js";
import { HttpError, addCustom, customService, isCustomId, listCustom, removeCustom, type ResolveHost } from "./customConnectors.js";

export interface PhoneConnection extends ConnectionExtras {
  /** how it connects: oauth | oauth-setup | device | key | browser | unsupported */
  auth?: string;
  setupDone?: boolean;
  oauthClass?: string;
  verification?: string;
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
  plaid: "money",
  simplefin: "money",
};

function categoryOf(service: ConnectService): string | undefined {
  if (HANDWRITTEN_CATEGORIES[service.id]) return HANDWRITTEN_CATEGORIES[service.id];
  const entry = catalogById(service.id);
  if (entry) return entry.category;
  return service.kind === "browser" ? "commerce" : undefined;
}

export async function listPhoneConnections(home?: string, opts: { now?: () => number } = {}): Promise<PhoneConnection[]> {
  // Services the owner added to the universal Api tool (possibly from another process) join the list.
  syncApiConnectServices(home);
  const remote = await loadRemoteMcpServers(home).catch(() => ({} as Record<string, RemoteMcpEntry>));
  const ctx = await loadEnrichContext({ ...(home ? { home } : {}), ...(opts.now ? { now: opts.now } : {}), remote });
  const registry = CONNECT_SERVICES.filter((s) => !s.id.startsWith("site:"));
  const clientCache = new Map<string, { hasSecret: boolean } | undefined>();
  const listed = await Promise.all(
    registry.map(async (service): Promise<PhoneConnection> => {
      const domain = serviceDomain(service);
      const category = categoryOf(service);
      const connected = await isServiceConnected(service, home).catch(() => false);
      const extras = await extrasFor(service, connected, ctx).catch((): ConnectionExtras => ({}));
      const entry = matrixFor(service.id);
      const provider = entry?.provider ?? service.oauthProvider ?? (service.kind === "oauth-app" ? service.id : undefined);
      let client: { hasSecret: boolean } | undefined;
      if (provider && (service.kind === "oauth-app" || (service.kind === "mcp-oauth" && entry && entry.class !== "a"))) {
        if (!clientCache.has(provider)) {
          const r = await resolveOAuthClient(provider, { ...(home ? { home } : {}), requireSecret: clientRequiresSecret(provider, entry) }).catch(() => undefined);
          clientCache.set(provider, r ? { hasSecret: Boolean(r.clientSecret) } : undefined);
        }
        client = clientCache.get(provider);
      }
      const plan = planConnect(service, { client });
      const wanted = !connected && !extras.scopes && entry?.scopes?.length ? { scopes: entry.scopes.slice(0, 40) } : {};
      return {
        auth: plan.auth,
        setupDone: plan.setupDone,
        ...(plan.oauthClass ? { oauthClass: plan.oauthClass } : {}),
        ...(entry ? { verification: entry.verification } : {}),
        ...wanted,
        id: service.id,
        label: service.label,
        kind: service.kind,
        ...(domain ? { domain } : {}),
        blurb: service.blurb,
        connected,
        ...(category ? { category } : {}),
        ...extras,
      };
    }),
  );
  // Connectors the owner added by URL: real servers no registry row owns.
  const custom = await Promise.all(
    Object.entries(remote)
      .filter(([id]) => isCustomId(id, remote))
      .map(async ([id, entry]): Promise<PhoneConnection> => {
        const service = customService(id, entry);
        const extras = await extrasFor(service, true, ctx, { custom: true }).catch((): ConnectionExtras => ({ custom: true }));
        return { id, label: service.label, kind: service.kind, blurb: service.blurb, connected: true, category: "custom", ...extras };
      }),
  );
  // Pasted-token siblings of an OAuth service stay listed only for owners already connected through them.
  const visible = listed.filter((c) => !(CONNECT_SERVICES.find((s) => s.id === c.id)?.advanced && !c.connected));
  return [...visible, ...custom];
}

/** Exact registry id first (the app sends ids it listed); then the same
 *  plain-language / domain resolution the Connect tool uses; then a custom
 *  connector the owner added by URL. */
async function findService(query: string, home?: string): Promise<ConnectService | null> {
  const q = query.trim();
  if (!q) return null;
  const known = CONNECT_SERVICES.find((s) => s.id === q);
  if (known) return known;
  const remote = await loadRemoteMcpServers(home).catch(() => ({} as Record<string, RemoteMcpEntry>));
  if (isCustomId(q, remote)) return customService(q, remote[q]!);
  return resolveConnectService(q);
}

/** Remove whatever connects `service`. True when something was removed. */
export async function disconnectService(service: ConnectService, home?: string): Promise<boolean> {
  switch (service.kind) {
    case "mcp-oauth":
    case "mcp-key": {
      const removed = (await disconnectMcpServer(service.id, home)) || (await uninstallStdioConnector(service.id, home).catch(() => false));
      const key = await deleteCredential(`mcp.key.${service.id}`, { home }).catch(() => false);
      return removed || key;
    }
    case "oauth-app": {
      const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
      if (!cfg) return false;
      // RFC 7009 where the vendor offers it, then forget (the registered client stays).
      return revokeAndForgetTokens(cfg, cfg.provider, home ? { home } : {});
    }
    case "api-key": {
      // Plaid: revoke and forget every linked bank; the Plaid keys stay, so
      // reconnecting is one tap (like an oauth-app's registered client).
      if (service.id === "plaid") return disconnectPlaid({ home });
      let removed = await uninstallStdioConnector(service.id, home).catch(() => false);
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

async function readJsonBody(req: IncomingMessage, limit = 8 * 1024): Promise<Record<string, unknown>> {
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
  /** Test seams: outbound HTTP, clock, DNS, the connect hub, the test budget. */
  fetchImpl?: FetchLike;
  now?: () => number;
  resolveHost?: ResolveHost;
  allowPrivate?: boolean;
  broker?: ConnectBroker | null;
  testTimeoutMs?: number;
}

/** Strict body reader for the routes that take input from the phone. */
async function readStrictBody(req: IncomingMessage, limit = 4 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
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
        json(200, { services: await listPhoneConnections(opts.home, opts.now ? { now: opts.now } : {}) });
        return true;

      case "POST /gateway/connections/start": {
        const body = await readJsonBody(req);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = await findService(asked, opts.home);
        if (!service) { json(404, { error: `unknown service: ${asked.slice(0, 80)}` }); return true; }
        const broker = opts.broker === undefined ? getConnectBroker() : opts.broker;
        if (!broker) { json(503, { error: "this machine has no connect hub (it needs a public address)" }); return true; }
        if (body.v === 2 && isBrokerV2(broker)) {
          try {
            const result = await broker.startV2(service, {
              reason: "from the Connections screen",
              ...(body.returnTo === "ares://oauth" ? { returnTo: "ares://oauth" } : {}),
              ...(body.mode === "browser" ? { mode: "browser" as const } : {}),
              ...(body.reconnect === true ? { reconnect: true } : {}),
            });
            opts.log?.(`connections: ${service.id} v2 start -> ${result.state}`);
            json(200, result);
          } catch (err) {
            json(502, { error: safeText(err instanceof Error ? err.message : String(err), [], 240) });
          }
          return true;
        }
        try {
          const prompt = await broker.start(service, { reason: "from the Connections screen" });
          opts.log?.(`connections: ${service.id} flow started from the phone`);
          json(200, { url: prompt.url, flowId: prompt.flowId, kind: prompt.kind, service: prompt.service, label: prompt.label, instructions: prompt.instructions });
        } catch (err) {
          json(502, { error: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      case "GET /gateway/connections/poll": {
        const broker = opts.broker === undefined ? getConnectBroker() : opts.broker;
        const id = url.searchParams.get("id") ?? "";
        if (!id) { json(400, { error: "id required" }); return true; }
        const r = isBrokerV2(broker) ? broker.pollFlow(id) : null;
        if (!r) { json(404, { error: "unknown or expired flow", state: "expired" }); return true; }
        json(200, r);
        return true;
      }

      case "POST /gateway/connections/complete": {
        const broker = opts.broker === undefined ? getConnectBroker() : opts.broker;
        const body = await readStrictBody(req, 8 * 1024);
        const pollId = typeof body.pollId === "string" ? body.pollId : "";
        const redirect = typeof body.url === "string" ? body.url : "";
        if (!pollId || !redirect) { json(400, { error: "pollId and url required" }); return true; }
        const r = isBrokerV2(broker) ? await broker.completeFlow(pollId, redirect) : null;
        if (!r) { json(404, { error: "unknown or expired flow", state: "expired" }); return true; }
        json(200, r);
        return true;
      }

      case "POST /gateway/connections/setup": {
        const broker = opts.broker === undefined ? getConnectBroker() : opts.broker;
        const body = await readStrictBody(req, 8 * 1024);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = await findService(asked, opts.home);
        if (!service) { json(404, { error: `unknown service: ${safeText(asked, [], 80)}` }); return true; }
        if (!isBrokerV2(broker)) { json(503, { error: "this machine has no connect hub" }); return true; }
        const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, unknown>) : {};
        const r = await broker.setupService(service, values, { clear: body.clear === true });
        opts.log?.(`connections: ${service.id} setup ${r.ok ? "ok" : "refused"}`);
        json(r.ok ? 200 : 400, r);
        return true;
      }

      case "POST /gateway/connections/disconnect": {
        const body = await readJsonBody(req);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = await findService(asked, opts.home);
        if (!service) { json(404, { error: `unknown service: ${asked.slice(0, 80)}` }); return true; }
        const removed = await disconnectService(service, opts.home);
        forgetTest(opts.home, service.id);
        const connected = await isServiceConnected(service, opts.home).catch(() => false);
        opts.log?.(`connections: ${service.id} disconnected from the phone (${removed ? "removed" : "nothing stored"})`);
        json(200, { ok: !connected, service: service.id, connected, removed });
        return true;
      }

      case "POST /gateway/connections/test": {
        const body = await readStrictBody(req);
        const asked = typeof body.service === "string" ? body.service : "";
        if (!asked.trim()) { json(400, { error: "service required" }); return true; }
        const service = await findService(asked, opts.home);
        if (!service) { json(404, { error: `unknown service: ${safeText(asked, [], 80)}` }); return true; }
        const result = await testConnection(service, {
          ...(opts.home ? { home: opts.home } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.testTimeoutMs ? { timeoutMs: opts.testTimeoutMs } : {}),
        });
        opts.log?.(`connections: ${service.id} tested from the phone (${result.ok ? "ok" : "failed"})`);
        json(200, { ok: result.ok, detail: result.detail, checkedAt: result.checkedAt });
        return true;
      }

      case "GET /gateway/connections/custom": {
        const ctx = await loadEnrichContext({ ...(opts.home ? { home: opts.home } : {}), ...(opts.now ? { now: opts.now } : {}), remote: {} });
        json(200, { supported: true, servers: await listCustom(opts.home, ctx.mcpCache) });
        return true;
      }

      case "POST /gateway/connections/custom": {
        const body = await readStrictBody(req);
        const added = await addCustom(body, {
          ...(opts.home ? { home: opts.home } : {}),
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.resolveHost ? { resolveHost: opts.resolveHost } : {}),
          ...(opts.allowPrivate !== undefined ? { allowPrivate: opts.allowPrivate } : {}),
          ...(opts.broker !== undefined ? { broker: opts.broker } : {}),
          ...(opts.log ? { log: opts.log } : {}),
        });
        json(200, added);
        return true;
      }

      case "POST /gateway/connections/custom/remove": {
        const body = await readStrictBody(req);
        const removed = await removeCustom(body.id, { ...(opts.home ? { home: opts.home } : {}), ...(opts.log ? { log: opts.log } : {}) });
        forgetTest(opts.home, String(body.id));
        json(200, { ok: removed });
        return true;
      }

      default:
        json(404, { error: "not found" });
        return true;
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) json(err.status, { error: err.message });
      return true;
    }
    opts.log?.(`connections ${url.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}
