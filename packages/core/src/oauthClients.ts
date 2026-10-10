// The OAuth client registry: which client id Ares uses for each provider.
//
// A vendor's OAuth server wants to know WHICH app is asking. Three sources,
// most specific first:
//
//   1. the vault   — a client the owner registered themselves (CLI
//                    `ares connectors clients set`, or the phone's setup step)
//   2. OFFICIAL    — Ares's own registered public client, shipped with the
//                    code. Device-flow and PKCE public clients carry no secret,
//                    so their ids are safe to ship. EMPTY BY DEFAULT: the owner
//                    registers the "Ares" app on each vendor console once and
//                    the lead pastes the id here. Never invent one.
//   3. none        — the product shows the one-time "register an app" setup
//                    (never a token prompt).
//
// Vault names keep the pre-existing scheme (<PROVIDER>_OAUTH_CLIENT_ID /
// _SECRET) so apps already registered for Google, Spotify... keep working.

import { deleteCredential, getCredential, listCredentialNames, setCredential } from "./credentials.js";

export interface OfficialClient {
  /** The public client id Ares registered with the vendor. Empty = not registered yet. */
  clientId: string;
  /** Only for vendors that hand a "secret" to a public/native client and say it is not confidential. Usually absent. */
  clientSecret?: string;
}

/**
 * Ares's own registered clients, by provider id. Fill `clientId` after the
 * owner registers the Ares app on that vendor's console (docs/CONNECTIONS-OAUTH.md
 * section 4 lists exactly where and how). An empty id means "not registered":
 * the setup step is shown instead.
 */
export const OFFICIAL_OAUTH_CLIENTS: Record<string, OfficialClient> = {
  github: { clientId: "" },
  google: { clientId: "" },
  slack: { clientId: "" },
  notion: { clientId: "" },
  spotify: { clientId: "" },
  microsoft: { clientId: "" },
  linear: { clientId: "" },
  atlassian: { clientId: "" },
  vercel: { clientId: "" },
  meta: { clientId: "" },
};

export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret?: string;
  /** Where it came from. `env` = a process environment variable of the vault's name. */
  source: "vault" | "official" | "env";
}

function envName(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function clientIdCredential(provider: string): string {
  return `${envName(provider)}_OAUTH_CLIENT_ID`;
}

export function clientSecretCredential(provider: string): string {
  return `${envName(provider)}_OAUTH_CLIENT_SECRET`;
}

/** The shipped client for a provider, or undefined when none is registered. */
export function officialClientFor(provider: string): OfficialClient | undefined {
  const c = OFFICIAL_OAUTH_CLIENTS[provider];
  return c && c.clientId.trim() ? c : undefined;
}

/**
 * The client Ares should use for `provider`: the owner's own (vault/env) first,
 * else Ares's official one, else undefined (setup needed). `requireSecret`
 * means a client id without its secret does not count (confidential vendors).
 */
export async function resolveOAuthClient(
  provider: string,
  opts: { home?: string; requireSecret?: boolean; idName?: string; secretName?: string } = {},
): Promise<ResolvedOAuthClient | undefined> {
  const lookup = opts.home ? { home: opts.home } : {};
  const idName = opts.idName ?? clientIdCredential(provider);
  const id = await getCredential(idName, lookup);
  if (id) {
    const secret = await getCredential(opts.secretName ?? clientSecretCredential(provider), lookup);
    if (!opts.requireSecret || secret) {
      const names = await listCredentialNames(lookup).catch(() => [] as string[]);
      return { clientId: id, ...(secret ? { clientSecret: secret } : {}), source: names.includes(idName) ? "vault" : "env" };
    }
  }
  const official = officialClientFor(provider);
  if (official && (!opts.requireSecret || official.clientSecret)) {
    return { clientId: official.clientId, ...(official.clientSecret ? { clientSecret: official.clientSecret } : {}), source: "official" };
  }
  return undefined;
}

const CLIENT_VALUE_RE = /^[\x21-\x7e]{3,512}$/;

/** Validate what the owner pasted: printable, no spaces/newlines, sane length. */
export function validateClientValue(value: string, what: string): string | null {
  const v = value.trim();
  if (!v) return `${what} is required`;
  if (!CLIENT_VALUE_RE.test(v)) return `${what} looks wrong (3-512 printable characters, no spaces)`;
  return null;
}

/** Store the owner's own client (encrypted in the vault). Throws on a malformed value. */
export async function saveOAuthClient(
  provider: string,
  input: { clientId: string; clientSecret?: string },
  opts: { home?: string } = {},
): Promise<void> {
  const bad = validateClientValue(input.clientId, "the client id") ?? (input.clientSecret ? validateClientValue(input.clientSecret, "the client secret") : null);
  if (bad) throw new Error(bad);
  await setCredential(clientIdCredential(provider), input.clientId.trim(), opts);
  if (input.clientSecret?.trim()) await setCredential(clientSecretCredential(provider), input.clientSecret.trim(), opts);
  else await deleteCredential(clientSecretCredential(provider), opts).catch(() => false);
}

/** Forget the owner's own client (the official one, if any, then applies again). */
export async function forgetOAuthClient(provider: string, opts: { home?: string } = {}): Promise<boolean> {
  const a = await deleteCredential(clientIdCredential(provider), opts);
  const b = await deleteCredential(clientSecretCredential(provider), opts);
  return a || b;
}

/** Which providers have a client of any source (for `ares connectors clients list`). */
export async function listOAuthClients(
  providers: string[],
  opts: { home?: string } = {},
): Promise<Array<{ provider: string; source: ResolvedOAuthClient["source"] | "none"; hasSecret: boolean }>> {
  const out: Array<{ provider: string; source: ResolvedOAuthClient["source"] | "none"; hasSecret: boolean }> = [];
  for (const provider of providers) {
    const c = await resolveOAuthClient(provider, opts);
    out.push({ provider, source: c?.source ?? "none", hasSecret: Boolean(c?.clientSecret) });
  }
  return out;
}
