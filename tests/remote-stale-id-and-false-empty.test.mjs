// The two ways "Ares can't find the connector" happened in the field, both
// from one session log (ares-session-1789196852):
//
//   1. A pc_id belongs to a CONNECTION, and a paired machine mints a fresh one
//      on every reconnect — sleep, wifi blip, the 100s Cloudflare idle close, a
//      connector update. Every id a chat was holding then died with `No remote
//      PC with id "…" connected` while the machine sat right there under a new
//      one. Only forwards re-resolved; exec/fetch/screenshot/file/input did not.
//
//   2. `list_devices` read a cache that starts empty and was blanked by any
//      error, and reported that as `ok: true, devices: []` — "No permanently
//      paired devices". A live, paired laptop (in ~/.ares/devices.json, seen 30
//      minutes earlier) was therefore declared never to have existed, and the
//      chat went off to re-pair a machine that was already paired.
//
// A false empty is worse than an error here: an error gets retried, a confident
// "nothing is paired" gets believed.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { proofFor, mintNonce, _resetDeviceKeyCache } from "../packages/cli/dist/remoteDeviceCrypto.js";
import { RemotePCTool, setRemoteAgentServer } from "../packages/tools/dist/index.js";

async function withServer(fn) {
  const prev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_DEVICES_HOME = await mkdtemp(path.join(tmpdir(), "ares-staleid-"));
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

function wire(ws, ops) {
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    const handler = ops[msg.type];
    if (handler) ws.send(JSON.stringify({ ...handler(msg), reqId: msg.reqId }));
  });
}

const echoExec = { exec: (msg) => ({ type: "exec_result", output: `ran: ${msg.command}`, exitCode: 0 }) };

async function enroll(server, base, ops = echoExec) {
  const { token } = await server.generatePairingLink("my laptop");
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  let cred = null;
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "enrolled") cred = msg;
  });
  wire(ws, ops);
  ws.send(JSON.stringify({
    type: "enroll", token, hostname: "TRICKFOOL", os: "Windows",
    username: "Clout", elevated: true, connectorVersion: 2,
  }));
  // Wait for BOTH sides: the server adopting the device, and this socket having
  // actually processed the `enrolled` frame that carries the credential.
  for (let i = 0; i < 400 && (server.listPcs().length === 0 || !cred); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const pc = server.listPcs()[0];
  assert.ok(pc, "device never attached");
  assert.ok(cred, "no credential issued");
  return { ws, pc, cred: () => cred };
}

/** Come back on a fresh socket the way a restarted connector does. */
async function reattach(server, base, cred, ops = echoExec) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type === "server_proof" || msg.type === "device_ready" || msg.type === "error") {
      const w = waiters.shift();
      if (w) w(msg); else inbox.push(msg);
      return;
    }
    const handler = ops[msg.type];
    if (handler) ws.send(JSON.stringify({ ...handler(msg), reqId: msg.reqId }));
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  const myNonce = mintNonce();
  ws.send(JSON.stringify({ type: "device_hello", deviceId: cred.deviceId, nonce: myNonce }));
  const sp = await next();
  assert.equal(sp.type, "server_proof");
  ws.send(JSON.stringify({
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, sp.nonce, "device"),
    connectorVersion: 2,
  }));
  const ready = await next();
  assert.equal(ready.type, "device_ready", `reattach refused: ${ready.message ?? ""}`);
  for (let i = 0; i < 200 && server.listPcs().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  return { ws };
}

test("a pc_id from before a reconnect still reaches the machine", async () => {
  await withServer(async (server, base) => {
    const first = await enroll(server, base);
    const staleId = first.pc.id;
    const cred = first.cred();

    // The machine reconnects: same device, brand-new pc_id.
    first.ws.close();
    const second = await reattach(server, base, cred);
    try {
      const live = server.listPcs()[0];
      assert.notEqual(live.id, staleId, "the premise: a reconnect mints a new pc_id");

      // What used to throw `No remote PC with id "…" connected`.
      const r = await server.exec(staleId, "hostname");
      assert.equal(r.output, "ran: hostname");
      assert.equal(server.resolvePcId(staleId), live.id);

      // The stable handle works directly, which is what callers should pin.
      const byDevice = await server.exec(cred.deviceId, "ver");
      assert.equal(byDevice.output, "ran: ver");

      // Version checks resolve too, or a v2 device reads as v1 and gets refused.
      assert.equal(server.connectorVersionOf(staleId), 2);
    } finally { second.ws.close(); }
  });
});

test("an offline paired device says so, instead of 'no such id'", async () => {
  await withServer(async (server, base) => {
    const { ws, pc, cred } = await enroll(server, base);
    const staleId = pc.id;
    ws.close();
    for (let i = 0; i < 200 && server.listPcs().length > 0; i++) await new Promise((r) => setTimeout(r, 20));

    await assert.rejects(
      () => server.exec(staleId, "hostname"),
      (err) => {
        assert.match(err.message, /paired but not connected/);
        assert.match(err.message, /my laptop/);
        assert.match(err.message, new RegExp(cred().deviceId));
        return true;
      },
    );

    // An id that was never anything still gets the honest answer, plus the
    // reason a pc_id goes stale in the first place.
    await assert.rejects(
      () => server.exec("deadbeefdeadbeef", "hostname"),
      (err) => {
        assert.match(err.message, /No remote PC with id/);
        assert.match(err.message, /list_devices/);
        return true;
      },
    );
  });
});

test("list_devices reports a failure as a failure, never as 'nothing is paired'", async () => {
  // The exact field shape: an out-of-process client whose cache is cold (or
  // whose garrison is unreachable) must not answer "No permanently paired
  // devices" — that sentence is what convinced a chat the laptop never existed.
  const asleep = {
    listPcs: () => [],
    listPcsAsync: async () => [],
    listDevices: () => [],                                  // the cold cache
    listDevicesAsync: async () => { throw new Error("Remote PC server not running"); },
    exec: async () => { throw new Error("unused"); },
    screenshot: async () => { throw new Error("unused"); },
    readFile: async () => { throw new Error("unused"); },
    writeFile: async () => { throw new Error("unused"); },
    notify: () => {},
    generateToken: async () => { throw new Error("unused"); },
  };
  setRemoteAgentServer(asleep);
  try {
    const res = await RemotePCTool.call({ action: "list_devices" }, {});
    assert.equal(res.output.ok, false, "an unreachable garrison must not read as ok");
    assert.doesNotMatch(res.display, /No permanently paired devices/);
    assert.match(res.display, /not running/);

    // And when it IS reachable and genuinely empty, the old wording stands.
    setRemoteAgentServer({ ...asleep, listDevicesAsync: async () => [] });
    const empty = await RemotePCTool.call({ action: "list_devices" }, {});
    assert.equal(empty.output.ok, true);
    assert.match(empty.display, /No permanently paired devices/);
  } finally {
    setRemoteAgentServer(null);
  }
});
