// GENERATED ONCE from the 2026-09-30 live audit (scripts/oauth-probe.mjs + vendor docs),
// then maintained by hand: this file is the data half of oauthMatrix.ts.
// Evidence URLs are what the auditor actually read; `fixtures` are saved bodies under
// tests/fixtures/oauth/ that tests parse (no network); `verification` follows the rules in
// docs/CONNECTIONS-OAUTH.md section 3. Never mark LIVE-VERIFIED without a fixture.
import type { OAuthMatrixEntry } from "./oauthMatrix.js";

export const OAUTH_MATRIX_DATA: OAuthMatrixEntry[] = [
  {
    "id": "airtable",
    "label": "Airtable",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://airtable.com/oauth2/v1",
      "authorize": "https://airtable.com/oauth2/v1/authorize",
      "token": "https://airtable.com/oauth2/v1/token",
      "register": "https://airtable.com/oauth2/v1/register",
      "mcp": "https://mcp.airtable.com/mcp",
      "resource": "https://mcp.airtable.com/.well-known/oauth-protected-resource",
      "docs": "https://airtable.com/developers/web/api/oauth-reference"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "data.records:read",
      "data.records:write",
      "schema.bases:read",
      "workspacesAndBases:read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "60 min access / 60 day refresh, single-use rotating (docs)",
    "redirectRules": "HTTPS required (http only for localhost/127.0.0.1), public-suffix domains, no fragments (docs); DCR allowlist unknown - lead's probe",
    "ownerSetup": "none if DCR accepts Ares redirect; else register an OAuth integration at airtable.com/create/oauth (class c; PKCE mandatory, secret optional)",
    "apiAfterConnect": "mcp:https://mcp.airtable.com/mcp (or rest:https://api.airtable.com/v0)",
    "evidence": [
      "https://airtable.com/oauth2/v1/.well-known/... via https://mcp.airtable.com/.well-known/oauth-authorization-server",
      "POST https://mcp.airtable.com/mcp -> 401",
      "https://airtable.com/developers/web/api/oauth-reference"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/airtable.json",
      "idp/airtable.as.json",
      "idp/airtable.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.airtable.com/v0/meta/whoami"
    },
    "notes": "Fine as registered."
  },
  {
    "id": "atlassian",
    "label": "Atlassian Rovo (Jira/Confluence)",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3",
      "authorize": "https://auth.atlassian.com/authorize",
      "token": "https://auth.atlassian.com/oauth/token",
      "register": "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/dcr/register",
      "mcp": "https://mcp.atlassian.com/v2/mcp",
      "resource": "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp",
      "docs": "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "offline_access",
      "read:me",
      "read:jira:agent-interface",
      "write:jira:agent-interface",
      "search:jira:agent-interface",
      "read:confluence:agent-interface",
      "write:confluence:agent-interface",
      "search:confluence:agent-interface"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (offline_access scope + refresh_token grant advertised)",
    "redirectRules": "UNVERIFIED: DCR redirect acceptance for lead's probe; Atlassian docs do not state an allowlist",
    "ownerSetup": "none if v2 DCR accepts the Ares redirect; otherwise register an OAuth 2.0 (3LO) app in developer.atlassian.com",
    "apiAfterConnect": "mcp:https://mcp.atlassian.com/v2/mcp",
    "evidence": [
      "POST https://mcp.atlassian.com/v2/mcp -> 401 resource_metadata",
      "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp",
      "https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3/.well-known/oauth-authorization-server",
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server (v1 sse AS, also has /v1/register)",
      "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/atlassian.json",
      "idp/atlassian.as.json",
      "idp/atlassian.as3.json",
      "idp/atlassian.prm2.json",
      "idp/atl.oidc.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.atlassian.com/oauth/token/accessible-resources"
    },
    "notes": "REGISTRY URL STALE: docs now give https://mcp.atlassian.com/v2/mcp (live 401 + PRM, with a per-tenant AS that has DCR); registry still points at /v1/sse (v1 AS also still answers with /v1/register today, may be deprecated). Docs also mention optional API-token auth (class e). Fallback c: Atlassian 3LO app (auth.atlassian.com/authorize, audience=api.atlassian.com, prompt=consent, offline_access, refresh tokens rotating, REST via api.atlassian.com/ex/jira/{cloudid}) - UNVERIFIED docs-only. The generic OIDC doc lists a device_authorization endpoint (auth.atlassian.com/oauth/device/code) but a bogus POST returned a 302 redirect; no evidence it is usable for 3LO - do not count on it."
  },
  {
    "id": "calendly",
    "label": "Calendly",
    "class": "a",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://calendly.com/",
      "authorize": "https://calendly.com/oauth/authorize",
      "token": "https://calendly.com/oauth/token",
      "register": "https://calendly.com/oauth/register",
      "mcp": "https://mcp.calendly.com",
      "resource": "https://mcp.calendly.com/.well-known/oauth-protected-resource",
      "docs": "https://developer.calendly.com/getting-started"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp:scheduling:read",
      "mcp:scheduling:write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED (lead's DCR probe)",
    "ownerSetup": "none if DCR accepts the Ares redirect; fallback a Calendly OAuth app or Personal Access Token",
    "apiAfterConnect": "mcp:https://mcp.calendly.com",
    "evidence": [
      "https://mcp.calendly.com/.well-known/oauth-protected-resource",
      "https://calendly.com/.well-known/oauth-authorization-server",
      "POST https://mcp.calendly.com -> 401"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/calendly.json",
      "idp/calendly.as2.json",
      "idp/calendly.oidc.json",
      "idp/calendly.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.calendly.com/users/me"
    },
    "notes": "AS metadata is on calendly.com, mcp.calendly.com/.well-known/oauth-authorization-server is 404 (follow PRM). Token auth method is only 'none' (public client)."
  },
  {
    "id": "canva",
    "label": "Canva",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.canva.com",
      "authorize": "https://mcp.canva.com/authorize",
      "token": "https://mcp.canva.com/token",
      "register": "https://mcp.canva.com/register",
      "mcp": "https://mcp.canva.com/mcp",
      "resource": "https://mcp.canva.com/.well-known/oauth-protected-resource/mcp",
      "docs": "https://www.canva.dev/docs/connect/authentication/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "profile:read",
      "design:meta:read",
      "design:content:read",
      "design:content:write",
      "asset:read",
      "asset:write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh single-use per Connect docs)",
    "redirectRules": "UNVERIFIED (lead's DCR probe)",
    "ownerSetup": "none if DCR accepts the Ares redirect; else Canva Connect integration in the Developer Portal (class c, PKCE S256 required, Basic client auth)",
    "apiAfterConnect": "mcp:https://mcp.canva.com/mcp",
    "evidence": [
      "https://mcp.canva.com/.well-known/oauth-authorization-server",
      "https://mcp.canva.com/.well-known/oauth-protected-resource",
      "POST https://mcp.canva.com/mcp -> 401",
      "https://www.canva.dev/docs/connect/authentication/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/canva.json",
      "idp/canva.as.json",
      "idp/canva.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.canva.com/rest/v1/users/me"
    },
    "notes": "Scope list is from PRM; Connect scopes need explicit read AND write. Connect requires secret on token calls (not from a browser)."
  },
  {
    "id": "clickup",
    "label": "ClickUp",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.clickup.com",
      "authorize": "https://mcp.clickup.com/oauth/authorize",
      "token": "https://mcp.clickup.com/oauth/token",
      "register": "https://mcp.clickup.com/oauth/register",
      "mcp": "https://mcp.clickup.com/mcp",
      "resource": "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "read",
      "write"
    ],
    "refreshTokens": false,
    "tokenLifetime": "UNVERIFIED; AS advertises only authorization_code grant (no refresh_token) -> expect re-auth on expiry",
    "redirectRules": "UNVERIFIED (DCR probe is lead's)",
    "ownerSetup": "none if DCR accepts the Ares redirect",
    "apiAfterConnect": "mcp:https://mcp.clickup.com/mcp",
    "evidence": [
      "https://mcp.clickup.com/.well-known/oauth-authorization-server",
      "POST https://mcp.clickup.com/mcp -> 401"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/clickup.json",
      "idp/clickup.as.json",
      "idp/clickup.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "grant_types_supported is only authorization_code: refreshTokens flagged false as an observation, not proof. Classic ClickUp OAuth app (class c, app.clickup.com/api, tokens non-expiring per ClickUp docs - UNVERIFIED) is the fallback."
  },
  {
    "id": "close",
    "label": "Close CRM",
    "class": "a",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.close.com",
      "authorize": "https://app.close.com/oauth2/authorize/",
      "token": "https://api.close.com/oauth2/token/",
      "revoke": "https://api.close.com/oauth2/revoke/",
      "register": "https://api.close.com/oauth2/register/",
      "mcp": "https://mcp.close.com/mcp",
      "resource": "https://mcp.close.com/",
      "docs": "https://help.close.com/docs/mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp.read",
      "mcp.write_safe",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "offline_access scope => refresh token; lifetimes unknown",
    "redirectRules": "NOT TESTED; DCR present with token_endpoint_auth_methods none/basic/post. Lead's probe decides.",
    "ownerSetup": "none if DCR accepts the Ares redirect (mcp.write_destructive is a separate opt-in scope).",
    "apiAfterConnect": "mcp:https://mcp.close.com/mcp",
    "evidence": [
      "https://mcp.close.com/.well-known/oauth-protected-resource (fetched)",
      "https://api.close.com/.well-known/oauth-authorization-server (fetched)",
      "https://help.close.com/docs/mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/close.json",
      "idp/close.as.json",
      "idp/close.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.close.com/api/v1/me/"
    },
    "notes": "Initialize -> 401 with resource_metadata (verified). Docs also allow header Close-API-Key + Close-Scope instead of OAuth (class e fallback). Close also has classic OAuth apps (Settings > Developer > OAuth Apps) - UNVERIFIED."
  },
  {
    "id": "cloudflare-bindings",
    "label": "Cloudflare Workers (bindings)",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://bindings.mcp.cloudflare.com",
      "authorize": "https://bindings.mcp.cloudflare.com/oauth/authorize",
      "token": "https://bindings.mcp.cloudflare.com/token",
      "revoke": "https://bindings.mcp.cloudflare.com/token",
      "register": "https://bindings.mcp.cloudflare.com/register",
      "mcp": "https://bindings.mcp.cloudflare.com/mcp",
      "resource": "https://bindings.mcp.cloudflare.com/mcp",
      "docs": "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token grant advertised)",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://bindings.mcp.cloudflare.com/mcp",
    "evidence": [
      "https://bindings.mcp.cloudflare.com/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/cloudflare-bindings.json",
      "idp/cloudflare-bindings.as.json",
      "idp/cloudflare-bindings.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Registry URL is the legacy /sse path; live 401 + PRM are at /mcp (update registry or deliberately keep sse transport). Scopes come from the Cloudflare account consent screen (scopes_supported absent). CIMD advertised false. Stock workers-oauth-provider generally accepts any redirect_uri at DCR (UNVERIFIED)."
  },
  {
    "id": "cloudflare-observability",
    "label": "Cloudflare Observability",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://observability.mcp.cloudflare.com",
      "authorize": "https://observability.mcp.cloudflare.com/oauth/authorize",
      "token": "https://observability.mcp.cloudflare.com/token",
      "revoke": "https://observability.mcp.cloudflare.com/token",
      "register": "https://observability.mcp.cloudflare.com/register",
      "mcp": "https://observability.mcp.cloudflare.com/mcp",
      "resource": "https://observability.mcp.cloudflare.com/mcp",
      "docs": "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token grant advertised)",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://observability.mcp.cloudflare.com/mcp",
    "evidence": [
      "https://observability.mcp.cloudflare.com/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/cloudflare-observability.json",
      "idp/cloudflare-observability.as.json",
      "idp/cloudflare-observability.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Registry URL is the legacy /sse path; live 401 + PRM are at /mcp (update registry or deliberately keep sse transport). Scopes come from the Cloudflare account consent screen (scopes_supported absent). CIMD advertised false. Stock workers-oauth-provider generally accepts any redirect_uri at DCR (UNVERIFIED)."
  },
  {
    "id": "dodo",
    "label": "Dodo Payments",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.dodopayments.com",
      "authorize": "https://mcp.dodopayments.com/authorize",
      "token": "https://mcp.dodopayments.com/token",
      "register": "https://mcp.dodopayments.com/register",
      "mcp": "https://mcp.dodopayments.com/sse",
      "resource": "https://mcp.dodopayments.com/sse"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR present; acceptance UNKNOWN.",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.dodopayments.com/sse",
    "evidence": [
      "https://mcp.dodopayments.com/.well-known/oauth-protected-resource/sse",
      "https://mcp.dodopayments.com/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/dodo.json",
      "idp/dodo.as.json",
      "idp/dodo.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://mcp.dodopayments.com/sse"
    },
    "notes": "Metadata shape identical to Square and PayPal (same OAuth proxy stack)."
  },
  {
    "id": "exa",
    "label": "Exa",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.exa.ai",
      "authorize": "https://auth.exa.ai/oauth/authorize",
      "token": "https://auth.exa.ai/api/oauth/token",
      "revoke": "https://auth.exa.ai/api/oauth/revoke",
      "register": "https://auth.exa.ai/api/oauth/register",
      "mcp": "https://mcp.exa.ai/mcp",
      "resource": "https://mcp.exa.ai/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp:tools"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR + client_id_metadata_document supported; acceptance of the Ares https redirect UNKNOWN.",
    "ownerSetup": "none",
    "anonymousOk": true,
    "apiAfterConnect": "mcp:https://mcp.exa.ai/mcp",
    "evidence": [
      "https://mcp.exa.ai/.well-known/oauth-protected-resource",
      "https://auth.exa.ai/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/exa.json",
      "idp/exa.as.json",
      "idp/exa.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://mcp.exa.ai/mcp"
    },
    "notes": "Unauthenticated initialize returns 200 (keyless, rate-limited) AND a PRM exists pointing at auth.exa.ai, so no 401 challenge ever arrives: a client must fetch the PRM directly. AS metadata exists only at /.well-known/oauth-authorization-server (openid-configuration 404). Registry kind key is wrong: use OAuth, with keyless as fallback."
  },
  {
    "id": "fireflies",
    "label": "Fireflies.ai",
    "class": "a",
    "alsoClass": [
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.fireflies.ai/",
      "authorize": "https://api.fireflies.ai/authorize",
      "token": "https://api.fireflies.ai/token",
      "register": "https://api.fireflies.ai/register",
      "mcp": "https://api.fireflies.ai/mcp",
      "resource": "https://api.fireflies.ai/.well-known/oauth-protected-resource/mcp",
      "docs": "https://docs.fireflies.ai/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "profile",
      "email"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED (lead's DCR probe)",
    "ownerSetup": "none if DCR accepts Ares redirect; fallback an API key from the Fireflies dashboard (class e)",
    "apiAfterConnect": "mcp:https://api.fireflies.ai/mcp",
    "evidence": [
      "https://api.fireflies.ai/.well-known/oauth-authorization-server",
      "POST https://api.fireflies.ai/mcp -> 401 scope=\"email profile\""
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/fireflies.json",
      "idp/fireflies.as.json",
      "idp/fireflies.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "token endpoint path assumed 'https://api.fireflies.ai/token' - read it from fixtures/fireflies.as.json."
  },
  {
    "id": "gitlab",
    "label": "GitLab.com",
    "class": "a",
    "alsoClass": [
      "d",
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "provider": "gitlab",
    "endpoints": {
      "issuer": "https://gitlab.com",
      "authorize": "https://gitlab.com/oauth/authorize",
      "token": "https://gitlab.com/oauth/token",
      "device": "https://gitlab.com/oauth/authorize_device",
      "revoke": "https://gitlab.com/oauth/revoke",
      "userinfo": "https://gitlab.com/oauth/userinfo",
      "register": "https://gitlab.com/oauth/register",
      "mcp": "https://gitlab.com/api/v4/mcp",
      "resource": "https://gitlab.com/api/v4/mcp",
      "docs": "https://docs.gitlab.com/user/model_context_protocol/mcp_server/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp"
    ],
    "refreshTokens": true,
    "tokenLifetime": "2h access token (expires_in 7200) + refresh token",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). GitLab docs say the server supports OAuth 2.0 DCR; redirect validation rules are not documented.",
    "ownerSetup": "none if DCR accepts the https redirect (plus enable 'Allow access to the MCP server' on the group); else register a non-confidential GitLab application once and use device flow.",
    "setup": {
      "consoleUrl": "https://gitlab.com/-/user_settings/applications",
      "appType": "User-owned application, Confidential UNCHECKED (public client; PKCE/device) - only for the d/c fallback",
      "steps": [
        "Profile > Applications > Add new application",
        "Redirect URI https://ares.mistiqueai.com/oauth/callback; untick Confidential; scopes mcp (+read_api for REST)",
        "Copy Application ID (no secret needed)",
        "Enable 'Allow access to the MCP server' on the top-level group"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "none documented (UNVERIFIED which flag gates it)",
      "reviewRequired": "none"
    },
    "apiAfterConnect": "mcp:https://gitlab.com/api/v4/mcp",
    "evidence": [
      "https://gitlab.com/api/v4/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
      "https://gitlab.com/.well-known/oauth-protected-resource/api/v4/mcp (live)",
      "https://gitlab.com/.well-known/oauth-authorization-server (live)",
      "https://docs.gitlab.com/api/oauth2/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/gitlab.json",
      "idp/gitlab.as.json",
      "idp/gitlab.oidc.json",
      "idp/gitlab.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://gitlab.com/api/v4/user"
    },
    "notes": "GitLab MCP server is Beta, Free tier since 19.2; DCR feature flag removed in 18.6. TRAP: on GitLab.com a group owner must enable 'Allow access to the MCP server' for the top-level group (docs). PRM scope is 'mcp'. AS metadata (oauth-authorization-server) lists the device_code grant; device endpoint /oauth/authorize_device is alive (bogus client -> 401 invalid_client). Device flow introduced 17.2, GA 17.9. So class d fallback with a user-created GitLab application (Profile > Applications, untick Confidential). PKCE methods plain+S256. The openid-configuration doc omits registration_endpoint but the oauth-authorization-server doc has it."
  },
  {
    "id": "granola",
    "label": "Granola",
    "class": "a",
    "alsoClass": [
      "d"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp-auth.granola.ai",
      "authorize": "https://mcp-auth.granola.ai/oauth2/authorize",
      "token": "https://mcp-auth.granola.ai/oauth2/token",
      "device": "https://mcp-auth.granola.ai/oauth2/device_authorization",
      "register": "https://mcp-auth.granola.ai/oauth2/register",
      "mcp": "https://mcp.granola.ai/mcp",
      "resource": "https://mcp.granola.ai/.well-known/oauth-protected-resource"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED (lead's DCR probe)",
    "ownerSetup": "none (DCR). If an https redirect is refused, the AS advertises the device grant.",
    "apiAfterConnect": "mcp:https://mcp.granola.ai/mcp",
    "evidence": [
      "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server (grant types incl. device_code)",
      "https://mcp.granola.ai/.well-known/oauth-protected-resource",
      "bogus POST device_authorization -> 401 invalid_client 'Application not found'"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/granola.json",
      "idp/granola.as.json",
      "idp/granola.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": true,
      "cimd": true,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "Surprise: AS advertises device_code grant and a live device_authorization endpoint (invalid_client for unknown id proves it exists). Whether a DCR-registered public client may use it is for the lead to probe after DCR. PRM scope is 'mcp'; AS lists email/offline_access/openid/profile."
  },
  {
    "id": "huggingface",
    "label": "Hugging Face",
    "class": "a",
    "alsoClass": [
      "d"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://huggingface.co",
      "authorize": "https://huggingface.co/oauth/authorize",
      "token": "https://huggingface.co/oauth/token",
      "device": "https://huggingface.co/oauth/device",
      "userinfo": "https://huggingface.co/oauth/userinfo",
      "register": "https://huggingface.co/oauth/register",
      "mcp": "https://huggingface.co/mcp",
      "resource": "https://huggingface.co/mcp",
      "docs": "https://huggingface.co/docs/hub/oauth"
    },
    "pkce": true,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "openid",
      "profile",
      "read-mcp",
      "read-repos",
      "jobs",
      "contribute-repos",
      "inference-api"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "anonymousOk": true,
    "apiAfterConnect": "mcp:https://huggingface.co/mcp",
    "evidence": [
      "https://huggingface.co/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://huggingface.co/docs/hub/oauth"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/huggingface.json",
      "idp/huggingface.as.json",
      "idp/huggingface.oidc.json",
      "idp/huggingface.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": true,
      "cimd": true,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://huggingface.co/oauth/userinfo"
    },
    "notes": "Live: anonymous MCP initialize returns 200 (public tools need no auth); a token only adds user-scoped tools. PRM lists scopes read-mcp, read-repos, jobs, contribute-repos, inference-api. AS advertises DCR, CIMD (client_id_metadata_document_supported:true) AND device_authorization_endpoint (bogus POST -> 400 invalid_request listing valid scopes: endpoint alive and parsing). Device flow needs a client_id from a HF OAuth app (class d fallback); CIMD is another zero-setup candidate. Registry says oauth required - actually optional."
  },
  {
    "id": "intercom",
    "label": "Intercom",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.intercom.com",
      "authorize": "https://mcp.intercom.com/authorize",
      "token": "https://mcp.intercom.com/token",
      "revoke": "https://mcp.intercom.com/token",
      "register": "https://mcp.intercom.com/register",
      "mcp": "https://mcp.intercom.com/mcp",
      "resource": "https://mcp.intercom.com/mcp",
      "docs": "https://developers.intercom.com/docs/guides/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown (refresh_token grant advertised)",
    "redirectRules": "NOT TESTED: registration_endpoint exists; whether arbitrary https redirects are accepted is for the lead's DCR probe.",
    "ownerSetup": "none if DCR accepts the Ares redirect; otherwise bearer API token fallback (documented).",
    "apiAfterConnect": "mcp:https://mcp.intercom.com/mcp",
    "evidence": [
      "https://mcp.intercom.com/.well-known/oauth-authorization-server (fetched)",
      "https://developers.intercom.com/docs/guides/mcp (via search result; direct fetch failed DNS)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/intercom.json",
      "idp/intercom.as.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Initialize without token -> 401 'Bearer realm=OAuth' with NO resource_metadata; PRM /.well-known/oauth-protected-resource is 404, so clients must fall back to AS metadata at the origin (Ares discovery must handle that). Sandbox default DNS could not resolve mcp.intercom.com (resolved fine via 1.1.1.1) - tooling flake, not a vendor issue. EU workspaces need https://mcp.eu.intercom.com/mcp; AU not supported (per search results, unverified). Docs list a Bearer-token alternative. Legacy /sse deprecated - registry 'transport: http' is correct. US-hosted workspace + admin needed for consent."
  },
  {
    "id": "jam",
    "label": "Jam",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.jam.dev",
      "authorize": "https://api.jam.dev/oauth/authorize",
      "token": "https://api.jam.dev/oauth/token",
      "revoke": "https://api.jam.dev/oauth/revoke",
      "register": "https://api.jam.dev/oauth/register",
      "mcp": "https://mcp.jam.dev/mcp",
      "resource": "https://mcp.jam.dev/mcp",
      "docs": "https://jam.dev/docs/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp:read",
      "mcp:write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED; refresh_token grant advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.jam.dev/mcp",
    "evidence": [
      "https://mcp.jam.dev/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://jam.dev/docs/mcp"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/jam.json",
      "idp/jam.as.json",
      "idp/jam.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "WWW-Authenticate scope 'mcp:read mcp:write'. AS also lists cli:read/cli:write. Public clients ('none') and client_secret_post. PRM exposes an introspection endpoint."
  },
  {
    "id": "linear",
    "label": "Linear",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.linear.app",
      "authorize": "https://mcp.linear.app/authorize",
      "token": "https://mcp.linear.app/token",
      "register": "https://mcp.linear.app/register",
      "mcp": "https://mcp.linear.app/mcp",
      "resource": "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
      "docs": "https://linear.app/docs/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "read",
      "write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (AS lists refresh_token grant)",
    "redirectRules": "UNVERIFIED: DCR acceptance of the Ares https redirect is for the lead's probe",
    "ownerSetup": "none (if DCR accepts the https redirect)",
    "apiAfterConnect": "mcp:https://mcp.linear.app/mcp",
    "evidence": [
      "https://mcp.linear.app/.well-known/oauth-authorization-server",
      "https://mcp.linear.app/.well-known/oauth-protected-resource",
      "POST https://mcp.linear.app/mcp -> 401 WWW-Authenticate resource_metadata, scope=\"read write\"",
      "bogus POST https://mcp.linear.app/token -> invalid_client"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/linear.json",
      "idp/linear.as.json",
      "idp/linear.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Fallback class c: Linear REST OAuth app (linear.app/oauth/authorize, api.linear.app/oauth/token, GraphQL) - UNVERIFIED, not fetched. Registry kind (mcp-oauth) is correct."
  },
  {
    "id": "mailchimp",
    "label": "Mailchimp",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "excluded",
    "excludedReason": "Mailchimp's remote MCP lives under a /claude/ path that suggests client allowlisting, and the classic OAuth needs a per-datacenter API host; not wired until confirmed.",
    "endpoints": {
      "issuer": "https://ai-inc.mailchimp.com",
      "authorize": "https://ai-inc.mailchimp.com/claude/oauth/authorize",
      "token": "https://ai-inc.mailchimp.com/claude/oauth/token",
      "register": "https://ai-inc.mailchimp.com/claude/oauth/register",
      "mcp": "https://ai-inc.mailchimp.com/claude/mcp/v2",
      "resource": "https://ai-inc.mailchimp.com/claude/mcp/v2",
      "docs": "https://ai-inc.mailchimp.com/docs"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mailchimp"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown for the MCP AS (refresh_token grant advertised). Classic Mailchimp OAuth2 tokens never expire.",
    "redirectRules": "NOT TESTED. The '/claude/' path hints the DCR may allowlist Claude's callback; lead probe decides. Class c fallback: registered-app redirect, https recommended not enforced.",
    "ownerSetup": "none if DCR accepts the Ares redirect; fallback: register an app once at the Mailchimp Registered Apps page and paste client id/secret.",
    "setup": {
      "consoleUrl": "https://us1.admin.mailchimp.com/account/oauth2/",
      "appType": "Registered OAuth2 app (fallback c)",
      "steps": [
        "Create app, set redirect_uri https://ares.mistiqueai.com/oauth/callback",
        "Copy client_id and client_secret (secret shown once)",
        "Authorize at https://login.mailchimp.com/oauth2/authorize, exchange at https://login.mailchimp.com/oauth2/token, then GET https://login.mailchimp.com/oauth2/metadata for the dc (datacenter) and api_endpoint"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for personal use of own account."
    },
    "apiAfterConnect": "mcp:https://ai-inc.mailchimp.com/claude/mcp/v2 or rest:https://<dc>.api.mailchimp.com/3.0",
    "evidence": [
      "https://ai-inc.mailchimp.com/.well-known/oauth-protected-resource/claude/mcp/v2 (fetched)",
      "https://ai-inc.mailchimp.com/claude/.well-known/oauth-authorization-server (fetched)",
      "https://mailchimp.com/developer/marketing/guides/access-user-data-oauth-2/ (tokens do not expire)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/mailchimp.as.json",
      "idp/mailchimp.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "Official remote MCP exists (surprise). A plain POST initialize returns a CDN '403 Access Denied' HTML (Akamai), not 401 - the MCP endpoint may be gated by user-agent/client allowlist; a second PRM (mc-chatgpt-mcp.mailchimp.com/mcp/v2) exists for ChatGPT. Treat 'a' as provisional. Classic oauth2 metadata page returned HTML at login.mailchimp.com (no oidc/AS json)."
  },
  {
    "id": "mercadopago",
    "label": "Mercado Pago",
    "class": "a",
    "alsoClass": [
      "d"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.mercadopago.com",
      "authorize": "https://auth.mercadopago.com/mcp/authorization",
      "token": "https://mcp.mercadopago.com/oauth/token",
      "device": "https://mcp.mercadopago.com/oauth/device_authorization",
      "register": "https://mcp.mercadopago.com/oauth/register",
      "mcp": "https://mcp.mercadopago.com/mcp",
      "resource": "https://mcp.mercadopago.com",
      "docs": "https://www.mercadopago.com/developers/en/docs/mcp-server/overview"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR present; redirect acceptance UNKNOWN.",
    "ownerSetup": "none (Mercado Pago login)",
    "apiAfterConnect": "mcp:https://mcp.mercadopago.com/mcp",
    "evidence": [
      "https://mcp.mercadopago.com/.well-known/oauth-authorization-server",
      "https://mcp.mercadopago.com/.well-known/oauth-protected-resource"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/mercadopago.json",
      "idp/mercadopago.as.json",
      "idp/mercadopago.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "Unauthenticated POST /mcp returns plain 401 JSON with NO WWW-Authenticate header, so a client must go straight to /.well-known/oauth-protected-resource (200). AS metadata advertises a device_authorization_endpoint: bogus token POST gave invalid_client (alive); bogus device POST returned an HTML Mercado Libre error page (inconclusive). Device flow for DCR clients is UNVERIFIED."
  },
  {
    "id": "monday",
    "label": "monday.com",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.monday.com/mcp",
      "authorize": "https://auth.monday.com/oauth2/authorize",
      "token": "https://auth.monday.com/oauth_ms/oauth/token",
      "revoke": "https://auth.monday.com/oauth_ms/oauth/revoke",
      "register": "https://auth.monday.com/oauth_ms/oauth/register",
      "mcp": "https://mcp.monday.com/mcp",
      "resource": "https://mcp.monday.com/.well-known/oauth-protected-resource/mcp"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "me:read",
      "boards:read",
      "boards:write",
      "items:read",
      "items:write",
      "docs:read",
      "docs:write",
      "updates:read",
      "updates:write",
      "workspaces:read",
      "users:read",
      "account:read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED (DCR probe is lead's)",
    "ownerSetup": "none if DCR accepts Ares redirect; else create an OAuth app in monday Developer Center (class c).",
    "apiAfterConnect": "mcp:https://mcp.monday.com/mcp",
    "evidence": [
      "POST https://mcp.monday.com/mcp -> 401 resource_metadata",
      "https://auth.monday.com/.well-known/oauth-authorization-server (and /mcp variant)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/monday.json",
      "idp/monday.as2.json",
      "idp/monday.as3.json",
      "idp/monday.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "notes": "mcp.monday.com/.well-known/oauth-authorization-server 302-redirects to auth.monday.com (client must follow, or use the PRM authorization_servers entry https://auth.monday.com/mcp). Token endpoint auth methods are secret-only (no 'none'), so a DCR client gets a secret."
  },
  {
    "id": "neon",
    "label": "Neon",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.neon.tech",
      "authorize": "https://mcp.neon.tech/api/authorize",
      "token": "https://mcp.neon.tech/api/token",
      "revoke": "https://mcp.neon.tech/api/revoke",
      "register": "https://mcp.neon.tech/api/register",
      "mcp": "https://mcp.neon.tech/mcp",
      "resource": "https://mcp.neon.tech/mcp",
      "docs": "https://neon.com/docs/ai/neon-mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "read",
      "write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED; refresh_token grant advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.neon.tech/mcp",
    "evidence": [
      "https://mcp.neon.tech/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://neon.com/docs/ai/neon-mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/neon.json",
      "idp/neon.as.json",
      "idp/neon.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://console.neon.tech/api/v2/users/me"
    },
    "notes": "Open public DCR: neondatabase/mcp-server-neon issue #66 complains arbitrary redirect_uris can be registered (consent screen warns about dynamic clients), so the Ares https redirect is very likely accepted. Revocation at /api/revoke."
  },
  {
    "id": "netlify",
    "label": "Netlify",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://netlify-mcp.netlify.app/",
      "authorize": "https://netlify-mcp.netlify.app/oauth-server/auth",
      "token": "https://netlify-mcp.netlify.app/oauth-server/token",
      "register": "https://netlify-mcp.netlify.app/oauth-server/reg",
      "mcp": "https://netlify-mcp.netlify.app/mcp",
      "resource": "https://netlify-mcp.netlify.app/mcp",
      "docs": "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "read",
      "write",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED lifetimes; refresh_token + offline_access advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://netlify-mcp.netlify.app/mcp",
    "evidence": [
      "https://netlify-mcp.netlify.app/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/netlify.json",
      "idp/netlify.as.json",
      "idp/netlify.oidc.json",
      "idp/netlify.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "S256, public clients allowed ('none'). Scope 'claudeai' is advertised (hint of client-specific handling; acceptance of other clients unverified). Netlify MCP is its own AS in front of Netlify."
  },
  {
    "id": "notion",
    "label": "Notion (hosted MCP)",
    "class": "a",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.notion.com",
      "authorize": "https://mcp.notion.com/authorize",
      "token": "https://mcp.notion.com/token",
      "register": "https://mcp.notion.com/register",
      "mcp": "https://mcp.notion.com/mcp",
      "resource": "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
      "docs": "https://developers.notion.com/docs/authorization"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "default"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token grant advertised)",
    "redirectRules": "UNVERIFIED (DCR probe is lead's)",
    "ownerSetup": "none (if DCR accepts Ares redirect)",
    "apiAfterConnect": "mcp:https://mcp.notion.com/mcp",
    "evidence": [
      "https://mcp.notion.com/.well-known/oauth-authorization-server",
      "POST https://mcp.notion.com/mcp -> 401",
      "https://developers.notion.com/docs/authorization"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/notion.json",
      "idp/notion.as.json",
      "idp/notion.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.notion.com/v1/users/me"
    },
    "notes": "Fallbacks documented: Notion public connection OAuth (class c: api.notion.com/v1/oauth/authorize, token via Basic auth, refresh tokens, page-picker consent) and Personal Access Tokens / internal integration token (class e; the stdio 'notion-token' entry)."
  },
  {
    "id": "paypal",
    "label": "PayPal",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.paypal.com",
      "authorize": "https://mcp.paypal.com/authorize",
      "token": "https://mcp.paypal.com/token",
      "revoke": "https://mcp.paypal.com/token",
      "register": "https://mcp.paypal.com/register",
      "mcp": "https://mcp.paypal.com/mcp",
      "resource": "https://mcp.paypal.com/mcp",
      "docs": "https://developer.paypal.com/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "openid",
      "email",
      "profile"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR present; redirect acceptance UNKNOWN (lead DCR probe).",
    "ownerSetup": "none (PayPal login + consent)",
    "apiAfterConnect": "mcp:https://mcp.paypal.com/mcp",
    "evidence": [
      "https://mcp.paypal.com/mcp (401, resource_metadata)",
      "https://mcp.paypal.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.paypal.com/.well-known/oauth-authorization-server",
      "https://www.paypalobjects.com/.well-known/openid-configuration"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/paypal.json",
      "idp/paypal.as.json",
      "idp/paypal.oidc.json",
      "idp/paypal.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "token auth methods include none, so a public DCR client is possible. Separate classic path: Log in with PayPal (authorize https://www.paypal.com/signin/authorize, token https://api.paypal.com/v1/oauth2/token, client_secret_basic, needs an app + secret; identity scopes only, no payments data) - class c and not useful. Merchant REST uses client-credentials app id+secret (e-like)."
  },
  {
    "id": "perplexity",
    "label": "Perplexity",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.perplexity.ai",
      "authorize": "https://api.perplexity.ai/oauth/authorize",
      "token": "https://api.perplexity.ai/oauth/token",
      "revoke": "https://api.perplexity.ai/oauth/revoke",
      "register": "https://api.perplexity.ai/oauth/register",
      "mcp": "https://api.perplexity.ai/mcp",
      "resource": "https://api.perplexity.ai"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "perplexity_api",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR + CIMD; acceptance UNKNOWN.",
    "ownerSetup": "none (sign-in; API usage presumably billed to account API credits, UNVERIFIED)",
    "apiAfterConnect": "mcp:https://api.perplexity.ai/mcp",
    "evidence": [
      "https://api.perplexity.ai/mcp (401, resource_metadata)",
      "https://api.perplexity.ai/.well-known/oauth-protected-resource",
      "https://api.perplexity.ai/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/perplexity.json",
      "idp/perplexity.as.json",
      "idp/perplexity.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://api.perplexity.ai/mcp"
    },
    "notes": "REGISTRY URL IS WRONG: packages/core/src/mcpCatalog.ts has https://mcp.perplexity.ai/mcp, which gave an empty response from curl (not resolvable/answering); the live endpoint is https://api.perplexity.ai/mcp. Registry kind key is wrong -> oauth. PRM resource is the bare origin https://api.perplexity.ai."
  },
  {
    "id": "plaid-dashboard",
    "label": "Plaid Dashboard",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.dashboard.plaid.com",
      "authorize": "https://dashboard.plaid.com/oauth/authorize",
      "token": "https://api.dashboard.plaid.com/oauth/token",
      "register": "https://api.dashboard.plaid.com/oauth/register",
      "mcp": "https://api.dashboard.plaid.com/mcp/sse",
      "resource": "https://api.dashboard.plaid.com/mcp/sse",
      "docs": "https://plaid.com/docs/resources/mcp/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp:dashboard"
    ],
    "refreshTokens": false,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://api.dashboard.plaid.com/mcp/sse",
    "evidence": [
      "https://api.dashboard.plaid.com/mcp/sse unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://plaid.com/docs/resources/mcp/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/plaid-dashboard.json",
      "idp/plaid-dashboard.as.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "Metadata only at the API host /.well-known/oauth-authorization-server (live). No oauth-protected-resource doc (404 at root) and the MCP path returns 401 {error:Unauthorized} WITHOUT a WWW-Authenticate header, so discovery must go through the AS well-known on the host. Scope mcp:dashboard; public clients only; DCR advertised; refresh_token grant NOT advertised (sessions may need re-auth). Plaid dashboard data is sensitive - owner should confirm intent."
  },
  {
    "id": "printify",
    "label": "Printify",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.printify.com",
      "authorize": "https://mcp.printify.com/oauth/authorize",
      "token": "https://mcp.printify.com/oauth/token",
      "register": "https://mcp.printify.com/oauth/register",
      "mcp": "https://mcp.printify.com/mcp",
      "resource": "https://mcp.printify.com/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "mcp:tools"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR present; acceptance UNKNOWN.",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.printify.com/mcp",
    "evidence": [
      "https://mcp.printify.com/.well-known/oauth-protected-resource",
      "https://mcp.printify.com/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/printify.json",
      "idp/printify.as.json",
      "idp/printify.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://mcp.printify.com/mcp"
    },
    "notes": "Not present in packages/core/src/mcpCatalog.ts (I could not find it there); URL taken from the brief assumption and confirmed live. Classic Printify API uses a personal access token (class e) as fallback, UNVERIFIED."
  },
  {
    "id": "prisma",
    "label": "Prisma Postgres",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.prisma.io",
      "authorize": "https://auth.prisma.io/authorize",
      "token": "https://auth.prisma.io/token",
      "register": "https://auth.prisma.io/register",
      "mcp": "https://mcp.prisma.io/mcp",
      "resource": "https://mcp.prisma.io/mcp",
      "docs": "https://www.prisma.io/docs/postgres/integrations/mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "workspace:admin",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED; offline_access scope advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.prisma.io/mcp",
    "evidence": [
      "https://mcp.prisma.io/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://www.prisma.io/docs/postgres/integrations/mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/prisma.json",
      "idp/prisma.as.json",
      "idp/prisma.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "notes": "PRM scopes: workspace:admin, offline_access. Public clients ('none') allowed."
  },
  {
    "id": "semgrep",
    "label": "Semgrep",
    "class": "a",
    "alsoClass": [
      "d"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://login.semgrep.dev",
      "authorize": "https://login.semgrep.dev/oauth2/authorize",
      "token": "https://login.semgrep.dev/oauth2/token",
      "device": "https://login.semgrep.dev/oauth2/device_authorization",
      "userinfo": "https://login.semgrep.dev/oauth2/userinfo",
      "register": "https://login.semgrep.dev/oauth2/register",
      "mcp": "https://mcp.semgrep.ai/mcp",
      "resource": "https://mcp.semgrep.ai/mcp",
      "docs": "https://semgrep.dev/docs/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "openid",
      "profile",
      "email",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED; offline_access advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.semgrep.ai/mcp",
    "evidence": [
      "https://mcp.semgrep.ai/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://semgrep.dev/docs/mcp"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/semgrep.json",
      "idp/semgrep.as.json",
      "idp/semgrep.oidc.json",
      "idp/semgrep.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://login.semgrep.dev/oauth2/userinfo"
    },
    "notes": "REGISTRY KIND WRONG: mcpCatalog lists auth:'none' but live unauthenticated initialize returns 401 + resource_metadata, so OAuth is required. AS (login.semgrep.dev) has DCR (oauth2/register, present in the oauth-authorization-server doc, absent from the OIDC doc) AND device_authorization_endpoint (bogus POST -> 401 invalid_client 'Application not found', alive). Auth methods none/client_secret_*, so public clients OK."
  },
  {
    "id": "sentry",
    "label": "Sentry",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.sentry.dev",
      "authorize": "https://mcp.sentry.dev/oauth/authorize",
      "token": "https://mcp.sentry.dev/oauth/token",
      "revoke": "https://mcp.sentry.dev/oauth/token",
      "register": "https://mcp.sentry.dev/oauth/register",
      "mcp": "https://mcp.sentry.dev/mcp",
      "resource": "https://mcp.sentry.dev/mcp",
      "docs": "https://docs.sentry.io/product/sentry-mcp/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "org:read",
      "project:write",
      "team:write",
      "event:write",
      "alerts:write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED; refresh_token grant advertised",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.sentry.dev/mcp",
    "evidence": [
      "https://mcp.sentry.dev/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://docs.sentry.io/product/sentry-mcp/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/sentry.json",
      "idp/sentry.as.json",
      "idp/sentry.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://sentry.io/api/0/"
    },
    "notes": "Sentry hosts its own AS in front of sentry.io; DCR AND CIMD (client_id_metadata_document_supported:true) both advertised - two routes to zero-setup. Self-hosted Sentry is not covered by mcp.sentry.dev."
  },
  {
    "id": "square",
    "label": "Square",
    "class": "a",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.squareup.com",
      "authorize": "https://mcp.squareup.com/authorize",
      "token": "https://mcp.squareup.com/token",
      "revoke": "https://mcp.squareup.com/token",
      "register": "https://mcp.squareup.com/register",
      "mcp": "https://mcp.squareup.com/sse",
      "resource": "https://mcp.squareup.com/sse",
      "docs": "https://developer.squareup.com/docs/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR present; redirect acceptance UNKNOWN (lead DCR probe). PKCE S256 and plain accepted.",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.squareup.com/sse",
    "evidence": [
      "https://mcp.squareup.com/sse (401, resource_metadata)",
      "https://mcp.squareup.com/.well-known/oauth-protected-resource/sse",
      "https://mcp.squareup.com/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/square.json",
      "idp/square.as.json",
      "idp/square.oidc.json",
      "idp/square.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Transport is SSE at /sse. Classic Square OAuth (https://connect.squareup.com/oauth2/authorize, token /oauth2/token, code flow + PKCE) needs a registered app; a personal access token from the developer console is the e fallback. Both UNVERIFIED (docs only). Own-account use needs no app review."
  },
  {
    "id": "stripe",
    "label": "Stripe",
    "class": "a",
    "alsoClass": [
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://access.stripe.com/mcp",
      "authorize": "https://access.stripe.com/mcp/oauth2/authorize",
      "token": "https://access.stripe.com/mcp/oauth2/token",
      "register": "https://access.stripe.com/mcp/oauth2/register",
      "mcp": "https://mcp.stripe.com",
      "resource": "https://mcp.stripe.com",
      "docs": "https://docs.stripe.com/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown (refresh_token grant advertised)",
    "redirectRules": "UNKNOWN whether DCR accepts the Ares https redirect; lead central DCR probe decides (a vs b).",
    "ownerSetup": "none (sign in to Stripe and pick the account on the consent screen)",
    "apiAfterConnect": "mcp:https://mcp.stripe.com",
    "evidence": [
      "https://mcp.stripe.com (401 + resource_metadata)",
      "https://mcp.stripe.com/.well-known/oauth-protected-resource",
      "https://mcp.stripe.com/.well-known/oauth-authorization-server",
      "https://docs.stripe.com/mcp"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/stripe.json",
      "idp/stripe.as.json",
      "idp/stripe.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "401 body also says error_code missing_api_key: the server accepts a restricted key (rk_) as Bearer too. Prefer OAuth; fallback is a Restricted API key (read-only). Stripe Connect OAuth (connect.stripe.com/oauth/authorize, scope read_only) needs a Connect platform account and is for platforms reading OTHER accounts; not useful for a personal owner (UNVERIFIED, not probed). Registry kind mcp-oauth is right."
  },
  {
    "id": "supabase",
    "label": "Supabase",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.supabase.com",
      "authorize": "https://api.supabase.com/v1/oauth/authorize",
      "token": "https://api.supabase.com/v1/oauth/token",
      "register": "https://api.supabase.com/platform/oauth/apps/register",
      "mcp": "https://mcp.supabase.com/mcp",
      "resource": "https://mcp.supabase.com/mcp",
      "docs": "https://supabase.com/docs/guides/getting-started/mcp"
    },
    "pkce": true,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "organizations:read",
      "projects:read",
      "projects:write",
      "database:read",
      "database:write",
      "analytics:read",
      "edge_functions:read",
      "edge_functions:write",
      "storage:read",
      "environment:read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token grant advertised)",
    "redirectRules": "UNVERIFIED for https://ares.mistiqueai.com/oauth/callback: RFC 7591 DCR is advertised in live AS metadata but acceptance of this https redirect is decided by the lead's DCR probe (cannot POST register). ",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.supabase.com/mcp",
    "evidence": [
      "https://mcp.supabase.com/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://supabase.com/docs/guides/getting-started/mcp"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/supabase.json",
      "idp/supabase.as.json",
      "idp/supabase.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.supabase.com/v1/organizations"
    },
    "notes": "Supabase docs: DCR is the default MCP auth; alternatives = custom OAuth app (client id+secret) or scoped PAT for CI. Token auth methods are client_secret_basic/post only (no 'none'): DCR clients receive a secret in the register response. Server flags: read_only=true, project_ref=, features=. 'supabase' MCP in this session is currently unauthenticated, consistent with needing the OAuth step."
  },
  {
    "id": "tavily",
    "label": "Tavily",
    "class": "a",
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.tavily.com/",
      "authorize": "https://mcp.tavily.com/authorize",
      "token": "https://mcp.tavily.com/token",
      "revoke": "https://mcp.tavily.com/revoke",
      "register": "https://mcp.tavily.com/register",
      "mcp": "https://mcp.tavily.com/mcp/",
      "resource": "https://mcp.tavily.com/mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "openid",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown",
    "redirectRules": "DCR + CIMD; acceptance UNKNOWN.",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://mcp.tavily.com/mcp/",
    "evidence": [
      "https://mcp.tavily.com/mcp/ (401 with scope + resource_metadata)",
      "https://mcp.tavily.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.tavily.com/.well-known/oauth-authorization-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/tavily.json",
      "idp/tavily.as.json",
      "idp/tavily.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://mcp.tavily.com/mcp/"
    },
    "notes": "PRM resource is https://mcp.tavily.com/mcp (no trailing slash) while the registry URL has one: use the PRM value as the resource indicator. Registry kind key is wrong -> oauth. Token auth: none or private_key_jwt."
  },
  {
    "id": "todoist",
    "label": "Todoist",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://todoist.com",
      "authorize": "https://todoist.com/oauth/authorize",
      "token": "https://todoist.com/oauth/access_token",
      "revoke": "https://todoist.com/api/v1/revoke",
      "register": "https://todoist.com/oauth/register",
      "mcp": "https://ai.todoist.net/mcp",
      "resource": "https://ai.todoist.net/.well-known/oauth-protected-resource/mcp",
      "docs": "https://developer.todoist.com/api/v1/#tag/Authorization"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "data:read_write",
      "task:add",
      "data:delete"
    ],
    "scopeSeparator": ",",
    "refreshTokens": true,
    "tokenLifetime": "1h access / rotating refresh (60s grace) per docs for new apps",
    "redirectRules": "UNVERIFIED for DCR; Todoist docs also describe Client ID Metadata Documents (HTTPS URL as client_id) for zero-registration public clients",
    "ownerSetup": "none (DCR / CIMD); fallback: create app in Todoist App Management console",
    "apiAfterConnect": "mcp:https://ai.todoist.net/mcp (or rest:https://api.todoist.com/api/v1)",
    "evidence": [
      "https://ai.todoist.net/.well-known/oauth-protected-resource -> authorization_servers todoist.com",
      "https://todoist.com/.well-known/oauth-authorization-server (registration_endpoint present)",
      "https://developer.todoist.com/api/v1/#tag/Authorization"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/todoist.json",
      "idp/todoist.as.json",
      "idp/todoist.oidc2.json",
      "idp/todoist.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.todoist.com/api/v1/user"
    },
    "notes": "AS metadata lives on todoist.com, NOT on ai.todoist.net (that host 404s /.well-known/oauth-authorization-server; follow PRM). PRM scopes_supported is [data:read_write]. Todoist scope separator is ',' in its docs (AS metadata silent) - UNVERIFIED."
  },
  {
    "id": "webflow",
    "label": "Webflow",
    "class": "a",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.webflow.com",
      "authorize": "https://mcp.webflow.com/oauth/authorize",
      "token": "https://mcp.webflow.com/oauth/token",
      "revoke": "https://mcp.webflow.com/oauth/token",
      "register": "https://mcp.webflow.com/oauth/register",
      "mcp": "https://mcp.webflow.com/mcp",
      "resource": "https://mcp.webflow.com/mcp",
      "docs": "https://developers.webflow.com/data/reference/oauth-app"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "unknown (refresh_token grant advertised)",
    "redirectRules": "NOT TESTED; DCR present, S256+plain, auth methods none/basic/post.",
    "ownerSetup": "none if DCR accepts the Ares redirect.",
    "setup": {
      "appType": "App with Data Client building block (fallback c for Data API v2)",
      "steps": [
        "Create app, add Data Client, set https redirect URI",
        "Workspace admin copies client secret",
        "Authorize at https://webflow.com/oauth/authorize, token at https://api.webflow.com/oauth/access_token"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Only workspace admins can see client secret; no review for own workspace (docs silent)."
    },
    "apiAfterConnect": "mcp:https://mcp.webflow.com/mcp",
    "evidence": [
      "https://mcp.webflow.com/.well-known/oauth-authorization-server (fetched)",
      "https://mcp.webflow.com/.well-known/oauth-protected-resource/sse (fetched)",
      "https://developers.webflow.com/data/reference/oauth-app"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/webflow.json",
      "idp/webflow.as.json",
      "idp/webflow.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.webflow.com/v2/token/introspect"
    },
    "notes": "Registry says sse /sse: both /sse and /mcp return 401 + resource_metadata. Prefer /mcp (streamable http); /sse works too. Registry transport should be http for /mcp."
  },
  {
    "id": "wix",
    "label": "Wix",
    "class": "a",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.wix.com",
      "authorize": "https://mcp.wix.com/authorize",
      "token": "https://mcp.wix.com/token",
      "revoke": "https://mcp.wix.com/token",
      "register": "https://mcp.wix.com/register",
      "mcp": "https://mcp.wix.com/mcp",
      "resource": "https://mcp.wix.com",
      "docs": "https://github.com/wix/wix-mcp"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "offline_access scope => refresh token; lifetimes unknown",
    "redirectRules": "NOT TESTED; lead DCR probe.",
    "ownerSetup": "none if DCR accepts the Ares redirect (docs say 'you typically do not need to create an OAuth app').",
    "apiAfterConnect": "mcp:https://mcp.wix.com/mcp",
    "evidence": [
      "https://mcp.wix.com/.well-known/oauth-protected-resource (fetched)",
      "https://mcp.wix.com/.well-known/oauth-authorization-server (fetched)",
      "search results citing wix/wix-mcp (DCR, API-key alt)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/wix.json",
      "idp/wix.as.json",
      "idp/wix.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Both /mcp (PRM .../mcp) and /sse (PRM root) return 401 + resource_metadata. Registry 'sse /sse' works but /mcp streamable http is the current endpoint. API-key + account-id fallback exists (class e)."
  },
  {
    "id": "zapier",
    "label": "Zapier MCP",
    "class": "a",
    "alsoClass": [
      "e"
    ],
    "flow": "mcp-dcr",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://mcp.zapier.com",
      "authorize": "https://mcp.zapier.com/oauth/authorize",
      "token": "https://mcp.zapier.com/api/v1/oauth/token",
      "revoke": "https://mcp.zapier.com/api/v1/oauth/revoke",
      "userinfo": "https://mcp.zapier.com/api/v1/oauth/userinfo",
      "register": "https://mcp.zapier.com/api/v1/oauth/register",
      "mcp": "https://mcp.zapier.com/api/mcp/mcp",
      "resource": "https://mcp.zapier.com/api/mcp/mcp",
      "docs": "https://docs.zapier.com/mcp/overview/how-connections-work"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "openid",
      "profile",
      "email"
    ],
    "refreshTokens": true,
    "tokenLifetime": "unknown (refresh_token grant advertised)",
    "redirectRules": "NOT TESTED; lead DCR probe. Docs say OAuth with DCR is preferred for new clients and a connection-token fallback exists.",
    "ownerSetup": "none if DCR accepts the Ares redirect; user signs in to Zapier and picks the actions/apps for the MCP server.",
    "apiAfterConnect": "mcp:https://mcp.zapier.com/api/mcp/mcp",
    "evidence": [
      "https://mcp.zapier.com/.well-known/oauth-authorization-server (fetched)",
      "https://docs.zapier.com/mcp/overview/how-connections-work",
      "https://docs.zapier.com/mcp/get-started/connect"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/zapier.json",
      "idp/zapier.as.json",
      "idp/zapier.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://mcp.zapier.com/api/v1/oauth/userinfo"
    },
    "notes": "REGISTRY KIND IS WRONG: catalog has auth 'key' (pasted connection token at mcp.zapier.com), but Zapier MCP supports OAuth + DCR now. The 401 on /api/mcp/mcp is 'Bearer realm=Zapier MCP error=invalid_token' with NO resource_metadata, and /.well-known/oauth-protected-resource is 404 - Ares must fall back to AS metadata at the origin. Do not confuse with Zapier Platform OAuth (that is Zapier acting as a client of other apps, or third parties building Zapier integrations - irrelevant here)."
  },
  {
    "id": "asana",
    "label": "Asana",
    "class": "b",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "provider": "asana",
    "endpoints": {
      "issuer": "https://app.asana.com",
      "authorize": "https://app.asana.com/-/oauth_authorize",
      "token": "https://app.asana.com/-/oauth_token",
      "mcp": "https://mcp.asana.com/v2/mcp",
      "resource": "https://mcp.asana.com/.well-known/oauth-protected-resource/v2/mcp",
      "docs": "https://developers.asana.com/docs/integrating-with-asanas-mcp-server"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token grant advertised)",
    "redirectRules": "exact redirect URL registered on the app (docs: 'Add your Redirect URL')",
    "ownerSetup": "Create an Asana MCP app in the Asana developer console, set redirect https://ares.mistiqueai.com/oauth/callback, paste client id + secret.",
    "setup": {
      "consoleUrl": "https://app.asana.com/0/my-apps",
      "appType": "app with MCP access (V2 MCP)",
      "steps": [
        "Create app in developer console",
        "Add redirect https://ares.mistiqueai.com/oauth/callback",
        "Copy client id + secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "none stated; MCP apps take no scopes (omit scope param)"
    },
    "apiAfterConnect": "mcp:https://mcp.asana.com/v2/mcp (or rest:https://app.asana.com/api/1.0)",
    "evidence": [
      "https://developers.asana.com/docs/integrating-with-asanas-mcp-server (V2: no DCR; SSE /sse deprecated, shutdown Aug 5 2026)",
      "POST https://mcp.asana.com/v2/mcp -> 401 resource_metadata",
      "https://app.asana.com/.well-known/oauth-authorization-server (no registration_endpoint)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/asana.json",
      "idp/asana.as2.json",
      "idp/asana.prm2.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://app.asana.com/api/1.0/users/me"
    },
    "notes": "REGISTRY KIND WRONG/STALE: registry says mcp-oauth sse https://mcp.asana.com/sse. Docs say that SSE endpoint was scheduled to shut down 2026-08-05 (it still returned a 401 + an AS with /register today, but do not rely on it). V2 (/v2/mcp) has NO DCR -> class b. Class c fallback: classic Asana OAuth app against the REST API (same console)."
  },
  {
    "id": "box",
    "label": "Box",
    "class": "b",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "provider": "box",
    "endpoints": {
      "issuer": "https://api.box.com",
      "authorize": "https://account.box.com/api/oauth2/authorize",
      "token": "https://api.box.com/oauth2/token",
      "revoke": "https://api.box.com/oauth2/revoke",
      "mcp": "https://mcp.box.com",
      "resource": "https://mcp.box.com/.well-known/oauth-protected-resource",
      "docs": "https://developer.box.com/guides/box-mcp/setup"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "root_readwrite",
      "ai.readwrite"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (AS lists refresh_token grant; Box docs say 60 min access / 60 day refresh from memory)",
    "redirectRules": "exact redirect URI entered in the Box Admin Console integration credentials",
    "ownerSetup": "A Box admin enables 'Box MCP server' under Admin Console > Integrations, adds integration credentials with redirect https://ares.mistiqueai.com/oauth/callback, and the owner pastes client id + secret.",
    "setup": {
      "consoleUrl": "https://app.box.com/master/integrations",
      "appType": "Box MCP server integration credentials (or a Custom App - OAuth 2.0 in the developer console for REST)",
      "steps": [
        "Admin Console > Integrations > Box MCP server > Configure",
        "Add integration credentials with the Ares redirect URI",
        "Copy Client ID + Secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "Box admin must enable MCP; docgen scope needs Enterprise Advanced"
    },
    "apiAfterConnect": "mcp:https://mcp.box.com (or rest:https://api.box.com/2.0)",
    "evidence": [
      "https://api.box.com/.well-known/oauth-authorization-server (no registration_endpoint)",
      "https://mcp.box.com/.well-known/oauth-protected-resource",
      "https://developer.box.com/guides/box-mcp/setup",
      "https://github.com/anthropics/claude-code/issues/67258 (search result: DCR unsupported)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/box.json",
      "idp/box.as2.json",
      "idp/box.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.box.com/2.0/users/me"
    },
    "notes": "Registry note 'no DCR' is correct. Personal free Box accounts are their own admin, so they can configure it. Box bare mcp.box.com/.well-known/oauth-authorization-server is 401 (use api.box.com). Box does not advertise device flow."
  },
  {
    "id": "hubspot",
    "label": "HubSpot",
    "class": "b",
    "alsoClass": [
      "c",
      "e"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "provider": "hubspot",
    "endpoints": {
      "issuer": "https://mcp.hubspot.com",
      "authorize": "https://mcp.hubspot.com/oauth/authorize/user",
      "token": "https://mcp.hubspot.com/oauth/v3/token",
      "mcp": "https://mcp.hubspot.com/anthropic",
      "resource": "https://mcp.hubspot.com",
      "docs": "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "grants authorization_code, refresh_token, client_credentials advertised; lifetimes undocumented in what I read",
    "redirectRules": "Redirect URL fixed per MCP connector at creation (docs examples use http://localhost:6274/...); exact-match. https callback presumably fine - unverified.",
    "ownerSetup": "Create a developer account, make one 'MCP connector / MCP auth app', add Ares redirect URL, paste client id + secret.",
    "setup": {
      "appType": "MCP connector (user-level app)",
      "steps": [
        "Open Development > MCP Connectors > Create MCP connector",
        "Set Redirect URL to https://ares.mistiqueai.com/oauth/callback",
        "Copy Client ID and Client Secret (scopes are NOT configured; derived from tools + user permissions)",
        "Ares uses PKCE S256 (required)",
        "Account admin must connect first, then other users"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "No marketplace review; needs a HubSpot account with developer/Development menu access and (per docs) the account admin must connect first."
    },
    "apiAfterConnect": "mcp:https://mcp.hubspot.com/anthropic",
    "evidence": [
      "https://mcp.hubspot.com/.well-known/oauth-protected-resource (fetched)",
      "https://mcp.hubspot.com/.well-known/oauth-authorization-server (fetched: no registration_endpoint, S256, client_secret_post)",
      "https://developers.hubspot.com/mcp",
      "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/hubspot.json",
      "idp/hubspot.as.json",
      "idp/hubspot.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "notes": "Catalog 'no DCR' confirmed live. Path /anthropic is a 401-with-resource_metadata (verified); /mcp is 404 - keep /anthropic or use the resource root https://mcp.hubspot.com (PRM resource value) - lead should check which accepts requests. Alternative c: classic public OAuth app at developers.hubspot.com (auth https://app.hubspot.com/oauth/authorize, token https://api.hubapi.com/oauth/v1/token) for REST - UNVERIFIED, from general knowledge. Alternative e: private app access token."
  },
  {
    "id": "instacart",
    "label": "Instacart",
    "class": "b",
    "alsoClass": [
      "e",
      "f"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://fig-mcp.instacart.com",
      "authorize": "https://www.instacart.com/oauth/authorize?addr=1",
      "token": "https://connect.instacart.com/v2/oauth/token",
      "userinfo": "https://www.instacart.com/userinfo",
      "mcp": "https://fig-mcp.instacart.com/mcp",
      "resource": "https://fig-mcp.instacart.com",
      "docs": "https://docs.instacart.com/developer_platform_api/guide/tutorials/mcp"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "connect:fig_mcp"
    ],
    "refreshTokens": true,
    "ownerSetup": "Request an Instacart Connect OAuth client (redirect https://ares.mistiqueai.com/oauth/callback), or take a Developer Platform API key for list-page creation only.",
    "selfServe": false,
    "unsupportedReason": "Instacart OAuth needs a client from its Connect partner program, and its free API only builds shareable lists.",
    "evidence": [
      "https://fig-mcp.instacart.com/.well-known/oauth-authorization-server (LIVE)",
      "https://fig-mcp.instacart.com/.well-known/oauth-protected-resource (LIVE)",
      "unauth initialize on fig-mcp.instacart.com/mcp -> 401 WWW-Authenticate resource_metadata (LIVE)",
      "https://docs.instacart.com/developer_platform_api/guide/tutorials/mcp"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/instacart.as.json",
      "idp/instacart.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "notes": "Consumer-account OAuth MCP (fig-mcp) is LIVE: auth-code + S256, client_secret_post, grants incl. refresh_token and client_credentials; NO registration_endpoint -> pre-registered client from Instacart Connect (partner program; no self-serve found -> how to obtain is UNVERIFIED). Separate self-serve Developer Platform: free API key (keys.*) as Bearer on https://mcp.instacart.com/mcp (initialize answered 200 unauthenticated, LIVE) exposes ONLY recipe-page and shopping-list-page creation (link handoff), no cart/checkout/order. For real ordering the honest fallback is f (browser)."
  },
  {
    "id": "mongodb",
    "label": "MongoDB Atlas",
    "class": "b",
    "alsoClass": [
      "a"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "provider": "mongodb",
    "endpoints": {
      "issuer": "https://authorize.mongodb.com",
      "authorize": "https://cloud.mongodb.com/oauth/authorize",
      "token": "https://authorize.mongodb.com/tokens",
      "revoke": "https://authorize.mongodb.com/tokens/revoke",
      "mcp": "https://mcp.mongodb.com/mcp",
      "resource": "https://mcp.mongodb.com/mcp",
      "docs": "https://www.mongodb.com/docs/mcp-server/overview/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (refresh_token + client_credentials + token-exchange advertised)",
    "redirectRules": "UNVERIFIED whether MongoDB accepts an Ares-hosted CIMD client_id/redirect; no DCR.",
    "ownerSetup": "Try an Ares-hosted CIMD client_id; if rejected, register an Atlas OAuth/service-account client once and paste id (+secret).",
    "cimd": true,
    "apiAfterConnect": "mcp:https://mcp.mongodb.com/mcp",
    "evidence": [
      "https://mcp.mongodb.com/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://www.mongodb.com/docs/mcp-server/overview/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/mongodb.json",
      "idp/mongodb.as.json",
      "idp/mongodb.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "NO registration_endpoint (live) so no DCR, BUT AS advertises client_id_metadata_document_supported:true (CIMD): client_id can be an https URL Ares hosts (e.g. https://ares.mistiqueai.com/oauth/client.json) whose JSON lists redirect_uris. If MongoDB honours CIMD for arbitrary hosts this is zero-setup (UNVERIFIED; may allowlist hosts). Otherwise class b: Atlas service account / OAuth client. MongoDB docs: the remote server cannot use static API keys over HTTP; the stdio mongodb-atlas-mcp-remote can use MDB_MCP_API_CLIENT_ID/SECRET. PRM resource is 'https://mcp.mongodb.com' (no /mcp path) - match when validating."
  },
  {
    "id": "pagerduty",
    "label": "PagerDuty",
    "class": "b",
    "alsoClass": [
      "e"
    ],
    "flow": "mcp-preregistered",
    "registry": "added",
    "provider": "pagerduty",
    "endpoints": {
      "issuer": "https://mcp.pagerduty.com/",
      "authorize": "https://app.pagerduty.com/global/oauth/authorize",
      "token": "https://app.pagerduty.com/global/oauth/token",
      "revoke": "https://app.pagerduty.com/global/oauth/revoke",
      "userinfo": "https://app.pagerduty.com/global/oauth/userinfo",
      "mcp": "https://mcp.pagerduty.com/mcp",
      "resource": "https://mcp.pagerduty.com/mcp",
      "docs": "https://docs.pagerduty.com/developer/oauth-functionality"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "incidents.read",
      "incidents.write",
      "services.read",
      "schedules.read",
      "oncalls.read",
      "escalation_policies.read",
      "users.read",
      "teams.read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "Classic OAuth: 30d access / 210d refresh. Scoped OAuth lifetime: see PagerDuty Private Apps docs - UNVERIFIED.",
    "redirectRules": "UNVERIFIED (docs do not state; confidential web app, https callback expected).",
    "ownerSetup": "Create a PagerDuty Scoped OAuth app once (Integrations > App Registration), set redirect https://ares.mistiqueai.com/oauth/callback + scopes, paste client_id and client_secret into Ares.",
    "setup": {
      "consoleUrl": "https://developer.pagerduty.com/",
      "appType": "Scoped OAuth (confidential, PKCE mandatory, client_secret required)",
      "steps": [
        "PagerDuty > Integrations > App Registration > New App; enable OAuth 2.0, choose Scoped OAuth",
        "Add redirect URL https://ares.mistiqueai.com/oauth/callback and the needed scopes",
        "Copy client_id and client_secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none (no device flow documented)",
      "reviewRequired": "App works immediately on the creating account; other accounts need admin install after publication. No review for single-account use."
    },
    "apiAfterConnect": "mcp:https://mcp.pagerduty.com/mcp (Authorization: Bearer <oauth token>; API-key alternative header 'Authorization: Token token=<key>') and rest:https://api.pagerduty.com",
    "evidence": [
      "https://mcp.pagerduty.com/.well-known/oauth-protected-resource/mcp (live)",
      "https://mcp.pagerduty.com/.well-known/oauth-authorization-server (live)",
      "https://docs.pagerduty.com/developer/oauth-functionality",
      "https://pagerduty.github.io/pagerduty-mcp-server/docs/remote-server/setup (search snippet: no DCR; static client creds or pre-obtained Bearer, or User API key)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/pagerduty.as.json",
      "idp/pagerduty.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.pagerduty.com/users/me"
    },
    "notes": "Remote MCP exists and is live (unauth initialize -> 401 + PRM). AS metadata has NO registration_endpoint (PagerDuty docs confirm no DCR). Grants: authorization_code, refresh_token, client_credentials (app tokens); no device grant. PRM lists ~80 granular scopes plus read/write. EU accounts: region carried in id token; EU hosts UNVERIFIED. Confidential client so the Ares backend must hold the secret."
  },
  {
    "id": "slack",
    "label": "Slack (user token via mcp.slack.com)",
    "class": "b",
    "alsoClass": [
      "c"
    ],
    "flow": "mcp-preregistered",
    "registry": "added",
    "provider": "slack",
    "endpoints": {
      "issuer": "https://mcp.slack.com",
      "authorize": "https://slack.com/oauth/v2_user/authorize",
      "token": "https://slack.com/api/oauth.v2.user.access",
      "revoke": "https://slack.com/api/auth.revoke",
      "userinfo": "https://slack.com/api/auth.test",
      "mcp": "https://mcp.slack.com/mcp",
      "resource": "https://mcp.slack.com",
      "docs": "https://docs.slack.dev/ai/slack-mcp-server/"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "search:read.public",
      "search:read.private",
      "search:read.im",
      "search:read.mpim",
      "search:read.users",
      "channels:history",
      "groups:history",
      "im:history",
      "mpim:history",
      "channels:read",
      "users:read",
      "chat:write",
      "reactions:write",
      "canvases:read"
    ],
    "scopeSeparator": ",",
    "refreshTokens": true,
    "tokenLifetime": "xoxp user token does NOT expire by default; if the app enables token rotation (irreversible) it becomes 12h access + single-use rotating refresh token. AS metadata advertises refresh_token grant.",
    "redirectRules": "Slack app 'Redirect URLs' list, exact-match. Docs say redirect_uri must be https for the normal install flow; Anthropic's own Slack MCP plugin registers http://localhost:3118/oauth/callback so loopback is accepted in practice (GitHub issue evidence). Ares https://ares.mistiqueai.com/oauth/callback is valid if added to the list.",
    "ownerSetup": "Create one Slack app in the owner's own workspace, enable Agents & AI Apps > Model Context Protocol, add the Ares redirect URL and user scopes, paste client id + secret into Ares.",
    "setup": {
      "consoleUrl": "https://api.slack.com/apps",
      "appType": "Create New App > From scratch (workspace-owned, NOT distributed/unlisted)",
      "steps": [
        "Create the app in the owner's workspace",
        "Features > Agents & AI Apps: toggle Model Context Protocol ON",
        "OAuth & Permissions > Redirect URLs: add https://ares.mistiqueai.com/oauth/callback",
        "OAuth & Permissions > User Token Scopes: add the user scopes listed (search:read.*, *:history, chat:write ...)",
        "Basic Information: copy Client ID and Client Secret; install the app to the workspace"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none - Slack has no device flow",
      "reviewRequired": "Slack docs: 'Only directory-published apps or internal apps may use MCP; unlisted apps are prohibited.' A workspace-internal (non-distributed) app should qualify; this is doc-only and NOT verified live. Marketplace review is only needed to serve other workspaces. DCR explicitly unsupported (no registration_endpoint in live AS metadata)."
    },
    "apiAfterConnect": "mcp:https://mcp.slack.com/mcp (Bearer xoxp token); REST fallback rest:https://slack.com/api",
    "evidence": [
      "https://mcp.slack.com/.well-known/oauth-protected-resource (fetched)",
      "https://mcp.slack.com/.well-known/oauth-authorization-server (fetched; no registration_endpoint, S256, client_secret_post)",
      "https://docs.slack.dev/ai/slack-mcp-server/",
      "https://docs.slack.dev/authentication/installing-with-oauth/",
      "https://docs.slack.dev/authentication/using-token-rotation/",
      "https://github.com/anthropics/claude-code/issues/37714"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/slack.as.json",
      "idp/slack.oidc.json",
      "idp/slack.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "notes": "Unauthenticated MCP initialize -> 401 + resource_metadata (verified). Not DCR: confidential client, client secret mandatory, so Ares must hold the owner's client secret (token endpoint client_secret_post). Slack also offers 'Sign in with Slack' OIDC (slack.oidc.json: openid/profile/email only, identity only, no workspace access). Scopes comma-separated in classic oauth/v2 authorize (user_scope=a,b); MCP v2_user endpoint presumably accepts the same - unverified. Existing 'slack' registry entry in the catalog does not exist yet (new id)."
  },
  {
    "id": "uber",
    "label": "Uber (rides)",
    "class": "b",
    "alsoClass": [
      "f"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.uber.com",
      "authorize": "https://auth.uber.com/oauth/v2/universal/authorize",
      "token": "https://auth.uber.com/oauth/v2/token",
      "register": "https://developer.uber.com/dashboard",
      "mcp": "https://mcp.uber.com/claude/rides-3p/mcp",
      "docs": "https://developer.uber.com/docs/riders/introduction"
    },
    "pkce": false,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "3p.rides.mcp",
      "offline_access"
    ],
    "refreshTokens": true,
    "ownerSetup": "Unknown / likely not self-serve; stay on browser for bookings.",
    "selfServe": false,
    "unsupportedReason": "Uber gates its Riders API and MCP behind partner approval, so rides need the browser for now.",
    "allowlist": true,
    "evidence": [
      "https://auth.uber.com/.well-known/openid-configuration (LIVE)",
      "https://developer.uber.com/docs/riders/introduction (\"Access to this API endpoint requires approval from Uber\"; program changing for third-party apps)",
      "MCP URL from search listings only"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/uber.oidc.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": true,
      "publicClient": false
    },
    "notes": "Riders API (profile, history, request scopes) requires Uber approval via a BD contact -> not self-serve for personal use. Hosted rides MCP (price/ETA estimates only; booking handed to the Uber app) listed at mcp.uber.com/claude/rides-3p/mcp but 403s curl, so MCP behaviour UNVERIFIED (LIVE applies only to AS metadata). An estimates-only MCP cannot book rides."
  },
  {
    "id": "ubereats",
    "label": "Uber Eats",
    "class": "b",
    "alsoClass": [
      "f"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.uber.com",
      "authorize": "https://auth.uber.com/oauth/v2/universal/authorize",
      "token": "https://auth.uber.com/oauth/v2/token",
      "register": "https://developer.uber.com/dashboard",
      "mcp": "https://mcp.ubereats.com/eats-claude/mcp",
      "docs": "https://mcpservers.org/remote-mcp-servers/uber-eats"
    },
    "pkce": false,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "eats.3p.mcp",
      "offline_access"
    ],
    "refreshTokens": true,
    "ownerSetup": "Unknown: probably needs Uber to allowlist the Ares client; otherwise browser session.",
    "selfServe": false,
    "unsupportedReason": "Uber Eats ordering via MCP needs an Uber-approved client; until then Ares uses the browser.",
    "allowlist": true,
    "evidence": [
      "https://auth.uber.com/.well-known/openid-configuration (LIVE: grants authorization_code, refresh_token, client_credentials; scopes include eats.3p.mcp, eats.customer_ordering, oauth.dcr; registration_endpoint field = developer dashboard, not RFC7591)",
      "MCP URL from search listings only (mcpservers.org 403 to fetcher)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/uber.oidc.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": true,
      "publicClient": false
    },
    "notes": "Uber AS metadata LIVE (fixtures/uber.oidc.json) lists MCP scopes (eats.3p.mcp, eats.partner.mcp, 3p.rides.mcp). Hosted Eats MCP at mcp.ubereats.com/eats-claude/mcp per third-party listings, but the host returns 403 \"access denied\" to curl (also with a browser UA), so its protected-resource metadata and DCR/allowlist behaviour are UNVERIFIED -- lead should test from the phone/browser path. The \"oauth.dcr\" scope hints DCR is gated. Likely class b with an allowlist (\"claude\" in the path suggests per-client onboarding). Verification level LIVE applies only to the AS metadata."
  },
  {
    "id": "vercel",
    "label": "Vercel",
    "class": "b",
    "alsoClass": [
      "c",
      "d"
    ],
    "flow": "mcp-preregistered",
    "registry": "existing",
    "provider": "vercel",
    "endpoints": {
      "issuer": "https://vercel.com",
      "authorize": "https://vercel.com/oauth/authorize",
      "token": "https://api.vercel.com/login/oauth/token",
      "device": "https://api.vercel.com/login/oauth/device-authorization",
      "revoke": "https://api.vercel.com/login/oauth/token/revoke",
      "userinfo": "https://api.vercel.com/login/oauth/userinfo",
      "register": "https://api.vercel.com/login/oauth/register",
      "mcp": "https://mcp.vercel.com",
      "resource": "https://mcp.vercel.com/",
      "docs": "https://vercel.com/docs/integrations/create-integration/vercel-api-integrations"
    },
    "pkce": true,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "openid",
      "offline_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "Sign-in-with-Vercel/MCP: refresh_token grant advertised (lifetimes UNVERIFIED). Integration OAuth token for the REST API: long-lived per docs, no refresh token, team-scoped via team_id.",
    "redirectRules": "MCP DCR: allowlist only (lead's finding; Ares https rejected). Integration OAuth: single Redirect URL configured in the console; localhost allowed for dev.",
    "ownerSetup": "For a REST-API OAuth token today: create a Vercel Integration (Integrations Console > Create) with Redirect URL https://ares.mistiqueai.com/oauth/callback and API scopes, give Ares its client_id + client_secret, install via https://vercel.com/integrations/<slug>/new.",
    "setup": {
      "consoleUrl": "https://vercel.com/dashboard/integrations/console",
      "appType": "Integration (connectable account / external), NOT native marketplace product",
      "steps": [
        "Dashboard > team > Integrations > Integrations Console > Create",
        "Fill the Create Integration form (name, slug, developer, emails, logo, website/docs/EULA/privacy URLs, overview, 1+ feature image; all required) and accept the Integrations Marketplace Agreement",
        "Redirect URL = https://ares.mistiqueai.com/oauth/callback; API Scopes e.g. deployment, project, domain, team, user (Read or Read/Write)",
        "Copy client_id (oac_...) + client_secret from the Credentials section",
        "Install: open https://vercel.com/integrations/<slug>/new?state=<csrf>, approve, receive ?code&teamId&configurationId, POST https://api.vercel.com/v2/oauth/access_token (client_id, client_secret, code, redirect_uri) once within 30 minutes"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "n/a",
      "reviewRequired": "Docs: submitted integrations get a Community badge and are installable via the slug URL / deploy button without marketplace listing (listing needs 500 installs + review). The doc says 'once your integration is approved'; whether approval is instant or manual for a private personal integration is UNVERIFIED."
    },
    "allowlist": true,
    "loopback": true,
    "apiAfterConnect": "rest:https://api.vercel.com (Authorization: Bearer <access_token>; append ?teamId=<team_id> when team_id non-null). Whether this token works at mcp.vercel.com is UNVERIFIED (likely not).",
    "evidence": [
      "https://mcp.vercel.com/.well-known/oauth-protected-resource (live)",
      "https://vercel.com/.well-known/oauth-authorization-server (live)",
      "https://vercel.com/docs/integrations/create-integration",
      "https://vercel.com/docs/integrations/create-integration/vercel-api-integrations",
      "https://vercel.com/docs/integrations/create-integration/submit-integration",
      "https://vercel.com/docs/connect"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/vercel.json",
      "idp/vercel.as.json",
      "idp/vercel.oidc.json",
      "idp/vercel.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.vercel.com/v2/user"
    },
    "notes": "AS metadata (live): DCR at /login/oauth/register, device_code + client_credentials + refresh grants, S256 only. Bogus device POST -> 400 invalid_client 'App not found' (alive). Sign in with Vercel (this AS) gives identity only; REST permissions beta. Vercel Connect (docs/connect, GA, per-token-request billing) is for apps DEPLOYED on Vercel obtaining third-party tokens; it is NOT a way for Ares to obtain a Vercel REST token - irrelevant. Integration tokens see only what the installer granted (all or selected projects) and scopes configured; integration is disabled (403 integration_configuration_disabled) if its owner leaves the team. Best REST path today = Integration OAuth (class c, code-secret, secret held server-side, https callback OK). Pasted access token remains the fallback. mcp.vercel.com accepts only reviewed clients: dynamic registration works for loopback redirects (http://localhost:<port>) and a few named clients, and refuses the garrison's https redirect. Ares registers with a loopback redirect and the phone app intercepts it."
  },
  {
    "id": "discord",
    "label": "Discord (user OAuth2)",
    "class": "c",
    "flow": "code-pkce",
    "registry": "added",
    "provider": "discord",
    "endpoints": {
      "issuer": "https://discord.com",
      "authorize": "https://discord.com/api/oauth2/authorize",
      "token": "https://discord.com/api/oauth2/token",
      "revoke": "https://discord.com/api/oauth2/token/revoke",
      "userinfo": "https://discord.com/api/oauth2/userinfo",
      "docs": "https://docs.discord.com/developers/topics/oauth2"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "identify",
      "guilds",
      "guilds.members.read",
      "email"
    ],
    "refreshTokens": true,
    "tokenLifetime": "access ~7d (expires_in), refresh token issued for code grant",
    "redirectRules": "Redirects registered on the app (OAuth2 > Redirects), exact-match; https allowed, localhost allowed. Ares https callback OK once registered.",
    "ownerSetup": "Create a Discord application once and register the Ares redirect; paste client id + secret.",
    "setup": {
      "consoleUrl": "https://discord.com/developers/applications",
      "appType": "New Application (no verification needed for personal use)",
      "steps": [
        "New Application",
        "OAuth2 > Redirects: add https://ares.mistiqueai.com/oauth/callback",
        "OAuth2: copy Client ID and Client Secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for identify/guilds/email. messages.read and rpc are local-RPC only (not usable by a remote agent); dm_channels.read is partner-only."
    },
    "apiAfterConnect": "rest:https://discord.com/api/v10 (/users/@me, /users/@me/guilds)",
    "evidence": [
      "https://docs.discord.com/developers/topics/oauth2 (fetched; scopes + grants: authorization code, implicit, client credentials, bot install)",
      "https://discord.com/.well-known/openid-configuration (fetched: authorize/token/userinfo, no device_authorization_endpoint)",
      "live probe: POST /api/oauth2/token with bogus ids -> 400 validation error (endpoint alive)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/discord.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://discord.com/api/v10/users/@me"
    },
    "notes": "OAuth user token is nearly useless for a personal agent: it identifies the user and lists guilds but CANNOT read messages/DMs or post (messages.read is RPC-only for a local Discord client). Real agent value requires a bot token (discord-bot). Surprise: POST https://discord.com/api/oauth2/device/authorize exists (401 code 50023 'Invalid client id' for a numeric id, 404 for random paths) but is UNDOCUMENTED and not in discovery - do not rely on it; flagged for lead only. PKCE support on Discord is not stated in the fetched docs."
  },
  {
    "id": "dropbox",
    "label": "Dropbox",
    "class": "c",
    "alsoClass": [
      "b"
    ],
    "flow": "code-pkce",
    "registry": "existing",
    "provider": "dropbox",
    "endpoints": {
      "issuer": "https://www.dropbox.com",
      "authorize": "https://www.dropbox.com/oauth2/authorize",
      "token": "https://api.dropboxapi.com/oauth2/token",
      "mcp": "https://mcp.dropbox.com/mcp",
      "resource": "https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp",
      "docs": "https://help.dropbox.com/integrations/connect-dropbox-mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
      "sharing.read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED here; Dropbox docs: short-lived access (~4h) + non-expiring refresh with token_access_type=offline",
    "redirectRules": "exact-match redirect URIs registered in the App Console (https ok) - from docs, UNVERIFIED",
    "ownerSetup": "Create a scoped 'Full Dropbox' app in the Dropbox App Console, tick the permissions, add redirect https://ares.mistiqueai.com/oauth/callback, paste the App key (PKCE needs no secret).",
    "setup": {
      "consoleUrl": "https://www.dropbox.com/developers/apps",
      "appType": "Scoped access / Full Dropbox",
      "steps": [
        "Create app",
        "Permissions tab: files.metadata.read files.content.read files.content.write sharing.read account_info.read",
        "Settings: add redirect URI",
        "Copy App key (and secret if using code-secret)"
      ],
      "fields": [
        "client_id"
      ],
      "reviewRequired": "none for a dev-mode app used by its owner (limit 500 users); production review only for distribution"
    },
    "apiAfterConnect": "mcp:https://mcp.dropbox.com/mcp (with pre-registered app) or rest:https://api.dropboxapi.com/2",
    "evidence": [
      "https://help.dropbox.com/integrations/connect-dropbox-mcp-server (DCR only for trusted clients: Claude Code/Web, ChatGPT, Cursor; others register an app and add redirect URIs)",
      "https://www.dropbox.com/.well-known/openid-configuration (no registration_endpoint)",
      "https://mcp.dropbox.com/.well-known/oauth-protected-resource/mcp",
      "POST https://mcp.dropbox.com/mcp -> 401"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/dropbox.json",
      "idp/dropbox.oidc.json",
      "idp/dropbox.prm2.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://api.dropboxapi.com/2/users/get_current_account"
    },
    "notes": "REGISTRY KIND WRONG IF it assumes plain DCR: mcp.dropbox.com DCR is allowlisted to named clients, so for Ares the MCP is class b. Easiest good path is class c REST PKCE public client (App key only). mcp.dropbox.com well-known endpoints returned HTTP 429 on first hit (rate-limited), PRM obtained on retry via /oauth-protected-resource/mcp. Team admins may block app creation."
  },
  {
    "id": "dropbox-sign",
    "label": "Dropbox Sign",
    "class": "c",
    "alsoClass": [
      "e"
    ],
    "flow": "code-secret",
    "registry": "excluded",
    "excludedReason": "Dropbox Sign OAuth rests on documentation only (no discovery document, no MCP); nothing could be exercised.",
    "endpoints": {
      "authorize": "https://app.hellosign.com/oauth/authorize",
      "token": "https://app.hellosign.com/oauth/token",
      "docs": "https://developers.hellosign.com/docs/oauth/walkthrough"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "basic_account_info",
      "request_signature",
      "signature_request_access"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "UNVERIFIED",
    "ownerSetup": "Create an API App in Dropbox Sign with OAuth, set callback, paste client id + secret (or use a plain API key).",
    "setup": {
      "consoleUrl": "https://app.hellosign.com/home/myAccount#api",
      "appType": "API App with OAuth",
      "steps": [
        "Create API App",
        "Set OAuth callback URL",
        "Copy client id + secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "UNVERIFIED (production API approval for embedded signing, not needed for personal sends)"
    },
    "apiAfterConnect": "rest:https://api.hellosign.com/v3",
    "evidence": [
      "https://developers.hellosign.com/docs/oauth/walkthrough",
      "https://developers.hellosign.com/api/reference/operation/oauthTokenGenerate/",
      "app.hellosign.com/.well-known/openid-configuration -> 404"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.hellosign.com/v3/account"
    },
    "notes": "No discovery document, no MCP. Scope names and PKCE support are from memory/docs, not verified. API key (class e) is the simple alternative for a personal account."
  },
  {
    "id": "facebook",
    "label": "Facebook (Pages)",
    "class": "c",
    "alsoClass": [
      "d",
      "f"
    ],
    "flow": "code-secret",
    "registry": "existing",
    "provider": "facebook",
    "endpoints": {
      "issuer": "https://www.facebook.com",
      "authorize": "https://www.facebook.com/v23.0/dialog/oauth",
      "token": "https://graph.facebook.com/v23.0/oauth/access_token",
      "device": "https://graph.facebook.com/v23.0/device/login",
      "userinfo": "https://graph.facebook.com/v23.0/me",
      "resource": "https://graph.facebook.com",
      "docs": "https://developers.facebook.com/docs/facebook-login/for-devices"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "public_profile",
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "pages_read_user_content",
      "pages_messaging"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "short-lived user token ~1-2h; exchange (grant_type=fb_exchange_token) for a long-lived user token ~60 days; Page access tokens derived from a long-lived user token do not expire (Meta behaviour from training knowledge, not re-fetched). No refresh_token grant",
    "redirectRules": "Exact match against 'Valid OAuth Redirect URIs'; HTTPS required for Live apps, http://localhost allowed in Development mode. Ares https tunnel OK.",
    "ownerSetup": "Create ONE Meta app (type Business) with Facebook Login for Business, add the Ares callback, keep it in Development mode; the owner (app admin) logs in and grants permissions to their Pages.",
    "setup": {
      "consoleUrl": "https://developers.facebook.com/apps/",
      "appType": "Meta app type 'Business' (use case 'Authenticate and request data from users with Facebook Login' / 'Manage everything on your Page'); labels UNVERIFIED",
      "steps": [
        "Create app > Business type; add use case/product Facebook Login for Business",
        "Facebook Login > Settings: add Valid OAuth Redirect URI https://ares.mistiqueai.com/oauth/callback",
        "Add the pages_* permissions to the configuration (for Login for Business a 'Configuration' lists permissions)",
        "Leave app in Development mode; log in with an app admin/developer/tester account who admins the Page",
        "Copy App ID + App Secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "Facebook Login > Settings > 'Login from Devices' = Yes (only if device flow wanted)",
      "reviewRequired": "None for Pages the owner administers while the app is in Development mode and the owner has a role on the app (Meta app-roles doc: admins/developers/testers can grant any permission in development). Any non-role user would require App Review + Business Verification."
    },
    "apiAfterConnect": "rest:https://graph.facebook.com/v23.0 (me/accounts then page-token calls: {page}/feed, {page}/posts, {page}/conversations, {page}/photos)",
    "evidence": [
      "https://developers.facebook.com/docs/facebook-login/for-devices (fetched)",
      "https://developers.facebook.com/docs/development/build-and-test/app-roles (fetched)",
      "https://www.facebook.com/.well-known/openid-configuration (live; Limited Login OIDC only: authorization_endpoint https://facebook.com/dialog/oauth/, response types id_token only)",
      "POST https://graph.facebook.com/v23.0/device/login with bogus access_token -> 190 'Invalid OAuth access token' (live: endpoint alive, needs app-id|client-token)",
      "POST https://graph.facebook.com/v23.0/oauth/access_token bogus -> 101 'Missing or invalid client id' (live)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [
      "idp/facebook.oidc.json"
    ],
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.facebook.com/v23.0/me?fields=id,name"
    },
    "notes": "WHAT FACEBOOK CAN DO OFFICIALLY: Pages only -- post/schedule to Pages the owner admins, read Page posts/comments/insights, moderate comments, Page inbox via Messenger Platform. PERSONAL profile: Graph gives only public_profile/email; no timeline reading, posting, friends list, groups feed, or personal Messenger via API (publish_actions gone since 2018; user_posts/user_friends need App Review and are limited). So personal Facebook feed/notifications/groups/marketplace remain browser-only (class f). DEVICE LOGIN: documented at /device/login + /device/login_status with access_token = app_id|client_token (live: endpoint exists). Scope param 'must contain Login Permissions approved for use in Login Review' (Meta doc) so in practice only public_profile/email and permissions the app has been reviewed for; whether dev-mode role-holders can request pages_* through device login was NOT verified. Prefer code flow for Pages. The fetched OIDC doc is for Limited Login (iOS) and is not a general OAuth AS. PKCE not documented for Graph login. Same Meta app + same Facebook Login token serves 'messenger'."
  },
  {
    "id": "figma",
    "label": "Figma",
    "class": "c",
    "alsoClass": [
      "b"
    ],
    "flow": "code-secret",
    "registry": "existing",
    "provider": "figma",
    "endpoints": {
      "issuer": "https://www.figma.com",
      "authorize": "https://www.figma.com/oauth",
      "token": "https://api.figma.com/v1/oauth/token",
      "register": "https://api.figma.com/v1/oauth/mcp/register",
      "mcp": "https://mcp.figma.com/mcp",
      "resource": "https://mcp.figma.com/.well-known/oauth-protected-resource",
      "docs": "https://developers.figma.com/docs/rest-api/authentication/"
    },
    "pkce": true,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "file_content:read",
      "file_metadata:read",
      "current_user:read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (Figma docs: access ~90 days, refresh token available)",
    "redirectRules": "exact-match redirect registered on the Figma app (docs-based, UNVERIFIED)",
    "ownerSetup": "Create an OAuth app at figma.com/developers/apps with redirect https://ares.mistiqueai.com/oauth/callback, paste client id + secret.",
    "setup": {
      "consoleUrl": "https://www.figma.com/developers/apps",
      "appType": "OAuth app",
      "steps": [
        "Create app",
        "Add redirect URL",
        "Copy client id + secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "private app for own use needs no review; publishing does"
    },
    "apiAfterConnect": "rest:https://api.figma.com/v1",
    "evidence": [
      "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/ (only catalog clients may connect; others join waitlist)",
      "https://mcp.figma.com/.well-known/oauth-protected-resource",
      "https://api.figma.com/.well-known/oauth-authorization-server (has /v1/oauth/mcp/register but doc says restricted)",
      "https://www.figma.com/.well-known/openid-configuration"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/figma.json",
      "idp/figma.as.json",
      "idp/figma.prm.json",
      "idp/figma.rest.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.figma.com/v1/me"
    },
    "notes": "REGISTRY KIND WRONG: mcp-oauth implies one-tap, but Figma restricts the MCP to allowlisted clients (DCR endpoint exists, per docs only catalog clients). Treat MCP as class b/unavailable; use class c REST OAuth app. MCP AS lists no 'none' client auth (secret required). Lead's DCR probe can confirm rejection."
  },
  {
    "id": "fitbit",
    "label": "Fitbit",
    "class": "c",
    "flow": "code-pkce",
    "registry": "excluded",
    "excludedReason": "Fitbit Web API support ended 2026-09-30 and the API stops working 2026-10-30; the successor (Google Health API) is not documented well enough to wire yet.",
    "endpoints": {
      "authorize": "https://www.fitbit.com/oauth2/authorize",
      "token": "https://api.fitbit.com/oauth2/token",
      "revoke": "https://api.fitbit.com/oauth2/revoke",
      "userinfo": "https://api.fitbit.com/1/user/-/profile.json",
      "resource": "https://api.fitbit.com",
      "docs": "https://dev.fitbit.com/build/reference/web-api/developer-guide/authorization/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "activity",
      "heartrate",
      "sleep",
      "profile",
      "weight",
      "oxygen_saturation",
      "temperature",
      "respiratory_rate",
      "settings",
      "nutrition",
      "location"
    ],
    "refreshTokens": true,
    "tokenLifetime": "8h access (28800s); refresh tokens single-use (doc fetched for access lifetime)",
    "redirectRules": "Registered redirect; PKCE + 'Personal' app type works without client secret (doc fetched). Not worth exploring: see notes.",
    "ownerSetup": "DO NOT BUILD: Fitbit Web API support ended 2026-09-30 and the API stops working 2026-10-30; use the Google Health API under the google provider instead.",
    "setup": {
      "consoleUrl": "https://dev.fitbit.com/apps/new",
      "appType": "Personal (legacy)",
      "steps": [
        "n/a - sunset"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "n/a"
    },
    "apiAfterConnect": "rest:https://api.fitbit.com (sunset 2026-10-30)",
    "evidence": [
      "https://dev.fitbit.com/build/reference/web-api/developer-guide/authorization/ (fetched: legacy API support ends 2026-09-30, no longer functions after 2026-10-30)",
      "https://developers.google.com/health (fetched: replacement, Google OAuth)",
      "POST https://api.fitbit.com/oauth2/token bogus -> 401 invalid_client (live: still alive today 2026-09-30)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.fitbit.com/1/user/-/profile.json"
    },
    "notes": "Today is 2026-09-30 = the legacy support end date; 30 days left. Existing Fitbit tokens do not transfer; every user must re-consent via Google OAuth (search-reported). RECOMMENDATION: do not add id 'fitbit'. If wanted, add id 'google-health' as scopes of the google provider (Google Health API, REST under /health/reference/rest; scope names/restricted status/device-flow eligibility NOT found in fetched docs -> UNVERIFIED; Google's device-flow allowed list (fetched) does not contain any health scope, so it needs the Web client + code flow)."
  },
  {
    "id": "google",
    "label": "Google (Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, Contacts)",
    "class": "c",
    "alsoClass": [
      "b",
      "d"
    ],
    "flow": "code-secret",
    "registry": "existing",
    "provider": "google",
    "endpoints": {
      "issuer": "https://accounts.google.com",
      "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
      "token": "https://oauth2.googleapis.com/token",
      "device": "https://oauth2.googleapis.com/device/code",
      "revoke": "https://oauth2.googleapis.com/revoke",
      "userinfo": "https://openidconnect.googleapis.com/v1/userinfo",
      "resource": "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1",
      "docs": "https://developers.google.com/identity/protocols/oauth2/limited-input-device"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/forms.body",
      "https://www.googleapis.com/auth/tasks",
      "https://www.googleapis.com/auth/contacts"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access; refresh does not expire in 'In production' status, but expires after 7 days while the consent screen is in 'Testing' (doc: support.google.com/cloud/answer/15549945); device-flow refresh tokens always returned",
    "redirectRules": "Web-application client: exact-match registered redirect URIs, https allowed (Ares tunnel redirect already registered by owner). Device flow needs no redirect. Google MCP servers use whatever redirect is registered on the owner's own Web client (their docs show claude.ai/antigravity callbacks but any registered one is a normal Google OAuth client).",
    "ownerSetup": "Keep the existing Web client; move the OAuth consent screen from 'Testing' to 'In production' (no verification submitted) so refresh tokens stop expiring after 7 days, and accept the one-time 'Google hasn't verified this app' screen.",
    "setup": {
      "consoleUrl": "https://console.cloud.google.com/auth/overview",
      "appType": "OAuth client type 'Web application' (full scopes). 'TVs and Limited Input devices' only if device flow is wanted and then ONLY for the 7 allowed scopes.",
      "steps": [
        "Create/choose a Cloud project; enable Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks, People APIs (plus the *MCP APIs only if the Google remote MCP path is used)",
        "Auth platform > Branding/Audience: User type External, add owner as test user",
        "Auth platform > Clients: create Web application client, add redirect https://ares.mistiqueai.com/oauth/callback",
        "Audience: click 'Publish app' to move Testing -> In production (do NOT submit for verification)",
        "Connect once; click through Advanced > 'Go to Ares (unsafe)'"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none (client type TVs and Limited Input devices instead)",
      "reviewRequired": "Sensitive scopes (calendar, drive.*, documents, spreadsheets, presentations, tasks, contacts, forms) and restricted scopes (gmail.modify/readonly/send are restricted via mail.google.com family, full drive) require Google verification for public apps; unverified 'In production' app = warning screen + permanent cap of 100 total new users, which is irrelevant for one owner (doc: support.google.com/cloud/answer/15549945). Restricted-scope security assessment is only for public distribution."
    },
    "apiAfterConnect": "existing tool Gmail/Calendar/Drive/... (REST googleapis.com) ; optional mcp:https://gmailmcp.googleapis.com/mcp/v1 etc.",
    "evidence": [
      "https://accounts.google.com/.well-known/openid-configuration (live)",
      "POST https://oauth2.googleapis.com/device/code bogus client -> 401 invalid_client 'The OAuth client was not found.' (live)",
      "https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1 (live PRM, authorization_servers accounts.google.com, no registration_endpoint anywhere)",
      "https://developers.google.com/identity/protocols/oauth2/limited-input-device",
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
      "https://support.google.com/cloud/answer/15549945"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/google.device.json",
      "idp/google.oidc.json",
      "idp/google.prm.json",
      "idp/google-calendar.prm.json",
      "idp/google-docs.prm.json",
      "idp/google-sheets.prm.json",
      "idp/google-slides.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://openidconnect.googleapis.com/v1/userinfo"
    },
    "notes": "DEVICE FLOW (live endpoint exists; allowed scopes per Google doc, verbatim list): email, openid, profile, https://www.googleapis.com/auth/drive.appdata, https://www.googleapis.com/auth/drive.file, https://www.googleapis.com/auth/youtube, https://www.googleapis.com/auth/youtube.readonly. Gmail, Calendar, full Drive, Docs, Sheets, Slides, Tasks, Contacts, Forms are NOT allowed on device flow -> device is useless for the main Google connection. Device client still needs client_secret at polling (TV-type clients get a non-confidential secret). GOOGLE REMOTE MCP: official servers exist in 'Google Workspace Developer Preview Program': gmailmcp, drivemcp, calendarmcp, docsmcp, sheetsmcp, slidesmcp, chatmcp .googleapis.com/mcp/v1 and people.googleapis.com/mcp/v1. LIVE: unauthenticated JSON-RPC initialize AND tools/list return 200 (Gmail tool list incl. 'Create draft email') -- no 401/WWW-Authenticate challenge at that layer, so the token is enforced at tools/call; PRM published at /.well-known/oauth-protected-resource/mcp/v1 (path-suffixed; root path 404) naming accounts.google.com as AS. Google docs state Dynamic Client Registration NOT supported: owner creates Web client, enables MCP APIs; so class b, not a. Scopes per PRM: gmail (mail.google.com, gmail.modify/readonly/send/compose/drafts/labels/metadata/settings.basic), drive (drive, drive.readonly, drive.file), calendar (calendar, calendar.events, calendar.readonly, ...), docs (documents(.readonly)+drive), sheets (spreadsheets(.readonly)+drive), slides (presentations(.readonly)+drive+drive.file). No Tasks/Forms/Contacts MCP in the live list except People API. Verdict: keep REST tools with the existing Web client (full coverage incl. Forms/Tasks); Google MCP is optional, adds nothing for auth. TESTING STATUS: 7-day authoriza"
  },
  {
    "id": "google-photos",
    "label": "Google Photos",
    "class": "c",
    "flow": "code-secret",
    "registry": "scope",
    "parent": "google",
    "endpoints": {
      "issuer": "https://accounts.google.com",
      "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
      "token": "https://oauth2.googleapis.com/token",
      "revoke": "https://oauth2.googleapis.com/revoke",
      "docs": "https://developers.google.com/photos/support/updates"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
      "https://www.googleapis.com/auth/photoslibrary.appendonly",
      "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata"
    ],
    "refreshTokens": true,
    "tokenLifetime": "same as google",
    "redirectRules": "Same Web client as google (device flow NOT allowed for photos scopes).",
    "ownerSetup": "Enable 'Photos Library API' and 'Google Photos Picker API' in the same Cloud project and request the photos scopes on the existing Google Web client.",
    "setup": {
      "consoleUrl": "https://console.cloud.google.com/apis/library",
      "appType": "Web application (same client as google)",
      "steps": [
        "Enable Photos Library API + Photos Picker API",
        "Add scopes to consent screen"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Picker scope is sensitive (not restricted); unverified production app works for the owner with a warning screen. Exact Picker scope string is from training knowledge, NOT verified in this run."
    },
    "apiAfterConnect": "rest:https://photospicker.googleapis.com/v1 (sessions) and https://photoslibrary.googleapis.com/v1 (app-created data only)",
    "evidence": [
      "https://developers.google.com/photos/support/updates",
      "https://developers.google.com/photos/picker/guides/get-started-picker"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "POST",
      "url": "https://photospicker.googleapis.com/v1/sessions"
    },
    "notes": "Since 2025-03-31 the scopes photoslibrary.readonly, photoslibrary.sharing and photoslibrary were removed (403). Remaining: photoslibrary.appendonly, photoslibrary.readonly.appcreateddata, photoslibrary.edit.appcreateddata -> Library API can only list/search/get media items and albums CREATED BY THE APP; shared-album operations are gone. To read the user's existing library the only route is the Picker API: create session -> user opens pickerUri in the Google Photos app/browser and chooses items -> app polls session (mediaItemsSet) -> lists/downloads only those items. So Ares can: upload photos, read what it uploaded, and ask the owner to pick photos (needs a human tap each time; cannot browse or search the library autonomously). RECOMMEND: scope-of/opt-in addition to google (same client) but NOT in the default consent, because it needs two extra APIs and is rarely needed; expose as its own registry id only for the picker handshake UX."
  },
  {
    "id": "instagram",
    "label": "Instagram",
    "class": "c",
    "alsoClass": [
      "f"
    ],
    "flow": "code-secret",
    "registry": "existing",
    "provider": "instagram",
    "endpoints": {
      "authorize": "https://www.instagram.com/oauth/authorize",
      "token": "https://api.instagram.com/oauth/access_token",
      "userinfo": "https://graph.instagram.com/v23.0/me",
      "resource": "https://graph.instagram.com",
      "docs": "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "instagram_business_basic",
      "instagram_business_manage_messages",
      "instagram_business_manage_comments",
      "instagram_business_content_publish"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "auth code 1h single-use; short-lived token 1h; long-lived token 60 days via GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=..; renewed via GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token (token must be >=24h old and unexpired). No OAuth refresh_token; the long-lived token IS the renewable credential",
    "redirectRules": "Exact match to 'OAuth redirect URIs' registered in App Dashboard (docs warn dashboard may append a trailing slash). Examples are https; Ares tunnel is https so OK. Authorize page is instagram.com login (user signs into Instagram natively, not via a controlled browser).",
    "ownerSetup": "Create ONE Meta app with the Instagram use case, set Business Login redirect URI to the Ares tunnel callback, add the owner's Instagram account as Instagram Tester (accept in Instagram > Apps and Websites > Tester invitations), and convert that Instagram account to a free Professional (Creator/Business) account.",
    "setup": {
      "consoleUrl": "https://developers.facebook.com/apps/",
      "appType": "Meta app (Business type, 'Instagram' use case / product 'Instagram API with Instagram Login'); console labels are UNVERIFIED, Meta redesigns them often",
      "steps": [
        "developers.facebook.com > Create app > use case Instagram (manage messaging and content) ",
        "Instagram > API setup with Instagram login > Business login settings: add OAuth redirect URI https://ares.mistiqueai.com/oauth/callback",
        "App roles > Roles > Add People > Instagram Tester: add the Instagram account; accept the invitation inside Instagram",
        "Instagram app itself: Settings > Account type and tools > Switch to professional account (Creator is fine; free)",
        "Copy Instagram app ID + Instagram app secret (NOT the Facebook app id/secret) into Ares"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none (no device flow for Instagram Login)",
      "reviewRequired": "None while the app stays in Development mode and the only authorizing account has a role on the app: Standard Access (default) works for app admins/developers/testers without App Review (Meta app-roles doc: roles 'can grant the app any permission while it is in development'; Instagram docs: Advanced Access = App Review + Business Verification, only for accounts you do not own). For a single owner this never has to be requested."
    },
    "apiAfterConnect": "rest:https://graph.instagram.com/v23.0 (me, me/media, me/conversations?platform=instagram, {comment-id}/replies, me/media_publish, me/messages)",
    "evidence": [
      "https://developers.facebook.com/docs/instagram-platform/overview (fetched)",
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login (fetched)",
      "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login (fetched)",
      "https://developers.facebook.com/docs/development/build-and-test/app-roles (fetched)",
      "POST https://api.instagram.com/oauth/access_token bogus client -> 400 'bad request' (live: host alive, no structured error)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.instagram.com/v23.0/me?fields=user_id,username,account_type"
    },
    "notes": "PRECISE TRUTH. (1) Instagram Basic Display API (the only personal-account API) was shut down 2024-12-04; nothing replaced it for personal accounts. Meta's own overview says neither login type supports personal accounts. (A third-party SEO blog claims the new API 'supports personal accounts': that contradicts Meta's docs - ignore.) (2) Official path = 'Instagram API with Instagram Login' (Business Login for Instagram): Instagram Professional (Business or Creator) accounts only, no Facebook Page needed. Scopes instagram_business_basic / _manage_messages / _manage_comments / _content_publish (old instagram_basic style names deprecated Jan 2025). Can do: read profile + media + insights, publish posts/reels/stories (content_publish), read/reply/hide comments, mentions, send and read DMs (messaging window rule: replies within 24h of the user's last message; reading conversations list works). (3) Alternative 'Facebook Login for Business' path requires the IG professional account linked to a Facebook Page and scopes pages_show_list, pages_read_engagement, instagram_basic, instagram_manage_comments, instagram_manage_messages, instagram_content_publish, instagram_manage_insights; adds nothing for a single owner except Page-level features -- prefer Instagram Login. (4) Facebook Login for Devices (device/login) is a Facebook-Login feature; NOT documented for Instagram scopes -> assume no device flow. (5) Personal (non-professional) Instagram DMs/feed/Stories viewing/following/liking remain browser-only (class f) -- Meta offers no API. Converting the account to Creator is the one-click unblock; it is free, reversible, changes some profile UI (and creator accounts can still be private? NO: professional accounts lose private-account mode in some regions; owner must accept that). Token"
  },
  {
    "id": "linkedin",
    "label": "LinkedIn",
    "class": "c",
    "alsoClass": [
      "f"
    ],
    "flow": "code-secret",
    "registry": "added",
    "provider": "linkedin",
    "endpoints": {
      "issuer": "https://www.linkedin.com/oauth",
      "authorize": "https://www.linkedin.com/oauth/v2/authorization",
      "token": "https://www.linkedin.com/oauth/v2/accessToken",
      "revoke": "https://www.linkedin.com/oauth/v2/revoke",
      "userinfo": "https://api.linkedin.com/v2/userinfo",
      "resource": "https://api.linkedin.com/rest",
      "docs": "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "openid",
      "profile",
      "email",
      "w_member_social"
    ],
    "refreshTokens": false,
    "tokenLifetime": "access token ~60 days; programmatic refresh tokens only for approved partners (training knowledge, not re-verified)",
    "redirectRules": "Exact match to Authorized redirect URLs on the app (https allowed).",
    "ownerSetup": "Create a LinkedIn developer app (requires associating a LinkedIn Company Page), add the 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn' products (self-serve), register the callback, paste client id + secret.",
    "setup": {
      "consoleUrl": "https://www.linkedin.com/developers/apps",
      "appType": "Standard app with products Sign In with LinkedIn using OpenID Connect + Share on LinkedIn",
      "steps": [
        "Create app (needs a Company Page; create a throwaway page and verify it)",
        "Products tab: request 'Sign In with LinkedIn using OpenID Connect' and 'Share on LinkedIn' (instant, self-serve)",
        "Auth tab: add redirect URL https://ares.mistiqueai.com/oauth/callback; copy Client ID + Primary Client Secret",
        "Owner verifies the app (Company Page admin verification link) once"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "OpenID and w_member_social are self-serve. r_member_social (reading own posts) is RESTRICTED to approved users only (Posts API doc fetched). Reading feed, messaging, connections, search: no API for individuals."
    },
    "apiAfterConnect": "rest:https://api.linkedin.com/rest/posts (headers Linkedin-Version: YYYYMM, X-Restli-Protocol-Version: 2.0.0)",
    "evidence": [
      "https://www.linkedin.com/oauth/.well-known/openid-configuration (live)",
      "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api (fetched)",
      "https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 (fetched)",
      "POST https://www.linkedin.com/oauth/v2/accessToken bogus -> 401 invalid_request (live); POST .../v2/deviceAuthorization -> 401 HTML (no device flow)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/linkedin.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.linkedin.com/v2/userinfo"
    },
    "notes": "Personal use = identity + publishing as the member (w_member_social: post, comment, like). Posts API requires version header; Marketing version 202510 sunsets 2026-10-15 so pin a newer YYYYMM. Everything else (messages, feed, connections, profile search, notifications) is browser-only (f) for individuals. PKCE not documented. The OIDC doc lists no refresh scope."
  },
  {
    "id": "messenger",
    "label": "Messenger (Page inbox)",
    "class": "c",
    "alsoClass": [
      "f"
    ],
    "flow": "code-secret",
    "registry": "scope",
    "provider": "facebook",
    "parent": "facebook",
    "endpoints": {
      "issuer": "https://www.facebook.com",
      "authorize": "https://www.facebook.com/v23.0/dialog/oauth",
      "token": "https://graph.facebook.com/v23.0/oauth/access_token",
      "userinfo": "https://graph.facebook.com/v23.0/me",
      "resource": "https://graph.facebook.com",
      "docs": "https://developers.facebook.com/docs/messenger-platform/overview"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "pages_show_list",
      "pages_messaging",
      "pages_manage_metadata"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "Page access token (non-expiring when derived from a long-lived user token; training knowledge)",
    "redirectRules": "Same as facebook.",
    "ownerSetup": "Same Meta app as facebook; add the Messenger product, subscribe the app to the Page, and use the owner's Facebook Page.",
    "setup": {
      "consoleUrl": "https://developers.facebook.com/apps/",
      "appType": "Meta Business app with Messenger use case",
      "steps": [
        "Add Messenger product to the same app",
        "Generate / obtain Page access token via the Facebook Login flow (me/accounts)",
        "Subscribe the app to Page webhooks (messages) -- needs a public https webhook; Ares tunnel works"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Standard Access (default) works for users with roles on the app/Page in Development mode; Advanced Access (App Review) needed to message arbitrary users. Owner-only use needs no review."
    },
    "apiAfterConnect": "rest:https://graph.facebook.com/v23.0/me/messages and {page}/conversations (Page token)",
    "evidence": [
      "https://developers.facebook.com/docs/messenger-platform/overview (fetched)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.facebook.com/v23.0/me/conversations?platform=messenger"
    },
    "notes": "Messenger Platform supports ONLY Facebook Pages (and IG Professional accounts), NOT personal Messenger accounts (Meta doc). 24-hour standard messaging window to reply to users. So 'my personal Messenger chats' = browser-only (class f); 'my Page's inbox' = official OAuth. Treat this as the same token as facebook (consider folding into facebook scopes)."
  },
  {
    "id": "quickbooks",
    "label": "QuickBooks Online",
    "class": "c",
    "alsoClass": [
      "e"
    ],
    "flow": "code-secret",
    "registry": "excluded",
    "excludedReason": "QuickBooks needs the per-company realmId captured from the redirect and Intuit's production-key review before it can reach a real company.",
    "endpoints": {
      "issuer": "https://oauth.platform.intuit.com/op/v1",
      "authorize": "https://appcenter.intuit.com/connect/oauth2",
      "token": "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      "revoke": "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
      "userinfo": "https://accounts.platform.intuit.com/v1/openid_connect/userinfo",
      "docs": "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0"
    },
    "pkce": false,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "com.intuit.quickbooks.accounting",
      "openid",
      "profile",
      "email"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access / ~100d refresh, rotating (docs)",
    "redirectRules": "Exact-match redirect URIs registered per app; https required for production keys, localhost allowed for development keys (docs).",
    "ownerSetup": "Create an Intuit developer app, add the redirect URI, paste client id+secret; production keys needed for the real company.",
    "setup": {
      "consoleUrl": "https://developer.intuit.com/app/developer/dashboard",
      "appType": "QuickBooks Online and Payments app",
      "steps": [
        "Create app, select Accounting scope",
        "Keys and credentials: add redirect https://ares.mistiqueai.com/oauth/callback",
        "Copy client id and secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "Development keys reach only sandbox companies; production keys (needed for the owner real company) require Intuit app-assessment questionnaire (privacy/EULA URLs). Strictness for private use UNVERIFIED."
    },
    "apiAfterConnect": "rest:https://quickbooks.api.intuit.com/v3/company/{realmId}",
    "evidence": [
      "https://developer.api.intuit.com/.well-known/openid_configuration",
      "https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/quickbooks.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": true,
      "publicClient": false
    },
    "notes": "Only the OIDC discovery doc is live-verified (no device endpoint, PKCE not advertised); the rest is docs knowledge. realmId arrives in the callback query string and must be stored."
  },
  {
    "id": "reddit",
    "label": "Reddit",
    "class": "c",
    "alsoClass": [
      "f"
    ],
    "flow": "code-secret",
    "registry": "added",
    "provider": "reddit",
    "endpoints": {
      "authorize": "https://www.reddit.com/api/v1/authorize",
      "token": "https://www.reddit.com/api/v1/access_token",
      "revoke": "https://www.reddit.com/api/v1/revoke_token",
      "userinfo": "https://oauth.reddit.com/api/v1/me",
      "resource": "https://oauth.reddit.com",
      "docs": "https://github.com/reddit-archive/reddit/wiki/OAuth2"
    },
    "pkce": false,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "identity",
      "read",
      "history",
      "mysubreddits",
      "submit",
      "vote",
      "privatemessages",
      "save"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access; refresh token only with duration=permanent at authorize (doc fetched)",
    "redirectRules": "Exact match to the redirect uri registered on the app; https allowed. 'installed app' type has no secret (empty password in basic auth).",
    "ownerSetup": "Since 2025-11-11 new Reddit API apps need Reddit's manual approval (Responsible Builder Policy, ~2-4 weeks, may be denied); an existing grandfathered app still works.",
    "setup": {
      "consoleUrl": "https://www.reddit.com/prefs/apps",
      "appType": "'web app' (secret, redirect) or 'installed app' (no secret); script type for single-user headless",
      "steps": [
        "Submit a Responsible Builder Policy / Data API access request at https://support.reddithelp.com (form linked from the policy) and wait for approval",
        "After approval: reddit.com/prefs/apps > create app (web app), redirect https://ares.mistiqueai.com/oauth/callback",
        "Copy client id (under app name) + secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Manual pre-approval of EVERY new app incl. personal projects (search-reported; vendor policy page not fetched in this run)."
    },
    "apiAfterConnect": "rest:https://oauth.reddit.com",
    "evidence": [
      "https://github.com/reddit-archive/reddit/wiki/OAuth2 (fetched; archived docs)",
      "web search: Reddit Responsible Builder Policy Nov 2025 (third-party blogs; not a Reddit page)",
      "POST https://www.reddit.com/api/v1/access_token with basic bogus -> 401 Unauthorized (live: endpoint alive; GET /.well-known/openid-configuration -> 403)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://oauth.reddit.com/api/v1/me"
    },
    "notes": "OAuth technically exists and standard (code flow, permanent refresh), but app creation is gated by approval since Nov 2025, so for a brand-new owner the practical class is f (browser) until/unless approval arrives. Classification evidence for the gate is third-party reporting; the owner should try the 'create app' button at reddit.com/prefs/apps first -- if it still works, class c is immediately usable."
  },
  {
    "id": "salesforce",
    "label": "Salesforce",
    "class": "c",
    "alsoClass": [
      "d"
    ],
    "flow": "code-pkce",
    "registry": "added",
    "provider": "salesforce",
    "endpoints": {
      "issuer": "https://login.salesforce.com",
      "authorize": "https://login.salesforce.com/services/oauth2/authorize",
      "token": "https://login.salesforce.com/services/oauth2/token",
      "revoke": "https://login.salesforce.com/services/oauth2/revoke",
      "userinfo": "https://login.salesforce.com/services/oauth2/userinfo",
      "resource": "https://api.salesforce.com/platform/mcp/v1/platform/sobject-all",
      "docs": "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/postman.html"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "api",
      "refresh_token",
      "mcp_api"
    ],
    "refreshTokens": true,
    "tokenLifetime": "per org session settings; refresh_token scope gives long-lived refresh token",
    "redirectRules": "ECA callback URL list is exact-match; docs example uses https://claude.ai/api/mcp/auth_callback. Device flow needs no redirect. My-domain / instance URL differs per org (login.salesforce.com for prod/dev edition, test.salesforce.com sandbox).",
    "ownerSetup": "In their Salesforce org, create one External Client App (OAuth scopes api/refresh_token/mcp_api, PKCE on, device flow enabled), paste consumer key; activate the hosted MCP servers in Setup > API Catalog > MCP Servers.",
    "setup": {
      "appType": "External Client App (Connected Apps are being deprecated for new creation)",
      "steps": [
        "Enable OAuth settings; callback URL https://ares.mistiqueai.com/oauth/callback (required field even for device flow)",
        "Scopes: Manage user data via APIs (api), Perform requests at any time (refresh_token), Access MCP servers (mcp_api)",
        "Enable 'Require PKCE'; enable 'Issue JWT-based access tokens for named users' (required for MCP per setup guides); turn on device flow ('Enable Device Flow')",
        "Setup > API Catalog > MCP Servers: activate the hosted servers needed",
        "Copy Consumer Key (client_id); public client needs no secret for device flow"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Enable Device Flow (in ECA OAuth flow enablement; label recalled from docs, not verified)",
      "reviewRequired": "Needs a Salesforce org (free Developer Edition works for the REST API; hosted MCP availability by edition not verified). No app review for own-org use."
    },
    "apiAfterConnect": "rest:https://<instance_url>/services/data/v62.0 (instance_url returned by token) or mcp:https://api.salesforce.com/platform/mcp/v1/<server>",
    "evidence": [
      "https://login.salesforce.com/.well-known/openid-configuration (fetched: auth-code + refresh only, S256 only, registration_endpoint listed, NO device grant advertised)",
      "https://api.salesforce.com/.well-known/oauth-protected-resource/platform/mcp/v1/platform/sobject-all (fetched: scopes mcp_api, refresh_token)",
      "https://api.salesforce.com/.well-known/oauth-authorization-server (fetched: client_secret_post only, no registration_endpoint)",
      "live: POST /services/oauth2/token response_type=device_code client_id=bogus -> {\"error\":\"invalid_client_id\"} (endpoint answers device requests)",
      "https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/postman.html (via search; page 403 to fetch)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/salesforce.as.json",
      "idp/salesforce.oidc.json",
      "idp/salesforce.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://login.salesforce.com/services/oauth2/userinfo"
    },
    "notes": "Device flow existence: documented by Salesforce, but discovery metadata does not advertise it and I could not complete a real device request (no client). Treat as unverified; auth-code+PKCE is the verified path. Hosted MCP AS metadata says client_secret_post only, so an MCP-token via device flow may need the secret - unverified. Registry id is NEW. Salesforce hosts a login redirect for each org (my domain); prod/dev edition login.salesforce.com, sandboxes test.salesforce.com."
  },
  {
    "id": "shopify-store",
    "label": "Shopify store (Admin API)",
    "class": "c",
    "alsoClass": [
      "e",
      "a"
    ],
    "flow": "code-secret",
    "registry": "excluded",
    "excludedReason": "Shopify OAuth is per store ({shop}.myshopify.com) and needs a Dev Dashboard app per store; not shippable generically in this pass.",
    "endpoints": {
      "docs": "https://shopify.dev/docs/apps/build/authentication-authorization"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "read_products",
      "read_orders",
      "read_customers",
      "read_inventory"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "legacy offline token does not expire; Dev Dashboard apps (since Jan 2026) support client-credentials grant with short-lived tokens (UNVERIFIED detail)",
    "redirectRules": "Redirect URLs must be whitelisted in app config; https exact match; install is per-store ({shop}).",
    "ownerSetup": "Create an app in the Shopify Dev Dashboard, set scopes, install on own store, paste client id+secret (or a legacy shpat_ token).",
    "setup": {
      "consoleUrl": "https://dev.shopify.com/dashboard",
      "appType": "Custom app (own store, custom distribution)",
      "steps": [
        "Dev Dashboard > Create app",
        "Set Admin API scopes and redirect URL https://ares.mistiqueai.com/oauth/callback",
        "Install on your store",
        "Copy client id and secret"
      ],
      "fields": [
        "client_id",
        "client_secret",
        "shop"
      ],
      "reviewRequired": "None for an app installed on your own store; App Store listing review not needed."
    },
    "apiAfterConnect": "rest:https://{shop}.myshopify.com/admin/api/2026-07/graphql.json",
    "evidence": [
      "https://shopify.dev/docs/apps/build/storefront-mcp/servers/customer-account",
      "web search results 2026 on Dev Dashboard client credentials"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "notes": "No global discovery: OAuth is per-store, per-app, never class a. Storefront MCP https://{shop}.myshopify.com/api/mcp is unauthenticated (public catalog/cart). Customer Accounts MCP uses code+PKCE for shoppers, not the merchant. API version string is a guess; use the current stable one."
  },
  {
    "id": "spotify",
    "label": "Spotify",
    "class": "c",
    "flow": "code-pkce",
    "registry": "existing",
    "provider": "spotify",
    "endpoints": {
      "issuer": "https://accounts.spotify.com",
      "authorize": "https://accounts.spotify.com/authorize",
      "token": "https://accounts.spotify.com/api/token",
      "revoke": "https://accounts.spotify.com/oauth2/revoke/v1",
      "userinfo": "https://api.spotify.com/v1/me",
      "resource": "https://api.spotify.com/v1",
      "docs": "https://developer.spotify.com/documentation/web-api/concepts/redirect_uri"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "user-read-private",
      "user-read-email",
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
      "user-library-read",
      "user-library-modify",
      "user-top-read",
      "user-read-recently-played"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access; refresh token long-lived (PKCE clients can refresh with client_id only; Spotify may return a new refresh token) (training knowledge)",
    "redirectRules": "Doc (fetched): HTTPS required unless loopback; loopback must be literal IP http://127.0.0.1:PORT or http://[::1]:PORT; 'localhost' is prohibited; all existing apps had to comply by Nov 2025. The Ares https tunnel callback is allowed.",
    "ownerSetup": "Create one Spotify app in the dashboard, add redirect https://ares.mistiqueai.com/oauth/callback, tick Web API, paste client id; owner needs Premium for the app owner account.",
    "setup": {
      "consoleUrl": "https://developer.spotify.com/dashboard",
      "appType": "App with 'Web API' (and optionally Web Playback SDK) selected",
      "steps": [
        "Dashboard > Create app; name Ares; redirect URI https://ares.mistiqueai.com/oauth/callback; tick Web API",
        "Settings > User Management: add the owner's Spotify account email (development-mode allowlist)",
        "Copy Client ID (secret not needed with PKCE)"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for one owner: Development mode = owner must have Premium, max 5 authenticated allowlisted users, lower quota. Extended Quota Mode is closed to individuals since May 2025 (org with 250k MAU) -- irrelevant."
    },
    "apiAfterConnect": "rest:https://api.spotify.com/v1",
    "evidence": [
      "https://accounts.spotify.com/.well-known/openid-configuration (live: code_challenge_methods_supported [S256], grant_types incl. device_code, token_endpoint_auth none NOT listed but PKCE public clients are documented)",
      "https://developer.spotify.com/documentation/web-api/concepts/redirect_uri (fetched)",
      "https://developer.spotify.com/documentation/web-api/concepts/quota-modes (fetched)",
      "POST accounts.spotify.com/api/token bogus -> 400 invalid_client (live)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/spotify.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.spotify.com/v1/me"
    },
    "notes": "ANOMALY: the OIDC metadata lists grant_type urn:ietf:params:oauth:grant-type:device_code, and POST https://accounts.spotify.com/api/device/code answers 400 'Missing required parameter: client_id' even when client_id was sent (the same string was sent). Not documented for the Web API; treat as an internal flow (likely Spotify Connect/TV), do not rely on it. Use PKCE. Dev-mode apps lost some endpoints in Nov 2024 (recommendations, related artists, audio features/analysis, featured/editorial playlists for new apps; training knowledge, not re-verified)."
  },
  {
    "id": "strava",
    "label": "Strava",
    "class": "c",
    "flow": "code-secret",
    "registry": "added",
    "provider": "strava",
    "endpoints": {
      "authorize": "https://www.strava.com/oauth/authorize",
      "token": "https://www.strava.com/oauth/token",
      "revoke": "https://www.strava.com/oauth/revoke",
      "userinfo": "https://www.strava.com/api/v3/athlete",
      "resource": "https://www.strava.com/api/v3",
      "docs": "https://developers.strava.com/docs/authentication/"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "read",
      "activity:read_all",
      "profile:read_all",
      "activity:write"
    ],
    "scopeSeparator": ",",
    "refreshTokens": true,
    "tokenLifetime": "6h access; refresh token rotates on every refresh, old one invalidated immediately (doc fetched)",
    "redirectRules": "Registration takes an 'Authorization Callback Domain' (domain only, e.g. ares.mistiqueai.com); localhost and 127.0.0.1 are whitelisted (doc fetched). Path is free.",
    "ownerSetup": "Create one API application at strava.com/settings/api with callback domain ares.mistiqueai.com and paste client id + secret.",
    "setup": {
      "consoleUrl": "https://www.strava.com/settings/api",
      "appType": "API Application (any category)",
      "steps": [
        "Log in > Settings > My API Application: name, category, website, Authorization Callback Domain = ares.mistiqueai.com",
        "Copy Client ID + Client Secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for personal use; new apps start with a 1-athlete capacity (the owner) until Strava approves a quota increase (training knowledge, not verified; rate limits 100 req/15min, 1000/day)."
    },
    "apiAfterConnect": "rest:https://www.strava.com/api/v3",
    "evidence": [
      "https://developers.strava.com/docs/authentication/ (fetched)",
      "POST https://www.strava.com/oauth/token bogus -> 400 client_id invalid (live)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://www.strava.com/api/v3/athlete"
    },
    "notes": "Strava recommends deauthorization via /oauth/revoke from 2026-06-01. Scopes comma-separated. Strava API terms restrict showing one athlete's data to others, irrelevant for owner-only use."
  },
  {
    "id": "threads",
    "label": "Threads",
    "class": "c",
    "flow": "code-secret",
    "registry": "existing",
    "provider": "threads",
    "endpoints": {
      "authorize": "https://threads.com/oauth/authorize",
      "token": "https://graph.threads.net/oauth/access_token",
      "userinfo": "https://graph.threads.net/v1.0/me",
      "resource": "https://graph.threads.net/v1.0",
      "docs": "https://developers.facebook.com/docs/threads/get-started"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "threads_basic",
      "threads_content_publish",
      "threads_read_replies",
      "threads_manage_replies",
      "threads_manage_insights"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "auth code 1h single use; short-lived token 1h; long-lived token 60 days (th_exchange_token at graph.threads.net/access_token), renewed with GET https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token (doc: 'refreshed via GET /refresh_access_token'; param names from training knowledge)",
    "redirectRules": "Exact match to the base URIs in 'Valid OAuth redirect URIs'; trailing slash caveat. HTTPS for Live; Ares https tunnel OK.",
    "ownerSetup": "Create ONE Meta app using the 'Access the Threads API' use case, add the Ares redirect, add the owner's Threads profile as Threads Tester and accept the invite in Threads.",
    "setup": {
      "consoleUrl": "https://developers.facebook.com/apps/",
      "appType": "Meta app with Threads use case ('Access the Threads API')",
      "steps": [
        "Create app > use case 'Access the Threads API'",
        "Use cases > Threads > Settings: add redirect, deauthorize and data-deletion URLs (https)",
        "App roles > Roles > Add People > Threads Tester: add the owner's Threads account; accept in Threads (Settings > Account > Website permissions > Invites)",
        "Copy Threads App ID + Threads App Secret (shown on the Threads use-case settings, distinct from Meta app id)"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Doc: for NON-tester users each permission needs App Review and the app must be published; testers (the owner) can use all permissions in development without review."
    },
    "apiAfterConnect": "rest:https://graph.threads.net/v1.0 (me, me/threads, me/threads_publish, replies, insights)",
    "evidence": [
      "https://developers.facebook.com/docs/threads/get-started (fetched)",
      "https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions (fetched; shows authorize host threads.com and token host graph.threads.com)",
      "POST https://graph.threads.net/oauth/access_token bogus -> 400 'Invalid client_id' (live)",
      "POST https://graph.threads.com/oauth/access_token bogus -> same (live: both hosts alive)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.threads.net/v1.0/me?fields=id,username"
    },
    "notes": "Threads is the CLEAN Meta win: it works for ordinary personal Threads profiles (public or private; no professional-account conversion, no Facebook Page; Threads account is tied to an Instagram login but not required to be a business). Can do: read own posts/profile, publish text/image/video/carousel, read/manage replies, hide replies, insights. Cannot: read arbitrary home feed, search (keyword search needs separate access), DMs (no Threads DM API), follow/like via API. Docs show authorize host threads.com (older docs: threads.net); both token hosts answered live, authorize host not probed (GET to a login page would not tell more). No device flow, no PKCE documented."
  },
  {
    "id": "trello",
    "label": "Trello",
    "class": "c",
    "alsoClass": [
      "e"
    ],
    "flow": "code-pkce",
    "registry": "excluded",
    "excludedReason": "Trello's new OAuth 2.0 goes through an Atlassian developer-console app and its scopes could not be verified; the legacy API-key flow is being deprecated.",
    "endpoints": {
      "authorize": "https://auth.atlassian.com/authorize",
      "token": "https://auth.atlassian.com/oauth/token",
      "docs": "https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-getting-started/"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "limited lifetime, refresh required (Trello docs, exact values UNVERIFIED)",
    "redirectRules": "UNVERIFIED (registered on the Atlassian developer-console app)",
    "ownerSetup": "Create an OAuth 2.0 app in the Atlassian developer console (Trello API), add redirect https://ares.mistiqueai.com/oauth/callback, paste client id (+secret).",
    "setup": {
      "consoleUrl": "https://developer.atlassian.com/console/myapps/",
      "appType": "OAuth 2.0 (3LO) with Trello API",
      "steps": [
        "Create app",
        "Add Trello API + scopes",
        "Set callback URL",
        "Copy client id/secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "none stated for own use"
    },
    "apiAfterConnect": "rest:https://api.trello.com/1 with Bearer token",
    "evidence": [
      "https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-getting-started/",
      "https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.trello.com/1/members/me"
    },
    "notes": "No Trello MCP server found. Trello's legacy API key + 1/authorize?response_type=token flow (class e/browser consent) is documented as to-be-deprecated. Docs say OAuth2 is for user-facing apps, not bots. trello.com/.well-known returns HTML (none)."
  },
  {
    "id": "typeform",
    "label": "Typeform",
    "class": "c",
    "alsoClass": [
      "a"
    ],
    "flow": "code-pkce",
    "registry": "added",
    "provider": "typeform",
    "endpoints": {
      "issuer": "https://api.typeform.com",
      "authorize": "https://admin.typeform.com/oauth/authorize",
      "token": "https://api.typeform.com/oauth/token",
      "register": "https://api.typeform.com/oauth/register",
      "docs": "https://www.typeform.com/developers/get-started/applications/"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "offline_access",
      "accounts:read",
      "forms:read",
      "forms:write",
      "responses:read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (offline_access scope gives refresh tokens)",
    "redirectRules": "UNVERIFIED",
    "ownerSetup": "Register an app at admin.typeform.com (Developer apps), set redirect URI, paste client id/secret. (AS advertises DCR + 'none' auth: lead may probe the register endpoint.)",
    "setup": {
      "consoleUrl": "https://admin.typeform.com/account#/section/tokens",
      "appType": "Developer app",
      "steps": [
        "Create app",
        "Add redirect URI",
        "Copy client id/secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "reviewRequired": "none for own use"
    },
    "apiAfterConnect": "rest:https://api.typeform.com",
    "evidence": [
      "https://api.typeform.com/.well-known/oauth-authorization-server",
      "bogus POST https://api.typeform.com/oauth/token -> INVALID_CLIENT_SECRET (alive)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/typeform.as.json",
      "idp/typeform.oidc.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.typeform.com/me"
    },
    "notes": "Surprise: Typeform's AS advertises RFC 7591 registration_endpoint (https://api.typeform.com/oauth/register) and client auth 'none', but no Typeform MCP exists at mcp.typeform.com (302 to typeform.com). If DCR works it is class a-like for the REST API; lead's central probe decides."
  },
  {
    "id": "withings",
    "label": "Withings",
    "class": "c",
    "flow": "code-secret",
    "registry": "existing",
    "provider": "withings",
    "endpoints": {
      "authorize": "https://account.withings.com/oauth2_user/authorize2",
      "token": "https://wbsapi.withings.net/v2/oauth2",
      "revoke": "https://wbsapi.withings.net/v2/oauth2",
      "resource": "https://wbsapi.withings.net",
      "docs": "https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/oauth-authorization-url/"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "user.info",
      "user.metrics",
      "user.activity"
    ],
    "scopeSeparator": ",",
    "refreshTokens": true,
    "tokenLifetime": "3h access; refresh 12 months (search-reported, Withings dev guide pages not fully fetched)",
    "redirectRules": "Exact registered callback (https; Withings historically also accepted http localhost for dev). Token call is a POST with form field action=requesttoken (and action=requesttoken+grant_type=refresh_token for refresh); non-standard: HTTP 200 with JSON {status,body}.",
    "ownerSetup": "Create one Public Health Data API application in the Withings developer dashboard with callback https://ares.mistiqueai.com/oauth/callback and paste client id + secret.",
    "setup": {
      "consoleUrl": "https://developer.withings.com/dashboard/",
      "appType": "Public Health Data API application (Public Cloud environment)",
      "steps": [
        "Sign in to Withings developer portal > Create an application (Public API integration)",
        "Set callback URL https://ares.mistiqueai.com/oauth/callback",
        "Copy Client ID + Consumer secret"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for personal use of own data in the dev environment (UNVERIFIED; the Withings fetch returned only a footer, details from search snippets)."
    },
    "apiAfterConnect": "rest:https://wbsapi.withings.net (POST action=getmeas on /measure, /v2/sleep, /v2/measure)",
    "evidence": [
      "web search results citing developer.withings.com (not fully fetched)",
      "POST https://wbsapi.withings.net/v2/oauth2 bogus -> HTTP 200 body status 503 'Invalid Params: invalid client id/secret' (live: endpoint alive)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "notes": "Withings errors come back as HTTP 200 with a numeric status in the body (0 = ok), so Ares' generic OAuth error handling must inspect body.status. Scope separator is a comma. No documented device flow or PKCE."
  },
  {
    "id": "x",
    "label": "X (Twitter)",
    "class": "c",
    "flow": "code-pkce",
    "registry": "added",
    "provider": "x",
    "endpoints": {
      "authorize": "https://x.com/i/oauth2/authorize",
      "token": "https://api.x.com/2/oauth2/token",
      "revoke": "https://api.x.com/2/oauth2/revoke",
      "userinfo": "https://api.x.com/2/users/me",
      "resource": "https://api.x.com/2",
      "docs": "https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "tweet.read",
      "tweet.write",
      "users.read",
      "offline.access",
      "dm.read",
      "dm.write",
      "like.read",
      "like.write",
      "follows.read",
      "follows.write",
      "bookmark.read",
      "media.write"
    ],
    "refreshTokens": true,
    "tokenLifetime": "2h access; refresh token only with offline.access (doc fetched; refresh tokens rotate - training knowledge)",
    "redirectRules": "Exact match, no patterns (doc fetched); https allowed. Public client type ('Native App' / 'Single page App') uses PKCE with client_id only; confidential ('Web App, Automated App or Bot') uses client_secret.",
    "ownerSetup": "Create a project/app at the X developer console, choose a public (native) client type, set callback https://ares.mistiqueai.com/oauth/callback, load pay-per-use credits.",
    "setup": {
      "consoleUrl": "https://console.x.com",
      "appType": "App in a Project; 'User authentication settings' > type Native App (public) or Web App (confidential); permissions Read and write (+DM if wanted)",
      "steps": [
        "console.x.com: sign in, create app inside a project",
        "Set up User authentication: OAuth 2.0 on, app type, permissions, callback URL, website URL",
        "Add pay-per-use credits (no free tier for new signups since 2026-02-06)",
        "Copy Client ID (+ Client Secret for confidential type)"
      ],
      "fields": [
        "client_id",
        "client_secret(optional)"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "No review; payment gate: pay-per-use credits (search-reported Sep 2026: $0.005/post read, $0.010/user read, $0.015/post created, $0.20 post with link, $0.015/DM; free tier closed to new signups Feb 2026; Basic $200/mo closed). Not a vendor page fetched."
    },
    "apiAfterConnect": "rest:https://api.x.com/2",
    "evidence": [
      "https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code (fetched)",
      "POST https://api.x.com/2/oauth2/token bogus -> 400 invalid_client 'Value passed for the client id was invalid.' (live)",
      "web search on pay-per-use (third-party blogs)"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.x.com/2/users/me"
    },
    "notes": "No device flow, no OIDC discovery (api.x.com/.well-known/openid-configuration -> 404). Token endpoint live. Cost is the real gate, not auth; reading/posting costs per call so Ares should cap usage. If the owner will not pay, X stays class f (browser)."
  },
  {
    "id": "xero",
    "label": "Xero",
    "class": "c",
    "alsoClass": [
      "e"
    ],
    "flow": "code-pkce",
    "registry": "added",
    "provider": "xero",
    "endpoints": {
      "issuer": "https://identity.xero.com",
      "authorize": "https://login.xero.com/identity/connect/authorize",
      "token": "https://identity.xero.com/connect/token",
      "revoke": "https://identity.xero.com/connect/revocation",
      "userinfo": "https://identity.xero.com/connect/userinfo",
      "docs": "https://developer.xero.com/documentation/guides/oauth2/pkce-flow"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "offline_access",
      "openid",
      "profile",
      "email",
      "accounting.transactions.read",
      "accounting.contacts.read",
      "accounting.settings.read"
    ],
    "refreshTokens": true,
    "tokenLifetime": "30min access / 60d refresh rotating (docs); needs offline_access",
    "redirectRules": "Redirect URIs registered in the app; https required except localhost; exact match (docs).",
    "ownerSetup": "Create a Xero app of type Auth Code with PKCE, add the redirect, paste the client id (no secret).",
    "setup": {
      "consoleUrl": "https://developer.xero.com/app/manage",
      "appType": "Auth Code with PKCE (public client, no secret)",
      "steps": [
        "New app, integration type Auth Code with PKCE",
        "Add redirect https://ares.mistiqueai.com/oauth/callback",
        "Copy client id"
      ],
      "fields": [
        "client_id"
      ],
      "reviewRequired": "None for dev use. Since 2026-03-02 Xero uses tiers: Starter is $0 and capped at 5 connected orgs, enough for a personal owner; custom connections (single org) are exempt. Source is a web search summary, UNVERIFIED against developer.xero.com/pricing."
    },
    "apiAfterConnect": "rest:https://api.xero.com/api.xro/2.0",
    "evidence": [
      "https://identity.xero.com/.well-known/openid-configuration",
      "https://developer.xero.com/pricing (search result only)",
      "https://truto.one/blog/xero-api-pricing-changes-2026-costs-tiers-and-how-to-minimize-egress/"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/xero.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.xero.com/connections"
    },
    "notes": "Live: no device_authorization_endpoint; grants authorization_code, client_credentials, refresh_token; S256 advertised; token auth only basic/post in the metadata (public PKCE client behavior is docs-only). Call /connections for tenant id and send xero-tenant-id header."
  },
  {
    "id": "zoom",
    "label": "Zoom",
    "class": "c",
    "alsoClass": [
      "d",
      "b"
    ],
    "flow": "code-pkce",
    "registry": "added",
    "provider": "zoom",
    "endpoints": {
      "issuer": "https://zoom.us",
      "authorize": "https://zoom.us/oauth/authorize",
      "token": "https://zoom.us/oauth/token",
      "device": "https://zoom.us/oauth/devicecode",
      "revoke": "https://zoom.us/oauth/revoke",
      "mcp": "https://mcp.zoom.us/mcp/zoom/streamable",
      "resource": "https://mcp.zoom.us/.well-known/oauth-protected-resource/mcp/zoom/streamable",
      "docs": "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/"
    },
    "pkce": true,
    "clientAuth": "client_secret_basic",
    "scopes": [
      "meeting:read:search",
      "meeting:write:meeting",
      "cloud_recording:read:content",
      "my_notes:read:content",
      "docs:read:export"
    ],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED (Zoom docs: 1h access, rotating refresh)",
    "redirectRules": "exact-match registered on the General app; PKCE allows a public client (docs: 'public client ID and no client secret')",
    "ownerSetup": "Create a General (user-managed) OAuth app in the Zoom App Marketplace, add redirect https://ares.mistiqueai.com/oauth/callback and scopes, paste client id (PKCE) (+secret).",
    "setup": {
      "consoleUrl": "https://marketplace.zoom.us/develop/create",
      "appType": "General app (user-managed OAuth)",
      "steps": [
        "Develop > Build app > General app",
        "Add redirect URL and scopes",
        "Copy client id (+secret)"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Device flow is not a checkbox: docs say it is only for private app types and Zoom developer support must enable it",
      "reviewRequired": "unpublished app usable on own account; the MCP scopes are user-level"
    },
    "apiAfterConnect": "mcp:https://mcp.zoom.us/mcp/zoom/streamable or rest:https://api.zoom.us/v2",
    "evidence": [
      "https://zoom.us/.well-known/openid-configuration (device_authorization_endpoint, grant device_code, PKCE S256+plain, no registration_endpoint)",
      "https://developers.zoom.us/docs/mcp/servers/connect-to-zoom-mcp-servers/ (search result: manual registration only, no DCR/CIMD, PKCE required)",
      "POST https://mcp.zoom.us/mcp/zoom/streamable -> 401 resource_metadata",
      "bogus POST zoom.us/oauth/devicecode and /oauth/token -> invalid_client (alive)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/zoom.as.json",
      "idp/zoom.oidc.json",
      "idp/zoommcp.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.zoom.us/v2/users/me"
    },
    "notes": "Device flow advertised and endpoint alive but gated by Zoom support enablement for private apps (docs, UNVERIFIED from here); do not promise it. Zoom MCP has no DCR (class b) and uses the same app registration."
  },
  {
    "id": "github",
    "label": "GitHub",
    "class": "d",
    "alsoClass": [
      "c"
    ],
    "flow": "device",
    "registry": "existing",
    "provider": "github",
    "endpoints": {
      "issuer": "https://github.com/login/oauth",
      "authorize": "https://github.com/login/oauth/authorize",
      "token": "https://github.com/login/oauth/access_token",
      "device": "https://github.com/login/device/code",
      "userinfo": "https://api.github.com/user",
      "mcp": "https://api.githubcopilot.com/mcp/",
      "resource": "https://api.githubcopilot.com/mcp/",
      "docs": "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [
      "repo",
      "read:org",
      "read:user",
      "user:email",
      "notifications",
      "read:project",
      "gist"
    ],
    "refreshTokens": false,
    "tokenLifetime": "OAuth App token: no expiry (until revoked). GitHub App user token (if a GitHub App is registered instead): 8h access + 6-month refresh token, optional per-app setting.",
    "redirectRules": "Device flow has no redirect. Web flow (alsoClass c) needs a registered callback URL; https allowed.",
    "ownerSetup": "Register ONE GitHub OAuth App once, tick 'Enable Device Flow', paste the client_id into Ares (no secret needed); every later phone sign-in is a code entered at github.com/login/device.",
    "setup": {
      "consoleUrl": "https://github.com/settings/developers",
      "appType": "OAuth App (scope-based, non-expiring token). Alternative: GitHub App with Device Flow enabled (permission-based, expiring tokens; whether refresh needs the client secret is not stated in the docs read - UNVERIFIED).",
      "steps": [
        "GitHub > Settings > Developer settings > OAuth Apps > New OAuth App",
        "Name Ares, Homepage https://ares.mistiqueai.com, Authorization callback URL https://ares.mistiqueai.com/oauth/callback (required field, unused by device flow)",
        "After creating, tick 'Enable Device Flow' and Update application",
        "Copy Client ID into Ares (no client secret needed)"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Enable Device Flow",
      "reviewRequired": "None for personal use. Orgs with OAuth App access restrictions must approve the app before org data is visible."
    },
    "apiAfterConnect": "mcp:https://api.githubcopilot.com/mcp/ with Authorization: Bearer <access_token> (also rest:https://api.github.com)",
    "evidence": [
      "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/ (live)",
      "https://github.com/login/oauth/.well-known/openid-configuration (live; lists device_authorization_endpoint + device_code grant)",
      "https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps",
      "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app",
      "https://raw.githubusercontent.com/github/github-mcp-server/main/README.md",
      "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/oauth-login.md",
      "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/scope-filtering.md"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/github.json",
      "idp/github.oidc.json",
      "idp/github.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.github.com/user"
    },
    "notes": "LIVE: unauthenticated MCP initialize -> 401 with resource_metadata; PRM names authorization server https://github.com/login/oauth and scopes_supported [repo read:org read:user user:email read:packages write:packages read:project project gist notifications]. GitHub's OIDC doc advertises NO registration_endpoint (no DCR) and no CIMD, so zero-setup class a is impossible; a pre-registered client is mandatory. (a) Device flow: POST https://github.com/login/device/code (client_id, scope) then poll https://github.com/login/oauth/access_token with grant_type=urn:ietf:params:oauth:grant-type:device_code; no client_secret on polling; app MUST have Enable Device Flow ticked; 5s minimum interval (slow_down otherwise); user enters code at https://github.com/login/device. Bogus-client probe: both device/code and access_token returned HTTP 404 for client_id=ares-probe-not-a-client (GitHub's unknown-app answer): host alive, but this does NOT prove device flow works for a real app. (b) Remote MCP accepting OAuth App / GitHub App user tokens as Bearer: UNVERIFIED by call (no real token) but documented: README says each MCP host configures a GitHub App or OAuth App for remote OAuth; PRM advertises github.com/login/oauth as AS; scope-filtering.md describes OAuth scope challenges on the remote server (so request the full scope set up front; a device flow cannot step up mid-call without a new code). (c) api.githubcopilot.com/mcp has oauth-protected-resource (live) but NO oauth-authorization-server doc (404), no openid-configuration there, no DCR. Official client id: GitHub bakes an OAuth app client id into official github-mcp-server binaries/Docker image for github.com, and gh CLI / VS Code have their own; those are product-specific with their own registered callbacks - do NOT reuse. No publ"
  },
  {
    "id": "onedrive",
    "label": "OneDrive",
    "class": "d",
    "alsoClass": [
      "c"
    ],
    "flow": "device",
    "registry": "scope",
    "parent": "microsoft",
    "endpoints": {
      "issuer": "https://login.microsoftonline.com/common/v2.0",
      "authorize": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "device": "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
      "userinfo": "https://graph.microsoft.com/oidc/userinfo",
      "resource": "https://graph.microsoft.com",
      "docs": "https://learn.microsoft.com/en-us/graph/onedrive-concept-overview"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "offline_access",
      "User.Read",
      "Files.ReadWrite"
    ],
    "refreshTokens": true,
    "tokenLifetime": "same as outlook",
    "redirectRules": "Same as outlook (shares the app registration).",
    "ownerSetup": "None beyond outlook: same Entra app; just include Files.ReadWrite (add Files.ReadWrite.All only for SharePoint/shared files).",
    "setup": {
      "consoleUrl": "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      "appType": "same as outlook",
      "steps": [
        "Add Files.ReadWrite delegated permission to the same registration"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Allow public client flows = Yes",
      "reviewRequired": "None for personal accounts; Files.ReadWrite.All needs admin consent in work tenants."
    },
    "apiAfterConnect": "rest:https://graph.microsoft.com/v1.0/me/drive",
    "evidence": [
      "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.microsoft.com/v1.0/me/drive"
    },
    "notes": "DECISION: separate registry id is fine for the tool surface but it must share the microsoft provider token (one client_id, one consent that requests all Graph scopes at once). Microsoft supports incremental consent so scopes can also be added later on re-login. Personal OneDrive is on the same Graph /me/drive."
  },
  {
    "id": "outlook",
    "label": "Outlook / Microsoft 365 (mail, calendar, contacts, tasks)",
    "class": "d",
    "alsoClass": [
      "c"
    ],
    "flow": "device",
    "registry": "existing",
    "provider": "microsoft",
    "endpoints": {
      "issuer": "https://login.microsoftonline.com/common/v2.0",
      "authorize": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      "device": "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
      "userinfo": "https://graph.microsoft.com/oidc/userinfo",
      "resource": "https://graph.microsoft.com",
      "docs": "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Tasks.ReadWrite"
    ],
    "refreshTokens": true,
    "tokenLifetime": "~1h access; refresh token ~90 days sliding, rotated on every use (returned only if offline_access requested) (training knowledge + doc: refresh issued if offline_access)",
    "redirectRules": "Device flow: no redirect and no secret. Code flow public client: https and http://localhost allowed, exact match; mobile/desktop platform type 'Mobile and desktop applications'.",
    "ownerSetup": "Register ONE Entra app (free, any Microsoft account can create it) as multi-tenant+personal with 'Allow public client flows' = Yes and paste the Application (client) ID; no secret, no redirect.",
    "setup": {
      "consoleUrl": "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
      "appType": "App registration, Supported account types 'Accounts in any organizational directory and personal Microsoft accounts' (signInAudience AzureADandPersonalMicrosoftAccount)",
      "steps": [
        "Entra admin center > App registrations > New registration; name 'Ares'; supported account types = any org directory + personal Microsoft accounts; no redirect URI",
        "Authentication > Settings > 'Allow public client flows' = Yes > Save",
        "API permissions > Add > Microsoft Graph > Delegated: offline_access, User.Read, Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, Contacts.ReadWrite, Tasks.ReadWrite, Files.ReadWrite",
        "Copy Application (client) ID into Ares"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Authentication > Advanced settings > Allow public client flows = Yes",
      "reviewRequired": "None for personal accounts (user self-consents). Work/school tenants: user consent may be blocked by tenant policy -> admin consent needed; the listed delegated scopes are user-consentable by default (Graph reference confirms only Calendars.ReadWrite delegated = no admin consent explicitly in this run; others from training knowledge). Publisher verification only needed for multi-tenant apps to avoid the 'unverified' label in work tenants; not needed for personal use."
    },
    "apiAfterConnect": "rest:https://graph.microsoft.com/v1.0",
    "evidence": [
      "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration (live)",
      "POST https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode bogus client -> AADSTS700016 app not found (live: endpoint alive)",
      "POST .../common/oauth2/v2.0/devicecode bogus -> AADSTS50059 no tenant info (live: endpoint alive)",
      "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code",
      "https://learn.microsoft.com/en-us/graph/permissions-reference"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/outlook.device.json",
      "idp/outlook.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://graph.microsoft.com/v1.0/me"
    },
    "notes": "Discovery JSON lists device_authorization_endpoint (checked) but does not advertise code_challenge_methods_supported (PKCE is supported by the platform for code flow; not seen in the metadata). Doc: device flow accepts tenant common/consumers/organizations/GUID; personal accounts using common/consumers are asked to sign in again on the verification page; verification_uri_complete is NOT supported (user must type the code). Doc: refresh token issued only if offline_access in scope. Whether a bogus device request against common behaves the same for a REAL public client was not tested (no client). A personal-only Entra tenant is needed to register: sign in to Azure with the personal MSA (free). Tasks (To Do) with Tasks.ReadWrite works for personal accounts (training knowledge, unverified here). Old 'Outlook.com REST' endpoints are gone; use Graph. Best path for Rook: device flow, since no redirect/secret and works headless; code flow is the alt."
  },
  {
    "id": "twitch",
    "label": "Twitch",
    "class": "d",
    "alsoClass": [
      "c"
    ],
    "flow": "device",
    "registry": "added",
    "provider": "twitch",
    "endpoints": {
      "issuer": "https://id.twitch.tv/oauth2",
      "authorize": "https://id.twitch.tv/oauth2/authorize",
      "token": "https://id.twitch.tv/oauth2/token",
      "device": "https://id.twitch.tv/oauth2/device",
      "revoke": "https://id.twitch.tv/oauth2/revoke",
      "userinfo": "https://id.twitch.tv/oauth2/userinfo",
      "resource": "https://api.twitch.tv/helix",
      "docs": "https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [
      "user:read:email",
      "user:read:follows",
      "user:read:subscriptions",
      "channel:read:subscriptions",
      "clips:edit",
      "chat:read",
      "chat:edit"
    ],
    "refreshTokens": true,
    "tokenLifetime": "4h access; public-client refresh token single use, expires after 30 days unused; confidential refresh tokens do not expire (docs fetched)",
    "redirectRules": "Registration requires an OAuth Redirect URL (http://localhost:3000 accepted); device flow itself uses no redirect. Code flow exact match, https or http://localhost.",
    "ownerSetup": "Register one app on dev.twitch.tv with Client Type = Public, any redirect (http://localhost), paste client id; no secret.",
    "setup": {
      "consoleUrl": "https://dev.twitch.tv/console/apps",
      "appType": "Client Type: Public (device flow only) -- or Confidential for code flow",
      "steps": [
        "Twitch account needs 2FA enabled for the developer console",
        "Register Your Application: name, OAuth Redirect URL http://localhost:3000, Category, Client Type = Public",
        "Copy Client ID"
      ],
      "fields": [
        "client_id"
      ],
      "deviceFlowCheckbox": "Client Type = Public",
      "reviewRequired": "None."
    },
    "apiAfterConnect": "rest:https://api.twitch.tv/helix (headers Authorization: Bearer, Client-Id)",
    "evidence": [
      "https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/ (fetched)",
      "https://id.twitch.tv/oauth2/.well-known/openid-configuration (live, OIDC only; lists no device endpoint)",
      "POST https://id.twitch.tv/oauth2/device bogus -> 400 {'status':400,'message':'invalid client'} (live: endpoint alive)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/twitch.device.json",
      "idp/twitch.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.twitch.tv/helix/users"
    },
    "notes": "Device endpoint is NOT in the discovery doc (token_endpoint_auth_methods only client_secret_post) but answers live. Device request uses parameter 'scopes' (plural, space-separated) not 'scope'. Public-client refresh tokens expire after 30 days idle and are one-time; Ares must store the rotated token each use. Helix needs Client-Id header with every call."
  },
  {
    "id": "youtube",
    "label": "YouTube",
    "class": "d",
    "alsoClass": [
      "c"
    ],
    "flow": "device",
    "registry": "scope",
    "parent": "google",
    "endpoints": {
      "issuer": "https://accounts.google.com",
      "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
      "token": "https://oauth2.googleapis.com/token",
      "device": "https://oauth2.googleapis.com/device/code",
      "revoke": "https://oauth2.googleapis.com/revoke",
      "docs": "https://developers.google.com/youtube/v3/guides/auth/devices"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.readonly"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access; refresh persistent once app is In production (7d in Testing)",
    "redirectRules": "Device flow: none. Code flow: same Web client as google.",
    "ownerSetup": "Recommended: none beyond google -- add the youtube scope to the existing Google Web client consent (incremental), enable 'YouTube Data API v3'.",
    "setup": {
      "consoleUrl": "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
      "appType": "same Web client as google (preferred) or 'TVs and Limited Input devices' for device flow",
      "steps": [
        "Enable YouTube Data API v3 in the same project",
        "Add youtube / youtube.readonly to the consent screen scopes"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "youtube scopes are sensitive; unverified production app = warning screen, fine for one owner. Data API default quota 10,000 units/day (training knowledge, not re-fetched; videos.insert costs ~1600, search 100)."
    },
    "apiAfterConnect": "rest:https://www.googleapis.com/youtube/v3",
    "evidence": [
      "https://developers.google.com/youtube/v3/guides/auth/devices",
      "https://developers.google.com/identity/protocols/oauth2/limited-input-device"
    ],
    "verification": "FLOW-VERIFIED-AGAINST-MOCK",
    "fixtures": [
      "idp/google.device.json"
    ],
    "healthCheck": {
      "method": "GET",
      "url": "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true"
    },
    "notes": "DECISION: make it a SCOPE of the google provider, not a separate secret-bearing service -- one Google consent, one client, one refresh token. A separate registry id 'youtube' is fine only as a UI/tool grouping that points at the google token with the youtube scope requested incrementally (note: Google says incremental authorization is NOT supported on device/installed flows; on the Web client it is). Device flow is legitimately available for YouTube (youtube + youtube.readonly are on the allowed list) but needs a separate TV-type client, which gives no advantage over the Web client Ares already has. YouTube Analytics / Reports would be different scopes (not device-allowed)."
  },
  {
    "id": "api-coingecko",
    "label": "CoinGecko",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Optional demo key (works keyless at low rate limits).",
    "apiAfterConnect": "rest:https://api.coingecko.com/api/v3",
    "evidence": [
      "https://docs.coingecko.com/ (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Key optional; no OAuth."
  },
  {
    "id": "api-home-assistant",
    "label": "Home Assistant (REST)",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "docs": "https://developers.home-assistant.io/docs/auth_api"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "1800s access / refresh token; long-lived access tokens valid 10 years",
    "redirectRules": "IndieAuth: client_id = your app website URL; redirect_uri must be same host+port as client_id (or listed via link tags in the first 10kB of the client_id page). Ares: client_id https://ares.mistiqueai.com/ + redirect https://ares.mistiqueai.com/oauth/callback share a host, so NO registration needed.",
    "ownerSetup": "None beyond giving Ares the HA base URL and logging in to HA in the phone browser.",
    "apiAfterConnect": "rest/ws:<HA base>/api (or mcp:<HA base>/api/mcp)",
    "evidence": [
      "https://developers.home-assistant.io/docs/auth_api"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Same flow as home-assistant (IndieAuth code flow at <HA base>/auth/authorize + /auth/token). UNVERIFIED (docs only, instance-local)."
  },
  {
    "id": "api-nasa-apod",
    "label": "NASA APOD",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Free key from api.nasa.gov (DEMO_KEY works with tight limits).",
    "apiAfterConnect": "rest:https://api.nasa.gov/planetary/apod",
    "evidence": [
      "https://api.nasa.gov/ (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "api_key query param; no OAuth."
  },
  {
    "id": "brave-search",
    "label": "Brave Search",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Create a free API key at brave.com/search/api and paste it.",
    "apiAfterConnect": "rest:https://api.search.brave.com/res/v1",
    "evidence": [
      "https://brave.com/search/api/ (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "X-Subscription-Token header only; no OAuth."
  },
  {
    "id": "caldav",
    "label": "CalDAV (generic)",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Server URL + username + app password.",
    "evidence": [
      "https://developers.google.com/calendar/caldav/v2/guide (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Generic protocol. OAuth only via provider-specific services: Google Calendar CalDAV accepts OAuth bearer (scope https://www.googleapis.com/auth/calendar) -- better served by the Google class; iCloud has none; Fastmail/Nextcloud use app passwords."
  },
  {
    "id": "carddav",
    "label": "CardDAV (generic)",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Server URL + username + app password.",
    "evidence": [
      "https://developers.google.com/people/carddav (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Generic protocol; Google CardDAV supports OAuth but the People API is the better path; iCloud app-password only."
  },
  {
    "id": "discord-bot",
    "label": "Discord bot",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "discord",
    "endpoints": {
      "docs": "https://docs.discord.com/developers/topics/oauth2"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [
      "bot",
      "applications.commands"
    ],
    "refreshTokens": false,
    "tokenLifetime": "Bot token never expires (reset in Developer Portal)",
    "redirectRules": "n/a - the OAuth 'bot' scope install only adds the bot to a guild; the credential is still the static bot token.",
    "ownerSetup": "Create application + bot in Developer Portal, copy bot token, use the invite URL (OAuth2 URL generator, scope=bot) to add it to the server.",
    "setup": {
      "consoleUrl": "https://discord.com/developers/applications",
      "appType": "New Application > Bot",
      "steps": [
        "Bot tab: Reset Token and copy",
        "Enable Message Content Intent if reading messages",
        "OAuth2 > URL Generator: scope bot, open URL, pick the server"
      ],
      "fields": [
        "bot_token"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "Message Content privileged intent needs verification only above 100 guilds."
    },
    "apiAfterConnect": "stdio MCP with DISCORD_TOKEN env",
    "evidence": [
      "https://docs.discord.com/developers/topics/oauth2 (bot authorization = serverless flow, no token exchange)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Correctly e: no OAuth token for a bot exists. Ares can reduce friction only by guiding the Developer Portal steps; token must be pasted."
  },
  {
    "id": "duffel",
    "label": "Duffel",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Create an access token in the Duffel dashboard (test or live) and paste it.",
    "apiAfterConnect": "rest:https://api.duffel.com",
    "evidence": [
      "https://duffel.com/docs/api"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Bearer access tokens created by the account owner. No documented third-party user OAuth for personal accounts (UNVERIFIED); mcp.duffel.com returned Cloudflare 520 (no MCP confirmed)."
  },
  {
    "id": "firecrawl",
    "label": "Firecrawl",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "mcp": "https://mcp.firecrawl.dev/mcp",
      "docs": "https://docs.firecrawl.dev/mcp-server"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "static key",
    "redirectRules": "n/a",
    "ownerSetup": "Optional: paste API key from firecrawl.dev; the MCP also runs KEYLESS with usage limits.",
    "anonymousOk": true,
    "apiAfterConnect": "mcp:https://mcp.firecrawl.dev/mcp",
    "evidence": [
      "unauthenticated initialize on https://mcp.firecrawl.dev/mcp returned 200 serverInfo firecrawl-fastmcp",
      "/.well-known/oauth-protected-resource and oauth-authorization-server both 404"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [
      "mcp/firecrawl.json"
    ],
    "notes": "Surprise: unauthenticated initialize SUCCEEDS; server instructions say hosted keyless sessions expose firecrawl_search, firecrawl_scrape, firecrawl_parse with usage limits. Registry kind key is therefore wrong in the strict sense: should be none-with-optional-key. No OAuth exists."
  },
  {
    "id": "flightaware",
    "label": "FlightAware AeroAPI",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Create an AeroAPI key (personal tier) and paste it.",
    "apiAfterConnect": "rest:https://aeroapi.flightaware.com/aeroapi",
    "evidence": [
      "https://www.flightaware.com/aeroapi/portal/documentation"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "x-apikey header only; no OAuth. Not fetched (knowledge)."
  },
  {
    "id": "gemini",
    "label": "Gemini API",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://accounts.google.com",
      "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
      "token": "https://oauth2.googleapis.com/token",
      "docs": "https://ai.google.dev/gemini-api/docs/oauth"
    },
    "pkce": true,
    "clientAuth": "client_secret_post",
    "scopes": [
      "https://www.googleapis.com/auth/generative-language.retriever",
      "https://www.googleapis.com/auth/cloud-platform"
    ],
    "refreshTokens": true,
    "tokenLifetime": "1h access; refresh until revoked (7 days if consent screen is External + Testing)",
    "ownerSetup": "Reuse the Google OAuth client (Cloud Console) and add the scope; owner must be a test user on the consent screen.",
    "apiAfterConnect": "rest:https://generativelanguage.googleapis.com/v1beta (Bearer)",
    "evidence": [
      "https://ai.google.dev/gemini-api/docs/oauth",
      "https://accounts.google.com/.well-known/openid-configuration (LIVE, shared fixture google.oidc.json)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/google.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": true,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": false
    },
    "notes": "Docs confirm OAuth is supported but call it \"appropriate for a testing environment\"; scopes are generative-language.retriever or cloud-platform (sensitive/restricted -> unverified-app warning, fine for owner-as-test-user). Device flow (oauth2.googleapis.com/device/code alive: bogus probe -> invalid_client) likely does NOT permit these scopes (UNVERIFIED). Simplest: keep the API key; OAuth only pays off if Ares already holds a Google OAuth client."
  },
  {
    "id": "gitlab-token",
    "label": "GitLab (PAT, stdio)",
    "class": "e",
    "alsoClass": [
      "a",
      "d"
    ],
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "gitlab",
    "endpoints": {
      "docs": "https://docs.gitlab.com/user/profile/personal_access_tokens/"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [
      "api"
    ],
    "refreshTokens": false,
    "tokenLifetime": "until revoked",
    "redirectRules": "n/a",
    "ownerSetup": "Superseded by the OAuth sibling entry; keep only as manual fallback.",
    "apiAfterConnect": "stdio token",
    "evidence": [
      "https://docs.gitlab.com/user/profile/personal_access_tokens/"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://gitlab.com/api/v4/user"
    },
    "notes": "Registry kind is token-only but GitLab.com has real OAuth (DCR + device grant, live AS metadata); fold into 'gitlab'."
  },
  {
    "id": "google-places",
    "label": "Google Places",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Create a Maps Platform API key (billing enabled) and paste it.",
    "apiAfterConnect": "rest:https://places.googleapis.com/v1",
    "evidence": [
      "https://developers.google.com/maps/documentation/places/web-service/overview (not fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "API key is the supported path; Places API (New) also accepts OAuth with the cloud-platform scope (UNVERIFIED) but needs a billed GCP project regardless."
  },
  {
    "id": "home-assistant",
    "label": "Home Assistant (MCP)",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "docs": "https://developers.home-assistant.io/docs/auth_api"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "1800s access / refresh token; long-lived access tokens valid 10 years",
    "redirectRules": "IndieAuth: client_id = your app website URL; redirect_uri must be same host+port as client_id (or listed via link tags in the first 10kB of the client_id page). Ares: client_id https://ares.mistiqueai.com/ + redirect https://ares.mistiqueai.com/oauth/callback share a host, so NO registration needed.",
    "ownerSetup": "None beyond giving Ares the HA base URL and logging in to HA in the phone browser.",
    "apiAfterConnect": "rest/ws:<HA base>/api (or mcp:<HA base>/api/mcp)",
    "evidence": [
      "https://developers.home-assistant.io/docs/auth_api"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Real IndieAuth code flow with zero app registration. Docs mention no PKCE and no device flow (pkce:false is \"not documented\"). No public HA instance to probe, so UNVERIFIED. Rook must reach the HA token endpoint (LAN or Nabu Casa URL). Long-lived token (profile page) is the fallback (class e). Same for api-home-assistant."
  },
  {
    "id": "hue",
    "label": "Philips Hue",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "authorize": "https://api.meethue.com/v2/oauth2/authorize",
      "token": "https://api.meethue.com/v2/oauth2/token",
      "docs": "https://developers.meethue.com/"
    },
    "pkce": false,
    "clientAuth": "client_secret_basic",
    "scopes": [],
    "refreshTokens": true,
    "ownerSetup": "Local path: press the bridge link button when Ares pairs (Rook must be on the same LAN). Remote OAuth path: register a Remote Hue API app at developers.meethue.com/my-apps for client id/secret.",
    "apiAfterConnect": "rest:https://<bridge-ip>/clip/v2 (local) or https://api.meethue.com/route (remote)",
    "evidence": [
      "https://developers.meethue.com/my-apps/ (login-walled, not read)",
      "https://github.com/michielpost/Q42.HueApi/blob/master/RemoteApi.md (via search)",
      "https://github.com/peter-murray/node-hue-api/blob/master/docs/remoteApi.md"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "HONEST: local link-button pairing is NOT OAuth -- it mints an application key (class e). Remote API is classic OAuth2 auth-code (class c): app registered on the Hue developer portal (name, callback URL, description) gives appId/clientId/clientSecret, Basic auth at the token endpoint, then the bridge must be whitelisted remotely (needs a physical link-button press too). Live: GET api.meethue.com/v2/oauth2/authorize answered HTTP 400 (endpoint alive, no discovery doc: /.well-known 404), so only endpoint existence is observed. Token lifetimes not verified. Since Rook sits on the home LAN, local pairing is simpler with no cloud dependency; use remote only if Rook leaves the LAN."
  },
  {
    "id": "icloud",
    "label": "iCloud (CalDAV/CardDAV/mail)",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://appleid.apple.com",
      "authorize": "https://appleid.apple.com/auth/authorize",
      "token": "https://appleid.apple.com/auth/token",
      "docs": "https://support.apple.com/102654"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Generate an app-specific password at account.apple.com and paste it with the Apple ID.",
    "evidence": [
      "https://appleid.apple.com/.well-known/openid-configuration (LIVE: scopes openid email name only)",
      "search results: iCloud CalDAV accepts only app-specific passwords"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/apple.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": true,
      "publicClient": false
    },
    "notes": "Confirmed: Sign in with Apple is identity only (scopes name, email); no OAuth for CalDAV/CardDAV/IMAP. App-specific password over Basic auth is the only path."
  },
  {
    "id": "imap",
    "label": "IMAP/SMTP (generic)",
    "class": "e",
    "alsoClass": [
      "c",
      "d"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "docs": "https://developers.google.com/workspace/gmail/imap/xoauth2-protocol"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Host + user + app password (Fastmail, iCloud, generic); for Gmail/Outlook use the provider OAuth class instead.",
    "evidence": [
      "https://developers.google.com/workspace/gmail/imap/xoauth2-protocol",
      "https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online",
      "search results; Microsoft device flow fixtures outlook.device.json / outlook.oidc.json from another slice"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "SASL XOAUTH2 is the OAuth route: Exchange Online and personal Outlook.com/Hotmail require it (basic auth disabled); Google disabled basic auth for Workspace (Mar 2025); personal Gmail app passwords still work (UNVERIFIED). Gmail scope mail.google.com is restricted (BYO client in testing mode works for the owner). Microsoft supports device code (class d) with the IMAP scope. Other IMAP hosts: password only."
  },
  {
    "id": "mongodb-uri",
    "label": "MongoDB (connection string, stdio)",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "mongodb",
    "endpoints": {
      "docs": "https://www.mongodb.com/docs/mcp-server/overview/"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "until revoked",
    "redirectRules": "n/a",
    "ownerSetup": "Superseded by the OAuth sibling entry; keep only as manual fallback.",
    "apiAfterConnect": "stdio token",
    "evidence": [
      "https://www.mongodb.com/docs/mcp-server/overview/"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Direct DB wire access is credential-only; class e is correct. Atlas OAuth only covers the Atlas Admin API/MCP (see 'mongodb')."
  },
  {
    "id": "mqtt",
    "label": "MQTT broker",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Broker URL + user/password.",
    "apiAfterConnect": "tcp:mqtt broker",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Broker-defined username/password or TLS client cert; brokers rarely use OAuth. Local/LAN service."
  },
  {
    "id": "notion-token",
    "label": "Notion (internal token, stdio)",
    "class": "e",
    "alsoClass": [
      "a",
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "notion",
    "endpoints": {
      "docs": "https://developers.notion.com/docs/authorization"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "static, no expiry documented",
    "redirectRules": "n/a",
    "ownerSetup": "Superseded by the hosted 'notion' OAuth entry; token path is only a fallback.",
    "apiAfterConnect": "rest:https://api.notion.com/v1",
    "evidence": [
      "https://developers.notion.com/docs/authorization (internal connection token and PATs)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.notion.com/v1/users/me"
    },
    "notes": "Keep only as hidden fallback. Docs list three mechanisms: internal connection token, personal access token, public OAuth connection."
  },
  {
    "id": "openai",
    "label": "OpenAI API",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://auth.openai.com",
      "authorize": "https://auth.openai.com/api/accounts/authorize",
      "token": "https://auth.openai.com/api/accounts/oauth/token",
      "docs": "https://platform.openai.com/docs/api-reference/authentication"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Paste an OpenAI API key (billing account).",
    "apiAfterConnect": "rest:https://api.openai.com/v1",
    "evidence": [
      "https://auth.openai.com/.well-known/openid-configuration (LIVE: auth-code+refresh, S256, auth methods none/basic/post, scopes openid profile email offline_access)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/openai.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "No third-party OAuth for the OpenAI API (platform keys only). auth.openai.com IS a live public OAuth AS (PKCE, no secret) but is the ChatGPT-account login used by first-party clients such as Codex CLI (\"Sign in with ChatGPT\"); its client id is not registrable by third parties and usage bills to a ChatGPT plan, not the API. Reusing the Codex client id would be impersonation/ToS risk -- owner decision. LIVE applies to the AS metadata only; the \"no third-party OAuth\" claim is doc/knowledge."
  },
  {
    "id": "plaid",
    "label": "Plaid",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "resource": "https://production.plaid.com",
      "docs": "https://plaid.com/docs/link/hosted-link/"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "Item access_token long-lived, no expiry",
    "redirectRules": "Link redirect_uri / hosted-link completion URL must be allowlisted in the Plaid dashboard.",
    "ownerSetup": "Sign up for Plaid, paste client_id + secret; link each bank through Plaid Hosted Link on the phone (bank-side OAuth happens inside Link).",
    "apiAfterConnect": "rest:https://production.plaid.com",
    "evidence": [
      "https://plaid.com/docs/link/hosted-link/ (docs only)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "POST",
      "url": "https://production.plaid.com/institutions/get"
    },
    "notes": "No login-as-owner OAuth: API auth is client_id+secret. Hosted Link gives a URL the phone can open (mint link_token server-side) so no redirect hosting is needed. Production access needs Plaid approval; personal use limits UNVERIFIED. Registry entry plaid points at api.dashboard.plaid.com/mcp/sse (the DASHBOARD MCP, other slice), which is not a bank-data connector; a real bank connector needs its own id."
  },
  {
    "id": "render",
    "label": "Render",
    "class": "e",
    "alsoClass": [
      "b"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.render.com",
      "authorize": "https://api.render.com/v1/oauth/authorize",
      "token": "https://api.render.com/v1/oauth/token",
      "revoke": "https://api.render.com/v1/oauth/token/revoke",
      "mcp": "https://mcp.render.com/mcp",
      "resource": "https://mcp.render.com/mcp",
      "docs": "https://render.com/docs/mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "UNVERIFIED",
    "redirectRules": "Unknown: no DCR and no documented client registration.",
    "ownerSetup": "Obtain a Render OAuth client_id (no documented self-service console - UNVERIFIED); until then use the API key.",
    "apiAfterConnect": "mcp:https://mcp.render.com/mcp",
    "evidence": [
      "https://mcp.render.com/mcp unauthenticated initialize -> 401 + resource_metadata (live)",
      "PRM + authorization-server metadata fetched live (see fixtures)",
      "https://render.com/docs/mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "mcp/render.json",
      "idp/render.as.json",
      "idp/render.prm.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.render.com/v1/owners"
    },
    "notes": "REGISTRY KIND WRONG (listed mcp-key): live 401 carries resource_metadata, PRM names https://api.render.com, AS metadata live with authorization_code+refresh_token, S256, public clients only ('none'). Render docs: OAuth is primary for interactive clients (official plugins), API key for non-interactive. AS has NO registration_endpoint and no CIMD flag, so no DCR: official plugins appear to use a pre-registered public client; no self-service registration found in docs (UNVERIFIED how to obtain a client_id; ask Render). Until then keep API key path https://dashboard.render.com/settings#api-keys. Render's OAuth server is live but has no way to obtain a client id (no self-service console, no DCR): the API key is the only working path today."
  },
  {
    "id": "resend",
    "label": "Resend",
    "class": "e",
    "alsoClass": [
      "a"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://api.resend.com",
      "authorize": "https://api.resend.com/oauth/authorize",
      "token": "https://api.resend.com/oauth/token",
      "revoke": "https://api.resend.com/oauth/revoke",
      "register": "https://api.resend.com/oauth/register",
      "mcp": "https://mcp.resend.com/mcp",
      "resource": "https://mcp.resend.com",
      "docs": "https://resend.com/docs/mcp-server"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [
      "emails:send",
      "full_access"
    ],
    "refreshTokens": true,
    "redirectRules": "Not tested (lead does DCR). Also advertises client_id_metadata_document_supported=true (CIMD).",
    "ownerSetup": "None if DCR accepts the Ares https callback; owner just signs in to Resend and picks the team.",
    "apiAfterConnect": "mcp:https://mcp.resend.com/mcp",
    "evidence": [
      "https://resend.com/.well-known/oauth-authorization-server (LIVE)",
      "https://mcp.resend.com/.well-known/oauth-protected-resource (LIVE)",
      "unauth initialize -> 401 WWW-Authenticate resource_metadata (LIVE)",
      "https://resend.com/docs/mcp-server"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/resend.as.json",
      "idp/resend.prm.json"
    ],
    "facts": {
      "dcr": true,
      "device": false,
      "cimd": true,
      "pkceS256": true,
      "revocation": true,
      "publicClient": true
    },
    "notes": "Real OAuth 2.1 with registration_endpoint (DCR), S256, none/secret client auth, refresh_token grant. DCR redirect acceptance NOT probed -> lead must confirm; if allowlisted it drops to b. MCP also accepts a raw re_ API key as Bearer. Unclear whether the OAuth token works on the REST API (docs say MCP); use MCP tools. Owner can revoke under Resend Team settings. Resend's hosted MCP supports OAuth with dynamic registration, but the Email tool sends with an API key, which OAuth does not give: the key stays (class e)."
  },
  {
    "id": "sentry-token",
    "label": "Sentry (auth token, stdio)",
    "class": "e",
    "alsoClass": [
      "a"
    ],
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "sentry",
    "endpoints": {
      "docs": "https://sentry.io/settings/account/api/auth-tokens/"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [
      "org:read",
      "project:read",
      "event:read"
    ],
    "refreshTokens": false,
    "tokenLifetime": "until revoked",
    "redirectRules": "n/a",
    "ownerSetup": "Superseded by the OAuth sibling entry; keep only as manual fallback.",
    "apiAfterConnect": "stdio token",
    "evidence": [
      "https://sentry.io/settings/account/api/auth-tokens/"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Keep only as fallback for self-hosted Sentry."
  },
  {
    "id": "shopify-dev",
    "label": "Shopify Dev (docs MCP)",
    "class": "e",
    "flow": "none",
    "registry": "existing",
    "endpoints": {
      "mcp": "https://shopify.dev/mcp",
      "docs": "https://shopify.dev/docs/apps/build/devmcp"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "n/a",
    "redirectRules": "n/a",
    "ownerSetup": "none",
    "apiAfterConnect": "mcp:https://shopify.dev/mcp",
    "evidence": [
      "https://shopify.dev/docs/apps/build/devmcp"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "POST",
      "url": "https://shopify.dev/mcp"
    },
    "notes": "Existing id shopify is the no-auth docs/schema MCP: no OAuth needed (auth none correct; class e here just means no OAuth applies). It exposes no store data. The store connector needs a DIFFERENT id (see shopify-store) because the brief id shopify collides with this one."
  },
  {
    "id": "simplefin",
    "label": "SimpleFIN Bridge",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "resource": "https://bridge.simplefin.org/simplefin",
      "docs": "https://www.simplefin.org/protocol.html"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "access URL with embedded basic-auth, no expiry",
    "redirectRules": "n/a",
    "ownerSetup": "Create a SimpleFIN Bridge account (paid), generate a Setup Token, paste it once; Ares claims it to get the access URL.",
    "apiAfterConnect": "rest:https://bridge.simplefin.org/simplefin/accounts",
    "evidence": [
      "https://www.simplefin.org/protocol.html (docs only)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "No OAuth by design; the setup token is single-use and exchanged for the long-lived access URL. Daily request cap (about 24/day, docs)."
  },
  {
    "id": "slack-bot",
    "label": "Slack bot (xoxb)",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "slack",
    "endpoints": {
      "issuer": "https://slack.com",
      "authorize": "https://slack.com/oauth/v2/authorize",
      "token": "https://slack.com/api/oauth.v2.access",
      "revoke": "https://slack.com/api/auth.revoke",
      "userinfo": "https://slack.com/api/auth.test",
      "docs": "https://docs.slack.dev/authentication/installing-with-oauth/"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "channels:read",
      "channels:history",
      "groups:history",
      "im:history",
      "chat:write",
      "users:read",
      "reactions:write",
      "files:read"
    ],
    "scopeSeparator": ",",
    "refreshTokens": false,
    "tokenLifetime": "xoxb bot token does not expire unless token rotation is enabled (then 12h + single-use refresh)",
    "redirectRules": "https required, exact-match against the app's Redirect URLs list. Ares https tunnel callback works.",
    "ownerSetup": "Same Slack app as 'slack' (or a second one): add bot scopes + redirect URL, then Ares runs the install flow and stores the xoxb token instead of the owner pasting it.",
    "setup": {
      "consoleUrl": "https://api.slack.com/apps",
      "appType": "Create New App > From scratch",
      "steps": [
        "Add redirect URL https://ares.mistiqueai.com/oauth/callback",
        "Add Bot Token Scopes",
        "Copy client id + secret into Ares; Ares sends owner to oauth/v2/authorize?scope=<bot scopes>, exchanges code at oauth.v2.access, stores authed bot access_token"
      ],
      "fields": [
        "client_id",
        "client_secret"
      ],
      "deviceFlowCheckbox": "none",
      "reviewRequired": "None for a workspace-installed (non-distributed) app."
    },
    "apiAfterConnect": "stdio MCP (Slack bot server) with SLACK_BOT_TOKEN env = token Ares obtained via oauth.v2.access; or rest:https://slack.com/api",
    "evidence": [
      "https://docs.slack.dev/authentication/installing-with-oauth/ (fetched: https redirect required, scope= for bot, user_scope= for user, tokens do not expire)",
      "live probe: POST https://slack.com/api/oauth.v2.access with bogus client -> {\"ok\":false,\"error\":\"invalid_code\"} (endpoint alive)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/slack.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "POST",
      "url": "https://slack.com/api/auth.test"
    },
    "notes": "The pasted xoxb token path is what exists today; the OAuth install flow produces the identical token, so the owner never copies it. Single app can hold both bot and user scopes (one authorize call with scope= and user_scope=). Bot reads only channels it has been invited to."
  },
  {
    "id": "stripe-key",
    "label": "Stripe (restricted/secret key)",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "resource": "https://api.stripe.com/v1",
      "docs": "https://docs.stripe.com/keys"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "static key until rolled",
    "redirectRules": "n/a",
    "ownerSetup": "Dashboard > Developers > API keys > create a restricted read-only key and paste it.",
    "apiAfterConnect": "rest:https://api.stripe.com/v1",
    "evidence": [
      "https://docs.stripe.com/keys",
      "https://docs.stripe.com/mcp"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.stripe.com/v1/balance"
    },
    "notes": "Redundant once stripe MCP OAuth works; keep only as fallback. Use restricted keys. Connect OAuth requires platform registration (not for personal use)."
  },
  {
    "id": "supabase-token",
    "label": "Supabase (PAT, stdio)",
    "class": "e",
    "alsoClass": [
      "a"
    ],
    "flow": "api-key",
    "registry": "existing",
    "supersededBy": "supabase",
    "endpoints": {
      "docs": "https://supabase.com/dashboard/account/tokens"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "until revoked",
    "redirectRules": "n/a",
    "ownerSetup": "Superseded by the OAuth sibling entry; keep only as manual fallback.",
    "apiAfterConnect": "stdio token",
    "evidence": [
      "https://supabase.com/dashboard/account/tokens"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "healthCheck": {
      "method": "GET",
      "url": "https://api.supabase.com/v1/organizations"
    },
    "notes": "Remote MCP has DCR OAuth; fold into 'supabase'."
  },
  {
    "id": "tailscale",
    "label": "Tailscale",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "issuer": "https://login.tailscale.com",
      "authorize": "https://login.tailscale.com/a/oauth_authorize",
      "token": "https://api.tailscale.com/api/v2/oauth/token",
      "docs": "https://tailscale.com/docs/features/oauth-clients"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "OAuth-client access token 1h fixed; plain API access token up to 90 days",
    "ownerSetup": "Create a scoped OAuth client (client_credentials) or API access token in the admin console and paste it.",
    "apiAfterConnect": "rest:https://api.tailscale.com/api/v2",
    "evidence": [
      "https://tailscale.com/docs/features/oauth-clients",
      "https://login.tailscale.com/.well-known/openid-configuration (LIVE)",
      "LIVE: bogus POST to api.tailscale.com/api/v2/oauth/token -> 401 \"API token invalid\""
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/tailscale.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.tailscale.com/api/v2/tailnet/-/devices"
    },
    "notes": "Docs: OAuth clients support ONLY client_credentials and must be created by an Owner/Admin/Network/IT admin -- no user-delegated auth-code flow for third-party apps. login.tailscale.com OIDC (openid scope only) is identity sign-in. `tailscale up` browser login enrolls a device, not an API grant. Prefer a scoped OAuth client over a 90-day API key, but it is still owner-pasted secrets: class e."
  },
  {
    "id": "tessie",
    "label": "Tessie (Tesla)",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "docs": "https://developer.tessie.com/reference/authentication"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Generate an access token in Tessie developer settings and paste it (no OAuth for third parties exists).",
    "apiAfterConnect": "rest:https://api.tessie.com",
    "evidence": [
      "https://developer.tessie.com/reference/authentication",
      "https://developer.tessie.com/reference/access-tesla-fleet-api",
      "https://developer.tessie.com/reference/quick-start",
      "https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens",
      "https://auth.tesla.com/oauth2/v3/.well-known/openid-configuration (LIVE)"
    ],
    "verification": "LIVE-VERIFIED",
    "fixtures": [
      "idp/tesla.oidc.json"
    ],
    "facts": {
      "dcr": false,
      "device": false,
      "cimd": false,
      "pkceS256": false,
      "revocation": false,
      "publicClient": false
    },
    "healthCheck": {
      "method": "GET",
      "url": "https://api.tessie.com/vehicles"
    },
    "notes": "Tessie docs describe only a bearer token (header or access_token query); its pitch is \"API key instead of OAuth\". Tessie does not document OAuth for third-party apps. Alternative: Tesla Fleet API direct: OAuth2 auth-code at https://auth.tesla.com/oauth2/v3/authorize, token POST https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token (per docs) -- requires a developer.tesla.com app, a domain hosting your public key at /.well-known/appspecific/com.tesla.3p.public-key.pem, partner registration, virtual-key pairing + command signing proxy for commands, and usage-based Fleet API billing (UNVERIFIED amounts). Scopes: openid offline_access user_data vehicle_device_data vehicle_cmds vehicle_charging_cmds; refresh token 3 months, single use. Tesla discovery doc LIVE-verified (fixtures/tesla.oidc.json: grant authorization_code only, client_secret_post, no PKCE advertised, no device flow; bogus token POST -> client_not_found, endpoint alive). Recommendation: keep Tessie token; Fleet-direct is class c with heavy setup."
  },
  {
    "id": "ticketmaster",
    "label": "Ticketmaster Discovery",
    "class": "e",
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Create a free key at developer.ticketmaster.com and paste it.",
    "apiAfterConnect": "rest:https://app.ticketmaster.com/discovery/v2",
    "evidence": [
      "https://developer.ticketmaster.com/products-and-docs/apis/getting-started/"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Discovery API is public-data search with an apikey query param; no OAuth. Purchasing is not exposed by any public API. Not fetched (knowledge)."
  },
  {
    "id": "twilio",
    "label": "Twilio",
    "class": "e",
    "alsoClass": [
      "c"
    ],
    "flow": "api-key",
    "registry": "existing",
    "endpoints": {
      "token": "https://oauth.twilio.com/v2/token",
      "docs": "https://www.twilio.com/docs/iam/oauth-apps/overview"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [],
    "refreshTokens": true,
    "tokenLifetime": "3600s access (doc example); refresh token for auth-code grant",
    "ownerSetup": "Create an OAuth app in the Twilio Console (client id/secret) -- or just keep Account SID + Auth Token/API key.",
    "apiAfterConnect": "rest:https://api.twilio.com (Bearer)",
    "evidence": [
      "https://www.twilio.com/docs/iam/oauth-apps/overview",
      "https://www.twilio.com/docs/iam/oauth-apps/oauth-access-token",
      "LIVE: bogus POST to https://oauth.twilio.com/v2/token -> 401 code 321401 \"Invalid credentials\""
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "CORRECTION to the brief: Twilio now has first-party OAuth Apps (client_credentials AND authorization_code + refresh; token endpoint alive as probed). Authorize URL / PKCE / scopes not found in the docs fetched. Legacy Twilio Connect is not OAuth. For an owner using their OWN account, client_credentials adds nothing over an API key; auth-code only matters for multi-user apps. Hosted MCP mcp.twilio.com/docs is docs-only, no auth. Treat as e in practice."
  },
  {
    "id": "amazon",
    "label": "Amazon (shopping)",
    "class": "f",
    "alsoClass": [
      "c"
    ],
    "flow": "browser",
    "registry": "existing",
    "endpoints": {
      "authorize": "https://www.amazon.com/ap/oa",
      "token": "https://api.amazon.com/auth/o2/token",
      "docs": "https://developer.amazon.com/docs/login-with-amazon/documentation-overview.html"
    },
    "pkce": false,
    "clientAuth": "client_secret_post",
    "scopes": [
      "profile",
      "postal_code"
    ],
    "refreshTokens": false,
    "ownerSetup": "none",
    "unsupportedReason": "Amazon only provides identity sign-in, not order or cart access, and its seller APIs are for sellers only.",
    "evidence": [
      "https://developer.amazon.com/docs/login-with-amazon/documentation-overview.html (not fetched; from knowledge)",
      "api.amazon.com/.well-known/openid-configuration -> HTTP 403 to curl"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Login with Amazon is class c but IDENTITY ONLY -- cannot read orders/cart or buy. SP-API is seller-only. No consumer shopping API -> browser session is the honest answer."
  },
  {
    "id": "doordash",
    "label": "DoorDash",
    "class": "f",
    "alsoClass": [
      "b"
    ],
    "flow": "browser",
    "registry": "existing",
    "endpoints": {
      "docs": "https://developer.doordash.com/en-US/docs/mcp/overview/about_mcp/"
    },
    "pkce": true,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "Join the DoorDash MCP waitlist and request an OAuth client with redirect https://ares.mistiqueai.com/oauth/callback; else stay on browser.",
    "selfServe": false,
    "unsupportedReason": "DoorDash MCP is a private corporate beta; until DoorDash approves an OAuth client for you, Ares uses the browser.",
    "evidence": [
      "https://developer.doordash.com/en-US/docs/mcp/overview/about_mcp/",
      "https://developer.doordash.com/en-US/docs/mcp/tutorials/get_started/"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "DoorDash MCP uses OAuth 2.1 + PKCE (\"Sign in with DoorDash\") but is PRIVATE BETA: waitlist, DoorDash provisions an OAuth client per approved agent (custom redirect URIs on request); intended for corporate/organizational ordering, \"not designed for consumer-facing products or personal workflows\" (a separate DoorDash CLI is the single-user path; not researched). DoorDash Drive is B2B logistics. mcp.doordash.com did not connect from here, so no endpoint verified. Class b only if the owner is accepted; today browser."
  },
  {
    "id": "opentable",
    "label": "OpenTable",
    "class": "f",
    "flow": "browser",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "unsupportedReason": "OpenTable only offers its booking API to approved restaurant and affiliate partners, not individuals.",
    "evidence": [
      "partner/affiliate program only (UNVERIFIED, no doc fetched)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Booking/availability APIs are partner-only; no consumer OAuth. Keep browser session."
  },
  {
    "id": "peloton",
    "label": "Peloton",
    "class": "f",
    "flow": "browser",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "unsupportedReason": "Peloton has no public API, so Ares can only use your logged-in browser session.",
    "evidence": [
      "no public developer program found (UNVERIFIED: absence of evidence)"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "No official public API or OAuth. Community clients use the unofficial api.onepeloton.com username/password login -- not OAuth, may break, ToS risk. Keep browser session."
  },
  {
    "id": "arxiv",
    "label": "arXiv",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "keyless public API; no remote auth."
  },
  {
    "id": "docker",
    "label": "Docker (local socket)",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "n/a",
    "redirectRules": "n/a",
    "ownerSetup": "none",
    "apiAfterConnect": "stdio local",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Local stdio against the Docker daemon socket; no network auth."
  },
  {
    "id": "duckduckgo",
    "label": "DuckDuckGo",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "keyless search; no remote auth."
  },
  {
    "id": "fetch",
    "label": "Fetch",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "plain HTTP fetch; no remote auth."
  },
  {
    "id": "filesystem",
    "label": "Filesystem",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local files; no remote auth."
  },
  {
    "id": "git",
    "label": "Git (local)",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "n/a",
    "redirectRules": "n/a",
    "ownerSetup": "none",
    "apiAfterConnect": "stdio local",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Local stdio against a local repo; remote auth is separate (see github/gitlab)."
  },
  {
    "id": "invideo",
    "label": "invideo",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {
      "mcp": "https://mcp.invideo.io/sse",
      "docs": "https://help.invideo.io/en/articles/11316042-invideo-model-context-protocol-server"
    },
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "n/a",
    "redirectRules": "n/a",
    "ownerSetup": "none (the SSE endpoint is open; generation is gated in the browser via links the tool returns)",
    "apiAfterConnect": "mcp:https://mcp.invideo.io/sse",
    "evidence": [
      "GET https://mcp.invideo.io/sse unauthenticated -> 200 text/event-stream with endpoint event",
      "/.well-known/oauth-protected-resource and oauth-authorization-server -> 404",
      "https://help.invideo.io/en/articles/11316042-invideo-model-context-protocol-server ('doesn't require any authorisation')"
    ],
    "verification": "UNVERIFIED",
    "fixtures": [
      "mcp/invideo.json"
    ],
    "notes": "REGISTRY KIND WRONG: catalog says auth oauth, but there is no OAuth (open SSE, no PRM). Change to auth none. No account link means no per-user data; confirm tool behavior before shipping."
  },
  {
    "id": "kubernetes",
    "label": "Kubernetes (kubeconfig)",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "tokenLifetime": "n/a",
    "redirectRules": "n/a",
    "ownerSetup": "none",
    "apiAfterConnect": "stdio local",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "Local stdio against the user's kubeconfig; auth is whatever the kubeconfig holds. No Ares OAuth applies."
  },
  {
    "id": "memory",
    "label": "Memory",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local knowledge graph; no remote auth."
  },
  {
    "id": "obsidian",
    "label": "Obsidian",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local vault files; no remote auth."
  },
  {
    "id": "open-meteo",
    "label": "Open-Meteo",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "keyless weather API; no remote auth."
  },
  {
    "id": "playwright",
    "label": "Playwright",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local browser automation; no remote auth."
  },
  {
    "id": "postgres",
    "label": "Postgres",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "owner-supplied connection string, no vendor auth; no remote auth."
  },
  {
    "id": "sequential-thinking",
    "label": "Sequential Thinking",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "pure local reasoning tool; no remote auth."
  },
  {
    "id": "sqlite",
    "label": "SQLite",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local db file; no remote auth."
  },
  {
    "id": "time",
    "label": "Time",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "local clock; no remote auth."
  },
  {
    "id": "wikipedia",
    "label": "Wikipedia",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "keyless public API; no remote auth."
  },
  {
    "id": "youtube-transcript",
    "label": "YouTube Transcript",
    "class": "n",
    "flow": "none",
    "registry": "existing",
    "endpoints": {},
    "pkce": false,
    "clientAuth": "none",
    "scopes": [],
    "refreshTokens": false,
    "ownerSetup": "none",
    "evidence": [],
    "verification": "UNVERIFIED",
    "fixtures": [],
    "notes": "keyless caption fetch; no remote auth."
  }
];
