// The host card: a small, always-current fact sheet about the machine an agent
// runs ON, appended to the PER-SESSION prompt layer (never the shared core
// prompt, which is under a hard size budget).
//
// Why it exists (2026-10-01): a persona agent running on the garrison box was
// asked to start something "on doingbox", tried to SSH/ping a stale address out
// of its notes, and told the owner the box was off the network - while it was
// running on the box. An agent has no built-in fact about where it lives, so a
// stale note beats nothing. The card is that fact, recomputed from the OS
// (network interfaces cached for 60 s, so a DHCP change shows up within a
// minute), and it ends with the rule the incident broke.
//
// Absent for guest tenants (a stranger must not learn the owner's LAN layout)
// and for sessions that are not on a garrison host.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hard ceiling on the rendered card, rule line included. */
export const HOST_CARD_MAX_CHARS = 600;
const IP_CACHE_MS = 60_000;

/** Bridges and tunnels are not "the box's address": a docker0 IP is never what the phone or a LAN peer uses. */
const VIRTUAL_IFACE = /^(lo|docker\d*|br-|veth|virbr|cni|flannel|cali|tun|tap|tailscale|zt|wg|vmnet|vboxnet|utun|awdl|llw|bridge|anpi)/i;

export interface HostFacts {
  hostname: string;
  /** What the owner calls this machine, when known ("doingbox"). */
  nickname?: string;
  ips: string[];
  os: string;
  uptimeSec: number;
  version: string;
  sha?: string;
  service?: string;
  cwd: string;
  /** Host of the public URL the phone connects over, when there is one. */
  phoneHost?: string;
  owner?: string;
}

/** Primary LAN IPv4s: private ranges first, virtual interfaces dropped, at most three. */
export function lanAddresses(nets: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const found: Array<{ ip: string; rank: number }> = [];
  for (const [name, list] of Object.entries(nets)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      const rank = /^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
      found.push({ ip: a.address, rank });
    }
  }
  found.sort((x, y) => x.rank - y.rank);
  return [...new Set(found.map((f) => f.ip))].slice(0, 3);
}

function uptimeWords(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** Pure: facts in, card out. Always under HOST_CARD_MAX_CHARS and always ends with the rule line. */
export function renderHostCard(f: HostFacts): string {
  const rule = "Never SSH/ping to reach this machine: you are on it. Stale addresses in memory are wrong; trust this card or run `hostname -I`.";
  const aka = f.nickname ? ` (the box the owner calls ${f.nickname})` : "";
  const parts = [
    `You run ON this machine: ${f.hostname}${aka}.`,
    f.ips.length ? `LAN IP now: ${f.ips.join(", ")}.` : "No LAN address up right now.",
    `${f.os}, up ${uptimeWords(f.uptimeSec)}.`,
    `Ares ${f.version}${f.sha ? ` @${f.sha}` : ""}${f.service ? `, service ${f.service}` : ""}.`,
    `Cwd ${f.cwd}.`,
    f.owner || f.phoneHost ? `Owner${f.owner ? ` ${f.owner}` : ""}: phone connects ${f.phoneHost ? `via ${f.phoneHost}` : "over the LAN"}.` : "",
  ].filter(Boolean);
  const head = "## Host card\n";
  // Shed the least important facts first until it fits; the rule line never goes.
  let body = parts.join(" ");
  const dropOrder = [5, 4, 2];
  for (const i of dropOrder) {
    if ((head + body + "\n" + rule).length <= HOST_CARD_MAX_CHARS) break;
    parts[i] = "";
    body = parts.filter(Boolean).join(" ");
  }
  let card = `${head}${body}\n${rule}`;
  if (card.length > HOST_CARD_MAX_CHARS) card = `${head}${body.slice(0, Math.max(0, HOST_CARD_MAX_CHARS - head.length - rule.length - 2))}\n${rule}`;
  return card;
}

// ─── live facts ────────────────────────────────────────────────────────────

let cachedSha: string | undefined;
let shaStarted = false;

/** Resolve the running build's short sha once, off the hot path. The prompt never awaits it. */
export function primeHostSha(): void {
  if (shaStarted) return;
  shaStarted = true;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    execFile("git", ["-C", here, "rev-parse", "--short", "HEAD"], { timeout: 3_000, windowsHide: true }, (err, out) => {
      const v = String(out ?? "").trim();
      if (!err && /^[0-9a-f]{6,40}$/.test(v)) cachedSha = v;
    });
  } catch { /* no git: the version alone will do */ }
}

export interface HostCardOptions {
  /** Version string of the running Ares. */
  version?: () => string;
  /** The public URL the phone connects over (the tunnel), if any. */
  phoneUrl?: () => string | undefined;
  now?: () => number;
  /** Test seams. */
  networkInterfaces?: typeof os.networkInterfaces;
  hostname?: () => string;
  uptime?: () => number;
}

let ipCache: { at: number; ips: string[] } | null = null;
let versionHint = "";

/** Reset module caches (tests). */
export function resetHostCardCache(): void {
  ipCache = null;
  cachedSha = undefined;
  shaStarted = false;
}

/** The card for this machine, now. Sync: composing a prompt never awaits. */
export function hostCardBlock(opts: HostCardOptions = {}): string {
  const now = (opts.now ?? Date.now)();
  if (!ipCache || now - ipCache.at >= IP_CACHE_MS) {
    ipCache = { at: now, ips: lanAddresses((opts.networkInterfaces ?? os.networkInterfaces)()) };
  }
  const hostname = (opts.hostname ?? os.hostname)();
  const nick = process.env.ARES_HOST_NICKNAME?.trim() || (/doingbox/i.test(hostname) ? "doingbox" : undefined);
  let phoneHost: string | undefined;
  try {
    const u = opts.phoneUrl?.();
    if (u) phoneHost = new URL(u).host;
  } catch { /* not a URL: leave it out */ }
  const version = opts.version?.() || versionHint || "dev";
  if (opts.version) versionHint = version;
  return renderHostCard({
    hostname,
    ...(nick ? { nickname: nick } : {}),
    ips: ipCache.ips,
    os: `${os.type()} ${os.release()}`,
    uptimeSec: (opts.uptime ?? os.uptime)(),
    version,
    ...(cachedSha ? { sha: cachedSha } : {}),
    ...(process.env.ARES_SERVICE_NAME || process.env.INVOCATION_ID ? { service: process.env.ARES_SERVICE_NAME ?? "ares-garrison" } : {}),
    cwd: process.cwd(),
    ...(process.env.ARES_OWNER_NAME?.trim() ? { owner: process.env.ARES_OWNER_NAME.trim() } : {}),
    ...(phoneHost ? { phoneHost } : {}),
  });
}

/** The card for a session's tenant: owners get it, a guest (or an unknown tenant) never does. */
export function hostCardFor(tenant: { role?: string } | undefined, opts: HostCardOptions = {}): string {
  return tenant?.role === "guest" ? "" : hostCardBlock(opts);
}
