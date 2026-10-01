// Meta's non-standard token handling: 1h token -> 60-day swap, renewal without a refresh_token grant.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OAUTH_PROVIDERS, finalizeProviderTokens, getValidAccessToken, saveOAuthClient, storeTokens, loadTokens, unwrapInstagramToken } from "../packages/core/dist/index.js";

const json = (b, status = 200) => new Response(JSON.stringify(b), { status });

test("Instagram: the code exchange answers data[], the 1h token is swapped for a long-lived one, and renewal uses ig_refresh_token", async () => {
  const cfg = OAUTH_PROVIDERS.instagram;
  assert.deepEqual(unwrapInstagramToken({ data: [{ access_token: "short", user_id: "1" }] }).access_token, "short");
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(String(u));
    if (String(u).includes("ig_exchange_token")) return json({ access_token: "long-lived", token_type: "bearer", expires_in: 5184000 });
    if (String(u).includes("ig_refresh_token")) return json({ access_token: "renewed", token_type: "bearer", expires_in: 5184000 });
    return json({ error: { message: "nope", code: 190 } }, 400);
  };
  const home = await mkdtemp(path.join(tmpdir(), "ares-meta-"));
  const t0 = 1_000_000;
  const tokens = await finalizeProviderTokens(cfg, { accessToken: "short", expiresAt: t0 + 3600_000 }, { client: { clientId: "app", clientSecret: "sec" }, via: "code" }, { fetchImpl, now: () => t0 });
  assert.equal(tokens.accessToken, "long-lived");
  assert.equal(tokens.expiresAt, t0 + 5184000 * 1000);
  assert.ok(calls[0].includes("client_secret=sec"));
  await saveOAuthClient("instagram", { clientId: "app", clientSecret: "sec" }, { home });
  await storeTokens("instagram", tokens, { home });
  // far from expiry: no network
  assert.equal(await getValidAccessToken(cfg, { home, fetchImpl, now: () => t0 + 86_400_000 }), "long-lived");
  assert.equal(calls.length, 1);
  // inside the 7-day renewal window: renewed in place
  assert.equal(await getValidAccessToken(cfg, { home, fetchImpl, now: () => t0 + 5184000 * 1000 - 3 * 86_400_000 }), "renewed");
  assert.equal((await loadTokens("instagram", { home })).accessToken, "renewed");
  // a token Meta no longer accepts marks the grant dead
  const dead = async () => json({ error: { message: "Error validating access token", code: 190 } }, 400);
  await assert.rejects(getValidAccessToken(cfg, { home, fetchImpl: dead, now: () => t0 + 400 * 86_400_000 }), /OAUTH_EXPIRED/);
  assert.equal((await loadTokens("instagram", { home })).needsReauth, true);
});
