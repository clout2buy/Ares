// The generic OAuth engine, proven against an in-test authorization server
// (tests/_oauthMock.mjs): authorization code + PKCE, dynamic registration (and
// its redirect allowlist), discovery, the device grant, refresh ROTATION with
// single-flight, revocation, `state` binding / replay / issuer mix-up refusal,
// and that no token ever lands in an error message or a plaintext vault.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  OAuthError,
  assertSecureEndpoint,
  beginAuthorization,
  beginProviderAuthorization,
  callbackParamsFromUrl,
  clientMetadataDocument,
  clientMetadataUrl,
  completeAuthorization,
  discoverIssuer,
  exchangeCodeForTokens,
  getValidAccessToken,
  loadTokens,
  newPkce,
  newState,
  parseAuthServerMetadata,
  pollDeviceAuthorization,
  refreshOAuthToken,
  registerOAuthClient,
  requestDeviceAuthorization,
  revokeAndForgetTokens,
  revokeOAuthToken,
  saveOAuthClient,
  scrubOAuthText,
  singleFlight,
  storeTokens,
  tokenRequest,
} from "../packages/core/dist/index.js";
import { startMockAuthServer } from "./_oauthMock.mjs";

const tmpHome = () => mkdtemp(path.join(tmpdir(), "ares-engine-"));
const REDIRECT = "https://ares.mistiqueai.com/oauth/callback";

test("PKCE: the challenge is the S256 of the verifier; states are unguessable", () => {
  const p = newPkce("fixed-verifier-for-the-test");
  const expected = createHash("sha256").update("fixed-verifier-for-the-test").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(p.challenge, expected);
  assert.equal(p.method, "S256");
  const states = new Set(Array.from({ length: 50 }, () => newState()));
  assert.equal(states.size, 50);
  for (const s of states) assert.ok(s.length >= 64);
});

test("endpoints: https only, plain http only on loopback; a token is never sent to http", async () => {
  assert.doesNotThrow(() => assertSecureEndpoint("https://example.com/token"));
  assert.doesNotThrow(() => assertSecureEndpoint("http://127.0.0.1:9/token"));
  assert.doesNotThrow(() => assertSecureEndpoint("http://localhost:9/token"));
  assert.throws(() => assertSecureEndpoint("http://example.com/token"), (e) => e instanceof OAuthError && e.code === "insecure_endpoint");
  let called = false;
  await assert.rejects(
    tokenRequest("http://example.com/token", { grant_type: "refresh_token", refresh_token: "rt-secret" }, { clientId: "c" }, { fetchImpl: async () => { called = true; return new Response("{}"); } }),
    (e) => e.code === "insecure_endpoint",
  );
  assert.equal(called, false, "no request was made to a plaintext endpoint");
});

test("discovery: parses an RFC 8414 document, reads device/CIMD/revocation, finds it via the mock", async (t) => {
  const m = await startMockAuthServer({ cimd: true });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  assert.equal(meta.issuer, m.origin);
  assert.equal(meta.tokenEndpoint, `${m.origin}/token`);
  assert.ok(meta.registrationEndpoint && meta.deviceAuthorizationEndpoint && meta.revocationEndpoint);
  assert.equal(meta.clientIdMetadataDocumentSupported, true);
  assert.deepEqual(meta.codeChallengeMethodsSupported, ["S256"]);
  assert.equal(parseAuthServerMetadata({ issuer: "x" }), null, "a document without a token endpoint is not usable");
  assert.equal(parseAuthServerMetadata(null), null);
});

test("authorization code + PKCE: register, consent, exchange; the server verified the PKCE verifier", async (t) => {
  const m = await startMockAuthServer();
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const client = await registerOAuthClient(meta.registrationEndpoint, { redirectUris: [REDIRECT] });
  assert.ok(client.clientId.startsWith("cl_"));
  assert.equal(client.authMethod, "none");
  const { authorizeUrl, pending } = beginAuthorization({
    authorizationEndpoint: meta.authorizationEndpoint,
    tokenEndpoint: meta.tokenEndpoint,
    client: { clientId: client.clientId },
    redirectUri: REDIRECT,
    scopes: ["read", "write"],
    issuer: meta.issuer,
    resource: `${m.origin}/mcp`,
  });
  const u = new URL(authorizeUrl);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("scope"), "read write");
  assert.equal(u.searchParams.get("resource"), `${m.origin}/mcp`);
  const redirect = await m.consent(authorizeUrl);
  const tokens = await completeAuthorization(pending, callbackParamsFromUrl(redirect));
  assert.ok(tokens.accessToken.startsWith("at_"));
  assert.ok(tokens.refreshToken.startsWith("rt_"));
  assert.ok(tokens.expiresAt > Date.now());
  const me = await fetch(`${m.origin}/userinfo`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  assert.equal(me.status, 200);
});

test("state binding: a wrong state is refused before ANY token request; a used flow cannot replay; a foreign issuer is refused", async (t) => {
  const m = await startMockAuthServer();
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const client = await registerOAuthClient(meta.registrationEndpoint, { redirectUris: [REDIRECT] });
  const mk = () => beginAuthorization({ authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, client: { clientId: client.clientId }, redirectUri: REDIRECT, issuer: meta.issuer });

  // 1. state mismatch
  const a = mk();
  const redirectA = await m.consent(a.authorizeUrl);
  const before = m.state.requests.filter((r) => r.path === "/token").length;
  const forged = callbackParamsFromUrl(redirectA);
  await assert.rejects(completeAuthorization(a.pending, { ...forged, state: "attacker-state" }), (e) => e.code === "state_mismatch");
  assert.equal(m.state.requests.filter((r) => r.path === "/token").length, before, "no code was exchanged for a callback that was not ours");

  // 2. replay of a flow that already completed
  const b = mk();
  const redirectB = await m.consent(b.authorizeUrl);
  await completeAuthorization(b.pending, callbackParamsFromUrl(redirectB));
  await assert.rejects(completeAuthorization(b.pending, callbackParamsFromUrl(redirectB)), (e) => e.code === "replay");

  // 3. RFC 9207 issuer mix-up: a redirect naming another issuer
  const c = mk();
  const redirectC = await m.consent(c.authorizeUrl);
  const params = callbackParamsFromUrl(redirectC);
  await assert.rejects(completeAuthorization(c.pending, { ...params, iss: "https://evil.example" }), (e) => e.code === "issuer_mismatch");

  // 4. the owner declined
  const d = mk();
  const redirectD = await m.consent(d.authorizeUrl, { deny: true });
  await assert.rejects(completeAuthorization(d.pending, callbackParamsFromUrl(redirectD)), (e) => e.code === "access_denied" && /declined/.test(e.message));
});

test("registration allowlist: a refused redirect is a typed error, not a silent fallback", async (t) => {
  const m = await startMockAuthServer({ redirectAllowlist: ["http://localhost", "http://127.0.0.1"] });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  await assert.rejects(registerOAuthClient(meta.registrationEndpoint, { redirectUris: [REDIRECT] }), (e) => e instanceof OAuthError && e.code === "invalid_redirect_uri");
  const loop = await registerOAuthClient(meta.registrationEndpoint, { redirectUris: ["http://localhost:53682/oauth/callback"] });
  assert.ok(loop.clientId);
});

test("device grant: pending then approved; slow_down adds 5s; the code is never in an error", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "dev-public-client" } });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const client = { clientId: "dev-public-client" };
  const device = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client, scopes: ["read"] });
  assert.equal(device.userCode, "WDJB-MJHT");
  assert.equal(device.verificationUri, `${m.origin}/device`);
  assert.equal(device.intervalSec, 5);
  assert.ok(device.expiresAt > Date.now());

  const waits = [];
  let polls = 0;
  m.state.slowDownOnce = true; // the first poll is "too fast"
  const sleep = async (ms) => {
    waits.push(ms);
    polls += 1;
    if (polls === 3) m.approveDevice(); // the owner enters the code after two polls
  };
  const tokens = await pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client, device, sleep });
  assert.ok(tokens.accessToken.startsWith("at_"));
  assert.deepEqual(waits, [5000, 10000, 10000], "slow_down adds 5s to the interval and keeps it");
});

test("device grant: denial and expiry end the poll with typed errors", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "dev-public-client" } });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const client = { clientId: "dev-public-client" };
  const denied = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client });
  await assert.rejects(
    pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client, device: denied, sleep: async () => m.denyDevice() }),
    (e) => e.code === "access_denied",
  );
  const expiring = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client });
  await assert.rejects(
    pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client, device: { ...expiring, expiresAt: Date.now() - 1 }, sleep: async () => {} }),
    (e) => e.code === "expired_token",
  );
  // an aborted poll stops cleanly
  const ctl = new AbortController();
  const pending = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client });
  const run = pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client, device: pending, signal: ctl.signal, sleep: (ms, signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new OAuthError("aborted", "cancelled"))); setTimeout(() => ctl.abort(), 1); }) });
  await assert.rejects(run, (e) => e.code === "aborted");
});

test("refresh rotation: the new refresh token replaces the old; reusing the old one is refused and kills the family", async (t) => {
  const m = await startMockAuthServer();
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const client = await registerOAuthClient(meta.registrationEndpoint, { redirectUris: [REDIRECT] });
  const { authorizeUrl, pending } = beginAuthorization({ authorizationEndpoint: meta.authorizationEndpoint, tokenEndpoint: meta.tokenEndpoint, client: { clientId: client.clientId }, redirectUri: REDIRECT });
  const first = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  const second = await refreshOAuthToken({ tokenEndpoint: meta.tokenEndpoint, client: { clientId: client.clientId }, refreshToken: first.refreshToken, prev: { refreshToken: first.refreshToken } });
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.equal(second.rotated, true);
  assert.notEqual(second.accessToken, first.accessToken);
  await assert.rejects(refreshOAuthToken({ tokenEndpoint: meta.tokenEndpoint, client: { clientId: client.clientId }, refreshToken: first.refreshToken }), (e) => e.code === "invalid_grant");
  // the family is dead now: even the newest refresh token no longer works (reuse detection)
  await assert.rejects(refreshOAuthToken({ tokenEndpoint: meta.tokenEndpoint, client: { clientId: client.clientId }, refreshToken: second.refreshToken }), (e) => e.code === "invalid_grant");
});

/** A provider config pointing at the mock, with a confidential client held in a throwaway vault. */
async function vaultedProvider(m, home, provider = "mockp") {
  const meta = await discoverIssuer(m.origin);
  const cfg = { provider, authorizeUrl: meta.authorizationEndpoint, tokenUrl: meta.tokenEndpoint, scopes: ["read"], pkce: true, clientAuth: "client_secret_post" };
  await saveOAuthClient(provider, { clientId: "conf-client", clientSecret: "conf-client-secret-value" }, { home });
  return cfg;
}

test("getValidAccessToken: concurrent callers share ONE refresh (single-flight), the vault keeps the rotated pair", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "conf-client", secret: "conf-client-secret-value" } });
  t.after(() => m.close());
  const home = await tmpHome();
  const cfg = await vaultedProvider(m, home);
  // authorize once for real so the server knows the refresh token
  const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client: { clientId: "conf-client", clientSecret: "conf-client-secret-value" }, redirectUri: REDIRECT });
  const t1 = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  await storeTokens("mockp", { accessToken: t1.accessToken, refreshToken: t1.refreshToken, expiresAt: Date.now() + 3600_000 }, { home });

  // jump the clock past expiry and fire many callers at once
  const later = () => Date.now() + 2 * 3600_000;
  const results = await Promise.all(Array.from({ length: 8 }, () => getValidAccessToken(cfg, { home, now: later })));
  const refreshCalls = m.state.requests.filter((r) => r.path === "/token" && /grant_type=refresh_token/.test(r.body));
  assert.equal(refreshCalls.length, 1, "eight racing callers made exactly one refresh request");
  assert.equal(new Set(results).size, 1, "every caller got the same fresh access token");
  const stored = await loadTokens("mockp", { home });
  assert.equal(stored.accessToken, results[0]);
  assert.notEqual(stored.refreshToken, t1.refreshToken, "the rotated refresh token was persisted");

  // a second expiry works with the rotated token (it would 400 with the old one)
  const evenLater = () => Date.now() + 5 * 3600_000;
  const again = await getValidAccessToken(cfg, { home, now: evenLater });
  assert.notEqual(again, results[0]);
});

test("a refresh the vendor rejects marks the grant needsReauth and stops hitting the network", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "conf-client", secret: "conf-client-secret-value" } });
  t.after(() => m.close());
  const home = await tmpHome();
  const cfg = await vaultedProvider(m, home);
  await storeTokens("mockp", { accessToken: "stale", refreshToken: "revoked-refresh-token", expiresAt: 1000 }, { home });
  await assert.rejects(getValidAccessToken(cfg, { home }), /OAUTH_EXPIRED: mockp refused the refresh token/);
  assert.equal((await loadTokens("mockp", { home })).needsReauth, true);
  const before = m.state.requests.length;
  await assert.rejects(getValidAccessToken(cfg, { home }), /OAUTH_EXPIRED/);
  assert.equal(m.state.requests.length, before, "no further requests once the grant is known dead");
});

test("revocation: RFC 7009 kills the token at the issuer; disconnect revokes THEN forgets", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "conf-client", secret: "conf-client-secret-value" } });
  t.after(() => m.close());
  const home = await tmpHome();
  const cfg = { ...(await vaultedProvider(m, home)), revokeUrl: `${m.origin}/revoke` };
  const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client: { clientId: "conf-client", clientSecret: "conf-client-secret-value" }, redirectUri: REDIRECT });
  const tok = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  await storeTokens("mockp", { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: Date.now() + 3600_000 }, { home });
  assert.equal((await fetch(`${m.origin}/userinfo`, { headers: { authorization: `Bearer ${tok.accessToken}` } })).status, 200);

  assert.equal(await revokeAndForgetTokens(cfg, "mockp", { home }), true);
  assert.equal((await fetch(`${m.origin}/userinfo`, { headers: { authorization: `Bearer ${tok.accessToken}` } })).status, 401, "the issuer no longer honours it");
  assert.equal(await loadTokens("mockp", { home }), undefined, "and it is gone from the vault");
  assert.equal(m.state.requests.some((r) => r.path === "/revoke" && /token_type_hint=refresh_token/.test(r.body)), true, "the long-lived refresh token was the one revoked");
  // a dead endpoint never blocks a disconnect
  assert.equal(await revokeOAuthToken({ endpoint: "http://127.0.0.1:1/revoke", token: "x", client: { clientId: "c" } }), false);
});

test("the vault: tokens are encrypted at rest and never appear in plaintext on disk", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "conf-client", secret: "conf-client-secret-value" } });
  t.after(() => m.close());
  const home = await tmpHome();
  const cfg = await vaultedProvider(m, home);
  const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client: { clientId: "conf-client", clientSecret: "conf-client-secret-value" }, redirectUri: REDIRECT });
  const tok = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  await storeTokens("mockp", { accessToken: tok.accessToken, refreshToken: tok.refreshToken, expiresAt: Date.now() + 3600_000, scope: "read" }, { home });
  const disk = await readFile(path.join(home, "credentials.json"), "utf8");
  assert.match(disk, /enc:v1:/);
  for (const secret of [tok.accessToken, tok.refreshToken, "conf-client-secret-value"]) assert.ok(!disk.includes(secret), "a secret sits in plaintext in credentials.json");
  assert.equal((await loadTokens("mockp", { home })).accessToken, tok.accessToken, "and it still round-trips");
});

test("client authentication: HTTP Basic and JSON bodies work; secrets never leak into thrown messages", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "basic-client", secret: "basic-client-secret" } });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const basicClient = { clientId: "basic-client", clientSecret: "basic-client-secret", authMethod: "client_secret_basic" };
  const dev = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client: basicClient });
  m.approveDevice();
  const ok = await pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client: basicClient, device: dev, sleep: async () => {} });
  assert.ok(ok.accessToken);
  // JSON token body (Notion's style)
  const dev2 = await requestDeviceAuthorization({ endpoint: meta.deviceAuthorizationEndpoint, client: { clientId: "basic-client", clientSecret: "basic-client-secret" } });
  m.approveDevice();
  const json = await pollDeviceAuthorization({ tokenEndpoint: meta.tokenEndpoint, client: { clientId: "basic-client", clientSecret: "basic-client-secret" }, device: dev2, quirks: { tokenBody: "json" }, sleep: async () => {} });
  assert.ok(json.accessToken);
  // a wrong secret fails, and the message carries no secret
  await assert.rejects(
    tokenRequest(meta.tokenEndpoint, { grant_type: "refresh_token", refresh_token: "rt-secret-refresh-token-0123456789abcdef0123456789" }, { clientId: "basic-client", clientSecret: "WRONG-secret-value-9999" }),
    (e) => e instanceof OAuthError && !e.message.includes("WRONG-secret") && !e.message.includes("rt-secret"),
  );
  assert.equal(scrubOAuthText("bad: Bearer abcdefghijklmnop1234 and ?access_token=zzzzzzzz1111 and " + "x".repeat(60)), "bad: [redacted] and [redacted] and [redacted]");
});

test("legacy oauth.ts entry points ride the engine (Basic auth, PKCE verifier) without changing their error contract", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "basic-client", secret: "basic-client-secret" } });
  t.after(() => m.close());
  const meta = await discoverIssuer(m.origin);
  const cfg = { provider: "legacy", authorizeUrl: meta.authorizationEndpoint, tokenUrl: meta.tokenEndpoint, scopes: ["read"], pkce: true, clientAuth: "client_secret_basic" };
  const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client: { clientId: "basic-client", clientSecret: "basic-client-secret" }, redirectUri: REDIRECT });
  const params = callbackParamsFromUrl(await m.consent(authorizeUrl));
  const tokens = await exchangeCodeForTokens(cfg, { code: params.code, clientId: "basic-client", clientSecret: "basic-client-secret", redirectUri: REDIRECT, codeVerifier: pending.verifier });
  assert.ok(tokens.accessToken.startsWith("at_"));
  await assert.rejects(exchangeCodeForTokens(cfg, { code: params.code, clientId: "basic-client", clientSecret: "basic-client-secret", redirectUri: REDIRECT, codeVerifier: pending.verifier }), /OAuth token request failed: invalid_grant/);
});

test("single-flight shares one promise per key and releases it afterwards", async () => {
  let runs = 0;
  const work = async () => { runs += 1; await new Promise((r) => setTimeout(r, 10)); return runs; };
  const [a, b] = await Promise.all([singleFlight("k", work), singleFlight("k", work)]);
  assert.equal(a, b);
  assert.equal(runs, 1);
  assert.equal(await singleFlight("k", work), 2, "a later call starts a new flight");
});

test("client metadata document: names the one redirect, is public, and is what a CIMD issuer fetches", async (t) => {
  const origin = "https://ares.mistiqueai.com";
  const doc = clientMetadataDocument(origin, [`${origin}/oauth/callback`]);
  assert.equal(doc.client_id, clientMetadataUrl(origin));
  assert.equal(doc.client_id, "https://ares.mistiqueai.com/oauth/client.json");
  assert.deepEqual(doc.redirect_uris, ["https://ares.mistiqueai.com/oauth/callback"]);
  assert.equal(doc.token_endpoint_auth_method, "none");
  assert.ok(!("client_secret" in doc));
});
