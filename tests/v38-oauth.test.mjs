// Verifies the in-house OAuth2 module — the primitive every Google/Meta/X
// connector rides:
//   1. buildAuthorizeUrl encodes client/redirect/scope/state correctly.
//   2. exchangeCodeForTokens parses the first token pair + computes expiry.
//   3. getValidAccessToken returns a still-valid token without refreshing.
//   4. getValidAccessToken auto-refreshes an expired token and re-persists it,
//      keeping the prior refresh_token when the provider omits a new one.
//   5. Un-authorized providers fail with a clear, actionable error.
// All hermetic: fetch + clock are injected, no real provider is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  storeTokens,
  loadTokens,
  setCredential,
} from "../packages/core/dist/index.js";

const GOOGLE = {
  provider: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/gmail.send"],
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
};

async function freshHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v38-"));
  process.env.ARES_HOME = home;
  return home;
}

/** A fake token endpoint that records the grant_type it was asked for. */
function fakeTokenFetch(responder) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = new URLSearchParams(init.body);
    calls.push(Object.fromEntries(body));
    const { status = 200, json } = responder(Object.fromEntries(body));
    return { ok: status < 400, status, json: async () => json };
  };
  return { fetchImpl, calls };
}

test("oauth: buildAuthorizeUrl encodes the consent request", () => {
  const url = new URL(
    buildAuthorizeUrl(GOOGLE, {
      clientId: "cid.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:7421/callback",
      state: "xyz",
    }),
  );
  assert.equal(url.searchParams.get("client_id"), "cid.apps.googleusercontent.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:7421/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.send");
  assert.equal(url.searchParams.get("state"), "xyz");
  assert.equal(url.searchParams.get("access_type"), "offline", "provider extra params are included");
});

test("oauth: exchangeCodeForTokens parses the first token pair and expiry", async () => {
  const { fetchImpl, calls } = fakeTokenFetch(() => ({
    json: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" },
  }));
  const tokens = await exchangeCodeForTokens(
    GOOGLE,
    { code: "auth-code", clientId: "cid", clientSecret: "secret", redirectUri: "http://127.0.0.1/cb" },
    { fetchImpl, now: () => 1_000_000 },
  );
  assert.equal(calls[0].grant_type, "authorization_code");
  assert.equal(tokens.accessToken, "at-1");
  assert.equal(tokens.refreshToken, "rt-1");
  assert.equal(tokens.expiresAt, 1_000_000 + 3600 * 1000);
});

test("oauth: getValidAccessToken returns a still-valid token without a network call", async () => {
  const home = await freshHome();
  await storeTokens("google", { accessToken: "at-good", refreshToken: "rt", expiresAt: 10_000_000 }, { home });
  let called = false;
  const token = await getValidAccessToken(GOOGLE, {
    home,
    now: () => 9_000_000, // well before expiry
    fetchImpl: async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  assert.equal(token, "at-good");
  assert.equal(called, false, "no refresh when the token is still valid");
});

test("oauth: getValidAccessToken auto-refreshes an expired token and re-persists", async () => {
  const home = await freshHome();
  await setCredential("GOOGLE_OAUTH_CLIENT_ID", "cid", { home });
  await setCredential("GOOGLE_OAUTH_CLIENT_SECRET", "secret", { home });
  await storeTokens("google", { accessToken: "at-old", refreshToken: "rt-keep", expiresAt: 1_000 }, { home });

  const { fetchImpl, calls } = fakeTokenFetch((form) => {
    assert.equal(form.grant_type, "refresh_token");
    assert.equal(form.refresh_token, "rt-keep");
    return { json: { access_token: "at-new", expires_in: 3600 } }; // note: no refresh_token returned
  });

  const token = await getValidAccessToken(GOOGLE, { home, now: () => 5_000_000, fetchImpl });
  assert.equal(token, "at-new");
  assert.equal(calls.length, 1);

  // Re-persisted, and the prior refresh token was preserved (provider omitted it).
  const stored = await loadTokens("google", { home });
  assert.equal(stored.accessToken, "at-new");
  assert.equal(stored.refreshToken, "rt-keep");
});

test("oauth: an un-authorized provider fails with an actionable error", async () => {
  const home = await freshHome();
  await assert.rejects(() => getValidAccessToken(GOOGLE, { home, now: () => 1 }), /OAUTH_NOT_AUTHORIZED/);
});
