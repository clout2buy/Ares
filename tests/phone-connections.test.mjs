// The phone's Connections hub: enriched list, liveness test, custom connectors.
// Handler tests run the real handleConnectionsApi behind a real http server
// with fake outbound fetch / DNS / connect broker and a throwaway vault home;
// the auth test goes through the real RemoteAgentServer.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleConnectionsApi, listPhoneConnections } from "../packages/cli/dist/phoneConnections.js";
import { isPrivateAddress, validateConnectorUrl, slugOfName } from "../packages/cli/dist/customConnectors.js";
import { safeText } from "../packages/cli/dist/connectionsSafe.js";
import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import {
  CONNECT_SERVICES,
  appendAudit,
  addOpenMcpServer,
  loadRemoteMcpServers,
  setCredential,
  setMcpServerToken,
  storeTokens,
} from "../packages/core/dist/index.js";

const tmpHome = () => mkdtemp(path.join(tmpdir(), "ares-conn-"));

async function serve(opts) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    handleConnectionsApi(req, res, url, opts).then((handled) => {
      if (!handled) res.writeHead(418).end("not mine");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, raw) => {
    const res = await fetch(base + p, {
      method,
      ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body: json, text };
  };
  return { call, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

/** A fake remote MCP endpoint: initialize + tools/list, optionally bearer-gated. */
function mcpFetch({ bearer = null, tools = 2, status = 200, calls = [] } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (status !== 200) return new Response("nope", { status });
    if (bearer && init.headers?.authorization !== `Bearer ${bearer}`) return new Response("unauthorized", { status: 401 });
    const body = JSON.parse(init.body);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: {} });
    return json({ jsonrpc: "2.0", id: 2, result: { tools: Array.from({ length: tools }, (_, i) => ({ name: `tool${i}` })) } });
  };
}

const publicDns = async () => ["93.184.216.34"];

// A catalog key service that is HTTP (probe-able) and sends a plain bearer.
const KEY_MCP = CONNECT_SERVICES.find((s) => s.id === "render");
const OPTIONAL = ["account", "connectedAt", "lastUsedAt", "health", "healthDetail", "scopes", "capabilities", "usedBy", "custom"];
const CORE = ["blurb", "category", "connected", "domain", "id", "kind", "label"];

// ── list: shape and enrichment ──────────────────────────────────────────────

test("list keeps the original shape and never invents data on a clean home", async () => {
  const home = await tmpHome();
  const list = await listPhoneConnections(home);
  assert.equal(list.length, CONNECT_SERVICES.filter((s) => !s.id.startsWith("site:")).length);
  for (const s of list) {
    for (const key of ["id", "label", "kind", "blurb", "connected"]) assert.ok(key in s, `${s.id} lacks ${key}`);
    for (const key of Object.keys(s)) assert.ok([...CORE, ...OPTIONAL].includes(key), `unexpected key ${key}`);
    assert.equal(s.connected, false);
    // nothing is connected, so nothing about an account, health, use or scopes can be known
    for (const key of ["account", "connectedAt", "lastUsedAt", "health", "healthDetail", "scopes", "custom"]) assert.ok(!(key in s), `${s.id} invented ${key}`);
  }
  const google = list.find((s) => s.id === "google");
  assert.ok(google.capabilities.length > 0);
  assert.ok(google.usedBy.includes("Gmail"));
});

test("a connected oauth service gets health, scopes, lastUsedAt, usedBy - and no secret", async () => {
  const home = await tmpHome();
  await storeTokens("google", { accessToken: "ya29.ACCESS-SECRET-123456", refreshToken: "1//REFRESH-SECRET-654321", expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar" }, { home });
  await setCredential("GOOGLE_OAUTH_CLIENT_SECRET", "CLIENT-SECRET-ABCDEF", { home });
  await appendAudit({ actor: "ares", action: "Gmail.search", result: "ok" }, home);
  const stamp = Date.now();
  const res = await listPhoneConnections(home);
  const google = res.find((s) => s.id === "google");
  assert.equal(google.connected, true);
  assert.equal(google.health, "ok");
  assert.deepEqual(google.scopes, ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar"]);
  assert.ok(google.lastUsedAt <= stamp && google.lastUsedAt > stamp - 60_000, "lastUsedAt comes from the audit entry");
  assert.ok(google.usedBy.includes("Gmail") && google.usedBy.includes("GoogleCalendar"));
  assert.ok(!("connectedAt" in google), "an oauth token records no connect time, so none is invented");
  assert.ok(!("account" in google), "no account until a test has asked the provider");
  const dump = JSON.stringify(res);
  for (const secret of ["ACCESS-SECRET", "REFRESH-SECRET", "CLIENT-SECRET"]) assert.ok(!dump.includes(secret), `${secret} leaked`);
});

test("an expired token with no refresh reads as expired; with a refresh token it is fine", async () => {
  const home = await tmpHome();
  await storeTokens("google", { accessToken: "a", expiresAt: Date.now() - 1000 }, { home });
  await storeTokens("spotify", { accessToken: "b", refreshToken: "r", expiresAt: Date.now() - 1000 }, { home });
  const list = await listPhoneConnections(home);
  const google = list.find((s) => s.id === "google");
  assert.equal(google.health, "expired");
  assert.match(google.healthDetail, /reconnect/);
  assert.equal(list.find((s) => s.id === "spotify").health, "ok");
});

test("an MCP connector reports connectedAt, cached tools as capabilities/usedBy, and mcp_ usage", async () => {
  const home = await tmpHome();
  await setMcpServerToken(KEY_MCP.mcpUrl, "render-SECRET-token-987654", { name: "render", home, fetchImpl: mcpFetch() });
  await writeFile(path.join(home, "mcp-tools-cache.json"), JSON.stringify({ render: { at: Date.now(), tools: [{ name: "list_services" }, { name: "create-deploy" }] } }));
  await appendAudit({ actor: "ares", action: "mcp_render_list_services", result: "ok" }, home);
  const render = (await listPhoneConnections(home)).find((s) => s.id === "render");
  assert.equal(render.connected, true);
  assert.ok(render.connectedAt > Date.now() - 60_000);
  assert.deepEqual(render.usedBy, ["mcp_render_list_services", "mcp_render_create_deploy"]);
  assert.deepEqual(render.capabilities, ["List services", "Create deploy"]);
  assert.ok(render.lastUsedAt > 0);
  assert.equal(render.health, "ok");
  assert.ok(!JSON.stringify(render).includes("render-SECRET"));
  // a cached refresh failure that says 401 is an expired sign-in, not a generic error
  await writeFile(path.join(home, "mcp-tools-cache.json"), JSON.stringify({ render: { at: 1, tools: [], error: "HTTP 401 unauthorized" } }));
  const again = (await listPhoneConnections(home)).find((s) => s.id === "render");
  assert.equal(again.health, "expired");
});

// ── the liveness test ───────────────────────────────────────────────────────

test("test: unknown service is 404, missing is 400, unconnected is ok:false", async () => {
  const s = await serve({ home: await tmpHome(), fetchImpl: mcpFetch() });
  try {
    assert.equal((await s.call("POST", "/gateway/connections/test", { service: "definitely-not-a-thing-xyz" })).status, 404);
    assert.equal((await s.call("POST", "/gateway/connections/test", {})).status, 400);
    const res = await s.call("POST", "/gateway/connections/test", { service: "spotify" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.detail, "not connected");
    assert.equal(typeof res.body.checkedAt, "number");
  } finally { await s.close(); }
});

test("test: an MCP connector is probed with initialize + tools/list; the token never reaches the answer", async () => {
  const home = await tmpHome();
  const token = "render-SECRET-token-987654";
  await setMcpServerToken(KEY_MCP.mcpUrl, token, { name: "render", home, fetchImpl: mcpFetch() });
  const calls = [];
  const s = await serve({ home, fetchImpl: mcpFetch({ bearer: token, tools: 3, calls }) });
  try {
    const ok = await s.call("POST", "/gateway/connections/test", { service: "render" });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.detail, "3 tools available");
    assert.deepEqual(calls.map((c) => JSON.parse(c.init.body).method), ["initialize", "tools/list"]);
    assert.ok(calls.every((c) => c.init.redirect === "manual" && c.init.signal), "bounded and never follows redirects");
    assert.ok(!ok.text.includes(token));
  } finally { await s.close(); }
  // a server that now rejects the token
  const rejecting = await serve({ home, fetchImpl: mcpFetch({ status: 401 }) });
  try {
    const bad = await rejecting.call("POST", "/gateway/connections/test", { service: "render" });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.detail, /rejected/);
    const list = (await listPhoneConnections(home)).find((x) => x.id === "render");
    assert.equal(list.health, "expired", "a failed recent test shows in the list");
  } finally { await rejecting.close(); }
});

test("test: oauth happy path records the account; expired / rejected / leaky errors are handled", async () => {
  const home = await tmpHome();
  const token = "ya29.ACCESS-SECRET-123456";
  await storeTokens("google", { accessToken: token, expiresAt: Date.now() + 3_600_000 }, { home });
  const seen = [];
  const userinfo = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify({ email: "owner@example.com" }), { status: 200 });
  };
  let s = await serve({ home, fetchImpl: userinfo });
  try {
    const res = await s.call("POST", "/gateway/connections/test", { service: "google" });
    assert.deepEqual([res.body.ok, res.body.detail], [true, "signed in as owner@example.com"]);
    assert.equal(seen[0].url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal(seen[0].auth, `Bearer ${token}`);
    const listed = (await listPhoneConnections(home)).find((x) => x.id === "google");
    assert.equal(listed.account, "owner@example.com");
    assert.equal(listed.health, "ok");
  } finally { await s.close(); }

  s = await serve({ home, fetchImpl: async () => new Response("", { status: 401 }) });
  try {
    const res = await s.call("POST", "/gateway/connections/test", { service: "google" });
    assert.equal(res.body.ok, false);
    assert.match(res.body.detail, /rejected/);
  } finally { await s.close(); }

  s = await serve({ home, fetchImpl: async () => { throw new Error(`connect failed for Bearer ${token} and key ${token}`); } });
  try {
    const res = await s.call("POST", "/gateway/connections/test", { service: "google" });
    assert.equal(res.body.ok, false);
    assert.ok(!res.text.includes("ACCESS-SECRET"), "secrets in an error are redacted");
  } finally { await s.close(); }

  await storeTokens("google", { accessToken: token, expiresAt: Date.now() - 5000 }, { home });
  s = await serve({ home, fetchImpl: userinfo });
  try {
    const res = await s.call("POST", "/gateway/connections/test", { service: "google" });
    assert.equal(res.body.ok, false);
    assert.match(res.body.detail, /expired/);
  } finally { await s.close(); }
});

test("test: key services get a read-only ping where one exists, else credential presence", async () => {
  const home = await tmpHome();
  await setCredential("OPENAI_API_KEY", "sk-OPENAI-SECRET-abcdefghijklmnop", { home });
  await setCredential("TESSIE_API_TOKEN", "tessie-secret", { home });
  const calls = [];
  let status = 200;
  const s = await serve({ home, fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status }); } });
  try {
    const ok = await s.call("POST", "/gateway/connections/test", { service: "openai" });
    assert.equal(ok.body.ok, true);
    assert.equal(calls[0].url, "https://api.openai.com/v1/models");
    assert.ok(!calls[0].init.method || calls[0].init.method === "GET", "read-only");
    status = 401;
    const bad = await s.call("POST", "/gateway/connections/test", { service: "openai" });
    assert.equal(bad.body.ok, false);
    assert.ok(!bad.text.includes("OPENAI-SECRET"));
    const before = calls.length;
    const presence = await s.call("POST", "/gateway/connections/test", { service: "tessie" });
    assert.equal(presence.body.ok, true);
    assert.match(presence.body.detail, /isn't verified/);
    assert.equal(calls.length, before, "no network for a presence-only service");
  } finally { await s.close(); }
});

test("test: a hung provider is cut off inside the budget", async () => {
  const home = await tmpHome();
  await storeTokens("google", { accessToken: "a", expiresAt: Date.now() + 3_600_000 }, { home });
  const s = await serve({ home, testTimeoutMs: 60, fetchImpl: () => new Promise(() => {}) });
  try {
    const started = Date.now();
    const res = await s.call("POST", "/gateway/connections/test", { service: "google" });
    assert.ok(Date.now() - started < 3000);
    assert.equal(res.body.ok, false);
    assert.match(res.body.detail, /timed out/);
  } finally { await s.close(); }
});

// ── custom connectors ───────────────────────────────────────────────────────

test("custom: URL validation refuses http, local, private, credentialed and oversized targets", async () => {
  const s = await serve({ home: await tmpHome(), fetchImpl: mcpFetch(), resolveHost: publicDns, broker: null });
  try {
    const bad = [
      "http://mcp.example.com/mcp",
      "https://localhost/mcp",
      "https://foo.localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://192.168.1.5/mcp",
      "https://172.20.0.1/mcp",
      "https://169.254.169.254/latest",
      "https://100.64.0.1/mcp",
      "https://[::1]/mcp",
      "https://[fd00::1]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://printer.local/mcp",
      "https://intranet/mcp",
      "https://user:pass@mcp.example.com/mcp",
      "https://mcp.example.com/mcp#frag",
      "ftp://mcp.example.com/",
      "not a url",
      "https://mcp.example.com/" + "a".repeat(2100),
    ];
    for (const url of bad) {
      const res = await s.call("POST", "/gateway/connections/custom", { name: "Thing", url });
      assert.equal(res.status, 400, `${url.slice(0, 60)} should be refused`);
    }
    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "Thing" })).status, 400);
  } finally { await s.close(); }
  // DNS that points inward is refused too
  const rebind = await serve({ home: await tmpHome(), fetchImpl: mcpFetch(), resolveHost: async () => ["10.0.0.7"], broker: null });
  try {
    const res = await rebind.call("POST", "/gateway/connections/custom", { name: "Thing", url: "https://innocent.example.com/mcp" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /private/);
  } finally { await rebind.close(); }
});

test("custom: names, body size and body shape are limited", async () => {
  const s = await serve({ home: await tmpHome(), fetchImpl: mcpFetch(), resolveHost: publicDns, broker: null });
  try {
    const url = "https://mcp.example.com/mcp";
    for (const name of ["", "   ", "<script>", "a".repeat(49), "!!!", "rm -rf /;", "bad\nname", 7, null]) {
      const res = await s.call("POST", "/gateway/connections/custom", { name, url });
      assert.equal(res.status, 400, `${JSON.stringify(name)} should be refused`);
    }
    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "Big", url, pad: "x".repeat(5000) })).status, 413);
    assert.equal((await s.call("POST", "/gateway/connections/custom", undefined, "{not json")).status, 400);
    assert.equal((await s.call("POST", "/gateway/connections/custom", undefined, "[1,2]")).status, 400);
    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "Spotify", url })).status, 409, "can't shadow a built-in");
  } finally { await s.close(); }
});

test("custom: an open server is added, listed (both ways), de-duplicated, and removed", async () => {
  const home = await tmpHome();
  const calls = [];
  const s = await serve({ home, fetchImpl: mcpFetch({ calls }), resolveHost: publicDns, broker: null });
  try {
    assert.deepEqual((await s.call("GET", "/gateway/connections/custom")).body, { supported: true, servers: [] });
    const added = await s.call("POST", "/gateway/connections/custom", { name: "My Notes Server", url: "https://mcp.example.com/mcp" });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body, { id: "my-notes-server", status: "connected" });
    assert.ok(calls.every((c) => !c.init.headers.authorization), "an unauthenticated probe carries no credential");

    const custom = (await s.call("GET", "/gateway/connections/custom")).body;
    assert.equal(custom.servers.length, 1);
    assert.deepEqual(custom.servers[0], { id: "my-notes-server", name: "My Notes Server", url: "https://mcp.example.com/mcp", status: "connected" });

    const services = (await s.call("GET", "/gateway/connections")).body.services;
    const row = services.find((x) => x.id === "my-notes-server");
    assert.equal(row.custom, true);
    assert.equal(row.connected, true);
    assert.equal(services.filter((x) => x.custom).length, 1);

    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "my notes server", url: "https://mcp.example.com/other" })).status, 409);

    // the normal test endpoint understands custom ids
    const tested = await s.call("POST", "/gateway/connections/test", { service: "my-notes-server" });
    assert.deepEqual([tested.body.ok, tested.body.detail], [true, "2 tools available"]);

    assert.equal((await s.call("POST", "/gateway/connections/custom/remove", { id: "spotify" })).status, 404, "only custom connectors are removable here");
    assert.equal((await s.call("POST", "/gateway/connections/custom/remove", { id: "nope" })).status, 404);
    assert.equal((await s.call("POST", "/gateway/connections/custom/remove", {})).status, 400);
    assert.deepEqual((await s.call("POST", "/gateway/connections/custom/remove", { id: "my-notes-server" })).body, { ok: true });
    assert.deepEqual((await s.call("GET", "/gateway/connections/custom")).body.servers, []);
    assert.deepEqual(await loadRemoteMcpServers(home), {});
  } finally { await s.close(); }
});

test("custom: a server that wants OAuth returns the connect link; failures are honest", async () => {
  const home = await tmpHome();
  const started = [];
  const broker = {
    async start(service, o) {
      started.push({ id: service.id, url: service.mcpUrl, kind: service.kind, reason: o?.reason });
      return { flowId: "f1", service: service.id, label: service.label, kind: service.kind, url: "https://ares.test/connect/f1", instructions: "Tap." };
    },
    async wait() { return { ok: true, detail: "" }; },
  };
  let s = await serve({ home, fetchImpl: mcpFetch({ bearer: "x" }), resolveHost: publicDns, broker });
  try {
    const res = await s.call("POST", "/gateway/connections/custom", { name: "Gated", url: "https://gated.example.com/mcp" });
    assert.deepEqual(res.body, { id: "gated", status: "needs_auth", authUrl: "https://ares.test/connect/f1" });
    assert.deepEqual(started[0], { id: "gated", url: "https://gated.example.com/mcp", kind: "mcp-oauth", reason: "a custom connector added from the Connections screen" });
    assert.deepEqual((await s.call("GET", "/gateway/connections/custom")).body.servers, [], "nothing is stored until the sign-in completes");
  } finally { await s.close(); }

  s = await serve({ home, fetchImpl: mcpFetch({ bearer: "x" }), resolveHost: publicDns, broker: null });
  try {
    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "Gated", url: "https://gated.example.com/mcp" })).status, 503);
  } finally { await s.close(); }

  for (const fetchImpl of [async () => { throw new Error("ECONNREFUSED"); }, mcpFetch({ status: 500 }), mcpFetch({ status: 302 })]) {
    s = await serve({ home, fetchImpl, resolveHost: publicDns, broker });
    try {
      const res = await s.call("POST", "/gateway/connections/custom", { name: "Broken", url: "https://broken.example.com/mcp" });
      assert.equal(res.status, 502);
    } finally { await s.close(); }
  }
  assert.deepEqual(await loadRemoteMcpServers(home), {}, "failures leave nothing behind");
});

test("custom: the private-target opt-in lifts only the host check; the count is capped", async () => {
  const home = await tmpHome();
  const s = await serve({ home, fetchImpl: mcpFetch(), allowPrivate: true, broker: null });
  try {
    const res = await s.call("POST", "/gateway/connections/custom", { name: "Lab", url: "https://localhost:8443/mcp" });
    assert.equal(res.status, 200);
    assert.equal((await s.call("POST", "/gateway/connections/custom", { name: "Lab2", url: "http://localhost:8080/mcp" })).status, 400, "https is still required");
    for (let i = 0; i < 19; i += 1) await addOpenMcpServer(`fill-${i}`, "https://x.example.com/mcp", { home });
    const over = await s.call("POST", "/gateway/connections/custom", { name: "One Too Many", url: "https://mcp.example.com/mcp" });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /at most 20/);
  } finally { await s.close(); }
});

test("address classification and helpers", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.5", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.127.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
  assert.equal(slugOfName("My Notes.Server_2"), "my-notes-server-2");
  await assert.rejects(() => validateConnectorUrl("https://x.example.com", { resolveHost: async () => [] }), /resolved/);
  assert.ok(!safeText("Bearer abcdefghijklmnop and sk_live_abcdefghijkl").includes("abcdefghij"));
});

// ── auth, through the real server ───────────────────────────────────────────

test("every new route is bearer-guarded on the real phone API", async (t) => {
  const srv = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "tok" });
  await srv.start();
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.port}`;
  const call = (method, p, body, token) =>
    fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const routes = [
    ["GET", "/gateway/connections"],
    ["POST", "/gateway/connections/test", { service: "google" }],
    ["GET", "/gateway/connections/custom"],
    ["POST", "/gateway/connections/custom", { name: "X", url: "https://x.example.com/mcp" }],
    ["POST", "/gateway/connections/custom/remove", { id: "x" }],
  ];
  for (const [method, p, body] of routes) {
    assert.equal((await call(method, p, body)).status, 401, `${method} ${p} without a token`);
    assert.equal((await call(method, p, body, "wrong")).status, 401, `${method} ${p} with a wrong token`);
  }
  assert.equal((await call("GET", "/gateway/connections", undefined, "tok")).status, 200);
  const custom = await call("GET", "/gateway/connections/custom", undefined, "tok");
  assert.equal(custom.status, 200);
  assert.equal((await custom.json()).supported, true);
  assert.equal((await call("POST", "/gateway/connections/test", { service: "definitely-not-a-thing-xyz" }, "tok")).status, 404);
});
