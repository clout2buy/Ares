// Vendors whose OAuth is not stock RFC 6749, as small pure functions.
//
// Meta (Instagram Login, Facebook Login, Threads) hands out a ~1h token from
// the code exchange, then wants it swapped for a 60-day one over a GET, and has
// NO refresh_token grant: the long-lived token itself is renewed (Instagram and
// Threads: a dedicated refresh call once it is >24h old; Facebook: swap it
// again). Without this a "connected" Instagram would die in an hour.
//
// Docs (read 2026-09-30):
//   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//   https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions
// Query-string secrets are the vendor's requirement for these GETs; the engine
// never logs them and every error is scrubbed.

import { OAuthError, scrubOAuthText } from "./oauthEngine.js";
import type { OAuthTokens } from "./oauth.js";

export interface VendorCtx {
  clientId: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

async function getJson(url: URL, ctx: VendorCtx): Promise<Record<string, unknown>> {
  const doFetch = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
  } catch {
    throw new OAuthError("network", "couldn't reach the token service");
  }
  const text = typeof res.text === "function" ? await res.text().catch(() => "") : JSON.stringify(await (res as unknown as { json(): Promise<unknown> }).json().catch(() => ({})));
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = {}; }
  if (!res.ok || typeof body.access_token !== "string") {
    const err = body.error as { message?: string; type?: string; code?: number } | string | undefined;
    const message = typeof err === "string" ? err : err?.message ?? `HTTP ${res.status}`;
    // Meta signals a dead token as an OAuthException (code 190): treat it as invalid_grant.
    const dead = typeof err === "object" && err?.code === 190;
    throw new OAuthError(dead ? "invalid_grant" : "invalid_request", scrubOAuthText(message), res.status);
  }
  return body;
}

function longLived(body: Record<string, unknown>, now: number, prev?: OAuthTokens): OAuthTokens {
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token as string,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : prev?.expiresAt ? { expiresAt: prev.expiresAt } : {}),
    ...(prev?.scope ? { scope: prev.scope } : {}),
    tokenType: typeof body.token_type === "string" ? body.token_type : "bearer",
    ...(prev?.meta ? { meta: prev.meta } : {}),
  };
}

/** Instagram's code exchange answers `{data:[{access_token,user_id}]}` (new) or a flat object (old). */
export function unwrapInstagramToken(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") return { ...(data[0] as Record<string, unknown>), token_type: "bearer" };
  return json;
}

/** Instagram: short-lived (1h) -> long-lived (60 days). */
export async function instagramExchange(tokens: OAuthTokens, ctx: VendorCtx): Promise<OAuthTokens> {
  const u = new URL("https://graph.instagram.com/access_token");
  u.searchParams.set("grant_type", "ig_exchange_token");
  u.searchParams.set("client_secret", ctx.clientSecret ?? "");
  u.searchParams.set("access_token", tokens.accessToken);
  return longLived(await getJson(u, ctx), (ctx.now ?? Date.now)(), tokens);
}

/** Instagram: renew a long-lived token (must be >=24h old and unexpired). */
export async function instagramRefresh(tokens: OAuthTokens, ctx: VendorCtx): Promise<OAuthTokens> {
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", tokens.accessToken);
  return longLived(await getJson(u, ctx), (ctx.now ?? Date.now)(), tokens);
}

/** Threads: short-lived -> long-lived (60 days). */
export async function threadsExchange(tokens: OAuthTokens, ctx: VendorCtx): Promise<OAuthTokens> {
  const u = new URL("https://graph.threads.net/access_token");
  u.searchParams.set("grant_type", "th_exchange_token");
  u.searchParams.set("client_secret", ctx.clientSecret ?? "");
  u.searchParams.set("access_token", tokens.accessToken);
  return longLived(await getJson(u, ctx), (ctx.now ?? Date.now)(), tokens);
}

export async function threadsRefresh(tokens: OAuthTokens, ctx: VendorCtx): Promise<OAuthTokens> {
  const u = new URL("https://graph.threads.net/refresh_access_token");
  u.searchParams.set("grant_type", "th_refresh_token");
  u.searchParams.set("access_token", tokens.accessToken);
  return longLived(await getJson(u, ctx), (ctx.now ?? Date.now)(), tokens);
}

/** Facebook Login: short-lived user token -> long-lived (~60 days); re-run the same swap to renew. */
export async function facebookExchange(tokens: OAuthTokens, ctx: VendorCtx): Promise<OAuthTokens> {
  const u = new URL("https://graph.facebook.com/v23.0/oauth/access_token");
  u.searchParams.set("grant_type", "fb_exchange_token");
  u.searchParams.set("client_id", ctx.clientId);
  u.searchParams.set("client_secret", ctx.clientSecret ?? "");
  u.searchParams.set("fb_exchange_token", tokens.accessToken);
  return longLived(await getJson(u, ctx), (ctx.now ?? Date.now)(), tokens);
}
