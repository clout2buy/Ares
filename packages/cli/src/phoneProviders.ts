// /gateway/providers — sign in to the coding agents and model providers on THIS
// box from the phone, without "open a link and paste a code". Contract and the
// per-provider findings: docs/PROVIDER-LOGIN.md.
//
//   GET  /gateway/providers                          state of every provider (no secrets)
//   POST /gateway/providers/login    {id, v:2}       start: open | device | paste | signed_in | unsupported
//   POST /gateway/providers/complete {pollId, callbackUrl?|code?}
//   GET  /gateway/providers/poll?id=
//   POST /gateway/providers/cancel   {pollId}
//   POST /gateway/providers/logout   {id}
//
// Three mechanisms, best first:
//   A loopback  the login runs on the box (a CLI under a pty, or Ares's own
//               in-process flow) and listens on http://localhost:<port>/<path>.
//               The phone opens the authorize URL, intercepts the provider's
//               redirect to that loopback address, and posts it back; the
//               SERVER replays it against its own listener (127.0.0.1:<port>
//               parsed from the CLI's redirect_uri, never a client host).
//   B device    {userCode, verificationUrl}; completion is the CLI exiting 0 /
//               the credential appearing.
//   C paste     last resort: the code the provider shows is typed into the app
//               and written to the pty's stdin.
//
// A CLI runs under `script -qefc` (a pty, no new dependency) with a SCRUBBED
// environment, HOME of the service user, and BROWSER / xdg-open pointing at a
// shim that records the URL instead of opening anything. One login per provider
// at a time; every flow dies after 10 minutes.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  appendAudit,
  authFilePath,
  clearAnthropicTokens,
  kimiAuthStatus,
  kimiLogout,
  loadAnthropicTokens,
  runAnthropicLoginFlow,
  runKimiLoginFlow,
  runOpenAILoginFlow,
} from "@ares/core";
import { cleanAccount, safeText } from "./connectionsSafe.js";

export type ProviderState = "signed_in" | "signed_out" | "expired" | "unknown" | "login_in_progress";
export type LoginMethod = "loopback" | "device" | "paste" | "key";

export interface ProviderView {
  id: string;
  label: string;
  kind: "coding-agent" | "model";
  state: ProviderState;
  account?: string;
  expiresAt?: number;
  method: LoginMethod;
  note?: string;
}

export interface ProvidersApiOptions {
  /** ARES_HOME for audit rows. */
  home?: string;
  log?: (line: string) => void;
  now?: () => number;
  /** HOME the CLIs run under (default: this process's home). */
  serviceHome?: string;
  /** Explicit CLI paths (tests / odd installs); otherwise PATH + ~/.local/bin. */
  bins?: Partial<Record<CliId, string>>;
  /** Flow lifetime (default 10 minutes). */
  flowTtlMs?: number;
  /** How long to wait for a CLI to print its URL (default 20s). */
  startTimeoutMs?: number;
  /** Test seams for Ares's own in-process logins. */
  anthropicFetch?: typeof fetch;
  openaiFetch?: typeof fetch;
  kimiFetch?: typeof fetch;
}

type CliId = "claude-code" | "codex" | "kimi-cli";
type OwnId = "ares-anthropic" | "ares-openai" | "ares-kimi";
const CLI_IDS: CliId[] = ["claude-code", "codex", "kimi-cli"];
const OWN_IDS: OwnId[] = ["ares-anthropic", "ares-openai", "ares-kimi"];

interface CliSpec {
  id: CliId;
  label: string;
  bin: string;
  /** argv (after the binary) per login method this CLI supports. */
  login: Partial<Record<"loopback" | "device" | "paste", string[]>>;
  statusArgs?: string[];
  logoutArgs: string[];
  /** Credential file relative to HOME: presence is the fallback state check. */
  credFile: string;
  method: LoginMethod;
  note?: string;
}

const CLI_SPECS: Record<CliId, CliSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    // verified on the box: prints a loopback authorize URL via BROWSER and a manual (paste) URL on stdout
    login: { loopback: ["auth", "login"], paste: ["auth", "login"] },
    statusArgs: ["auth", "status", "--json"],
    logoutArgs: ["auth", "logout"],
    credFile: ".claude/.credentials.json",
    method: "loopback",
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    // not installed on the box: from the CLI's documented behaviour (unverified here)
    login: { loopback: ["login"], device: ["login", "--device-auth"] },
    statusArgs: ["login", "status"],
    logoutArgs: ["logout"],
    credFile: ".codex/auth.json",
    method: "loopback",
  },
  "kimi-cli": {
    id: "kimi-cli",
    label: "Kimi CLI",
    bin: "kimi",
    login: { device: ["login"], loopback: ["login"] },
    logoutArgs: ["logout"],
    credFile: ".kimi/credentials/kimi-code.json",
    method: "device",
    note: "Kimi CLI login output has not been verified on this machine.",
  },
};

const OWN_LABELS: Record<OwnId, { label: string; method: LoginMethod }> = {
  "ares-anthropic": { label: "Ares - Claude subscription", method: "loopback" },
  "ares-openai": { label: "Ares - ChatGPT / Codex", method: "loopback" },
  "ares-kimi": { label: "Ares - Kimi", method: "device" },
};

const DEFAULT_TTL_MS = 10 * 60_000;
const BODY_LIMIT = 8 * 1024;
const STATUS_TIMEOUT_MS = 8_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface DeviceInfo {
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete?: string;
  expiresInSec: number;
  intervalSec: number;
}

type FlowStatus = "pending" | "signed_in" | "failed" | "expired";

interface Flow {
  pollId: string;
  provider: string;
  mode: "loopback" | "device" | "paste";
  status: FlowStatus;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  /** loopback: the port + path the login is listening on. */
  port?: number;
  callbackPath?: string;
  consumed: boolean;
  child?: ChildProcess;
  shimDir?: string;
  /** Resolves when the login ends, however it ends. */
  done: Promise<void>;
  finish: (status: FlowStatus, error?: string) => void;
  timer?: NodeJS.Timeout;
  cancel: () => void;
  /** paste: write the code into the CLI. */
  sendCode?: (code: string) => boolean;
  secrets: string[];
}

class HttpFail extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

// ── output handling ───────────────────────────────────────────────────────

/** Strip terminal escapes (CSI + OSC incl. OSC-8 hyperlinks) and CRs. */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[()][0-9A-Za-z]/g, "")
    .replace(/\r/g, "");
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>\u0000-\u001f]+/g)].map((m) => m[0].replace(/[.,;)\]]+$/, ""));
}

/** The loopback redirect of an authorize URL, when it has one. */
export function loopbackOf(authorizeUrl: string): { port: number; path: string } | null {
  try {
    const redirect = new URL(authorizeUrl).searchParams.get("redirect_uri");
    if (!redirect) return null;
    const r = new URL(redirect);
    if (r.protocol !== "http:" || !LOOPBACK_HOSTS.has(r.hostname)) return null;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { port, path: r.pathname || "/" };
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── the module ────────────────────────────────────────────────────────────

export function createProvidersApi(opts: ProvidersApiOptions = {}) {
  const now = opts.now ?? Date.now;
  const ttl = opts.flowTtlMs ?? DEFAULT_TTL_MS;
  const startTimeout = opts.startTimeoutMs ?? 20_000;
  const serviceHome = opts.serviceHome ?? os.homedir();
  const log = (line: string): void => opts.log?.(`providers: ${line}`);
  const flows = new Map<string, Flow>();
  const active = new Map<string, Flow>(); // provider id -> its pending flow

  const audit = (action: string, target: string, params: Record<string, unknown>, result: string): void => {
    void appendAudit({ actor: "owner", action, target, params, result }, opts.home).catch(() => undefined);
  };

  // ---- environment + binaries ---------------------------------------------

  const scrubbedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: [path.join(serviceHome, ".local", "bin"), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(path.delimiter),
    HOME: serviceHome,
    USER: process.env.USER ?? os.userInfo().username,
    LOGNAME: process.env.LOGNAME ?? os.userInfo().username,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    ...extra,
  });

  const findBin = async (spec: CliSpec): Promise<string | null> => {
    const explicit = opts.bins?.[spec.id];
    const candidates = explicit ? [explicit] : scrubbedEnv().PATH!.split(path.delimiter).map((d) => path.join(d, spec.bin));
    for (const c of candidates) {
      try {
        await fs.access(c, 1 /* X_OK */);
        const st = await fs.stat(c);
        if (st.isFile()) return c;
      } catch { /* next */ }
    }
    return null;
  };

  const hasScript = async (): Promise<boolean> => {
    if (process.platform !== "linux") return false;
    for (const d of ["/usr/bin", "/bin", "/usr/local/bin"]) {
      try { await fs.access(path.join(d, "script"), 1); return true; } catch { /* next */ }
    }
    return false;
  };

  /** Run a CLI to completion with the scrubbed env (status / logout). */
  const runQuick = (bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> =>
    new Promise((resolve) => {
      let out = "";
      let settled = false;
      const child = spawn(bin, args, { env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"] });
      const end = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve({ code, out: stripAnsi(out).slice(0, 8192) });
      };
      const t = setTimeout(() => { child.kill("SIGKILL"); end(null); }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      child.stderr.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      child.on("error", () => end(null));
      child.on("close", (code) => end(code));
    });

  // ---- state ----------------------------------------------------------------

  const readCliState = async (spec: CliSpec): Promise<Pick<ProviderView, "state" | "account" | "expiresAt" | "note">> => {
    const bin = await findBin(spec);
    if (!bin) return { state: "unknown", note: `${spec.bin} is not installed on this machine` };
    let expiresAt: number | undefined;
    let credPresent = false;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(serviceHome, spec.credFile), "utf8")) as Record<string, unknown>;
      credPresent = true;
      const oauth = (raw.claudeAiOauth ?? raw) as Record<string, unknown>;
      if (typeof oauth.expiresAt === "number") expiresAt = oauth.expiresAt;
    } catch { /* absent or unparsable */ }
    if (spec.statusArgs) {
      const r = await runQuick(bin, spec.statusArgs, opts.startTimeoutMs && opts.startTimeoutMs < STATUS_TIMEOUT_MS ? opts.startTimeoutMs : STATUS_TIMEOUT_MS);
      if (r.code === null) return { state: "unknown", note: `${spec.bin} did not answer a status check` };
      let loggedIn: boolean | undefined;
      let account: string | undefined;
      try {
        const j = JSON.parse(r.out) as Record<string, unknown>;
        if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn;
        account = cleanAccount(j.email) ?? cleanAccount(j.account);
      } catch {
        loggedIn = r.code === 0 ? true : undefined;
      }
      if (loggedIn === true) return { state: "signed_in", ...(account ? { account } : {}), ...(expiresAt ? { expiresAt } : {}) };
      if (loggedIn === false) return { state: credPresent ? "expired" : "signed_out" };
    }
    return { state: credPresent ? "signed_in" : "signed_out", ...(expiresAt ? { expiresAt } : {}) };
  };

  const readOwnState = async (id: OwnId): Promise<Pick<ProviderView, "state" | "account" | "expiresAt" | "note">> => {
    try {
      if (id === "ares-anthropic") {
        const t = await loadAnthropicTokens();
        if (!t) return { state: "signed_out" };
        if (t.expiresAt && t.expiresAt < now() && !t.refreshToken) return { state: "expired", expiresAt: t.expiresAt };
        return { state: "signed_in", ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}) };
      }
      if (id === "ares-openai") {
        // Read the file directly: loadAuthToken() would refresh over the network on a list call.
        if (process.env.ARES_OPENAI_OAUTH_TOKEN) return { state: "signed_in", note: "from ARES_OPENAI_OAUTH_TOKEN" };
        let file: { tokens?: { refreshToken?: unknown; expiresAt?: unknown }; profile?: { email?: unknown } };
        try { file = JSON.parse(await fs.readFile(authFilePath(), "utf8")); } catch { return { state: "signed_out" }; }
        const exp = typeof file.tokens?.expiresAt === "number" ? file.tokens.expiresAt : undefined;
        const account = cleanAccount(file.profile?.email);
        const dead = exp !== undefined && exp < now() && !file.tokens?.refreshToken;
        return { state: dead ? "expired" : "signed_in", ...(account ? { account } : {}), ...(exp ? { expiresAt: exp } : {}) };
      }
      const k = await kimiAuthStatus();
      if (!k.connected) return { state: "signed_out" };
      return { state: "signed_in", ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}) };
    } catch {
      return { state: "unknown" };
    }
  };

  const viewOf = async (id: string): Promise<ProviderView> => {
    const inProgress = active.has(id);
    if ((CLI_IDS as string[]).includes(id)) {
      const spec = CLI_SPECS[id as CliId];
      const s = await readCliState(spec);
      return { id, label: spec.label, kind: "coding-agent", method: spec.method, ...s, ...(inProgress ? { state: "login_in_progress" as const } : {}), ...(s.note ? {} : spec.note ? { note: spec.note } : {}) };
    }
    const own = OWN_LABELS[id as OwnId];
    const s = await readOwnState(id as OwnId);
    return { id, label: own.label, kind: "model", method: own.method, ...s, ...(inProgress ? { state: "login_in_progress" as const } : {}) };
  };

  // ---- flows ----------------------------------------------------------------

  const newFlow = (provider: string, mode: Flow["mode"]): Flow => {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    const flow: Flow = {
      pollId: randomBytes(24).toString("base64url"),
      provider,
      mode,
      status: "pending",
      createdAt: now(),
      consumed: false,
      done,
      secrets: [],
      finish: (status, error) => {
        if (flow.status !== "pending") return;
        flow.status = status;
        if (error) flow.error = error;
        flow.finishedAt = now();
        if (flow.timer) clearTimeout(flow.timer);
        if (active.get(provider) === flow) active.delete(provider);
        if (flow.shimDir) void fs.rm(flow.shimDir, { recursive: true, force: true }).catch(() => undefined);
        killChild(flow);
        resolveDone();
      },
      cancel: () => flow.finish("failed", "cancelled"),
    };
    flow.timer = setTimeout(() => {
      flow.finish("expired", "the sign-in took longer than 10 minutes");
      log(`${provider} login expired`);
    }, ttl);
    flow.timer.unref?.();
    flows.set(flow.pollId, flow);
    active.set(provider, flow);
    return flow;
  };

  const killChild = (flow: Flow): void => {
    const child = flow.child;
    if (!child || child.exitCode !== null || child.pid === undefined) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    const hard = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } }, 2_000);
    hard.unref?.();
  };

  const sweep = (): void => {
    for (const [id, flow] of flows) {
      if (flow.status !== "pending" && flow.finishedAt !== undefined && now() - flow.finishedAt > ttl) flows.delete(id);
    }
  };

  /** Replay the intercepted redirect against the loopback listener THIS flow owns. */
  const replay = (port: number, pathAndQuery: string): Promise<void> =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: pathAndQuery, method: "GET", timeout: 15_000, headers: { host: `localhost:${port}`, connection: "close" } }, (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve());
      req.end();
    });

  // ---- CLI login under a pty -----------------------------------------------

  const startCliLogin = async (spec: CliSpec, method: "loopback" | "device" | "paste"): Promise<Record<string, unknown>> => {
    const bin = await findBin(spec);
    if (!bin) return { state: "unsupported", id: spec.id, reason: `${spec.bin} is not installed on this machine` };
    if (!(await hasScript())) return { state: "unsupported", id: spec.id, reason: "this machine has no pty helper (util-linux script), so a CLI login cannot be driven here" };
    const args = spec.login[method];
    if (!args) return { state: "unsupported", id: spec.id, reason: `${spec.label} has no ${method} sign-in` };

    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-login-"));
    await fs.chmod(shimDir, 0o700);
    const urlsFile = path.join(shimDir, "urls");
    const shim = path.join(shimDir, "open.sh");
    await fs.writeFile(shim, `#!/bin/sh\nfor a in "$@"; do case "$a" in http*) printf '%s\\n' "$a" >> ${shellQuote(urlsFile)};; esac; done\nexit 0\n`, { mode: 0o700 });
    for (const n of ["xdg-open", "open", "sensible-browser", "x-www-browser", "www-browser", "gnome-open"]) await fs.symlink("open.sh", path.join(shimDir, n)).catch(() => undefined);

    const flow = newFlow(spec.id, method);
    flow.shimDir = shimDir;
    const cmd = [bin, ...args].map(shellQuote).join(" ");
    const child = spawn("script", ["-qefc", cmd, "/dev/null"], {
      env: { ...scrubbedEnv({ BROWSER: shim }), PATH: `${shimDir}${path.delimiter}${scrubbedEnv().PATH}` },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    flow.child = child;
    let out = "";
    const onData = (d: Buffer): void => { out = (out + d.toString("utf8")).slice(-64 * 1024); };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.stdin!.on("error", () => undefined);
    child.on("error", (err) => flow.finish("failed", safeText(err, [], 160)));
    flow.sendCode = (code: string): boolean => {
      if (child.exitCode !== null || !child.stdin || child.stdin.destroyed) return false;
      child.stdin.write(`${code}\r`);
      return true;
    };
    child.on("close", (code) => {
      if (flow.status !== "pending") return;
      if (code !== 0) {
        const tail = stripAnsi(out).split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
        flow.finish("failed", safeText(tail || `${spec.bin} exited with ${code}`, flow.secrets, 160));
        return;
      }
      // A zero exit is only believed if the credential is really there.
      void readCliState(spec).then((s) => {
        if (s.state === "signed_in") flow.finish("signed_in");
        else flow.finish("failed", `${spec.bin} finished but no credential is visible`);
      });
    });

    // Wait for the URL (and, for device, the code) the CLI prints / "opens".
    const deadline = now() + startTimeout;
    let stdoutUrlSeenAt = 0;
    let result: Record<string, unknown> | null = null;
    while (now() < deadline && flow.status === "pending") {
      const shimUrls = await fs.readFile(urlsFile, "utf8").then((t) => t.split("\n").filter(Boolean), () => [] as string[]);
      const text = stripAnsi(out);
      const printed = urlsIn(text);
      if (printed.length && !stdoutUrlSeenAt) stdoutUrlSeenAt = now();
      if (method === "device") {
        const code = /\b([A-Z0-9]{3,5}-[A-Z0-9]{3,5})\b/.exec(text)?.[1];
        const url = printed.find((u) => !loopbackOf(u)) ?? shimUrls[0];
        if (code && url) {
          const info: DeviceInfo = { userCode: code, verificationUrl: url, expiresInSec: Math.round(ttl / 1000), intervalSec: 5 };
          result = { state: "device", id: spec.id, ...info, pollId: flow.pollId };
          break;
        }
      } else if (method === "loopback") {
        const candidates = [...shimUrls, ...(now() - stdoutUrlSeenAt > 1_500 ? printed : [])];
        const lb = candidates.map((u) => ({ u, lb: loopbackOf(u) })).find((c) => c.lb);
        if (lb?.lb) {
          flow.port = lb.lb.port;
          flow.callbackPath = lb.lb.path;
          result = { state: "open", id: spec.id, url: lb.u, pollId: flow.pollId, intercept: { redirectPrefix: `http://localhost:${lb.lb.port}${lb.lb.path}` } };
          break;
        }
        // No loopback redirect: the CLI only does the manual flow. Fall back, labelled.
        if (candidates.length && (now() - stdoutUrlSeenAt > 3_000 || shimUrls.length)) {
          const manual = candidates[0]!;
          flow.mode = "paste";
          result = { state: "paste", id: spec.id, url: manual, pollId: flow.pollId, hint: `Approve in the browser, then copy the code ${spec.label} shows and enter it here.` };
          break;
        }
      } else {
        // paste: the manual (non-loopback) URL
        const manual = [...printed, ...shimUrls].find((u) => !loopbackOf(u));
        if (manual) {
          result = { state: "paste", id: spec.id, url: manual, pollId: flow.pollId, hint: `Approve in the browser, then copy the code ${spec.label} shows and enter it here.` };
          break;
        }
      }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!result) {
      const why = flow.status === "failed" && flow.error ? flow.error : `${spec.bin} did not offer a sign-in link in time`;
      flow.finish("failed", why);
      throw new HttpFail(502, safeText(why, [], 200));
    }
    return result;
  };

  // ---- Ares's own in-process logins ----------------------------------------

  const startOwnLogin = async (id: OwnId): Promise<Record<string, unknown>> => {
    const flow = newFlow(id, id === "ares-kimi" ? "device" : "loopback");
    const ac = new AbortController();
    let gotUrl!: (v: string | DeviceInfo) => void;
    const first = new Promise<string | DeviceInfo>((r) => { gotUrl = r; });
    const settle = (p: Promise<unknown>): void => {
      p.then(
        () => flow.finish("signed_in"),
        (err: unknown) => flow.finish("failed", safeText(err, flow.secrets, 200)),
      );
    };
    let run: Promise<unknown>;
    if (id === "ares-anthropic") run = runAnthropicLoginFlow((u) => gotUrl(u), opts.anthropicFetch ?? fetch, ttl, true);
    else if (id === "ares-openai") run = runOpenAILoginFlow({ onAuthorizeUrl: (u) => gotUrl(u), maxWaitMs: ttl, ...(opts.openaiFetch ? { fetchImpl: opts.openaiFetch } : {}) });
    else {
      run = runKimiLoginFlow({
        force: true,
        signal: ac.signal,
        timeoutMs: ttl,
        ...(opts.kimiFetch ? { fetchImpl: opts.kimiFetch } : {}),
        onAuthorize: (a) => gotUrl({
          userCode: a.userCode,
          verificationUrl: a.verificationUri,
          ...(a.verificationUriComplete ? { verificationUrlComplete: a.verificationUriComplete } : {}),
          expiresInSec: a.expiresInSeconds,
          intervalSec: a.intervalSeconds,
        }),
      });
      flow.cancel = () => { ac.abort(); flow.finish("failed", "cancelled"); };
    }
    settle(run);
    // The login may fail before it ever offers a URL (port busy, device endpoint down).
    const winner = await Promise.race([first, flow.done.then(() => null)]);
    if (winner === null) throw new HttpFail(502, safeText(flow.error ?? "the sign-in could not start", [], 200));
    if (typeof winner === "string") {
      const lb = loopbackOf(winner);
      if (!lb) { flow.finish("failed", "unexpected authorize URL"); throw new HttpFail(502, "the provider's sign-in URL has no loopback redirect"); }
      flow.port = lb.port;
      flow.callbackPath = lb.path;
      flow.cancel = () => {
        // Closing the listener: a provider-error callback makes the flow finish and close its server.
        void replay(lb.port, `${lb.path}?error=cancelled`).then(() => flow.finish("failed", "cancelled"));
      };
      return { state: "open", id, url: winner, pollId: flow.pollId, intercept: { redirectPrefix: `http://localhost:${lb.port}${lb.path}` } };
    }
    return { state: "device", id, ...winner, pollId: flow.pollId };
  };

  // ---- completion -----------------------------------------------------------

  const validateCallback = (flow: Flow, raw: string): string => {
    if (flow.port === undefined || flow.callbackPath === undefined) throw new HttpFail(400, "this sign-in does not take a callback URL");
    if (raw.length > 4096) throw new HttpFail(400, "callbackUrl too long");
    let u: URL;
    try { u = new URL(raw); } catch { throw new HttpFail(400, "callbackUrl is not a URL"); }
    if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname)) throw new HttpFail(400, "callbackUrl must be the loopback redirect this sign-in registered");
    if (Number(u.port) !== flow.port) throw new HttpFail(400, "callbackUrl port is not the one this sign-in is listening on");
    if (u.pathname !== flow.callbackPath) throw new HttpFail(400, "callbackUrl path is not the one this sign-in registered");
    if (u.username || u.password) throw new HttpFail(400, "callbackUrl may not carry credentials");
    return `${u.pathname}${u.search}`;
  };

  const waitDone = async (flow: Flow, ms: number): Promise<void> => {
    await Promise.race([flow.done, new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); })]);
  };

  const pollOf = (flow: Flow): { state: FlowStatus; error?: string } => {
    if (flow.status === "pending" && now() - flow.createdAt > ttl) flow.finish("expired", "the sign-in took longer than 10 minutes");
    return { state: flow.status, ...(flow.error ? { error: safeText(flow.error, flow.secrets, 200) } : {}) };
  };

  // ---- HTTP -----------------------------------------------------------------

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
    res.end(text);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > BODY_LIMIT) throw new HttpFail(413, "body too large");
      chunks.push(chunk as Buffer);
    }
    if (!total) return {};
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpFail(400, "body must be JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpFail(400, "body must be a JSON object");
    return parsed as Record<string, unknown>;
  };

  const knownId = (id: unknown): id is string => typeof id === "string" && ([...CLI_IDS, ...OWN_IDS] as string[]).includes(id);

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/gateway/providers" && !url.pathname.startsWith("/gateway/providers/")) return false;
    sweep();
    try {
      switch (`${req.method} ${url.pathname.replace(/\/+$/, "")}`) {
        case "GET /gateway/providers": {
          const providers = await Promise.all([...CLI_IDS, ...OWN_IDS].map((id) => viewOf(id)));
          send(res, 200, { providers });
          return true;
        }

        case "POST /gateway/providers/login": {
          const body = await readBody(req);
          if (!knownId(body.id)) throw new HttpFail(404, "unknown provider");
          const id = body.id;
          const method = body.method === "device" || body.method === "paste" ? body.method : undefined;
          const existing = active.get(id);
          if (existing && existing.status === "pending") throw new HttpFail(409, "a sign-in for this provider is already in progress", { state: "login_in_progress", pollId: existing.pollId });
          if (body.force !== true) {
            const cur = await viewOf(id);
            if (cur.state === "signed_in") { send(res, 200, { state: "signed_in", id }); return true; }
          }
          let result: Record<string, unknown>;
          if ((CLI_IDS as string[]).includes(id)) {
            const spec = CLI_SPECS[id as CliId];
            result = await startCliLogin(spec, method ?? (spec.method === "device" ? "device" : "loopback"));
          } else {
            if (method === "paste" || (method === "device" && id !== "ares-kimi")) {
              send(res, 200, { state: "unsupported", id, reason: `${OWN_LABELS[id as OwnId].label} signs in by ${OWN_LABELS[id as OwnId].method} only` });
              return true;
            }
            result = await startOwnLogin(id as OwnId);
          }
          log(`${id} login ${String(result.state)}`);
          audit("providers.login", id, { method: String(result.state) }, String(result.state));
          send(res, 200, result);
          return true;
        }

        case "POST /gateway/providers/complete": {
          const body = await readBody(req);
          const pollId = typeof body.pollId === "string" ? body.pollId : "";
          const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : undefined;
          const code = typeof body.code === "string" ? body.code : undefined;
          if (!pollId) throw new HttpFail(400, "pollId required");
          if ((callbackUrl === undefined) === (code === undefined)) throw new HttpFail(400, "send exactly one of callbackUrl or code");
          const flow = flows.get(pollId);
          if (!flow) { send(res, 404, { error: "unknown or expired sign-in", state: "expired" }); return true; }
          if (flow.status !== "pending") { send(res, 200, pollOf(flow)); return true; }
          if (flow.consumed) throw new HttpFail(409, "this sign-in was already completed once", { state: pollOf(flow).state });
          if (callbackUrl !== undefined) {
            if (flow.mode === "paste") throw new HttpFail(400, "this sign-in takes a code, not a callback URL");
            const target = validateCallback(flow, callbackUrl);
            flow.consumed = true;
            await replay(flow.port!, target);
          } else {
            if (flow.mode !== "paste" || !flow.sendCode) throw new HttpFail(400, "this sign-in does not take a pasted code");
            if (!/^[A-Za-z0-9._~#:/+=-]{6,800}$/.test(code!)) throw new HttpFail(400, "that does not look like an authorization code");
            flow.secrets.push(code!);
            flow.consumed = true;
            if (!flow.sendCode(code!)) throw new HttpFail(409, "the sign-in is no longer running", { state: pollOf(flow).state });
          }
          await waitDone(flow, 20_000);
          const r = pollOf(flow);
          log(`${flow.provider} complete -> ${r.state}`);
          audit("providers.complete", flow.provider, { mode: flow.mode }, r.state);
          send(res, 200, r);
          return true;
        }

        case "GET /gateway/providers/poll": {
          const id = url.searchParams.get("id") ?? "";
          const flow = id ? flows.get(id) : undefined;
          if (!flow) { send(res, 404, { error: "unknown or expired sign-in", state: "expired" }); return true; }
          send(res, 200, pollOf(flow));
          return true;
        }

        case "POST /gateway/providers/cancel": {
          const body = await readBody(req);
          const flow = typeof body.pollId === "string" ? flows.get(body.pollId) : undefined;
          if (!flow) { send(res, 404, { error: "unknown or expired sign-in", state: "expired" }); return true; }
          if (flow.status === "pending") flow.cancel();
          audit("providers.cancel", flow.provider, {}, "ok");
          send(res, 200, { ok: true, ...pollOf(flow) });
          return true;
        }

        case "POST /gateway/providers/logout": {
          const body = await readBody(req);
          if (!knownId(body.id)) throw new HttpFail(404, "unknown provider");
          const id = body.id;
          const running = active.get(id);
          if (running) running.cancel();
          if ((CLI_IDS as string[]).includes(id)) {
            const spec = CLI_SPECS[id as CliId];
            const bin = await findBin(spec);
            if (!bin) throw new HttpFail(409, `${spec.bin} is not installed on this machine`);
            await runQuick(bin, spec.logoutArgs, 15_000);
          } else if (id === "ares-anthropic") await clearAnthropicTokens();
          else if (id === "ares-openai") await fs.rm(authFilePath(), { force: true });
          else await kimiLogout();
          const v = await viewOf(id);
          log(`${id} logout -> ${v.state}`);
          audit("providers.logout", id, {}, v.state);
          send(res, 200, { ok: v.state !== "signed_in", id, state: v.state });
          return true;
        }

        default:
          send(res, 404, { error: "not found" });
          return true;
      }
    } catch (err) {
      if (err instanceof HttpFail) {
        send(res, err.status, { error: err.message, ...err.extra });
        return true;
      }
      log(`${url.pathname} failed: ${safeText(err, [], 160)}`);
      if (!res.headersSent) send(res, 500, { error: safeText(err, [], 160) });
      return true;
    }
  }

  /** Stop every pending login (garrison shutdown). */
  function close(): void {
    for (const flow of [...active.values()]) { try { flow.cancel(); } catch { /* gone */ } }
  }

  return Object.assign(handle, { close });
}
