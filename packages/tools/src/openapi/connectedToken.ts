// Where an Api preset's bearer token comes from when the service is connected
// through the Connect registry (OAuth, a pasted key) instead of a form of its own.
//
// Order, first hit wins:
//   1. the explicit credential API_<ID>_KEY (vault, or the environment variable of
//      the same name — the headless fallback; also what a test injects)
//   2. the vault credentials the registry stores a key under (def.oauth.credentials:
//      STRIPE_SECRET_KEY, mcp.key.github ...)
//   3. the owner's OAuth-app grant for the provider (Google, Spotify, GitHub, Slack ...),
//      refreshed transparently by oauth-core's getValidAccessToken. The provider id is
//      the preset's own, else the one the Connect registry / OAuth matrix names for
//      `oauth.connect`, so the preset follows the registry.
//   4. the remote-MCP OAuth bundle the hub stored under the connect id (Linear, Figma,
//      Sentry, Vercel ... are connected through their MCP server's sign-in; the same
//      vendor-issued token is sent to that vendor's own REST host and nowhere else)
//
// A host that wants to take over token supply entirely plugs in through
// setConnectedTokenProvider, which is asked FIRST. Nothing in here
// ever returns a token to the model: the Api tool puts it in a header and scrubs
// it from everything shown.

import { apiCred, getMcpAccessToken, getProviderConfig, getValidAccessToken, loadTokens, matrixFor, resolveConnectService, type ApiServiceDef } from "@ares/core";
import { ApiInputError, type CredentialSource } from "./errors.js";

export interface ConnectedTokenEnv {
  creds: CredentialSource;
  home?: string;
  now?: () => number;
  /** Tags of the operation being called (a preset's opCredentials may pick another credential for them). */
  opTags?: string[];
}

export interface ConnectedToken {
  token: string;
  source: "key" | "credential" | "oauth" | "mcp" | "provider";
  /** Set when an operation-specific credential supplied the token (Discord's "Bot"): the word before it. */
  scheme?: string;
}

export type ConnectedTokenProvider = (def: ApiServiceDef, env: ConnectedTokenEnv) => Promise<string | undefined>;

let provider: ConnectedTokenProvider | undefined;

/** Plug in the OAuth engine's token source. Pass undefined to go back to the built-in order. */
export function setConnectedTokenProvider(fn: ConnectedTokenProvider | undefined): void {
  provider = fn;
}

/** The sentence a model (and the owner) reads when the token is absent. */
export function notConnectedMessage(def: ApiServiceDef): string {
  const connect = def.oauth?.connect ?? `api-${def.id}`;
  return (
    `${def.label} is not connected - Connect service "${connect}" (the owner taps one card on their phone; never ask for a token in chat). ` +
    `Headless fallback: set the environment variable ${apiCred(def.id, "KEY")}.`
  );
}

export async function resolveConnectedToken(def: ApiServiceDef, env: ConnectedTokenEnv): Promise<ConnectedToken | undefined> {
  const src = def.oauth;
  // An operation that authenticates differently (Discord's bot operations) wins when its credential is stored.
  if (src?.opCredentials && env.opTags?.length) {
    for (const rule of src.opCredentials) {
      if (!env.opTags.some((tag) => tag.toLowerCase() === rule.tag.toLowerCase())) continue;
      for (const name of rule.credentials) {
        const value = await env.creds.get(name);
        if (value) return { token: value, source: "credential", scheme: rule.scheme };
      }
    }
  }
  if (provider) {
    const injected = await provider(def, env);
    if (injected) return { token: injected, source: "provider" };
  }
  const explicit = await env.creds.get(apiCred(def.id, "KEY"));
  if (explicit) return { token: explicit, source: "key" };
  if (!src) return undefined;
  for (const name of src.credentials ?? []) {
    const value = await env.creds.get(name);
    if (value) return { token: value, source: "credential" };
  }
  const providerId = oauthProviderId(def);
  const cfg = getProviderConfig(providerId);
  if (cfg) {
    const deps = env.home ? { home: env.home } : {};
    const tokens = await loadTokens(cfg.provider, deps).catch(() => undefined);
    if (tokens?.accessToken) {
      try {
        return { token: await getValidAccessToken(cfg, { ...deps, ...(env.now ? { now: env.now } : {}) }), source: "oauth" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An expired grant with no way to refresh is not "never connected": say so, so the owner reconnects.
        if (/OAUTH_EXPIRED|OAUTH_NO_APP/.test(message)) {
          throw new ApiInputError(`${def.label}: the stored sign-in expired and cannot be refreshed - Connect service "${src.connect}" again.`);
        }
        throw err;
      }
    }
  }
  const mcpName = mcpBundleName(def);
  if (mcpName) {
    const token = await getMcpAccessToken(mcpName, env.home).catch(() => null);
    if (token) return { token, source: "mcp" };
  }
  return undefined;
}

/** The engine provider id (vault slot oauth/<provider>) for a connected-account preset: its own, else the registry's. */
export function oauthProviderId(def: ApiServiceDef): string {
  const src = def.oauth;
  if (!src) return def.id;
  if (src.provider) return src.provider.toLowerCase();
  const service = resolveConnectService(src.connect);
  return (service?.oauthProvider ?? matrixFor(src.connect)?.provider ?? src.connect).toLowerCase();
}

/** The MCP bundle name the hub stored the owner's sign-in under: the preset's own claim, else the registry's remote-MCP connect id. */
function mcpBundleName(def: ApiServiceDef): string | undefined {
  const src = def.oauth;
  if (!src) return undefined;
  if (src.mcp) return src.mcp;
  const service = resolveConnectService(src.connect);
  return service?.kind === "mcp-oauth" ? service.id : undefined;
}

/**
 * The API host the vendor named in the token response (Salesforce instance_url), for a preset whose
 * `oauth.baseUrlFromToken` says so. Never throws; undefined when the account is not connected or the
 * field is absent.
 */
export async function connectedBaseUrl(def: ApiServiceDef, env: { home?: string }): Promise<string | undefined> {
  const field = def.oauth?.baseUrlFromToken;
  if (!field) return undefined;
  const cfg = getProviderConfig(oauthProviderId(def));
  if (!cfg) return undefined;
  const tokens = await loadTokens(cfg.provider, env.home ? { home: env.home } : {}).catch(() => undefined);
  const value = tokens?.meta?.extra?.[field];
  return typeof value === "string" && value ? value : undefined;
}

/** Does the service have a usable token right now? Never throws. */
export async function hasConnectedToken(def: ApiServiceDef, env: ConnectedTokenEnv): Promise<boolean> {
  try {
    return (await resolveConnectedToken(def, env)) !== undefined;
  } catch {
    return false;
  }
}
