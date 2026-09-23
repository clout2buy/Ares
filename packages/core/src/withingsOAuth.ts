// Withings — OAuth2 with three quirks the generic module has to be told about.
//
// Docs: https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/oauth-authorization-url
//       https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/get-access/access-and-refresh-tokens-no-recover
//
//  1. Scopes are COMMA-separated in the authorize URL (`user.info,user.metrics`).
//  2. The token endpoint (POST https://wbsapi.withings.net/v2/oauth2) is an
//     "action" webservice: every call carries `action=requesttoken`, for the
//     code exchange and the refresh alike.
//  3. The response is enveloped — HTTP 200 with `{status, body:{access_token,
//     refresh_token, expires_in, userid, scope}}` — and a failure is a non-zero
//     `status` on a 200, so an unwrapped read would store an empty token.
//
// The authorization code lives 30 seconds, access tokens 3 hours, and every
// refresh ROTATES the refresh token (the old one dies 8 hours later) — the
// generic refresh path already persists the new pair each time.

import type { OAuthProviderConfig } from "./oauth.js";

export function unwrapWithingsToken(json: Record<string, unknown>): Record<string, unknown> {
  const status = Number(json.status);
  if (status !== 0) {
    const why = typeof json.error === "string" ? json.error : `status ${String(json.status)}`;
    throw new Error(`Withings token request failed: ${why}`);
  }
  const body = json.body;
  if (!body || typeof body !== "object") throw new Error("Withings token response had no body");
  return body as Record<string, unknown>;
}

export const WITHINGS_OAUTH: OAuthProviderConfig = {
  provider: "withings",
  authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
  tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
  scopes: ["user.info", "user.metrics", "user.activity"],
  scopeSeparator: ",",
  extraTokenParams: { action: "requesttoken" },
  unwrapTokenResponse: unwrapWithingsToken,
};
