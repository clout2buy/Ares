// RemoteAgentServer end to end on loopback (tunnelMode "none"): link minting,
// the landing page + connector payloads, register → exec → result, reconnect on
// the same link, rejection of a different machine on a used link, and the
// owner-initiated disconnect.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

async function withServer(fn) {
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none" });
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

function connectAgent(base, token, { hostname = "SARAH-LAPTOP" } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const w = waiters.shift();
      if (w) w(msg); else inbox.push(msg);
    });
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", token, hostname, os: "Windows 11", username: "sarah", ip: "10.0.0.5" }));
      resolve({
        ws,
        next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r))),
      });
    });
  });
}

test("link → landing page → connector payloads", async () => {
  await withServer(async (server, base) => {
    const { token, url, scope } = await server.generateToken("Sarah's PC");
    assert.equal(scope, "lan");
    assert.equal(url, `${base}/agent?token=${token}`);

    const page = await fetch(url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /DOWNLOAD ARES CONNECT/);
    assert.ok(html.includes(`/agent.cmd?token=${token}`), "Windows download link present");
    assert.ok(html.includes(`/agent.py?token=${token}`), "Mac/Linux one-liner present");

    const cmd = await fetch(`${base}/agent.cmd?token=${token}`);
    assert.equal(cmd.headers.get("content-disposition"), 'attachment; filename="ares-connect.cmd"');
    const cmdText = await cmd.text();
    assert.match(cmdText, /^@echo off\r\n/);
    assert.ok(cmdText.includes(`/agent.ps1?token=${token}`));

    const ps1 = await (await fetch(`${base}/agent.ps1?token=${token}`)).text();
    assert.ok(ps1.includes(`$Token = '${token}'`));
    assert.ok(ps1.includes(`ws://127.0.0.1:${server.port}/ws`));
    assert.ok(!ps1.includes("__ARES_"), "all placeholders substituted");

    const py = await (await fetch(`${base}/agent.py?token=${token}`)).text();
    assert.ok(py.includes(`_TOKEN  = "${token}"`));
    assert.ok(!py.includes("__ARES_"));

    assert.equal((await fetch(`${base}/agent?token=nope`)).status, 410);
    assert.equal((await fetch(`${base}/agent.cmd?token=nope`)).status, 410);
  });
});

test("register → exec round trip → disconnect tells the connector goodbye", async () => {
  await withServer(async (server, base) => {
    const connected = [];
    const gone = [];
    server.onPcConnected((pc) => connected.push(pc));
    server.onPcDisconnected((pc) => gone.push(pc));

    const { token } = await server.generateToken("Sarah's PC");
    const agent = await connectAgent(base, token);
    const registered = await agent.next();
    assert.equal(registered.type, "registered");
    assert.equal(connected.length, 1);
    assert.equal(connected[0].label, "Sarah's PC");
    assert.equal(connected[0].hostname, "SARAH-LAPTOP");
    assert.equal(server.listPcs().length, 1);
    assert.equal("ws" in server.listPcs()[0], false, "no socket leaks through listPcs");

    const pcId = connected[0].id;
    const pending = server.exec(pcId, "dir", 5_000);
    const execMsg = await agent.next();
    assert.equal(execMsg.type, "exec");
    assert.equal(execMsg.command, "dir");
    assert.equal(execMsg.timeoutMs, 5_000, "the connector is told the timeout");
    agent.ws.send(JSON.stringify({ type: "exec_result", reqId: execMsg.reqId, output: "Volume C:", exitCode: 0 }));
    assert.deepEqual(await pending, { output: "Volume C:", exitCode: 0 });

    server.notify(pcId, "hello");
    assert.equal((await agent.next()).type, "notify");

    server.disconnect(pcId);
    assert.equal((await agent.next()).type, "bye");
    await new Promise((r) => agent.ws.once("close", r));
    assert.equal(gone.length, 1);
    assert.equal(server.listPcs().length, 0);
    // The link is dead after an owner disconnect — no silent reconnect.
    assert.equal((await fetch(`${base}/agent?token=${token}`)).status, 410);
  });
});

test("a used link lets the SAME machine reconnect and refuses a different one", async () => {
  await withServer(async (server, base) => {
    const connected = [];
    const gone = [];
    server.onPcConnected((pc) => connected.push(pc));
    server.onPcDisconnected((pc) => gone.push(pc));

    const { token } = await server.generateToken("Dave's PC");
    const first = await connectAgent(base, token, { hostname: "DAVE-PC" });
    assert.equal((await first.next()).type, "registered");

    // Wifi blip: the connector comes back on the same token.
    const second = await connectAgent(base, token, { hostname: "DAVE-PC" });
    assert.equal((await second.next()).type, "registered");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.listPcs().length, 1, "stale entry replaced, not duplicated");
    assert.equal(connected.length, 2);
    assert.equal(gone.length, 0, "a replaced entry is not announced as a disconnect");

    // Someone else with the forwarded link: refused.
    const intruder = await connectAgent(base, token, { hostname: "OTHER-PC" });
    const reply = await intruder.next();
    assert.equal(reply.type, "error");
    assert.equal(server.listPcs().length, 1);
    intruder.ws.close();
    second.ws.close();
  });
});

// ─── Control API + daemon-side client ─────────────────────────────────────

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RemoteAgentClient } from "../packages/cli/dist/remoteAgentClient.js";

const CONTROL_TOKEN = "fedcba9876543210fedcba9876543210";

test("control API refuses without the token and serves the daemon client with it", async () => {
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: CONTROL_TOKEN });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${base}/api/pcs`)).status, 401);
    assert.equal((await fetch(`${base}/api/pcs`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${base}/api/link`, { method: "POST", body: "{}" })).status, 401);

    // The client reads the garrison token from the isolated home.
    const home = process.env.ARES_HOME;
    mkdirSync(path.join(home, "garrison"), { recursive: true });
    writeFileSync(path.join(home, "garrison", "token"), CONTROL_TOKEN + "\n");
    const client = new RemoteAgentClient(home, server.port);

    const link = await client.generateToken("Dave's PC");
    assert.equal(link.scope, "lan");
    assert.equal(link.url, `${base}/agent?token=${link.token}`);
    assert.deepEqual(await client.listPcsAsync(), []);

    const agent = await connectAgent(base, link.token, { hostname: "DAVE-PC" });
    assert.equal((await agent.next()).type, "registered");
    const pcs = await client.listPcsAsync();
    assert.equal(pcs.length, 1);
    assert.equal(pcs[0].label, "Dave's PC");

    const pending = client.exec(pcs[0].id, "echo hi", 5_000);
    const execMsg = await agent.next();
    assert.equal(execMsg.type, "exec");
    agent.ws.send(JSON.stringify({ type: "exec_result", reqId: execMsg.reqId, output: "hi", exitCode: 0 }));
    assert.deepEqual(await pending, { output: "hi", exitCode: 0 });

    await assert.rejects(client.exec("nope", "x", 1000), /No remote PC/);

    client.disconnect(pcs[0].id);
    assert.equal((await agent.next()).type, "bye");
    await new Promise((r) => agent.ws.once("close", r));
    assert.deepEqual(await client.listPcsAsync(), []);
  } finally {
    await server.close();
  }
});

test("client reports a helpful error when no server is listening", async () => {
  const home = process.env.ARES_HOME;
  mkdirSync(path.join(home, "garrison"), { recursive: true });
  writeFileSync(path.join(home, "garrison", "token"), CONTROL_TOKEN + "\n");
  const client = new RemoteAgentClient(home, 1); // nothing listens on port 1
  await assert.rejects(client.generateToken("x"), /Remote PC server not running/);
});
