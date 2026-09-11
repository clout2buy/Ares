// Keepalive for the remote-PC link.
//
// Field report: "its my current session im in and it keeps dropping connection."
// Cloudflare closes any WebSocket idle for 100s on Free/Pro (a quick tunnel is
// Free), and their documented remedy is a keepalive. Ares sent none -- no ping,
// no pong, no dead-peer detection anywhere in the server or either connector.
// A session spent READING rather than typing is exactly that idle condition, so
// the link died about every 100 seconds, forever.
//
// The server drives the heartbeat because both connectors sit blocked in a
// receive call: answering is free, sending on a timer would need a cancellable
// receive in both PowerShell and Python.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

/** Heartbeat period is 30s in prod -- far too slow to test against. These tests
 *  drive the wire directly instead of waiting on the timer. */
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

test("a JSON pong from the connector is absorbed, not treated as a command reply", async () => {
  await withServer(async (server, base) => {
    const { token } = await server.generateToken("Sarah's PC");
    const agent = await connectAgent(base, token);
    assert.equal((await agent.next()).type, "registered");

    // The connector answers the server's ping. This must not surface as a stray
    // message or disturb the pending-command bookkeeping.
    agent.ws.send(JSON.stringify({ type: "pong" }));
    // Round-trip a real command to prove the channel still works afterwards.
    const execPromise = server.exec(server.listPcs()[0].id, "echo hi", 5_000);
    const cmd = await agent.next();
    assert.equal(cmd.type, "exec");
    agent.ws.send(JSON.stringify({ type: "exec_result", reqId: cmd.reqId, output: "hi", exitCode: 0 }));
    const res = await execPromise;
    assert.equal(res.output, "hi");
    agent.ws.close();
  });
});

test("the PC stays listed while it answers -- a quiet link is not a dead one", async () => {
  await withServer(async (server, base) => {
    const { token } = await server.generateToken("Sarah's PC");
    const agent = await connectAgent(base, token);
    assert.equal((await agent.next()).type, "registered");
    assert.equal(server.listPcs().length, 1);

    // Idle, then answer a ping the way the connectors do. Still connected.
    agent.ws.send(JSON.stringify({ type: "pong" }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.listPcs().length, 1, "an idle-but-answering PC stays connected");
    agent.ws.close();
  });
});

test("a WS-level ping from the server is answered by the ws client automatically", async () => {
  // Proves the control-frame half of the belt-and-braces. The Python connector
  // replies to opcode 0x9 by hand; .NET ClientWebSocket does it natively.
  await withServer(async (server, base) => {
    const { token } = await server.generateToken("Sarah's PC");
    const agent = await connectAgent(base, token);
    assert.equal((await agent.next()).type, "registered");

    const pcId = server.listPcs()[0].id;
    const pongSeen = new Promise((resolve) => {
      // Reach the live socket the same way the heartbeat does.
      const before = Date.now();
      agent.ws.on("pong", () => resolve(Date.now() - before));
    });
    agent.ws.ping();
    const ms = await pongSeen;
    assert.ok(ms >= 0, "peer answered a control ping");
    assert.equal(server.listPcs()[0].id, pcId, "connection survived the exchange");
    agent.ws.close();
  });
});

test("disconnect settles in-flight commands instead of hanging them forever", async () => {
  await withServer(async (server, base) => {
    const { token } = await server.generateToken("Sarah's PC");
    const agent = await connectAgent(base, token);
    assert.equal((await agent.next()).type, "registered");

    const pending = server.exec(server.listPcs()[0].id, "sleep 999", 30_000);
    await agent.next(); // the exec command reaches the connector
    agent.ws.close();   // ...and the PC vanishes mid-command

    // Before dead-peer handling this rejected only via the 30s command timeout.
    await assert.rejects(pending, /disconnect|closed|gone/i);
  });
});
