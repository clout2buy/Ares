// The phone's way in: wss://<tunnel origin>/gateway is piped to the garrison's
// loopback WebSocket gateway by the remote-agent server, so the one tunnel
// that already fronts remote PCs and the Ares network fronts the owner's own
// chat too. The proxy is dumb on purpose — the garrison's hello handshake is
// the auth — but it must never lose the hello, and /ws must stay untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket, { WebSocketServer } from "ws";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";

/** A stand-in garrison: answers hello with welcome, echoes everything else. */
async function fakeGateway() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const seen = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      seen.push(frame);
      if (frame.type === "hello") ws.send(JSON.stringify({ type: "welcome", sessions: [{ id: "s1", title: "phone" }] }));
      else ws.send(JSON.stringify({ type: "echo", frame }));
    });
  });
  const { port } = wss.address();
  // wss.close() only stops accepting; live sockets must be torn down too, or
  // "the garrison went away" never actually happens from the proxy's view.
  const close = () => {
    for (const client of wss.clients) client.terminate();
    return new Promise((r) => wss.close(r));
  };
  return { url: `ws://127.0.0.1:${port}`, seen, close };
}

function once(ws, event) {
  return new Promise((resolve) => ws.once(event, (...args) => resolve(args)));
}

test("/gateway pipes a companion to the garrison, hello included, both ways", async () => {
  const gw = await fakeGateway();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", gatewayUrl: gw.url });
  await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/gateway`);
    // Send the hello the instant the client socket opens — before the proxy's
    // upstream leg can possibly be up. It must be held, not dropped.
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", token: "tok", client: "phone", proto: 1 }));
    const [welcomeRaw] = await once(ws, "message");
    const welcome = JSON.parse(String(welcomeRaw));
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.sessions[0].id, "s1");
    assert.deepEqual(gw.seen[0], { type: "hello", token: "tok", client: "phone", proto: 1 });

    ws.send(JSON.stringify({ type: "sessions.list" }));
    const [echoRaw] = await once(ws, "message");
    assert.deepEqual(JSON.parse(String(echoRaw)), { type: "echo", frame: { type: "sessions.list" } });
    ws.close();
  } finally {
    await server.close();
    await gw.close();
  }
});

test("/gateway is refused when this machine has no gateway configured", async () => {
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none" });
  await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/gateway`);
    const [code, reason] = await once(ws, "close");
    assert.equal(code, 1011);
    assert.match(String(reason), /no gateway/);
  } finally {
    await server.close();
  }
});

test("a companion whose garrison goes away is closed, not left hanging", async () => {
  const gw = await fakeGateway();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", gatewayUrl: gw.url });
  await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/gateway`);
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", token: "tok", client: "phone", proto: 1 }));
    await once(ws, "message");
    const closed = once(ws, "close");
    await gw.close();
    const [code] = await closed;
    assert.ok(code === 1000 || code === 1006 || code === 1011, `closed with ${code}`);
  } finally {
    await server.close();
  }
});

test("/ws is still the remote-PC path — the proxy takes only /gateway", async () => {
  const gw = await fakeGateway();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", gatewayUrl: gw.url });
  await server.start();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await once(ws, "open");
    // A hello here is a remote-PC hello, which the fake garrison never sees.
    ws.send(JSON.stringify({ type: "hello", token: "bogus", hostname: "X" }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(gw.seen.length, 0, "nothing reached the garrison");
    ws.close();
  } finally {
    await server.close();
    await gw.close();
  }
});
