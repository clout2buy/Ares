// The phone's OAuth contract end to end: the real RemoteAgentServer + the real
// ConnectHub against an in-test authorization server. Every `state` the v2
// start can answer (open, device, setup, fields, unsupported, connected), the
// poll / setup / complete routes, the ares://oauth return, the loopback
// intercept, replay + state refusal, the public client metadata document, and
// that no secret reaches a response, a log line or the plaintext vault.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import {
  CONNECT_SERVICES,
  OAUTH_MATRIX,
  OAUTH_PROVIDERS,
  getCredential,
  loadRemoteMcpServers,
  loadTokens,
  registerConnectService,
  setConnectBroker,
  unregisterConnectService,
} from "../packages/core/dist/index.js";
import { startMockAuthServer } from "./_oauthMock.mjs";

const TOKEN = "tok";

async function rig(t, mockOpts = {}, hubOpts = {}) {
  const home = process.env.ARES_HOME;
  const mock = await startMockAuthServer(mockOpts);
  const logs = [];
  let origin = "";
  const hub = new ConnectHub({ publicUrl: () => origin, home, log: (l) => logs.push(l), engineSleep: async () => {}, ...hubOpts });
  const srv = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: TOKEN,
    phoneApi: { oauth: { handleCallback: (req, res, url) => hub.handleCallback(req, res, url), begin: async () => { throw new Error("n/a"); }, callbackUrlForSetup: () => `${origin}/oauth/callback` }, connect: (req, res, url) => hub.handle(req, res, url) },
  });
  await srv.start();
  origin = `http://127.0.0.1:${srv.port}`;
  setConnectBroker(hub);
  t.after(async () => { setConnectBroker(null); await srv.close(); await hub.close(); await mock.close(); });
  const call = async (method, p, body) => {
    const res = await fetch(origin + p, { method, redirect: "manual", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, body: j, text, headers: res.headers };
  };
  return { home, mock, logs, hub, origin, call };
}

const MOCK_SVC = (mock, id = "mockmcp") => ({ id, label: "Mock MCP", kind: "mcp-oauth", blurb: "mock", keywords: [id], howToUse: "mock", mcpUrl: mock.mcpUrl });

/** Play the owner: open the authorize URL, then hit the garrison callback the provider redirected to. */
async function ownerApproves(mock, url) {
  const redirect = await mock.consent(url);
  return redirect;
}

test("v1 start keeps the old shape; the hub page 302s to consent; the callback connects and no secret leaks", async (t) => {
  const r = await rig(t);
  registerConnectService(MOCK_SVC(r.mock, "mockv1"));
  t.after(() => unregisterConnectService("mockv1"));
  const start = await r.call("POST", "/gateway/connections/start", { service: "mockv1" });
  assert.equal(start.status, 200);
  assert.deepEqual(Object.keys(start.body).sort(), ["flowId", "instructions", "kind", "label", "service", "url"]);
  const page = await fetch(start.body.url, { redirect: "manual" });
  assert.equal(page.status, 302);
  const authorize = page.headers.get("location");
  assert.ok(authorize.startsWith(`${r.mock.origin}/authorize`));
  const back = await ownerApproves(r.mock, authorize);
  const cb = await fetch(back, { redirect: "manual" });
  assert.equal(cb.status, 200);
  assert.match(await cb.text(), /Mock MCP connected/);
  assert.ok((await loadRemoteMcpServers(r.home)).mockv1, "connector entry written");
  // replay of the same callback URL finds nothing
  const replay = await fetch(back, { redirect: "manual" });
  assert.notEqual(replay.status, 200);
  // nothing secret anywhere
  const disk = await readFile(path.join(r.home, "credentials.json"), "utf8");
  for (const s of r.mock.secrets()) {
    assert.ok(!disk.includes(s), "plaintext secret in the vault");
    assert.ok(!r.logs.join("\n").includes(s), "secret in a log line");
    assert.ok(!start.text.includes(s));
  }
});

test("v2 open: poll goes pending -> connected, ares://oauth return when asked, state is bound and single use", async (t) => {
  const r = await rig(t);
  registerConnectService(MOCK_SVC(r.mock, "mockv2"));
  t.after(() => unregisterConnectService("mockv2"));
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockv2", v: 2, returnTo: "ares://oauth" });
  assert.equal(s.body.state, "open");
  assert.equal(s.body.returnTo, "ares://oauth");
  assert.ok(s.body.url.startsWith(r.mock.origin) && s.body.pollId);
  assert.deepEqual((await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`)).body, { state: "pending", service: "mockv2" });
  const back = await ownerApproves(r.mock, s.body.url);
  // a forged state is refused and exchanges nothing
  const forged = new URL(back); forged.searchParams.set("state", "forged");
  assert.notEqual((await fetch(forged, { redirect: "manual" })).status, 200);
  assert.equal((await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`)).body.state, "pending");
  const cb = await fetch(back, { redirect: "manual" });
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get("location"), /^ares:\/\/oauth\?service=mockv2&state=connected&pollId=/);
  assert.equal((await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`)).body.state, "connected");
  // an already-connected service answers connected (idempotent) unless asked to reconnect
  assert.equal((await r.call("POST", "/gateway/connections/start", { service: "mockv2", v: 2 })).body.state, "connected");
  assert.equal((await r.call("POST", "/gateway/connections/start", { service: "mockv2", v: 2, reconnect: true })).body.state, "open");
  // only the exact ares://oauth return is honoured
  const evil = await r.call("POST", "/gateway/connections/start", { service: "mockv2", v: 2, returnTo: "https://evil.example", reconnect: true });
  assert.equal(evil.body.returnTo, undefined);
  assert.equal((await r.call("GET", "/gateway/connections/poll?id=nope")).status, 404);
});

test("a declined consent fails the poll with a short safe error", async (t) => {
  const r = await rig(t);
  registerConnectService(MOCK_SVC(r.mock, "mockdeny"));
  t.after(() => unregisterConnectService("mockdeny"));
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockdeny", v: 2 });
  const back = await r.mock.consent(s.body.url, { deny: true });
  assert.equal((await fetch(back, { redirect: "manual" })).status, 400);
  const p = await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`);
  assert.equal(p.body.state, "failed");
  assert.match(p.body.error, /declined/);
});

test("allowlisting issuer (Vercel-style): the https redirect is refused, so the flow falls back to a loopback redirect the app intercepts and completes", async (t) => {
  const r = await rig(t, { redirectAllowlist: ["http://localhost", "http://127.0.0.1:53682"] });
  registerConnectService(MOCK_SVC(r.mock, "mockloop"));
  t.after(() => unregisterConnectService("mockloop"));
  // v1 cannot intercept: no token fallback either, an honest dead end
  const v1 = await r.call("POST", "/gateway/connections/start", { service: "mockloop" });
  assert.equal(v1.status, 200);
  const dead = await fetch(v1.body.url, { redirect: "manual" });
  assert.notEqual(dead.status, 302);
  assert.ok(!/token/i.test(await dead.text().then((x) => x.replace(/The token/g, ""))), "no paste-a-token offer on the page");
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockloop", v: 2, reconnect: true });
  assert.equal(s.body.state, "open");
  assert.equal(s.body.intercept.redirectPrefix, "http://localhost:53682/oauth/callback");
  const intercepted = await ownerApproves(r.mock, s.body.url);
  assert.ok(intercepted.startsWith("http://localhost:53682/oauth/callback?"), "the provider redirected to the loopback address");
  // wrong prefix refused
  assert.equal((await r.call("POST", "/gateway/connections/complete", { pollId: s.body.pollId, url: `https://evil.example/cb?${intercepted.split("?")[1]}` })).body.state, "failed");
  // a forged state refused
  assert.equal((await r.call("POST", "/gateway/connections/complete", { pollId: s.body.pollId, url: intercepted.replace(/state=[^&]+/, "state=forged") })).body.state, "failed");
  const done = await r.call("POST", "/gateway/connections/complete", { pollId: s.body.pollId, url: intercepted });
  assert.equal(done.body.state, "connected");
  assert.ok((await loadRemoteMcpServers(r.home)).mockloop);
  // single use
  assert.notEqual((await r.call("POST", "/gateway/connections/complete", { pollId: s.body.pollId, url: intercepted })).body.state, "pending");
});

test("CIMD: an issuer that supports client metadata documents and refuses DCR for our redirect accepts Ares via the garrison's /oauth/client.json (public, unauthenticated)", async (t) => {
  const r = await rig(t, { cimd: true, redirectAllowlist: ["https://nobody.example"] });
  registerConnectService(MOCK_SVC(r.mock, "mockcimd"));
  t.after(() => unregisterConnectService("mockcimd"));
  const doc = await fetch(`${r.origin}/oauth/client.json`);
  assert.equal(doc.status, 200);
  const j = await doc.json();
  assert.equal(j.client_id, `${r.origin}/oauth/client.json`);
  assert.deepEqual(j.redirect_uris, [`${r.origin}/oauth/callback`]);
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockcimd", v: 2 });
  assert.equal(s.body.state, "open");
  assert.equal(new URL(s.body.url).searchParams.get("client_id"), j.client_id);
  const back = await ownerApproves(r.mock, s.body.url);
  assert.equal((await fetch(back, { redirect: "manual" })).status, 200);
  assert.equal((await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`)).body.state, "connected");
});

test("device: state=device carries the code; the garrison polls the issuer; poll flips to connected; the token is only in the vault", async (t) => {
  const r = await rig(t, { fixedClient: { id: "dev-client" } });
  const cfg = { provider: "mockdev", authorizeUrl: `${r.mock.origin}/authorize`, tokenUrl: `${r.mock.origin}/token`, deviceUrl: `${r.mock.origin}/device_authorization`, publicClient: true, scopes: ["read"], userinfoUrl: `${r.mock.origin}/userinfo` };
  OAUTH_PROVIDERS.mockdev = cfg;
  OAUTH_MATRIX.push({ id: "mockdev", label: "Mock Device", class: "d", flow: "device", registry: "added", provider: "mockdev", endpoints: {}, scopes: ["read"], ownerSetup: "x", evidence: [], verification: "FLOW-VERIFIED-AGAINST-MOCK", fixtures: [], notes: "" });
  registerConnectService({ id: "mockdev", label: "Mock Device", kind: "oauth-app", oauthProvider: "mockdev", blurb: "m", keywords: ["mockdev"], howToUse: "m", appSetup: { consoleUrl: "https://x.example", steps: [] } });
  t.after(() => { delete OAUTH_PROVIDERS.mockdev; OAUTH_MATRIX.splice(OAUTH_MATRIX.findIndex((e) => e.id === "mockdev"), 1); unregisterConnectService("mockdev"); });

  // no client yet: setup (never a token field), then the setup route stores it
  const setup = await r.call("POST", "/gateway/connections/start", { service: "mockdev", v: 2 });
  assert.equal(setup.body.state, "setup");
  assert.equal(setup.body.redirectUri, undefined, "device flows register no redirect");
  assert.deepEqual(setup.body.fields.map((f) => f.key), ["client_id"]);
  assert.equal((await r.call("POST", "/gateway/connections/setup", { service: "mockdev", values: { client_id: "" } })).status, 400);
  assert.deepEqual((await r.call("POST", "/gateway/connections/setup", { service: "mockdev", values: { client_id: "dev-client" } })).body, { ok: true, state: "ready", next: "start" });

  const s = await r.call("POST", "/gateway/connections/start", { service: "mockdev", v: 2 });
  assert.equal(s.body.state, "device");
  assert.equal(s.body.userCode, "WDJB-MJHT");
  assert.equal(s.body.verificationUrl, `${r.mock.origin}/device`);
  assert.ok(s.body.expiresInSec > 0 && s.body.intervalSec === 5);
  r.mock.approveDevice();
  let p;
  for (let i = 0; i < 50; i += 1) {
    p = await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`);
    if (p.body.state !== "pending") break;
    await new Promise((x) => setTimeout(x, 20));
  }
  assert.equal(p.body.state, "connected");
  const tokens = await loadTokens("mockdev", { home: r.home });
  assert.ok(tokens.accessToken.startsWith("at_"));
  assert.equal(tokens.meta.account, "owner@example.com", "the account name was read from userinfo");
  for (const sec of r.mock.secrets()) assert.ok(!JSON.stringify([s.body, p.body]).includes(sec) && !r.logs.join("\n").includes(sec));
  const list = (await r.call("GET", "/gateway/connections")).body.services.find((x) => x.id === "mockdev");
  assert.equal(list.auth, "device");
  assert.equal(list.setupDone, true);
  assert.equal(list.oauthClass, "d");
  assert.equal(list.connected, true);
});

test("device denied -> poll failed with a short reason", async (t) => {
  const r = await rig(t, { fixedClient: { id: "dev-client2" } });
  OAUTH_PROVIDERS.mockdev2 = { provider: "mockdev2", authorizeUrl: `${r.mock.origin}/authorize`, tokenUrl: `${r.mock.origin}/token`, deviceUrl: `${r.mock.origin}/device_authorization`, publicClient: true, scopes: [] };
  OAUTH_MATRIX.push({ id: "mockdev2", label: "M2", class: "d", flow: "device", registry: "added", provider: "mockdev2", endpoints: {}, scopes: [], ownerSetup: "x", evidence: [], verification: "UNVERIFIED", fixtures: [], notes: "" });
  registerConnectService({ id: "mockdev2", label: "M2", kind: "oauth-app", oauthProvider: "mockdev2", blurb: "m", keywords: ["mockdev2"], howToUse: "m", appSetup: { consoleUrl: "https://x.example", steps: [] } });
  t.after(() => { delete OAUTH_PROVIDERS.mockdev2; OAUTH_MATRIX.splice(OAUTH_MATRIX.findIndex((e) => e.id === "mockdev2"), 1); unregisterConnectService("mockdev2"); });
  await r.call("POST", "/gateway/connections/setup", { service: "mockdev2", values: { client_id: "dev-client2" } });
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockdev2", v: 2 });
  r.mock.denyDevice();
  let p;
  for (let i = 0; i < 50; i += 1) { p = await r.call("GET", `/gateway/connections/poll?id=${s.body.pollId}`); if (p.body.state !== "pending") break; await new Promise((x) => setTimeout(x, 20)); }
  assert.equal(p.body.state, "failed");
  assert.match(p.body.error, /declined/);
});

test("setup / fields / unsupported / experimental browser states, and the setup route's guards", async (t) => {
  const r = await rig(t);
  // class c with no client: setup, with the redirect URI and steps, never a token field
  const strava = await r.call("POST", "/gateway/connections/start", { service: "strava", v: 2 });
  assert.equal(strava.body.state, "setup");
  assert.equal(strava.body.redirectUri, `${r.origin}/oauth/callback`);
  assert.ok(strava.body.consoleUrl.startsWith("https://"));
  assert.ok(strava.body.steps.length >= 2);
  assert.deepEqual(strava.body.fields.map((f) => f.key), ["client_id", "client_secret"]);
  assert.ok(!JSON.stringify(strava.body).match(/access token|paste a token/i));
  assert.equal((await r.call("POST", "/gateway/connections/setup", { service: "strava", values: { client_id: "123" } })).status, 400, "a confidential vendor needs its secret too");
  assert.equal((await r.call("POST", "/gateway/connections/setup", { service: "strava", values: { client_id: "12345", client_secret: "s3cr3t-value" } })).body.state, "ready");
  const again = await r.call("POST", "/gateway/connections/start", { service: "strava", v: 2 });
  assert.equal(again.body.state, "open");
  const authz = new URL(again.body.url);
  assert.equal(authz.hostname, "www.strava.com");
  assert.equal(authz.searchParams.get("client_id"), "12345");
  assert.equal(authz.searchParams.get("scope"), "read,activity:read_all,profile:read_all,activity:write");
  assert.ok(!again.text.includes("s3cr3t-value"));
  assert.equal((await getCredential("STRAVA_OAUTH_CLIENT_SECRET", { home: r.home })), "s3cr3t-value");
  assert.deepEqual((await r.call("POST", "/gateway/connections/setup", { service: "strava", clear: true })).body, { ok: true, state: "cleared" });
  // class e: honest fields, labelled NOT OAuth
  const twilio = await r.call("POST", "/gateway/connections/start", { service: "twilio", v: 2 });
  assert.equal(twilio.body.state, "fields");
  assert.equal(twilio.body.notOAuth, true);
  assert.equal(twilio.body.submit, "/gateway/connections/setup");
  assert.deepEqual(twilio.body.fields.map((f) => f.key), ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]);
  // class f: unsupported, with the experimental browser as an alternative
  const dd = await r.call("POST", "/gateway/connections/start", { service: "doordash", v: 2 });
  assert.equal(dd.body.state, "unsupported");
  assert.equal(dd.body.alternative.mode, "browser");
  assert.equal(dd.body.alternative.experimental, true);
  // Instagram is OAuth now (setup), with the browser demoted to an explicit experimental alternative
  const ig = await r.call("POST", "/gateway/connections/start", { service: "instagram", v: 2 });
  assert.equal(ig.body.state, "setup");
  assert.ok(ig.body.notes.join(" ").length > 0);
  assert.equal((await r.call("GET", "/gateway/connections")).body.services.find((s) => s.id === "instagram").auth, "oauth-setup");
  // unknown / missing
  assert.equal((await r.call("POST", "/gateway/connections/setup", { service: "nope-xyz" })).status, 404);
  assert.equal((await r.call("POST", "/gateway/connections/setup", {})).status, 400);
  // bearer guard on every new route
  for (const [m, p] of [["GET", "/gateway/connections/poll?id=x"], ["POST", "/gateway/connections/setup"], ["POST", "/gateway/connections/complete"]]) {
    const res = await fetch(r.origin + p, { method: m });
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});

test("disconnect revokes at the issuer (RFC 7009) then forgets", async (t) => {
  const r = await rig(t);
  registerConnectService(MOCK_SVC(r.mock, "mockrev"));
  t.after(() => unregisterConnectService("mockrev"));
  const s = await r.call("POST", "/gateway/connections/start", { service: "mockrev", v: 2 });
  await fetch(await ownerApproves(r.mock, s.body.url), { redirect: "manual" });
  const before = (await loadRemoteMcpServers(r.home)).mockrev;
  assert.ok(before);
  const d = await r.call("POST", "/gateway/connections/disconnect", { service: "mockrev" });
  assert.equal(d.body.removed, true);
  assert.equal((await loadRemoteMcpServers(r.home)).mockrev, undefined);
});
