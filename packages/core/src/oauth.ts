// The OAuth2 module — the in-house primitive every Google/Meta/X connector rides.
//
// Resend and Stripe authenticate with a static API key; almost nothing else
// does. Gmail, Google Ads, Calendar, Meta Ads, X, LinkedIn — all OAuth2 with
// short-lived access tokens and long-lived refresh tokens. This is the ONE
// generic implementation of that dance:
//
//   buildAuthorizeUrl → (owner consents in a browser, once) → exchangeCodeForTokens
//   → store tokens in the vault → getValidAccessToken auto-refreshes forever.
//
// The pure pieces (url build, code exchange, refresh) take an injectable fetch +
// clock so they're unit-testable with zero real provider. Tokens persist through
// the credential vault (credentials.ts), so they're encrypted at rest like every
// other secret. The owner supplies a registered OAuth app's client id/secret
// ONCE (stored as credentials); the framework handles the rest.

import { deleteCredential, getCredential, setCredential } from "./credentials.js";
import {
  OAuthError,
  beginAuthorization,
  parseTokenSet,
  pollDeviceAuthorization,
  refreshOAuthToken,
  requestDeviceAuthorization,
  revokeOAuthToken,
  singleFlight,
  tokenRequest,
  type ClientAuthMethod,
  type DeviceAuthorization,
  type OAuthClientCreds,
  type PendingAuthorization,
  type TokenQuirks,
  type TokenSet,
} from "./oauthEngine.js";
import { clientIdCredential, clientSecretCredential, resolveOAuthClient } from "./oauthClients.js";
import type { VendorCtx } from "./oauthVendorQuirks.js";

export interface OAuthProviderConfig {
  /** Stable id — "google", "x", "meta". Keys the stored token + client creds. */
  provider: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Default scopes; a connector may request a subset/superset at authorize time. */
  scopes: string[];
  /** Credential names for the owner-registered OAuth app. Default <PROVIDER>_OAUTH_CLIENT_ID/SECRET. */
  clientIdCredential?: string;
  clientSecretCredential?: string;
  /** Extra params some providers require (Google: access_type=offline&prompt=consent). */
  extraAuthorizeParams?: Record<string, string>;
  /** Scope list separator in the authorize URL. RFC 6749 says space; Withings
   *  wants commas (`user.info,user.metrics`). */
  scopeSeparator?: string;
  /** Extra form fields on EVERY token call (code exchange and refresh).
   *  Withings routes its token endpoint by `action=requesttoken`. */
  extraTokenParams?: Record<string, string>;
  /** Turn a provider's non-standard token response into the RFC 6749 shape,
   *  throwing on an in-band error. Withings answers HTTP 200 with
   *  `{status, body:{access_token…}}` and signals failure by a non-zero status. */
  unwrapTokenResponse?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** Send an S256 PKCE challenge on the authorize step and the verifier on the
   *  exchange. On for every vendor that accepts it (public clients need it). */
  pkce?: boolean;
  /** How the client authenticates at the token endpoint. Default client_secret_post. */
  clientAuth?: ClientAuthMethod;
  /** No client secret exists or is needed (device flow, PKCE public client). */
  publicClient?: boolean;
  /** `json` for vendors that want a JSON token body (Notion). */
  tokenBody?: "form" | "json";
  /** Extra headers on token calls (Reddit wants a User-Agent). */
  tokenHeaders?: Record<string, string>;
  /** RFC 8628 device authorization endpoint, when the vendor has one. */
  deviceUrl?: string;
  /** RFC 7009 revocation endpoint, when the vendor has one. */
  revokeUrl?: string;
  /** Scope parameter name when it is not `scope` (Slack user tokens: `user_scope`). */
  scopeParam?: string;
  /** Cheap read that proves the token and names the account (health + display). */
  userinfoUrl?: string;
  /** Scope parameter name on the DEVICE request when it is not `scope` (Twitch: `scopes`). */
  deviceScopeParam?: string;
  /** Extra form fields on the device token poll only. */
  deviceTokenParams?: Record<string, string>;
  /** Token-response fields to keep beside the token (Salesforce: instance_url). */
  keepTokenFields?: string[];
  /** After the code exchange: e.g. swap Meta's 1h token for a 60-day one. */
  afterExchange?: (tokens: OAuthTokens, ctx: VendorCtx) => Promise<OAuthTokens>;
  /** Vendors with no refresh_token grant renew the access token itself (Meta). */
  customRefresh?: (tokens: OAuthTokens, ctx: VendorCtx) => Promise<OAuthTokens>;
  /** Renew this long before expiry (Meta tokens last 60 days and renew late). Default 60 s. */
  refreshAheadMs?: number;
}

/** Bookkeeping stored beside a token. Never holds a secret. */
export interface OAuthTokenMeta {
  /** Display name/email of the connected account, when known. */
  account?: string;
  /** RFC 7009 endpoint, kept so a disconnect can revoke even when the config moved. */
  revocationEndpoint?: string;
  /** How this token was obtained. */
  via?: "code" | "device" | "mcp";
  connectedAt?: number;
  /** Fields the vendor returned beside the token that the API needs (Salesforce instance_url). Never secrets. */
  extra?: Record<string, string>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (undefined → unknown / non-expiring). */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  /** The refresh was rejected (invalid_grant): the owner must sign in again. */
  needsReauth?: boolean;
  meta?: OAuthTokenMeta;
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Vault home override (tests). */
  home?: string;
}


const DEFAULT_SKEW_MS = 60_000; // refresh a minute early — never hand out a token about to die.

export function clientIdName(cfg: OAuthProviderConfig): string {
  return cfg.clientIdCredential ?? clientIdCredential(cfg.provider);
}

export function clientSecretName(cfg: OAuthProviderConfig): string {
  return cfg.clientSecretCredential ?? clientSecretCredential(cfg.provider);
}

function tokenCredentialName(provider: string): string {
  return `oauth/${provider}`;
}

/** The wire quirks of a provider config, in the engine's vocabulary. */
export function quirksOf(cfg: OAuthProviderConfig): TokenQuirks {
  return {
    ...(cfg.tokenBody ? { tokenBody: cfg.tokenBody } : {}),
    ...(cfg.extraTokenParams ? { extraTokenParams: cfg.extraTokenParams } : {}),
    ...(cfg.unwrapTokenResponse ? { unwrapTokenResponse: cfg.unwrapTokenResponse } : {}),
    ...(cfg.tokenHeaders ? { tokenHeaders: cfg.tokenHeaders } : {}),
    ...(cfg.keepTokenFields ? { keepTokenFields: cfg.keepTokenFields } : {}),
  };
}

/** The engine's view of a client for this provider (auth method from the config). */
export function clientCredsFor(cfg: OAuthProviderConfig, c: { clientId: string; clientSecret?: string }): OAuthClientCreds {
  return {
    clientId: c.clientId,
    ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}),
    ...(cfg.clientAuth ? { authMethod: cfg.clientAuth } : {}),
  };
}

function engineDeps(deps: OAuthDeps): { fetchImpl?: typeof fetch; now?: () => number } {
  return { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.now ? { now: deps.now } : {}) };
}

/** Build the consent URL the owner opens once to authorize the app. */
export function buildAuthorizeUrl(
  cfg: OAuthProviderConfig,
  input: { clientId: string; redirectUri: string; state: string; scopes?: string[]; pkceChallenge?: string },
): string {
  const url = new URL(cfg.authorizeUrl);
  const params: Record<string, string> = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    [cfg.scopeParam ?? "scope"]: (input.scopes ?? cfg.scopes).join(cfg.scopeSeparator ?? " "),
    state: input.state,
    ...(cfg.extraAuthorizeParams ?? {}),
  };
  if (input.pkceChallenge) {
    params.code_challenge = input.pkceChallenge;
    params.code_challenge_method = "S256";
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function legacyError(err: unknown): never {
  if (err instanceof OAuthError) throw new OAuthError(err.code, `OAuth token request failed: ${err.message}`, err.status);
  throw err;
}

function asTokens(t: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string; tokenType?: string }): OAuthTokens {
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, scope: t.scope, tokenType: t.tokenType };
}

/** Exchange the one-time authorization code for the first token pair. */
export async function exchangeCodeForTokens(
  cfg: OAuthProviderConfig,
  input: { code: string; clientId: string; clientSecret?: string; redirectUri: string; codeVerifier?: string },
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  const now = (deps.now ?? Date.now)();
  try {
    const json = await tokenRequest(
      cfg.tokenUrl,
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
      },
      clientCredsFor(cfg, input),
      engineDeps(deps),
      quirksOf(cfg),
    );
    return asTokens(parseTokenSet(json, now));
  } catch (err) {
    return legacyError(err);
  }
}

/** Trade a refresh token for a fresh access token. */
export async function refreshTokens(
  cfg: OAuthProviderConfig,
  input: { refreshToken: string; clientId: string; clientSecret?: string },
  deps: OAuthDeps = {},
  prev?: OAuthTokens,
): Promise<OAuthTokens> {
  try {
    const t = await refreshOAuthToken(
      {
        tokenEndpoint: cfg.tokenUrl,
        client: clientCredsFor(cfg, input),
        refreshToken: input.refreshToken,
        quirks: quirksOf(cfg),
        prev: prev ?? { refreshToken: input.refreshToken },
      },
      engineDeps(deps),
    );
    return asTokens(t);
  } catch (err) {
    return legacyError(err);
  }
}

/** Persist a provider's tokens (encrypted, via the credential vault). */
export async function storeTokens(provider: string, tokens: OAuthTokens, deps: OAuthDeps = {}): Promise<void> {
  await setCredential(tokenCredentialName(provider), JSON.stringify(tokens), { home: deps.home });
}

/** Load a provider's stored tokens, or undefined if the owner hasn't authorized yet. */
export async function loadTokens(provider: string, deps: OAuthDeps = {}): Promise<OAuthTokens | undefined> {
  const raw = await getCredential(tokenCredentialName(provider), { home: deps.home });
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as OAuthTokens;
    return parsed.accessToken !== undefined ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isExpired(tokens: OAuthTokens, now: number, skewMs = DEFAULT_SKEW_MS): boolean {
  return tokens.expiresAt !== undefined && now >= tokens.expiresAt - skewMs;
}

/**
 * The function connectors actually call: return a usable access token, refreshing
 * (and re-persisting) transparently when the stored one is expired. Throws a
 * clear, actionable error when the owner hasn't authorized the provider yet.
 *
 * Refresh is SINGLE-FLIGHT per (vault, provider): a rotating refresh token dies
 * the moment it is used, so two racing callers must share one request. A
 * refresh the vendor rejects as invalid_grant marks the record `needsReauth`
 * (surfaced as "expired" in the Connections list) instead of retrying forever.
 */
export async function getValidAccessToken(cfg: OAuthProviderConfig, deps: OAuthDeps = {}): Promise<string> {
  const clock = deps.now ?? Date.now;
  const tokens = await loadTokens(cfg.provider, deps);
  if (!tokens) {
    throw new Error(
      `OAUTH_NOT_AUTHORIZED: ${cfg.provider} is not connected. Call Connect with action "connect" and ` +
        `service "${cfg.provider}" — the owner gets a one-tap card that walks them through it. No ${cfg.provider} access token on file.`,
    );
  }
  // A refresh the vendor already rejected: don't hammer it, ask for a fresh sign-in.
  if (tokens.needsReauth) {
    throw new Error(`OAUTH_EXPIRED: ${cfg.provider} refused the refresh token (revoked or expired) — call Connect with action "connect" and service "${cfg.provider}" to sign in again.`);
  }
  if (!isExpired(tokens, clock(), cfg.refreshAheadMs ?? DEFAULT_SKEW_MS)) return tokens.accessToken;

  // Vendors with no refresh_token grant (Meta) renew the access token itself.
  if (cfg.customRefresh) {
    return singleFlight(`oauth|${deps.home ?? ""}|${cfg.provider}`, async () => {
      const current = (await loadTokens(cfg.provider, deps)) ?? tokens;
      if (!isExpired(current, clock(), cfg.refreshAheadMs ?? DEFAULT_SKEW_MS)) return current.accessToken;
      const client = await resolveOAuthClient(cfg.provider, { ...(deps.home ? { home: deps.home } : {}), idName: clientIdName(cfg), secretName: clientSecretName(cfg) });
      if (!client) throw new Error(`OAUTH_NO_APP: ${cfg.provider} renewal needs ${clientIdName(cfg)} / ${clientSecretName(cfg)} in the vault.`);
      try {
        const renewed = await cfg.customRefresh!(current, { clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), ...engineDeps(deps) });
        await storeTokens(cfg.provider, renewed, deps);
        return renewed.accessToken;
      } catch (err) {
        if (err instanceof OAuthError && err.code === "invalid_grant") {
          await storeTokens(cfg.provider, { ...current, needsReauth: true }, deps).catch(() => undefined);
          throw new Error(`OAUTH_EXPIRED: ${cfg.provider} no longer accepts the token (expired or revoked) — call Connect with action "connect" and service "${cfg.provider}" to sign in again.`);
        }
        throw err;
      }
    });
  }

  if (!tokens.refreshToken) {
    throw new Error(`OAUTH_EXPIRED: ${cfg.provider} access token expired and no refresh token is stored — call Connect with action "connect" and service "${cfg.provider}" to re-authorize.`);
  }
  return singleFlight(`oauth|${deps.home ?? ""}|${cfg.provider}`, async () => {
    // Another caller may have refreshed while we waited for the flight slot.
    const current = (await loadTokens(cfg.provider, deps)) ?? tokens;
    if (!isExpired(current, clock())) return current.accessToken;
    const refreshToken = current.refreshToken ?? tokens.refreshToken!;
    const client = await resolveOAuthClient(cfg.provider, {
      ...(deps.home ? { home: deps.home } : {}),
      requireSecret: !cfg.publicClient && cfg.clientAuth !== "none",
      idName: clientIdName(cfg),
      secretName: clientSecretName(cfg),
    });
    if (!client) {
      throw new Error(`OAUTH_NO_APP: ${cfg.provider} refresh needs ${clientIdName(cfg)}${cfg.publicClient ? "" : ` / ${clientSecretName(cfg)}`} in the vault.`);
    }
    try {
      const refreshed = await refreshTokens(cfg, { refreshToken, clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) }, deps, current);
      // Rotation: refreshTokens keeps the OLD refresh token only when the vendor sent no new one.
      await storeTokens(cfg.provider, { ...refreshed, ...(current.meta ? { meta: current.meta } : {}) }, deps);
      return refreshed.accessToken;
    } catch (err) {
      if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "invalid_client" || err.code === "unauthorized_client")) {
        await storeTokens(cfg.provider, { ...current, needsReauth: true }, deps).catch(() => undefined);
        throw new Error(`OAUTH_EXPIRED: ${cfg.provider} refused the refresh token (revoked or expired) — call Connect with action "connect" and service "${cfg.provider}" to sign in again.`);
      }
      throw err;
    }
  });
}

// ─── provider-config driven flows (the hub and the loopback server use these) ─

/** Start an authorization-code flow for a provider config with a resolved client. */
export function beginProviderAuthorization(
  cfg: OAuthProviderConfig,
  input: { client: { clientId: string; clientSecret?: string }; redirectUri: string; scopes?: string[] },
): { authorizeUrl: string; pending: PendingAuthorization } {
  return beginAuthorization({
    authorizationEndpoint: cfg.authorizeUrl,
    tokenEndpoint: cfg.tokenUrl,
    client: clientCredsFor(cfg, input.client),
    redirectUri: input.redirectUri,
    scopes: input.scopes ?? cfg.scopes,
    ...(cfg.scopeSeparator ? { scopeSeparator: cfg.scopeSeparator } : {}),
    ...(cfg.scopeParam ? { scopeParam: cfg.scopeParam } : {}),
    pkce: cfg.pkce ?? true,
    ...(cfg.extraAuthorizeParams ? { extra: cfg.extraAuthorizeParams } : {}),
    quirks: quirksOf(cfg),
  });
}

/** RFC 8628 for a provider config. */
export async function startProviderDevice(
  cfg: OAuthProviderConfig,
  input: { client: { clientId: string; clientSecret?: string }; scopes?: string[] },
  deps: OAuthDeps = {},
): Promise<DeviceAuthorization> {
  if (!cfg.deviceUrl) throw new OAuthError("unsupported", `${cfg.provider} has no device authorization endpoint`);
  return requestDeviceAuthorization(
    {
      endpoint: cfg.deviceUrl,
      client: clientCredsFor(cfg, input.client),
      scopes: input.scopes ?? cfg.scopes,
      ...(cfg.scopeSeparator ? { scopeSeparator: cfg.scopeSeparator } : {}),
      ...(cfg.deviceScopeParam ? { scopeParam: cfg.deviceScopeParam } : {}),
      quirks: quirksOf(cfg),
    },
    engineDeps(deps),
  );
}

/** Poll a provider's device grant to completion (RFC 8628). */
export async function pollProviderDevice(
  cfg: OAuthProviderConfig,
  input: { client: { clientId: string; clientSecret?: string }; device: DeviceAuthorization; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  return pollDeviceAuthorization(
    {
      tokenEndpoint: cfg.tokenUrl,
      client: clientCredsFor(cfg, input.client),
      device: input.device,
      quirks: quirksOf(cfg),
      ...(cfg.deviceTokenParams ? { extraParams: cfg.deviceTokenParams } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
    },
    engineDeps(deps),
  );
}

/**
 * Turn a freshly issued TokenSet into the stored record: run the vendor's
 * after-exchange step (Meta long-lived swap), keep the response fields the API
 * needs, and stamp how/when it was connected. The caller stores the result.
 */
export async function finalizeProviderTokens(
  cfg: OAuthProviderConfig,
  set: TokenSet,
  input: { client: { clientId: string; clientSecret?: string }; via: "code" | "device"; account?: string },
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  let tokens: OAuthTokens = {
    accessToken: set.accessToken,
    ...(set.refreshToken ? { refreshToken: set.refreshToken } : {}),
    ...(set.expiresAt !== undefined ? { expiresAt: set.expiresAt } : {}),
    ...(set.scope ? { scope: set.scope } : {}),
    ...(set.tokenType ? { tokenType: set.tokenType } : {}),
  };
  if (cfg.afterExchange) {
    tokens = await cfg.afterExchange(tokens, { clientId: input.client.clientId, ...(input.client.clientSecret ? { clientSecret: input.client.clientSecret } : {}), ...engineDeps(deps) });
  }
  const meta: OAuthTokenMeta = {
    via: input.via,
    connectedAt: (deps.now ?? Date.now)(),
    ...(cfg.revokeUrl ? { revocationEndpoint: cfg.revokeUrl } : {}),
    ...(set.extra ? { extra: set.extra } : {}),
    ...(input.account ? { account: input.account } : {}),
    ...(tokens.meta ?? {}),
  };
  return { ...tokens, meta };
}

/** Revoke (RFC 7009) a provider's stored token at the vendor, then forget it locally. */
export async function revokeAndForgetTokens(cfg: OAuthProviderConfig | undefined, provider: string, deps: OAuthDeps = {}): Promise<boolean> {
  const tokens = await loadTokens(provider, deps);
  const endpoint = tokens?.meta?.revocationEndpoint ?? cfg?.revokeUrl;
  if (tokens && endpoint) {
    const client = await resolveOAuthClient(provider, deps.home ? { home: deps.home } : {});
    if (client) {
      // The refresh token is the long-lived one; revoking it kills the grant.
      await revokeOAuthToken(
        {
          endpoint,
          token: tokens.refreshToken ?? tokens.accessToken,
          hint: tokens.refreshToken ? "refresh_token" : "access_token",
          client: cfg ? clientCredsFor(cfg, client) : client,
          ...(cfg ? { quirks: quirksOf(cfg) } : {}),
        },
        engineDeps(deps),
      );
    }
  }
  return deleteCredential(tokenCredentialName(provider), { home: deps.home });
}
