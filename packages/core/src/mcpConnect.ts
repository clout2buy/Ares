// MCP connect — turns the OAuth brain (mcpOAuth.ts) into a one-click action:
// discover → dynamically register → PKCE authorize (loopback callback) →
// exchange → persist → VERIFY. Tokens are stored ENCRYPTED in the credential
// vault; the on-disk server list (~/.ares/mcp-remote.json) never holds a
// secret. The tools layer resolves a fresh access token at call-time via
// getMcpAccessToken (which refreshes transparently), so connectors keep
// working across restarts.
//
// Hardening (2026-08-11):
//   - post-connect verification: a tools/list probe with the fresh token, so
//     "connected" means the server actually accepts it (toolCount populated;
//     an issued-but-rejected token no longer reads as success);
//   - reconnect preserves state: enabled:false pauses, custom headers and
//     display names survive a re-auth instead of being wiped;
//   - API-key connectors: setMcpServerToken stores a pasted token in the SAME
//     encrypted vault (as a static bundle) — never plaintext on disk;
//   - loopback port fallback: a busy 53682 falls back to an ephemeral port and
//     registers the redirect URI with the port actually bound.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getCredential, setCredential, deleteCredential } from "./credentials.js";
import {
  discoverMcpAuth,
  registerMcpClient,
  generatePkce,
  buildMcpAuthorizeUrl,
  exchangeMcpCode,
  refreshMcpToken,
  revokeMcpToken,
  type McpAuthServer,
} from "./mcpOAuth.js";
import {
  OAuthError,
  beginAuthorization,
  completeAuthorization,
  pollDeviceAuthorization,
  refreshOAuthToken,
  registerOAuthClient,
  requestDeviceAuthorization,
  singleFlight,
  type CallbackParams,
  type ClientAuthMethod,
  type DeviceAuthorization,
  type PendingAuthorization,
} from "./oauthEngine.js";

const DEFAULT_PORT = 53682; // distinct from the provider-OAuth loopback (53691)
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function aresHome(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}
function remoteConfigPath(home?: string): string {
  return path.join(aresHome(home), "mcp-remote.json");
}
function tokenKey(name: string): string {
  return `mcp.token.${name}`;
}

/** A connector as stored on disk — no secret here, only where to reach it and
 *  how its bearer resolves. `oauth` = vault-held OAuth bundle (auto-refresh);
 *  `vault` = vault-held static token (pasted API key, no refresh). `authToken`
 *  is only the legacy manual-paste path and is discouraged — new pastes go
 *  through setMcpServerToken into the vault. */
export interface RemoteMcpEntry {
  url: string;
  oauth?: boolean;
  /** Static vault token connector (API key pasted by the owner). */
  vault?: boolean;
  authToken?: string;
  headers?: Record<string, string>;
  displayName?: string;
  connectedAt?: string;
  /** false = connected but paused: tokens stay in the vault, tools don't load.
   *  Absent means enabled (back-compat with pre-toggle entries). */
  enabled?: boolean;
}

/** The encrypted-at-rest OAuth bundle (JSON) kept in the vault per connector.
 *  A static (pasted) token is the same shape with no refresh material. */
interface McpTokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  /** RFC 7009 endpoint from discovery, so disconnect can revoke. */
  revocationEndpoint?: string;
  clientId: string;
  clientSecret?: string;
  /** How the client authenticates at the token endpoint (default: secret in the form, or none). */
  clientAuth?: ClientAuthMethod;
  resource: string;
  /** Scope string the issuer granted, for display. */
  scope?: string;
  /** The refresh token was rejected (invalid_grant): the owner must sign in again. */
  needsReauth?: boolean;
  /** Custom request headers swept out of the on-disk entry — headers routinely
   *  carry API keys (x-api-key et al.) and must live encrypted like tokens. */
  headers?: Record<string, string>;
}

export async function loadRemoteMcpServers(home?: string): Promise<Record<string, RemoteMcpEntry>> {
  try {
    const raw = await fs.readFile(remoteConfigPath(home), "utf8");
    const parsed = JSON.parse(raw) as { servers?: Record<string, RemoteMcpEntry> };
    const servers = parsed.servers ?? {};
    await sweepPlaintextSecrets(servers, home);
    return servers;
  } catch {
    return {};
  }
}

/**
 * One-way migration: legacy `authToken` and custom `headers` used to sit in
 * plaintext in ~/.ares/mcp-remote.json while everything else lived in the
 * AES-256-GCM vault. Sweep them into the connector's vault bundle and strip
 * them from disk. Vault write FIRST, strip second — a failed encryption leaves
 * the secret where it was rather than losing it. Idempotent: a clean file is
 * untouched.
 */
async function sweepPlaintextSecrets(servers: Record<string, RemoteMcpEntry>, home?: string): Promise<void> {
  let dirty = false;
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry.authToken && !entry.headers) continue;
    try {
      const raw = await getCredential(tokenKey(name), { home });
      let bundle: McpTokenBundle | null = null;
      if (raw) {
        try { bundle = JSON.parse(raw) as McpTokenBundle; } catch { bundle = null; }
      }
      bundle ??= { accessToken: "", tokenEndpoint: "", clientId: "", resource: entry.url };
      // The vault is the newer authority: an already-vaulted token or header
      // wins over the plaintext leftover it superseded.
      if (entry.authToken && !bundle.accessToken) bundle.accessToken = entry.authToken;
      if (entry.headers) bundle.headers = { ...entry.headers, ...(bundle.headers ?? {}) };
      await setCredential(tokenKey(name), JSON.stringify(bundle), { home });
      if (entry.authToken && !entry.oauth) entry.vault = true;
      delete entry.authToken;
      delete entry.headers;
      dirty = true;
    } catch {
      // Encryption unavailable or vault unwritable: leave this entry's
      // plaintext alone — worse than un-migrated is silently lost.
    }
  }
  if (dirty) await saveRemoteMcpServers(servers, home);
}

async function saveRemoteMcpServers(servers: Record<string, RemoteMcpEntry>, home?: string): Promise<void> {
  const dir = aresHome(home);
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
  await fs.writeFile(remoteConfigPath(home), JSON.stringify({ servers }, null, 2) + "\n", "utf8");
}

/** Pause/resume a connector without touching its vault tokens — the `/mcp`
 *  panel's toggle. Unknown names are a no-op (returns false). */
export async function setMcpServerEnabled(name: string, enabled: boolean, home?: string): Promise<boolean> {
  const servers = await loadRemoteMcpServers(home);
  const entry = servers[name];
  if (!entry) return false;
  entry.enabled = enabled;
  await saveRemoteMcpServers(servers, home);
  return true;
}

/** Derive a stable, human-ish connector name from a URL host when the caller
 *  doesn't supply one (e.g. "mcp.notion.com" → "notion"). */
export function connectorNameFromUrl(url: string): string {
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    const parts = host.split(".");
    // drop a leading "mcp"/"api" and the TLD → the brand in the middle.
    const meaningful = parts.filter((p) => p !== "mcp" && p !== "api" && p !== "server");
    return (meaningful[meaningful.length - 2] ?? meaningful[0] ?? host).toLowerCase();
  } catch {
    return "connector";
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Parse a Streamable-HTTP reply that may be plain JSON or a single-shot SSE. */
async function readJsonRpcBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {
        // keep scanning
      }
    }
    throw new Error("no JSON-RPC payload in SSE reply");
  }
  return JSON.parse(text);
}

export interface McpProbeResult {
  toolCount: number;
}

/**
 * Verify a bearer against a live MCP server: initialize, then tools/list, and
 * count. This is what makes "connected" mean something — a token the server
 * rejects fails HERE, at connect time, not on the agent's first tool call.
 */
export async function probeMcpTools(
  url: string,
  bearer: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<McpProbeResult> {
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
  if (bearer) baseHeaders.authorization = `Bearer ${bearer}`;
  const init = await fetchImpl(url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ares", version: "connect-verify" },
      },
    }),
  });
  if (init.status === 401 || init.status === 403) {
    throw new Error(`the server rejected the token (HTTP ${init.status})`);
  }
  if (!init.ok) throw new Error(`initialize failed (HTTP ${init.status})`);
  await readJsonRpcBody(init).catch(() => undefined); // some servers reply with an empty ack
  const session = init.headers.get("mcp-session-id");
  const listHeaders = session ? { ...baseHeaders, "mcp-session-id": session } : baseHeaders;
  const list = await fetchImpl(url, {
    method: "POST",
    headers: listHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  if (!list.ok) throw new Error(`tools/list failed (HTTP ${list.status})`);
  const body = (await readJsonRpcBody(list)) as { result?: { tools?: unknown[] }; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "tools/list returned an error");
  return { toolCount: body.result?.tools?.length ?? 0 };
}

export interface ConnectMcpOptions {
  name?: string;
  displayName?: string;
  home?: string;
  port?: number;
  timeoutMs?: number;
  /** The daemon opens this in the user's real browser (emits an oauth_url frame). */
  onAuthorizeUrl: (url: string) => void;
  /** Test seam for the verification probe's HTTP. */
  fetchImpl?: FetchLike;
}

export interface ConnectMcpResult {
  name: string;
  url: string;
  /** Populated by the post-connect tools/list probe (undefined when unverified). */
  toolCount?: number;
  /** True when the fresh token was proven against the server's tools/list. */
  verified: boolean;
  /** Why verification failed, when it did. Tokens are stored either way. */
  verifyError?: string;
}

/** Bind on the preferred port; a busy port falls back to an ephemeral one so
 *  two concurrent connects (or a squatter on 53682) can't kill the flow. */
function listenWithFallback(server: Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : preferred);
        });
        return;
      }
      reject(err);
    };
    server.once("error", onError);
    server.listen(preferred, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : preferred);
    });
  });
}

/** Run the full OAuth connect for a remote MCP server. Resolves once the user
 *  authorizes in their browser and tokens are stored; rejects on denial/timeout. */
/** Dynamic registrations are cached per registration endpoint so a reconnect
 *  reuses the client the issuer already knows instead of minting another. */
async function cachedClient(home: string | undefined, registrationEndpoint: string): Promise<{ clientId: string; clientSecret?: string } | null> {
  try {
    const raw = JSON.parse(await readFile(clientCachePath(home), "utf8")) as Record<string, { clientId?: string; clientSecret?: string }>;
    const hit = raw[registrationEndpoint];
    return hit && typeof hit.clientId === "string" ? { clientId: hit.clientId, ...(hit.clientSecret ? { clientSecret: hit.clientSecret } : {}) } : null;
  } catch {
    return null;
  }
}
async function rememberClient(home: string | undefined, registrationEndpoint: string, client: { clientId: string; clientSecret?: string }): Promise<void> {
  const file = clientCachePath(home);
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; } catch { raw = {}; }
  raw[registrationEndpoint] = { clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), at: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  await writeFile(file, JSON.stringify(raw, null, 2) + "\n", "utf8").catch(() => undefined);
}
function clientCachePath(home: string | undefined): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "mcp-clients.json");
}

export async function connectMcpServer(url: string, opts: ConnectMcpOptions): Promise<ConnectMcpResult> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const home = opts.home;

  // Discovery needs no port — do it before binding so a dead server fails fast.
  const authServer = await discoverMcpAuth(url);
  if (!authServer.registrationEndpoint) {
    // Some servers require a pre-registered client. Surface a clear next step
    // instead of failing deep in the flow.
    throw new Error(
      `${name} doesn't support automatic app registration. It may need a token you paste directly (use the token field), or a pre-registered client.`,
    );
  }

  // The callback context is populated AFTER the port is known (registration
  // needs the real redirect URI). Requests racing ahead of it get a 503.
  let ctx: {
    state: string;
    verifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
  } | null = null;

  const tokens = await new Promise<Awaited<ReturnType<typeof exchangeMcpCode>>>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    const cleanup = () => { try { server?.close(); } catch { /* closed */ } server = undefined; };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`connecting ${name} timed out — authorization wasn't completed`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    server = createServer(async (req, res) => {
      if (settled) { res.end(); return; }
      if (!ctx) { res.writeHead(503); res.end("Not ready"); return; }
      const u = new URL(req.url ?? "/", ctx.redirectUri);
      if (u.pathname !== "/oauth/callback") { res.writeHead(404); res.end("Not found"); return; }
      const code = u.searchParams.get("code");
      const returnedState = u.searchParams.get("state");
      const error = u.searchParams.get("error");
      if (error) {
        settled = true; clearTimeout(timer); res.writeHead(200, { "content-type": "text/html" });
        res.end(resultHtml(false, `Authorization was denied (${error}).`)); cleanup();
        reject(new Error(`authorization denied: ${error}`)); return;
      }
      if (!code || returnedState !== ctx.state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(resultHtml(false, "State mismatch or missing code.")); return;
      }
      try {
        const tok = await exchangeMcpCode({
          tokenEndpoint: authServer.tokenEndpoint,
          ...(authServer.revocationEndpoint ? { revocationEndpoint: authServer.revocationEndpoint } : {}),
          clientId: ctx.clientId,
          clientSecret: ctx.clientSecret,
          code,
          verifier: ctx.verifier,
          redirectUri: ctx.redirectUri,
          resource: authServer.resource,
        });
        settled = true; clearTimeout(timer); res.writeHead(200, { "content-type": "text/html" });
        res.end(resultHtml(true, `${name} is connected. Return to Ares.`)); cleanup();
        resolve(tok);
      } catch (err) {
        settled = true; clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200, { "content-type": "text/html" }); res.end(resultHtml(false, msg)); cleanup();
        reject(err instanceof Error ? err : new Error(msg));
      }
    });

    void (async () => {
      const port = await listenWithFallback(server!, opts.port ?? DEFAULT_PORT);
      const redirectUri = `http://localhost:${port}/oauth/callback`;
      // Reuse the client this issuer already knows for this redirect URI; the
      // port can differ between runs, and a fresh registration per attempt
      // litters the issuer with dead clients.
      const cacheKey = `${authServer.registrationEndpoint}|${redirectUri}`;
      const reg = (await cachedClient(home, cacheKey)) ?? (await (async () => {
        const fresh = await registerMcpClient(authServer.registrationEndpoint!, redirectUri);
        await rememberClient(home, cacheKey, fresh);
        return fresh;
      })());
      const pkce = generatePkce();
      const state = randomBytes(16).toString("hex");
      ctx = { state, verifier: pkce.verifier, redirectUri, clientId: reg.clientId, clientSecret: reg.clientSecret };
      opts.onAuthorizeUrl(
        buildMcpAuthorizeUrl({
          authorizationEndpoint: authServer.authorizationEndpoint,
          clientId: reg.clientId,
          redirectUri,
          challenge: pkce.challenge,
          state,
          scopes: authServer.scopesSupported,
          resource: authServer.resource,
        }),
      );
    })().catch(fail);
  });

  return persistMcpConnection({
    name,
    url,
    home,
    displayName: opts.displayName,
    authServer,
    tokens,
    client: { clientId: ctx!.clientId, ...(ctx!.clientSecret ? { clientSecret: ctx!.clientSecret } : {}) },
    fetchImpl: opts.fetchImpl,
  });
}

/** Store a freshly exchanged token bundle and the connector entry, then prove
 *  the token against tools/list. Shared by the loopback and public-redirect
 *  flows so both persist identically. */
async function persistMcpConnection(input: {
  name: string;
  url: string;
  home?: string;
  displayName?: string;
  authServer: Awaited<ReturnType<typeof discoverMcpAuth>>;
  tokens: Awaited<ReturnType<typeof exchangeMcpCode>>;
  client: { clientId: string; clientSecret?: string; authMethod?: ClientAuthMethod };
  fetchImpl?: FetchLike;
}): Promise<ConnectMcpResult> {
  const { name, url, home, authServer, tokens } = input;
  // Persist: encrypted token bundle in the vault, secret-free entry on disk.
  // A re-auth must not clobber the vaulted custom headers the owner configured.
  const priorHeaders = await vaultedHeaders(name, home);
  const bundle: McpTokenBundle = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    tokenEndpoint: authServer.tokenEndpoint,
    ...(authServer.revocationEndpoint ? { revocationEndpoint: authServer.revocationEndpoint } : {}),
    clientId: input.client.clientId,
    clientSecret: input.client.clientSecret,
    ...(input.client.authMethod ? { clientAuth: input.client.authMethod } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    resource: authServer.resource,
    ...(priorHeaders ? { headers: priorHeaders } : {}),
  };
  await setCredential(tokenKey(name), JSON.stringify(bundle), { home });
  const servers = await loadRemoteMcpServers(home);
  // A RE-connect must not wipe what the owner configured: the pause state,
  // custom headers, and display name all survive re-auth.
  const prev = servers[name];
  servers[name] = {
    ...prev,
    url,
    oauth: true,
    vault: undefined,
    authToken: undefined,
    displayName: input.displayName ?? prev?.displayName ?? name,
    connectedAt: new Date().toISOString(),
  };
  await saveRemoteMcpServers(servers, home);

  // Post-connect verification: prove the token against tools/list. Failure does
  // NOT roll back the stored tokens (the server may be briefly unhappy) — it is
  // surfaced so the UI says "connected but unverified" instead of lying.
  try {
    const probe = await probeMcpTools(url, tokens.accessToken, input.fetchImpl);
    return { name, url, toolCount: probe.toolCount, verified: true };
  } catch (err) {
    return { name, url, verified: false, verifyError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The same OAuth connect, split in two for a caller that owns its own public
 * redirect (the garrison, reached from a phone — where a loopback callback on
 * the box is unreachable). `begin` discovers, registers a client for
 * `redirectUri` (cached per issuer + URI), and returns the URL to open; the
 * caller routes the provider's redirect back to `finish(code)`.
 */
export async function beginMcpConnect(
  url: string,
  opts: { redirectUri: string; state: string; name?: string; displayName?: string; home?: string; fetchImpl?: FetchLike },
): Promise<{ name: string; authorizeUrl: string; finish: (code: string) => Promise<ConnectMcpResult> }> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const home = opts.home;
  const authServer = await discoverMcpAuth(url);
  if (!authServer.registrationEndpoint) {
    throw new Error(`${name} doesn't support automatic app registration — it needs an API key or a pre-registered client`);
  }
  const cacheKey = `${authServer.registrationEndpoint}|${opts.redirectUri}`;
  const reg = (await cachedClient(home, cacheKey)) ?? (await (async () => {
    const fresh = await registerMcpClient(authServer.registrationEndpoint!, opts.redirectUri);
    await rememberClient(home, cacheKey, fresh);
    return fresh;
  })());
  const pkce = generatePkce();
  const authorizeUrl = buildMcpAuthorizeUrl({
    authorizationEndpoint: authServer.authorizationEndpoint,
    clientId: reg.clientId,
    redirectUri: opts.redirectUri,
    challenge: pkce.challenge,
    state: opts.state,
    scopes: authServer.scopesSupported,
    resource: authServer.resource,
  });
  const finish = async (code: string): Promise<ConnectMcpResult> => {
    const tokens = await exchangeMcpCode({
      tokenEndpoint: authServer.tokenEndpoint,
      ...(authServer.revocationEndpoint ? { revocationEndpoint: authServer.revocationEndpoint } : {}),
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      code,
      verifier: pkce.verifier,
      redirectUri: opts.redirectUri,
      resource: authServer.resource,
    });
    return persistMcpConnection({
      name,
      url,
      home,
      displayName: opts.displayName,
      authServer,
      tokens,
      client: { clientId: reg.clientId, ...(reg.clientSecret ? { clientSecret: reg.clientSecret } : {}) },
      fetchImpl: opts.fetchImpl,
    });
  };
  return { name, authorizeUrl, finish };
}

// ─── The engine-driven connect (what the garrison's hub calls) ───────────────

export interface McpAuthPlanOptions {
  name?: string;
  displayName?: string;
  home?: string;
  /** Where the issuer sends the browser back: the garrison's /oauth/callback. */
  redirectUri: string;
  /** https://<origin>/oauth/client.json: lets servers that support Client ID
   *  Metadata Documents (and refuse DCR for our redirect) accept Ares. */
  clientMetadataUrl?: string;
  /** A client from the registry (owner-registered or Ares's official one). */
  client?: { clientId: string; clientSecret?: string; authMethod?: ClientAuthMethod };
  /** Scopes Ares needs (the matrix); default: what the resource/issuer advertises. */
  scopes?: string[];
  /** Use the device flow when a client is given and the issuer offers one. */
  preferDevice?: boolean;
  /** When DCR refuses the redirect (allowlists), retry with this loopback
   *  redirect: the phone app intercepts it (POST /gateway/connections/complete). */
  loopbackRedirectUri?: string;
  /** Test seam for the post-connect tools/list probe. */
  fetchImpl?: FetchLike;
  /** Test seam for discovery / registration / token HTTP. */
  engineFetch?: typeof fetch;
  /** Test seam: the wait between device polls. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type McpAuthPrepared =
  | {
      mode: "code";
      name: string;
      authorizeUrl: string;
      redirectUri: string;
      /** How the client id was obtained: dcr | cimd | client (registry). */
      registration: "dcr" | "cimd" | "client";
      /** True when the loopback redirect was used (the app must intercept it). */
      viaLoopback: boolean;
      issuer?: string;
      pending: PendingAuthorization;
      finish: (params: CallbackParams) => Promise<ConnectMcpResult>;
    }
  | {
      mode: "device";
      name: string;
      device: DeviceAuthorization;
      /** Polls the issuer until the owner approves; resolves once connected. */
      poll: (signal?: AbortSignal) => Promise<ConnectMcpResult>;
    }
  | {
      /** No client could be had automatically: the owner registers one once. */
      mode: "setup";
      name: string;
      reason: string;
      authServer: McpAuthServer;
    };

function looksLikeRedirectRefusal(err: unknown): boolean {
  return err instanceof OAuthError && (err.code === "invalid_redirect_uri" || /redirect/i.test(err.message));
}

const REFUSED = "this server only accepts clients it has approved, and it refused Ares's redirect";

/**
 * Discover, obtain a client, and prepare either an authorization-code URL or a
 * device code for a remote MCP server. The client comes from, in order: the
 * registry (a given client), dynamic registration (RFC 7591), a Client ID
 * Metadata Document, a loopback-redirect registration (allowlisting issuers),
 * and otherwise `setup` - never a pasted token. Tokens persist only in the
 * encrypted vault, exactly like every other connect path.
 */
export async function prepareMcpAuthorization(url: string, opts: McpAuthPlanOptions): Promise<McpAuthPrepared> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const home = opts.home;
  const deps = opts.engineFetch ? { fetchImpl: opts.engineFetch } : {};
  const authServer = await discoverMcpAuth(url, deps);

  let client = opts.client;
  let registration: "dcr" | "cimd" | "client" = "client";
  let redirectUri = opts.redirectUri;
  let viaLoopback = false;

  /** Register (or reuse the cached registration) for one redirect URI. */
  const register = async (uri: string) => {
    const cacheKey = `${authServer.registrationEndpoint}|${uri}`;
    const cached = await cachedClient(home, cacheKey);
    if (cached) return cached;
    const fresh = await registerOAuthClient(authServer.registrationEndpoint!, { redirectUris: [uri], clientName: "Ares" }, deps);
    await rememberClient(home, cacheKey, fresh);
    return fresh;
  };
  const useCimd = (): boolean => {
    if (!authServer.clientIdMetadataDocumentSupported || !opts.clientMetadataUrl) return false;
    client = { clientId: opts.clientMetadataUrl, authMethod: "none" };
    registration = "cimd";
    return true;
  };

  if (!client) {
    if (authServer.registrationEndpoint) {
      try {
        const reg = await register(redirectUri);
        client = { clientId: reg.clientId, ...(reg.clientSecret ? { clientSecret: reg.clientSecret } : {}) };
        registration = "dcr";
      } catch (err) {
        if (!looksLikeRedirectRefusal(err)) throw err;
        if (!useCimd()) {
          if (!opts.loopbackRedirectUri) return { mode: "setup", name, authServer, reason: REFUSED };
          try {
            const reg = await register(opts.loopbackRedirectUri);
            client = { clientId: reg.clientId, ...(reg.clientSecret ? { clientSecret: reg.clientSecret } : {}) };
            registration = "dcr";
            redirectUri = opts.loopbackRedirectUri;
            viaLoopback = true;
          } catch (loopErr) {
            if (!looksLikeRedirectRefusal(loopErr)) throw loopErr;
            return { mode: "setup", name, authServer, reason: REFUSED };
          }
        }
      }
    } else if (!useCimd()) {
      return { mode: "setup", name, authServer, reason: "this server has no automatic client registration" };
    }
  }

  const useClient = client!;
  // A registry client with a secret authenticates the way the issuer says it accepts.
  if (useClient.clientSecret && !useClient.authMethod) {
    const methods = authServer.tokenEndpointAuthMethodsSupported;
    if (methods?.length && !methods.includes("client_secret_post") && methods.includes("client_secret_basic")) useClient.authMethod = "client_secret_basic";
  }
  const scopes = opts.scopes?.length ? opts.scopes : authServer.resourceScopes?.length ? authServer.resourceScopes : authServer.scopesSupported;
  const persist = (tokens: Awaited<ReturnType<typeof exchangeMcpCode>>) =>
    persistMcpConnection({ name, url, home, displayName: opts.displayName, authServer, tokens, client: useClient, fetchImpl: opts.fetchImpl });

  if (opts.preferDevice && opts.client && authServer.deviceAuthorizationEndpoint) {
    const device = await requestDeviceAuthorization({ endpoint: authServer.deviceAuthorizationEndpoint, client: useClient, ...(scopes?.length ? { scopes } : {}) }, deps);
    return {
      mode: "device",
      name,
      device,
      poll: async (signal) =>
        persist(await pollDeviceAuthorization({ tokenEndpoint: authServer.tokenEndpoint, client: useClient, device, ...(signal ? { signal } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) }, deps)),
    };
  }

  const { authorizeUrl, pending } = beginAuthorization({
    authorizationEndpoint: authServer.authorizationEndpoint,
    tokenEndpoint: authServer.tokenEndpoint,
    client: useClient,
    redirectUri,
    ...(scopes?.length ? { scopes } : {}),
    resource: authServer.resource,
    ...(authServer.issuer ? { issuer: authServer.issuer } : {}),
  });
  return {
    mode: "code",
    name,
    authorizeUrl,
    redirectUri,
    registration,
    viaLoopback,
    ...(authServer.issuer ? { issuer: authServer.issuer } : {}),
    pending,
    finish: async (params) => persist(await completeAuthorization(pending, params, deps)),
  };
}

export interface SetMcpTokenResult {
  name: string;
  url: string;
  toolCount?: number;
  verified: boolean;
  verifyError?: string;
}

/**
 * Connect a server with a PASTED token (API-key connectors — the registry rows
 * flagged needsKey, and servers without dynamic registration). The token goes
 * into the encrypted vault as a static bundle — NEVER plaintext on disk — and
 * is verified against tools/list before we call it connected.
 */
export async function setMcpServerToken(
  url: string,
  token: string,
  opts: { name?: string; displayName?: string; home?: string; fetchImpl?: FetchLike; header?: string } = {},
): Promise<SetMcpTokenResult> {
  const name = (opts.name ?? connectorNameFromUrl(url)).trim();
  const trimmed = token.trim();
  if (!trimmed) throw new Error("a connector token can't be empty");
  const priorHeaders = await vaultedHeaders(name, opts.home);
  // Some servers take the key in a named header (x-api-key …) rather than as
  // a bearer; the header name comes from the catalog or the registry entry.
  const header = opts.header?.trim() && !/^authorization$/i.test(opts.header.trim()) ? opts.header.trim() : "";
  const bundle: McpTokenBundle = {
    accessToken: header ? "" : trimmed,
    tokenEndpoint: "",
    clientId: "",
    resource: url,
    ...(priorHeaders || header ? { headers: { ...(priorHeaders ?? {}), ...(header ? { [header]: trimmed } : {}) } } : {}),
  };
  await setCredential(tokenKey(name), JSON.stringify(bundle), { home: opts.home });
  const servers = await loadRemoteMcpServers(opts.home);
  const prev = servers[name];
  servers[name] = {
    ...prev,
    url,
    oauth: undefined,
    vault: true,
    authToken: undefined,
    displayName: opts.displayName ?? prev?.displayName ?? name,
    connectedAt: new Date().toISOString(),
  };
  await saveRemoteMcpServers(servers, opts.home);
  try {
    const probe = await probeMcpTools(url, trimmed, opts.fetchImpl);
    return { name, url, toolCount: probe.toolCount, verified: true };
  } catch (err) {
    return { name, url, verified: false, verifyError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register a remote MCP server that needs NO credential (it answered an
 * unauthenticated initialize + tools/list). Stores only the secret-free entry;
 * there is no vault bundle. Refuses to overwrite an existing entry — the
 * caller decides names, and a custom connector must never clobber a real one.
 */
export async function addOpenMcpServer(
  name: string,
  url: string,
  opts: { displayName?: string; home?: string } = {},
): Promise<boolean> {
  const servers = await loadRemoteMcpServers(opts.home);
  if (servers[name]) return false;
  servers[name] = {
    url,
    displayName: opts.displayName ?? name,
    connectedAt: new Date().toISOString(),
  };
  await saveRemoteMcpServers(servers, opts.home);
  return true;
}

/** Remove a connector: delete its on-disk entry and its vault token. */
export async function disconnectMcpServer(name: string, home?: string): Promise<boolean> {
  const servers = await loadRemoteMcpServers(home);
  if (!servers[name]) return false;
  // Revoke at the issuer first (best effort), then forget locally.
  try {
    const raw = await getCredential(tokenKey(name), { home });
    if (raw) {
      const bundle = JSON.parse(raw) as McpTokenBundle;
      if (bundle.revocationEndpoint && bundle.accessToken && bundle.clientId) {
        // The refresh token is the long-lived one; revoking it kills the grant.
        await revokeMcpToken(bundle.revocationEndpoint, bundle.refreshToken ?? bundle.accessToken, bundle.clientId, {
          ...(bundle.clientSecret ? { clientSecret: bundle.clientSecret } : {}),
          hint: bundle.refreshToken ? "refresh_token" : "access_token",
        });
      }
    }
  } catch {
    // never let a revocation hiccup block the disconnect
  }
  delete servers[name];
  await saveRemoteMcpServers(servers, home);
  await deleteCredential(tokenKey(name), { home }).catch(() => undefined);
  return true;
}

/** Return a VALID access token for a connected server, refreshing transparently
 *  when the stored one is near expiry. Used by the tools layer at call-time so a
 *  live token never has to sit in the on-disk config. Returns null when the
 *  connector isn't vault-connected (the caller falls back to authToken). */
export async function getMcpAccessToken(name: string, home?: string, now: () => number = Date.now): Promise<string | null> {
  const raw = await getCredential(tokenKey(name), { home });
  if (!raw) return null;
  let bundle: McpTokenBundle;
  try { bundle = JSON.parse(raw) as McpTokenBundle; } catch { return null; }
  const skewMs = 60_000;
  const fresh = bundle.expiresAt == null || bundle.expiresAt - now() > skewMs;
  if (fresh) return bundle.accessToken;
  if (!bundle.refreshToken) return bundle.accessToken; // can't refresh; try it anyway
  // Single-flight: a rotating refresh token is burnt by its first use, so two
  // tool calls racing past expiry must share ONE refresh request.
  return singleFlight(`mcp|${home ?? ""}|${name}`, async () => {
    const latestRaw = await getCredential(tokenKey(name), { home });
    let current = bundle;
    if (latestRaw) { try { current = JSON.parse(latestRaw) as McpTokenBundle; } catch { current = bundle; } }
    if (current.expiresAt == null || current.expiresAt - now() > skewMs) return current.accessToken; // someone else refreshed
    if (!current.refreshToken) return current.accessToken;
    try {
      const next = await refreshOAuthToken({
        tokenEndpoint: current.tokenEndpoint,
        client: { clientId: current.clientId, ...(current.clientSecret ? { clientSecret: current.clientSecret } : {}), ...(current.clientAuth ? { authMethod: current.clientAuth } : {}) },
        refreshToken: current.refreshToken,
        resource: current.resource,
        prev: { refreshToken: current.refreshToken, ...(current.scope ? { scope: current.scope } : {}) },
      }, { now });
      const updated: McpTokenBundle = { ...current, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt, ...(next.scope ? { scope: next.scope } : {}) };
      delete updated.needsReauth;
      await setCredential(tokenKey(name), JSON.stringify(updated), { home });
      return next.accessToken;
    } catch (err) {
      // The vendor says the grant is dead: remember it so the list reads "expired"
      // (and the owner is asked to sign in again) instead of retrying forever.
      if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "invalid_client")) {
        await setCredential(tokenKey(name), JSON.stringify({ ...current, needsReauth: true }), { home }).catch(() => undefined);
      }
      return current.accessToken; // refresh failed; hand back the stale token so the call can surface a clean 401
    }
  });
}

/** The vault bundle's custom headers for a connector, if any. */
async function vaultedHeaders(name: string, home?: string): Promise<Record<string, string> | undefined> {
  try {
    const raw = await getCredential(tokenKey(name), { home });
    if (!raw) return undefined;
    return (JSON.parse(raw) as McpTokenBundle).headers;
  } catch {
    return undefined;
  }
}

/**
 * Everything the tools layer needs to authenticate one MCP call: a fresh
 * bearer (transparently refreshed, same path as getMcpAccessToken) plus the
 * vault-held custom headers the on-disk entry no longer carries.
 */
export async function getMcpCallCredentials(
  name: string,
  home?: string,
  now: () => number = Date.now,
): Promise<{ bearer: string | null; headers: Record<string, string> }> {
  const raw = await getCredential(tokenKey(name), { home });
  if (!raw) return { bearer: null, headers: {} };
  let bundle: McpTokenBundle;
  try {
    bundle = JSON.parse(raw) as McpTokenBundle;
  } catch {
    return { bearer: null, headers: {} };
  }
  const bearer = await getMcpAccessToken(name, home, now);
  return { bearer: bearer || (bundle.accessToken || null), headers: bundle.headers ?? {} };
}

function resultHtml(ok: boolean, msg: string): string {
  const color = ok ? "#4ade80" : "#f87171";
  const title = ok ? "Connected" : "Connection failed";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:${color};margin:0 0 .5rem}p{margin:0;opacity:.75}</style></head>
<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}
