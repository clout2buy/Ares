// /gateway/providers end to end through the real RemoteAgentServer. The CLIs are
// mocks that behave like the real login (print an authorize URL, listen on a
// loopback port, accept the callback, write a credential file): mechanisms A
// (loopback intercept), B (device) and C (paste), plus the SSRF refusal,
// timeouts, concurrent-login refusal, cancel, logout, token scrubbing, and
// Ares's own in-process Anthropic / ChatGPT / Kimi logins.

import baseTest from "node:test";

// Provider sign-in drives the CLIs under util-linux `script` (a pty) and these fakes are sh
// scripts, so the flow only exists on Linux; elsewhere it reports "unsupported" by design.
const LINUX_ONLY = process.platform === "linux" ? false : "provider sign-in runs CLIs under util-linux script (Linux hosts only)";
const test = (name, ...rest) => baseTest(name, { skip: LINUX_ONLY }, rest.at(-1));
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { createProvidersApi } from "../packages/cli/dist/phoneProviders.js";
import { loadAnthropicTokens, resolveAnthropicAccessToken, kimiAuthStatus, authFilePath, readAudit } from "../packages/core/dist/index.js";
import { MOCK_CLI_SOURCE } from "./_mockLoginCli.mjs";

const TOKEN = "tok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
});

async function rig(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.homedir(), "ares-prov-test-"));
  const bins = path.join(dir, "bin");
  await fs.mkdir(bins);
  for (const n of ["claude", "codex"]) {
    await fs.writeFile(path.join(bins, n), MOCK_CLI_SOURCE, { mode: 0o755 });
  }
  const logs = [];
  const api = createProvidersApi({
    home: process.env.ARES_HOME,
    serviceHome: dir,
    bins: { "claude-code": path.join(bins, "claude"), codex: path.join(bins, "codex") },
    startTimeoutMs: 8000,
    log: (l) => logs.push(l),
    ...extra,
  });
  const srv = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: TOKEN, phoneApi: { providers: api } });
  await srv.start();
  const origin = `http://127.0.0.1:${srv.port}`;
  t.after(async () => { api.close(); await srv.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const call = async (method, p, body, auth = true) => {
    const res = await fetch(origin + p, { method, headers: { ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: j, text };
  };
  const mode = (cfg) => fs.writeFile(path.join(dir, ".mockcli.json"), JSON.stringify(cfg));
  const provider = async (id) => (await call("GET", "/gateway/providers")).body.providers.find((p) => p.id === id);
  return { dir, call, mode, provider, logs, origin };
}

/** What the provider's redirect would be after the owner approves in the in-app browser. */
const redirectFor = (authorizeUrl, extra = "") => {
  const u = new URL(authorizeUrl);
  const r = new URL(u.searchParams.get("redirect_uri"));
  return `${r.origin}${r.pathname}?code=AUTHCODE123456&state=${u.searchParams.get("state")}${extra}`;
};

test("GET /gateway/providers needs the bearer and lists state without secrets", async (t) => {
  const r = await rig(t);
  assert.equal((await r.call("GET", "/gateway/providers", undefined, false)).status, 401);
  const list = await r.call("GET", "/gateway/providers");
  assert.equal(list.status, 200);
  const by = Object.fromEntries(list.body.providers.map((p) => [p.id, p]));
  assert.equal(by["claude-code"].state, "signed_out");
  assert.equal(by["claude-code"].kind, "coding-agent");
  assert.equal(by["claude-code"].method, "loopback");
  assert.equal(by.codex.state, "signed_out");
  assert.equal(by["kimi-cli"].state, "unknown");
  assert.match(by["kimi-cli"].note, /not installed/);
  assert.equal(by["ares-anthropic"].kind, "model");
  assert.equal(by["ares-kimi"].method, "device");
  // a credential on disk: signed in, the account is shown, no token is
  await fs.mkdir(path.join(r.dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(r.dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-ACCESS", refreshToken: "FAKE-REFRESH", expiresAt: Date.now() + 1e6 } }));
  const after = await r.call("GET", "/gateway/providers");
  assert.ok(!/FAKE-/.test(after.text), "no token in the listing");
  const p = after.body.providers.find((x) => x.id === "claude-code");
  assert.equal(p.state, "signed_in");
  assert.equal(p.account, "owner@example.com");
  assert.ok(p.expiresAt > Date.now());
});

test("A: loopback - the phone intercepts the redirect, the server replays it on the box, the CLI finishes", async (t) => {
  const r = await rig(t);
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(start.status, 200);
  assert.equal(start.body.state, "open");
  assert.ok(start.body.url.startsWith("https://mock.example/oauth/authorize"), "the URL the shim recorded, not opened");
  const port = Number(/^http:\/\/localhost:(\d+)\/callback$/.exec(start.body.intercept.redirectPrefix)?.[1]);
  assert.ok(port > 0);
  assert.ok(await portOpen(port), "the CLI is listening on the box");
  assert.equal((await r.provider("claude-code")).state, "login_in_progress");

  // one login at a time per provider
  const again = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(again.status, 409);
  assert.equal(again.body.state, "login_in_progress");
  assert.equal(again.body.pollId, start.body.pollId);

  assert.equal((await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state, "pending");

  // refused: other host, other port, other path, a code in the paste field
  const good = redirectFor(start.body.url);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good.replace("localhost", "evil.example") })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good.replace(`:${port}`, `:${port + 1}`) })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good.replace("/callback", "/other") })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, code: "PASTECODE-123456" })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good, code: "x" })).status, 400);
  assert.equal((await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state, "pending", "refusals did not end the login");

  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good });
  assert.equal(done.status, 200);
  assert.equal(done.body.state, "signed_in");
  // the credential landed where the CLI (and its status check) look
  await fs.access(path.join(r.dir, ".claude", ".credentials.json"));
  const p = await r.provider("claude-code");
  assert.equal(p.state, "signed_in");
  assert.equal(await portOpen(port), false, "the listener is gone");
  // a finished flow answers its verdict again, never replays
  const replay = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: good });
  assert.equal(replay.body.state, "signed_in");
  // an already signed-in provider is not re-run without force
  assert.equal((await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 })).body.state, "signed_in");
  // audited, with no query or code in it
  await sleep(100);
  const audit = JSON.stringify(await readAudit({ limit: 200 }));
  assert.match(audit, /providers\.login/);
  assert.match(audit, /providers\.complete/);
  assert.ok(!/AUTHCODE123456/.test(audit));
});

test("SSRF: a callbackUrl can never make the server call anything but its own listener", async (t) => {
  const r = await rig(t);
  let hits = 0;
  const decoy = http.createServer((q, s) => { hits++; s.end("x"); });
  await new Promise((res) => decoy.listen(0, "127.0.0.1", res));
  t.after(() => decoy.close());
  const decoyPort = decoy.address().port;
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  const own = new URL(start.body.intercept.redirectPrefix).port;
  for (const bad of [
    `http://127.0.0.1:${decoyPort}/callback?code=a&state=b`,
    `http://localhost:${decoyPort}/callback?code=a&state=b`,
    `https://localhost:${own}/callback?code=a&state=b`,
    "http://169.254.169.254/callback?code=a&state=b",
    `http://user:pw@localhost:${own}/callback?code=a&state=b`,
    "file:///etc/passwd",
    "not a url",
  ]) {
    const res = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: bad });
    assert.equal(res.status, 400, bad);
  }
  assert.equal(hits, 0);
  await r.call("POST", "/gateway/providers/cancel", { pollId: start.body.pollId });
});

test("a failing CLI is reported with tokens scrubbed everywhere, and frees the slot", async (t) => {
  const r = await rig(t);
  await r.mode({ failOnCallback: true });
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: redirectFor(start.body.url) });
  assert.equal(done.body.state, "failed");
  assert.ok(done.body.error);
  await sleep(100);
  for (const text of [done.text, JSON.stringify(await readAudit({ limit: 200 })), r.logs.join("\n")]) {
    assert.ok(!/SECRETSECRET/.test(text), "token-shaped value scrubbed");
    assert.ok(!/sk-ant-oat01/.test(text));
    assert.ok(!/AUTHCODE123456/.test(text));
  }
  assert.equal((await r.provider("claude-code")).state, "signed_out");
  await r.mode({});
  const next = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(next.body.state, "open");
  await r.call("POST", "/gateway/providers/cancel", { pollId: next.body.pollId });
});

test("A (codex): the CLI that prints its URL instead of opening a browser works the same way", async (t) => {
  const r = await rig(t);
  await r.mode({ noOpen: true });
  const start = await r.call("POST", "/gateway/providers/login", { id: "codex", v: 2 });
  assert.equal(start.body.state, "open");
  assert.match(start.body.intercept.redirectPrefix, /^http:\/\/localhost:\d+\/auth\/callback$/);
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: redirectFor(start.body.url) });
  assert.equal(done.body.state, "signed_in");
  assert.equal((await r.provider("codex")).state, "signed_in");
});

test("B: device - the code and URL are surfaced and the poll follows the CLI", async (t) => {
  const r = await rig(t);
  const start = await r.call("POST", "/gateway/providers/login", { id: "codex", v: 2, method: "device" });
  assert.equal(start.body.state, "device");
  assert.equal(start.body.userCode, "ABCD-EF12");
  assert.equal(start.body.verificationUrl, "https://mock.example/device");
  assert.ok(start.body.expiresInSec > 0 && start.body.intervalSec > 0);
  assert.equal((await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state, "pending");
  await fs.writeFile(path.join(r.dir, ".approve-device"), "1");
  let state = "pending";
  for (let i = 0; i < 40 && state === "pending"; i++) { await sleep(150); state = (await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state; }
  assert.equal(state, "signed_in");
  assert.equal((await r.provider("codex")).state, "signed_in");
});

test("C: paste - last resort, labelled; the code goes to the CLI's stdin and is never echoed back", async (t) => {
  const r = await rig(t);
  await r.mode({ noLoopback: true, noOpen: true });
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(start.body.state, "paste");
  assert.ok(start.body.hint);
  assert.ok(start.body.url.includes("platform.example"));
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: "http://localhost:1/callback" })).status, 400);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, code: "bad code with spaces" })).status, 400);
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, code: "PASTECODE-123456" });
  assert.equal(done.body.state, "signed_in");
  assert.ok(!done.text.includes("PASTECODE-123456"));
  assert.equal((await r.provider("claude-code")).state, "signed_in");
});

test("C by request: method paste on a CLI that also has loopback uses the manual URL", async (t) => {
  const r = await rig(t);
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2, method: "paste" });
  assert.equal(start.body.state, "paste");
  assert.ok(start.body.url.includes("platform.example"));
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, code: "PASTECODE-123456" })).body.state, "signed_in");
});

test("flows expire after the TTL: the child is killed, the poll says expired, the slot is free", async (t) => {
  const r = await rig(t, { flowTtlMs: 1500 });
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  const port = Number(new URL(start.body.intercept.redirectPrefix).port);
  assert.ok(await portOpen(port));
  await sleep(2600);
  assert.equal((await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state, "expired");
  assert.equal(await portOpen(port), false, "the child was killed");
  const late = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: redirectFor(start.body.url) });
  assert.equal(late.body.state, "expired");
  const next = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(next.body.state, "open");
  await r.call("POST", "/gateway/providers/cancel", { pollId: next.body.pollId });
});

test("cancel kills the child; unknown poll ids and providers are refused; a missing CLI is unsupported", async (t) => {
  const r = await rig(t);
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  const port = Number(new URL(start.body.intercept.redirectPrefix).port);
  const c = await r.call("POST", "/gateway/providers/cancel", { pollId: start.body.pollId });
  assert.equal(c.body.state, "failed");
  await sleep(500);
  assert.equal(await portOpen(port), false);
  assert.equal((await r.call("GET", "/gateway/providers/poll?id=nope")).status, 404);
  assert.equal((await r.call("POST", "/gateway/providers/login", { id: "rm -rf", v: 2 })).status, 404);
  assert.equal((await r.call("POST", "/gateway/providers/complete", { pollId: "nope", code: "PASTECODE-123456" })).status, 404);
  const none = await r.call("POST", "/gateway/providers/login", { id: "kimi-cli", v: 2 });
  assert.equal(none.body.state, "unsupported");
  assert.match(none.body.reason, /not installed/);
});

test("the CLI runs with a scrubbed environment and the service HOME", async (t) => {
  const r = await rig(t);
  process.env.ARES_TEST_SECRET_ENV = "LEAKME-1234567890";
  t.after(() => { delete process.env.ARES_TEST_SECRET_ENV; });
  const bin = path.join(r.dir, "bin", "claude");
  const src = (await fs.readFile(bin, "utf8")).replace("const line =", 'fs.writeFileSync(path.join(home, ".env-seen"), JSON.stringify(Object.keys(process.env)));\nconst line =');
  await fs.writeFile(bin, src, { mode: 0o755 });
  const start = await r.call("POST", "/gateway/providers/login", { id: "claude-code", v: 2 });
  assert.equal(start.body.state, "open");
  const keys = JSON.parse(await fs.readFile(path.join(r.dir, ".env-seen"), "utf8"));
  assert.ok(!keys.includes("ARES_TEST_SECRET_ENV"));
  assert.ok(!keys.includes("ARES_HOME"));
  assert.ok(keys.includes("BROWSER") && keys.includes("HOME"));
  await r.call("POST", "/gateway/providers/cancel", { pollId: start.body.pollId });
});

test("logout runs the CLI's own logout and the listing flips to signed_out", async (t) => {
  const r = await rig(t);
  await fs.mkdir(path.join(r.dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(r.dir, ".claude", ".credentials.json"), "{}");
  assert.equal((await r.provider("claude-code")).state, "signed_in");
  const out = await r.call("POST", "/gateway/providers/logout", { id: "claude-code" });
  assert.equal(out.body.ok, true);
  assert.equal(out.body.state, "signed_out");
  assert.equal((await r.call("POST", "/gateway/providers/logout", { id: "nope" })).status, 404);
});

// ── Ares's own provider logins, no pty ────────────────────────────────────

test("ares-anthropic: the in-process login is driven through the same routes and lands where the engine reads it", async (t) => {
  const exchanges = [];
  const anthropicFetch = async (url, init) => {
    exchanges.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ access_token: "ACC-TOKEN-1", refresh_token: "REF-TOKEN-1", expires_in: 3600, scope: "user:inference" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await rig(t, { anthropicFetch });
  const start = await r.call("POST", "/gateway/providers/login", { id: "ares-anthropic", v: 2, force: true });
  assert.equal(start.body.state, "open");
  assert.equal(start.body.intercept.redirectPrefix, "http://localhost:53692/callback");
  assert.equal((await r.provider("ares-anthropic")).state, "login_in_progress");
  assert.equal((await r.call("POST", "/gateway/providers/login", { id: "ares-anthropic", v: 2 })).status, 409);
  const u = new URL(start.body.url);
  assert.equal(u.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: `http://localhost:53692/callback?code=AUTHCODE123456&state=${u.searchParams.get("state")}` });
  assert.equal(done.body.state, "signed_in");
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].code, "AUTHCODE123456");
  const tokens = await loadAnthropicTokens();
  assert.equal(tokens.accessToken, "ACC-TOKEN-1");
  assert.equal(await resolveAnthropicAccessToken(anthropicFetch), "ACC-TOKEN-1");
  const p = await r.provider("ares-anthropic");
  assert.equal(p.state, "signed_in");
  assert.ok(!r.logs.join("\n").includes("ACC-TOKEN-1"));
  const out = await r.call("POST", "/gateway/providers/logout", { id: "ares-anthropic" });
  assert.equal(out.body.state, "signed_out");
  assert.equal(await loadAnthropicTokens(), null);
});

test("ares-anthropic: cancel closes the listener on 53692", async (t) => {
  const r = await rig(t, { anthropicFetch: async () => new Response("{}", { status: 400 }) });
  const start = await r.call("POST", "/gateway/providers/login", { id: "ares-anthropic", v: 2, force: true });
  assert.equal(start.body.state, "open");
  assert.ok(await portOpen(53692));
  const c = await r.call("POST", "/gateway/providers/cancel", { pollId: start.body.pollId });
  assert.equal(c.body.state, "failed");
  await sleep(300);
  assert.equal(await portOpen(53692), false);
});

test("ares-openai: loopback on 1455, the token file lands at the path Ares reads", async (t) => {
  const idToken = ["h", Buffer.from(JSON.stringify({ email: "me@example.com", plan_type: "plus", sub: "u1" })).toString("base64url"), "s"].join(".");
  const openaiFetch = async () => new Response(JSON.stringify({ id_token: idToken, access_token: "OA-ACC-1", refresh_token: "OA-REF-1", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  const r = await rig(t, { openaiFetch });
  const start = await r.call("POST", "/gateway/providers/login", { id: "ares-openai", v: 2, force: true });
  assert.equal(start.body.state, "open");
  assert.equal(start.body.intercept.redirectPrefix, "http://localhost:1455/auth/callback");
  const u = new URL(start.body.url);
  const done = await r.call("POST", "/gateway/providers/complete", { pollId: start.body.pollId, callbackUrl: `http://localhost:1455/auth/callback?code=AUTHCODE123456&state=${u.searchParams.get("state")}` });
  assert.equal(done.body.state, "signed_in");
  const file = JSON.parse(await fs.readFile(authFilePath(), "utf8"));
  assert.equal(file.tokens.accessToken, "OA-ACC-1");
  const p = await r.provider("ares-openai");
  assert.equal(p.state, "signed_in");
  assert.equal(p.account, "me@example.com");
  assert.ok(!JSON.stringify(p).includes("OA-ACC-1"));
  assert.equal((await r.call("POST", "/gateway/providers/logout", { id: "ares-openai" })).body.state, "signed_out");
});

test("ares-kimi: device flow surfaces the code and the poll follows the in-process login", async (t) => {
  let polls = 0;
  const kimiFetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/device_authorization")) return new Response(JSON.stringify({ device_code: "DEV-1", user_code: "KIMI-9999", verification_uri: "https://auth.kimi.com/device", verification_uri_complete: "https://auth.kimi.com/device?c=KIMI-9999", interval: 1, expires_in: 60 }), { status: 200 });
    polls++;
    if (polls < 2) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 });
    return new Response(JSON.stringify({ access_token: "K-ACC-1", refresh_token: "K-REF-1", expires_in: 3600, scope: "s" }), { status: 200 });
  };
  const r = await rig(t, { kimiFetch });
  const start = await r.call("POST", "/gateway/providers/login", { id: "ares-kimi", v: 2, force: true });
  assert.equal(start.body.state, "device");
  assert.equal(start.body.userCode, "KIMI-9999");
  assert.equal(start.body.verificationUrl, "https://auth.kimi.com/device");
  assert.equal(start.body.verificationUrlComplete, "https://auth.kimi.com/device?c=KIMI-9999");
  assert.equal(start.body.intervalSec, 1);
  let state = "pending";
  for (let i = 0; i < 40 && state === "pending"; i++) { await sleep(300); state = (await r.call("GET", `/gateway/providers/poll?id=${start.body.pollId}`)).body.state; }
  assert.equal(state, "signed_in");
  assert.equal((await kimiAuthStatus()).connected, true);
  assert.equal((await r.provider("ares-kimi")).state, "signed_in");
  assert.equal((await r.call("POST", "/gateway/providers/logout", { id: "ares-kimi" })).body.state, "signed_out");
});
