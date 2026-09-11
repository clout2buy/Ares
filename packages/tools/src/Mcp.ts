// MCP — stdio, Streamable HTTP and SSE clients, plus the generic tools.
//
// Loads servers from .ares/mcp.json, ~/.ares/mcp.json and the connector
// gallery's ~/.ares/mcp-remote.json. The config shape mirrors common clients:
// { "servers": { "name": { "command": "node", "args": ["server.js"], "env": {} } } }
// Remote servers: { "url": "https://…", "transport": "http" | "sse" | "auto" }.
//
// Auth failures surface as McpAuthError so the engine can offer a reconnect
// card instead of a bare error string.

import { z } from "zod";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTool, toolError } from "./_shared.js";
import { getMcpCallCredentials } from "@ares/core";

const listInputSchema = z
  .object({
    server: z.string().optional().describe("Optional server name. Omit to list configured servers and tools."),
    timeout_ms: z.number().int().positive().max(60_000).default(20_000),
  })
  .strict();

const callInputSchema = z
  .object({
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    timeout_ms: z.number().int().positive().max(120_000).default(60_000),
  })
  .strict();

interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A remote MCP server reachable over Streamable HTTP. `url` is the message
 *  endpoint; `authToken` (or an explicit Authorization in `headers`) is the
 *  bearer used on every request. Remote connectors persisted by the OAuth
 *  gallery live in ~/.ares/mcp-remote.json in this shape. */
interface RemoteServerConfig {
  url: string;
  /** "http" = Streamable HTTP (default for /mcp), "sse" = legacy HTTP+SSE
   *  (default for /sse URLs), "auto" = try HTTP, fall back to SSE. */
  transport?: "http" | "sse" | "auto";
  headers?: Record<string, string>;
  authToken?: string;
  /** OAuth connector — the bearer lives in the encrypted vault, not here. */
  oauth?: boolean;
  /** Static vault-token connector (pasted API key) — bearer in the vault too. */
  vault?: boolean;
  /** Injected at load time (the config-map key) so the vault token resolves. */
  serverName?: string;
}

type McpServerConfig = StdioServerConfig | RemoteServerConfig;

/** The server refused our credentials (401/403). Carries the server name so
 *  the host can offer "Connect <name>" instead of a dead-end error. */
export class McpAuthError extends Error {
  readonly server: string;
  readonly status: number;
  constructor(server: string, status: number) {
    super(`${server} rejected the connection (HTTP ${status}) — it needs to be connected again`);
    this.name = "McpAuthError";
    this.server = server;
    this.status = status;
  }
}

export type { RemoteServerConfig, StdioServerConfig, McpServerConfig };

function isRemote(cfg: McpServerConfig): cfg is RemoteServerConfig {
  return typeof (cfg as RemoteServerConfig).url === "string" && (cfg as RemoteServerConfig).url.length > 0;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpListOutput {
  configFiles: string[];
  servers: Array<{ name: string; tools?: unknown[]; error?: string }>;
}

export interface McpCallOutput {
  server: string;
  tool: string;
  result: unknown;
}

export const McpListToolsTool = buildTool({
  name: "McpListTools",
  description:
    "List MCP servers and their exposed tools from .ares/mcp.json and ~/.ares/mcp.json. Use before McpCallTool when the user configured MCP servers.",
  safety: "external-state",
  concurrency: "parallel-safe",
  inputZod: listInputSchema,
  activityDescription: (i) => (i.server ? `Listing MCP tools from ${i.server}` : "Listing MCP servers"),

  async call(i, ctx): Promise<{ output: McpListOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const selected = Object.entries(loaded.servers).filter(([name]) => !i.server || name === i.server);
    const servers: McpListOutput["servers"] = [];
    for (const [name, cfg] of selected) {
      try {
        const result = await withMcpClient(cfg, i.timeout_ms, async (client) => await client.request("tools/list", {}));
        servers.push({ name, tools: (result as { tools?: unknown[] }).tools ?? [] });
      } catch (err) {
        servers.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      output: { configFiles: loaded.configFiles, servers },
      display: `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`,
    };
  },
});

/** Tool listing for the desktop `/mcp` explorer: connects to one named server
 *  (even a paused one — the panel shows what it WOULD provide) and returns its
 *  tools. Not agent-facing; the daemon calls this on behalf of the panel. */
export async function listMcpServerTools(
  workspace: string,
  server: string,
  timeoutMs?: number,
): Promise<{ tools: Array<{ name: string; description?: string }>; error?: string }> {
  const loaded = await loadMcpConfig(workspace, true);
  const cfg = loaded.servers[server];
  if (!cfg) return { tools: [], error: `unknown MCP server: ${server}` };
  try {
    const result = await withMcpClient(cfg, timeoutMs ?? 15_000, async (client) => await client.request("tools/list", {}));
    const raw = (result as { tools?: unknown[] }).tools ?? [];
    const tools = raw
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({
        name: typeof t.name === "string" ? t.name : "",
        description: typeof t.description === "string" ? t.description : undefined,
      }))
      .filter((t) => t.name);
    return { tools };
  } catch (err) {
    return { tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export const McpCallTool = buildTool({
  name: "McpCallTool",
  description:
    "Call a tool exposed by a configured MCP stdio server. Run McpListTools first to discover available tools and schemas.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: callInputSchema,
  activityDescription: (i) => `MCP ${i.server}/${i.tool}`,

  async call(i, ctx): Promise<{ output: McpCallOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const cfg = loaded.servers[i.server];
    if (!cfg) throw new Error(`Unknown MCP server: ${i.server}`);
    const result = await withMcpClient(
      cfg,
      i.timeout_ms,
      async (client) =>
        await client.request("tools/call", {
          name: i.tool,
          arguments: i.arguments,
        }),
    );
    // A tools/call can succeed at the JSON-RPC layer yet report a tool-level
    // failure via isError. Surface it as a thrown is_error tool_result like every
    // other tool, so the engine's failure-breakers fire instead of the model
    // having to spot a buried "isError":true in the JSON.
    if (result != null && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
      throw toolError(`${i.server}/${i.tool}: ${extractMcpErrorText(result)}`);
    }
    return {
      output: { server: i.server, tool: i.tool, result },
      display: `called ${i.server}/${i.tool}`,
    };
  },
});

// Pull a human-readable message out of a tools/call result's content array.
// MCP content blocks are typically [{ type:"text", text:"…" }]; we join the text
// blocks and fall back to a stringified result when no text is present.
function extractMcpErrorText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block != null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter((t) => t.length > 0)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "tool reported an error";
}

async function loadMcpConfig(workspace: string, includeDisabled = false): Promise<{ servers: Record<string, McpServerConfig>; configFiles: string[] }> {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  // mcp-remote.json is written by the connector gallery (remote HTTP servers);
  // mcp.json is the classic hand-authored (usually stdio) config.
  const candidates = [
    path.join(home, "mcp.json"),
    path.join(home, "mcp-remote.json"),
    path.join(workspace, ".ares", "mcp.json"),
  ];
  const servers: Record<string, McpServerConfig> = {};
  const configFiles: string[] = [];
  for (const file of candidates) {
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8")) as McpConfig;
      const entries = json.servers ?? json.mcpServers ?? {};
      for (const [name, cfg] of Object.entries(entries)) {
        // A paused connector (enabled:false from the /mcp toggle) keeps its
        // tokens but contributes no tools.
        if (!includeDisabled && (cfg as { enabled?: boolean }).enabled === false) continue;
        servers[name] = cfg;
      }
      configFiles.push(file);
    } catch {
      // absent or invalid; ignore here so the tool still reports what is available
    }
  }
  // Tag remote entries with their name so the OAuth-token resolver can find the
  // matching vault bundle at call-time.
  for (const [name, cfg] of Object.entries(servers)) {
    if (isRemote(cfg)) (cfg as RemoteServerConfig).serverName = name;
  }
  return { servers, configFiles };
}

class StdioMcpClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  // The child's first spawn 'error' (e.g. ENOENT for a missing command). It can
  // fire before any request is enqueued, so we stash it and let initialize()/
  // request() reject with it immediately instead of stalling until the timeout.
  spawnError: Error | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      void chunk;
    });
    // A bad/missing server command emits an async 'error' (ENOENT is common on a
    // first run). Unhandled, that becomes an uncaught exception that can crash the
    // daemon — so reject all in-flight requests, mirroring the "close" handler.
    child.on("error", (err) => {
      this.spawnError = err instanceof Error ? err : new Error(String(err));
      for (const p of this.pending.values()) p.reject(this.spawnError);
      this.pending.clear();
    });
    // A write to a dead child's stdin would otherwise raise its own unhandled
    // stream error; swallow it — the 'error'/'close' handlers already reject.
    child.stdin.on("error", () => {});
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ares", version: "0.11.2" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown): Promise<unknown> {
    // If the child already failed to spawn, fail fast instead of writing to a dead
    // stdin and waiting out the Promise.race timeout.
    if (this.spawnError) return Promise.reject(this.spawnError);
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.writeMessage(msg);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private writeMessage(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lenMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      // A malformed frame must not kill the client and orphan in-flight requests;
      // drop the bad frame and keep draining so well-formed frames still resolve.
      try {
        this.handleMessage(JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } });
      } catch {
        // unparseable JSON-RPC frame; skip it
      }
    }
  }

  private handleMessage(msg: { id?: number; result?: unknown; error?: { message?: string } }): void {
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
    else pending.resolve(msg.result);
  }
}

/** The subset of the client both transports share — enough for list/call. */
interface McpClient {
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

/** MCP over Streamable HTTP (the remote-connector transport). One JSON-RPC
 *  request per POST; the server answers with either a JSON body or an SSE
 *  stream whose `data:` event carries the response. A session id handed back on
 *  initialize is echoed on every later request. Injectable fetch for tests. */
export class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private readonly protocolVersion = "2025-06-18";

  constructor(
    private readonly url: string,
    private readonly baseHeaders: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly serverName: string = "the MCP server",
  ) {}

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "ares", version: "1" },
    });
    // Best-effort per spec; a server that rejects the notification must not
    // break the session, so swallow errors here.
    await this.send("notifications/initialized", {}, true).catch(() => undefined);
  }

  request(method: string, params: unknown): Promise<unknown> {
    return this.send(method, params, false);
  }

  private async send(method: string, params: unknown, isNotification: boolean): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
    if (!isNotification) body.id = this.nextId++;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
      ...this.baseHeaders,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const res = await this.fetchImpl(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (isNotification) return undefined;
    if (res.status === 401 || res.status === 403) {
      throw new McpAuthError(this.serverName, res.status);
    }
    if (!res.ok) throw new McpHttpError(res.status, `MCP HTTP ${res.status} from ${this.url}`);

    const ctype = res.headers.get("content-type") ?? "";
    const text = await res.text();
    const message = ctype.includes("text/event-stream") ? parseSseJsonRpc(text) : safeJson(text);
    if (message == null) throw new Error("MCP server returned an empty/unparseable response");
    if (message.error) throw new Error(message.error.message ?? "MCP error");
    return message.result;
  }
}

/** Pull the first JSON-RPC response object out of an SSE body (the `data:`
 *  lines of the last event that parses as a JSON-RPC message). */
function parseSseJsonRpc(text: string): { result?: unknown; error?: { message?: string } } | null {
  let last: { result?: unknown; error?: { message?: string } } | null = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data) continue;
    const parsed = safeJson(data);
    if (parsed && ("result" in parsed || "error" in parsed)) last = parsed;
  }
  return last;
}

function safeJson(text: string): { result?: unknown; error?: { message?: string } } | null {
  try {
    return JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  } catch {
    return null;
  }
}

class McpHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "McpHttpError";
  }
}

/** MCP over the legacy HTTP+SSE transport (2024-11-05): one long-lived GET
 *  stream carries every server→client message; the first `endpoint` event
 *  names the URL to POST client→server messages to. Still what several large
 *  remote servers speak (Linear, Atlassian, Asana, Square, Cloudflare). */
export class SseMcpClient implements McpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private endpoint: string | null = null;
  private endpointReady: Promise<string>;
  private resolveEndpoint!: (url: string) => void;
  private rejectEndpoint!: (err: Error) => void;
  private readonly abort = new AbortController();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly baseHeaders: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly serverName: string = "the MCP server",
  ) {
    this.endpointReady = new Promise<string>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });
    // close() rejects endpointReady via failAll — even on the SUCCESS path,
    // because runSse always close()s in its finally. By then real awaiters have
    // long since consumed the resolved value, so that rejection has no handler
    // and surfaces as an unhandledRejection that crashes garrison (field crash
    // loop, 2026-09-11: "MCP SSE client closed" ×4 during a background tool
    // refresh). A permanently-attached no-op handler marks it handled without
    // affecting genuine awaiters, which attach their own.
    this.endpointReady.catch(() => {});
  }

  async open(): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "GET",
      headers: { accept: "text/event-stream", "cache-control": "no-cache", ...this.baseHeaders },
      signal: this.abort.signal,
    });
    if (res.status === 401 || res.status === 403) throw new McpAuthError(this.serverName, res.status);
    if (!res.ok || !res.body) throw new McpHttpError(res.status, `MCP SSE HTTP ${res.status} from ${this.url}`);
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) throw new McpHttpError(res.status, `MCP SSE endpoint answered ${ctype || "no content-type"}`);
    void this.pump(res.body);
    // Cleared when the endpoint arrives first, so the loser of this race does
    // not reject later with nobody listening (another unhandledRejection path).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("MCP SSE server never sent its endpoint")), 15_000);
      timer.unref?.();
    });
    timeout.catch(() => {});
    try {
      await Promise.race([this.endpointReady, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
          this.onEvent(block);
        }
      }
    } catch (err) {
      if (!this.closed) this.failAll(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!this.closed) this.failAll(new Error("MCP SSE stream closed"));
    }
  }

  private onEvent(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    const payload = data.join("\n");
    if (event === "endpoint") {
      try {
        this.endpoint = new URL(payload, this.url).toString();
        this.resolveEndpoint(this.endpoint);
      } catch {
        this.rejectEndpoint(new Error(`MCP SSE server sent an invalid endpoint: ${payload}`));
      }
      return;
    }
    if (!payload) return;
    const msg = safeJson(payload) as { id?: number; result?: unknown; error?: { message?: string } } | null;
    if (!msg || typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.rejectEndpoint(err);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ares", version: "1" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => undefined);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // If post() throws we never reach `return result`, so the caller never
    // awaits it — yet it stays in `pending` and close()/failAll later rejects
    // it with no handler. Drop it from the map on a send failure so failAll has
    // nothing orphaned to reject, and rethrow for the caller.
    try {
      await this.post({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      this.pending.delete(id);
      throw err;
    }
    return result;
  }

  private async post(body: unknown): Promise<void> {
    const endpoint = this.endpoint ?? (await this.endpointReady);
    const res = await this.fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.baseHeaders },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new McpAuthError(this.serverName, res.status);
    if (!res.ok && res.status !== 202) throw new McpHttpError(res.status, `MCP SSE POST ${res.status}`);
    // Some servers answer the POST with the response body directly.
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      const text = await res.text().catch(() => "");
      const msg = safeJson(text) as { id?: number; result?: unknown; error?: { message?: string } } | null;
      if (msg && typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
          else p.resolve(msg.result);
        }
      }
    }
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    this.failAll(new Error("MCP SSE client closed"));
  }
}

function pickTransport(cfg: RemoteServerConfig): "http" | "sse" | "auto" {
  if (cfg.transport) return cfg.transport;
  return /\/sse\/?$/i.test(new URL(cfg.url).pathname) ? "sse" : "auto";
}

/** Resolve the bearer + headers for a remote server (vault first, config
 *  fallback) — shared by the tools and the daemon's probes. */
export async function remoteHeaders(cfg: RemoteServerConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
  let bearer = cfg.authToken;
  if (cfg.serverName) {
    const vaulted = await getMcpCallCredentials(cfg.serverName).catch(() => null);
    if (vaulted) {
      for (const [key, value] of Object.entries(vaulted.headers)) {
        if (!(key in headers)) headers[key] = value;
      }
      bearer = vaulted.bearer ?? bearer;
    }
  }
  if (bearer && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

async function withRemoteClient<T>(cfg: RemoteServerConfig, timeoutMs: number, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const headers = await remoteHeaders(cfg);
  const name = cfg.serverName ?? "the MCP server";
  const transport = pickTransport(cfg);
  const runHttp = async (): Promise<T> => {
    const client = new HttpMcpClient(cfg.url, headers, fetch, name);
    await client.initialize();
    return await fn(client);
  };
  const runSse = async (): Promise<T> => {
    const client = new SseMcpClient(cfg.url, headers, fetch, name);
    try {
      await client.open();
      await client.initialize();
      return await fn(client);
    } finally {
      client.close();
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      (async () => {
        if (transport === "sse") return await runSse();
        if (transport === "http") return await runHttp();
        try {
          return await runHttp();
        } catch (err) {
          // Streamable HTTP not spoken here (404/405/406, or a non-JSON-RPC
          // answer) → the legacy stream. Auth failures are never retried.
          if (err instanceof McpAuthError) throw err;
          const status = err instanceof McpHttpError ? err.status : 0;
          const looksLegacy = status === 404 || status === 405 || status === 406 || status === 400 || /unparseable/.test(String(err));
          if (!looksLegacy) throw err;
          return await runSse();
        }
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One tools/call against a configured server, with the typed auth error. */
export async function callMcpTool(workspace: string, server: string, tool: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
  const loaded = await loadMcpConfig(workspace);
  const cfg = loaded.servers[server];
  if (!cfg) throw new Error(`Unknown MCP server: ${server}`);
  const result = await withMcpClient(cfg, timeoutMs, async (client) => await client.request("tools/call", { name: tool, arguments: args }));
  if (result != null && typeof result === "object" && (result as { isError?: unknown }).isError === true) {
    throw toolError(`${server}/${tool}: ${extractMcpErrorText(result)}`);
  }
  return result;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Full tool descriptors (with schemas) for one server — what the engine
 *  registers as first-class tools. Paused servers are included when asked. */
export async function listMcpServerToolsFull(workspace: string, server: string, timeoutMs = 20_000, includeDisabled = false): Promise<McpToolDescriptor[]> {
  const loaded = await loadMcpConfig(workspace, includeDisabled);
  const cfg = loaded.servers[server];
  if (!cfg) throw new Error(`unknown MCP server: ${server}`);
  const result = await withMcpClient(cfg, timeoutMs, async (client) => await client.request("tools/list", {}));
  const raw = (result as { tools?: unknown[] }).tools ?? [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
    .map((t) => ({
      name: t.name as string,
      ...(typeof t.description === "string" ? { description: t.description } : {}),
      ...(t.inputSchema && typeof t.inputSchema === "object" ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
    }));
}

/** Names + configs of the servers a workspace can reach (enabled only). */
export async function listMcpServers(workspace: string, includeDisabled = false): Promise<Record<string, McpServerConfig>> {
  return (await loadMcpConfig(workspace, includeDisabled)).servers;
}

export { loadMcpConfig, withMcpClient };

async function withMcpClient<T>(
  cfg: McpServerConfig,
  timeoutMs: number,
  fn: (client: McpClient) => Promise<T>,
): Promise<T> {
  if (isRemote(cfg)) return await withRemoteClient(cfg, timeoutMs, fn);
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env ?? {}) },
    windowsHide: true,
  });
  const client = new StdioMcpClient(child);
  // Capture the handle so we can clear it after the race settles; an un-cleared
  // timer keeps the event loop alive and can fire a late no-op rejection. unref()
  // also stops it from holding the process open on its own.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  // A spawn 'error' (e.g. ENOENT) can fire before/around initialize(); surface it
  // as an immediate rejection rather than stalling until the timeout. If the error
  // already happened, reject synchronously via spawnError.
  const spawnFailed = new Promise<never>((_, reject) => {
    if (client.spawnError) reject(client.spawnError);
    else child.once("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        return await fn(client);
      })(),
      spawnFailed,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
