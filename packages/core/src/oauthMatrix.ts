// The OAuth truth matrix: for EVERY service Ares can connect, what OAuth 2.x
// really exists, with the evidence, and what the product does about it.
//
// Classes (docs/CONNECTIONS-OAUTH.md section 3 is the human version):
//   a  remote MCP + OAuth + dynamic client registration: one tap, no setup
//   b  OAuth exists but a PRE-REGISTERED client is required (no DCR, or DCR
//      with a redirect allowlist): the owner/Ares registers an app once
//   c  classic OAuth2 authorization code (+PKCE) API needing a registered app
//   d  device authorization grant (RFC 8628) for a public client id
//   e  no OAuth for third parties: API key / token / password only
//   f  no API at all: a website only (browser session, experimental)
//   n  not an account service (local/keyless connector): nothing to sign in to
//
// `verification` is mechanical (see oauthMatrix tests): LIVE-VERIFIED = a saved
// discovery document the test parses; FLOW-VERIFIED-AGAINST-MOCK = the engine
// flow for this service's kind is exercised against the in-test authorization
// server, vendor facts rest on docs; UNVERIFIED = documentation only, nothing
// exercised. This file never claims a flow works that was not exercised.

import { OAUTH_MATRIX_DATA } from "./oauthMatrixData.js";

export type OAuthClass = "a" | "b" | "c" | "d" | "e" | "f" | "n";
export type OAuthFlowKind = "mcp-dcr" | "mcp-preregistered" | "code-pkce" | "code-secret" | "device" | "api-key" | "browser" | "none";
export type VerificationLevel = "LIVE-VERIFIED" | "FLOW-VERIFIED-AGAINST-MOCK" | "UNVERIFIED";
/** How the service appears in the product. */
export type MatrixRegistry = "existing" | "added" | "excluded" | "scope";

export interface DiscoveryFacts {
  /** The issuer advertises a registration_endpoint (RFC 7591). */
  dcr: boolean;
  /** A device authorization endpoint or the device_code grant is advertised. */
  device: boolean;
  /** client_id_metadata_document_supported (CIMD). */
  cimd: boolean;
  /** code_challenge_methods_supported includes S256. */
  pkceS256: boolean;
  /** A revocation_endpoint is advertised (RFC 7009). */
  revocation: boolean;
  /** token_endpoint_auth_methods_supported includes "none" (public clients). */
  publicClient: boolean;
}

export interface OAuthMatrixEntry {
  /** The connect-registry service id (or the planned id for `added` / `excluded` rows). */
  id: string;
  label: string;
  /** The best path for a phone-driven agent. */
  class: OAuthClass;
  /** Other paths that also exist. */
  alsoClass?: OAuthClass[];
  flow: OAuthFlowKind;
  registry: MatrixRegistry;
  excludedReason?: string;
  /** Engine / client-registry provider id (the vault slot is oauth/<provider>). */
  provider?: string;
  /** `scope` rows ride this parent's token (youtube -> google). */
  parent?: string;
  /** A legacy pasted-token sibling of this OAuth service (hidden from the main list). */
  supersededBy?: string;
  endpoints: {
    issuer?: string;
    authorize?: string;
    token?: string;
    device?: string;
    revoke?: string;
    userinfo?: string;
    register?: string;
    mcp?: string;
    resource?: string;
    docs?: string;
  };
  pkce?: boolean;
  clientAuth?: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
  scopes: string[];
  scopeSeparator?: string;
  refreshTokens?: boolean;
  tokenLifetime?: string;
  redirectRules?: string;
  /** One sentence: what the owner does once (or "none"). */
  ownerSetup: string;
  setup?: {
    consoleUrl?: string;
    appType?: string;
    steps: string[];
    /** Which of client_id / client_secret the setup form takes. */
    fields: string[];
    deviceFlowCheckbox?: string;
    reviewRequired?: string;
  };
  /** false = OAuth exists but only for approved partners: no self-serve registration. */
  selfServe?: boolean;
  /** One honest sentence for the owner when the service cannot connect (class f / partner-only). */
  unsupportedReason?: string;
  /** Dynamic registration exists but allowlists redirect URIs (Vercel). */
  allowlist?: boolean;
  /** The server only accepts a loopback redirect: the phone app intercepts it. */
  loopback?: boolean;
  /** Try an Ares-hosted Client ID Metadata Document before asking for setup. */
  cimd?: boolean;
  /** The server answers an unauthenticated initialize (OAuth only unlocks more). */
  anonymousOk?: boolean;
  apiAfterConnect?: string;
  evidence: string[];
  verification: VerificationLevel;
  /** Saved bodies, relative to tests/fixtures/oauth/. */
  fixtures: string[];
  facts?: DiscoveryFacts;
  healthCheck?: { method: "GET" | "POST"; url: string };
  notes: string;
}

export const OAUTH_MATRIX: readonly OAuthMatrixEntry[] = OAUTH_MATRIX_DATA;

const BY_ID = new Map(OAUTH_MATRIX.map((e) => [e.id, e]));

export function matrixFor(id: string): OAuthMatrixEntry | undefined {
  return BY_ID.get(id) ?? OAUTH_MATRIX.find((e) => e.id === id);
}

/** The rows that ride one engine provider (client registry key / vault slot). */
export function matrixForProvider(provider: string): OAuthMatrixEntry[] {
  return OAUTH_MATRIX.filter((e) => (e.provider ?? e.id) === provider);
}

/** Pure: facts about an authorization server from its discovery document. */
export function discoveryFactsFrom(as: Record<string, unknown> | null | undefined): DiscoveryFacts | null {
  if (!as || typeof as !== "object") return null;
  if (typeof as.token_endpoint !== "string" && typeof as.device_authorization_endpoint !== "string") return null;
  const grants = Array.isArray(as.grant_types_supported) ? (as.grant_types_supported as unknown[]) : [];
  const methods = Array.isArray(as.token_endpoint_auth_methods_supported) ? (as.token_endpoint_auth_methods_supported as unknown[]) : [];
  const pkce = Array.isArray(as.code_challenge_methods_supported) ? (as.code_challenge_methods_supported as unknown[]) : [];
  return {
    dcr: typeof as.registration_endpoint === "string",
    device: typeof as.device_authorization_endpoint === "string" || grants.includes("urn:ietf:params:oauth:grant-type:device_code"),
    cimd: as.client_id_metadata_document_supported === true,
    pkceS256: pkce.includes("S256"),
    revocation: typeof as.revocation_endpoint === "string",
    publicClient: methods.includes("none"),
  };
}

export interface MatrixSummary {
  total: number;
  byClass: Record<OAuthClass, number>;
  byVerification: Record<VerificationLevel, number>;
}

export function summarizeMatrix(entries: readonly OAuthMatrixEntry[] = OAUTH_MATRIX): MatrixSummary {
  const byClass: Record<OAuthClass, number> = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, n: 0 };
  const byVerification: Record<VerificationLevel, number> = { "LIVE-VERIFIED": 0, "FLOW-VERIFIED-AGAINST-MOCK": 0, UNVERIFIED: 0 };
  for (const e of entries) {
    byClass[e.class] += 1;
    byVerification[e.verification] += 1;
  }
  return { total: entries.length, byClass, byVerification };
}
