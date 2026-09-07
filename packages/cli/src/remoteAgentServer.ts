// RemoteAgentServer — lightweight HTTP + WebSocket bridge for on-the-fly remote
// PC connections. The owner DMs Ares on Telegram ("I'm at Sarah's PC"), Ares
// generates a one-time link, the coworker downloads and runs a tiny Python script
// that phones home here, and Ares can then execute commands on their machine.
//
// Runs on a separate port (default 7422, ARES_REMOTE_AGENT_PORT) so it never
// collides with the garrison WS gateway (7421).

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export const DEFAULT_REMOTE_AGENT_PORT = 7422;
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Public types ──────────────────────────────────────────────────────────

export interface RemotePcInfo {
  id: string;
  label: string;      // how the user referred to this PC ("Sarah's PC")
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

export interface RemoteAgentServerOptions {
  port?: number;
  /** Bind address. Defaults to 0.0.0.0 so LAN peers can reach it. */
  host?: string;
  log?: (line: string) => void;
  /**
   * Controls tunnel behaviour for cross-network connections.
   * - "auto" (default): tries cloudflared; falls back to LAN URL silently if not installed.
   * - "cloudflared": requires cloudflared; throws if not available.
   * - "none": always use LAN URL (useful for local-only setups).
   */
  tunnelMode?: "auto" | "cloudflared" | "none";
}

// ─── Internal connection state ─────────────────────────────────────────────

interface PendingCmd {
  resolve: (r: ExecResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface RemotePcConn extends RemotePcInfo {
  ws: WebSocket;
  pendingCmds: Map<string, PendingCmd>;
}

// ─── Server ────────────────────────────────────────────────────────────────

export class RemoteAgentServer {
  private readonly opts: RemoteAgentServerOptions;
  private readonly log: (line: string) => void;
  private http?: HttpServer;
  private wss?: WebSocketServer;
  private readonly tokens = new Map<string, { label: string; expiresAt: number }>();
  private readonly pcs = new Map<string, RemotePcConn>();
  private boundPort = 0;
  private tunnelProc?: ChildProcess;
  private publicBaseUrl?: string; // set when cloudflared tunnel is active

  private readonly connectedListeners = new Set<(pc: RemotePcInfo) => void>();
  private readonly disconnectedListeners = new Set<(pc: RemotePcInfo) => void>();

  constructor(opts: RemoteAgentServerOptions = {}) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /** Subscribe to remote PC connect events. Returns an unsubscribe function. */
  onPcConnected(cb: (pc: RemotePcInfo) => void): () => void {
    this.connectedListeners.add(cb);
    return () => { this.connectedListeners.delete(cb); };
  }

  /** Subscribe to remote PC disconnect events. Returns an unsubscribe function. */
  onPcDisconnected(cb: (pc: RemotePcInfo) => void): () => void {
    this.disconnectedListeners.add(cb);
    return () => { this.disconnectedListeners.delete(cb); };
  }

  async start(): Promise<{ host: string; port: number }> {
    const port = this.opts.port ?? (Number(process.env["ARES_REMOTE_AGENT_PORT"]) || DEFAULT_REMOTE_AGENT_PORT);
    const host = this.opts.host ?? "0.0.0.0";
    const http = createServer((req, res) => this.handleHttp(req, res));
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (ws) => this.handleConnection(ws));
    this.http = http;
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, host, () => { http.off("error", reject); resolve(); });
    });
    const addr = http.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : port;
    this.log(`remote-agent listening on ${host}:${this.boundPort}`);

    const tunnelMode = this.opts.tunnelMode ?? "auto";
    if (tunnelMode !== "none") {
      try {
        this.publicBaseUrl = await this.startCloudflaredTunnel();
        this.log(`remote-agent tunnel: ${this.publicBaseUrl}`);
      } catch (err) {
        if (tunnelMode === "cloudflared") throw err; // hard requirement
        // "auto": cloudflared not installed or failed — silently use LAN URL
        this.log(`remote-agent tunnel unavailable (${err instanceof Error ? err.message : String(err)}), using LAN URL`);
      }
    }

    return { host, port: this.boundPort };
  }

  get port(): number { return this.boundPort; }

  /** The public base URL for generated links (tunnel URL when active, LAN URL otherwise). */
  linkBaseUrl(): string {
    return this.publicBaseUrl ?? `http://${this.lanIp()}:${this.boundPort}`;
  }

  /** Best-effort LAN IPv4 address — embedded in download links. */
  lanIp(): string {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "127.0.0.1";
  }

  /** Generate a one-time download token; returns the URL to send to the coworker. */
  generateToken(label: string): { token: string; url: string } {
    const token = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { label, expiresAt });
    setTimeout(() => this.tokens.delete(token), TOKEN_TTL_MS + 1_000).unref?.();
    const url = `${this.linkBaseUrl()}/agent?token=${token}`;
    return { token, url };
  }

  /** Start a Cloudflare Quick Tunnel pointing at the local port. Resolves with the public HTTPS base URL. */
  private startCloudflaredTunnel(): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${this.boundPort}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.tunnelProc = proc;

      const timeoutHandle = setTimeout(() => {
        reject(new Error("cloudflared tunnel URL not found within 30s — is cloudflared installed?"));
      }, 30_000);

      let buf = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timeoutHandle);
          resolve(match[0]);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        reject(new Error(`cloudflared not found: ${err.message} — install with: brew install cloudflare/cloudflare/cloudflared`));
      });

      proc.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0 && code !== null) reject(new Error(`cloudflared exited early (code ${code})`));
      });
    });
  }

  /** Enumerate connected remote PCs (info only, no WS reference). */
  listPcs(): RemotePcInfo[] {
    return [...this.pcs.values()].map(({ ws: _w, pendingCmds: _p, ...info }) => info);
  }

  /** Run a shell command on a connected remote PC. */
  exec(pcId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    const pc = this.pcs.get(pcId);
    if (!pc) return Promise.reject(new Error(`No remote PC with id "${pcId}" connected`));
    return new Promise((resolve, reject) => {
      const reqId = randomBytes(8).toString("hex");
      const timer = setTimeout(() => {
        pc.pendingCmds.delete(reqId);
        reject(new Error("remote command timed out"));
      }, timeoutMs);
      timer.unref?.();
      pc.pendingCmds.set(reqId, { resolve, reject, timer });
      pc.ws.send(JSON.stringify({ type: "exec", reqId, command }));
    });
  }

  /** Show a popup notification on a connected remote PC (fire-and-forget). */
  notify(pcId: string, message: string): void {
    this.pcs.get(pcId)?.ws.send(JSON.stringify({ type: "notify", message }));
  }

  async close(): Promise<void> {
    try { this.tunnelProc?.kill(); } catch { /* already dead */ }
    this.tunnelProc = undefined;
    for (const pc of this.pcs.values()) {
      for (const { reject, timer } of pc.pendingCmds.values()) {
        clearTimeout(timer);
        reject(new Error("server closed"));
      }
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

  // ─── HTTP ──────────────────────────────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pcs: this.pcs.size }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/agent") {
      const token = url.searchParams.get("token") ?? "";
      const pending = this.tokens.get(token);
      if (!pending || Date.now() > pending.expiresAt) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8" });
        res.end(EXPIRED_HTML);
        return;
      }
      const accept = req.headers["accept"] ?? "";
      const ua = req.headers["user-agent"] ?? "";
      const isBrowser = accept.includes("text/html") && !ua.includes("python") && !ua.includes("curl") && !ua.includes("wget");
      if (isBrowser) {
        const scriptUrl = `${this.linkBaseUrl()}/script?token=${token}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(buildConnectHtml(scriptUrl));
        return;
      }
      // Non-browser (curl, python, wget): serve raw script
      const base = this.linkBaseUrl();
      const wsUrl = base.replace(/^http/, "ws") + "/ws";
      const script = buildAgentScript(token, wsUrl);
      res.writeHead(200, {
        "content-type": "text/x-python; charset=utf-8",
        "content-disposition": 'attachment; filename="ares-connect.py"',
      });
      res.end(script);
      return;
    }

    if (req.method === "GET" && url.pathname === "/script") {
      const token = url.searchParams.get("token") ?? "";
      const pending = this.tokens.get(token);
      if (!pending || Date.now() > pending.expiresAt) {
        res.writeHead(410, { "content-type": "text/plain" });
        res.end("# Link expired. Ask Ares for a new one.\n");
        return;
      }
      const base = this.linkBaseUrl();
      const wsUrl = base.replace(/^http/, "ws") + "/ws";
      const script = buildAgentScript(token, wsUrl);
      res.writeHead(200, {
        "content-type": "text/x-python; charset=utf-8",
        "content-disposition": 'attachment; filename="ares-connect.py"',
      });
      res.end(script);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  // ─── WebSocket ─────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let pc: RemotePcConn | undefined;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      if (msg["type"] === "register") {
        const token = String(msg["token"] ?? "");
        const pending = this.tokens.get(token);
        if (!pending || Date.now() > pending.expiresAt) {
          ws.send(JSON.stringify({ type: "error", message: "invalid or expired token" }));
          ws.close();
          return;
        }
        this.tokens.delete(token);
        const id = randomBytes(8).toString("hex");
        pc = {
          id,
          label: pending.label,
          hostname: String(msg["hostname"] ?? "unknown"),
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
        const { ws: _w, pendingCmds: _p, ...info } = pc;
        for (const cb of this.connectedListeners) cb(info);
        return;
      }

      if (msg["type"] === "exec_result" && pc) {
        const reqId = String(msg["reqId"] ?? "");
        const pend = pc.pendingCmds.get(reqId);
        if (pend) {
          clearTimeout(pend.timer);
          pc.pendingCmds.delete(reqId);
          pend.resolve({
            output: String(msg["output"] ?? ""),
            exitCode: typeof msg["exitCode"] === "number" ? msg["exitCode"] : undefined,
          });
        }
      }
    });

    ws.on("close", () => {
      if (!pc) return;
      for (const { reject, timer } of pc.pendingCmds.values()) {
        clearTimeout(timer);
        reject(new Error("remote PC disconnected"));
      }
      this.pcs.delete(pc.id);
      this.log(`remote PC disconnected: ${pc.hostname} id=${pc.id}`);
      const { ws: _w, pendingCmds: _p, ...info } = pc;
      for (const cb of this.disconnectedListeners) cb(info);
      pc = undefined;
    });

    ws.on("error", () => { /* surfaces as close */ });
  }
}

// ─── Python agent script generator ────────────────────────────────────────

function buildAgentScript(token: string, wsUrl: string): string {
  return AGENT_PY
    .replace("__ARES_TOKEN__", token)
    .replace("__ARES_WS_URL__", wsUrl);
}

// The script is embedded as a multi-line string so it ships as part of the
// compiled JS bundle — no separate asset file to distribute.
const AGENT_PY = `#!/usr/bin/env python3
"""
Ares Remote Connect — auto-generated one-time script.
Run this on the PC where you need help to let Ares connect.
"""
import json, os, platform, socket, subprocess, sys, threading

# ── Auto-install websocket-client if absent ────────────────────────────────
try:
    import websocket
except ImportError:
    print("Installing websocket-client (one-time) ...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "websocket-client"])
    import websocket  # noqa: E401

# ── Connection config (embedded by Ares) ───────────────────────────────────
_WS_URL = "__ARES_WS_URL__"
_TOKEN  = "__ARES_TOKEN__"


# ── "Ares Connected" animated popup ────────────────────────────────────────
def _ares_popup(text="ARES CONNECTED", sub="remote assistance active"):
    try:
        import tkinter as tk
        root = tk.Tk()
        root.title("")
        root.overrideredirect(True)
        root.attributes("-topmost", True)
        sw = root.winfo_screenwidth()
        sh = root.winfo_screenheight()
        w, h = 340, 82
        root.geometry(f"{w}x{h}+{sw - w - 20}+{sh - h - 56}")
        root.configure(bg="#0d0d0d")
        pad = tk.Frame(root, bg="#0d0d0d", padx=14, pady=10)
        pad.pack(fill="both", expand=True)
        tk.Frame(pad, bg="#00ff88", height=2).pack(fill="x", pady=(0, 7))
        tk.Label(pad, text=f"\\u26a1  {text}", font=("Courier New", 12, "bold"),
                 fg="#00ff88", bg="#0d0d0d", anchor="w").pack(fill="x")
        tk.Label(pad, text=sub, font=("Courier New", 8),
                 fg="#555555", bg="#0d0d0d", anchor="w").pack(fill="x")
        root.attributes("-alpha", 0.0)

        def _fade(a=0.0, direction=1):
            if direction == 1:
                na = min(a + 0.08, 0.92)
                root.attributes("-alpha", na)
                if na >= 0.84:
                    root.after(2800, lambda: _fade(0.92, -1))
                else:
                    root.after(18, lambda: _fade(na, 1))
            else:
                na = max(a - 0.06, 0.0)
                root.attributes("-alpha", na)
                if na > 0.0:
                    root.after(18, lambda: _fade(na, -1))
                else:
                    root.destroy()

        root.after(80, _fade)
        root.mainloop()
    except Exception:
        pass


def _get_local_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "unknown"


def main():
    hostname = socket.gethostname()
    username = os.getenv("USER") or os.getenv("USERNAME") or "unknown"
    os_info  = f"{platform.system()} {platform.release()}"
    ip       = _get_local_ip()

    print(f"Connecting to Ares ...")
    ws = websocket.WebSocket(sslopt={"check_hostname": False} if _WS_URL.startswith("wss://") else {})
    try:
        ws.connect(_WS_URL)
    except Exception as exc:
        print(f"\\u274c  Connection failed: {exc}")
        print(f"If this link came from Telegram, make sure it hasn't expired (10 min).")
        sys.exit(1)

    ws.send(json.dumps({
        "type": "register", "token": _TOKEN,
        "hostname": hostname, "os": os_info,
        "username": username, "ip": ip,
    }))

    raw = ws.recv()
    reply = json.loads(raw)
    if reply.get("type") == "error":
        print(f"\\u274c  {reply.get('message')}")
        ws.close()
        sys.exit(1)

    pc_id = reply.get("id")
    print(f"\\u2713  Connected! PC id: {pc_id}")
    print("Keep this window open. Ares is ready to help.")

    threading.Thread(target=_ares_popup, daemon=True).start()

    while True:
        try:
            raw = ws.recv()
            if not raw:
                break
        except Exception:
            break
        try:
            cmd = json.loads(raw)
        except Exception:
            continue

        if cmd.get("type") == "exec":
            req_id  = cmd.get("reqId", "")
            command = cmd.get("command", "")
            try:
                r = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
                output    = r.stdout + r.stderr
                exit_code = r.returncode
            except subprocess.TimeoutExpired:
                output, exit_code = "Command timed out after 30s.", -1
            except Exception as exc:
                output, exit_code = str(exc), -1
            ws.send(json.dumps({"type": "exec_result", "reqId": req_id,
                                "output": output, "exitCode": exit_code}))

        elif cmd.get("type") == "notify":
            msg_text = cmd.get("message", "Ares")
            threading.Thread(target=_ares_popup, args=(msg_text,), daemon=True).start()

    print("Disconnected from Ares.")
    ws.close()


if __name__ == "__main__":
    main()
`;

function buildConnectHtml(scriptUrl: string): string {
  const winCmd = `python -c "import urllib.request; exec(urllib.request.urlopen('${scriptUrl}').read())"`;
  const macCmd = `python3 -c "import urllib.request; exec(urllib.request.urlopen('${scriptUrl}').read())"`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ares Remote Connect</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0d0d;color:#ccc;font-family:'Courier New',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
  .card{border:1px solid #1e1e1e;border-top:2px solid #00ff88;background:#111;padding:2.5rem 3rem;max-width:640px;width:100%}
  .logo{font-size:1.4rem;font-weight:bold;color:#00ff88;letter-spacing:.12em;margin-bottom:.25rem}
  .sub{font-size:.8rem;color:#444;margin-bottom:2rem}
  h2{font-size:1rem;color:#ccc;margin-bottom:.5rem;letter-spacing:.06em}
  .step{display:flex;gap:1rem;align-items:flex-start;margin-bottom:1.5rem}
  .num{background:#00ff88;color:#000;font-weight:bold;font-size:.8rem;min-width:22px;height:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px}
  .cmd-box{background:#0a0a0a;border:1px solid #222;padding:.9rem 1rem;font-size:.8rem;word-break:break-all;line-height:1.5;color:#aaa;margin-top:.4rem;position:relative}
  .copy-btn{display:block;width:100%;margin-top:.6rem;padding:.55rem;background:#00ff88;color:#000;font-family:'Courier New',monospace;font-weight:bold;font-size:.85rem;border:none;cursor:pointer;letter-spacing:.08em;transition:opacity .15s}
  .copy-btn:hover{opacity:.85}
  .copy-btn.copied{background:#005533}
  .tabs{display:flex;gap:.5rem;margin-bottom:.75rem}
  .tab{padding:.35rem .9rem;font-family:'Courier New',monospace;font-size:.78rem;background:#0a0a0a;border:1px solid #222;color:#555;cursor:pointer}
  .tab.active{border-color:#00ff88;color:#00ff88}
  .note{font-size:.75rem;color:#444;margin-top:1.5rem;line-height:1.6;border-top:1px solid #1e1e1e;padding-top:1rem}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡ ARES</div>
  <div class="sub">remote connect · one-time link</div>

  <div class="step">
    <div class="num">1</div>
    <div style="flex:1">
      <h2>OPEN A TERMINAL</h2>
      <div style="font-size:.78rem;color:#555;margin-top:.3rem">
        Windows: press <kbd style="background:#1a1a1a;padding:.1rem .4rem;border:1px solid #333">Win+R</kbd> → type <code>cmd</code> → Enter &nbsp;·&nbsp;
        Mac: <kbd style="background:#1a1a1a;padding:.1rem .4rem;border:1px solid #333">⌘ Space</kbd> → type <code>terminal</code> → Enter
      </div>
    </div>
  </div>

  <div class="step">
    <div class="num">2</div>
    <div style="flex:1">
      <h2>COPY &amp; PASTE THIS COMMAND</h2>
      <div class="tabs">
        <div class="tab active" onclick="showOs('win',this)">Windows</div>
        <div class="tab" onclick="showOs('mac',this)">Mac / Linux</div>
      </div>
      <div id="cmd-win" class="cmd-box">${winCmd}</div>
      <div id="cmd-mac" class="cmd-box" hidden>${macCmd}</div>
      <button class="copy-btn" id="copyBtn" onclick="doCopy()">⎘ COPY COMMAND</button>
    </div>
  </div>

  <div class="step">
    <div class="num">3</div>
    <div style="flex:1">
      <h2>PRESS ENTER</h2>
      <div style="font-size:.78rem;color:#555;margin-top:.3rem">
        Ares will confirm on Telegram. A notification will appear on this screen.
      </div>
    </div>
  </div>

  <div class="note">
    This link expires in 10 minutes and can only be used once.<br>
    Python 3 must be installed — most work PCs already have it.
    If not: <a href="https://python.org/downloads" style="color:#00ff88">python.org/downloads</a>
  </div>
</div>
<script>
  var os = 'win';
  function showOs(which, el) {
    os = which;
    document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});
    el.classList.add('active');
    document.getElementById('cmd-win').hidden = which !== 'win';
    document.getElementById('cmd-mac').hidden = which !== 'mac';
    document.getElementById('copyBtn').classList.remove('copied');
    document.getElementById('copyBtn').textContent = '⎘ COPY COMMAND';
  }
  function doCopy() {
    var cmd = document.getElementById('cmd-' + os).textContent;
    navigator.clipboard.writeText(cmd).then(function() {
      var btn = document.getElementById('copyBtn');
      btn.textContent = '✓ COPIED — paste in terminal & press Enter';
      btn.classList.add('copied');
    }).catch(function() {
      var cmd = document.getElementById('cmd-' + os);
      cmd.style.background = '#001a0d';
      setTimeout(function(){cmd.style.background='';}, 800);
    });
  }
  // Auto-detect OS
  if (!navigator.platform.toLowerCase().includes('win')) {
    showOs('mac', document.querySelectorAll('.tab')[1]);
  }
</script>
</body>
</html>`;
}

const EXPIRED_HTML = `<!doctype html>
<html><head><title>Ares – Link Expired</title>
<style>body{font-family:monospace;background:#0d0d0d;color:#ccc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{border:1px solid #333;padding:2rem 3rem;text-align:center}
h2{color:#ff4444;margin:0 0 .5rem}p{margin:.25rem 0;color:#666}</style>
</head><body><div class="box">
<h2>Link Expired</h2>
<p>Ask Ares to generate a new connection link on Telegram.</p>
</div></body></html>`;
