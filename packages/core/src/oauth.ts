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

import { getCredential, setCredential } from "./credentials.js";

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
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (undefined → unknown / non-expiring). */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Vault home override (tests). */
  home?: string;
}

const DEFAULT_SKEW_MS = 60_000; // refresh a minute early — never hand out a token about to die.

export function clientIdName(cfg: OAuthProviderConfig): string {
  return cfg.clientIdCredential ?? `${cfg.provider.toUpperCase()}_OAUTH_CLIENT_ID`;
}

export function clientSecretName(cfg: OAuthProviderConfig): string {
  return cfg.clientSecretCredential ?? `${cfg.provider.toUpperCase()}_OAUTH_CLIENT_SECRET`;
}

function tokenCredentialName(provider: string): string {
  return `oauth/${provider}`;
}

/** Build the consent URL the owner opens once to authorize the app. */
export function buildAuthorizeUrl(
  cfg: OAuthProviderConfig,
  input: { clientId: string; redirectUri: string; state: string; scopes?: string[] },
): string {
  const url = new URL(cfg.authorizeUrl);
  const params: Record<string, string> = {
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? cfg.scopes).join(" "),
    state: input.state,
    ...(cfg.extraAuthorizeParams ?? {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function parseTokenResponse(json: Record<string, unknown>, now: number, prev?: OAuthTokens): OAuthTokens {
  const accessToken = String(json.access_token ?? "");
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
  return {
    accessToken,
    // Providers omit refresh_token on refresh — keep the one we already hold.
    refreshToken: (json.refresh_token as string | undefined) ?? prev?.refreshToken,
    expiresAt: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : prev?.expiresAt,
    scope: (json.scope as string | undefined) ?? prev?.scope,
    tokenType: (json.token_type as string | undefined) ?? prev?.tokenType,
  };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  deps: OAuthDeps,
): Promise<Record<string, unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = (json.error_description as string) ?? (json.error as string) ?? `HTTP ${res.status}`;
    throw new Error(`OAuth token request failed: ${detail}`);
  }
  return json;
}

/** Exchange the one-time authorization code for the first token pair. */
export async function exchangeCodeForTokens(
  cfg: OAuthProviderConfig,
  input: { code: string; clientId: string; clientSecret: string; redirectUri: string },
  deps: OAuthDeps = {},
): Promise<OAuthTokens> {
  const now = (deps.now ?? Date.now)();
  const json = await postForm(
    cfg.tokenUrl,
    {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    },
    deps,
  );
  return parseTokenResponse(json, now);
}

/** Trade a refresh token for a fresh access token. */
export async function refreshTokens(
  cfg: OAuthProviderConfig,
  input: { refreshToken: string; clientId: string; clientSecret: string },
  deps: OAuthDeps = {},
  prev?: OAuthTokens,
): Promise<OAuthTokens> {
  const now = (deps.now ?? Date.now)();
  const json = await postForm(
    cfg.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    deps,
  );
  return parseTokenResponse(json, now, prev ?? { accessToken: "", refreshToken: input.refreshToken });
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
 */
export async function getValidAccessToken(cfg: OAuthProviderConfig, deps: OAuthDeps = {}): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const tokens = await loadTokens(cfg.provider, deps);
  if (!tokens) {
    throw new Error(
      `OAUTH_NOT_AUTHORIZED: ${cfg.provider} is not connected. The owner must authorize it once ` +
        `(register an OAuth app, then run the connect flow). No ${cfg.provider} access token on file.`,
    );
  }
  if (!isExpired(tokens, now)) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new Error(`OAUTH_EXPIRED: ${cfg.provider} access token expired and no refresh token is stored — re-authorize.`);
  }
  const clientId = await getCredential(clientIdName(cfg), { home: deps.home });
  const clientSecret = await getCredential(clientSecretName(cfg), { home: deps.home });
  if (!clientId || !clientSecret) {
    throw new Error(
      `OAUTH_NO_APP: ${cfg.provider} refresh needs ${clientIdName(cfg)} / ${clientSecretName(cfg)} in the vault.`,
    );
  }
  const refreshed = await refreshTokens(cfg, { refreshToken: tokens.refreshToken, clientId, clientSecret }, deps, tokens);
  await storeTokens(cfg.provider, refreshed, deps);
  return refreshed.accessToken;
}
