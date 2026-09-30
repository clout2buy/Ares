// Network guard for every outbound request the universal connectors make
// (Api, Mqtt). The model chooses what to call; this decides where it may go.
//
//   Always refused   link-local (169.254/16, fe80::/10), cloud metadata
//                    endpoints (169.254.169.254, fd00:ec2::254, 100.100.100.200,
//                    168.63.129.16, metadata.google.internal …), unspecified,
//                    multicast/broadcast, documentation and reserved ranges.
//   Refused unless   loopback, RFC1918, CGNAT (100.64/10), ULA (fc00::/7) — a
//   the owner allows LAN service such as Home Assistant may be reached only when its
//   the LAN for it   definition says allowLan, and only that service.
//   Scheme           https always; http only for a LAN-allowed service and only
//                    when every address the host resolves to is private.
//
// DNS rebinding: validation happens INSIDE the `lookup` function the socket
// connects with, so the address that was checked is the address that is used —
// there is no second resolution an attacker's DNS could answer differently.
// Redirects are followed by hand: each hop goes through the same checks, a
// change of origin strips every credential the request carried, a redirect to
// another origin is refused for anything but GET/HEAD, and https never
// downgrades to http.

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

export type AddressClass = "public" | "private" | "loopback" | "linklocal" | "metadata" | "unspecified" | "multicast" | "reserved";

export class NetBlockedError extends Error {
  readonly code = "NET_BLOCKED";
}

// ─── Address classification ──────────────────────────────────────────────────

function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return out.some((n) => !(n >= 0 && n <= 255)) ? null : out;
}

function classifyV4(o: number[]): AddressClass {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 169 && b === 254 && c === 169 && o[3] === 254) return "metadata";
  if (a === 100 && b === 100 && c === 100 && o[3] === 200) return "metadata"; // Alibaba
  if (a === 168 && b === 63 && c === 129 && o[3] === 16) return "metadata"; // Azure wireserver
  if (a === 192 && b === 0 && c === 0 && o[3] === 192) return "metadata"; // Oracle
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 169 && b === 254) return "linklocal";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  return "public";
}

/** Expand an IPv6 literal to eight 16-bit groups (handles :: and a dotted tail). */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const o = v4Octets(text.slice(lastColon + 1));
    if (!o) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function embeddedV4(g: number[], hi: number, lo: number): number[] {
  return [(g[hi]! >> 8) & 255, g[hi]! & 255, (g[lo]! >> 8) & 255, g[lo]! & 255];
}

function classifyV6(g: number[]): AddressClass {
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return "unspecified";
  if (allZero(0, 7) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96)
  if (allZero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return classifyV4(embeddedV4(g, 6, 7));
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return classifyV4(embeddedV4(g, 6, 7));
  // 6to4 (2002::/16) carries the v4 address in bits 16-47
  if (g[0] === 0x2002) return classifyV4(embeddedV4(g, 1, 2));
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && allZero(2, 7) && g[7] === 0x254) return "metadata"; // AWS IMDS v6
  if ((g[0]! & 0xffc0) === 0xfe80) return "linklocal";
  if ((g[0]! & 0xfe00) === 0xfc00) return "private";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "reserved";
  return "public";
}

export function classifyAddress(ip: string): AddressClass {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bare)) {
    const o = v4Octets(bare);
    return o ? classifyV4(o) : "reserved";
  }
  if (net.isIPv6(bare)) {
    const g = expandV6(bare);
    return g ? classifyV6(g) : "reserved";
  }
  return "reserved";
}

const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal", "metadata.azure.com"]);

export interface GuardPolicy {
  /** The owner allowed this service on the LAN (private/loopback, plain http). */
  allowLan: boolean;
}

/** Throw unless an address of this class may be connected to under the policy. */
export function assertAddressClass(cls: AddressClass, address: string, policy: GuardPolicy): void {
  switch (cls) {
    case "public":
      return;
    case "private":
    case "loopback":
      if (policy.allowLan) return;
      throw new NetBlockedError(`${address} is a private/loopback address. Only a service the owner explicitly allowed on the LAN may use one.`);
    case "metadata":
      throw new NetBlockedError(`${address} is a cloud metadata address. It is always blocked.`);
    case "linklocal":
      throw new NetBlockedError(`${address} is a link-local address. It is always blocked.`);
    default:
      throw new NetBlockedError(`${address} is a ${cls} address. It is always blocked.`);
  }
}

/** Static checks on a URL before any DNS: scheme, literal hosts, metadata names. */
export function assertUrlAllowed(url: URL, policy: GuardPolicy): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetBlockedError(`only http(s) URLs are allowed (got ${url.protocol})`);
  if (url.username || url.password) throw new NetBlockedError("URLs with embedded credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) throw new NetBlockedError("URL has no host");
  if (METADATA_NAMES.has(host)) throw new NetBlockedError(`${host} is a cloud metadata host. It is always blocked.`);
  const literal = net.isIP(host) !== 0;
  if (literal) {
    const cls = classifyAddress(host);
    assertAddressClass(cls, host, policy);
    if (url.protocol === "http:" && cls === "public") throw new NetBlockedError("plain http to a public address is not allowed; use https");
  } else {
    if (host === "localhost" || host.endsWith(".localhost")) assertAddressClass("loopback", host, policy);
    if (url.protocol === "http:" && !policy.allowLan) throw new NetBlockedError("plain http is only allowed for a service the owner allowed on the LAN; use https");
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * The `lookup` a socket connects with. Every address the name resolves to is
 * classified; one blocked address fails the lot (a split answer is a rebinding
 * tell). `lanOnly` (plain http) additionally demands every address be private.
 */
export function guardedLookup(policy: GuardPolicy, opts: { lanOnly?: boolean; resolver?: Resolver } = {}): net.LookupFunction {
  const resolve = opts.resolver ?? defaultResolver;
  return (hostname, options, callback) => {
    resolve(hostname)
      .then((list) => {
        if (!list.length) throw new NetBlockedError(`${hostname} did not resolve`);
        for (const entry of list) {
          const cls = classifyAddress(entry.address);
          assertAddressClass(cls, `${hostname} -> ${entry.address}`, policy);
          if (opts.lanOnly && cls === "public") throw new NetBlockedError(`plain http to ${hostname} (${entry.address}) is not allowed; use https`);
        }
        const wantsAll = typeof options === "object" && options !== null && (options as dns.LookupOptions).all;
        if (wantsAll) (callback as unknown as (err: null, list: Array<{ address: string; family: number }>) => void)(null, list);
        else callback(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: unknown) => (callback as (err: Error) => void)(err instanceof Error ? err : new Error(String(err))));
  };
}

// ─── Guarded fetch ───────────────────────────────────────────────────────────

export interface SafeFetchOptions extends GuardPolicy {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  resolver?: Resolver;
  /** Header names (lowercase) that carry credentials; dropped on a change of origin. */
  credentialHeaders?: string[];
  /** Query parameter names that carry credentials; dropped on a change of origin. */
  credentialQuery?: string[];
  /** Accept a self-signed certificate (LAN services such as Home Assistant over https). */
  insecureTls?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The body hit maxBytes and was cut. */
  truncated: boolean;
  /** The URL that finally answered (credentials in the query are NOT stripped here; mask before showing). */
  finalUrl: string;
  redirects: string[];
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ALWAYS_STRIP_ON_CROSS_ORIGIN = ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-auth-token"];

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && (a.port || (a.protocol === "https:" ? "443" : "80")) === (b.port || (b.protocol === "https:" ? "443" : "80"));
}

function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const enc = (encoding ?? "").toLowerCase().trim();
  try {
    if (enc === "gzip" || enc === "x-gzip") return zlib.gunzipSync(body, { maxOutputLength: maxBytes });
    if (enc === "br") return zlib.brotliDecompressSync(body, { maxOutputLength: maxBytes });
    if (enc === "deflate") return zlib.inflateSync(body, { maxOutputLength: maxBytes });
  } catch (err) {
    // A bomb or a corrupt stream: hand back nothing rather than the raw bytes.
    throw new Error(`could not decode the ${enc} response (${err instanceof Error ? err.message : String(err)})`);
  }
  return body;
}

function once(url: URL, method: string, headers: Record<string, string>, body: string | Buffer | undefined, opts: SafeFetchOptions): Promise<{ status: number; headers: Record<string, string>; body: Buffer; truncated: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const secure = url.protocol === "https:";
  const lookup = net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : guardedLookup(opts, { lanOnly: !secure, resolver: opts.resolver });
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
        agent: false,
        ...(lookup ? { lookup } : {}),
        ...(secure ? { servername: net.isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: !opts.insecureTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let truncated = false;
        const compressed = /gzip|br|deflate/i.test(String(res.headers["content-encoding"] ?? ""));
        // A compressed body cannot be cut mid-stream and still decode; cap the wire bytes tighter.
        const cap = compressed ? Math.min(maxBytes, 8 * 1024 * 1024) : maxBytes;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          total += chunk.length;
          if (total > cap) {
            const room = cap - (total - chunk.length);
            if (room > 0) chunks.push(chunk.subarray(0, room));
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => {
          clearTimeout(deadline);
          try {
            const raw = Buffer.concat(chunks);
            const headersOut: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headersOut[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            const decoded = truncated && compressed ? Buffer.alloc(0) : decode(raw, headersOut["content-encoding"], maxBytes);
            resolve({ status: res.statusCode ?? 0, headers: headersOut, body: decoded, truncated: truncated || (decoded.length >= maxBytes && compressed) });
          } catch (err) {
            reject(err);
          }
        };
        res.on("end", finish);
        res.on("close", () => {
          if (truncated) finish();
        });
        res.on("error", (err) => {
          if (truncated) return;
          clearTimeout(deadline);
          reject(err);
        });
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    const onAbort = () => req.destroy(new Error("cancelled"));
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
    req.end(body);
  });
}

/** One guarded HTTP exchange, following redirects by hand. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetBlockedError(`not a valid URL: ${rawUrl.slice(0, 120)}`);
  }
  let method = (opts.method ?? "GET").toUpperCase();
  let body = opts.body;
  let headers: Record<string, string> = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (!headers["accept-encoding"]) headers["accept-encoding"] = "gzip, deflate";
  const maxRedirects = opts.maxRedirects ?? 3;
  const redirects: string[] = [];
  const credentialHeaders = new Set([...ALWAYS_STRIP_ON_CROSS_ORIGIN, ...(opts.credentialHeaders ?? []).map((h) => h.toLowerCase())]);
  for (let hop = 0; ; hop++) {
    assertUrlAllowed(url, opts);
    const res = await once(url, method, headers, body, opts);
    const location = res.headers.location;
    if (REDIRECTS.has(res.status) && location) {
      if (hop >= maxRedirects) throw new NetBlockedError(`too many redirects (more than ${maxRedirects})`);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new NetBlockedError("the server sent an invalid redirect");
      }
      if (url.protocol === "https:" && next.protocol === "http:") throw new NetBlockedError("refusing a redirect from https to http");
      const cross = !sameOrigin(url, next);
      if (cross) {
        if (method !== "GET" && method !== "HEAD") throw new NetBlockedError(`refusing a cross-origin redirect (${next.origin}) for a ${method} request`);
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !credentialHeaders.has(k)));
        for (const name of opts.credentialQuery ?? []) next.searchParams.delete(name);
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
      }
      redirects.push(next.href);
      url = next;
      continue;
    }
    return { status: res.status, headers: res.headers, body: res.body, truncated: res.truncated, finalUrl: url.href, redirects };
  }
}
