// Per-service extras for GET /gateway/connections — only what the box can
// actually know. Every field is OPTIONAL and omitted when unknowable:
//
//   account       recorded by the last successful liveness test (the provider's
//                 own userinfo answer). Nothing else in the vault records it.
//   connectedAt   mcp-remote.json's connectedAt; a browser session file's mtime.
//                 OAuth / key credentials carry no timestamp, so: omitted.
//   lastUsedAt    newest audit-trail entry for a tool that depends on the
//                 service (the audit is written by the runtime per tool call).
//   health        token expiry (oauth / mcp), the last MCP tool-refresh error,
//                 saved-cookie expiry (browser), or a recent liveness test.
//   scopes        the scope string the provider returned with the token.
//   capabilities  a small static map (hand-written services) or the connector's
//                 own cached tool list; else the blurb's sentences.
//   usedBy        tool names: "Use the X tool" in the registry's howToUse, a
//                 static map for Google's family, or mcp_<id>_<tool> from the
//                 connector's cached tool list.
//   custom        true for a remote MCP server the owner added by URL.
//
// Secrets are never read into a field: the vault bundles are parsed only for
// their expiry/refresh presence, and nothing from them is copied out.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OAUTH_PROVIDERS,
  browserSessionFile,
  catalogById,
  getCredential,
  loadTokens,
  readAudit,
  type ConnectService,
  type RemoteMcpEntry,
} from "@ares/core";
import { cleanAccount, recallTest, safeText } from "./connectionsSafe.js";

export interface ConnectionExtras {
  account?: string;
  connectedAt?: number;
  lastUsedAt?: number;
  health?: "ok" | "expired" | "error";
  healthDetail?: string;
  scopes?: string[];
  capabilities?: string[];
  usedBy?: string[];
  custom?: boolean;
}

const TEST_FRESH_MS = 15 * 60_000;
const AUDIT_DAYS = 14;
const AUDIT_LIMIT = 2000;
const AUDIT_TTL_MS = 30_000;

/** Tools a service powers when the registry's own text doesn't name them. */
const STATIC_TOOLS: Record<string, string[]> = {
  google: ["Gmail", "GoogleCalendar", "GoogleDrive", "GoogleDocs", "GoogleSheets", "GoogleSlides", "GoogleForms", "GoogleTasks", "GoogleContacts"],
  "google-places": ["Places"],
  gemini: ["Imagine"],
};

/** Short, human-readable abilities for the hand-written services. */
const STATIC_CAPABILITIES: Record<string, string[]> = {
  google: ["Read, search and send Gmail", "Manage Calendar events", "Find and edit Drive files", "Edit Docs, Sheets and Slides", "Manage Tasks, Forms and Contacts"],
  outlook: ["Read, search and send mail", "Manage calendar events", "Search contacts"],
  spotify: ["Control playback", "Manage playlists and your library"],
  twilio: ["Send texts", "Place calls", "Manage phone numbers"],
  "stripe-key": ["Read balances and charges", "Manage customers and invoices"],
  resend: ["Send email from your domain"],
  openai: ["Generate images"],
  gemini: ["Generate images and video"],
  "google-places": ["Search places and get details"],
  hue: ["Control lights, rooms and scenes"],
  tessie: ["Read Tesla state and location", "Control climate, charging and locks"],
  ticketmaster: ["Find concerts, sports and shows"],
  flightaware: ["Look up live flight status", "Airport arrivals and departures"],
  duffel: ["Search airline offers", "Book flights (asks you first)"],
  withings: ["Read weight and health measurements"],
  tailscale: ["See and manage tailnet devices"],
  simplefin: ["Read bank balances and transactions"],
  plaid: ["Read bank balances and transactions"],
  peloton: ["Read your workouts"],
};

export interface McpToolsCache {
  [server: string]: { tools?: Array<{ name?: string; description?: string }>; error?: string; at?: number } | undefined;
}

export interface EnrichContext {
  home?: string;
  now: () => number;
  remote: Record<string, RemoteMcpEntry>;
  mcpCache: McpToolsCache;
  /** tool name (before any ".action") → newest ms it ran. */
  lastUsedByTool: Map<string, number>;
}

function aresHome(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

/** Same naming rule the engine uses for mcp_<server>_<tool> (entry/mcpTools.ts). */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp_${slug(server)}_${slug(tool)}`.slice(0, 64);
}

async function readMcpCache(home?: string): Promise<McpToolsCache> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(aresHome(home), "mcp-tools-cache.json"), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as McpToolsCache) : {};
  } catch {
    return {};
  }
}

const auditCache = new Map<string, { at: number; map: Map<string, number> }>();

async function lastUsedMap(home: string | undefined, now: number): Promise<Map<string, number>> {
  const k = home ?? "";
  const hit = auditCache.get(k);
  if (hit && now - hit.at < AUDIT_TTL_MS) return hit.map;
  const map = new Map<string, number>();
  try {
    const entries = await readAudit({ home, days: AUDIT_DAYS, limit: AUDIT_LIMIT });
    for (const entry of entries) {
      if (!entry.action || entry.action.startsWith("permission:")) continue;
      if (entry.result === "denied") continue;
      const tool = entry.action.split(".")[0]!;
      const ts = Date.parse(entry.ts);
      if (!Number.isFinite(ts)) continue;
      if (ts > (map.get(tool) ?? 0)) map.set(tool, ts);
    }
  } catch {
    // no audit trail → no lastUsedAt
  }
  auditCache.set(k, { at: now, map });
  return map;
}

export async function loadEnrichContext(opts: {
  home?: string;
  now?: () => number;
  remote: Record<string, RemoteMcpEntry>;
}): Promise<EnrichContext> {
  const now = opts.now ?? Date.now;
  const [mcpCache, lastUsedByTool] = await Promise.all([readMcpCache(opts.home), lastUsedMap(opts.home, now())]);
  return { ...(opts.home ? { home: opts.home } : {}), now, remote: opts.remote, mcpCache, lastUsedByTool };
}

/** Tool names that depend on a service. */
export function toolsFor(service: { id: string; howToUse?: string }, ctx: Pick<EnrichContext, "mcpCache">): string[] {
  const names = new Set<string>(STATIC_TOOLS[service.id] ?? []);
  for (const m of (service.howToUse ?? "").matchAll(/\b(?:Use|use) the ([A-Z][A-Za-z]+) tool\b/g)) names.add(m[1]!);
  for (const t of ctx.mcpCache[service.id]?.tools ?? []) if (t.name) names.add(mcpToolName(service.id, t.name));
  return [...names].slice(0, 40);
}

function humanize(tool: string): string {
  const text = tool.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return text ? text[0]!.toUpperCase() + text.slice(1) : tool;
}

function capabilitiesFor(service: { id: string; blurb: string }, ctx: Pick<EnrichContext, "mcpCache">): string[] | undefined {
  if (STATIC_CAPABILITIES[service.id]) return STATIC_CAPABILITIES[service.id];
  const tools = (ctx.mcpCache[service.id]?.tools ?? []).map((t) => t.name).filter((n): n is string => Boolean(n));
  if (tools.length) return tools.slice(0, 8).map(humanize);
  const sentences = service.blurb
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, "").trim())
    .filter((s) => s.length > 0 && s.length <= 100 && !/^metered/i.test(s));
  return sentences.length ? sentences.slice(0, 3) : undefined;
}

function scopesOf(scope: string | undefined): string[] | undefined {
  if (!scope) return undefined;
  const list = scope.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s && s.length <= 200);
  return list.length ? list.slice(0, 60) : undefined;
}

interface TokenShape {
  expiresAt?: number;
  hasRefresh: boolean;
}

/** Expiry facts from the MCP vault bundle — nothing else leaves this function. */
async function mcpTokenShape(id: string, home?: string): Promise<TokenShape | null> {
  try {
    const raw = await getCredential(`mcp.token.${id}`, { home });
    if (!raw) return null;
    const bundle = JSON.parse(raw) as { expiresAt?: unknown; refreshToken?: unknown; needsReauth?: unknown };
    if (bundle.needsReauth === true) return { expiresAt: 1, hasRefresh: false };
    return {
      ...(typeof bundle.expiresAt === "number" ? { expiresAt: bundle.expiresAt } : {}),
      hasRefresh: typeof bundle.refreshToken === "string" && bundle.refreshToken.length > 0,
    };
  } catch {
    return null;
  }
}

/** Saved browser cookies: expired when every persistent cookie is past its date. */
async function browserHealth(file: string, now: number): Promise<{ connectedAt?: number; health?: "ok" | "expired"; detail?: string }> {
  let mtime: number | undefined;
  try {
    mtime = (await fs.stat(file)).mtimeMs;
  } catch {
    return {};
  }
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8")) as { cookies?: Array<{ expires?: number }> };
    const persistent = (state.cookies ?? []).filter((c) => typeof c.expires === "number" && c.expires > 0);
    if (persistent.length > 0 && persistent.every((c) => c.expires! * 1000 < now)) {
      return { ...(mtime ? { connectedAt: Math.round(mtime) } : {}), health: "expired", detail: "the saved sign-in has expired" };
    }
    return { ...(mtime ? { connectedAt: Math.round(mtime) } : {}), health: "ok" };
  } catch {
    return { ...(mtime ? { connectedAt: Math.round(mtime) } : {}) };
  }
}

function lastUsed(tools: string[], ctx: EnrichContext, prefix?: string): number | undefined {
  let best = 0;
  for (const tool of tools) best = Math.max(best, ctx.lastUsedByTool.get(tool) ?? 0);
  if (prefix) for (const [tool, ts] of ctx.lastUsedByTool) if (tool.startsWith(prefix)) best = Math.max(best, ts);
  return best > 0 ? best : undefined;
}

/** The extras for one service. `connected` comes from the existing check. */
export async function extrasFor(
  service: ConnectService,
  connected: boolean,
  ctx: EnrichContext,
  opts: { custom?: boolean } = {},
): Promise<ConnectionExtras> {
  const out: ConnectionExtras = {};
  const tools = toolsFor(service, ctx);
  const capabilities = capabilitiesFor(service, ctx);
  if (capabilities?.length) out.capabilities = capabilities;
  if (tools.length) out.usedBy = tools;
  if (opts.custom) out.custom = true;
  if (!connected) return out;

  const used = lastUsed(tools, ctx, service.kind.startsWith("mcp") ? `mcp_${slug(service.id)}_` : undefined);
  if (used) out.lastUsedAt = used;

  let health: ConnectionExtras["health"];
  let detail: string | undefined;

  switch (service.kind) {
    case "mcp-oauth":
    case "mcp-key": {
      const entry = ctx.remote[service.id];
      const at = entry?.connectedAt ? Date.parse(entry.connectedAt) : NaN;
      if (Number.isFinite(at)) out.connectedAt = at;
      const shape = await mcpTokenShape(service.id, ctx.home);
      const cachedError = ctx.mcpCache[service.id]?.error;
      if (shape?.expiresAt !== undefined && shape.expiresAt <= ctx.now() && !shape.hasRefresh) {
        health = "expired";
        detail = "the access token expired; reconnect to sign in again";
      } else if (cachedError) {
        health = /401|403|unauthori[sz]ed|expired|revoked|authoriz|rejected/i.test(cachedError) ? "expired" : "error";
        detail = safeText(cachedError);
      } else if (shape || entry) {
        health = "ok";
      }
      break;
    }
    case "oauth-app": {
      const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
      const tokens = cfg ? await loadTokens(cfg.provider, ctx.home ? { home: ctx.home } : {}).catch(() => undefined) : undefined;
      if (tokens) {
        const scopes = scopesOf(tokens.scope);
        if (scopes) out.scopes = scopes;
        if (tokens.meta?.account) out.account = tokens.meta.account;
        if (tokens.meta?.connectedAt) out.connectedAt = tokens.meta.connectedAt;
        if (tokens.needsReauth || (tokens.expiresAt !== undefined && tokens.expiresAt <= ctx.now() && !tokens.refreshToken && !cfg?.customRefresh)) {
          health = "expired";
          detail = "the access token expired; reconnect to sign in again";
        } else {
          health = "ok";
        }
      }
      break;
    }
    case "browser": {
      const b = await browserHealth(browserSessionFile(service.id, ctx.home), ctx.now());
      if (b.connectedAt) out.connectedAt = b.connectedAt;
      if (b.health) health = b.health;
      if (b.detail) detail = b.detail;
      break;
    }
    case "api-key":
      break;
  }

  const test = recallTest(ctx.home, service.id);
  if (test) {
    const account = cleanAccount(test.account);
    if (account) out.account = account;
    if (!health || health === "ok") {
      if (ctx.now() - test.checkedAt < TEST_FRESH_MS) {
        if (test.ok) health = "ok";
        else {
          health = /expired|rejected|unauthori|reconnect/i.test(test.detail) ? "expired" : "error";
          detail = safeText(test.detail);
        }
      }
    }
  }

  if (health) out.health = health;
  if (detail && health && health !== "ok") out.healthDetail = safeText(detail);
  return out;
}

/** Catalog-known custom-ness: a server in mcp-remote.json no registry row owns. */
export function isCustomEntry(id: string, knownIds: Set<string>): boolean {
  return !knownIds.has(id) && !catalogById(id);
}
