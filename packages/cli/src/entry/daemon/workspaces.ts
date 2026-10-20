// Workspaces — a VPS your agents work on.
//
// Owner, 2026-10-20: "there should be an option to add a VPS for your agent —
// it can help you set it up — and in group chats pick a VPS for agents to use."
//
// A workspace is a Linux box the owner rents. Ares never asks for a password
// or a private key: it MAKES its own ed25519 key for that box and shows the
// public half, which the owner pastes into the provider's "SSH keys" field (or
// the box's ~/.ssh/authorized_keys). After that, Ares can test the box, set up
// a work folder, and the Workspace tool lets an agent run commands and move
// files there — in ~/ares-work/<room or agent>, never anywhere on the owner's
// own PC. Which box: the room's workspace for room seats and room work
// threads, else the agent's own, else the only one there is.
//
// Uses the system OpenSSH client (ssh, scp, ssh-keygen — built into Windows
// 10+, macOS and every Linux). Host keys are pinned per workspace on first use
// (StrictHostKeyChecking=accept-new into the workspace's own known_hosts).

import { spawn } from "node:child_process";
import { createServer } from "node:net";

/** A free 127.0.0.1 port for a tunnel. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface Workspace {
  id: string;
  label: string;
  host: string;
  user: string;
  port: number;
  /** The public key the owner adds to the box. */
  publicKey: string;
  status: "new" | "ok" | "error";
  /** What the last check found ("Ubuntu 24.04 · 4 CPU · 7.6 GB"). */
  info?: string;
  error?: string;
  setUp?: boolean;
  addedAt: string;
  checkedAt?: string;
}

export class WorkspaceError extends Error {}

const HOST_RE = /^(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[[0-9a-fA-F:]+\]$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Run a program with args (never a shell string), capped output, timeout. */
export function runProgram(cmd: string, args: string[], opts: { timeoutMs?: number; input?: string; cap?: number } = {}): Promise<RunResult> {
  const cap = opts.cap ?? 60_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (c: Buffer) => { if (stdout.length < cap) stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { if (stderr.length < cap) stderr += c.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(error.message ?? error), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.slice(0, cap), stderr: stderr.slice(0, cap), timedOut }); });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** A folder name a room or agent works in on the box. */
export function workFolder(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work";
}

export interface WorkspacesDeps {
  home: string;
  emit(payload: Record<string, unknown>): void;
  /** Override for tests. */
  run?: typeof runProgram;
  now?: () => number;
}

export class DesktopWorkspaces {
  private list_: Workspace[] = [];
  private readonly run: typeof runProgram;
  private readonly now: () => number;

  constructor(private readonly deps: WorkspacesDeps) {
    this.run = deps.run ?? runProgram;
    this.now = deps.now ?? Date.now;
  }

  private file(): string { return path.join(this.deps.home, "workspaces.json"); }
  private dir(id: string): string { return path.join(this.deps.home, "workspaces", id); }
  private keyPath(id: string): string { return path.join(this.dir(id), "id_ed25519"); }

  async load(): Promise<Workspace[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(), "utf8")) as Workspace[];
      this.list_ = Array.isArray(raw) ? raw.filter((w) => w && typeof w.id === "string" && typeof w.host === "string") : [];
    } catch {
      this.list_ = [];
    }
    return this.list();
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.deps.home, { recursive: true });
    await fs.writeFile(this.file(), JSON.stringify(this.list_, null, 2), "utf8");
    this.deps.emit({ type: "workspaces_list", workspaces: this.list() });
  }

  list(): Workspace[] { return this.list_.map((w) => ({ ...w })); }
  get(id: string): Workspace | undefined { return this.list_.find((w) => w.id === id); }

  /** Add a box: make Ares's own key for it; the owner adds the public half. */
  async add(spec: { label?: unknown; host?: unknown; user?: unknown; port?: unknown }): Promise<Workspace> {
    const host = typeof spec.host === "string" ? spec.host.trim() : "";
    if (!HOST_RE.test(host)) throw new WorkspaceError("the address must be an IP or a hostname (no http://, no path)");
    const user = typeof spec.user === "string" && spec.user.trim() ? spec.user.trim() : "root";
    if (!USER_RE.test(user)) throw new WorkspaceError("the user name looks wrong — usually root, or the user your provider gave you");
    const port = typeof spec.port === "number" && spec.port > 0 && spec.port < 65536 ? Math.round(spec.port) : 22;
    const id = `ws_${randomBytes(4).toString("hex")}`;
    await fs.mkdir(this.dir(id), { recursive: true });
    const keygen = await this.run("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-C", `ares-${id}`, "-f", this.keyPath(id)], { timeoutMs: 20_000 });
    if (keygen.code !== 0) throw new WorkspaceError(`couldn't make a key (is OpenSSH installed?): ${(keygen.stderr || keygen.stdout).trim().slice(0, 200)}`);
    // Windows OpenSSH refuses a private key other users can read.
    if (process.platform === "win32") {
      const me = process.env.USERNAME ?? "";
      if (me) await this.run("icacls", [this.keyPath(id), "/inheritance:r", "/grant:r", `${me}:F`], { timeoutMs: 10_000 });
    } else {
      await fs.chmod(this.keyPath(id), 0o600).catch(() => undefined);
    }
    const publicKey = (await fs.readFile(`${this.keyPath(id)}.pub`, "utf8")).trim();
    const ws: Workspace = {
      id,
      label: (typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : host).slice(0, 40),
      host,
      user,
      port,
      publicKey,
      status: "new",
      addedAt: new Date(this.now()).toISOString(),
    };
    this.list_.push(ws);
    await this.save();
    return ws;
  }

  /** Live previews: a PRIVATE tunnel from this PC to a port on the box
   *  (ssh -L, bound to 127.0.0.1 only). Nothing is opened to the internet;
   *  only this PC can load it. One per box+port, closed after TUNNEL_TTL_MS. */
  private readonly tunnels = new Map<string, { port: number; child: { kill(): void }; timer: NodeJS.Timeout }>();
  static readonly TUNNEL_TTL_MS = 2 * 60 * 60_000;

  async forward(id: string, remotePort: number, opts: { spawnImpl?: typeof spawn; localPort?: number } = {}): Promise<{ url: string; localPort: number; reused: boolean }> {
    const ws = this.get(id);
    if (!ws) throw new WorkspaceError("unknown workspace");
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new WorkspaceError("port must be 1–65535");
    const key = `${id}:${remotePort}`;
    const open = this.tunnels.get(key);
    if (open) return { url: `http://127.0.0.1:${open.port}/`, localPort: open.port, reused: true };
    const localPort = opts.localPort ?? (await freePort());
    const child = (opts.spawnImpl ?? spawn)("ssh", [...this.sshArgs(ws), "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, `${ws.user}@${ws.host}`], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => this.unforward(key), DesktopWorkspaces.TUNNEL_TTL_MS);
    timer.unref?.();
    child.on?.("exit", () => { const t = this.tunnels.get(key); if (t && t.child === child) { clearTimeout(t.timer); this.tunnels.delete(key); } });
    this.tunnels.set(key, { port: localPort, child, timer });
    // give ssh a moment to bind (or fail fast on a refused forward)
    await new Promise((r) => setTimeout(r, opts.spawnImpl ? 0 : 1200));
    if (!this.tunnels.has(key)) throw new WorkspaceError(`couldn't reach port ${remotePort} on ${ws.label} — is the server running there?`);
    return { url: `http://127.0.0.1:${localPort}/`, localPort, reused: false };
  }

  private unforward(key: string): void {
    const t = this.tunnels.get(key);
    if (!t) return;
    clearTimeout(t.timer);
    try { t.child.kill(); } catch { /* already gone */ }
    this.tunnels.delete(key);
  }

  closeTunnels(id?: string): void {
    for (const key of [...this.tunnels.keys()]) if (!id || key.startsWith(`${id}:`)) this.unforward(key);
  }

  async remove(id: string): Promise<void> {
    this.closeTunnels(id);
    this.list_ = this.list_.filter((w) => w.id !== id);
    await fs.rm(this.dir(id), { recursive: true, force: true }).catch(() => undefined);
    await this.save();
  }

  private sshArgs(ws: Workspace): string[] {
    return [
      "-i", this.keyPath(ws.id),
      "-p", String(ws.port),
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${path.join(this.dir(ws.id), "known_hosts")}`,
      "-o", "ConnectTimeout=12",
      "-o", "ServerAliveInterval=15",
    ];
  }

  /** Run a shell command on the box (in ~/ares-work/<folder> when given). */
  async exec(id: string, command: string, opts: { folder?: string; timeoutMs?: number } = {}): Promise<RunResult> {
    const ws = this.get(id);
    if (!ws) throw new WorkspaceError("unknown workspace");
    const folder = opts.folder ? workFolder(opts.folder) : "";
    const prefix = folder ? `mkdir -p ~/ares-work/${folder} && cd ~/ares-work/${folder} && ` : "";
    return this.run("ssh", [...this.sshArgs(ws), `${ws.user}@${ws.host}`, `${prefix}${command}`], { timeoutMs: opts.timeoutMs ?? 120_000, cap: 40_000 });
  }

  async put(id: string, localPath: string, remoteName: string, folder: string): Promise<RunResult> {
    const ws = this.get(id);
    if (!ws) throw new WorkspaceError("unknown workspace");
    const dest = `~/ares-work/${workFolder(folder)}/${remoteName.replace(/^\/+/, "").replace(/\.\.\//g, "")}`;
    await this.exec(id, `mkdir -p "$(dirname ${dest})"`, { timeoutMs: 30_000 });
    return this.run("scp", ["-i", this.keyPath(ws.id), "-P", String(ws.port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${path.join(this.dir(ws.id), "known_hosts")}`, localPath, `${ws.user}@${ws.host}:${dest}`], { timeoutMs: 180_000 });
  }

  async get_(id: string, remoteName: string, folder: string, localPath: string): Promise<RunResult> {
    const ws = this.get(id);
    if (!ws) throw new WorkspaceError("unknown workspace");
    const src = `~/ares-work/${workFolder(folder)}/${remoteName.replace(/^\/+/, "").replace(/\.\.\//g, "")}`;
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    return this.run("scp", ["-i", this.keyPath(ws.id), "-P", String(ws.port), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${path.join(this.dir(ws.id), "known_hosts")}`, `${ws.user}@${ws.host}:${src}`, localPath], { timeoutMs: 180_000 });
  }

  private async mark(id: string, patch: Partial<Workspace>): Promise<Workspace> {
    const i = this.list_.findIndex((w) => w.id === id);
    if (i < 0) throw new WorkspaceError("unknown workspace");
    this.list_[i] = { ...this.list_[i]!, ...patch, checkedAt: new Date(this.now()).toISOString() };
    await this.save();
    return { ...this.list_[i]! };
  }

  /** Can Ares get in? What is it? */
  async test(id: string): Promise<Workspace> {
    const out = await this.exec(id, `. /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-$(uname -sr)} · $(nproc 2>/dev/null || echo ?) CPU · $(awk '/MemTotal/{printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null)"`, { timeoutMs: 25_000 });
    if (out.code === 0) return this.mark(id, { status: "ok", info: out.stdout.trim().slice(0, 120), error: undefined });
    const err = (out.stderr || out.stdout).trim();
    const hint = /Permission denied/i.test(err)
      ? "the box doesn't know Ares's key yet — add the public key above to it, then test again"
      : /timed out|No route|Connection refused|Could not resolve/i.test(err) || out.timedOut
        ? "couldn't reach the box — check the address and that SSH (port " + (this.get(id)?.port ?? 22) + ") is open"
        : err.slice(0, 200) || "the connection failed";
    return this.mark(id, { status: "error", error: hint });
  }

  /** Make the box ready for agents: a work folder and the basic tools. Only
   *  installs packages when the user can (root or passwordless sudo). */
  async setUp(id: string): Promise<Workspace> {
    const script = [
      "set -e",
      "mkdir -p ~/ares-work",
      'SUDO=""; if [ "$(id -u)" != "0" ]; then if sudo -n true 2>/dev/null; then SUDO="sudo"; else SUDO="none"; fi; fi',
      'if [ "$SUDO" != "none" ] && command -v apt-get >/dev/null 2>&1; then',
      "  export DEBIAN_FRONTEND=noninteractive",
      "  $SUDO apt-get update -qq >/dev/null",
      "  $SUDO apt-get install -y -qq git curl ca-certificates python3 unzip >/dev/null",
      "  if ! command -v node >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - >/dev/null 2>&1 && $SUDO apt-get install -y -qq nodejs >/dev/null; fi",
      "fi",
      'echo "git:$(command -v git >/dev/null && echo yes || echo no) node:$(node -v 2>/dev/null || echo no) python:$(python3 -V 2>/dev/null | cut -d" " -f2 || echo no)"',
    ].join("\n");
    const out = await this.exec(id, `bash -s <<'ARES_SETUP'\n${script}\nARES_SETUP`, { timeoutMs: 600_000 });
    if (out.code !== 0) return this.mark(id, { status: "error", error: (out.stderr || out.stdout).trim().slice(-200) || "setup failed" });
    const tested = await this.test(id);
    return this.mark(id, { setUp: true, info: `${tested.info ?? ""} · ${out.stdout.trim().split("\n").pop() ?? ""}`.slice(0, 200) });
  }
}
