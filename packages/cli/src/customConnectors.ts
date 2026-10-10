// Custom connectors — remote MCP servers the owner adds by URL from the phone.
//
// SECURITY-SENSITIVE: this lets a phone make the box connect outward. So:
//   - https only, no credentials or fragment in the URL, <= 2048 chars;
//   - the host must be a public name or address: localhost, single-label,
//     .local/.internal/.lan/.home/.corp names and every loopback / private /
//     link-local / CGNAT / reserved IPv4 and IPv6 range are refused, and the
//     name is RESOLVED and every answer checked (DNS that points inward is
//     refused too). ARES_CONNECTIONS_ALLOW_PRIVATE=1 lifts the host check only;
//   - redirects are never followed by the probe (a public host can't bounce it
//     inward);
//   - names are 1-48 printable characters; the connector id is a slug of it and
//     may not collide with a registry service or an existing connector;
//   - at most 20 custom connectors.
//
// Connecting reuses the existing machinery: an open server (answers an
// unauthenticated initialize + tools/list) is registered directly; a server
// that answers 401/403 goes through the ConnectHub's OAuth landing
// (`/connect/<flow>`), whose URL is returned as `authUrl` for the phone to open.
// The hub itself falls back to a paste-a-token form when the server refuses
// dynamic client registration — the same URL serves that form.
//
// Residual risk (documented, not hidden): after the check the connect code
// resolves the host again; a DNS-rebinding attacker who controls the name could
// answer differently. The owner is the only caller (bearer-gated), so this is
// the owner pointing the box at their own choice of server.

import dns from "node:dns";
import net from "node:net";
import {
  CONNECT_SERVICES,
  addOpenMcpServer,
  catalogById,
  disconnectMcpServer,
  getConnectBroker,
  getCredential,
  loadRemoteMcpServers,
  probeMcpTools,
  type ConnectBroker,
  type ConnectService,
  type RemoteMcpEntry,
} from "@ares/core";
import { safeText } from "./connectionsSafe.js";
import type { FetchLike } from "./connectionsTest.js";
import type { McpToolsCache } from "./connectionsEnrich.js";

export const MAX_CUSTOM = 20;
export const MAX_URL_LENGTH = 2048;
export const MAX_NAME_LENGTH = 48;
const PROBE_TIMEOUT_MS = 8_000;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

export function validateName(input: unknown): string {
  if (typeof input !== "string") throw new HttpError(400, "name required");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) throw new HttpError(400, "name must not contain control characters");
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) throw new HttpError(400, "name required");
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `name must be at most ${MAX_NAME_LENGTH} characters`);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) {
    throw new HttpError(400, "name may use letters, numbers, spaces, dots, dashes and underscores, and must start with a letter or number");
  }
  return name;
}

/** The connector id: lowercase slug of the name. */
export function slugOfName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!slug) throw new HttpError(400, "name must contain at least one letter or number (a-z, 0-9)");
  return slug;
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

function inV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3], // multicast + reserved + broadcast
];

/** True when `ip` is loopback / private / link-local / reserved (v4 or v6). */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return PRIVATE_V4.some(([base, bits]) => inV4(ip, base, bits));
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if (first === 0) return true; // ::, ::1 and the rest of ::/8 are never public
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith("2001:db8:") || lower.startsWith("64:ff9b:")) return true; // documentation / NAT64
    return false;
  }
  return true; // not an address at all → treat as unsafe
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".localdomain", ".home.arpa"];

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolve: ResolveHost = async (host) => {
  const answers = await dns.promises.lookup(host, { all: true });
  return answers.map((a) => a.address);
};

export function allowPrivateTargets(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.ARES_CONNECTIONS_ALLOW_PRIVATE ?? "");
}

export interface UrlCheckOptions {
  resolveHost?: ResolveHost;
  allowPrivate?: boolean;
}

/** Validate and normalise a connector URL. Throws HttpError(400) when unsafe. */
export async function validateConnectorUrl(input: unknown, opts: UrlCheckOptions = {}): Promise<string> {
  if (typeof input !== "string" || !input.trim()) throw new HttpError(400, "url required");
  const raw = input.trim();
  if (raw.length > MAX_URL_LENGTH) throw new HttpError(400, `url must be at most ${MAX_URL_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(raw)) throw new HttpError(400, "url must not contain spaces or control characters");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "url must start with https://");
  if (url.username || url.password) throw new HttpError(400, "url must not contain credentials");
  if (url.hash) throw new HttpError(400, "url must not contain a fragment");

  const allowPrivate = opts.allowPrivate ?? allowPrivateTargets();
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
    if (!host) throw new HttpError(400, "url has no host");
    const literal = net.isIP(host);
    if (literal) {
      if (isPrivateAddress(host)) throw new HttpError(400, "url points at a private or local address");
    } else {
      if (host === "localhost" || !host.includes(".") || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
        throw new HttpError(400, "url points at a private or local host");
      }
      let addresses: string[];
      try {
        addresses = await (opts.resolveHost ?? defaultResolve)(host);
      } catch {
        throw new HttpError(400, "url's host could not be resolved");
      }
      if (!addresses.length) throw new HttpError(400, "url's host could not be resolved");
      if (addresses.some(isPrivateAddress)) throw new HttpError(400, "url's host resolves to a private or local address");
    }
  }
  // Keep the path/query the owner gave; drop nothing but normalise via URL.
  return url.toString();
}

// ─── Registry view ───────────────────────────────────────────────────────────

export interface CustomServerView {
  id: string;
  name: string;
  url: string;
  status: "connected" | "needs_auth" | "error";
  toolCount?: number;
  detail?: string;
}

/** Ids no custom connector may take: the registry's rows and catalog. */
function registryIds(): Set<string> {
  return new Set(CONNECT_SERVICES.map((s) => s.id));
}

export function isCustomId(id: string, remote: Record<string, RemoteMcpEntry>): boolean {
  return Boolean(remote[id]) && !registryIds().has(id) && !catalogById(id);
}

/** A ConnectService for a custom connector, so start/test/disconnect reuse the registry paths. */
export function customService(id: string, entry: Pick<RemoteMcpEntry, "url" | "displayName" | "oauth" | "vault">): ConnectService {
  const label = entry.displayName ?? id;
  return {
    id,
    label,
    kind: entry.oauth ? "mcp-oauth" : "mcp-key",
    blurb: `Custom connector ${label}.`,
    keywords: [],
    howToUse: `Its tools arrive as mcp_${id}_<tool>.`,
    mcpUrl: entry.url,
  };
}

export async function listCustom(home: string | undefined, cache: McpToolsCache): Promise<CustomServerView[]> {
  const remote = await loadRemoteMcpServers(home).catch(() => ({} as Record<string, RemoteMcpEntry>));
  const out: CustomServerView[] = [];
  for (const [id, entry] of Object.entries(remote)) {
    if (!isCustomId(id, remote)) continue;
    const cached = cache[id];
    let status: CustomServerView["status"] = "connected";
    let detail: string | undefined;
    if (entry.oauth || entry.vault) {
      const token = await getCredential(`mcp.token.${id}`, home ? { home } : {}).catch(() => undefined);
      if (!token) {
        status = "needs_auth";
        detail = "sign in again to reconnect";
      }
    }
    if (status === "connected" && cached?.error) {
      if (/401|403|unauthori[sz]ed|expired|revoked|authoriz|rejected/i.test(cached.error)) {
        status = "needs_auth";
        detail = "the server rejected the saved sign-in";
      } else {
        status = "error";
        detail = safeText(cached.error, [], 160);
      }
    }
    out.push({
      id,
      name: entry.displayName ?? id,
      url: entry.url,
      status,
      ...(cached?.tools ? { toolCount: cached.tools.length } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  return out;
}

// ─── Add / remove ────────────────────────────────────────────────────────────

export interface AddCustomOptions {
  home?: string;
  fetchImpl?: FetchLike;
  resolveHost?: ResolveHost;
  allowPrivate?: boolean;
  broker?: ConnectBroker | null;
  log?: (line: string) => void;
}

export async function addCustom(body: Record<string, unknown>, opts: AddCustomOptions): Promise<{ id: string; status: "connected" | "needs_auth"; authUrl?: string }> {
  const name = validateName(body.name);
  const id = slugOfName(name);
  const url = await validateConnectorUrl(body.url, { resolveHost: opts.resolveHost, allowPrivate: opts.allowPrivate });
  if (registryIds().has(id) || catalogById(id)) throw new HttpError(409, `"${name}" is already a built-in connector — pick another name`);
  const remote = await loadRemoteMcpServers(opts.home);
  if (remote[id]) throw new HttpError(409, `a connector named "${name}" already exists`);
  if (Object.keys(remote).filter((k) => isCustomId(k, remote)).length >= MAX_CUSTOM) {
    throw new HttpError(409, `at most ${MAX_CUSTOM} custom connectors — remove one first`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  const base: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  // Never follow redirects: a public host must not be able to bounce the probe inward.
  const guarded: FetchLike = (u, init) => base(u, { ...init, redirect: "manual", signal: controller.signal });
  let needsAuth = false;
  try {
    const probe = await probeMcpTools(url, undefined, guarded);
    const added = await addOpenMcpServer(id, url, { displayName: name, ...(opts.home ? { home: opts.home } : {}) });
    if (!added) throw new HttpError(409, `a connector named "${name}" already exists`);
    opts.log?.(`connections: custom connector ${id} added (open server, ${probe.toolCount} tools)`);
    return { id, status: "connected" };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP (401|403)/.test(message)) needsAuth = true;
    else throw new HttpError(502, `couldn't reach an MCP server at that address: ${safeText(message, [], 140)}`);
  } finally {
    clearTimeout(timer);
  }

  if (needsAuth) {
    const broker = opts.broker === undefined ? getConnectBroker() : opts.broker;
    if (!broker) throw new HttpError(503, "this machine has no connect hub (it needs a public address)");
    const service = customService(id, { url, displayName: name, oauth: true });
    try {
      const prompt = await broker.start(service, { reason: "a custom connector added from the Connections screen" });
      opts.log?.(`connections: custom connector ${id} needs sign-in; flow started`);
      return { id, status: "needs_auth", authUrl: prompt.url };
    } catch (err) {
      throw new HttpError(502, safeText(err, [], 200));
    }
  }
  throw new HttpError(502, "couldn't connect");
}

export async function removeCustom(id: unknown, opts: { home?: string; log?: (line: string) => void }): Promise<boolean> {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new HttpError(400, "id required");
  const remote = await loadRemoteMcpServers(opts.home);
  if (!isCustomId(id, remote)) throw new HttpError(404, "no such custom connector");
  const removed = await disconnectMcpServer(id, opts.home);
  opts.log?.(`connections: custom connector ${id} removed`);
  return removed;
}
