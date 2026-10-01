// Where an Api preset's bearer token comes from when the service is connected
// through the Connect registry (OAuth, a pasted key) instead of a form of its own.
//
// Order, first hit wins:
//   1. the explicit credential API_<ID>_KEY (vault, or the environment variable of
//      the same name — the headless fallback; also what a test injects)
//   2. the vault credentials the registry stores a key under (def.oauth.credentials:
//      STRIPE_SECRET_KEY, mcp.key.github ...)
//   3. the owner's OAuth-app grant for the provider (Google, Spotify, GitHub, Slack ...),
//      refreshed transparently by getValidAccessToken
//   4. the remote-MCP OAuth bundle (def.oauth.mcp), only where a preset says the
//      vendor's MCP token is also a REST token
//
// The OAuth engine is being rebuilt elsewhere; whatever it ends up exposing plugs
// in through setConnectedTokenProvider, which is asked FIRST. Nothing in here
// ever returns a token to the model: the Api tool puts it in a header and scrubs
// it from everything shown.

import { apiCred, getMcpAccessToken, getProviderConfig, getValidAccessToken, loadTokens, type ApiServiceDef } from "@ares/core";
import { ApiInputError, type CredentialSource } from "./errors.js";

export interface ConnectedTokenEnv {
  creds: CredentialSource;
  home?: string;
  now?: () => number;
}

export interface ConnectedToken {
  token: string;
  source: "key" | "credential" | "oauth" | "mcp" | "provider";
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
  const providerId = (src.provider ?? src.connect).toLowerCase();
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
  if (src.mcp) {
    const token = await getMcpAccessToken(src.mcp, env.home).catch(() => null);
    if (token) return { token, source: "mcp" };
  }
  return undefined;
}

/** Does the service have a usable token right now? Never throws. */
export async function hasConnectedToken(def: ApiServiceDef, env: ConnectedTokenEnv): Promise<boolean> {
  try {
    return (await resolveConnectedToken(def, env)) !== undefined;
  } catch {
    return false;
  }
}
