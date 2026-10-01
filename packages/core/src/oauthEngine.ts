// The generic OAuth 2.x engine — one implementation behind every connector.
//
// What it speaks (all pure + injectable: `fetchImpl`, `now`, `sleep`):
//   - authorization code + PKCE (RFC 6749 / 7636, S256 only), `state` binding,
//     RFC 9207 `iss` mix-up defence, RFC 8707 `resource`
//   - dynamic client registration (RFC 7591), with a typed refusal when the
//     issuer allowlists redirect URIs (Vercel does)
//   - discovery: RFC 8414 / OIDC / RFC 9728 (protected-resource metadata)
//   - device authorization grant (RFC 8628) incl. slow_down / expiry
//   - refresh with rotation and SINGLE-FLIGHT (a rotating refresh token burns
//     if two callers race, so concurrent callers share one request)
//   - revocation (RFC 7009)
//
// What it never does: log, throw or return a token, a code, a secret or a
// verifier inside an error message. Tokens persist ONLY through the credential
// vault (credentials.ts, AES-256-GCM at rest); callers hand them to nothing else.
// Endpoints must be https (http only on loopback) so a credential never rides
// a plaintext link.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface OAuthClientCreds {
  clientId: string;
  clientSecret?: string;
  /** Default: client_secret_post when a secret is held, else none (public client). */
  authMethod?: ClientAuthMethod;
}

export interface AuthServerMetadata {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  scopesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  issParameterSupported?: boolean;
  /** The issuer fetches an https client_id as a Client ID Metadata Document (no registration needed). */
  clientIdMetadataDocumentSupported?: boolean;
}

export interface EngineDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per-request budget; default 15 s. */
  timeoutMs?: number;
}

/** Wire quirks a provider needs; every field is optional (RFC defaults apply). */
export interface TokenQuirks {
  /** `form` (RFC 6749) or `json` (Notion). */
  tokenBody?: "form" | "json";
  /** Extra form fields on every token call (Withings: action=requesttoken). */
  extraTokenParams?: Record<string, string>;
  /** Turn an enveloped / non-standard token response into the RFC shape. */
  unwrapTokenResponse?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** Extra headers on token calls (Reddit wants a User-Agent). */
  tokenHeaders?: Record<string, string>;
  /** Response fields to keep beside the token (Salesforce's instance_url). Strings only. */
  keepTokenFields?: string[];
}

export class OAuthError extends Error {
  constructor(
    /** RFC 6749 error code from the server, or a local one: network | protocol |
     *  state_mismatch | issuer_mismatch | replay | insecure_endpoint | timeout. */
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const GRANT_DEVICE = "urn:ietf:params:oauth:grant-type:device_code";

export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair (S256). Pass a verifier in tests for determinism. */
export function newPkce(verifier?: string): { verifier: string; challenge: string; method: "S256" } {
  const v = verifier ?? base64url(randomBytes(48));
  return { verifier: v, challenge: base64url(createHash("sha256").update(v).digest()), method: "S256" };
}

export function newState(): string {
  return randomBytes(32).toString("hex");
}

/** Constant-time string compare (the `state` check). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A credential must never ride a plaintext link: https, or http on loopback. */
export function assertSecureEndpoint(url: string, what = "endpoint"): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new OAuthError("protocol", `${what} is not a valid URL`);
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return;
  throw new OAuthError("insecure_endpoint", `${what} must be https (got ${u.protocol}//${u.hostname})`);
}

/** Strip anything token-shaped from provider-supplied text before it can be shown. */
export function scrubOAuthText(text: string, max = 200): string {
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted]")
    .replace(/[?&](?:access_token|refresh_token|code|client_secret|code_verifier|device_code)=[^&\s"']+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function signalFor(deps: EngineDeps): AbortSignal {
  return AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  // Test doubles sometimes implement only json(); real responses have text().
  if (typeof res.text !== "function") {
    const parsed = (await (res as unknown as { json?: () => Promise<unknown> }).json?.().catch(() => null)) ?? null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }
  const text = await res.text().catch(() => "");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // GitHub answers form-encoded unless asked for JSON; keep tolerant.
    if (/^[\w.%+-]+=/.test(text)) return Object.fromEntries(new URLSearchParams(text));
    return {};
  }
}

function applyClientAuth(form: URLSearchParams, headers: Record<string, string>, client: OAuthClientCreds): void {
  const method: ClientAuthMethod = client.authMethod ?? (client.clientSecret ? "client_secret_post" : "none");
  if (method === "client_secret_basic" && client.clientSecret) {
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(`${enc(client.clientId)}:${enc(client.clientSecret)}`).toString("base64")}`;
    return;
  }
  form.set("client_id", client.clientId);
  if (method === "client_secret_post" && client.clientSecret) form.set("client_secret", client.clientSecret);
}

function oauthErrorFrom(body: Record<string, unknown>, status: number): OAuthError {
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  const description = typeof body.error_description === "string" ? body.error_description : typeof body.message === "string" ? body.message : "";
  return new OAuthError(code, scrubOAuthText(description ? `${code}: ${description}` : code), status);
}

// ─── token endpoint ──────────────────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; undefined = non-expiring / unknown. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  /** The server issued a NEW refresh token (rotation). */
  rotated?: boolean;
  /** `keepTokenFields` pulled from the response (never secrets by contract). */
  extra?: Record<string, string>;
}

export function parseTokenSet(json: Record<string, unknown>, now: number, prev?: { refreshToken?: string; scope?: string; expiresAt?: number }, keep?: string[]): TokenSet {
  const access = typeof json.access_token === "string" ? json.access_token : "";
  if (!access) throw new OAuthError("protocol", "the token response held no access_token");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
  const fresh = typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : undefined;
  return {
    accessToken: access,
    refreshToken: fresh ?? prev?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : prev?.expiresAt,
    scope: typeof json.scope === "string" ? json.scope : prev?.scope,
    tokenType: typeof json.token_type === "string" ? json.token_type : undefined,
    ...(fresh && prev?.refreshToken && fresh !== prev.refreshToken ? { rotated: true } : {}),
    ...(keep?.length ? (() => {
      const extra = Object.fromEntries(keep.filter((k) => typeof json[k] === "string").map((k) => [k, json[k] as string]));
      return Object.keys(extra).length ? { extra } : {};
    })() : {}),
  };
}

export async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  client: OAuthClientCreds,
  deps: EngineDeps = {},
  quirks: TokenQuirks = {},
): Promise<Record<string, unknown>> {
  assertSecureEndpoint(endpoint, "token endpoint");
  const doFetch = deps.fetchImpl ?? fetch;
  const form = new URLSearchParams({ ...(quirks.extraTokenParams ?? {}), ...params });
  const headers: Record<string, string> = { accept: "application/json", ...(quirks.tokenHeaders ?? {}) };
  applyClientAuth(form, headers, client);
  let body: string;
  if (quirks.tokenBody === "json") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(Object.fromEntries(form));
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = form.toString();
  }
  let res: Response;
  try {
    res = await doFetch(endpoint, { method: "POST", headers, body, signal: signalFor(deps), redirect: "manual" });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new OAuthError(timedOut ? "timeout" : "network", timedOut ? "the token endpoint timed out" : "couldn't reach the token endpoint");
  }
  let json = await readBody(res);
  if (quirks.unwrapTokenResponse) {
    try {
      json = quirks.unwrapTokenResponse(json);
    } catch (err) {
      throw new OAuthError("invalid_request", scrubOAuthText(err instanceof Error ? err.message : String(err)), res.status);
    }
  }
  // An in-band error (GitHub, Slack answer 200 + {error}) is still an error.
  if (!res.ok || (typeof json.error === "string" && !json.access_token)) throw oauthErrorFrom(json, res.status);
  return json;
}

// ─── discovery ───────────────────────────────────────────────────────────────

const strs = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** Parse an RFC 8414 / OIDC discovery document (pure: also used on saved fixtures). */
export function parseAuthServerMetadata(json: Record<string, unknown> | null | undefined): AuthServerMetadata | null {
  if (!json || typeof json !== "object") return null;
  const token = typeof json.token_endpoint === "string" ? json.token_endpoint : "";
  const authz = typeof json.authorization_endpoint === "string" ? json.authorization_endpoint : undefined;
  const device = typeof json.device_authorization_endpoint === "string" ? json.device_authorization_endpoint : undefined;
  if (!token || (!authz && !device)) return null;
  return {
    ...(typeof json.issuer === "string" ? { issuer: json.issuer } : {}),
    ...(authz ? { authorizationEndpoint: authz } : {}),
    tokenEndpoint: token,
    ...(typeof json.registration_endpoint === "string" ? { registrationEndpoint: json.registration_endpoint } : {}),
    ...(device ? { deviceAuthorizationEndpoint: device } : {}),
    ...(typeof json.revocation_endpoint === "string" ? { revocationEndpoint: json.revocation_endpoint } : {}),
    ...(typeof json.userinfo_endpoint === "string" ? { userinfoEndpoint: json.userinfo_endpoint } : {}),
    ...(strs(json.scopes_supported) ? { scopesSupported: strs(json.scopes_supported)! } : {}),
    ...(strs(json.grant_types_supported) ? { grantTypesSupported: strs(json.grant_types_supported)! } : {}),
    ...(strs(json.token_endpoint_auth_methods_supported) ? { tokenEndpointAuthMethodsSupported: strs(json.token_endpoint_auth_methods_supported)! } : {}),
    ...(strs(json.code_challenge_methods_supported) ? { codeChallengeMethodsSupported: strs(json.code_challenge_methods_supported)! } : {}),
    ...(json.authorization_response_iss_parameter_supported === true ? { issParameterSupported: true } : {}),
    ...(json.client_id_metadata_document_supported === true ? { clientIdMetadataDocumentSupported: true } : {}),
  };
}

// ─── client ID metadata documents (CIMD) ─────────────────────────────────────

/** Where the garrison serves its client metadata document. */
export const CLIENT_METADATA_PATH = "/oauth/client.json";

export function clientMetadataUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${CLIENT_METADATA_PATH}`;
}

/**
 * The document an issuer fetches when Ares presents an https URL as its
 * `client_id` (draft-ietf-oauth-client-id-metadata-document, adopted by the MCP
 * authorization spec). It makes servers that support it but offer no dynamic
 * registration (MongoDB) zero-setup, and it is public by design: it names the
 * client and the one redirect it may use, nothing else.
 */
export function clientMetadataDocument(origin: string, redirectUris: string[]): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    client_id: clientMetadataUrl(base),
    client_name: "Ares",
    client_uri: base,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Does the discovery document say the server takes a device authorization grant? */
export function supportsDeviceGrant(meta: AuthServerMetadata): boolean {
  return Boolean(meta.deviceAuthorizationEndpoint) || (meta.grantTypesSupported ?? []).includes(GRANT_DEVICE);
}

function wellKnownUrls(base: string, kind: string): string[] {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return [];
  }
  const p = u.pathname.replace(/\/+$/, "");
  return [...(p && p !== "/" ? [`${u.origin}/.well-known/${kind}${p}`] : []), `${u.origin}/.well-known/${kind}`];
}

/** Fetch the authorization-server metadata for an issuer (RFC 8414, then OIDC). */
export async function discoverIssuer(issuer: string, deps: EngineDeps = {}): Promise<AuthServerMetadata | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const urls = [
    ...wellKnownUrls(issuer, "oauth-authorization-server"),
    ...wellKnownUrls(issuer, "openid-configuration"),
    `${new URL(issuer).origin}/.well-known/openid-configuration`,
  ];
  for (const url of urls) {
    try {
      assertSecureEndpoint(url, "discovery URL");
      const res = await doFetch(url, { headers: { accept: "application/json" }, signal: signalFor(deps) });
      if (!res.ok) continue;
      const parsed = parseAuthServerMetadata((await res.json().catch(() => null)) as Record<string, unknown> | null);
      if (parsed) return parsed;
    } catch {
      // try the next well-known location
    }
  }
  return null;
}

// ─── dynamic client registration ─────────────────────────────────────────────

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  authMethod: ClientAuthMethod;
}

/**
 * RFC 7591. Registers Ares as a public client (PKCE, no secret). An issuer
 * that allowlists redirect URIs answers `invalid_redirect_uri`, surfaced as an
 * OAuthError with that code so the caller can try a loopback redirect or
 * explain the limit — never silently fall back to a pasted token.
 */
export async function registerOAuthClient(
  registrationEndpoint: string,
  input: { redirectUris: string[]; clientName?: string; grantTypes?: string[]; scope?: string },
  deps: EngineDeps = {},
): Promise<RegisteredClient> {
  assertSecureEndpoint(registrationEndpoint, "registration endpoint");
  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: input.clientName ?? "Ares",
        redirect_uris: input.redirectUris,
        grant_types: input.grantTypes ?? ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        ...(input.scope ? { scope: input.scope } : {}),
      }),
      signal: signalFor(deps),
    });
  } catch {
    throw new OAuthError("network", "couldn't reach the registration endpoint");
  }
  const body = await readBody(res);
  if (!res.ok || typeof body.client_id !== "string" || !body.client_id) throw oauthErrorFrom(body, res.status);
  const secret = typeof body.client_secret === "string" && body.client_secret ? body.client_secret : undefined;
  const wanted = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : undefined;
  return {
    clientId: body.client_id,
    ...(secret ? { clientSecret: secret } : {}),
    authMethod: wanted === "client_secret_basic" ? "client_secret_basic" : secret ? "client_secret_post" : "none",
  };
}

// ─── authorization code + PKCE ───────────────────────────────────────────────

export interface AuthorizationRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
  scopeSeparator?: string;
  /** Slack v2 wants `user_scope`; default `scope`. */
  scopeParam?: string;
  pkceChallenge?: string;
  resource?: string;
  extra?: Record<string, string>;
}

export function buildAuthorizationUrl(req: AuthorizationRequest): string {
  assertSecureEndpoint(req.authorizationEndpoint, "authorization endpoint");
  const u = new URL(req.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", req.clientId);
  u.searchParams.set("redirect_uri", req.redirectUri);
  u.searchParams.set("state", req.state);
  if (req.scopes?.length) u.searchParams.set(req.scopeParam ?? "scope", req.scopes.join(req.scopeSeparator ?? " "));
  if (req.pkceChallenge) {
    u.searchParams.set("code_challenge", req.pkceChallenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  if (req.resource) u.searchParams.set("resource", req.resource);
  for (const [k, v] of Object.entries(req.extra ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** One in-flight authorization: everything needed to finish it, held in memory only. */
export interface PendingAuthorization {
  state: string;
  verifier?: string;
  redirectUri: string;
  client: OAuthClientCreds;
  tokenEndpoint: string;
  resource?: string;
  /** Expected issuer (RFC 9207): a callback carrying a different `iss` is refused. */
  issuer?: string;
  quirks?: TokenQuirks;
  createdAt: number;
  used: boolean;
}

export interface BeginAuthorizationInput extends Omit<AuthorizationRequest, "state" | "pkceChallenge" | "clientId"> {
  client: OAuthClientCreds;
  tokenEndpoint: string;
  /** Default true: every flow uses PKCE S256. A provider that rejects it sets false. */
  pkce?: boolean;
  issuer?: string;
  quirks?: TokenQuirks;
  now?: () => number;
}

export function beginAuthorization(input: BeginAuthorizationInput): { authorizeUrl: string; pending: PendingAuthorization } {
  const pkce = input.pkce === false ? undefined : newPkce();
  const state = newState();
  const authorizeUrl = buildAuthorizationUrl({
    authorizationEndpoint: input.authorizationEndpoint,
    clientId: input.client.clientId,
    redirectUri: input.redirectUri,
    state,
    ...(input.scopes ? { scopes: input.scopes } : {}),
    ...(input.scopeSeparator ? { scopeSeparator: input.scopeSeparator } : {}),
    ...(input.scopeParam ? { scopeParam: input.scopeParam } : {}),
    ...(pkce ? { pkceChallenge: pkce.challenge } : {}),
    ...(input.resource ? { resource: input.resource } : {}),
    ...(input.extra ? { extra: input.extra } : {}),
  });
  return {
    authorizeUrl,
    pending: {
      state,
      ...(pkce ? { verifier: pkce.verifier } : {}),
      redirectUri: input.redirectUri,
      client: input.client,
      tokenEndpoint: input.tokenEndpoint,
      ...(input.resource ? { resource: input.resource } : {}),
      ...(input.issuer ? { issuer: input.issuer } : {}),
      ...(input.quirks ? { quirks: input.quirks } : {}),
      createdAt: (input.now ?? Date.now)(),
      used: false,
    },
  };
}

/** The query parameters a provider's redirect carried. */
export interface CallbackParams {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  iss?: string | null;
}

/** Parse a full redirect URL (the app intercepted it) into callback params. */
export function callbackParamsFromUrl(url: string): CallbackParams {
  const u = new URL(url);
  const q = u.searchParams;
  return { code: q.get("code"), state: q.get("state"), error: q.get("error"), iss: q.get("iss") };
}

/**
 * Finish an authorization. Refuses (before any request is made) a callback that
 * is not for THIS flow: wrong `state`, a replay of an already-used flow, or a
 * mismatched issuer. Consent denial surfaces as OAuthError("access_denied").
 */
export async function completeAuthorization(
  pending: PendingAuthorization,
  params: CallbackParams,
  deps: EngineDeps = {},
): Promise<TokenSet> {
  if (pending.used) throw new OAuthError("replay", "this authorization was already used");
  if (!params.state || !safeEqual(params.state, pending.state)) throw new OAuthError("state_mismatch", "the redirect did not match the pending sign-in");
  // From here the state is consumed whatever happens next: one shot per flow.
  pending.used = true;
  if (params.iss && pending.issuer && params.iss !== pending.issuer) throw new OAuthError("issuer_mismatch", "the redirect came from a different issuer");
  if (params.error) throw new OAuthError(params.error, params.error === "access_denied" ? "access_denied: you declined" : scrubOAuthText(params.error));
  if (!params.code) throw new OAuthError("protocol", "the redirect carried no code");
  const now = (deps.now ?? Date.now)();
  const json = await tokenRequest(
    pending.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: pending.redirectUri,
      ...(pending.verifier ? { code_verifier: pending.verifier } : {}),
      ...(pending.resource ? { resource: pending.resource } : {}),
    },
    pending.client,
    deps,
    pending.quirks,
  );
  return parseTokenSet(json, now, undefined, pending.quirks?.keepTokenFields);
}

// ─── device authorization grant (RFC 8628) ───────────────────────────────────

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Epoch ms. */
  expiresAt: number;
  intervalSec: number;
}

export async function requestDeviceAuthorization(
  input: { endpoint: string; client: OAuthClientCreds; scopes?: string[]; scopeSeparator?: string; scopeParam?: string; extra?: Record<string, string>; quirks?: TokenQuirks },
  deps: EngineDeps = {},
): Promise<DeviceAuthorization> {
  assertSecureEndpoint(input.endpoint, "device authorization endpoint");
  const doFetch = deps.fetchImpl ?? fetch;
  const form = new URLSearchParams({
    ...(input.scopes?.length ? { [input.scopeParam ?? "scope"]: input.scopes.join(input.scopeSeparator ?? " ") } : {}),
    ...(input.extra ?? {}),
  });
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...(input.quirks?.tokenHeaders ?? {}) };
  applyClientAuth(form, headers, input.client);
  let res: Response;
  try {
    res = await doFetch(input.endpoint, { method: "POST", headers, body: form.toString(), signal: signalFor(deps), redirect: "manual" });
  } catch {
    throw new OAuthError("network", "couldn't reach the device authorization endpoint");
  }
  const body = await readBody(res);
  if (!res.ok || typeof body.error === "string") throw oauthErrorFrom(body, res.status);
  const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
  const userCode = typeof body.user_code === "string" ? body.user_code : "";
  // Google's historical spelling is verification_url.
  const verificationUri = typeof body.verification_uri === "string" ? body.verification_uri : typeof body.verification_url === "string" ? body.verification_url : "";
  if (!deviceCode || !userCode || !verificationUri) throw new OAuthError("protocol", "the device authorization response was incomplete");
  const expires = Number(body.expires_in);
  const interval = Number(body.interval);
  const now = (deps.now ?? Date.now)();
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof body.verification_uri_complete === "string" ? { verificationUriComplete: body.verification_uri_complete } : {}),
    expiresAt: now + (Number.isFinite(expires) && expires > 0 ? expires : 900) * 1000,
    intervalSec: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export interface DevicePollOptions {
  tokenEndpoint: string;
  client: OAuthClientCreds;
  device: DeviceAuthorization;
  quirks?: TokenQuirks;
  /** Extra form fields on the device token poll only (Twitch wants `scopes`). */
  extraParams?: Record<string, string>;
  signal?: AbortSignal;
  /** Test seam; default setTimeout with abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called after each pending/slow_down poll (UI progress). */
  onPending?: (info: { intervalSec: number }) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new OAuthError("aborted", "cancelled"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new OAuthError("aborted", "cancelled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll the token endpoint until the owner approves the code. RFC 8628 §3.5:
 * `authorization_pending` keeps waiting, `slow_down` adds 5 s to the interval,
 * `access_denied` and `expired_token` end it. A network hiccup is retried until
 * the code itself expires.
 */
export async function pollDeviceAuthorization(opts: DevicePollOptions, deps: EngineDeps = {}): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  let intervalSec = opts.device.intervalSec;
  for (;;) {
    await sleep(intervalSec * 1000, opts.signal);
    if (now() >= opts.device.expiresAt) throw new OAuthError("expired_token", "the code expired before it was approved");
    try {
      const json = await tokenRequest(
        opts.tokenEndpoint,
        { grant_type: GRANT_DEVICE, device_code: opts.device.deviceCode, ...(opts.extraParams ?? {}) },
        opts.client,
        deps,
        opts.quirks,
      );
      return parseTokenSet(json, now(), undefined, opts.quirks?.keepTokenFields);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.code === "authorization_pending") { opts.onPending?.({ intervalSec }); continue; }
      if (err.code === "slow_down") { intervalSec += 5; opts.onPending?.({ intervalSec }); continue; }
      if (err.code === "network" || err.code === "timeout") continue;
      throw err;
    }
  }
}

// ─── refresh (rotation, single-flight) ───────────────────────────────────────

const inflight = new Map<string, Promise<unknown>>();

/** Share one in-flight promise per key: concurrent refreshes become one request. */
export function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const hit = inflight.get(key);
  if (hit) return hit as Promise<T>;
  const p = (async () => {
    try {
      return await work();
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export async function refreshOAuthToken(
  input: {
    tokenEndpoint: string;
    client: OAuthClientCreds;
    refreshToken: string;
    scopes?: string[];
    scopeSeparator?: string;
    resource?: string;
    quirks?: TokenQuirks;
    prev?: { refreshToken?: string; scope?: string; expiresAt?: number };
  },
  deps: EngineDeps = {},
): Promise<TokenSet> {
  const now = (deps.now ?? Date.now)();
  const json = await tokenRequest(
    input.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      ...(input.scopes?.length ? { scope: input.scopes.join(input.scopeSeparator ?? " ") } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    },
    input.client,
    deps,
    input.quirks,
  );
  return parseTokenSet(json, now, input.prev ?? { refreshToken: input.refreshToken });
}

// ─── revocation (RFC 7009) ───────────────────────────────────────────────────

/** Best effort and bounded: a revocation hiccup must never block a disconnect. */
export async function revokeOAuthToken(
  input: { endpoint: string; token: string; hint?: "access_token" | "refresh_token"; client: OAuthClientCreds; quirks?: TokenQuirks },
  deps: EngineDeps = {},
): Promise<boolean> {
  try {
    assertSecureEndpoint(input.endpoint, "revocation endpoint");
    const doFetch = deps.fetchImpl ?? fetch;
    const form = new URLSearchParams({ token: input.token, ...(input.hint ? { token_type_hint: input.hint } : {}) });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...(input.quirks?.tokenHeaders ?? {}) };
    applyClientAuth(form, headers, input.client);
    const res = await doFetch(input.endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(Math.min(deps.timeoutMs ?? 8_000, 8_000)), redirect: "manual" });
    return res.ok;
  } catch {
    return false;
  }
}
