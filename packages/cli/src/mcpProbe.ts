// MCP probes — the real handshake, for the connector doctor and the health
// monitor. Nothing here trusts a server: every spawn has a deadline, its own
// process group (so npx/uvx grandchildren die with it), a scrubbed environment
// and a stderr cap; every reply is parsed defensively (stdout noise, legacy
// Content-Length frames, server-initiated requests).
//
// Two probes:
//   probeStdioServer  spawn the exact command, initialize, notifications/
//                     initialized, tools/list (paged).
//   probeRemoteMcp    unauthenticated (or bearer) connectivity check of a
//                     Streamable-HTTP / SSE endpoint. A 401 with OAuth
//                     metadata is "alive", not broken.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// ─── Secret scrubbing ────────────────────────────────────────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
  /\bsecret_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /([?&](?:api[_-]?key|key|token|access[_-]?token|secret|password|apikey)=)[^&\s"']+/gi,
  /(:\/\/[^/\s:@]+:)[^@\s/]+(?=@)/g,
];

/** Redact anything secret-shaped, plus every literal in `extra`. Never throws. */
export function scrubSecrets(text: string, extra: Iterable<string> = []): string {
  let out = String(text ?? "");
  for (const secret of extra) {
    if (typeof secret === "string" && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) => (typeof p1 === "string" && /[=:]$/.test(p1) ? `${p1}[redacted]` : "[redacted]"));
  }
  return out;
}

// ─── Shared types ────────────────────────────────────────────────────────────

export interface StdioSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type StdioFailure = "spawn-error" | "exited" | "timeout" | "rpc-error" | "no-response";

export interface StdioProbeResult {
  ok: boolean;
  /** Last protocol stage reached. */
  stage: "spawn" | "initialize" | "tools" | "done";
  failure?: StdioFailure;
  error?: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  framing?: "ndjson" | "content-length";
  initializeMs?: number;
  latencyMs: number;
  exitCode?: number | null;
  exitSignal?: string | null;
  /** Scrubbed last ~1.5KB of stderr. */
  stderrTail: string;
  /** Non-JSON lines the server wrote to stdout (noise is tolerated). */
  stdoutNoiseLines: number;
}

export interface StdioProbeOptions {
  timeoutMs?: number;
  /** Isolated HOME/XDG/ARES_HOME live under this directory (created). */
  scratchDir: string;
  /** Extra secret literals to scrub from evidence (injected placeholders etc.). */
  secrets?: string[];
  /** Inherit these env names from the caller (PATH is always inherited). */
  inheritEnv?: string[];
  /** Caller's env for the PATH lookup (tests). */
  baseEnv?: NodeJS.ProcessEnv;
  /** Keep the caller's real HOME/cache dirs (verifying a server about to be used). */
  keepHome?: boolean;
}

const DEFAULT_TIMEOUT_MS = 45_000;
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The minimal, isolated environment a third-party server gets in a probe. */
export async function isolatedEnv(scratchDir: string, extra: Record<string, string> = {}, inherit: string[] = [], base: NodeJS.ProcessEnv = process.env, keepHome = false): Promise<Record<string, string>> {
  const dirs = {
    home: path.join(scratchDir, "home"),
    ares: path.join(scratchDir, "ares-home"),
    cfg: path.join(scratchDir, "xdg-config"),
    data: path.join(scratchDir, "xdg-data"),
    state: path.join(scratchDir, "xdg-state"),
    tmp: path.join(scratchDir, "tmp"),
  };
  // The npm/uv caches are shared across the run (set by the caller through
  // `inherit`) so cold downloads are paid once, not per check.
  const cache = path.join(scratchDir, "xdg-cache");
  for (const d of [...Object.values(dirs), cache]) await fs.mkdir(d, { recursive: true });
  const env: Record<string, string> = {
    PATH: base.PATH ?? base.Path ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    ARES_HOME: dirs.ares,
    XDG_CONFIG_HOME: dirs.cfg,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: cache,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    LANG: base.LANG ?? "C.UTF-8",
    CI: "1",
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
  if (process.platform === "win32") {
    for (const k of ["SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA"]) if (base[k]) env[k] = base[k]!;
  }
  if (keepHome) {
    // Verifying a server the owner is about to USE: let npx/uv warm the real
    // package cache, so the first real tool call is not a cold download.
    for (const k of ["HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "npm_config_cache", "UV_CACHE_DIR", "KUBECONFIG", "DOCKER_HOST"]) {
      if (base[k] !== undefined) env[k] = base[k]!;
    }
    if (base.HOME === undefined && base.USERPROFILE === undefined) env.HOME = dirs.home;
    if (base.XDG_CACHE_HOME === undefined) delete env.XDG_CACHE_HOME;
  }
  for (const k of inherit) if (base[k] !== undefined) env[k] = base[k]!;
  return { ...env, ...extra };
}

// ─── stdio ───────────────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Spawn an MCP stdio server and run the real handshake. Never throws. */
export async function probeStdioServer(spec: StdioSpec, opts: StdioProbeOptions): Promise<StdioProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets = new Set<string>([...(opts.secrets ?? []), ...Object.values(spec.env ?? {}).filter((v) => v.length >= 6)]);
  const result: StdioProbeResult = { ok: false, stage: "spawn", latencyMs: 0, stderrTail: "", stdoutNoiseLines: 0 };
  const finish = (): StdioProbeResult => {
    result.latencyMs = Date.now() - started;
    result.stderrTail = scrubSecrets(result.stderrTail.slice(-1500), secrets);
    if (result.error) result.error = scrubSecrets(result.error, secrets);
    return result;
  };

  let env: Record<string, string>;
  try {
    env = await isolatedEnv(opts.scratchDir, spec.env ?? {}, opts.inheritEnv ?? [], opts.baseEnv ?? process.env, opts.keepHome ?? false);
  } catch (err) {
    result.failure = "spawn-error";
    result.error = `could not prepare scratch environment: ${err instanceof Error ? err.message : String(err)}`;
    return finish();
  }

  return await new Promise<StdioProbeResult>((resolve) => {
    let settled = false;
    let buffer: Buffer = Buffer.alloc(0);
    let framing: "ndjson" | "content-length" = "ndjson";
    const waiters = new Map<number, (msg: JsonRpcMessage) => void>();
    let exited = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd ?? opts.scratchDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      result.failure = "spawn-error";
      result.error = err instanceof Error ? err.message : String(err);
      resolve(finish());
      return;
    }

    const done = (patch: Partial<StdioProbeResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      Object.assign(result, patch);
      // Reap the whole group, then make sure.
      killTree(child.pid, "SIGTERM");
      const hard = setTimeout(() => killTree(child.pid, "SIGKILL"), 1500);
      hard.unref?.();
      // Give the exit a moment so exitCode is meaningful when it already died.
      setTimeout(() => resolve(finish()), exited ? 0 : 20);
    };

    const deadline = setTimeout(() => {
      done({
        failure: result.stage === "spawn" || result.stage === "initialize" ? "no-response" : "timeout",
        error: `no ${result.stage === "tools" ? "tools/list" : "initialize"} reply within ${Math.round(timeoutMs / 1000)}s (server hung, is waiting on input, or is still downloading)`,
      });
    }, timeoutMs);
    deadline.unref?.();

    child.on("error", (err: NodeJS.ErrnoException) => {
      done({ stage: "spawn", failure: "spawn-error", error: err.code === "ENOENT" ? `command not found: ${spec.command}` : err.message });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      result.stderrTail = (result.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    child.stdin?.on("error", () => { /* EPIPE when it died early; close handler reports */ });
    child.on("close", (code, signal) => {
      exited = true;
      result.exitCode = code;
      result.exitSignal = signal;
      if (!settled) {
        const last = scrubSecrets(result.stderrTail, secrets).trim().split(/\r?\n/).filter(Boolean).pop();
        done({ failure: "exited", error: `server exited (${signal ?? `code ${code}`}) before answering${last ? `: ${last.slice(0, 300)}` : ""}` });
      }
    });

    const write = (msg: Record<string, unknown>): void => {
      const text = JSON.stringify({ jsonrpc: "2.0", ...msg });
      try {
        if (framing === "content-length") {
          const body = Buffer.from(text, "utf8");
          child.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
          child.stdin?.write(body);
        } else {
          child.stdin?.write(`${text}\n`);
        }
      } catch { /* the close handler reports */ }
    };

    const handle = (raw: string): void => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(raw) as JsonRpcMessage;
      } catch {
        result.stdoutNoiseLines++;
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.method && msg.id !== undefined) {
        // server -> client request: answer so it never blocks on us
        if (msg.method === "ping") write({ id: msg.id, result: {} });
        else if (msg.method === "roots/list") write({ id: msg.id, result: { roots: [] } });
        else write({ id: msg.id, error: { code: -32601, message: "not supported" } });
        return;
      }
      if (typeof msg.id === "number") waiters.get(msg.id)?.(msg);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8 * 1024 * 1024) buffer = buffer.subarray(buffer.length - 1024 * 1024); // runaway output guard
      while (buffer.length > 0) {
        const head = buffer.subarray(0, Math.min(16, buffer.length)).toString("latin1");
        if (/^content-length:/i.test(head)) {
          const he = buffer.indexOf("\r\n\r\n");
          if (he === -1) return;
          const m = buffer.subarray(0, he).toString("utf8").match(/Content-Length:\s*(\d+)/i);
          if (!m) { buffer = buffer.subarray(he + 4); continue; }
          const end = he + 4 + Number(m[1]);
          if (buffer.length < end) return;
          const body = buffer.subarray(he + 4, end).toString("utf8");
          buffer = buffer.subarray(end);
          framing = "content-length";
          result.framing = "content-length";
          handle(body);
          continue;
        }
        const nl = buffer.indexOf(0x0a);
        if (nl === -1) return;
        const line = buffer.subarray(0, nl).toString("utf8").trim();
        buffer = buffer.subarray(nl + 1);
        if (!line) continue;
        if (line.startsWith("{")) handle(line);
        else result.stdoutNoiseLines++;
      }
    });

    const request = (id: number, method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> =>
      new Promise((res) => {
        waiters.set(id, res);
        write({ id, method, params });
      });

    void (async () => {
      try {
        result.stage = "initialize";
        const t0 = Date.now();
        const init = await request(1, "initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ares-connectors-doctor", version: "1" },
        });
        if (settled) return;
        result.initializeMs = Date.now() - t0;
        if (init.error) {
          done({ failure: "rpc-error", error: `initialize failed: ${init.error.message ?? init.error.code}` });
          return;
        }
        const r = init.result ?? {};
        const info = (r.serverInfo ?? {}) as { name?: string; version?: string };
        result.serverName = info.name;
        result.serverVersion = info.version;
        result.protocolVersion = typeof r.protocolVersion === "string" ? r.protocolVersion : undefined;
        result.framing = framing;
        write({ method: "notifications/initialized" });

        result.stage = "tools";
        const names: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 6; page++) {
          const res = await request(2 + page, "tools/list", cursor ? { cursor } : {});
          if (settled) return;
          if (res.error) {
            // Some servers legitimately expose no tools capability.
            if (page === 0 && /method not found|-32601/i.test(`${res.error.message} ${res.error.code}`)) break;
            done({ failure: "rpc-error", error: `tools/list failed: ${res.error.message ?? res.error.code}` });
            return;
          }
          const tools = Array.isArray(res.result?.tools) ? (res.result!.tools as Array<{ name?: unknown }>) : [];
          for (const t of tools) if (typeof t.name === "string") names.push(t.name);
          cursor = typeof res.result?.nextCursor === "string" ? (res.result!.nextCursor as string) : undefined;
          if (!cursor) break;
        }
        done({ ok: true, stage: "done", toolCount: names.length, toolNames: names.slice(0, 200) });
      } catch (err) {
        done({ failure: "rpc-error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

// ─── remote (Streamable HTTP / SSE) ──────────────────────────────────────────

export type RemoteProbeKind =
  | "ok" // initialize (and tools/list) answered
  | "auth-required" // 401/403: alive, credential gate
  | "sse-open" // legacy SSE stream opened
  | "not-found" // 404/410: endpoint gone or moved
  | "server-error" // 5xx
  | "network" // DNS / TLS / connection refused
  | "timeout"
  | "protocol"; // answered, but not MCP

export interface RemoteProbeResult {
  kind: RemoteProbeKind;
  status?: number;
  latencyMs: number;
  toolCount?: number;
  wwwAuthenticate?: string;
  /** auth-required only: did RFC 9728 / RFC 8414 discovery resolve? */
  oauth?: { resourceMetadata: boolean; authorizationServer?: string; registrationEndpoint?: boolean; pkce?: boolean };
  serverName?: string;
  error?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RemoteProbeOptions {
  transport?: "http" | "sse" | "auto";
  bearer?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Also run OAuth discovery when a 401 comes back. Default true. */
  discoverOAuth?: boolean;
}

function netError(err: unknown): { kind: "network" | "timeout"; message: string } {
  const e = err as { name?: string; cause?: { code?: string; message?: string }; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return { kind: "timeout", message: "timed out" };
  const code = e?.cause?.code;
  const msg = code ? `${code}${e.cause?.message ? `: ${e.cause.message}` : ""}` : (e?.message ?? String(err));
  return { kind: "network", message: msg };
}

async function readSseFirstEvent(res: Response, limitMs: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  let text = "";
  const dec = new TextDecoder();
  const end = Date.now() + limitMs;
  try {
    while (Date.now() < end && text.length < 8192) {
      const { value, done } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (/\n\n|\r\n\r\n/.test(text)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function parseRpcBody(text: string, contentType: string): JsonRpcMessage | null {
  try {
    if (contentType.includes("text/event-stream") || /^\s*(event|data):/m.test(text)) {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        try { return JSON.parse(t.slice(5).trim()) as JsonRpcMessage; } catch { /* keep scanning */ }
      }
      return null;
    }
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    return null;
  }
}

async function discoverOAuthMeta(url: string, www: string | undefined, fetchImpl: FetchLike, timeoutMs: number): Promise<RemoteProbeResult["oauth"]> {
  const getJson = async (u: string): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetchImpl(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const origin = new URL(url).origin;
  const pathPart = new URL(url).pathname.replace(/\/+$/, "");
  const fromHeader = www?.match(/resource_metadata="?([^",\s]+)"?/i)?.[1];
  const candidates = [fromHeader, `${origin}/.well-known/oauth-protected-resource${pathPart}`, `${origin}/.well-known/oauth-protected-resource`].filter((c): c is string => Boolean(c));
  let meta: Record<string, unknown> | null = null;
  for (const c of candidates) {
    meta = await getJson(c);
    if (meta) break;
  }
  const authServers = Array.isArray(meta?.authorization_servers) ? (meta!.authorization_servers as string[]) : [];
  const asBase = authServers[0] ?? origin;
  const asUrl = new URL(asBase);
  const asPath = asUrl.pathname.replace(/\/+$/, "");
  let as: Record<string, unknown> | null = null;
  for (const c of [
    `${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${asUrl.origin}/.well-known/openid-configuration${asPath}`,
    `${asBase.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  ]) {
    as = await getJson(c);
    if (as) break;
  }
  const methods = Array.isArray(as?.code_challenge_methods_supported) ? (as!.code_challenge_methods_supported as string[]) : [];
  return {
    resourceMetadata: Boolean(meta),
    ...(authServers[0] ? { authorizationServer: authServers[0] } : {}),
    ...(as ? { registrationEndpoint: typeof as.registration_endpoint === "string", pkce: methods.includes("S256") || methods.length === 0 } : {}),
  };
}

/** Probe a remote MCP endpoint. Never throws. */
export async function probeRemoteMcp(url: string, opts: RemoteProbeOptions = {}): Promise<RemoteProbeResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const secrets = [opts.bearer ?? "", ...Object.values(opts.headers ?? {})].filter((s) => s.length >= 6);
  const lat = (): number => Date.now() - started;
  const base: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "user-agent": "ares-connectors-doctor/1",
    ...(opts.headers ?? {}),
  };
  if (opts.bearer) base.authorization = `Bearer ${opts.bearer}`;

  const authResult = async (res: Response): Promise<RemoteProbeResult> => {
    const www = res.headers.get("www-authenticate") ?? undefined;
    const oauth = opts.discoverOAuth === false ? undefined : await discoverOAuthMeta(url, www, fetchImpl, timeoutMs).catch(() => undefined);
    return { kind: "auth-required", status: res.status, latencyMs: lat(), ...(www ? { wwwAuthenticate: scrubSecrets(www.slice(0, 300), secrets) } : {}), ...(oauth ? { oauth } : {}) };
  };

  const trySse = async (): Promise<RemoteProbeResult> => {
    try {
      const res = await fetchImpl(url, { method: "GET", headers: { ...base, accept: "text/event-stream" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 401 || res.status === 403) return await authResult(res);
      if (res.status === 404 || res.status === 410) return { kind: "not-found", status: res.status, latencyMs: lat(), error: `HTTP ${res.status}` };
      if (res.status >= 500) return { kind: "server-error", status: res.status, latencyMs: lat(), error: `HTTP ${res.status}` };
      if (!res.ok) return { kind: "protocol", status: res.status, latencyMs: lat(), error: `HTTP ${res.status}` };
      const first = await readSseFirstEvent(res, Math.min(timeoutMs, 8000));
      if (/event:\s*endpoint/i.test(first) || /data:/i.test(first) || (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return { kind: "sse-open", status: res.status, latencyMs: lat() };
      }
      return { kind: "protocol", status: res.status, latencyMs: lat(), error: "200 but no SSE stream" };
    } catch (err) {
      const n = netError(err);
      return { kind: n.kind, latencyMs: lat(), error: scrubSecrets(n.message, secrets) };
    }
  };

  if (opts.transport === "sse") return await trySse();

  try {
    const init = await fetchImpl(url, {
      method: "POST",
      headers: base,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ares-connectors-doctor", version: "1" } } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (init.status === 401 || init.status === 403) return await authResult(init);
    if (init.status === 404 || init.status === 410) {
      // A legacy SSE server answers 404/405 to POST; give it one GET before calling it dead.
      if (opts.transport === "auto") {
        const sse = await trySse();
        if (sse.kind === "sse-open" || sse.kind === "auth-required") return sse;
      }
      return { kind: "not-found", status: init.status, latencyMs: lat(), error: `HTTP ${init.status}` };
    }
    if (init.status === 405 || init.status === 406) {
      const sse = await trySse();
      if (sse.kind === "sse-open" || sse.kind === "auth-required") return sse;
      return { kind: "protocol", status: init.status, latencyMs: lat(), error: `POST answered HTTP ${init.status} and no SSE stream either` };
    }
    if (init.status >= 500) return { kind: "server-error", status: init.status, latencyMs: lat(), error: `HTTP ${init.status}` };
    if (!init.ok) return { kind: "protocol", status: init.status, latencyMs: lat(), error: `initialize answered HTTP ${init.status}` };
    const body = parseRpcBody(await init.text(), init.headers.get("content-type") ?? "");
    if (!body || body.error || !body.result) {
      return { kind: "protocol", status: init.status, latencyMs: lat(), error: body?.error?.message ? `initialize error: ${scrubSecrets(body.error.message, secrets)}` : "initialize reply was not a JSON-RPC result" };
    }
    const serverName = (body.result.serverInfo as { name?: string } | undefined)?.name;
    const sid = init.headers.get("mcp-session-id");
    const h2 = sid ? { ...base, "mcp-session-id": sid } : base;
    await fetchImpl(url, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.text().catch(() => "")).catch(() => undefined);
    const list = await fetchImpl(url, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), signal: AbortSignal.timeout(timeoutMs) });
    if (list.status === 401 || list.status === 403) return await authResult(list);
    const lb = list.ok ? parseRpcBody(await list.text(), list.headers.get("content-type") ?? "") : null;
    const tools = Array.isArray(lb?.result?.tools) ? (lb!.result!.tools as unknown[]).length : undefined;
    if (tools === undefined) {
      return { kind: "protocol", status: list.status, latencyMs: lat(), serverName, error: lb?.error?.message ? `tools/list error: ${scrubSecrets(lb.error.message, secrets)}` : `tools/list answered HTTP ${list.status}` };
    }
    return { kind: "ok", status: 200, latencyMs: lat(), toolCount: tools, ...(serverName ? { serverName } : {}) };
  } catch (err) {
    const n = netError(err);
    return { kind: n.kind, latencyMs: lat(), error: scrubSecrets(n.message, secrets) };
  }
}
