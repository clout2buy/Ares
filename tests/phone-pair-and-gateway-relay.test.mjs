// Self-hosted phone pairing + the desktop's relay into the phone gateway.
//
// Every Ares hosts its own gateway: the pairing payload must point at THIS
// machine (never a shared server), carry the owner token, and say honestly
// whether the address survives a restart. The relay lets the desktop use the
// same /gateway routes as the iPhone app without handing the token to the UI.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { RemoteAgentClient } from "../packages/cli/dist/remoteAgentClient.js";
import { tokenPath } from "../packages/garrison/dist/index.js";

const TOKEN = "t".repeat(48);

async function rig(t, opts = {}) {
  // The owner's machine pins its own public address; these tests choose theirs.
  const pinned = process.env.ARES_REMOTE_PUBLIC_URL;
  delete process.env.ARES_REMOTE_PUBLIC_URL;
  t.after(() => { if (pinned !== undefined) process.env.ARES_REMOTE_PUBLIC_URL = pinned; });
  const home = process.env.ARES_HOME;
  await mkdir(path.dirname(tokenPath(home)), { recursive: true });
  await writeFile(tokenPath(home), TOKEN);
  const seen = [];
  const srv = new RemoteAgentServer({
    port: 0,
    host: "127.0.0.1",
    tunnelMode: "none",
    controlToken: TOKEN,
    ...opts,
    phoneApi: {
      goals: async (req, res, url) => {
        if (!url.pathname.startsWith("/gateway/goals")) return false;
        const chunks = [];
        for await (const c of req) chunks.push(c);
        seen.push({ method: req.method, path: url.pathname, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
        res.writeHead(req.method === "DELETE" ? 404 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.method === "DELETE" ? { error: "no such goal" } : { goals: [{ id: "g1", title: "ship it" }] }));
        return true;
      },
    },
  });
  await srv.start();
  t.after(() => srv.close());
  return { srv, seen, client: new RemoteAgentClient(home, srv.port) };
}

test("phone pairing: a LAN-only Ares pairs to itself, with the owner token and an honest warning", async (t) => {
  const { srv, client } = await rig(t);
  const p = await client.phonePairing();
  assert.equal(p.token, TOKEN);
  assert.equal(p.permanence, "lan");
  assert.match(p.url, new RegExp(`^ws://[^/]+:${srv.port}/gateway$`));
  assert.match(p.advice ?? "", /home network/);
  const link = new URL(p.link);
  assert.equal(link.protocol, "ares:");
  assert.equal(link.searchParams.get("url"), p.url);
  assert.equal(link.searchParams.get("token"), TOKEN);
  assert.equal(link.searchParams.get("name"), p.name);
});

test("phone pairing: a pinned public address is permanent and becomes wss://<host>/gateway", async (t) => {
  const { client } = await rig(t, { publicUrl: "https://ares.example.org/" });
  const p = await client.phonePairing();
  assert.equal(p.permanence, "stable");
  assert.equal(p.url, "wss://ares.example.org/gateway");
  assert.equal(p.advice, undefined);
});

test("gateway relay: the desktop reaches phone routes with the owner token and sees real statuses", async (t) => {
  const { client, seen } = await rig(t);
  const got = await client.gatewayFetch("GET", "/gateway/goals");
  assert.equal(got.status, 200);
  assert.deepEqual(got.data, { goals: [{ id: "g1", title: "ship it" }] });

  const posted = await client.gatewayFetch("POST", "/gateway/goals", { title: "new" });
  assert.equal(posted.status, 200);
  assert.deepEqual(seen.at(-1), { method: "POST", path: "/gateway/goals", body: { title: "new" } });

  const missing = await client.gatewayFetch("DELETE", "/gateway/goals/nope");
  assert.equal(missing.status, 404, "a gateway error is returned, not thrown");
  assert.deepEqual(missing.data, { error: "no such goal" });
});

test("gateway relay: refuses anything outside /gateway", async (t) => {
  const { client } = await rig(t);
  await assert.rejects(client.gatewayFetch("POST", "/api/exec", {}), /not a gateway route/);
  await assert.rejects(client.gatewayFetch("GET", "/gateway/../api/devices"), /not a gateway route/);
  await assert.rejects(client.gatewayFetch("GET", "https://evil.example/gateway"), /not a gateway route/);
});
