// Connecting a service from the phone.
//
// The stock OAuth flow redirects to http://localhost:53691 — meaningless on a
// phone, where localhost is the phone. The redirect now comes back to the
// garrison's public origin instead. That endpoint CANNOT require the bearer
// token (it is a browser hop from Google), so the `state` is the whole guard:
// these tests pin that an unknown or reused state never reaches a code
// exchange, and that the flow is otherwise reachable from anywhere.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TunnelOAuth } from "../packages/cli/dist/oauthTunnel.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { setCredential } from "../packages/core/dist/index.js";

async function withGoogleApp(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-oauth-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await setCredential("GOOGLE_OAUTH_CLIENT_ID", "cid-123", { home });
  await setCredential("GOOGLE_OAUTH_CLIENT_SECRET", "secret-abc", { home });
  return home;
}

test("the authorize URL points back at the tunnel, not localhost", async (t) => {
  const home = await withGoogleApp(t);
  const oauth = new TunnelOAuth(() => "https://ares.mistiqueai.com", home);
  assert.equal(oauth.callbackUrlForSetup(), "https://ares.mistiqueai.com/oauth/callback");

  const { authorizeUrl, state } = await oauth.begin("google");
  const u = new URL(authorizeUrl);
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("redirect_uri"), "https://ares.mistiqueai.com/oauth/callback", "a phone can actually reach this");
  assert.equal(u.searchParams.get("client_id"), "cid-123");
  assert.equal(u.searchParams.get("state"), state);
  assert.ok(state.length >= 64, "state is unguessable");
  assert.match(u.searchParams.get("scope"), /gmail\.send/);
});

test("a garrison with no public address refuses to start a flow", async (t) => {
  const home = await withGoogleApp(t);
  const oauth = new TunnelOAuth(() => undefined, home);
  assert.equal(oauth.callbackUrlForSetup(), null);
  await assert.rejects(() => oauth.begin("google"), /public address/);
});

test("a provider with no OAuth app says so instead of building a broken link", async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-oauth-bare-"));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const oauth = new TunnelOAuth(() => "https://x.test", home);
  await assert.rejects(() => oauth.begin("google"), /client id and secret/);
  await assert.rejects(() => oauth.begin("nope"), /unknown provider/);
});

test("the callback is public but an unknown or reused state never exchanges a code", async (t) => {
  const home = await withGoogleApp(t);
  const oauth = new TunnelOAuth(() => "https://ares.mistiqueai.com", home);
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: {
      oauth: {
        handleCallback: (req, res, url) => oauth.handleCallback(req, res, url),
        begin: (p, s) => oauth.begin(p, s),
        callbackUrlForSetup: () => oauth.callbackUrlForSetup(),
      },
    },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  // Reachable with no Authorization header — it is a browser redirect.
  const forged = await fetch(`${base}/oauth/callback?code=stolen&state=not-a-real-state`);
  assert.equal(forged.status, 400, "an unknown state is refused");
  assert.match(await forged.text(), /Expired or unknown/);

  const { state } = await oauth.begin("google");
  // A declined consent is reported, not exchanged.
  const denied = await fetch(`${base}/oauth/callback?error=access_denied&state=${state}`);
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /declined/);

  // ...and that state is now spent: a replay cannot reuse it.
  const replay = await fetch(`${base}/oauth/callback?code=whatever&state=${state}`);
  assert.equal(replay.status, 400, "state is single-use");
  assert.match(await replay.text(), /Expired or unknown/);
});

test("connect/start is bearer-guarded and hands back a link to open on the phone", async (t) => {
  const home = await withGoogleApp(t);
  const oauth = new TunnelOAuth(() => "https://ares.mistiqueai.com", home);
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: {
      oauth: {
        handleCallback: (req, res, url) => oauth.handleCallback(req, res, url),
        begin: (p, s) => oauth.begin(p, s),
        callbackUrlForSetup: () => oauth.callbackUrlForSetup(),
      },
    },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer tok", "content-type": "application/json" };

  assert.equal((await fetch(`${base}/gateway/connect/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "google" }) })).status, 401);

  const res = await fetch(`${base}/gateway/connect/start`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "google" }) });
  assert.equal(res.status, 200);
  assert.match((await res.json()).authorizeUrl, /accounts\.google\.com/);

  const setup = await fetch(`${base}/gateway/connect/callback-url`, { headers: { authorization: "Bearer tok" } });
  assert.equal((await setup.json()).callbackUrl, "https://ares.mistiqueai.com/oauth/callback", "the value to paste into Google's console");
});
