// MCP OAuth — the generic handshake that lets Ares connect to ANY spec-compliant
// remote MCP server (a Slack/Notion/Vercel-style connector) with no per-server
// setup. It implements the MCP Authorization flow end to end:
//
//   1. Discover the authorization server from the MCP URL
//      (RFC 9728 protected-resource metadata → RFC 8414 auth-server metadata).
//   2. Dynamic Client Registration (RFC 7591) so we never pre-register an app.
//   3. Authorization Code + PKCE (RFC 7636) — the loopback callback (reused from
//      oauthCallback) catches the redirect; we exchange the code for tokens.
//
// Everything here is pure/injectable (fetchImpl) so the protocol logic is unit
// tested without a live server. Token storage/refresh reuses oauth.ts.

import { createHash, randomBytes } from "node:crypto";

export interface McpAuthServer {
  /** RFC 8414 authorization_endpoint. */
  authorizationEndpoint: string;
  /** RFC 8414 token_endpoint. */
  tokenEndpoint: string;
  /** RFC 7591 registration_endpoint, when the server supports DCR. */
  registrationEndpoint?: string;
  /** Scopes the server advertises (may be empty). */
  scopesSupported?: string[];
  /** The protected resource identifier to bind tokens to (RFC 8707). */
  resource: string;
}

export interface McpOAuthDeps {
  fetchImpl?: typeof fetch;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair — S256. Pass an explicit verifier in tests for determinism. */
export function generatePkce(verifier?: string): { verifier: string; challenge: string; method: "S256" } {
  const v = verifier ?? base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(v).digest());
  return { verifier: v, challenge, method: "S256" };
}

function originOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | null> {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Discover the authorization server for an MCP endpoint. Follows the RFC 9728
 *  protected-resource metadata to the RFC 8414 auth-server metadata. Falls back
 *  to the well-known paths at the MCP origin when the server doesn't advertise a
 *  separate resource metadata document. Throws a readable error if nothing is
 *  discoverable (the server likely isn't an OAuth-protected MCP server). */
export async function discoverMcpAuth(mcpUrl: string, deps: McpOAuthDeps = {}): Promise<McpAuthServer> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const origin = originOf(mcpUrl);

  // 1. Protected-resource metadata (RFC 9728). Optional — many servers skip it.
  const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`, fetchImpl);
  const authServers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as string[]) : [];
  const resource = typeof prm?.resource === "string" ? (prm!.resource as string) : origin;

  // 2. Authorization-server metadata (RFC 8414). Try each advertised server,
  //    then the MCP origin itself (common for single-tenant servers).
  const candidates = [...authServers, origin];
  for (const asBase of candidates) {
    const asOrigin = originOf(asBase);
    const meta =
      (await fetchJson(`${asOrigin}/.well-known/oauth-authorization-server`, fetchImpl)) ??
      (await fetchJson(`${asOrigin}/.well-known/openid-configuration`, fetchImpl));
    const authorizationEndpoint = typeof meta?.authorization_endpoint === "string" ? meta.authorization_endpoint : "";
    const tokenEndpoint = typeof meta?.token_endpoint === "string" ? meta.token_endpoint : "";
    if (authorizationEndpoint && tokenEndpoint) {
      return {
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: typeof meta?.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
        scopesSupported: Array.isArray(meta?.scopes_supported) ? (meta!.scopes_supported as string[]) : undefined,
        resource,
      };
    }
  }
  throw new Error(
    `No OAuth metadata found for ${mcpUrl}. It may not be an OAuth-protected MCP server, or it uses a token you can paste directly.`,
  );
}

export interface McpClientRegistration {
  clientId: string;
  clientSecret?: string;
}

/** Dynamic Client Registration (RFC 7591). Registers Ares as a public client
 *  using PKCE (no client secret) with the loopback redirect. Returns the issued
 *  client_id. Throws with the server's error body when registration is refused. */
export async function registerMcpClient(
  registrationEndpoint: string,
  redirectUri: string,
  deps: McpOAuthDeps = {},
): Promise<McpClientRegistration> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Ares",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  }).catch(() => null);
  if (!res) throw new Error(`couldn't reach the registration endpoint at ${registrationEndpoint}`);
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error_description?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(`dynamic client registration failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** Build the authorize URL for the PKCE auth-code flow, binding the token to the
 *  MCP resource (RFC 8707) so the issued token is accepted by that server. */
export function buildMcpAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scopes?: string[];
  resource: string;
}): string {
  const u = new URL(input.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("code_challenge", input.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", input.state);
  u.searchParams.set("resource", input.resource);
  if (input.scopes && input.scopes.length) u.searchParams.set("scope", input.scopes.join(" "));
  return u.toString();
}

export interface McpTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

/** Exchange an authorization code (with the PKCE verifier) for tokens at the
 *  server's token endpoint. `now` is injectable for deterministic expiry tests. */
export async function exchangeMcpCode(
  input: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    verifier: string;
    redirectUri: string;
    resource: string;
  },
  deps: McpOAuthDeps & { now?: () => number } = {},
): Promise<McpTokenResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
    resource: input.resource,
  });
  if (input.clientSecret) form.set("client_secret", input.clientSecret);
  const res = await fetchImpl(input.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  }).catch(() => null);
  if (!res) throw new Error("couldn't reach the token endpoint");
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`token exchange failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: typeof body.expires_in === "number" ? now() + body.expires_in * 1000 : undefined,
    scope: body.scope,
    tokenType: body.token_type,
  };
}
