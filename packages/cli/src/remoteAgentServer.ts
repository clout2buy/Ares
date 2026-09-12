// RemoteAgentServer — HTTP + WebSocket bridge for on-the-fly remote PC help.
// The owner tells Ares someone needs help, Ares makes a one-time link, the
// owner forwards it, the friend taps it: on Windows a tiny .cmd downloads and
// runs a PowerShell connector (no Python, no install); on Mac/Linux one pasted
// command runs a Python connector. The PC dials home here over WebSocket and
// Ares can run commands on it and show popups.
//
// Reachability: a link is only useful if the friend can open it from wherever
// they are, so the server brings up a Cloudflare quick tunnel — finding
// cloudflared on PATH or fetching the official binary into ~/.ares/bin. If
// that fails the link is LAN-only and every caller is told so (`scope`).
//
// Runs on a separate port (default 7422, ARES_REMOTE_AGENT_PORT) so it never
// collides with the garrison WS gateway (7421).

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { createSocket as createUdpSocket } from "node:dgram";
import path from "node:path";
import { aresHome } from "@ares/core";
import {
  type DeviceRegistryFile,
  type PairedDevice,
  loadDeviceRegistry,
  saveDeviceRegistry,
} from "./remoteDevices.js";
import {
  type AttachState,
  enrollDevice,
  handleDeviceAuth,
  handleDeviceHello,
  renameDevice as renameDeviceIn,
  revokeDevice,
} from "./remoteEnrollment.js";
import { DiscoveryResponder, DISCOVERY_PORT } from "./remoteRendezvous.js";
import { buildDeviceConnectorPs1, buildV1UpdateScript, DEVICE_CONNECTOR_VERSION } from "./remoteDeviceConnector.js";
import { checkFirewall, firewallAdvice } from "./remoteFirewall.js";

export const DEFAULT_REMOTE_AGENT_PORT = 7422;
/** How long an unused link stays valid. */
/**
 * Application-level heartbeat period. Cloudflare closes any WebSocket idle for
 * 100s on Free/Pro (quick tunnels are Free), and their documented remedy is a
 * keepalive — which Ares had none of. A session spent READING rather than
 * typing is exactly that idle condition, so the link died roughly every 100
 * seconds and the connector reconnected, forever.
 *
 * The server drives it rather than the connectors: both connectors sit blocked
 * in a receive call, so answering a ping is free, whereas sending one on a
 * timer would need a cancellable receive in both PowerShell and Python.
 */
// 2s, not 30s. A connector that runs exec ASYNC only flushes a finished
// command's result when its next inbound frame arrives — so the heartbeat
// interval is also the worst-case exec-result latency. At 30s that made exec
// technically-working but unusable (~25s per command in a live test). 2s keeps
// exec responsive; the traffic is one tiny frame per device per 2s, nothing.
// (A connector that runs exec synchronously and replies inline wouldn't need
// this — that is the proper connector-side fix, tracked for the release.)
const HEARTBEAT_MS = 2_000;
/** Drop a PC that has not sent a frame in this long (≈3 missed heartbeats). */
const PEER_TIMEOUT_MS = 100_000;

const LINK_TTL_MS = 10 * 60 * 1000;
/** Once a PC has used its link, the same PC may reconnect on it for this long —
 *  a flaky wifi blip must not mean "send a new link". */
const REBIND_TTL_MS = 12 * 60 * 60 * 1000;
/** generateToken waits this long for a cold tunnel before handing out a LAN link. */
const TUNNEL_WAIT_MS = 25_000;

// ─── Public types ──────────────────────────────────────────────────────────

export interface RemotePcInfo {
  id: string;
  label: string;      // how the owner referred to this PC ("Sarah's PC")
  hostname: string;
  os: string;
  username: string;
  ip: string;
  connectedAt: number;
  /** Connector protocol version this machine is running, when it reports one.
   *  Absent means a pre-versioning connector — treat as 1. */
  connectorVersion?: number;
}

/** One HTTP round trip performed FROM a remote machine. */
export interface RemoteFetchResult {
  status: number;
  headers: Record<string, string>;
  dataBase64: string;
  size: number;
}

/** A live local→remote HTTP forward. */
export interface ForwardInfo {
  id: string;
  pcId: string;
  /** Origin on the remote machine, e.g. http://127.0.0.1:8090 */
  target: string;
  /** Where it is served on the owner's machine. */
  localUrl: string;
  port: number;
  createdAt: number;
  requests: number;
}

export interface ExecResult {
  output: string;
  exitCode?: number;
}

export type LinkScope = "public" | "lan";

export interface RemoteAgentServerOptions {
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 so LAN peers can reach it. */
  host?: string;
  /** Ares home — where a fetched cloudflared binary is cached (~/.ares/bin). */
  home?: string;
  /** Bearer token for the loopback control API (/api/*) that lets the daemon
   *  process — which runs the desktop and TUI chats — drive this server. The
   *  garrison passes its gateway token. Absent → the control API is off. */
  controlToken?: string;
  log?: (line: string) => void;
  /**
   * Controls tunnel behaviour for cross-network connections.
   * - "auto" (default): PATH cloudflared → cached binary → download; LAN fallback.
   * - "cloudflared": requires cloudflared; throws if not available.
   * - "none": always use LAN URL (tests, local-only setups).
   */
  tunnelMode?: "auto" | "cloudflared" | "none";
  /**
   * A PERMANENT public origin that fronts this port (e.g. a named Cloudflare
   * tunnel on a domain the owner controls). Env: ARES_REMOTE_PUBLIC_URL.
   *
   * This is what makes an off-LAN pairing survive a restart. A quick tunnel
   * comes back on a new random *.trycloudflare.com hostname every time, so a
   * connector that was installed against the old one is dialling an address
   * that no longer routes — and if it is not on this LAN, discovery cannot
   * rescue it either. It then retries forever against three dead candidates:
   * permanently paired on paper, a ghost in practice. A fixed origin never
   * goes stale, so the seed baked into the connector is good for its lifetime.
   */
  publicUrl?: string;
  /**
   * Bring a device up to THIS build's connector the moment it attaches,
   * without asking. Default on: the owner's own machines are supposed to just
   * work, and a device pinned on an old connector silently lacks capabilities.
   * ARES_REMOTE_AUTO_UPDATE=0 turns it off.
   */
  autoUpdateDevices?: boolean;
}

// ─── Internal state ────────────────────────────────────────────────────────

interface PendingCmd {
  /** Resolves with the whole result message (exec_result / screenshot_result / …). */
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** The op this is waiting on, so a bulk rejection can say what it killed. */
  op: string;
}

export interface FileGetResult {
  dataBase64: string;
  size: number;
}

interface RemotePcConn extends RemotePcInfo {
  ws: WebSocket;
  pendingCmds: Map<string, PendingCmd>;
  token: string;
  /** Last time ANY frame arrived from this PC. Drives dead-peer detection. */
  lastSeen: number;
  /** Set when this connection is a PAIRED device rather than a one-time help
   *  session. Paired devices survive reboots and may run elevated. */
  deviceId?: string;
}

interface LinkToken {
  label: string;
  expiresAt: number;
  /** "help" is the one-time assist link; "pair" enrols a permanent device.
   *  They must not be interchangeable: a help link that could enrol would turn
   *  a five-minute favour into permanent elevated access to that machine. */
  kind?: "help" | "pair";
  /** Set on first register; later registers must come from the same hostname. */
  boundHostname?: string;
}

// ─── Server ────────────────────────────────────────────────────────────────

export class RemoteAgentServer {
  private readonly opts: RemoteAgentServerOptions;
  private readonly log: (line: string) => void;
  private readonly home: string;
  private http?: HttpServer;
  private wss?: WebSocketServer;
  private readonly tokens = new Map<string, LinkToken>();
  private readonly pcs = new Map<string, RemotePcConn>();
  /**
   * Retired pcId → the deviceId it belonged to.
   *
   * A pcId identifies a CONNECTION, and a paired machine mints a fresh one on
   * every reconnect — sleep, wifi blip, garrison restart, the 100s idle close,
   * a connector update. Anything holding an id from five minutes ago (a chat
   * that was told "use this pc_id from here on", a queued step) then failed
   * with `No remote PC with id "…" connected` even though the machine was
   * sitting right there under a new id. Remembering the mapping lets a stale
   * id resolve forward to the device's current connection.
   */
  private readonly retiredPcIds = new Map<string, string>();
  private boundPort = 0;
  private boundHost = "0.0.0.0";
  private lanAddress = "127.0.0.1";
  private tunnelProc?: ChildProcess;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Set by close() so tunnel supervision doesn't fight a deliberate shutdown. */
  private closing = false;
  private tunnelRestarts = 0;
  private devices: DeviceRegistryFile = { version: 1, devices: [] };
  private discovery?: DiscoveryResponder;
  private publicBaseUrl?: string;
  /** Set from opts/env: a permanent origin, so nothing ever re-homes off it. */
  private stableBaseUrl?: string;
  /** Resolves (to the URL or undefined) once the tunnel attempt has finished either way. */
  private tunnelReady: Promise<string | undefined> = Promise.resolve(undefined);

  private readonly connectedListeners = new Set<(pc: RemotePcInfo) => void>();
  private readonly disconnectedListeners = new Set<(pc: RemotePcInfo) => void>();

  constructor(opts: RemoteAgentServerOptions = {}) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.home = opts.home ?? aresHome();
  }

  onPcConnected(cb: (pc: RemotePcInfo) => void): () => void {
    this.connectedListeners.add(cb);
    return () => { this.connectedListeners.delete(cb); };
  }

  onPcDisconnected(cb: (pc: RemotePcInfo) => void): () => void {
    this.disconnectedListeners.add(cb);
    return () => { this.disconnectedListeners.delete(cb); };
  }

  async start(): Promise<{ host: string; port: number }> {
    // Config is validated before ANYTHING is bound. A throw further down leaves
    // the caller with a half-started server it has no handle to close — a held
    // TCP port and a live UDP discovery socket for the life of the process.
    const stable = (this.opts.publicUrl ?? process.env["ARES_REMOTE_PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
    if (stable && !/^https?:\/\//i.test(stable)) {
      throw new Error(`ARES_REMOTE_PUBLIC_URL must be an http(s) origin, got "${stable}"`);
    }
    const port = this.opts.port ?? (Number(process.env["ARES_REMOTE_AGENT_PORT"]) || DEFAULT_REMOTE_AGENT_PORT);
    const host = this.opts.host ?? "0.0.0.0";
    const http = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 * 1024 });
    wss.on("connection", (ws) => this.handleConnection(ws));
    // `ws` forwards the HTTP server's errors onto the WebSocketServer, and an
    // "error" event with no listener THROWS. That made the listen guard below
    // a lie: the promise rejected and the caller caught it, but the re-emit
    // still took the process down as an uncaughtException. Cost: a second
    // garrison (or anything else already on 7422) crashed the whole daemon at
    // boot instead of coming up without the remote server.
    wss.on("error", (err) => this.log(`remote-agent socket error: ${err instanceof Error ? err.message : String(err)}`));
    this.http = http;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => { http.off("error", reject); resolve(); });
    });
    const addr = http.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : port;
    this.boundHost = host;
    this.lanAddress = await detectLanIp();
    this.log(`remote-agent listening on ${host}:${this.boundPort}`);
    this.startHeartbeat();

    // Paired devices. Machine-scoped on purpose (see remoteDevices.ts), so the
    // desktop app and a CLI garrison see the same list.
    this.devices = await loadDeviceRegistry();
    const paired = this.devices.devices.filter((d) => !d.revokedAt).length;
    if (paired > 0) this.log(`remote-agent: ${paired} paired device(s) known`);

    // Answers discovery probes so a paired device can re-find this machine
    // after the address changes. Best-effort: a bind failure leaves the other
    // rungs of the ladder intact rather than taking the server down.
    this.discovery = new DiscoveryResponder({
      currentBaseUrl: () => this.linkBaseUrl(),
      knowsDevice: (id) => this.devices.devices.some((d) => d.id === id && !d.revokedAt),
      host: hostname(),
      log: this.log,
    });
    await this.discovery.start();

    // A stable origin beats a quick tunnel outright: same reachability, and it
    // is still correct after a restart. When one is configured, don't spend a
    // cloudflared process on a hostname nobody would use.
    if (stable) {
      this.stableBaseUrl = stable;
      this.publicBaseUrl = stable;
      this.tunnelReady = Promise.resolve(stable);
      this.log(`remote-agent: permanent public address ${stable} (no quick tunnel; links survive restarts)`);
      return { host, port: this.boundPort };
    }

    const tunnelMode = this.opts.tunnelMode ?? "auto";
    if (tunnelMode === "cloudflared") {
      // Hard requirement: surface the failure to the caller.
      this.publicBaseUrl = await this.startTunnel();
      this.tunnelReady = Promise.resolve(this.publicBaseUrl);
    } else if (tunnelMode === "auto") {
      // Background: a 60MB first-time download must not hold up garrison boot.
      // generateToken awaits this (bounded) so the first link still gets the tunnel.
      this.tunnelReady = this.startTunnel()
        .then((url) => { this.publicBaseUrl = url; this.broadcastHome(); return url; })
        .catch((err) => {
          this.log(`remote-agent tunnel unavailable (${err instanceof Error ? err.message : String(err)}) — links are LAN-only`);
          return undefined;
        });
    }

    return { host, port: this.boundPort };
  }

  get port(): number { return this.boundPort; }

  /** Whether links currently reach the internet or only this LAN. */
  linkScope(): LinkScope { return this.publicBaseUrl ? "public" : "lan"; }

  /** The base URL for generated links (tunnel URL when active, LAN URL otherwise). */
  linkBaseUrl(): string {
    return this.publicBaseUrl ?? `http://${this.lanIp()}:${this.boundPort}`;
  }

  /**
   * Tell every attached device where home is NOW.
   *
   * The address a connector dials is the one it last connected on. When a
   * quick tunnel dies and returns on a different hostname, that stored address
   * is already dead — the connector just doesn't know yet, and finds out at
   * the worst moment: the next disconnect, off-LAN, with nothing left to try.
   * Sending the new one while the socket is still up means the ladder's first
   * rung is never stale. v3 connectors act on it; older ones ignore it.
   */
  private broadcastHome(): void {
    const wsUrl = this.linkBaseUrl().replace(/^http/, "ws") + "/ws";
    let told = 0;
    for (const pc of this.pcs.values()) {
      if (!pc.deviceId) continue;
      try { pc.ws.send(JSON.stringify({ type: "home", wsUrl })); told++; } catch { /* the sweep will drop it */ }
    }
    if (told) this.log(`remote-agent: re-homed ${told} device(s) to ${wsUrl}`);
  }

  /** The address a LAN peer should use: the explicit bind host when there is
   *  one, otherwise the interface that carries the default route. */
  lanIp(): string {
    if (this.boundHost && this.boundHost !== "0.0.0.0" && this.boundHost !== "::") return this.boundHost;
    return this.lanAddress;
  }

  /** Mint a one-time link. Waits (bounded) for a cold tunnel so the very first
   *  link after boot is still internet-reachable. */
  async generateToken(label: string): Promise<{ token: string; url: string; scope: LinkScope }> {
    if (!this.publicBaseUrl && (this.opts.tunnelMode ?? "auto") !== "none") {
      await Promise.race([this.tunnelReady, new Promise<void>((r) => setTimeout(r, TUNNEL_WAIT_MS).unref?.())]);
    }
    this.sweepTokens();
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { label, expiresAt: Date.now() + LINK_TTL_MS });
    return { token, url: `${this.linkBaseUrl()}/agent?token=${token}`, scope: this.linkScope() };
  }

  /**
   * Mint a PAIRING link: one use, ten minutes, and it enrols a device that stays
   * paired afterwards. Deliberately a separate kind from the help link — the
   * two have very different consequences and must never be confused.
   */
  async generatePairingLink(name: string): Promise<{ token: string; url: string; scope: LinkScope; warning?: string }> {
    if (!this.publicBaseUrl && (this.opts.tunnelMode ?? "auto") !== "none") {
      await Promise.race([this.tunnelReady, new Promise<void>((r) => setTimeout(r, TUNNEL_WAIT_MS).unref?.())]);
    }
    this.sweepTokens();
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, { label: name, expiresAt: Date.now() + LINK_TTL_MS, kind: "pair" });
    // A device that cannot reach this machine retries forever and says nothing,
    // so the reachability problem is surfaced WITH the link rather than after.
    const fw = await checkFirewall(this.boundPort, DISCOVERY_PORT).catch(() => null);
    const warning = fw ? firewallAdvice(fw) : null;
    return {
      token,
      url: `${this.linkBaseUrl()}/pair?token=${token}`,
      scope: this.linkScope(),
      ...(warning ? { warning } : {}),
    };
  }

  /** Every paired device, with whether it is connected right now. */
  listDevices(): Array<{
    id: string; name: string; hostname: string; os: string;
    addedAt: number; lastSeenAt?: number; elevated: boolean; online: boolean;
  }> {
    const online = new Set([...this.pcs.values()].map((p) => p.deviceId).filter(Boolean) as string[]);
    return this.devices.devices
      .filter((d) => !d.revokedAt)
      .map((d) => ({
        id: d.id,
        name: d.name,
        hostname: d.hostname,
        os: d.os,
        addedAt: d.addedAt,
        ...(d.lastSeenAt ? { lastSeenAt: d.lastSeenAt } : {}),
        elevated: d.allowElevated === true,
        online: online.has(d.id),
      }));
  }

  /** Revoke a device. Its connector is told WHY before the socket closes, so it
   *  stops and uninstalls instead of retrying into silence forever. */
  async unpairDevice(deviceId: string): Promise<PairedDevice | null> {
    const device = await revokeDevice({ registry: this.devices, save: (r) => saveDeviceRegistry(undefined, r) }, deviceId);
    if (!device) return null;
    for (const [id, pc] of this.pcs) {
      if (pc.deviceId !== deviceId) continue;
      try { pc.ws.send(JSON.stringify({ type: "error", message: "this device was unpaired — stop and uninstall", fatal: true })); } catch { /* gone */ }
      try { pc.ws.close(); } catch { /* gone */ }
      this.dropPc(id);
    }
    this.log(`remote device unpaired: ${device.name} (${deviceId})`);
    return device;
  }

  async renameDevice(deviceId: string, name: string): Promise<PairedDevice | null> {
    return renameDeviceIn({ registry: this.devices, save: (r) => saveDeviceRegistry(undefined, r) }, deviceId, name);
  }

  private sweepTokens(): void {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (now > v.expiresAt) this.tokens.delete(t);
  }

  /** Claim a PAIRING token: valid once, and burned on use so a forwarded link
   *  cannot enrol a second machine. */
  private claimPairingToken(token: string): { name: string } | null {
    const t = this.liveToken(token);
    if (!t || t.kind !== "pair") return null;
    this.tokens.delete(token);
    return { name: t.label };
  }

  private liveToken(token: string): LinkToken | undefined {
    const t = this.tokens.get(token);
    if (!t) return undefined;
    if (Date.now() > t.expiresAt) { this.tokens.delete(token); return undefined; }
    return t;
  }

  // ─── Tunnel ────────────────────────────────────────────────────────────

  /**
   * Bring a dead quick tunnel back, with capped exponential backoff.
   *
   * NOTE what this does and does not buy: new links get a working public URL
   * again, and the daemon stops silently degrading to LAN for the rest of its
   * life. It does NOT rescue a connector that is already running, because a
   * quick tunnel comes back on a DIFFERENT random *.trycloudflare.com hostname
   * and the connector has the old one baked in from download time. Surviving
   * that needs a stable rendezvous the connector can re-resolve; this is the
   * floor, not the ceiling.
   */
  private scheduleTunnelRestart(): void {
    if (this.closing) return;
    if ((this.opts.tunnelMode ?? "auto") === "none") return;
    const attempt = ++this.tunnelRestarts;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt - 1, 5));
    this.log(`remote-agent tunnel died — restarting in ${Math.round(delay / 1000)}s (attempt ${attempt})`);
    const timer = setTimeout(() => {
      if (this.closing || this.tunnelProc) return;
      this.tunnelReady = this.startTunnel()
        .then((url) => {
          this.publicBaseUrl = url;
          this.tunnelRestarts = 0;
          this.log(`remote-agent tunnel restored: ${url}`);
          // The whole point of restoring it: hand the new hostname to anyone
          // still attached, before they need it.
          this.broadcastHome();
          return url;
        })
        .catch((err) => {
          this.log(`remote-agent tunnel restart failed (${err instanceof Error ? err.message : String(err)})`);
          this.scheduleTunnelRestart();
          return undefined;
        });
    }, delay);
    timer.unref?.();
  }

  private async startTunnel(): Promise<string> {
    const bin = await ensureCloudflared(this.home, this.log);
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${this.boundPort}`], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      this.tunnelProc = proc;
      const timeoutHandle = setTimeout(() => {
        reject(new Error("cloudflared did not report a tunnel URL within 45s"));
        try { proc.kill(); } catch { /* already gone */ }
      }, 45_000);
      let buf = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeoutHandle);
          this.log(`remote-agent tunnel: ${match[0]}`);
          resolve(match[0]);
        }
      });
      proc.on("error", (err) => { clearTimeout(timeoutHandle); reject(new Error(`cloudflared failed to start: ${err.message}`)); });
      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0 && code !== null) reject(new Error(`cloudflared exited early (code ${code})`));
        // A tunnel that dies mid-flight used to drop us to LAN links silently and
        // stay there for the life of the daemon: nothing ever restarted
        // cloudflared, so the owner's next link was LAN-only with no explanation
        // and any connector already dialled in was left calling a hostname that
        // no longer routed. Bring it back instead.
        if (this.tunnelProc === proc) {
          this.publicBaseUrl = undefined;
          this.tunnelProc = undefined;
          this.scheduleTunnelRestart();
        }
      });
    });
  }

  // ─── PC control ────────────────────────────────────────────────────────

  listPcs(): RemotePcInfo[] {
    return [...this.pcs.values()].map(({ ws: _w, pendingCmds: _p, token: _t, lastSeen: _l, ...info }) => info);
  }

  /** Remember which device a connection belonged to, so its id stays resolvable
   *  after the connection is gone. Bounded: a machine that flaps for weeks must
   *  not grow this without limit. */
  private retirePcId(id: string, deviceId?: string): void {
    if (!deviceId) return;
    this.retiredPcIds.set(id, deviceId);
    while (this.retiredPcIds.size > 256) {
      const oldest = this.retiredPcIds.keys().next();
      if (oldest.done) break;
      this.retiredPcIds.delete(oldest.value);
    }
  }

  /**
   * Map whatever the caller is holding onto a live connection.
   *
   * Accepts, in order: a live pcId; a deviceId (stable for the life of the
   * pairing, so callers can pin THAT instead); a retired pcId whose device is
   * connected again. Returns undefined when nothing matches, and the callers
   * raise the error — with the reason, because "that id is stale and the
   * machine is offline" and "that id never existed" want different answers.
   */
  resolvePcId(id: string): string | undefined {
    if (this.pcs.has(id)) return id;
    const liveFor = (deviceId: string): string | undefined => {
      for (const [pcId, pc] of this.pcs) if (pc.deviceId === deviceId) return pcId;
      return undefined;
    };
    return liveFor(id) ?? (() => {
      const deviceId = this.retiredPcIds.get(id);
      return deviceId ? liveFor(deviceId) : undefined;
    })();
  }

  /** The resolved id, or a precise Error explaining which kind of miss it was. */
  private requirePc(id: string): RemotePcConn {
    const resolved = this.resolvePcId(id);
    const pc = resolved ? this.pcs.get(resolved) : undefined;
    if (pc) return pc;
    const knownDevice = this.devices.devices.find(
      (d) => !d.revokedAt && (d.id === id || this.retiredPcIds.get(id) === d.id),
    );
    if (knownDevice) {
      const seen = knownDevice.lastSeenAt ? new Date(knownDevice.lastSeenAt).toISOString().replace("T", " ").slice(0, 16) : "never";
      throw new Error(
        `"${knownDevice.name}" (${knownDevice.hostname}) is paired but not connected right now — last seen ${seen}. ` +
        `It reconnects by itself when the machine is on and can reach this one; check it is awake, or use device id "${knownDevice.id}" once it is back.`,
      );
    }
    throw new Error(
      `No remote PC with id "${id}" connected. ` +
      `A pc_id belongs to one connection and changes whenever the machine reconnects — ` +
      `run list_pcs for current ids, or pass the device id from list_devices, which never changes.`,
    );
  }

  /** Send a request to a connected PC and await its matching `*_result`. */
  private request(rawPcId: string, msg: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    let pc: RemotePcConn;
    try { pc = this.requirePc(rawPcId); }
    catch (err) { return Promise.reject(err instanceof Error ? err : new Error(String(err))); }
    return new Promise((resolve, reject) => {
      const reqId = randomBytes(8).toString("hex");
      const timer = setTimeout(() => {
        pc.pendingCmds.delete(reqId);
        reject(new Error(`remote ${String(msg["type"])} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 2_000);
      timer.unref?.();
      pc.pendingCmds.set(reqId, { resolve, reject, timer, op: String(msg["type"]) });
      try { pc.ws.send(JSON.stringify({ ...msg, reqId })); }
      catch (err) { clearTimeout(timer); pc.pendingCmds.delete(reqId); reject(err instanceof Error ? err : new Error(String(err))); }
    });
  }

  async exec(pcId: string, command: string, timeoutMs = 30_000, shell?: "cmd" | "powershell"): Promise<ExecResult> {
    const r = await this.request(pcId, { type: "exec", command, timeoutMs, ...(shell ? { shell } : {}) }, timeoutMs);
    return { output: String(r["output"] ?? ""), exitCode: typeof r["exitCode"] === "number" ? (r["exitCode"] as number) : undefined };
  }

  /** Drive the remote desktop: click / type / key / move / scroll / drag.
   *  The remote mirror of the local AgentComputer input tools. */
  async input(pcId: string, ev: Record<string, unknown>, timeoutMs = 15_000): Promise<{ ok: boolean; error?: string }> {
    const r = await this.request(pcId, { type: "input", ...ev }, timeoutMs);
    return { ok: r["ok"] === true, ...(typeof r["error"] === "string" ? { error: r["error"] as string } : {}) };
  }

  /** Capture the remote screen; returns a base64 PNG. */
  async screenshot(pcId: string, timeoutMs = 20_000): Promise<{ dataBase64: string }> {
    const r = await this.request(pcId, { type: "screenshot" }, timeoutMs);
    if (r["error"]) throw new Error(String(r["error"]));
    const data = String(r["dataBase64"] ?? "");
    if (!data) throw new Error("remote screenshot returned no image");
    return { dataBase64: data };
  }

  /** Read a file FROM the remote PC (owner-driven; the connector never initiates). */
  async readFile(pcId: string, remotePath: string, timeoutMs = 60_000): Promise<FileGetResult> {
    const r = await this.request(pcId, { type: "getfile", path: remotePath }, timeoutMs);
    if (r["error"]) throw new Error(String(r["error"]));
    const dataBase64 = String(r["dataBase64"] ?? "");
    return { dataBase64, size: typeof r["size"] === "number" ? (r["size"] as number) : Buffer.byteLength(dataBase64, "base64") };
  }

  /** Write a file TO the remote PC (data flows owner → remote only). */
  async writeFile(pcId: string, remotePath: string, dataBase64: string, timeoutMs = 60_000): Promise<{ bytes: number }> {
    const r = await this.request(pcId, { type: "putfile", path: remotePath, dataBase64 }, timeoutMs);
    if (r["error"]) throw new Error(String(r["error"]));
    return { bytes: typeof r["bytes"] === "number" ? (r["bytes"] as number) : 0 };
  }

  /** The connector version THIS build ships — what a device gets if updated. */
  availableConnectorVersion(): number {
    return DEVICE_CONNECTOR_VERSION;
  }

  /** Connector version a PC is running (1 = pre-versioning). */
  connectorVersionOf(pcId: string): number {
    const resolved = this.resolvePcId(pcId);
    return (resolved ? this.pcs.get(resolved)?.connectorVersion : undefined) ?? 1;
  }

  /** Fail fast, with the fix, rather than letting an old connector time out in
   *  silence on an op it has never heard of. */
  private requireConnector(pcId: string, minVersion: number, op: string): void {
    const pc = this.requirePc(pcId);
    const have = pc.connectorVersion ?? 1;
    if (have < minVersion) {
      throw new Error(
        `${pc.label} is running connector v${have}; "${op}" needs v${minVersion}. ` +
        `Update it first: RemotePC { action: "update_agent", pc_id: "${pcId}" } (asks the owner to approve).`,
      );
    }
  }

  /**
   * Perform an HTTP request FROM the remote machine.
   *
   * The point is network position, not the bytes: services bound to that
   * machine's localhost, hosts inside its LAN or VPN, a container's published
   * port. None of it is reachable from the owner's desk, and all of it is one
   * hop from the connector.
   */
  async fetchVia(
    pcId: string,
    req: { url: string; method?: string; headers?: Record<string, string>; bodyBase64?: string; timeoutMs?: number },
  ): Promise<RemoteFetchResult> {
    this.requireConnector(pcId, 2, "fetch");
    const timeoutMs = Math.max(1_000, Math.min(120_000, req.timeoutMs ?? 30_000));
    const r = await this.request(pcId, {
      type: "fetch",
      url: req.url,
      method: (req.method ?? "GET").toUpperCase(),
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.bodyBase64 ? { bodyBase64: req.bodyBase64 } : {}),
      timeoutMs,
    }, timeoutMs);
    if (r["error"]) throw new Error(String(r["error"]));
    const dataBase64 = String(r["dataBase64"] ?? "");
    return {
      status: typeof r["status"] === "number" ? (r["status"] as number) : 0,
      headers: (r["headers"] && typeof r["headers"] === "object" ? r["headers"] : {}) as Record<string, string>,
      dataBase64,
      size: typeof r["size"] === "number" ? (r["size"] as number) : Buffer.byteLength(dataBase64, "base64"),
    };
  }

  /**
   * Replace a paired device's connector script with the one THIS build ships.
   *
   * Two delivery paths, because the interesting case is a device too old to
   * know the word "update":
   *   v2+ — send the script over the live channel; the connector verifies the
   *         hash, arms its rollback watchdog, swaps and restarts itself.
   *   v1  — no update op exists, so bootstrap through primitives it does have:
   *         putfile the script, then exec an elevated PowerShell that performs
   *         the same verify → backup → swap → restart.
   * Either way the device drops its socket and comes back; the caller waits
   * for the reconnect and reports the version that shows up.
   */
  async updateAgent(pcId: string, opts: string | { waitMs?: number; scriptPath?: string } = {}): Promise<{
    deviceId: string;
    ok: boolean;
    from: number;
    to: number;
    reconnected: boolean;
    newPcId?: string;
    detail: string;
  }> {
    // The tool passes a script path positionally; the control API passes an
    // options object. Accept both rather than making callers care.
    const options = typeof opts === "string" ? { scriptPath: opts } : opts;
    const pc = this.requirePc(pcId);
    if (!pc.deviceId) throw new Error("update_agent only applies to permanently paired devices, not one-time help links.");
    const from = pc.connectorVersion ?? 1;
    const deviceId = pc.deviceId;
    const waitMs = options.waitMs ?? 150_000;

    // An enrolled device authenticates from its stored credential, so the
    // token placeholder is inert here — never mint a fresh pairing token for
    // an update, or a leaked script would be a pairing link.
    //
    // scriptPath lets Ares push a connector it just WROTE rather than only the
    // one this build compiled — the difference between "the remote gains a
    // capability next release" and "it gains one this afternoon". The device
    // still verifies the hash, parses before trusting, and rolls itself back,
    // and the owner still approves the push; what changes is only who authored
    // the bytes.
    const script = options.scriptPath
      ? await readFile(options.scriptPath, "utf8")
      : buildDeviceConnectorPs1({
        token: "",
        wsUrl: `${this.linkBaseUrl().replace(/^http/, "ws")}/ws`,
        baseUrl: this.linkBaseUrl(),
        discoveryPort: DISCOVERY_PORT,
      });
    if (options.scriptPath) {
      // A template that never went through buildDeviceConnectorPs1 still has
      // its placeholders, and would come up with no address to call home to —
      // a bricked device whose only fix is walking over to it.
      const leftover = script.match(/__ARES_[A-Z_]+__/);
      if (leftover) throw new Error(`${options.scriptPath} still contains the placeholder ${leftover[0]} — render it with buildDeviceConnectorPs1 before pushing.`);
      if (!/Ares Remote/.test(script)) throw new Error(`${options.scriptPath} does not look like an Ares connector.`);
      if (script.length < 4000) throw new Error(`${options.scriptPath} is only ${script.length} bytes — too small to be a connector.`);
    }
    const bytes = Buffer.from(script, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (from >= 2) {
      const r = await this.request(pcId, {
        type: "update",
        scriptBase64: bytes.toString("base64"),
        sha256,
        version: DEVICE_CONNECTOR_VERSION,
      }, 60_000);
      if (r["ok"] !== true) throw new Error(String(r["error"] ?? "the device refused the update"));
    } else {
      await this.bootstrapUpdateV1(pcId, bytes, sha256);
    }

    const reconnected = await this.waitForDevice(deviceId, waitMs);
    const to = reconnected ? (this.pcs.get(reconnected)?.connectorVersion ?? 1) : from;
    return {
      ok: reconnected ? to >= DEVICE_CONNECTOR_VERSION : false,
      from,
      to,
      reconnected: !!reconnected,
      ...(reconnected ? { newPcId: reconnected } : {}),
      // The stable handle. newPcId is already obsolete the next time this
      // machine reconnects; deviceId is good for the life of the pairing.
      deviceId,
      detail: reconnected
        ? to >= DEVICE_CONNECTOR_VERSION
          ? `connector updated v${from} → v${to} and reattached`
          : `device came back still on v${to} — either its rollback watchdog reverted the update, or its connector runs from somewhere other than ProgramData\\Ares\\remote (check update.log there)`
        : `device did not reattach within ${Math.round(waitMs / 1000)}s — its watchdog rolls back to the previous connector automatically`,
    };
  }

  /**
   * Bring a just-attached device up to this build's connector, unasked.
   *
   * The owner's standing instruction for their OWN machines is "it should just
   * work — no need to mess with it". A device that stays on an old connector
   * is not obviously broken, it just silently cannot do the newest things, and
   * nobody finds out until an op fails. So the garrison does it on sight.
   *
   * Safety is the device's, unchanged: it verifies the sha256, keeps the old
   * script, and its watchdog rolls back if the new one fails to reconnect. The
   * guard here is against REPEAT pushes — one attempt per device per target
   * version per process. If an update lands and the device still comes back on
   * the old version (a rollback), it is not tried again in a loop; that is a
   * real fault and it belongs in the log, not in an infinite retry.
   */
  private readonly autoUpdateTried = new Set<string>();
  private autoUpdateOnAttach(pcId: string, deviceId: string, have: number): void {
    const enabled = this.opts.autoUpdateDevices ?? process.env["ARES_REMOTE_AUTO_UPDATE"] !== "0";
    if (!enabled || have >= DEVICE_CONNECTOR_VERSION) return;
    const key = `${deviceId}@${DEVICE_CONNECTOR_VERSION}`;
    if (this.autoUpdateTried.has(key)) return;
    this.autoUpdateTried.add(key);
    // Let the attach settle first — updateAgent talks to this same socket.
    const timer = setTimeout(() => {
      if (this.closing) return;
      this.log(`remote-agent: auto-updating connector v${have} -> v${DEVICE_CONNECTOR_VERSION} on ${deviceId}`);
      void this.updateAgent(pcId)
        .then((r) => this.log(`remote-agent: auto-update ${r.ok ? "succeeded" : "did not take"} — ${r.detail}`))
        .catch((err) => this.log(`remote-agent: auto-update failed (${err instanceof Error ? err.message : String(err)})`));
    }, 3_000);
    timer.unref?.();
  }

  /** v1 devices have no update op; drive one through putfile + exec instead. */
  private async bootstrapUpdateV1(pcId: string, bytes: Buffer, sha256: string): Promise<void> {
    const stagePath = "C:\\ProgramData\\Ares\\remote\\ares-remote.new.ps1";
    await this.writeFile(pcId, stagePath, bytes.toString("base64"), 120_000);
    // One elevated PowerShell: verify the transfer, parse the script, keep the
    // old one, swap, then restart the task from a DETACHED process — the task
    // restart kills this very connector, and a child of the dying process
    // would go with it.
    const ps = buildV1UpdateScript(sha256);
    const res = await this.exec(pcId, ps, 60_000, "powershell");
    if (!/staged/.test(res.output)) {
      throw new Error(`bootstrap update failed on the device: ${res.output.slice(0, 400)}`);
    }
  }

  /** Resolve with the new pcId once a device reattaches, or "" on timeout. */
  private waitForDevice(deviceId: string, timeoutMs: number): Promise<string> {
    const existing = [...this.pcs.values()].find((p) => p.deviceId === deviceId);
    const before = existing?.id;
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const now = [...this.pcs.values()].find((p) => p.deviceId === deviceId);
        if (now && now.id !== before) { clearInterval(timer); resolve(now.id); return; }
        if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(""); }
      }, 500);
      timer.unref?.();
    });
  }

  // ─── HTTP forwarding ──────────────────────────────────────────────────────
  // A local port on the owner's machine that answers with a service living on
  // the remote one. Every request is relayed through the connector's `fetch`,
  // so it needs no new protocol and no inbound port on the device — and it is
  // what makes "preview the UI you are editing against the real backend"
  // possible when the backend is on another machine.

  private readonly forwards = new Map<string, { info: ForwardInfo; server: HttpServer; deviceId?: string }>();

  listForwards(): ForwardInfo[] {
    return [...this.forwards.values()].map((f) => ({ ...f.info }));
  }

  /**
   * The pcId to send this forward's next request to.
   *
   * A pcId belongs to a CONNECTION, not a machine: every reconnect mints a new
   * one, and `update_agent` deliberately causes a reconnect. A forward pinned
   * to the id it was opened with would therefore break exactly when the owner
   * updates the machine it points at. For a paired device the durable identity
   * is the deviceId, so re-resolve through that and keep the info row honest.
   */
  private forwardTarget(id: string): string {
    const entry = this.forwards.get(id);
    if (!entry) return "";
    if (this.pcs.has(entry.info.pcId)) return entry.info.pcId;
    if (!entry.deviceId) return entry.info.pcId;
    const current = [...this.pcs.values()].find((p) => p.deviceId === entry.deviceId);
    if (current) entry.info.pcId = current.id;
    return entry.info.pcId;
  }

  async startForward(pcId: string, target: string, localPort = 0): Promise<ForwardInfo> {
    this.requireConnector(pcId, 2, "forward_http");
    const origin = target.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(origin)) throw new Error(`forward target must be an http(s) origin, got "${target}"`);
    const existing = [...this.forwards.values()].find((f) => f.info.pcId === pcId && f.info.target === origin);
    if (existing) return { ...existing.info };

    const deviceId = this.pcs.get(this.resolvePcId(pcId) ?? pcId)?.deviceId;
    const id = randomBytes(6).toString("hex");
    const server = createServer((req, res) => {
      void (async () => {
        const entry = this.forwards.get(id);
        if (entry) entry.info.requests += 1;
        try {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (/^(host|connection|content-length|accept-encoding)$/i.test(k)) continue;
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          const out = await this.fetchVia(this.forwardTarget(id) || pcId, {
            url: origin + (req.url ?? "/"),
            method: req.method ?? "GET",
            headers,
            ...(chunks.length ? { bodyBase64: Buffer.concat(chunks).toString("base64") } : {}),
            timeoutMs: 60_000,
          });
          const body = Buffer.from(out.dataBase64, "base64");
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(out.headers)) {
            // The relay re-frames the body, so the remote's transfer encoding
            // and length no longer describe what goes out on this socket.
            if (/^(transfer-encoding|content-length|content-encoding|connection)$/i.test(k)) continue;
            outHeaders[k] = v;
          }
          outHeaders["content-length"] = String(body.length);
          res.writeHead(out.status || 502, outHeaders);
          res.end(body);
        } catch (err) {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end(`Ares remote forward failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
    // Loopback only. This port is an unauthenticated door onto a service on
    // another machine; it must not be one the LAN can walk through.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(localPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : localPort;
    const info: ForwardInfo = {
      id, pcId, target: origin,
      localUrl: `http://127.0.0.1:${port}`,
      port, createdAt: Date.now(), requests: 0,
    };
    this.forwards.set(id, { info, server, ...(deviceId ? { deviceId } : {}) });
    this.log(`remote forward ${info.localUrl} → ${origin} on ${this.pcs.get(this.resolvePcId(pcId) ?? pcId)?.label ?? pcId}`);
    return { ...info };
  }

  async stopForward(id: string): Promise<boolean> {
    const entry = this.forwards.get(id);
    if (!entry) return false;
    this.forwards.delete(id);
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    this.log(`remote forward ${entry.info.localUrl} closed`);
    return true;
  }

  notify(pcId: string, message: string): void {
    const resolved = this.resolvePcId(pcId);
    if (resolved) this.pcs.get(resolved)?.ws.send(JSON.stringify({ type: "notify", message }));
  }

  /** Owner-initiated: tell the connector to exit (so it doesn't auto-reconnect) and drop it. */
  disconnect(pcId: string): void {
    const resolved = this.resolvePcId(pcId);
    const pc = resolved ? this.pcs.get(resolved) : undefined;
    if (!pc) return;
    this.tokens.delete(pc.token);
    try { pc.ws.send(JSON.stringify({ type: "bye" })); } catch { /* gone */ }
    setTimeout(() => { try { pc.ws.close(); } catch { /* gone */ } }, 300).unref?.();
  }

  /**
   * Keep every live connection warm and reap the ones that stopped answering.
   *
   * Both a WS control ping and a JSON `{type:"ping"}` go out: the control frame
   * is what the `ws` library and .NET answer natively, while the JSON one is
   * guaranteed to be real application traffic through any intermediary that
   * only counts data frames toward its idle timer. Belt and braces is cheap at
   * one frame per 30s, and getting this wrong is a link that dies silently.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, pc] of this.pcs) {
        if (now - pc.lastSeen > PEER_TIMEOUT_MS) {
          // Unresponsive: terminate() (not close()) because a half-open socket
          // never completes a closing handshake — close() would hang forever.
          this.log(`remote PC ${pc.hostname} stopped answering — dropping (id=${id})`);
          try { pc.ws.terminate(); } catch { /* already gone */ }
          this.dropPc(id);
          continue;
        }
        try { pc.ws.ping(); } catch { /* gone; the sweep above will catch it */ }
        try { pc.ws.send(JSON.stringify({ type: "ping" })); } catch { /* same */ }
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  /** Remove a PC and settle anything still waiting on it. */
  private dropPc(id: string): void {
    const pc = this.pcs.get(id);
    if (!pc) return;
    this.pcs.delete(id);
    this.retirePcId(id, pc.deviceId);
    for (const { reject, timer } of pc.pendingCmds.values()) {
      clearTimeout(timer);
      reject(new Error("remote PC disconnected"));
    }
    pc.pendingCmds.clear();
    const { ws: _w, pendingCmds: _p, token: _t, lastSeen: _l, ...info } = pc;
    for (const cb of this.disconnectedListeners) cb(info);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.discovery?.close();
    this.discovery = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    try { this.tunnelProc?.kill(); } catch { /* already dead */ }
    this.tunnelProc = undefined;
    // Forwards outlive individual requests, so they have to be closed here or
    // the process keeps listening on ports for machines it can no longer reach.
    for (const id of [...this.forwards.keys()]) await this.stopForward(id);
    for (const pc of this.pcs.values()) {
      for (const { reject, timer, op } of pc.pendingCmds.values()) {
        clearTimeout(timer);
        reject(new Error(`server closed while waiting for ${op}`));
      }
      try { pc.ws.send(JSON.stringify({ type: "bye" })); } catch { /* gone */ }
      try { pc.ws.close(); } catch { /* already dead */ }
    }
    this.pcs.clear();
    this.tokens.clear();
    const { wss, http } = this;
    this.wss = undefined;
    this.http = undefined;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
    if (http) {
      http.closeIdleConnections?.();
      await new Promise<void>((r) => http.close(() => r()));
    }
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) { void this.handleControlApi(req, res, url); return; }
    if (req.method !== "GET") { res.writeHead(405).end(); return; }

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pcs: this.pcs.size, scope: this.linkScope() }));
      return;
    }

    const token = url.searchParams.get("token") ?? "";
    const routes: Record<string, (t: string) => { body: string; type: string; filename?: string }> = {
      "/agent": (t) => ({ body: buildLandingHtml(this.linkBaseUrl(), t), type: "text/html; charset=utf-8" }),
      "/agent.cmd": (t) => ({ body: buildWindowsCmd(this.linkBaseUrl(), t), type: "application/octet-stream", filename: "ares-connect.cmd" }),
      "/agent.ps1": (t) => ({ body: buildPowerShellAgent(t, this.wsUrl()), type: "text/plain; charset=utf-8" }),
      "/agent.py": (t) => ({ body: buildPythonAgent(t, this.wsUrl()), type: "text/x-python; charset=utf-8" }),
      "/script": (t) => ({ body: buildPythonAgent(t, this.wsUrl()), type: "text/x-python; charset=utf-8", filename: "ares-connect.py" }),
      // ── permanent pairing ──
      "/pair": (t) => ({ body: buildPairLandingHtml(this.linkBaseUrl(), t), type: "text/html; charset=utf-8" }),
      "/pair.cmd": (t) => ({ body: buildPairCmd(this.linkBaseUrl(), t), type: "application/octet-stream", filename: "ares-remote-setup.cmd" }),
      "/pair.ps1": (t) => ({
        body: buildDeviceConnectorPs1({
          token: t,
          wsUrl: this.wsUrl(),
          baseUrl: this.linkBaseUrl(),
          discoveryPort: DISCOVERY_PORT,
        }),
        type: "text/plain; charset=utf-8",
      }),
      "/pair-install.ps1": (t) => ({
        body: buildPairInstallPs1(this.linkBaseUrl(), t),
        type: "text/plain; charset=utf-8",
      }),
    };
    const route = routes[url.pathname];
    if (!route) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }

    if (!this.liveToken(token)) {
      const html = url.pathname === "/agent";
      res.writeHead(410, { "content-type": html ? "text/html; charset=utf-8" : "text/plain" });
      res.end(html ? EXPIRED_HTML : "# This link has expired. Ask for a fresh one.\n");
      return;
    }
    const { body, type, filename } = route(token);
    const headers: Record<string, string> = { "content-type": type, "cache-control": "no-store" };
    if (filename) headers["content-disposition"] = `attachment; filename="${filename}"`;
    res.writeHead(200, headers);
    res.end(body);
  }

  private wsUrl(): string {
    return this.linkBaseUrl().replace(/^http/, "ws") + "/ws";
  }

  // ─── Control API (loopback + bearer token) ─────────────────────────────
  //
  // The chat surfaces run in the daemon process; this server runs in the
  // garrison. The RemotePC tool there talks to us through these routes.

  private async handleControlApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const remote = req.socket.remoteAddress ?? "";
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const expected = this.opts.controlToken;
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!expected || !loopback || !tokensMatch(presented, expected)) return json(401, { error: "unauthorized" });

    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
      catch { return json(400, { error: "bad json" }); }
    }
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");

    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/pcs": return json(200, { pcs: this.listPcs(), scope: this.linkScope() });
        case "POST /api/link": return json(200, await this.generateToken(str("label") || "their PC"));
        // Permanent pairing — a DIFFERENT link kind from the one-time help
        // link above, so the UI can offer the two as distinct buttons.
        case "POST /api/pair-link": return json(200, await this.generatePairingLink(str("label") || "my device"));
        case "GET /api/devices": return json(200, { devices: this.listDevices() });
        case "POST /api/unpair": {
          const device = await this.unpairDevice(str("deviceId"));
          return json(200, { ok: !!device, name: device?.name });
        }
        case "POST /api/rename-device": {
          const device = await this.renameDevice(str("deviceId"), str("name"));
          return json(200, { ok: !!device, name: device?.name });
        }
        case "POST /api/exec": {
          const timeout = typeof body["timeoutMs"] === "number" ? (body["timeoutMs"] as number) : undefined;
          const shell = str("shell") === "powershell" ? "powershell" : str("shell") === "cmd" ? "cmd" : undefined;
          return json(200, await this.exec(str("pcId"), str("command"), timeout, shell));
        }
        case "POST /api/input": {
          const { pcId: _p, ...ev } = body as Record<string, unknown>;
          return json(200, await this.input(str("pcId"), ev));
        }
        case "POST /api/screenshot": return json(200, await this.screenshot(str("pcId")));
        case "POST /api/readfile": return json(200, await this.readFile(str("pcId"), str("path")));
        case "POST /api/writefile": return json(200, await this.writeFile(str("pcId"), str("path"), str("dataBase64")));
        case "POST /api/notify": this.notify(str("pcId"), str("message")); return json(200, { ok: true });
        case "POST /api/disconnect": this.disconnect(str("pcId")); return json(200, { ok: true });
        case "POST /api/fetch": {
          const headers = (body["headers"] && typeof body["headers"] === "object" ? body["headers"] : undefined) as
            Record<string, string> | undefined;
          return json(200, await this.fetchVia(str("pcId"), {
            url: str("url"),
            method: str("method") || "GET",
            ...(headers ? { headers } : {}),
            ...(str("bodyBase64") ? { bodyBase64: str("bodyBase64") } : {}),
            ...(typeof body["timeoutMs"] === "number" ? { timeoutMs: body["timeoutMs"] as number } : {}),
          }));
        }
        case "POST /api/update-agent":
          return json(200, await this.updateAgent(str("pcId"), str("scriptPath") ? { scriptPath: str("scriptPath") } : {}));
        case "GET /api/agent-version":
          return json(200, { available: DEVICE_CONNECTOR_VERSION });
        case "GET /api/forwards": return json(200, { forwards: this.listForwards() });
        case "POST /api/forward": {
          const port = typeof body["localPort"] === "number" ? (body["localPort"] as number) : 0;
          return json(200, await this.startForward(str("pcId"), str("target"), port));
        }
        case "POST /api/forward-stop":
          return json(200, { ok: await this.stopForward(str("id")) });
        default: return json(404, { error: "not found" });
      }
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let pc: RemotePcConn | undefined;

    // A pong (or any frame at all) is proof of life. Recorded before parsing so
    // even a malformed frame counts — the peer is demonstrably still there.
    ws.on("pong", () => { if (pc) pc.lastSeen = Date.now(); });

    // Handshake state for a PAIRED device, held only for this socket.
    let attach: AttachState | null = null;
    const saveDevices = (r: DeviceRegistryFile) => saveDeviceRegistry(undefined, r);

    /** Adopt an authenticated device into the normal PC table, so every existing
     *  exec / screenshot / file path works on it unchanged. */
    const adoptDevice = (device: PairedDevice, meta: { username?: string; ip?: string; connectorVersion?: number }): void => {
      // A reconnect replaces the stale entry rather than accumulating ghosts.
      for (const [existingId, existing] of this.pcs) {
        if (existing.deviceId !== device.id) continue;
        this.pcs.delete(existingId);
        this.retirePcId(existingId, existing.deviceId);
        try { existing.ws.close(); } catch { /* already gone */ }
      }
      const id = randomBytes(8).toString("hex");
      pc = {
        id,
        token: "",
        deviceId: device.id,
        label: device.name,
        hostname: device.hostname,
        os: device.os,
        username: meta.username ?? "unknown",
        ip: meta.ip ?? "unknown",
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        ws,
        pendingCmds: new Map(),
        ...(meta.connectorVersion ? { connectorVersion: meta.connectorVersion } : {}),
      };
      this.pcs.set(id, pc);
      // No "home" frame here on purpose: a connector already persists the URL
      // it just connected on. The broadcast exists for the address CHANGING
      // under a live socket, which is the case nothing else covers.
      this.autoUpdateOnAttach(id, device.id, meta.connectorVersion ?? 1);
      this.log(
        `paired device attached: ${device.name} (${device.hostname}) id=${id}` +
        `${device.allowElevated ? " [elevated]" : ""} connector v${meta.connectorVersion ?? 1}` +
        `${(meta.connectorVersion ?? 1) < DEVICE_CONNECTOR_VERSION ? ` (update available: v${DEVICE_CONNECTOR_VERSION})` : ""}`,
      );
      const { ws: _w, pendingCmds: _p, token: _t, lastSeen: _l, deviceId: _d, ...info } = pc;
      for (const cb of this.connectedListeners) cb(info);
    };

    ws.on("message", (raw) => {
      if (pc) pc.lastSeen = Date.now();
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      // Connector answering our JSON ping. No payload, purely traffic.
      if (msg["type"] === "pong") return;

      // ── paired-device handshake ──
      if (msg["type"] === "enroll") {
        void (async () => {
          const res = await enrollDevice(
            {
              claimPairingToken: (t) => this.claimPairingToken(t),
              registry: this.devices,
              save: saveDevices,
            },
            {
              type: "enroll",
              token: String(msg["token"] ?? ""),
              hostname: String(msg["hostname"] ?? "unknown"),
              os: String(msg["os"] ?? "unknown"),
              username: String(msg["username"] ?? "unknown"),
              elevated: msg["elevated"] === true,
            },
          );
          try { ws.send(JSON.stringify(res.reply)); } catch { /* gone */ }
          if (!res.ok) { try { ws.close(); } catch { /* gone */ } return; }
          this.log(`remote device paired: ${res.device.name} (${res.device.hostname})`);
          adoptDevice(res.device, {
            username: String(msg["username"] ?? ""),
            ip: "unknown",
            ...(typeof msg["connectorVersion"] === "number" ? { connectorVersion: msg["connectorVersion"] as number } : {}),
          });
        })();
        return;
      }

      if (msg["type"] === "device_hello") {
        void (async () => {
          const res = await handleDeviceHello(this.devices, {
            type: "device_hello",
            deviceId: String(msg["deviceId"] ?? ""),
            nonce: String(msg["nonce"] ?? ""),
          });
          try { ws.send(JSON.stringify(res.reply)); } catch { /* gone */ }
          if (!res.ok) { try { ws.close(); } catch { /* gone */ } return; }
          attach = res.state;
        })();
        return;
      }

      if (msg["type"] === "device_auth") {
        const state = attach;
        if (!state) {
          // Proof without a challenge: either a confused client or someone
          // trying to skip the half of the handshake that binds a nonce.
          try { ws.send(JSON.stringify({ type: "error", message: "say hello first" })); } catch { /* gone */ }
          return;
        }
        void (async () => {
          const res = await handleDeviceAuth(
            { registry: this.devices, save: saveDevices },
            state,
            { type: "device_auth", proof: String(msg["proof"] ?? "") },
          );
          try { ws.send(JSON.stringify(res.reply)); } catch { /* gone */ }
          if (!res.ok) { try { ws.close(); } catch { /* gone */ } return; }
          adoptDevice(res.device, {
            username: String(msg["username"] ?? ""),
            ...(typeof msg["connectorVersion"] === "number" ? { connectorVersion: msg["connectorVersion"] as number } : {}),
          });
        })();
        return;
      }

      if (msg["type"] === "register") {
        const token = String(msg["token"] ?? "");
        const hostname = String(msg["hostname"] ?? "unknown");
        const pending = this.liveToken(token);
        if (!pending || (pending.boundHostname && pending.boundHostname !== hostname)) {
          ws.send(JSON.stringify({ type: "error", message: "invalid or expired token" }));
          ws.close();
          return;
        }
        // First use binds the link to this machine and extends it for reconnects.
        if (!pending.boundHostname) {
          pending.boundHostname = hostname;
          pending.expiresAt = Date.now() + REBIND_TTL_MS;
        }
        // A reconnect from the same PC replaces its stale entry silently.
        for (const [id, existing] of this.pcs) {
          if (existing.token === token) {
            this.pcs.delete(id);
            try { existing.ws.close(); } catch { /* already gone */ }
          }
        }
        const id = randomBytes(8).toString("hex");
        pc = {
          id,
          token,
          label: pending.label,
          hostname,
          os: String(msg["os"] ?? "unknown"),
          username: String(msg["username"] ?? "unknown"),
          ip: String(msg["ip"] ?? "unknown"),
          connectedAt: Date.now(),
          ws,
          pendingCmds: new Map(),
          lastSeen: Date.now(),
        };
        this.pcs.set(id, pc);
        ws.send(JSON.stringify({ type: "registered", id }));
        this.log(`remote PC connected: ${pc.hostname} (${pc.os}) ip=${pc.ip} id=${id}`);
        const { ws: _w, pendingCmds: _p, token: _t, lastSeen: _l, ...info } = pc;
        for (const cb of this.connectedListeners) cb(info);
        return;
      }

      // Any reply carrying a known reqId settles its pending request — exec_result,
      // screenshot_result, getfile_result, putfile_result all share this path.
      if (pc && typeof msg["reqId"] === "string" && String(msg["type"]).endsWith("_result")) {
        const pend = pc.pendingCmds.get(msg["reqId"]);
        if (pend) {
          clearTimeout(pend.timer);
          pc.pendingCmds.delete(msg["reqId"]);
          pend.resolve(msg);
        }
      }
    });

    ws.on("close", () => {
      if (!pc) return;
      // A replaced (reconnected) entry already left the map — don't announce it twice.
      if (this.pcs.get(pc.id) !== pc) { pc = undefined; return; }
      this.log(`remote PC disconnected: ${pc.hostname} id=${pc.id}`);
      // Through dropPc, not a copy of it: this used to inline the same four
      // steps and so missed retiring the id, which is exactly the path a
      // sleeping laptop takes — the common case for a pc_id going stale.
      this.dropPc(pc.id);
      pc = undefined;
    });

    ws.on("error", () => { /* surfaces as close */ });
  }
}

function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

// ─── LAN address ───────────────────────────────────────────────────────────

/** The IPv4 address of the interface holding the default route — a connected
 *  UDP socket reveals it without sending a packet. Falls back to the first
 *  non-internal interface, then loopback. VirtualBox/WSL/Docker adapters are
 *  what the naive "first interface" answer used to pick. */
export function detectLanIp(): Promise<string> {
  return new Promise((resolve) => {
    const fallback = () => {
      for (const ifaces of Object.values(networkInterfaces())) {
        for (const iface of ifaces ?? []) {
          if (iface.family === "IPv4" && !iface.internal) return resolve(iface.address);
        }
      }
      resolve("127.0.0.1");
    };
    try {
      const sock = createUdpSocket("udp4");
      sock.once("error", () => { try { sock.close(); } catch { /* closed */ } fallback(); });
      sock.connect(53, "8.8.8.8", () => {
        try {
          const { address } = sock.address();
          sock.close();
          resolve(address && !address.startsWith("0.") ? address : "127.0.0.1");
        } catch {
          fallback();
        }
      });
    } catch {
      fallback();
    }
  });
}

// ─── cloudflared provisioning ──────────────────────────────────────────────

function cloudflaredAsset(): { asset: string; archive: "tgz" | null } | null {
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : null;
  if (!arch) return null;
  switch (process.platform) {
    case "win32": return arch === "arm64" ? null : { asset: `cloudflared-windows-${arch}.exe`, archive: null };
    case "darwin": return { asset: `cloudflared-darwin-${arch}.tgz`, archive: "tgz" };
    case "linux": return { asset: `cloudflared-linux-${arch}`, archive: null };
    default: return null;
  }
}

function onPath(name: string): Promise<string | undefined> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(probe, [name], { windowsHide: true }, (err, stdout) => {
      const first = stdout?.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(!err && first ? first : undefined);
    });
  });
}

/** Find cloudflared: PATH → ~/.ares/bin cache → download the official release. */
export async function ensureCloudflared(home: string, log: (line: string) => void = () => {}): Promise<string> {
  const fromPath = await onPath("cloudflared");
  if (fromPath) return fromPath;

  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const binDir = path.join(home, "bin");
  const cached = path.join(binDir, exe);
  if (await access(cached, fsConstants.X_OK | fsConstants.R_OK).then(() => true, () => false)) return cached;

  const target = cloudflaredAsset();
  if (!target) throw new Error(`no cloudflared build for ${process.platform}/${process.arch} — install it manually`);
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${target.asset}`;
  log(`remote-agent: fetching cloudflared (one-time, ~60MB) from ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(binDir, { recursive: true });

  if (target.archive === "tgz") {
    const tmp = path.join(tmpdir(), `cloudflared-${process.pid}.tgz`);
    await writeFile(tmp, bytes);
    await new Promise<void>((resolve, reject) => {
      execFile("tar", ["-xzf", tmp, "-C", binDir, "cloudflared"], (err) => (err ? reject(err) : resolve()));
    });
  } else {
    const partial = `${cached}.part`;
    await writeFile(partial, bytes);
    await rename(partial, cached);
  }
  if (process.platform !== "win32") await chmod(cached, 0o755);
  log(`remote-agent: cloudflared ready at ${cached}`);
  return cached;
}

// ─── Connector payloads ────────────────────────────────────────────────────

function buildWindowsCmd(base: string, token: string): string {
  // CRLF: Notepad-era cmd.exe still misparses LF-only batch files in places.
  return [
    "@echo off",
    "title Ares Connect",
    "echo.",
    "echo   Connecting this PC to Ares ...",
    "echo   (keep this window open while they help you; close it to disconnect)",
    "echo.",
    // Download the connector to a file and run it with -File. The classic
    // `iex (irm ...)` download-cradle is one of the most heavily AV-flagged
    // patterns (AMSI blocks it outright); a plain file run is not.
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; (New-Object Net.WebClient).DownloadFile('${base}/agent.ps1?token=${token}', $env:TEMP + '\\ares-connect.ps1')"`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\\ares-connect.ps1"`,
    "echo.",
    "echo   Disconnected from Ares. You can close this window.",
    "pause >nul",
    "",
  ].join("\r\n");
}

function buildPowerShellAgent(token: string, wsUrl: string): string {
  return AGENT_PS1.replace(/__ARES_TOKEN__/g, token).replace(/__ARES_WS_URL__/g, wsUrl);
}

function buildPythonAgent(token: string, wsUrl: string): string {
  return AGENT_PY.replace(/__ARES_TOKEN__/g, token).replace(/__ARES_WS_URL__/g, wsUrl);
}

// Windows connector. Pure PowerShell 5.1 (.NET ClientWebSocket) so a friend's
// PC needs nothing installed. Popups run in a detached process so the command
// loop never blocks. Reconnects on the same token for up to 10 minutes; exits
// on an explicit "bye" from Ares.
const AGENT_PS1 = String.raw`
$ErrorActionPreference = 'Continue'
$WsUrl = '__ARES_WS_URL__'
$Token = '__ARES_TOKEN__'

function Show-AresPopup([string]$Text, [string]$Sub) {
  $inner = @'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.BackColor = [System.Drawing.Color]::FromArgb(13,13,13); $f.Size = New-Object System.Drawing.Size(340,82); $f.Opacity = 0
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location = New-Object System.Drawing.Point(($wa.Right - 360), ($wa.Bottom - 102))
$bar = New-Object System.Windows.Forms.Panel; $bar.BackColor = [System.Drawing.Color]::FromArgb(0,255,136); $bar.Size = New-Object System.Drawing.Size(340,2); $f.Controls.Add($bar)
$l1 = New-Object System.Windows.Forms.Label; $l1.Text = [char]0x26A1 + '  ' + '__TEXT__'; $l1.ForeColor = [System.Drawing.Color]::FromArgb(0,255,136); $l1.Font = New-Object System.Drawing.Font('Consolas',12,[System.Drawing.FontStyle]::Bold); $l1.Location = New-Object System.Drawing.Point(14,14); $l1.AutoSize = $true; $f.Controls.Add($l1)
$l2 = New-Object System.Windows.Forms.Label; $l2.Text = '__SUB__'; $l2.ForeColor = [System.Drawing.Color]::FromArgb(90,90,90); $l2.Font = New-Object System.Drawing.Font('Consolas',8); $l2.Location = New-Object System.Drawing.Point(16,46); $l2.AutoSize = $true; $f.Controls.Add($l2)
$f.Show()
for ($o = 0; $o -lt 0.92; $o += 0.08) { $f.Opacity = $o; Start-Sleep -Milliseconds 18; [System.Windows.Forms.Application]::DoEvents() }
Start-Sleep -Milliseconds 2800
for ($o = 0.92; $o -gt 0; $o -= 0.06) { $f.Opacity = $o; Start-Sleep -Milliseconds 18; [System.Windows.Forms.Application]::DoEvents() }
$f.Close()
'@
  $inner = $inner.Replace('__TEXT__', $Text.Replace("'", "''")).Replace('__SUB__', $Sub.Replace("'", "''"))
  # Cosmetic only — a locked-down box that can't spawn the popup still connects.
  # A temp .ps1 run with -File avoids the -EncodedCommand signature AV flags.
  try {
    $pf = [IO.Path]::Combine($env:TEMP, 'ares-popup.ps1')
    [IO.File]::WriteAllText($pf, $inner)
    Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',$pf -ErrorAction Stop | Out-Null
  } catch {}
}

function Get-LocalIp {
  try {
    $u = New-Object System.Net.Sockets.UdpClient
    $u.Connect('8.8.8.8', 80); $ip = $u.Client.LocalEndPoint.Address.ToString(); $u.Close(); return $ip
  } catch { return 'unknown' }
}

# NOTE: no screen-capture here on purpose. A PowerShell script that calls
# Graphics.CopyFromScreen matches Windows Defender's AMSI spyware signature and
# gets the ENTIRE connector blocked as "malicious content" — which would kill
# exec and file transfer too. Screen capture on Windows needs the code-signed
# Ares connector binary; until then screenshot_pc returns a clear message.

function Invoke-Remote([string]$Command, [int]$TimeoutMs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'; $psi.Arguments = '/d /s /c "' + $Command + '"'
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $p = New-Object System.Diagnostics.Process; $p.StartInfo = $psi
  try { [void]$p.Start() } catch { return @{ output = "Could not start: $($_.Exception.Message)"; exitCode = -1 } }
  $outTask = $p.StandardOutput.ReadToEndAsync(); $errTask = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit([Math]::Max(1000, $TimeoutMs))) {
    try { $p.Kill() } catch {}
    return @{ output = ("Command timed out after " + [int]($TimeoutMs / 1000) + "s."); exitCode = -1 }
  }
  $p.WaitForExit()
  return @{ output = ($outTask.Result + $errTask.Result); exitCode = $p.ExitCode }
}

function Send-Json($ws, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 5))
  $null = $ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
}

function Receive-Text($ws) {
  $buf = New-Object byte[] 65536
  $ms = New-Object IO.MemoryStream
  do {
    $seg = [ArraySegment[byte]]::new($buf)
    $r = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($r.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { return $null }
    $ms.Write($buf, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  return [Text.Encoding]::UTF8.GetString($ms.ToArray())
}

$hostname = $env:COMPUTERNAME
$osInfo = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
if (-not $osInfo) { $osInfo = 'Windows' }
$osInfo = $osInfo -replace '^Microsoft ', ''
$deadline = (Get-Date).AddMinutes(10)
$everConnected = $false
$bye = $false

while (-not $bye -and (Get-Date) -lt $deadline) {
  $ws = New-Object Net.WebSockets.ClientWebSocket
  try {
    $null = $ws.ConnectAsync([Uri]$WsUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  } catch {
    if (-not $everConnected) { Write-Host "  Waiting for Ares ... ($($_.Exception.InnerException.Message))" }
    Start-Sleep -Seconds 3
    continue
  }
  Send-Json $ws @{ type = 'register'; token = $Token; hostname = $hostname; os = $osInfo; username = $env:USERNAME; ip = (Get-LocalIp) }
  $reply = Receive-Text $ws
  if (-not $reply) { Start-Sleep -Seconds 3; continue }
  $r = $reply | ConvertFrom-Json
  if ($r.type -eq 'error') { Write-Host "  $($r.message)"; break }
  $everConnected = $true
  $deadline = (Get-Date).AddHours(12)
  Write-Host "  Connected to Ares. Keep this window open." -ForegroundColor Green
  Show-AresPopup 'ARES CONNECTED' 'remote assistance active'

  while ($true) {
    $raw = Receive-Text $ws
    if ($null -eq $raw) { break }
    try { $cmd = $raw | ConvertFrom-Json } catch { continue }
    switch ($cmd.type) {
      'ping' { Send-Json $ws @{ type = 'pong' } }
      'exec' {
        $t = if ($cmd.timeoutMs) { [int]$cmd.timeoutMs } else { 30000 }
        $res = Invoke-Remote ([string]$cmd.command) $t
        Send-Json $ws @{ type = 'exec_result'; reqId = $cmd.reqId; output = [string]$res.output; exitCode = [int]$res.exitCode }
      }
      'screenshot' {
        Send-Json $ws @{ type = 'screenshot_result'; reqId = $cmd.reqId; error = 'Screen capture is not available from the script connector on Windows (antivirus blocks screen-scraping scripts). Use exec_on_pc to inspect the machine, or ask the owner to install the signed Ares connector.' }
      }
      'getfile' {
        try {
          $bytes = [IO.File]::ReadAllBytes([string]$cmd.path)
          Send-Json $ws @{ type = 'getfile_result'; reqId = $cmd.reqId; dataBase64 = [Convert]::ToBase64String($bytes); size = $bytes.Length }
        } catch { Send-Json $ws @{ type = 'getfile_result'; reqId = $cmd.reqId; error = $_.Exception.Message } }
      }
      'putfile' {
        try {
          $bytes = [Convert]::FromBase64String([string]$cmd.dataBase64)
          $dir = [IO.Path]::GetDirectoryName([string]$cmd.path)
          if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
          [IO.File]::WriteAllBytes([string]$cmd.path, $bytes)
          Send-Json $ws @{ type = 'putfile_result'; reqId = $cmd.reqId; bytes = $bytes.Length }
        } catch { Send-Json $ws @{ type = 'putfile_result'; reqId = $cmd.reqId; error = $_.Exception.Message } }
      }
      'notify' { Show-AresPopup ([string]$cmd.message) 'from Ares' }
      'bye' { $bye = $true; break }
    }
    if ($bye) { break }
  }
  try { $ws.Dispose() } catch {}
  if (-not $bye) { Write-Host '  Connection dropped — reconnecting ...'; Start-Sleep -Seconds 3 }
}
`;

// Mac/Linux connector. Reconnects on the same token; exits on "bye".
const AGENT_PY = `#!/usr/bin/env python3
"""Ares Remote Connect — one-time connector. Keep this running while Ares helps."""
import base64, json, os, platform, socket, ssl, struct, subprocess, sys, tempfile, threading, time

_WS_URL = "__ARES_WS_URL__"
_TOKEN  = "__ARES_TOKEN__"

# A tiny RFC 6455 WebSocket client on pure stdlib — no pip, no venv, works on
# any Python 3. (Homebrew/modern Python refuses "pip install" under PEP 668,
# which is why depending on websocket-client broke Mac connects.) CRLF is built
# from chr() so this source carries no backslash escapes through the bundler.
_CRLF = chr(13) + chr(10)


class _WS:
    def __init__(self):
        self.sock = None
        self._buf = b""

    def connect(self, url, timeout=30):
        proto, rest = url.split("://", 1)
        hostport, _slash, path = rest.partition("/")
        path = "/" + path
        if ":" in hostport:
            host, port = hostport.rsplit(":", 1); port = int(port)
        else:
            host = hostport; port = 443 if proto == "wss" else 80
        s = socket.create_connection((host, port), timeout=timeout)
        if proto == "wss":
            s = ssl._create_unverified_context().wrap_socket(s, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = _CRLF.join([
            "GET " + path + " HTTP/1.1",
            "Host: " + host + ":" + str(port),
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: " + key,
            "Sec-WebSocket-Version: 13",
            "", "",
        ])
        s.sendall(req.encode())
        sep = (_CRLF + _CRLF).encode()
        resp = b""
        while sep not in resp:
            chunk = s.recv(4096)
            if not chunk:
                raise IOError("handshake failed")
            resp += chunk
        head, self._buf = resp.split(sep, 1)
        if b" 101 " not in head.split(_CRLF.encode())[0]:
            raise IOError("server refused the websocket upgrade")
        s.settimeout(None)
        self.sock = s

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise IOError("connection closed")
            self._buf += chunk
        out = self._buf[:n]; self._buf = self._buf[n:]
        return out

    def _frame(self, opcode, data):
        header = bytearray([0x80 | opcode])
        mask = os.urandom(4); ln = len(data)
        if ln < 126:
            header.append(0x80 | ln)
        elif ln < 65536:
            header.append(0x80 | 126); header += struct.pack(">H", ln)
        else:
            header.append(0x80 | 127); header += struct.pack(">Q", ln)
        header += mask
        return bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(data))

    def send(self, text):
        if isinstance(text, str):
            text = text.encode()
        self.sock.sendall(self._frame(0x1, text))

    def recv(self):
        payload = bytearray()
        while True:
            b1 = self._read(1)[0]; b2 = self._read(1)[0]
            fin = b1 & 0x80; opcode = b1 & 0x0f
            ln = b2 & 0x7f
            if ln == 126:
                ln = struct.unpack(">H", self._read(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if (b2 & 0x80) else b""
            data = self._read(ln) if ln else b""
            if mask:
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if opcode == 0x8:
                return None
            if opcode == 0x9:
                self.sock.sendall(self._frame(0xA, data)); continue
            if opcode == 0xA:
                continue
            payload += data
            if fin:
                return payload.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.sendall(self._frame(0x8, b""))
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def _popup(text="ARES CONNECTED", sub="remote assistance active"):
    try:
        import tkinter as tk
        root = tk.Tk()
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = 340, 82
        root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 56}")
        root.configure(bg="#0d0d0d")
        pad = tk.Frame(root, bg="#0d0d0d", padx=14, pady=10); pad.pack(fill="both", expand=True)
        tk.Frame(pad, bg="#00ff88", height=2).pack(fill="x", pady=(0, 7))
        tk.Label(pad, text=f"\\u26a1  {text}", font=("Courier New", 12, "bold"), fg="#00ff88", bg="#0d0d0d", anchor="w").pack(fill="x")
        tk.Label(pad, text=sub, font=("Courier New", 8), fg="#555555", bg="#0d0d0d", anchor="w").pack(fill="x")
        root.attributes("-alpha", 0.0)
        def fade(a=0.0, d=1):
            if d == 1:
                na = min(a + 0.08, 0.92); root.attributes("-alpha", na)
                root.after(2800, lambda: fade(0.92, -1)) if na >= 0.84 else root.after(18, lambda: fade(na, 1))
            else:
                na = max(a - 0.06, 0.0); root.attributes("-alpha", na)
                root.after(18, lambda: fade(na, -1)) if na > 0 else root.destroy()
        root.after(80, fade)
        root.mainloop()
    except Exception:
        pass


def _local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80)); return s.getsockname()[0]
    except Exception:
        return "unknown"


def _capture_screen():
    # macOS has a built-in; elsewhere try Pillow, then common Linux tools.
    if sys.platform == "darwin":
        try:
            p = tempfile.mktemp(suffix=".png")
            subprocess.run(["screencapture", "-x", p], timeout=15, check=True)
            with open(p, "rb") as f: data = f.read()
            os.remove(p)
            return base64.b64encode(data).decode(), None
        except Exception as exc:
            return None, str(exc)
    try:
        import io
        from PIL import ImageGrab
        buf = io.BytesIO(); ImageGrab.grab().save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode(), None
    except Exception:
        pass
    for tool in (["gnome-screenshot", "-f"], ["scrot"], ["import", "-window", "root"]):
        try:
            p = tempfile.mktemp(suffix=".png")
            subprocess.run(tool + [p], timeout=15, check=True)
            with open(p, "rb") as f: data = f.read()
            os.remove(p)
            return base64.b64encode(data).decode(), None
        except Exception:
            continue
    return None, "no screen-capture tool available (install Pillow, scrot, or gnome-screenshot)"


def _session(ws):
    ws.send(json.dumps({"type": "register", "token": _TOKEN, "hostname": socket.gethostname(),
                        "os": f"{platform.system()} {platform.release()}",
                        "username": os.getenv("USER") or os.getenv("USERNAME") or "unknown", "ip": _local_ip()}))
    reply = json.loads(ws.recv())
    if reply.get("type") == "error":
        print(f"  {reply.get('message')}"); return "fatal"
    print("  Connected to Ares. Keep this window open.")
    threading.Thread(target=_popup, daemon=True).start()
    while True:
        raw = ws.recv()
        if not raw: return "dropped"
        try: cmd = json.loads(raw)
        except Exception: continue
        t = cmd.get("type")
        if t == "ping":
            # Keepalive. Cloudflare reaps a WebSocket idle for 100s, so the
            # reply is the whole point -- it puts a frame on the wire.
            ws.send(json.dumps({"type": "pong"}))
        elif t == "exec":
            timeout = max(1, int(cmd.get("timeoutMs") or 30000) / 1000)
            try:
                r = subprocess.run(cmd.get("command", ""), shell=True, capture_output=True, text=True, timeout=timeout)
                out, code = r.stdout + r.stderr, r.returncode
            except subprocess.TimeoutExpired:
                out, code = f"Command timed out after {int(timeout)}s.", -1
            except Exception as exc:
                out, code = str(exc), -1
            ws.send(json.dumps({"type": "exec_result", "reqId": cmd.get("reqId", ""), "output": out, "exitCode": code}))
        elif t == "screenshot":
            img, err = _capture_screen()
            if img: ws.send(json.dumps({"type": "screenshot_result", "reqId": cmd.get("reqId", ""), "dataBase64": img}))
            else: ws.send(json.dumps({"type": "screenshot_result", "reqId": cmd.get("reqId", ""), "error": err}))
        elif t == "getfile":
            try:
                with open(cmd.get("path", ""), "rb") as f: data = f.read()
                ws.send(json.dumps({"type": "getfile_result", "reqId": cmd.get("reqId", ""), "dataBase64": base64.b64encode(data).decode(), "size": len(data)}))
            except Exception as exc:
                ws.send(json.dumps({"type": "getfile_result", "reqId": cmd.get("reqId", ""), "error": str(exc)}))
        elif t == "putfile":
            try:
                raw = base64.b64decode(cmd.get("dataBase64", ""))
                p = cmd.get("path", ""); d = os.path.dirname(p)
                if d and not os.path.isdir(d): os.makedirs(d, exist_ok=True)
                with open(p, "wb") as f: f.write(raw)
                ws.send(json.dumps({"type": "putfile_result", "reqId": cmd.get("reqId", ""), "bytes": len(raw)}))
            except Exception as exc:
                ws.send(json.dumps({"type": "putfile_result", "reqId": cmd.get("reqId", ""), "error": str(exc)}))
        elif t == "notify":
            threading.Thread(target=_popup, args=(cmd.get("message", "Ares"), "from Ares"), daemon=True).start()
        elif t == "bye":
            return "bye"


def main():
    deadline = time.time() + 600
    connected_once = False
    while time.time() < deadline:
        ws = _WS()
        try:
            ws.connect(_WS_URL)
        except Exception as exc:
            if not connected_once: print(f"  Waiting for Ares ... ({exc})")
            time.sleep(3); continue
        try:
            outcome = _session(ws)
        except Exception:
            outcome = "dropped"
        finally:
            try: ws.close()
            except Exception: pass
        if outcome in ("bye", "fatal"): break
        connected_once = True
        deadline = time.time() + 12 * 3600
        print("  Connection dropped — reconnecting ..."); time.sleep(3)
    print("  Disconnected from Ares.")


if __name__ == "__main__":
    main()
`;

// ─── Landing page ──────────────────────────────────────────────────────────

function buildLandingHtml(base: string, token: string): string {
  const cmdUrl = `${base}/agent.cmd?token=${token}`;
  const pyUrl = `${base}/agent.py?token=${token}`;
  const nixOneLiner = `curl -fsSL '${pyUrl}' | python3`;
  // One clear action per OS. Windows auto-downloads a runnable file; Mac/Linux
  // get one line to paste (a browser can't run a script there). Everything
  // secondary is tucked away so the page reads "do this one thing".
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ares Remote Connect</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#ccc;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
  .card{border:1px solid #1e1e1e;border-top:3px solid #00ff88;background:#111;padding:2.5rem;max-width:480px;width:100%;text-align:center}
  .logo{font-size:1.5rem;font-weight:800;color:#00ff88;letter-spacing:.14em}
  .sub{font-size:.8rem;color:#555;margin:.35rem 0 1.75rem;text-transform:lowercase;letter-spacing:.04em}
  h1{font-size:1.15rem;color:#fff;margin-bottom:.6rem;font-weight:600}
  p{font-size:.9rem;color:#9a9a9a;line-height:1.6}
  .big{display:block;width:100%;margin:1.4rem 0 .5rem;padding:1.05rem;background:#00ff88;color:#000;text-decoration:none;font-weight:700;font-size:1rem;letter-spacing:.03em;border-radius:6px}
  .big:hover{opacity:.9}
  .then{font-size:.82rem;color:#777;margin-top:.4rem;line-height:1.6}
  .then b{color:#bbb;font-weight:600}
  .cmd{background:#0a0a0a;border:1px solid #222;border-radius:6px;padding:.85rem;font-family:ui-monospace,monospace;font-size:.82rem;word-break:break-all;color:#bbb;margin:1rem 0 .5rem;text-align:left}
  .copy{padding:.6rem 1rem;background:#00ff88;color:#000;border:none;border-radius:6px;font-weight:700;font-size:.85rem;cursor:pointer}
  .copy.ok{background:#005a33;color:#fff}
  .foot{font-size:.72rem;color:#4a4a4a;margin-top:1.6rem;border-top:1px solid #1c1c1c;padding-top:1rem;line-height:1.7}
  a{color:#00ff88}
  kbd{background:#1a1a1a;padding:.1rem .4rem;border:1px solid #333;border-radius:3px;font-size:.75rem}
  [hidden]{display:none!important}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ ARES</div>
  <div class="sub">someone is helping you · one-time link</div>

  <section id="win">
    <h1>Your download is starting…</h1>
    <p>Open the file when it lands, and you're connected.</p>
    <a class="big" href="${cmdUrl}" download="ares-connect.cmd">⬇  Download Ares Connect</a>
    <div class="then">Then: <b>open ares-connect</b> (bottom of your browser) → if Windows warns, <b>More info → Run anyway</b> → leave the little window open. Done.</div>
  </section>

  <section id="nix" hidden>
    <h1>One line to connect</h1>
    <p>Open Terminal (Mac: <kbd>⌘</kbd>+<kbd>Space</kbd> → "terminal"), paste this, press Enter:</p>
    <div class="cmd" id="c-nix">${nixOneLiner}</div>
    <button class="copy" onclick="copyNix(this)">⎘  Copy the command</button>
    <div class="then">Then leave the Terminal window open. Needs Python 3 (already on most Macs).</div>
  </section>

  <div class="foot">Works once, for this computer, expires in 10 minutes. Nothing is installed and it closes when you close the window.</div>
</div>
<script>
  var isWin = /Windows/i.test(navigator.userAgent);
  document.getElementById('win').hidden = !isWin;
  document.getElementById('nix').hidden = isWin;
  if (isWin) setTimeout(function () {
    var f = document.createElement('iframe'); f.hidden = true; f.src = ${JSON.stringify(cmdUrl)}; document.body.appendChild(f);
  }, 400);
  function copyNix(btn) {
    navigator.clipboard.writeText(document.getElementById('c-nix').textContent).then(function () {
      btn.textContent = '✓ Copied — paste it and press Enter'; btn.classList.add('ok');
    }).catch(function () { btn.textContent = 'Select the text above and copy it'; });
  }
</script>
</body>
</html>`;
}

const EXPIRED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Ares – Link Expired</title>
<style>body{font-family:monospace;background:#0d0d0d;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{border:1px solid #333;border-top:2px solid #ff4444;padding:2rem 3rem;text-align:center}
h2{color:#ff4444;margin:0 0 .5rem}p{margin:.25rem 0;color:#666}</style>
</head><body><div class="box">
<h2>This link has expired</h2>
<p>Ask the person helping you for a fresh one — it takes them two seconds.</p>
</div></body></html>`;

// â”€â”€â”€ Permanent pairing: landing page and installer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * The page the OWNER opens on the machine they are pairing.
 *
 * Deliberately blunt about what is being installed. This is not the one-time
 * help flow: it grants a machine's permanent, elevated, boot-time availability
 * to the owner's agent, and someone should be able to decide that from the page
 * rather than discover it afterwards.
 */
function buildPairLandingHtml(base: string, token: string): string {
  const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr '${base}/pair-install.ps1?token=${token}' -UseBasicParsing | iex"`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair this PC with Ares</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e9ef;
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.card{max-width:560px;padding:32px 28px}
h1{font-size:21px;margin:0 0 6px}
.sub{color:#8b93a7;margin:0 0 22px}
ol{padding-left:20px;margin:0 0 20px}li{margin:9px 0}
pre{background:#141821;border:1px solid #232a37;border-radius:8px;padding:13px;overflow-x:auto;
font:12.5px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#cfd6e4;white-space:pre-wrap;word-break:break-all}
.warn{background:#1b1512;border:1px solid #4a3520;border-radius:8px;padding:13px;margin:20px 0;color:#e8d5b7;font-size:13.5px}
.warn b{color:#f0c07a}
button{margin-top:9px;background:#2c6fdb;color:#fff;border:0;border-radius:7px;padding:9px 15px;font-size:13.5px;cursor:pointer}
button.ok{background:#2f7d4f}
.foot{color:#6b7488;font-size:12.5px;margin-top:22px}
</style></head><body><div class="card">
<h1>Pair this PC with Ares</h1>
<p class="sub">This is a <b>permanent</b> link, not a one-time session.</p>
<div class="warn">
<b>What this installs.</b> A task that starts when you sign in to this PC and connects to your
Ares, running in your own desktop session <b>with administrator rights</b>. From then on Ares can
run commands here and, because it runs in your session, see the screen and drive the mouse and
keyboard &mdash; the whole machine, whenever you are signed in.
Only do this on a machine you own. You can undo it at any time by unpairing the device in Ares,
which revokes the credential immediately.
</div>
<ol>
<li>Open <b>PowerShell as Administrator</b> (Start &rarr; type <i>powershell</i> &rarr; right-click &rarr; Run as administrator)</li>
<li>Paste this and press Enter:</li>
</ol>
<pre id="c">${cmd.replace(/</g, "&lt;")}</pre>
<button id="b" onclick="navigator.clipboard.writeText(document.getElementById('c').innerText).then(function(){var b=document.getElementById('b');b.textContent='âœ“ Copied';b.className='ok'})">Copy command</button>
<p class="foot">No password needed &mdash; it runs inside your own signed-in session. This link works once and
expires in 10 minutes.</p>
</div></body></html>`;
}

/** A .cmd for the double-click path â€” it just relaunches the real installer elevated. */
function buildPairCmd(base: string, token: string): string {
  return [
    "@echo off",
    "echo Ares Remote - pairing this PC (needs administrator).",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','iwr ''${base}/pair-install.ps1?token=${token}'' -UseBasicParsing | iex'"`,
    "echo If a UAC prompt appeared, approve it and follow the window that opens.",
    "pause",
  ].join("\r\n");
}

/**
 * The installer the owner actually pastes: fetch the connector, drop it on
 * disk, register the boot task, run it once so pairing completes immediately.
 *
 * Deliberately NOT silent. Someone granting permanent elevated access to a
 * machine should see each step happen and be able to stop.
 */
function buildPairInstallPs1(base: string, token: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())" +
      ".IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {",
    "  throw 'Run this in an ADMIN PowerShell - installing a boot task needs elevation.'",
    "}",
    "$dir = Join-Path $env:ProgramData 'Ares\\remote'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$script = Join-Path $dir 'ares-remote.ps1'",
    "Write-Host 'Downloading the Ares Remote connector...'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    `Invoke-WebRequest '${base}/pair.ps1?token=${token}' -UseBasicParsing -OutFile $script`,
    "",
    "$name = 'AresRemoteConnector'",
    "$ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + $script + '\"')",
    "# AtLogOn + Interactive, NOT AtStartup. A boot task runs in Windows session 0,",
    "# which has no desktop — so mouse, keyboard and screen capture do nothing there",
    "# (SetCursorPos silently no-ops, CopyFromScreen returns black). To DRIVE the",
    "# GUI the connector must run in the real logged-on session, which AtLogOn +",
    "# LogonType Interactive gives. Bonus: Interactive needs no stored password.",
    "# The trade is it starts at logon rather than before it — fine for a machine",
    "# someone signs into; exec/files/admin all still work, plus GUI control.",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn",
    "# A second trigger that fires every 5 minutes, forever. RestartCount only",
    "# covers a task the scheduler considers FAILED; a connector that exits 0",
    "# (killed, a clean throw, an antivirus stop) counts as completed and is",
    "# never restarted — the machine then sits there paired and unreachable",
    "# until the next logon. With MultipleInstances IgnoreNew this tick is free",
    "# while the connector is alive, and is the whole recovery when it is not.",
    "$heal = New-ScheduledTaskTrigger -Once -At (Get-Date) " +
      "-RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)",
    "$triggers = @($trigger, $heal)",
    "# ExecutionTimeLimit 0 = never time out; the default would kill it after days.",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries " +
      "-StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) " +
      "-ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew",
    "",
    "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {",
    "  Write-Host 'Replacing the existing Ares Remote task...'",
    "  Unregister-ScheduledTask -TaskName $name -Confirm:$false",
    "}",
    "",
    "# Runs as YOU, in your interactive desktop session, elevated. Interactive",
    "# logon means Windows runs it inside your logged-on session (so it can see",
    "# the screen and move the mouse) and needs NO password stored. SYSTEM would",
    "# have more privilege but no desktop and a different profile.",
    '$me = "$env:USERDOMAIN\\$env:USERNAME"',
    "$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest",
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null",
    "",
    "# The firewall blocks inbound by default, and a device that cannot be",
    "# reached on the LAN retries forever with nothing logged to say why.",
    "foreach ($r in @(@{n='Ares Remote (TCP 7422)';p='TCP';port=7422}, @{n='Ares Remote (UDP 7423)';p='UDP';port=7423})) {",
    "  if (-not (Get-NetFirewallRule -DisplayName $r.n -ErrorAction SilentlyContinue)) {",
    "    New-NetFirewallRule -DisplayName $r.n -Direction Inbound -Action Allow -Protocol $r.p -LocalPort $r.port -Profile Private | Out-Null",
    "  }",
    "}",
    "",
    "Write-Host 'Starting and pairing...'",
    "Start-ScheduledTask -TaskName $name",
    "Start-Sleep -Seconds 6",
    "$state = (Get-ScheduledTask -TaskName $name).State",
    "Write-Host ''",
    "if ($state -eq 'Running') {",
    "  Write-Host 'Done. This PC is paired and will reconnect on every boot.' -ForegroundColor Green",
    "} else {",
    "  Write-Host ('Task registered but its state is ' + $state + '. Check the log below.') -ForegroundColor Yellow",
    "}",
    "Write-Host ('Connector: ' + $script)",
    "Write-Host 'To undo: unpair the device in Ares, then run  Unregister-ScheduledTask -TaskName AresRemoteConnector -Confirm:$false'",
  ].join("\n");
}

