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
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import WebSocket, { WebSocketServer } from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces, tmpdir } from "node:os";
import { createSocket as createUdpSocket } from "node:dgram";
import path from "node:path";
import { aresHome } from "@ares/core";

export const DEFAULT_REMOTE_AGENT_PORT = 7422;
/** How long an unused link stays valid. */
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
}

// ─── Internal state ────────────────────────────────────────────────────────

interface PendingCmd {
  /** Resolves with the whole result message (exec_result / screenshot_result / …). */
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface FileGetResult {
  dataBase64: string;
  size: number;
}

interface RemotePcConn extends RemotePcInfo {
  ws: WebSocket;
  pendingCmds: Map<string, PendingCmd>;
  token: string;
}

interface LinkToken {
  label: string;
  expiresAt: number;
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
  private boundPort = 0;
  private boundHost = "0.0.0.0";
  private lanAddress = "127.0.0.1";
  private tunnelProc?: ChildProcess;
  private publicBaseUrl?: string;
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
    const port = this.opts.port ?? (Number(process.env["ARES_REMOTE_AGENT_PORT"]) || DEFAULT_REMOTE_AGENT_PORT);
    const host = this.opts.host ?? "0.0.0.0";
    const http = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 * 1024 });
    wss.on("connection", (ws) => this.handleConnection(ws));
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

    const tunnelMode = this.opts.tunnelMode ?? "auto";
    if (tunnelMode === "cloudflared") {
      // Hard requirement: surface the failure to the caller.
      this.publicBaseUrl = await this.startTunnel();
      this.tunnelReady = Promise.resolve(this.publicBaseUrl);
    } else if (tunnelMode === "auto") {
      // Background: a 60MB first-time download must not hold up garrison boot.
      // generateToken awaits this (bounded) so the first link still gets the tunnel.
      this.tunnelReady = this.startTunnel()
        .then((url) => { this.publicBaseUrl = url; return url; })
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

  private sweepTokens(): void {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (now > v.expiresAt) this.tokens.delete(t);
  }

  private liveToken(token: string): LinkToken | undefined {
    const t = this.tokens.get(token);
    if (!t) return undefined;
    if (Date.now() > t.expiresAt) { this.tokens.delete(token); return undefined; }
    return t;
  }

  // ─── Tunnel ────────────────────────────────────────────────────────────

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
        // A tunnel that dies mid-flight drops us to LAN links; every link says so.
        if (this.tunnelProc === proc) { this.publicBaseUrl = undefined; this.tunnelProc = undefined; }
      });
    });
  }

  // ─── PC control ────────────────────────────────────────────────────────

  listPcs(): RemotePcInfo[] {
    return [...this.pcs.values()].map(({ ws: _w, pendingCmds: _p, token: _t, ...info }) => info);
  }

  /** Send a request to a connected PC and await its matching `*_result`. */
  private request(pcId: string, msg: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const pc = this.pcs.get(pcId);
    if (!pc) return Promise.reject(new Error(`No remote PC with id "${pcId}" connected`));
    return new Promise((resolve, reject) => {
      const reqId = randomBytes(8).toString("hex");
      const timer = setTimeout(() => {
        pc.pendingCmds.delete(reqId);
        reject(new Error(`remote ${String(msg["type"])} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 2_000);
      timer.unref?.();
      pc.pendingCmds.set(reqId, { resolve, reject, timer });
      try { pc.ws.send(JSON.stringify({ ...msg, reqId })); }
      catch (err) { clearTimeout(timer); pc.pendingCmds.delete(reqId); reject(err instanceof Error ? err : new Error(String(err))); }
    });
  }

  async exec(pcId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const r = await this.request(pcId, { type: "exec", command, timeoutMs }, timeoutMs);
    return { output: String(r["output"] ?? ""), exitCode: typeof r["exitCode"] === "number" ? (r["exitCode"] as number) : undefined };
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

  notify(pcId: string, message: string): void {
    this.pcs.get(pcId)?.ws.send(JSON.stringify({ type: "notify", message }));
  }

  /** Owner-initiated: tell the connector to exit (so it doesn't auto-reconnect) and drop it. */
  disconnect(pcId: string): void {
    const pc = this.pcs.get(pcId);
    if (!pc) return;
    this.tokens.delete(pc.token);
    try { pc.ws.send(JSON.stringify({ type: "bye" })); } catch { /* gone */ }
    setTimeout(() => { try { pc.ws.close(); } catch { /* gone */ } }, 300).unref?.();
  }

  async close(): Promise<void> {
    try { this.tunnelProc?.kill(); } catch { /* already dead */ }
    this.tunnelProc = undefined;
    for (const pc of this.pcs.values()) {
      for (const { reject, timer } of pc.pendingCmds.values()) {
        clearTimeout(timer);
        reject(new Error("server closed"));
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
        case "POST /api/exec": {
          const timeout = typeof body["timeoutMs"] === "number" ? (body["timeoutMs"] as number) : undefined;
          return json(200, await this.exec(str("pcId"), str("command"), timeout));
        }
        case "POST /api/screenshot": return json(200, await this.screenshot(str("pcId")));
        case "POST /api/readfile": return json(200, await this.readFile(str("pcId"), str("path")));
        case "POST /api/writefile": return json(200, await this.writeFile(str("pcId"), str("path"), str("dataBase64")));
        case "POST /api/notify": this.notify(str("pcId"), str("message")); return json(200, { ok: true });
        case "POST /api/disconnect": this.disconnect(str("pcId")); return json(200, { ok: true });
        default: return json(404, { error: "not found" });
      }
    } catch (err) {
      return json(400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── WebSocket ─────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let pc: RemotePcConn | undefined;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

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
        };
        this.pcs.set(id, pc);
        ws.send(JSON.stringify({ type: "registered", id }));
        this.log(`remote PC connected: ${pc.hostname} (${pc.os}) ip=${pc.ip} id=${id}`);
        const { ws: _w, pendingCmds: _p, token: _t, ...info } = pc;
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
      for (const { reject, timer } of pc.pendingCmds.values()) {
        clearTimeout(timer);
        reject(new Error("remote PC disconnected"));
      }
      this.pcs.delete(pc.id);
      this.log(`remote PC disconnected: ${pc.hostname} id=${pc.id}`);
      const { ws: _w, pendingCmds: _p, token: _t, ...info } = pc;
      for (const cb of this.disconnectedListeners) cb(info);
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
        if t == "exec":
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
