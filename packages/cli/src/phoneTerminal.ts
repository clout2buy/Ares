// The phone's Terminal tab, server side: a real PTY shell on the garrison box,
// owner-only, over the same origin and tunnel as the rest of the phone API.
// The contract (routes, frames, limits, the honest risk statement) is
// docs/TERMINAL.md; this file is the implementation of it.
//
// Shape of the machine:
//   * tmux (one session per terminal id, dedicated socket) owns the real PTY,
//     so job control, Ctrl-C, vim/htop, colors, UTF-8 and SIGWINCH are the
//     kernel's and tmux's, not ours, and the shell outlives any phone.
//   * Output is read RAW from the pane (tmux pipe-pane into a private FIFO)
//     into a ring per terminal. The phone's emulator keeps native scrollback,
//     and a returning phone can be caught up byte-exactly from a `seq`.
//   * Input goes back as exact bytes through `tmux send-keys -H`.
//   * A slow phone never blocks anything: output lands in the ring regardless,
//     and a client that falls too far behind is resynced with a fresh screen
//     snapshot (capture-pane) instead of being fed an unbounded queue.
//
// No new native dependency: tmux is a binary on the box, everything else is
// node:child_process.

import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type WebSocket from "ws";
import { appendAudit, ownerPause, registerStoppable } from "@ares/core";

// ─── Limits ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX = 6;
const DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;
const DEAD_REAP_MS = 10 * 60 * 1000;
const RING_BYTES = 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 256 * 1024;
const FLUSH_MS = 30;
const HIGH_WATER_BYTES = 512 * 1024;
const MAX_LAG_BYTES = 512 * 1024;
const FRAME_BYTES = 32 * 1024;
const FLUSH_BUDGET_BYTES = 256 * 1024;
const IN_FRAME_MAX = 64 * 1024;
const WS_MESSAGE_MAX = 128 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const WS_PING_MS = 20_000;
const WS_SILENCE_MS = 75_000;
const BODY_MAX = 16 * 1024;
const TITLE_MAX = 64;
const COMMAND_MAX = 4096;
const CREATES_PER_MINUTE = 10;
const RUNS_PER_MINUTE = 30;
const RUN_CONCURRENCY = 4;
const RUN_DEFAULT_SEC = 60;
const RUN_MAX_SEC = 120;
const RUN_OUTPUT_BYTES = 64 * 1024;
const SEND_KEYS_CHUNK = 1024;
const TMUX_TIMEOUT_MS = 10_000;
const SID = /^t-[0-9a-f]{8}$/;

/** Env names a shell may inherit from the garrison. Everything else is dropped. */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TZ", "XDG_RUNTIME_DIR"] as const;

/** Headers a reverse proxy or tunnel adds (same set the control API trusts as "proxied"). */
const PROXY_HEADERS = [
  "cf-connecting-ip", "cf-ray", "cf-warp-tag-id", "cf-ipcountry",
  "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded",
] as const;

const TMUX_CONF = [
  "# written by Ares (phoneTerminal.ts); regenerated at every start",
  "set -g status off",
  "set -g prefix None",
  "set -g prefix2 None",
  "set -g remain-on-exit on",
  "set -g history-limit 20000",
  "set -g default-terminal xterm-256color",
  "set -g escape-time 0",
  "set -g mouse off",
  "set -g set-titles off",
  "set -g destroy-unattached off",
  "unbind-key -a",
  "",
].join("\n");

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * Bytes of `buf` that end on a UTF-8 character boundary. A multi-byte
 * character split across two reads is held back until it is whole, so no frame
 * ever carries half a character (and `seq` always lands between characters).
 */
export function utf8CompleteLength(buf: Buffer): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && ((buf[i] as number) & 0xc0) === 0x80) { i--; back++; }
  if (i < 0) return buf.length;
  const lead = buf[i] as number;
  if (lead < 0xc0) return buf.length; // ASCII, or a stray continuation run: nothing to wait for
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return buf.length - i >= need ? buf.length : i;
}

/** The environment a terminal (or one-shot run) gets: an allowlist, never the garrison's own. */
export function buildTerminalEnv(
  base: NodeJS.ProcessEnv = process.env,
  extraPass: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...ENV_ALLOW, ...extraPass]) {
    const v = base[name];
    if (typeof v === "string" && v && !/[\0]/.test(v)) env[name] = v;
  }
  env["HOME"] ??= os.homedir();
  env["USER"] ??= (() => { try { return os.userInfo().username; } catch { return "user"; } })();
  env["LOGNAME"] ??= env["USER"];
  env["PATH"] ??= "/usr/local/bin:/usr/bin:/bin";
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["LANG"] = "en_US.UTF-8";
  return env;
}

const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** Remove secret-shaped strings (and any literal `secrets`) from text that leaves the box. */
export function scrubText(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  for (const re of SECRET_SHAPES) out = out.replace(re, "[redacted]");
  return out;
}

function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time token comparison (digests first, so length is not leaked). */
export function tokenEquals(presented: string, expected: string | undefined): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/** loopback = direct local; tunnel = cloudflared (loopback socket + proxy headers); lan = anything else. */
export function remoteClass(req: IncomingMessage): { cls: "loopback" | "tunnel" | "lan"; plainHttp: boolean } {
  const remote = req.socket.remoteAddress ?? "";
  const onThisMachine = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  if (!onThisMachine) return { cls: "lan", plainHttp: true };
  if (!proxied) return { cls: "loopback", plainHttp: false };
  const proto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
  return { cls: "tunnel", plainHttp: proto === "http" };
}

/** A ring of recent output addressed by absolute byte offset ("seq"). */
export class OutputRing {
  head: number;
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number, base = 0) { this.head = base; }
  get start(): number { return this.head - this.size; }
  push(b: Buffer): void {
    if (b.length === 0) return;
    this.chunks.push(b);
    this.size += b.length;
    this.head += b.length;
    while (this.size > this.cap && this.chunks.length > 1) this.size -= (this.chunks.shift() as Buffer).length;
  }
  /** Bytes in [from, to); null when `from` is no longer (or not yet) held. */
  slice(from: number, to = this.head): Buffer | null {
    if (from < this.start || from > this.head) return null;
    const end = Math.min(to, this.head);
    if (end <= from) return Buffer.alloc(0);
    const out: Buffer[] = [];
    let offset = this.start;
    for (const c of this.chunks) {
      const cEnd = offset + c.length;
      if (cEnd > from && offset < end) out.push(c.subarray(Math.max(from - offset, 0), Math.min(end - offset, c.length)));
      offset = cEnd;
      if (offset >= end) break;
    }
    return Buffer.concat(out);
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TerminalApiOptions {
  /** The garrison home (~/.ares): audit, FIFOs, transcripts. */
  home: string;
  /** The owner's gateway token. Anything else is refused. */
  ownerToken: () => string | undefined;
  log?: (line: string) => void;
  /** tmux socket name (-L). Env ARES_TERMINAL_SOCKET; tests use their own. */
  socket?: string;
  tmux?: string;
  /** Base environment the allowlist is built from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  max?: number;
  idleMs?: number;
  deadReapMs?: number;
  pollMs?: number;
  flushMs?: number;
  highWaterBytes?: number;
  maxLagBytes?: number;
  ringBytes?: number;
  createsPerMinute?: number;
  /** "auto" (default): systemd when running under systemd with passwordless sudo. */
  server?: "direct" | "systemd" | "auto";
}

interface Client {
  ws: WebSocket;
  sess: Sess;
  cursor: number;
  state: "syncing" | "live";
  timer: ReturnType<typeof setTimeout> | undefined;
  openedAt: number;
  bytesIn: number;
  bytesOut: number;
  lastSeen: number;
  remote: string;
  closed: boolean;
  heldSince: number;
  lastSnapshotAt: number;
}

interface Sess {
  id: string;
  title: string;
  createdAt: string;
  lastActiveMs: number;
  cols: number;
  rows: number;
  cwd: string;
  alive: boolean;
  exitCode: number | null;
  pid: number;
  ring: OutputRing;
  fifo: string;
  reader: fs.ReadStream | undefined;
  clients: Set<Client>;
  bytesIn: number;
  bytesOut: number;
  detachedAtMs: number;
  deadAtMs: number;
  unregister: (() => void) | undefined;
  inputChain: Promise<void>;
  logFd: number | undefined;
  closing: boolean;
  /** false while the tmux session is still being created (the poll must not judge it yet). */
  ready: boolean;
}

export interface TerminalApi {
  /** Owner-bearer HTTP routes under /gateway/terminal. false = not mine. */
  http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** A WebSocket upgraded at /gateway/terminal/<id>. */
  ws(ws: WebSocket, req: IncomingMessage): void;
  /** Kill every terminal (tree and tmux session). Returns how many were live. */
  killAll(reason: string): Promise<number>;
  /** Close every attached socket; the terminals keep running. */
  detachAll(code: number, reason: string): void;
  /** Stop timers and readers (tests, shutdown). Does not kill terminals. */
  dispose(): void;
  /** Test/inspection hook. */
  snapshotSessions(): Array<{ id: string; clients: number; alive: boolean }>;
}

// ─── The service ────────────────────────────────────────────────────────────

export function createTerminalApi(opts: TerminalApiOptions): TerminalApi {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const baseEnv = opts.env ?? process.env;
  const dirs = {
    run: path.join(opts.home, "terminal", "run"),
    logs: path.join(opts.home, "terminal", "logs"),
    conf: path.join(opts.home, "terminal", "tmux.conf"),
  };
  const sessions = new Map<string, Sess>();
  const createdAt: number[] = [];
  const runStarts: number[] = [];
  let runsLive = 0;
  let tick: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let adopted: Promise<void> | undefined;
  let serverReady: Promise<void> | undefined;
  let tmuxChecked: Promise<string | null> | undefined;
  let titleCounter = 0;
  let disposed = false;

  // Knobs are read at call time so the owner's env (and tests) can change them.
  const cfg = {
    enabled: () => (baseEnv["ARES_TERMINAL"] ?? process.env["ARES_TERMINAL"] ?? "1").trim() !== "0",
    max: () => opts.max ?? clampInt(Number(process.env["ARES_TERMINAL_MAX"]), 1, 32, DEFAULT_MAX),
    idleMs: () => opts.idleMs ?? Math.round(clampNum(Number(process.env["ARES_TERMINAL_IDLE_HOURS"]), 0.001, 24 * 30, 12) * 3_600_000),
    socket: () => opts.socket ?? (/^[A-Za-z0-9_.-]{1,48}$/.test(process.env["ARES_TERMINAL_SOCKET"] ?? "") ? (process.env["ARES_TERMINAL_SOCKET"] as string) : "ares-term"),
    tmux: () => opts.tmux ?? "tmux",
    shell: () => (process.env["ARES_TERMINAL_SHELL"] ?? "").trim() || baseEnv["SHELL"] || "/bin/bash",
    transcript: () => (process.env["ARES_TERMINAL_LOG"] ?? "") === "1",
    allowLan: () => (process.env["ARES_TERMINAL_ALLOW_LAN"] ?? "") === "1",
    extraEnv: () => (process.env["ARES_TERMINAL_ENV_PASS"] ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
    pollMs: () => opts.pollMs ?? 500,
    flushMs: () => opts.flushMs ?? FLUSH_MS,
    high: () => opts.highWaterBytes ?? HIGH_WATER_BYTES,
    lag: () => opts.maxLagBytes ?? MAX_LAG_BYTES,
    ring: () => opts.ringBytes ?? RING_BYTES,
    deadReap: () => opts.deadReapMs ?? DEAD_REAP_MS,
    creates: () => opts.createsPerMinute ?? CREATES_PER_MINUTE,
    server: () => opts.server ?? ((process.env["ARES_TERMINAL_SERVER"] ?? "auto") as "direct" | "systemd" | "auto"),
  };

  const audit = (action: string, target: string | undefined, params: Record<string, unknown>, result = "ok"): void => {
    void appendAudit({ actor: "owner", action: `terminal.${action}`, ...(target ? { target } : {}), params, result }, opts.home);
  };

  // ── tmux plumbing ──

  const termEnv = (): Record<string, string> => buildTerminalEnv(baseEnv, cfg.extraEnv());

  function tmux(args: string[], timeoutMs = TMUX_TIMEOUT_MS): Promise<{ code: number; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        cfg.tmux(),
        ["-L", cfg.socket(), ...args],
        { env: termEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
          resolve({ code, out: stdout ?? "", err: stderr ?? (error ? error.message : "") });
        },
      );
      child.on("error", () => { /* surfaced through the callback */ });
    });
  }

  async function tmuxAvailable(): Promise<string | null> {
    tmuxChecked ??= new Promise<string | null>((resolve) => {
      execFile(cfg.tmux(), ["-V"], { timeout: 5_000 }, (error) => {
        resolve(error ? "tmux is not installed on this machine" : null);
      });
    });
    return tmuxChecked;
  }

  const serverUp = async (): Promise<boolean> => {
    const r = await tmux(["list-sessions"]);
    return r.code === 0 || /no sessions/i.test(r.err);
  };

  async function sudoOk(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("sudo", ["-n", "true"], { timeout: 5_000 }, (error) => resolve(!error));
    });
  }

  /** Make sure a tmux server is running; in systemd mode, as its own transient unit. */
  async function ensureServer(): Promise<void> {
    serverReady ??= (async () => {
      await fs.promises.mkdir(dirs.run, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(dirs.conf, TMUX_CONF, { mode: 0o600 });
      if (await serverUp()) return;
      const mode = cfg.server();
      const underSystemd = !!process.env["INVOCATION_ID"];
      if (mode === "systemd" || (mode === "auto" && underSystemd && process.platform === "linux" && (await sudoOk()))) {
        const user = (() => { try { return os.userInfo().username; } catch { return ""; } })();
        const unit = `ares-term-${cfg.socket()}`.replace(/[^A-Za-z0-9_.-]/g, "-");
        const started = await new Promise<boolean>((resolve) => {
          execFile(
            "sudo",
            ["-n", "systemd-run", "--quiet", "--collect", `--unit=${unit}`, `--uid=${user}`, `--working-directory=${baseEnv["HOME"] ?? os.homedir()}`,
              `--setenv=HOME=${baseEnv["HOME"] ?? os.homedir()}`, "--", cfg.tmux(), "-D", "-L", cfg.socket(), "-f", dirs.conf],
            { timeout: 15_000 },
            (error) => resolve(!error),
          );
        });
        if (started) {
          for (let i = 0; i < 40; i++) {
            if (await serverUp()) { log(`terminal: tmux server runs as ${unit}.service (survives garrison restarts)`); return; }
            await sleep(100);
          }
        }
        log("terminal: could not start the tmux server as a transient unit; falling back to the garrison's own cgroup");
      }
      // direct mode: the first new-session starts the server (with the conf, via -f below)
    })().catch((err) => { serverReady = undefined; throw err; });
    return serverReady;
  }

  const tmuxWithConf = (args: string[]): Promise<{ code: number; out: string; err: string }> => tmux(["-f", dirs.conf, ...args]);

  // ── sessions ──

  function newSess(init: { id: string; title: string; createdAt: string; cols: number; rows: number; cwd: string; pid: number }): Sess {
    const s: Sess = {
      ...init,
      lastActiveMs: now(),
      alive: true,
      exitCode: null,
      ring: new OutputRing(cfg.ring(), randomInt(2 ** 30, 2 ** 40)),
      fifo: path.join(dirs.run, `${init.id}.fifo`),
      reader: undefined,
      clients: new Set(),
      bytesIn: 0,
      bytesOut: 0,
      detachedAtMs: now(),
      deadAtMs: 0,
      unregister: undefined,
      inputChain: Promise.resolve(),
      logFd: undefined,
      closing: false,
      ready: false,
    };
    sessions.set(s.id, s);
    s.unregister = registerStoppable({
      kind: "job",
      id: `terminal:${s.id}`,
      label: `Terminal ${s.title}`,
      stop: async (reason) => {
        if (!sessions.has(s.id)) return false;
        await destroy(s, reason, "kill");
        return true;
      },
    });
    startTick();
    return s;
  }

  async function openPipe(s: Sess): Promise<void> {
    await fs.promises.unlink(s.fifo).catch(() => {});
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", ["-m", "600", s.fifo], (e) => (e ? reject(e) : resolve()));
    });
    if (cfg.transcript()) {
      await fs.promises.mkdir(dirs.logs, { recursive: true, mode: 0o700 });
      s.logFd = fs.openSync(path.join(dirs.logs, `${s.id}.log`), "a", 0o600);
    }
    // r+ on a FIFO opens it read-write: it never blocks waiting for a writer
    // and never sees EOF when the pane's `cat` is replaced.
    const reader = fs.createReadStream(s.fifo, { flags: "r+", highWaterMark: 64 * 1024 });
    s.reader = reader;
    reader.on("data", (chunk) => {
      const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      s.ring.push(b);
      s.bytesOut += b.length;
      s.lastActiveMs = now();
      if (s.logFd !== undefined) { try { fs.writeSync(s.logFd, b); } catch { /* disk full: not fatal */ } }
      for (const c of s.clients) scheduleFlush(c);
    });
    reader.on("error", () => { /* torn down with the session */ });
    const quoted = `'${s.fifo.replace(/'/g, `'\\''`)}'`;
    const r = await tmux(["pipe-pane", "-O", "-t", `${s.id}:`, `cat >> ${quoted}`]);
    if (r.code !== 0) throw new Error(`pipe-pane failed: ${r.err.trim().slice(0, 200)}`);
  }

  async function adopt(): Promise<void> {
    adopted ??= (async () => {
      if (await tmuxAvailable()) return;
      if (!(await serverUp())) return;
      await fs.promises.mkdir(dirs.run, { recursive: true, mode: 0o700 });
      const sep = "~|~"; // printable: tmux rewrites control characters in format output
      const r = await tmux(["list-panes", "-a", "-F", ["#{session_name}", "#{pane_pid}", "#{window_width}", "#{window_height}", "#{pane_current_path}", "#{pane_dead}", "#{pane_dead_status}", "#{@ares_created}", "#{@ares_title}"].join(sep)]);
      if (r.code !== 0) return;
      for (const line of r.out.split("\n")) {
        const f = line.split(sep);
        const id = f[0] ?? "";
        if (!SID.test(id) || sessions.has(id)) continue;
        const s = newSess({
          id, pid: Number(f[1]) || 0, cols: Number(f[2]) || 80, rows: Number(f[3]) || 24, cwd: f[4] || "",
          title: f.slice(8).join(sep) || `Terminal ${++titleCounter}`, createdAt: f[7] || new Date(now()).toISOString(),
        });
        s.ready = true;
        if (f[5] === "1") { s.alive = false; s.exitCode = Number(f[6]) || 0; s.deadAtMs = now(); }
        else { await openPipe(s).catch((err) => log(`terminal: could not re-attach output of ${id}: ${(err as Error).message}`)); }
        log(`terminal: adopted ${id}`);
      }
    })().catch((err) => { adopted = undefined; log(`terminal: adopt failed: ${(err as Error).message}`); });
    return adopted;
  }

  function view(s: Sess) {
    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      lastActiveAt: new Date(s.lastActiveMs).toISOString(),
      cols: s.cols,
      rows: s.rows,
      alive: s.alive,
      attached: s.clients.size > 0,
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(!s.alive ? { exitCode: s.exitCode } : {}),
    };
  }

  /** Kill the shell's process tree, then the tmux session; close sockets; forget it. */
  async function destroy(s: Sess, reason: string, kind: "kill" | "idle" | "gone" | "reap"): Promise<void> {
    if (s.closing) return;
    s.closing = true;
    log(`terminal: ended ${s.id} (${kind}: ${reason})`);
    sessions.delete(s.id);
    s.unregister?.();
    for (const c of [...s.clients]) {
      sendJson(c.ws, { t: "exit", code: s.exitCode, reason });
      closeClient(c, 1000, "terminal ended");
    }
    if (kind !== "gone") {
      await killTree(s.pid);
      await tmux(["kill-session", "-t", `${s.id}`]);
    }
    s.reader?.destroy();
    if (s.logFd !== undefined) { try { fs.closeSync(s.logFd); } catch { /* closed */ } }
    await fs.promises.unlink(s.fifo).catch(() => {});
    audit(kind === "idle" ? "idle" : "kill", `terminal:${s.id}`, { reason, bytesIn: s.bytesIn, bytesOut: s.bytesOut, ageSec: Math.round((now() - Date.parse(s.createdAt)) / 1000) });
    if (sessions.size === 0) stopTick();
  }

  function startTick(): void {
    if (tick || disposed) return;
    tick = setInterval(() => { void poll(); }, cfg.pollMs());
    tick.unref?.();
  }
  function stopTick(): void {
    if (tick) clearInterval(tick);
    tick = undefined;
  }

  async function poll(): Promise<void> {
    if (ticking || sessions.size === 0) return;
    ticking = true;
    try {
      if (ownerPause.paused) api.detachAll(4423, "paused by owner");
      const sep = "~|~"; // printable: tmux rewrites control characters in format output
      const r = await tmux(["list-panes", "-a", "-F", ["#{session_name}", "#{pane_dead}", "#{pane_dead_status}", "#{pane_dead_signal}", "#{pane_pid}", "#{pane_current_path}", "#{window_width}", "#{window_height}"].join(sep)]);
      const seen = new Set<string>();
      if (r.code === 0) {
        for (const line of r.out.split("\n")) {
          const f = line.split(sep);
          const s = sessions.get(f[0] ?? "");
          if (!s || s.closing || !s.ready) continue;
          seen.add(s.id);
          s.pid = Number(f[4]) || s.pid;
          if (f[5]) s.cwd = f[5];
          s.cols = Number(f[6]) || s.cols;
          s.rows = Number(f[7]) || s.rows;
          if (f[1] === "1" && s.alive) {
            s.alive = false;
            const status = Number(f[2]);
            const signal = Number(f[3]);
            s.exitCode = Number.isFinite(status) && f[2] !== "" ? status : signal > 0 ? 128 + signal : 0;
            s.deadAtMs = now();
            // Let the last output through the ring before the exit frame.
            setTimeout(() => {
              for (const c of s.clients) {
                void flush(c).then(() => { sendJson(c.ws, { t: "exit", code: s.exitCode }); closeClient(c, 1000, "exited"); });
              }
            }, 80);
          }
        }
      }
      const noServer = r.code !== 0 && !/no sessions/i.test(r.err);
      for (const s of [...sessions.values()]) {
        if (s.closing || !s.ready) continue;
        if (noServer || (!seen.has(s.id) && r.code === 0)) { await destroy(s, "terminal ended outside Ares", "gone"); continue; }
        if (s.clients.size === 0) {
          if (s.alive && now() - s.detachedAtMs > cfg.idleMs()) await destroy(s, "idle timeout", "idle");
          else if (!s.alive && now() - s.deadAtMs > cfg.deadReap()) await destroy(s, "exited terminal reaped", "reap");
        }
      }
    } finally {
      ticking = false;
    }
  }

  // ── input / resize / snapshot ──

  function writeInput(s: Sess, data: Buffer): void {
    s.bytesIn += data.length;
    s.lastActiveMs = now();
    s.inputChain = s.inputChain.then(async () => {
      for (let i = 0; i < data.length; i += SEND_KEYS_CHUNK) {
        const hex = [...data.subarray(i, i + SEND_KEYS_CHUNK)].map((b) => b.toString(16));
        await tmux(["send-keys", "-t", `${s.id}:`, "-H", ...hex]);
      }
    }).catch(() => {});
  }

  async function resizeSess(s: Sess, cols: number, rows: number): Promise<void> {
    if (s.cols === cols && s.rows === rows) return;
    s.cols = cols;
    s.rows = rows;
    await tmux(["resize-window", "-t", `${s.id}:`, "-x", String(cols), "-y", String(rows)]);
  }

  /** Scrollback + visible screen + cursor, as bytes an emulator can replay. Bounded. */
  async function snapshot(s: Sess): Promise<string> {
    const sep = "~|~"; // printable: tmux rewrites control characters in format output
    const info = await tmux(["display-message", "-p", "-t", `${s.id}:`, ["#{alternate_on}", "#{cursor_x}", "#{cursor_y}", "#{history_size}", "#{window_height}"].join(sep)]);
    const f = info.out.trim().split(sep);
    const alt = f[0] === "1";
    const cx = Number(f[1]) || 0;
    const cy = Number(f[2]) || 0;
    const hist = Number(f[3]) || 0;
    const rows = Number(f[4]) || s.rows;
    const reset = "\u001b[0m\u001b[?1049l\u001b[2J\u001b[3J\u001b[H";
    const nl = (t: string) => t.replace(/\r?\n/g, "\r\n");
    let history = "";
    if (!alt && hist > 0) {
      const h = await tmux(["capture-pane", "-p", "-e", "-J", "-t", `${s.id}:`, "-S", `-${Math.min(hist, 5000)}`, "-E", "-1"]);
      history = h.out;
      while (Buffer.byteLength(history) > SNAPSHOT_MAX_BYTES - 32 * 1024) history = history.slice(history.indexOf("\n") + 1 || history.length);
    }
    const screenArgs = alt ? ["capture-pane", "-p", "-e", "-a", "-q", "-t", `${s.id}:`] : ["capture-pane", "-p", "-e", "-t", `${s.id}:`];
    const screen = (await tmux(screenArgs)).out.replace(/\n$/, "").split("\n");
    let out = reset;
    if (history) out += nl(history.replace(/\n?$/, "\n")) + "\r\n".repeat(rows);
    if (alt) out += "\u001b[?1049h\u001b[H";
    out += screen.slice(0, rows).map((line, i) => `\u001b[${i + 1};1H${line}\u001b[0m\u001b[K`).join("");
    out += `\u001b[${cy + 1};${cx + 1}H`;
    if (Buffer.byteLength(out) > SNAPSHOT_MAX_BYTES) out = reset + screen.slice(0, rows).map((line, i) => `\u001b[${i + 1};1H${line}\u001b[0m\u001b[K`).join("") + `\u001b[${cy + 1};${cx + 1}H`;
    return out;
  }

  // ── client streaming ──

  function sendJson(ws: WebSocket, obj: unknown): void {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch { /* peer gone */ }
  }

  function closeClient(c: Client, code: number, reason: string): void {
    if (c.closed) return;
    c.closed = true;
    if (c.timer) clearTimeout(c.timer);
    try { c.ws.close(code, reason.slice(0, 100)); } catch { /* already closed */ }
    onClientGone(c);
  }

  function onClientGone(c: Client): void {
    const s = c.sess;
    if (!s.clients.delete(c)) return;
    if (c.timer) clearTimeout(c.timer);
    if (s.clients.size === 0) s.detachedAtMs = now();
    audit("detach", `terminal:${s.id}`, { remote: c.remote, durationSec: Math.round((now() - c.openedAt) / 1000), bytesIn: c.bytesIn, bytesOut: c.bytesOut });
  }

  function scheduleFlush(c: Client): void {
    if (c.timer || c.closed || c.state !== "live") return;
    c.timer = setTimeout(() => { c.timer = undefined; void flush(c); }, cfg.flushMs());
    c.timer.unref?.();
  }

  async function flush(c: Client): Promise<void> {
    if (c.closed || c.state !== "live") return;
    const ring = c.sess.ring;
    if (c.cursor < ring.start || ring.head - c.cursor > cfg.lag()) { void resync(c); return; }
    let budget = FLUSH_BUDGET_BYTES;
    while (c.cursor < ring.head && budget > 0) {
      if (c.ws.bufferedAmount > cfg.high()) { scheduleFlush(c); return; }
      const raw = ring.slice(c.cursor, Math.min(ring.head, c.cursor + FRAME_BYTES));
      if (!raw || raw.length === 0) break;
      let n = utf8CompleteLength(raw);
      if (n === 0) {
        // Half a character at the very end of the stream: wait briefly for the rest.
        c.heldSince ||= now();
        if (now() - c.heldSince < 500) { scheduleFlush(c); return; }
        n = raw.length;
      }
      c.heldSince = 0;
      const frame = raw.subarray(0, n);
      c.cursor += n;
      budget -= n;
      c.bytesOut += n;
      sendJson(c.ws, { t: "out", d: frame.toString("utf8"), seq: c.cursor });
    }
    if (c.cursor < ring.head) scheduleFlush(c);
  }

  /** The phone fell behind: drop what it has not been sent and give it the screen as it is now. */
  async function resync(c: Client): Promise<void> {
    if (c.state === "syncing" || c.closed) return;
    c.state = "syncing";
    if (c.timer) { clearTimeout(c.timer); c.timer = undefined; }
    try {
      const wait = cfg.flushMs() * 2;
      const rateLimit = Math.max(0, c.lastSnapshotAt + 1000 - now());
      if (rateLimit) await sleep(rateLimit);
      for (let waited = 0; !c.closed && c.ws.bufferedAmount > cfg.high() / 4; waited += wait) {
        if (waited > 30_000) { closeClient(c, 1013, "client too slow"); return; }
        await sleep(wait);
      }
      if (c.closed) return;
      const d = await snapshot(c.sess);
      c.cursor = c.sess.ring.head;
      c.lastSnapshotAt = now();
      sendJson(c.ws, { t: "replay", d, seq: c.cursor, reset: true });
    } finally {
      c.state = "live";
      scheduleFlush(c);
    }
  }

  async function catchUp(c: Client, since: number | undefined): Promise<void> {
    const ring = c.sess.ring;
    if (since !== undefined && Number.isFinite(since) && since <= ring.head && since >= ring.start && ring.head - since <= SNAPSHOT_MAX_BYTES) {
      let raw = ring.slice(since) ?? Buffer.alloc(0);
      const n = utf8CompleteLength(raw);
      raw = raw.subarray(0, n);
      c.cursor = since + n;
      sendJson(c.ws, { t: "replay", d: raw.toString("utf8"), seq: c.cursor, reset: false });
    } else {
      const d = await snapshot(c.sess);
      c.cursor = ring.head;
      c.lastSnapshotAt = now();
      sendJson(c.ws, { t: "replay", d, seq: c.cursor, reset: true });
    }
  }

  // ── guards shared by HTTP and WebSocket ──

  type Verdict = { ok: true; remote: string } | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

  async function gate(req: IncomingMessage, opts2: { needTmux: boolean }): Promise<Verdict> {
    const { cls, plainHttp } = remoteClass(req);
    if (cls === "lan" && !cfg.allowLan()) return { ok: false, status: 403, error: "terminal requires the tunnel or TLS" };
    if (cls === "tunnel" && plainHttp && !cfg.allowLan()) return { ok: false, status: 403, error: "terminal requires the tunnel or TLS" };
    if (!cfg.enabled()) return { ok: false, status: 503, error: "terminal is disabled on this machine", extra: { enabled: false } };
    if (ownerPause.paused) return { ok: false, status: 423, error: "Ares is paused by the owner", extra: { paused: true } };
    if (opts2.needTmux) {
      const missing = await tmuxAvailable();
      if (missing) return { ok: false, status: 503, error: missing, extra: { enabled: false, reason: missing } };
    }
    return { ok: true, remote: cls };
  }

  function jsonOut(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > BODY_MAX) throw new Error("body too large");
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return {};
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }

  // ── HTTP ──

  async function handleHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    if (p !== "/gateway/terminal" && !p.startsWith("/gateway/terminal/")) return false;
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!presented) { jsonOut(res, 401, { error: "unauthorized" }); return true; }
    const { cls } = remoteClass(req);
    if (!tokenEquals(presented, opts.ownerToken())) {
      audit("denied", undefined, { reason: "not the owner token", remote: cls, route: `${req.method} ${p}`.slice(0, 120) }, "denied");
      jsonOut(res, 403, { error: "owner only" });
      return true;
    }
    const verdict = await gate(req, { needTmux: false });
    if (!verdict.ok) {
      if (verdict.status === 503 && req.method === "GET" && p === "/gateway/terminal") {
        jsonOut(res, 200, { enabled: false, max: cfg.max(), sessions: [] });
        return true;
      }
      if (verdict.status === 403) audit("denied", undefined, { reason: verdict.error, remote: cls }, "denied");
      jsonOut(res, verdict.status, { error: verdict.error, ...(verdict.extra ?? {}) });
      return true;
    }
    try {
      if (req.method === "GET" && p === "/gateway/terminal") {
        const missing = await tmuxAvailable();
        if (missing) { jsonOut(res, 200, { enabled: false, max: cfg.max(), reason: missing, sessions: [] }); return true; }
        await adopt();
        jsonOut(res, 200, { enabled: true, max: cfg.max(), sessions: [...sessions.values()].map(view) });
        return true;
      }
      if (req.method === "POST" && p === "/gateway/terminal/run") { await handleRun(req, res, verdict.remote); return true; }
      if (req.method === "POST" && p === "/gateway/terminal/sessions") { await handleCreate(req, res, verdict.remote); return true; }
      const m = /^\/gateway\/terminal\/sessions\/([^/]+)(\/rename)?$/.exec(p);
      if (m) {
        const id = m[1] as string;
        await adopt();
        const s = SID.test(id) ? sessions.get(id) : undefined;
        if (!s) { jsonOut(res, 404, { error: "no such terminal" }); return true; }
        if (m[2] && req.method === "POST") {
          const title = cleanTitle((await readBody(req))["title"]);
          if (!title) { jsonOut(res, 400, { error: "title required" }); return true; }
          s.title = title;
          await tmux(["set-option", "-t", `${s.id}:`, "@ares_title", title]);
          jsonOut(res, 200, { ok: true, title });
          return true;
        }
        if (!m[2] && req.method === "DELETE") {
          await destroy(s, "killed by owner", "kill");
          jsonOut(res, 200, { ok: true });
          return true;
        }
      }
      jsonOut(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonOut(res, /too large|JSON/i.test(message) ? 400 : 500, { error: message.slice(0, 300) });
    }
    return true;
  }

  async function handleCreate(req: IncomingMessage, res: ServerResponse, remote: string): Promise<void> {
    const body = await readBody(req);
    const cols = clampInt(Number(body["cols"] ?? 80), 20, 500, 80);
    const rows = clampInt(Number(body["rows"] ?? 24), 5, 200, 24);
    let command = "";
    if (body["command"] !== undefined) {
      if (typeof body["command"] !== "string" || body["command"].length > COMMAND_MAX || body["command"].includes("\0")) return jsonOut(res, 400, { error: "bad command" });
      command = body["command"];
    }
    const home = baseEnv["HOME"] ?? os.homedir();
    let cwd = home;
    if (body["cwd"] !== undefined && body["cwd"] !== "") {
      const raw = body["cwd"];
      if (typeof raw !== "string" || raw.length > 1024 || !path.isAbsolute(raw)) return jsonOut(res, 400, { error: "cwd must be an absolute path" });
      const stat = await fs.promises.stat(raw).catch(() => undefined);
      if (!stat?.isDirectory()) return jsonOut(res, 400, { error: "cwd is not a directory" });
      cwd = raw;
    }
    await adopt();
    if (sessions.size >= cfg.max()) return jsonOut(res, 409, { error: `at most ${cfg.max()} terminals`, max: cfg.max() });
    const t = now();
    while (createdAt.length && t - (createdAt[0] as number) > 60_000) createdAt.shift();
    if (createdAt.length >= cfg.creates()) return jsonOut(res, 429, { error: "creating terminals too fast", retryAfterSec: Math.max(1, Math.ceil((60_000 - (t - (createdAt[0] as number))) / 1000)) });
    createdAt.push(t);

    const shell = cfg.shell();
    if (!fs.existsSync(shell)) return jsonOut(res, 503, { error: `shell not found: ${shell}` });
    await ensureServer();
    const id = `t-${randomBytes(4).toString("hex")}`;
    const title = cleanTitle(body["title"]) || `Terminal ${++titleCounter}`;
    const created = new Date(now()).toISOString();
    const env = Object.entries(termEnv()).map(([k, v]) => `${k}=${v}`);
    const argv = ["/usr/bin/env", "-i", ...env, shell, "-l", ...(command ? ["-c", command] : [])];
    const s = newSess({ id, title, createdAt: created, cols, rows, cwd, pid: 0 });
    try {
      await fs.promises.mkdir(dirs.run, { recursive: true, mode: 0o700 });
      await fs.promises.unlink(s.fifo).catch(() => {});
      await new Promise<void>((resolve, reject) => execFile("mkfifo", ["-m", "600", s.fifo], (e) => (e ? reject(e) : resolve())));
      const r = await tmuxWithConf(["new-session", "-d", "-s", id, "-x", String(cols), "-y", String(rows), "-c", cwd, "--", ...argv]);
      if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.err.trim().slice(0, 200)}`);
      await tmux(["set-option", "-t", `${id}:`, "@ares_title", title]);
      await tmux(["set-option", "-t", `${id}:`, "@ares_created", created]);
      await openPipe(s);
      const pane = await tmux(["display-message", "-p", "-t", `${id}:`, "#{pane_pid}"]);
      s.pid = Number(pane.out.trim()) || 0;
      s.ready = true;
    } catch (err) {
      await destroy(s, "create failed", "kill").catch(() => {});
      return jsonOut(res, 500, { error: (err as Error).message.slice(0, 300) });
    }
    audit("create", `terminal:${id}`, { remote, cols, rows, command: !!command });
    log(`terminal: created ${id}`);
    jsonOut(res, 200, { id });
  }

  async function handleRun(req: IncomingMessage, res: ServerResponse, remote: string): Promise<void> {
    const body = await readBody(req);
    const command = body["command"];
    if (typeof command !== "string" || !command.trim() || command.length > COMMAND_MAX || command.includes("\0")) return jsonOut(res, 400, { error: "command required (max 4096 chars)" });
    const timeoutSec = clampNum(Number(body["timeoutSec"] ?? RUN_DEFAULT_SEC), 1, RUN_MAX_SEC, RUN_DEFAULT_SEC);
    let cwd = baseEnv["HOME"] ?? os.homedir();
    if (body["cwd"] !== undefined && body["cwd"] !== "") {
      const raw = body["cwd"];
      if (typeof raw !== "string" || raw.length > 1024 || !path.isAbsolute(raw)) return jsonOut(res, 400, { error: "cwd must be an absolute path" });
      const stat = await fs.promises.stat(raw).catch(() => undefined);
      if (!stat?.isDirectory()) return jsonOut(res, 400, { error: "cwd is not a directory" });
      cwd = raw;
    }
    const t = now();
    while (runStarts.length && t - (runStarts[0] as number) > 60_000) runStarts.shift();
    if (runStarts.length >= RUNS_PER_MINUTE) return jsonOut(res, 429, { error: "too many commands", retryAfterSec: 5 });
    if (runsLive >= RUN_CONCURRENCY) return jsonOut(res, 429, { error: `at most ${RUN_CONCURRENCY} commands at once`, retryAfterSec: 2 });
    runStarts.push(t);
    const shell = cfg.shell();
    if (!fs.existsSync(shell)) return jsonOut(res, 503, { error: `shell not found: ${shell}` });
    runsLive++;
    const started = now();
    const secrets = [opts.ownerToken() ?? ""];
    const result = await new Promise<{ exitCode: number; signal?: string; timedOut: boolean; stdout: string; stderr: string; truncated: boolean }>((resolve) => {
      const child = spawn(shell, ["-lc", command], { cwd, env: termEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outN = 0;
      let errN = 0;
      let truncated = false;
      let timedOut = false;
      const take = (arr: Buffer[], n: number, b: Buffer): number => {
        if (n >= RUN_OUTPUT_BYTES) { truncated = true; return n; }
        const room = RUN_OUTPUT_BYTES - n;
        if (b.length > room) truncated = true;
        arr.push(b.subarray(0, room));
        return n + Math.min(room, b.length);
      };
      child.stdout.on("data", (b: Buffer) => { outN = take(out, outN, b); });
      child.stderr.on("data", (b: Buffer) => { errN = take(err, errN, b); });
      const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, "SIGKILL"); }, timeoutSec * 1000);
      let done = false;
      const finish = (exitCode: number, signal?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // A command that backgrounds a daemon keeps the pipes open; do not wait for it.
        child.stdout.destroy();
        child.stderr.destroy();
        const text = (arr: Buffer[]) => scrubText(Buffer.concat(arr).toString("utf8"), secrets);
        resolve({ exitCode, ...(signal ? { signal } : {}), timedOut, stdout: text(out), stderr: text(err), truncated });
      };
      child.on("error", (e) => { err.push(Buffer.from(String(e.message))); finish(127); });
      child.on("exit", (code, signal) => { setTimeout(() => finish(code ?? (signal ? 128 : 1), signal ?? undefined), 200); });
      child.on("close", (code, signal) => finish(code ?? (signal ? 128 : 1), signal ?? undefined));
    }).finally(() => { runsLive--; });
    audit("run", undefined, { remote, command: scrubText(command, secrets).slice(0, 200), exitCode: result.exitCode, timedOut: result.timedOut, durationMs: now() - started }, result.exitCode === 0 ? "ok" : "error");
    jsonOut(res, 200, result);
  }

  // ── WebSocket ──

  function handleWs(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const id = url.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
    const cls = remoteClass(req).cls;
    let client: Client | undefined;
    let lastSeen = now();
    let authed = false;
    const fail = (code: number, message: string) => {
      sendJson(ws, { t: "error", message });
      try { ws.close(code, message.slice(0, 100)); } catch { /* gone */ }
    };

    ws.on("pong", () => { lastSeen = now(); });
    const hello = setTimeout(() => { if (!authed) fail(4401, "handshake timeout"); }, HELLO_TIMEOUT_MS);
    hello.unref?.();
    const keepalive = setInterval(() => {
      if (now() - lastSeen > WS_SILENCE_MS) { try { ws.terminate(); } catch { /* gone */ } return; }
      try { ws.ping(); } catch { /* gone */ }
    }, WS_PING_MS);
    keepalive.unref?.();
    ws.on("close", () => {
      clearTimeout(hello);
      clearInterval(keepalive);
      if (client) { client.closed = true; onClientGone(client); }
    });
    ws.on("error", () => { /* close follows */ });

    // Transport check first: a refused transport never even hears the hello.
    const early = remoteClass(req);
    if ((early.cls === "lan" || (early.cls === "tunnel" && early.plainHttp)) && !cfg.allowLan()) {
      audit("denied", undefined, { reason: "plain http", remote: cls, ws: true }, "denied");
      return fail(4403, "terminal requires the tunnel or TLS");
    }

    ws.on("message", (raw, isBinary) => {
      lastSeen = now();
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      const text = buf.toString("utf8");
      if (isBinary || text.length > WS_MESSAGE_MAX) { try { ws.close(1009, "frame too large"); } catch { /* gone */ } return; }
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      const kind = (msg["t"] ?? msg["type"]) as unknown;
      if (!authed) {
        if (kind !== "hello") return fail(4401, "handshake required: the first frame must be hello");
        authed = true;
        clearTimeout(hello);
        const token = typeof msg["token"] === "string" ? msg["token"] : "";
        if (!tokenEquals(token, opts.ownerToken())) {
          audit("denied", SID.test(id) ? `terminal:${id}` : undefined, { reason: token ? "not the owner token" : "no token", remote: cls, ws: true }, "denied");
          return fail(token ? 4403 : 4401, token ? "owner only" : "unauthorized");
        }
        void (async () => {
          const v = await gate(req, { needTmux: true });
          if (!v.ok) { audit("denied", undefined, { reason: v.error, remote: cls, ws: true }, "denied"); return fail(v.status === 423 ? 4423 : v.status === 503 ? 4503 : 4403, v.error); }
          await adopt();
          const s = SID.test(id) ? sessions.get(id) : undefined;
          if (!s) return fail(4404, "no such terminal");
          const c: Client = { ws, sess: s, cursor: s.ring.head, state: "syncing", timer: undefined, openedAt: now(), bytesIn: 0, bytesOut: 0, lastSeen: now(), remote: cls, closed: false, heldSince: 0, lastSnapshotAt: 0 };
          if (ws.readyState !== 1) return;
          client = c;
          s.clients.add(c);
          const cols = clampInt(Number(url.searchParams.get("cols")), 20, 500, 0);
          const rows = clampInt(Number(url.searchParams.get("rows")), 5, 200, 0);
          if (cols && rows && s.alive) await resizeSess(s, cols, rows);
          sendJson(ws, { t: "ready", id: s.id, cols: s.cols, rows: s.rows, alive: s.alive });
          const sinceRaw = url.searchParams.get("since");
          await catchUp(c, sinceRaw !== null && /^\d{1,16}$/.test(sinceRaw) ? Number(sinceRaw) : undefined);
          c.state = "live";
          audit("attach", `terminal:${s.id}`, { remote: cls, since: sinceRaw !== null });
          if (!s.alive) { sendJson(ws, { t: "exit", code: s.exitCode }); closeClient(c, 1000, "exited"); return; }
          scheduleFlush(c);
        })().catch((err) => fail(1011, `terminal error: ${(err as Error).message.slice(0, 120)}`));
        return;
      }
      const c = client;
      if (!c || c.closed) return;
      switch (kind) {
        case "in": {
          const d = msg["d"];
          if (typeof d !== "string" || d.length === 0 || d.length > IN_FRAME_MAX) return;
          if (ownerPause.paused) return;
          const bytes = Buffer.from(d, "utf8");
          c.bytesIn += bytes.length;
          writeInput(c.sess, bytes);
          return;
        }
        case "resize": {
          const cols = clampInt(Number(msg["cols"]), 20, 500, 0);
          const rows = clampInt(Number(msg["rows"]), 5, 200, 0);
          if (cols && rows && c.sess.alive) void resizeSess(c.sess, cols, rows);
          return;
        }
        case "ping":
          sendJson(ws, { t: "pong" });
          return;
        default:
          return;
      }
    });
  }

  // ── lifecycle ──

  const api: TerminalApi = {
    http: handleHttp,
    ws: handleWs,
    async killAll(reason) {
      const all = [...sessions.values()];
      await Promise.all(all.map((s) => destroy(s, reason, "kill")));
      return all.length;
    },
    detachAll(code, reason) {
      for (const s of sessions.values()) for (const c of [...s.clients]) closeClient(c, code, reason);
    },
    dispose() {
      disposed = true;
      stopTick();
      for (const s of sessions.values()) {
        s.reader?.destroy();
        s.unregister?.();
        for (const c of [...s.clients]) closeClient(c, 1001, "shutting down");
      }
    },
    snapshotSessions: () => [...sessions.values()].map((s) => ({ id: s.id, clients: s.clients.size, alive: s.alive })),
  };
  return api;
}

// ─── Process helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function clampNum(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* already gone */ }
}

interface ProcRow { pid: number; ppid: number; sid: number }

function readProcTable(): ProcRow[] {
  const rows: ProcRow[] = [];
  let names: string[];
  try { names = fs.readdirSync("/proc"); } catch { return rows; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(name), ppid: Number(rest[1]), sid: Number(rest[3]) });
    } catch { /* exited while we looked */ }
  }
  return rows;
}

/** Everything below `rootPid` by parentage, plus everything left in its session. */
export function processTree(rootPid: number, table: ProcRow[] = readProcTable()): number[] {
  if (!rootPid || rootPid <= 1) return [];
  const byParent = new Map<number, number[]>();
  for (const r of table) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r.pid]);
  const found = new Set<number>();
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.pop() as number;
    if (found.has(p)) continue;
    found.add(p);
    for (const k of byParent.get(p) ?? []) queue.push(k);
  }
  for (const r of table) if (r.sid === rootPid) found.add(r.pid);
  found.delete(process.pid);
  found.delete(1);
  return [...found];
}

async function killTree(rootPid: number): Promise<void> {
  const victims = processTree(rootPid);
  if (victims.length === 0) return;
  for (const pid of victims) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  await sleep(250);
  const table = readProcTable();
  const alive = new Set(table.map((r) => r.pid));
  for (const pid of victims) {
    if (alive.has(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}
