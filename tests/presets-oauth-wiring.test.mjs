// The connected-account presets (packages/tools/src/openapi/presets) and the OAuth
// engine (packages/core/src/oauth*.ts, connectServices.ts) were built apart. This file
// holds them to ONE registry:
//   - every preset's `oauth.connect` is a real Connect-registry id that is also a row of
//     the OAuth matrix, and its provider id is one the registry/engine knows;
//   - a form-connected preset has exactly one `api-<id>` card;
//   - the token the owner granted through the engine really reaches the Api tool's
//     Authorization header, refreshed through a (mock) authorization server when it has
//     expired, and the vendor-named host (Salesforce instance_url) is honoured.
// Offline: the authorization server and the vendor API are in-test stand-ins.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PRESET_BUNDLES,
  PRESET_ROSTER,
  presetBundle,
  SpecHandle,
  buildRequest,
  executeCall,
  resolveAuth,
  resolveBaseUrl,
  resolveConnectedToken,
  oauthProviderId,
  vaultCredentials,
  resetRateLimits,
  setConnectedTokenProvider,
} from "../packages/tools/dist/index.js";
import {
  OAUTH_PROVIDERS,
  getProviderConfig,
  matrixFor,
  resolveConnectService,
  validateApiId,
  apiCred,
  beginProviderAuthorization,
  callbackParamsFromUrl,
  completeAuthorization,
  saveOAuthClient,
  storeTokens,
  loadTokens,
  setCredential,
} from "../packages/core/dist/index.js";
import { startMockAuthServer } from "./_oauthMock.mjs";

const tmpHome = () => mkdtemp(path.join(tmpdir(), "ares-wiring-"));
const REDIRECT = "https://ares.mistiqueai.com/oauth/callback";

// ─── one registry ────────────────────────────────────────────────────────────

test("registry: every preset id is a valid Api id; x is x-twitter and Fitbit is not on the roster", () => {
  for (const id of PRESET_ROSTER) assert.equal(validateApiId(id), null, `${id} must pass core validateApiId`);
  assert.ok(PRESET_ROSTER.includes("x-twitter"));
  assert.ok(!PRESET_ROSTER.includes("x"), "the single-letter id is rejected by validateApiId");
  assert.ok(!PRESET_ROSTER.includes("fitbit"), "Fitbit's Web API is shut down 2026-10-30");
  assert.equal(presetBundle("x-twitter")?.def.oauth?.connect, "x");
});

test("registry: each OAuth preset connects through a real registry id that is a matrix row, with a provider the engine knows", () => {
  for (const b of PRESET_BUNDLES) {
    const src = b.def.oauth;
    if (!src) continue;
    const service = resolveConnectService(src.connect);
    assert.ok(service, `${b.id}: Connect service "${src.connect}" does not resolve`);
    assert.equal(service.id, src.connect, `${b.id}: "${src.connect}" must be the registry's own id, not an alias`);
    assert.ok(!service.id.startsWith("api-"), `${b.id}: an api-<id> form is not an OAuth connection`);
    const row = matrixFor(src.connect);
    assert.ok(row, `${b.id}: "${src.connect}" has no oauthMatrix row`);
    assert.ok(row.registry !== "excluded", `${b.id}: the matrix row for "${src.connect}" is excluded`);
    const provider = oauthProviderId(b.def);
    assert.ok(provider, `${b.id}: a provider id`);
    if (src.provider) {
      const known = Boolean(getProviderConfig(src.provider)) || service.oauthProvider === src.provider || row.provider === src.provider;
      assert.ok(known, `${b.id}: oauth.provider "${src.provider}" is not an engine provider or the registry's provider for "${src.connect}"`);
    }
    // an OAuth-app connect id must also have an engine config, or nothing could ever store its token
    if (service.kind === "oauth-app") assert.ok(OAUTH_PROVIDERS[service.oauthProvider ?? service.id], `${b.id}: oauth-app "${service.id}" has no OAUTH_PROVIDERS entry`);
  }
});

test("registry: a form-connected preset adds exactly one api-<id> card; the connect-registry never gets a second", () => {
  for (const b of PRESET_BUNDLES) {
    if (b.def.oauth) continue;
    const card = resolveConnectService(`api-${b.id}`);
    assert.equal(card?.id, `api-${b.id}`, `${b.id}: its secure form`);
    assert.equal(card.kind, "api-key");
  }
  // Trello's key + token and Shopify's / Mailchimp's address are all asked on the one form
  const trello = resolveConnectService("api-trello");
  assert.ok(trello.fields.some((f) => f.credential === apiCred("trello", "CLIENT_ID")), "Trello asks for its API key");
  assert.ok(trello.fields.some((f) => f.credential === apiCred("trello", "KEY") && f.secret), "and its token");
  assert.ok(resolveConnectService("api-cloudflare").fields.some((f) => f.credential === apiCred("cloudflare", "KEY")));
  // an OAuth preset with a vendor-named host (Salesforce) asks no address either
  assert.notEqual(resolveConnectService("api-salesforce")?.id, "api-salesforce");
});

// ─── the engine's token reaches the Api tool ─────────────────────────────────

/** The vendor API stand-in: records the Authorization header of every request. */
async function startVendor(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: [] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** One verify call of a preset (its own operation), pointed at the stand-in. */
async function callVerify(bundle, vendor, home, now, opts = {}) {
  const def = { ...bundle.def, baseUrl: vendor.url, baseUrlField: undefined, extraOrigins: [], allowLan: true };
  const handle = new SpecHandle(bundle.spec);
  const op = handle.operation(bundle.def.verifyOperationId);
  const creds = vaultCredentials(home);
  const env = { creds, home, ...(now ? { now } : {}), ...(opts.opTags ? { opTags: opts.opTags } : {}) };
  const auth = await resolveAuth(def, env);
  const params = Object.fromEntries(op.parameters.filter((p) => p.required && p.schema.default === undefined).map((p) => [p.name, "example"]));
  const built = buildRequest({ def, op, baseUrl: vendor.url, params, auth });
  resetRateLimits();
  const res = await executeCall(def, op, built, auth, env, {});
  return { res, auth };
}

test("end to end: a token granted through the engine (code + PKCE against a mock authorization server) is the bearer the Api tool sends, and an expired one is refreshed first", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "strava-client", secret: "strava-client-secret-0123456789" } });
  t.after(() => m.close());
  const vendor = await startVendor(t);
  const home = await tmpHome();
  // the real Strava provider config, pointed at the stand-in authorization server for this test only
  const real = OAUTH_PROVIDERS.strava;
  t.after(() => { OAUTH_PROVIDERS.strava = real; });
  const cfg = { ...real, authorizeUrl: `${m.origin}/authorize`, tokenUrl: `${m.origin}/token`, revokeUrl: undefined, userinfoUrl: undefined };
  OAUTH_PROVIDERS.strava = cfg;
  const client = { clientId: "strava-client", clientSecret: "strava-client-secret-0123456789" };
  await saveOAuthClient("strava", client, { home });

  const bundle = presetBundle("strava");
  assert.equal(bundle.def.oauth.connect, "strava");
  // before anyone signs in: one sentence that names the registry card
  await assert.rejects(() => callVerify(bundle, vendor, home), /not connected - Connect service "strava"/);

  // sign in: the exact steps the connect hub takes for an oauth-app service
  const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client, redirectUri: REDIRECT });
  const tokens = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  await storeTokens("strava", { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + 3600_000 }, { home });

  const first = await callVerify(bundle, vendor, home);
  assert.equal(first.res.status, 200);
  assert.equal(vendor.seen.at(-1).authorization, `Bearer ${tokens.accessToken}`, "the engine's access token went out as the bearer");
  assert.ok(!first.res.text.includes(tokens.accessToken));

  // two hours later the token is expired: the Api tool's resolution refreshes through the mock server and sends the NEW token
  const later = () => Date.now() + 2 * 3600_000;
  const second = await callVerify(bundle, vendor, home, later);
  const refreshed = await loadTokens("strava", { home });
  assert.notEqual(refreshed.accessToken, tokens.accessToken, "a new access token was stored");
  assert.equal(vendor.seen.at(-1).authorization, `Bearer ${refreshed.accessToken}`, "and that is what the API received");
  assert.equal(second.res.status, 200);
  assert.ok(m.state.requests.some((r) => r.path === "/token" && /grant_type=refresh_token/.test(r.body)));
  assert.ok(!JSON.stringify(m.state.requests.map((r) => r.path)).includes(refreshed.accessToken));
});

test("end to end: a remote-MCP sign-in (Linear's connect id) is also a usable bearer, refreshed through the same engine", async (t) => {
  const m = await startMockAuthServer({ fixedClient: { id: "mcp-client" } });
  t.after(() => m.close());
  const vendor = await startVendor(t);
  const home = await tmpHome();
  const bundle = presetBundle("linear");
  assert.equal(resolveConnectService(bundle.def.oauth.connect).kind, "mcp-oauth");
  assert.equal(await resolveConnectedToken(bundle.def, { creds: vaultCredentials(home), home }), undefined, "nothing stored yet");
  // the bundle the hub stores under mcp.token.<service id> after the MCP sign-in
  const { authorizeUrl, pending } = beginProviderAuthorization({ provider: "linear-mock", authorizeUrl: `${m.origin}/authorize`, tokenUrl: `${m.origin}/token`, scopes: ["read"], pkce: true, publicClient: true, clientAuth: "none" }, { client: { clientId: "mcp-client" }, redirectUri: REDIRECT });
  const tokens = await completeAuthorization(pending, callbackParamsFromUrl(await m.consent(authorizeUrl)));
  const store = (accessToken, refreshToken, expiresAt) => setCredential("mcp.token.linear", JSON.stringify({ accessToken, refreshToken, expiresAt, tokenEndpoint: `${m.origin}/token`, clientId: "mcp-client", resource: "https://mcp.linear.app/mcp" }), { home });
  await store(tokens.accessToken, tokens.refreshToken, Date.now() + 3600_000);
  const fresh = await callVerify(bundle, vendor, home);
  assert.equal(fresh.res.status, 200);
  assert.equal(vendor.seen.at(-1).authorization, `Bearer ${tokens.accessToken}`);
  // expired: refreshed through the mock, the new token is what goes out
  await store(tokens.accessToken, tokens.refreshToken, Date.now() - 1000);
  await callVerify(bundle, vendor, home);
  const sent = vendor.seen.at(-1).authorization;
  assert.match(sent, /^Bearer /);
  assert.notEqual(sent, `Bearer ${tokens.accessToken}`, "the refreshed token replaced the expired one");
  assert.ok(m.state.requests.some((r) => r.path === "/token" && /grant_type=refresh_token/.test(r.body)));
});

test("an injected token provider (setConnectedTokenProvider) is asked first and can be removed", async () => {
  const def = presetBundle("github").def;
  const home = await tmpHome();
  setConnectedTokenProvider(async (d) => (d.id === "github" ? "injected-token-123456" : undefined));
  try {
    const got = await resolveConnectedToken(def, { creds: vaultCredentials(home), home });
    assert.deepEqual(got, { token: "injected-token-123456", source: "provider" });
  } finally {
    setConnectedTokenProvider(undefined);
  }
  assert.equal(await resolveConnectedToken(def, { creds: vaultCredentials(home), home }), undefined);
});

// ─── per-service details ─────────────────────────────────────────────────────

test("Discord: bot operations send `Authorization: Bot <token>` from the bot connector's credential; user operations stay on the OAuth bearer", async (t) => {
  const vendor = await startVendor(t);
  const home = await tmpHome();
  const bundle = presetBundle("discord");
  const def = { ...bundle.def, baseUrl: vendor.url, extraOrigins: [], allowLan: true };
  const handle = new SpecHandle(bundle.spec);
  const bot = handle.operation("listGuildChannels");
  const user = handle.operation("getMe");
  assert.ok(bot.tags.includes("bot") && !user.tags.includes("bot"));
  await storeTokens("discord", { accessToken: "user-oauth-token-000111", expiresAt: Date.now() + 3600_000 }, { home });
  await setCredential("mcp.stdio.discord-bot.token", "bot-token-from-connector-777", { home });
  const creds = vaultCredentials(home);
  assert.equal((await resolveAuth(def, { creds, home, opTags: bot.tags })).headers.authorization, "Bot bot-token-from-connector-777");
  assert.equal((await resolveAuth(def, { creds, home, opTags: user.tags })).headers.authorization, "Bearer user-oauth-token-000111");
  assert.equal((await resolveAuth(def, { creds, home })).headers.authorization, "Bearer user-oauth-token-000111", "no tags = the connected account");
  const botAuth = await resolveAuth(def, { creds, home, opTags: bot.tags });
  assert.ok(botAuth.secrets.includes("bot-token-from-connector-777"), "the bot token is on the scrub list");
  // with no bot token stored a bot operation falls back to the user token (and Discord answers 401)
  const lone = await tmpHome();
  await storeTokens("discord", { accessToken: "user-oauth-token-000111", expiresAt: Date.now() + 3600_000 }, { home: lone });
  assert.equal((await resolveAuth(def, { creds: vaultCredentials(lone), home: lone, opTags: bot.tags })).headers.authorization, "Bearer user-oauth-token-000111");
});

test("Salesforce: the API host is the instance_url from the token response; only Salesforce domains are trusted", async () => {
  const home = await tmpHome();
  const bundle = presetBundle("salesforce");
  const handle = new SpecHandle(bundle.spec);
  const creds = vaultCredentials(home);
  await assert.rejects(() => resolveBaseUrl(bundle.def, handle, creds, home), /has no address stored/);
  const meta = (instance) => ({ via: "code", connectedAt: Date.now(), extra: { instance_url: instance } });
  await storeTokens("salesforce", { accessToken: "sf-access-token-123456", expiresAt: Date.now() + 3600_000, meta: meta("https://acme.my.salesforce.com") }, { home });
  assert.equal(await resolveBaseUrl(bundle.def, handle, creds, home), "https://acme.my.salesforce.com");
  await storeTokens("salesforce", { accessToken: "sf-access-token-123456", expiresAt: Date.now() + 3600_000, meta: meta("https://login.evil.example") }, { home });
  await assert.rejects(() => resolveBaseUrl(bundle.def, handle, creds, home), /has no address stored/);
  await storeTokens("salesforce", { accessToken: "sf-access-token-123456", expiresAt: Date.now() + 3600_000, meta: meta("http://acme.my.salesforce.com") }, { home });
  await assert.rejects(() => resolveBaseUrl(bundle.def, handle, creds, home), /has no address stored/, "plain http is refused");
  // the explicit override still wins (headless)
  await setCredential(apiCred("salesforce", "BASEURL"), "https://override.my.salesforce.com", { home });
  assert.equal(await resolveBaseUrl(bundle.def, handle, creds, home), "https://override.my.salesforce.com");
});
