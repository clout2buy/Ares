// Post-handshake channel authentication, end to end against the real server.
//
// The security invariant is stronger than "the handshake passed": after a v5
// proof, every command/result/heartbeat frame is MACed with a directional key
// and an exact sequence number before either side dispatches it.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { proofFor, mintNonce, _resetDeviceKeyCache } from "../packages/cli/dist/remoteDeviceCrypto.js";
import { channelAuthProof, channelKeys, openFrame, sealFrame } from "../packages/cli/dist/remoteChannelCrypto.js";

const S2D = 0x01;
const D2S = 0x02;

async function withServer(fn) {
  const prev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_DEVICES_HOME = await mkdtemp(path.join(tmpdir(), "ares-mac1-"));
  _resetDeviceKeyCache();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none" });
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
    _resetDeviceKeyCache();
    if (prev === undefined) delete process.env.ARES_DEVICES_HOME;
    else process.env.ARES_DEVICES_HOME = prev;
  }
}

function connectRaw(base) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const text = String(raw);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(text); else inbox.push(text);
    });
    ws.on("error", reject);
    ws.on("open", () => resolve({
      ws,
      sendJson: (obj) => ws.send(JSON.stringify(obj)),
      sendText: (text) => ws.send(text),
      nextText: (timeout = 2_000) => {
        if (inbox.length) return Promise.resolve(inbox.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error("timed out waiting for frame")), timeout);
          waiters.push({ resolve: (value) => { clearTimeout(timer); res(value); } });
        });
      },
    }));
  });
}

async function enrol(server, base) {
  const { token } = await server.generatePairingLink("MAC laptop");
  const c = await connectRaw(base);
  c.sendJson({ type: "enroll", token, hostname: "MAC-LAPTOP", os: "Windows", username: "owner", elevated: true, connectorVersion: 5 });
  const cred = JSON.parse(await c.nextText());
  assert.equal(cred.type, "enrolled");
  c.ws.close();
  await new Promise((r) => setTimeout(r, 40));
  return cred;
}

async function attachV5(base, cred) {
  const c = await connectRaw(base);
  const deviceNonce = mintNonce();
  c.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce: deviceNonce });
  const serverProof = JSON.parse(await c.nextText());
  assert.equal(serverProof.type, "server_proof");
  assert.equal(serverProof.proof, proofFor(cred.serverKey, deviceNonce, "server"));
  const keys = channelKeys(cred.deviceSecret, cred.serverKey, deviceNonce, serverProof.nonce);
  assert.ok(keys, "valid credentials/nonces derive channel keys");
  c.sendJson({
    type: "device_auth",
    proof: channelAuthProof(cred.deviceSecret, serverProof.nonce),
    connectorVersion: 5,
    username: "owner",
  });
  const readyWire = await c.nextText();
  const readyFrame = openFrame(keys.s2d, S2D, 0, readyWire);
  assert.ok(readyFrame, "device_ready is the first authenticated s2d frame");
  const ready = JSON.parse(readyFrame.payload);
  assert.equal(ready.type, "device_ready");
  assert.equal(ready.channel, "mac1");
  return { c, keys, s2dSeq: 1, d2sSeq: 0 };
}

async function waitForClose(ws, timeout = 2_000) {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close")), timeout);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("v5 MACs device_ready, commands, and results in both directions", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const session = await attachV5(base, cred);
    const pc = server.listPcs()[0];
    assert.ok(pc, "v5 device is adopted after authenticated ready");

    const running = server.exec(pc.id, "whoami", 2_000);
    const commandWire = await session.c.nextText();
    const commandFrame = openFrame(session.keys.s2d, S2D, session.s2dSeq++, commandWire);
    assert.ok(commandFrame, "exec is authenticated before the device sees it");
    const command = JSON.parse(commandFrame.payload);
    assert.equal(command.type, "exec");
    assert.equal(command.command, "whoami");

    const result = { type: "exec_result", reqId: command.reqId, output: "owner", exitCode: 0 };
    const resultWire = sealFrame(session.keys.d2s, D2S, session.d2sSeq++, JSON.stringify(result));
    assert.ok(resultWire);
    session.c.sendText(resultWire);
    assert.equal((await running).output, "owner");

    server.notify(pc.id, "still authenticated");
    const notifyWire = await session.c.nextText();
    const notifyFrame = openFrame(session.keys.s2d, S2D, session.s2dSeq++, notifyWire);
    assert.ok(notifyFrame, "notify cannot bypass channel sealing");
    assert.deepEqual(JSON.parse(notifyFrame.payload), {
      type: "notify", message: "still authenticated", seq: String(session.s2dSeq - 1),
    });
    session.c.ws.close();
  });
});

test("v5 fails closed on an unMACed post-handshake frame", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const { c } = await attachV5(base, cred);
    c.sendJson({ type: "pong" });
    await waitForClose(c.ws);
    for (let i = 0; i < 50 && server.listPcs().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.listPcs().length, 0);
  });
});

test("legacy proof cannot spoof a v5 version to suppress migration", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const legacy = await connectRaw(base);
    const nonce = mintNonce();
    legacy.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce });
    const sp = JSON.parse(await legacy.nextText());
    legacy.sendJson({
      type: "device_auth",
      proof: proofFor(cred.deviceSecret, sp.nonce, "device"),
      connectorVersion: 999,
    });
    assert.equal(JSON.parse(await legacy.nextText()).type, "device_ready");
    const pc = server.listPcs()[0];
    assert.ok(pc);
    assert.equal(server.connectorVersionOf(pc.id), 4);
    legacy.ws.close();
  });
});

test("mac1 proof binds connectorVersion, so a relay cannot inflate it", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const c = await connectRaw(base);
    const nonce = mintNonce();
    c.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce });
    const sp = JSON.parse(await c.nextText());
    c.sendJson({
      type: "device_auth",
      proof: channelAuthProof(cred.deviceSecret, sp.nonce, 5),
      connectorVersion: 999,
    });
    const refused = JSON.parse(await c.nextText());
    assert.equal(refused.type, "error");
    assert.equal(refused.reason, "bad-proof");
    assert.equal(server.listPcs().length, 0);
    c.ws.close();
  });
});

test("duplicating a genuine auth frame cannot reset channel sequences", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const c = await connectRaw(base);
    const nonce = mintNonce();
    c.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce });
    const sp = JSON.parse(await c.nextText());
    const auth = {
      type: "device_auth",
      proof: channelAuthProof(cred.deviceSecret, sp.nonce),
      connectorVersion: 5,
    };
    const closed = waitForClose(c.ws);
    c.sendJson(auth);
    c.sendJson(auth);
    await closed;
    for (let i = 0; i < 50 && server.listPcs().length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(server.listPcs().length, 0);
  });
});

test("a socket closed during async auth is never adopted", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const c = await connectRaw(base);
    const nonce = mintNonce();
    c.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce });
    const sp = JSON.parse(await c.nextText());
    c.sendJson({
      type: "device_auth",
      proof: channelAuthProof(cred.deviceSecret, sp.nonce, 5),
      connectorVersion: 5,
    });
    c.ws.terminate();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(server.listPcs().length, 0, "closed auth socket was installed as online");
  });
});

test("once mac1 is pinned, a legacy proof cannot downgrade the device", async () => {
  await withServer(async (server, base) => {
    const cred = await enrol(server, base);
    const protectedSession = await attachV5(base, cred);
    protectedSession.c.ws.close();
    await new Promise((r) => setTimeout(r, 40));

    const legacy = await connectRaw(base);
    const nonce = mintNonce();
    legacy.sendJson({ type: "device_hello", deviceId: cred.deviceId, nonce });
    const sp = JSON.parse(await legacy.nextText());
    legacy.sendJson({ type: "device_auth", proof: proofFor(cred.deviceSecret, sp.nonce, "device"), connectorVersion: 4 });
    const refused = JSON.parse(await legacy.nextText());
    assert.equal(refused.type, "error");
    assert.equal(refused.reason, "downgrade");
    assert.equal(refused.fatal, true);
    legacy.ws.close();
  });
});
