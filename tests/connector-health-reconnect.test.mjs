// The phone's "Fix" button must clear: an expired connector that is reconnected
// (or simply tests green) lists green, a stale cached tool-list failure never
// resurrects "expired", and start on a connected-but-dead service opens a fresh
// flow. Real RemoteAgentServer + ConnectHub + a mock vendor.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { ConnectHub } from "../packages/cli/dist/connectHub.js";
import { loadRemoteMcpServers, registerConnectService, setConnectBroker, unregisterConnectService } from "../packages/core/dist/index.js";
import { startMockAuthServer } from "./_oauthMock.mjs";

const TOKEN = "tok";

async function rig(t) {
  const home = process.env.ARES_HOME;
  const mock = await startMockAuthServer({});
  let origin = "";
  const hub = new ConnectHub({ publicUrl: () => origin, home, log: () => {}, engineSleep: async () => {} });
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
    return { status: res.status, body: j };
  };
  return { home, mock, call };
}

const svc = (mock, id) => ({ id, label: "Mock Health", kind: "mcp-oauth", blurb: "mock", keywords: [id], howToUse: "mock", mcpUrl: mock.mcpUrl });
const healthOf = async (r, id) => (await r.call("GET", "/gateway/connections")).body.services.find((s) => s.id === id);
const seedStaleError = async (home, id) => {
  const file = path.join(home, "mcp-tools-cache.json");
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(file, "utf8")); } catch { /* none */ }
  cache[id] = { at: 0, tools: [], error: `${id} rejected the connection (HTTP 401) - it needs to be connected again`, errorAt: Date.now() - 60_000 };
  await fs.writeFile(file, JSON.stringify(cache));
};
async function connect(r, id) {
  const s = await r.call("POST", "/gateway/connections/start", { service: id, v: 2 });
  assert.equal(s.body.state, "open");
  const back = await r.mock.consent(s.body.url);
  assert.equal((await fetch(back, { redirect: "manual" })).status, 200);
}

test("expired -> start opens a fresh flow (not 'connected') -> reconnect lists green and drops the stale latch", async (t) => {
  const r = await rig(t);
  registerConnectService(svc(r.mock, "mockhealth1"));
  t.after(() => unregisterConnectService("mockhealth1"));
  await connect(r, "mockhealth1");
  assert.equal((await healthOf(r, "mockhealth1")).health, "ok");

  await seedStaleError(r.home, "mockhealth1");
  const expired = await healthOf(r, "mockhealth1");
  assert.equal(expired.health, "expired");

  // The Fix button: start again. Stored-but-dead must not answer "connected".
  const fix = await r.call("POST", "/gateway/connections/start", { service: "mockhealth1", v: 2 });
  assert.equal(fix.body.state, "open");
  const back = await r.mock.consent(fix.body.url);
  assert.equal((await fetch(back, { redirect: "manual" })).status, 200);
  const poll = await r.call("GET", `/gateway/connections/poll?id=${encodeURIComponent(fix.body.pollId)}`);
  assert.equal(poll.body.state, "connected");

  const after = await healthOf(r, "mockhealth1");
  assert.equal(after.health, "ok");
  assert.equal(after.healthDetail, undefined);
  const cache = JSON.parse(await fs.readFile(path.join(r.home, "mcp-tools-cache.json"), "utf8"));
  assert.equal(cache.mockhealth1.error, undefined, "the cached failure is gone from disk");
  // And a healthy connected service still answers "connected" without a new flow.
  assert.equal((await r.call("POST", "/gateway/connections/start", { service: "mockhealth1", v: 2 })).body.state, "connected");
});

test("a successful test flips an expired listing to green with the new checkedAt", async (t) => {
  const r = await rig(t);
  registerConnectService(svc(r.mock, "mockhealth2"));
  t.after(() => unregisterConnectService("mockhealth2"));
  await connect(r, "mockhealth2");
  await seedStaleError(r.home, "mockhealth2");
  assert.equal((await healthOf(r, "mockhealth2")).health, "expired");
  const tested = await r.call("POST", "/gateway/connections/test", { service: "mockhealth2" });
  assert.equal(tested.body.ok, true);
  assert.ok(tested.body.checkedAt > Date.now() - 60_000);
  assert.equal((await healthOf(r, "mockhealth2")).health, "ok");
  const cache = JSON.parse(await fs.readFile(path.join(r.home, "mcp-tools-cache.json"), "utf8"));
  assert.equal(cache.mockhealth2.error, undefined);
});

test("a connector stored on a retired /sse URL is migrated to the catalog streamable-HTTP URL", async () => {
  const home = process.env.ARES_HOME;
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "mcp-remote.json"), JSON.stringify({ servers: {
    "cloudflare-observability": { url: "https://observability.mcp.cloudflare.com/sse", oauth: true },
    "custom-sse": { url: "https://example.com/sse", oauth: true },
  } }));
  const servers = await loadRemoteMcpServers(home);
  assert.equal(servers["cloudflare-observability"].url, "https://observability.mcp.cloudflare.com/mcp");
  assert.equal(servers["custom-sse"].url, "https://example.com/sse");
  assert.match(await fs.readFile(path.join(home, "mcp-remote.json"), "utf8"), /observability\.mcp\.cloudflare\.com\/mcp/);
});
