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

// ── the phone's HTTP side-channel ────────────────────────────────────────────

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

async function phoneServer(extra = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-shots-"));
  const server = new RemoteAgentServer({
    port: 0, host: "127.0.0.1", tunnelMode: "none", controlToken: "phone-token",
    phoneApi: {
      screenshotRoots: [root],
      transcribe: async (audio, format) => `heard ${audio.byteLength} bytes as ${format.encoding}@${format.sampleRateHertz}`,
      synthesize: async (text) => Buffer.from(`mp3:${text}`),
      ...extra,
    },
  });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: "Bearer phone-token" };
  return { server, base, root, auth, close: async () => { await server.close(); await fsp.rm(root, { recursive: true, force: true }); } };
}

test("phone api: the token is the gate, and /gateway/health needs none", async () => {
  const ctx = await phoneServer();
  try {
    assert.equal((await fetch(`${ctx.base}/gateway/health`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/gateway/shot?path=/etc/passwd`)).status, 401, "no token → 401");
    assert.equal((await fetch(`${ctx.base}/gateway/shot?path=/etc/passwd`, { headers: { authorization: "Bearer nope" } })).status, 401);
  } finally {
    await ctx.close();
  }
});

test("phone api: /gateway/shot serves only images under a screenshot root", async () => {
  const ctx = await phoneServer();
  try {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await fsp.writeFile(path.join(ctx.root, "shot-1.png"), png);
    await fsp.writeFile(path.join(ctx.root, "notes.txt"), "secret");
    const ok = await fetch(`${ctx.base}/gateway/shot?path=${encodeURIComponent(path.join(ctx.root, "shot-1.png"))}`, { headers: ctx.auth });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), png);
    // Wrong extension, outside the root, and a traversal are all "not found".
    for (const p of [path.join(ctx.root, "notes.txt"), "/etc/passwd", path.join(ctx.root, "..", "x.png"), path.join(ctx.root, "../../etc/passwd.png")]) {
      const res = await fetch(`${ctx.base}/gateway/shot?path=${encodeURIComponent(p)}`, { headers: ctx.auth });
      assert.equal(res.status, 404, `refused: ${p}`);
    }
  } finally {
    await ctx.close();
  }
});

test("phone api: voice in and voice out go through the hooks", async () => {
  const ctx = await phoneServer();
  try {
    const stt = await fetch(`${ctx.base}/gateway/stt`, {
      method: "POST", headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ audio: Buffer.from("abcdef").toString("base64"), encoding: "LINEAR16", sampleRateHertz: 16000 }),
    });
    assert.equal(stt.status, 200);
    assert.deepEqual(await stt.json(), { text: "heard 6 bytes as LINEAR16@16000" });

    const tts = await fetch(`${ctx.base}/gateway/tts`, {
      method: "POST", headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(tts.status, 200);
    const body = await tts.json();
    assert.equal(Buffer.from(body.audio, "base64").toString(), "mp3:hello");
    assert.equal(body.contentType, "audio/mpeg");

    const empty = await fetch(`${ctx.base}/gateway/stt`, { method: "POST", headers: { ...ctx.auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(empty.status, 400);
  } finally {
    await ctx.close();
  }
});

test("phone api: a machine without voice hooks says so instead of crashing", async () => {
  const ctx = await phoneServer({ transcribe: undefined, synthesize: undefined });
  try {
    const res = await fetch(`${ctx.base}/gateway/tts`, { method: "POST", headers: { ...ctx.auth, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    assert.equal(res.status, 501);
  } finally {
    await ctx.close();
  }
});
