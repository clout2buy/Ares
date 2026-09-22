// Pushing to the owner's phone, straight to Apple.
//
// The garrison holds the APNs key and talks to api.push.apple.com itself, so
// a permission prompt — which names the command about to run — never passes
// through a third party's servers. These tests pin the two things that decide
// whether a prompt actually reaches the phone: a correctly shaped provider
// token, and a registry that forgets dead devices instead of retrying them.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PhonePush, apnsJwt, apnsFromEnv } from "../packages/cli/dist/phonePush.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

function p256Pem() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

test("apnsJwt is an ES256 provider token Apple would accept", () => {
  const pem = p256Pem();
  const cfg = { keyPath: "/dev/null", keyId: "ABC1234567", teamId: "JLP658BLS8", bundleId: "com.doingteam.ares" };
  const at = 1_700_000_000_000;
  const jwt = apnsJwt(cfg, pem, at);
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.deepEqual(header, { alg: "ES256", kid: "ABC1234567" }, "alg + key id, exactly what Apple reads");
  assert.equal(payload.iss, "JLP658BLS8", "issuer is the team id");
  assert.equal(payload.iat, Math.floor(at / 1000));
  // Raw R||S, not DER — Apple rejects the DER encoding Node signs with by default.
  assert.equal(Buffer.from(s, "base64url").byteLength, 64, "signature is ieee-p1363 (64 bytes)");
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: crypto.createPublicKey(pem), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  assert.ok(ok, "signature verifies against the key");
});

test("apnsFromEnv only reports configured when every piece is present", () => {
  const saved = { ...process.env };
  try {
    delete process.env.ARES_APNS_KEY_PATH; delete process.env.ARES_APNS_KEY_ID; delete process.env.ARES_APNS_TEAM_ID;
    assert.equal(apnsFromEnv("com.x"), null, "no key → push is simply off");
    process.env.ARES_APNS_KEY_PATH = "/k.p8"; process.env.ARES_APNS_KEY_ID = "K";
    assert.equal(apnsFromEnv("com.x"), null, "a half-configured key is not configured");
    process.env.ARES_APNS_TEAM_ID = "T";
    const cfg = apnsFromEnv("com.x");
    assert.equal(cfg.bundleId, "com.x");
    assert.equal(cfg.production, true, "production APNs unless ARES_APNS_SANDBOX=1");
  } finally {
    process.env = saved;
  }
});

test("device registry persists across a restart and can forget a device", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-push-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = path.join(dir, "phone-push.json");
  const push = new PhonePush(store, null);
  assert.equal(push.configured, false, "no APNs config → not configured");
  await push.register({ token: "aaaa", platform: "ios", label: "iPhone" });
  await push.register({ token: "bbbb", platform: "ios" });
  assert.equal((await push.list()).length, 2);

  // A fresh garrison process must still know the phone.
  const reloaded = new PhonePush(store, null);
  const devices = await reloaded.list();
  assert.equal(devices.length, 2);
  assert.equal(devices.find((d) => d.token === "aaaa").label, "iPhone");

  await reloaded.unregister("aaaa");
  assert.deepEqual((await new PhonePush(store, null).list()).map((d) => d.token), ["bbbb"]);

  // Sending with no APNs config is a no-op, not a crash.
  assert.deepEqual(await reloaded.send({ title: "t", body: "b" }), { sent: 0, failed: 0 });
});

test("/gateway/push/register stores a token, and says so when push is not set up", async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-push-api-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const push = new PhonePush(path.join(dir, "p.json"), null);
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok",
    phoneApi: {
      registerPush: (d) => push.register(d),
      unregisterPush: (tk) => push.unregister(tk),
      pushConfigured: () => push.configured,
    },
  });
  await server.start();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer tok", "content-type": "application/json" };

  assert.equal((await fetch(`${base}/gateway/push/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401, "the token is still the gate");

  const bad = await fetch(`${base}/gateway/push/register`, { method: "POST", headers: auth, body: JSON.stringify({}) });
  assert.equal(bad.status, 400, "a registration without a token is refused");

  const ok = await fetch(`${base}/gateway/push/register`, { method: "POST", headers: auth, body: JSON.stringify({ token: "dead-beef", platform: "ios", label: "iPhone" }) });
  assert.equal(ok.status, 200);
  // The app learns push is not armed on this garrison, instead of silently
  // believing notifications will arrive.
  assert.equal((await ok.json()).configured, false);
  assert.deepEqual((await push.list()).map((d) => d.token), ["dead-beef"]);

  const gone = await fetch(`${base}/gateway/push/register`, { method: "POST", headers: auth, body: JSON.stringify({ token: "dead-beef", remove: true }) });
  assert.equal(gone.status, 200);
  assert.equal((await push.list()).length, 0);
});
