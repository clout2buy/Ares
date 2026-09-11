// Rendezvous — how a permanently-installed connector re-finds home.
//
// The one-time connector has the server's URL baked in at download time, which
// is fine for a script that lives ten minutes. A device paired FOREVER cannot
// work that way: a Cloudflare quick tunnel returns on a different random
// *.trycloudflare.com hostname every restart, a LAN IP moves on DHCP lease, and
// the owner's machine reboots. A baked-in URL means the device is orphaned by
// the first hiccup and never comes back — which is exactly the failure the
// one-time link already suffers.
//
// So a paired device resolves its way home through a ladder, cheapest first:
//
//   1. last-known-good address, cached on the device
//   2. LAN discovery — this module: a UDP probe the owner's server answers
//   3. an optional rendezvous URL for off-LAN devices (owner-configured)
//
// Rung 2 is the important one. For the case the owner actually described — "my
// database box, connected forever" — the device and the server are on the same
// network, so this resolves with NO cloud in the path at all: no tunnel, no
// gateway, no Cloudflare, nothing to churn and nothing to pay for.

import { createSocket as createUdpSocket, type Socket as UdpSocket } from "node:dgram";

/** Fixed discovery port. Deliberately NOT the agent port (7422): discovery is
 *  UDP and must keep working when the TCP listener has moved or is rebinding. */
export const DISCOVERY_PORT = 7423;
/** Magic prefix so a stray packet on a busy LAN is never mistaken for a probe. */
export const DISCOVERY_MAGIC = "ares-remote-discover/1";
export const DISCOVERY_REPLY_MAGIC = "ares-remote-here/1";

export interface DiscoveryAnswer {
  /** Base URL the connector should dial — LAN or public, whichever is current. */
  baseUrl: string;
  /** Owner's hostname, shown to the device's user so they know whose Ares it is. */
  host: string;
}

/**
 * Probe payload. Carries the deviceId so the responder can decline to answer a
 * device it has never heard of: an unpaired machine on the LAN learns nothing
 * about whether an Ares is running, and the registry is not a discovery oracle.
 */
export function buildDiscoveryProbe(deviceId: string): Buffer {
  return Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, deviceId }), "utf8");
}

export function parseDiscoveryProbe(raw: Buffer): { deviceId: string } | null {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch { return null; }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj["magic"] !== DISCOVERY_MAGIC) return null;
  const deviceId = typeof obj["deviceId"] === "string" ? obj["deviceId"] : "";
  return deviceId ? { deviceId } : null;
}

export function buildDiscoveryReply(answer: DiscoveryAnswer): Buffer {
  return Buffer.from(JSON.stringify({ magic: DISCOVERY_REPLY_MAGIC, ...answer }), "utf8");
}

export function parseDiscoveryReply(raw: Buffer): DiscoveryAnswer | null {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); }
  catch { return null; }
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj["magic"] !== DISCOVERY_REPLY_MAGIC) return null;
  const baseUrl = typeof obj["baseUrl"] === "string" ? obj["baseUrl"] : "";
  if (!baseUrl) return null;
  return { baseUrl, host: typeof obj["host"] === "string" ? obj["host"] : "unknown" };
}

/**
 * Every address worth sending a probe to.
 *
 * The global broadcast 255.255.255.255 alone is NOT enough. Stacks differ in
 * whether they route it, and on a multi-homed host it goes out one interface of
 * the kernel's choosing — which is the wrong one about as often as not. The
 * concrete case this was written for: the owner's PC is on Ethernet and the
 * device is on WiFi. Same router, same broadcast domain, but the probing host
 * may have several interfaces (WiFi, Ethernet, a VM switch, a VPN adapter) and
 * only one of them faces the router.
 *
 * So: a subnet-directed broadcast per non-internal IPv4 interface (derived from
 * that interface's own netmask), plus the global address as a backstop. Sending
 * a handful of tiny UDP packets is free; missing the right interface is not.
 */
export function broadcastTargets(
  interfaces: Record<string, Array<{ family: string; internal: boolean; address: string; netmask: string }> | undefined>,
): string[] {
  const targets: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const iface of list ?? []) {
      // node <18 reports family as "IPv4"; newer as 4. Accept both.
      const isV4 = iface.family === "IPv4" || (iface.family as unknown) === 4;
      if (!isV4 || iface.internal) continue;
      const bcast = subnetBroadcast(iface.address, iface.netmask);
      if (bcast && !targets.includes(bcast)) targets.push(bcast);
    }
  }
  if (!targets.includes("255.255.255.255")) targets.push("255.255.255.255");
  return targets;
}

/** Broadcast address for an IPv4 address/netmask pair, or null if unparseable. */
export function subnetBroadcast(address: string, netmask: string): string | null {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  if (a.length !== 4 || m.length !== 4) return null;
  if (a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (m.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  // A /32 has no meaningful broadcast address — probing it is just a unicast
  // to ourselves, which would look like a working discovery that never answers.
  if (m.every((n) => n === 255)) return null;
  return a.map((oct, i) => (oct & m[i]) | (~m[i] & 0xff)).join(".");
}

export interface DiscoveryResponderOptions {
  /** Current base URL to hand out. Called per probe, never cached: the whole
   *  point is that this value changes underneath us. */
  currentBaseUrl: () => string | undefined;
  /** Whether this deviceId is one of ours. Unknown devices get silence. */
  knowsDevice: (deviceId: string) => boolean;
  host: string;
  port?: number;
  log?: (line: string) => void;
}

/**
 * Answers discovery probes from paired devices on the LAN.
 *
 * Best-effort by construction: a bind failure (another Ares already listening,
 * a locked-down host) must never take down the agent server, so start()
 * resolves either way and the ladder simply falls through to its other rungs.
 */
export class DiscoveryResponder {
  private sock?: UdpSocket;
  private readonly opts: DiscoveryResponderOptions;
  private readonly log: (line: string) => void;

  constructor(opts: DiscoveryResponderOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  async start(): Promise<boolean> {
    const port = this.opts.port ?? DISCOVERY_PORT;
    return new Promise<boolean>((resolve) => {
      let sock: UdpSocket;
      try { sock = createUdpSocket({ type: "udp4", reuseAddr: true }); }
      catch { resolve(false); return; }

      const giveUp = (why: string) => {
        this.log(`remote-agent discovery unavailable (${why}) — paired devices fall back to their cached address`);
        try { sock.close(); } catch { /* never bound */ }
        this.sock = undefined;
        resolve(false);
      };
      sock.once("error", (err) => giveUp(err.message));

      sock.on("message", (raw, rinfo) => {
        const probe = parseDiscoveryProbe(raw);
        if (!probe) return;
        if (!this.opts.knowsDevice(probe.deviceId)) return; // silence, not a refusal
        const baseUrl = this.opts.currentBaseUrl();
        if (!baseUrl) return;
        const reply = buildDiscoveryReply({ baseUrl, host: this.opts.host });
        sock.send(reply, rinfo.port, rinfo.address, () => { /* fire and forget */ });
      });

      sock.bind(port, () => {
        sock.off("error", giveUp as never);
        sock.on("error", (err) => this.log(`remote-agent discovery error: ${err.message}`));
        try { sock.setBroadcast(true); } catch { /* not fatal — directed probes still work */ }
        this.sock = sock;
        this.log(`remote-agent discovery listening on udp/${port}`);
        resolve(true);
      });
    });
  }

  close(): void {
    try { this.sock?.close(); } catch { /* already closed */ }
    this.sock = undefined;
  }
}

export interface ProbeResult extends DiscoveryAnswer {
  /** Which address answered — useful when diagnosing a multi-interface host. */
  from: string;
}

/**
 * Ask the LAN where home is. Resolves with the first answer, or null on timeout.
 *
 * Fires at every target concurrently rather than walking them in sequence: the
 * timeout is the user-visible cost of a device that cannot find its owner, and
 * probing six addresses serially at 400ms each is a connector that looks hung.
 */
export async function probeForServer(
  deviceId: string,
  opts: { targets?: string[]; port?: number; timeoutMs?: number } = {},
): Promise<ProbeResult | null> {
  const { networkInterfaces } = await import("node:os");
  const targets = opts.targets ?? broadcastTargets(networkInterfaces() as never);
  const port = opts.port ?? DISCOVERY_PORT;
  const timeoutMs = opts.timeoutMs ?? 1_500;

  return new Promise<ProbeResult | null>((resolve) => {
    let sock: UdpSocket;
    try { sock = createUdpSocket({ type: "udp4", reuseAddr: true }); }
    catch { resolve(null); return; }

    let settled = false;
    const done = (value: ProbeResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    timer.unref?.();

    sock.on("error", () => done(null));
    sock.on("message", (raw, rinfo) => {
      const answer = parseDiscoveryReply(raw);
      if (answer) done({ ...answer, from: rinfo.address });
    });

    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* directed targets may still work */ }
      const probe = buildDiscoveryProbe(deviceId);
      for (const target of targets) {
        sock.send(probe, port, target, () => { /* a dead target is not an error */ });
      }
    });
  });
}
