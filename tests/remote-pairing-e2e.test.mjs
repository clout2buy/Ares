// Permanent device pairing, end to end against a real server on loopback.
//
// The goal in the owner's words: "download Ares Remote on laptop, connect my
// agent, and it can run those admin commands instead of me." So the things that
// must hold are (a) a device enrols once and thereafter authenticates on its
// own, across restarts, and (b) once attached it behaves like any other remote
// PC so every existing exec/screenshot/file path works on it unchanged.
//
// These drive the ACTUAL WebSocket protocol rather than the helper functions,
// so a mistake in the server wiring is caught here rather than on the laptop.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { proofFor, mintNonce, _resetDeviceKeyCache } from "../packages/cli/dist/remoteDeviceCrypto.js";

/** Each test gets its own device registry + machine key. */
async function withServer(fn) {
  const prev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_DEVICES_HOME = await mkdtemp(path.join(tmpdir(), "ares-pair-"));
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

/** A connector socket that queues inbound messages. */
function connect(base) {
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
    ws.on("open", () =>
      resolve({
        ws,
        send: (o) => ws.send(JSON.stringify(o)),
        next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r))),
      }),
    );
  });
}

/** Phase 1: trade a pairing link for a permanent credential. */
async function enrol(server, base, { name = "Laptop DB", elevated = true } = {}) {
  const link = await server.generatePairingLink(name);
  const c = await connect(base);
  c.send({ type: "enroll", token: link.token, hostname: "MIKE-LAPTOP", os: "Windows 11", username: "mike", elevated });
  const reply = await c.next();
  return { link, c, reply };
}

/** Phase 2: the every-boot handshake, exactly as the connector performs it. */
async function attach(base, cred) {
  const c = await connect(base);
  const myNonce = mintNonce();
  c.send({ type: "device_hello", deviceId: cred.deviceId, nonce: myNonce });
  const sp = await c.next();
  if (sp.type !== "server_proof") return { c, refused: sp };
  // The device verifies the SERVER before authenticating to it.
  assert.equal(sp.proof, proofFor(cred.serverKey, myNonce, "server"), "server proof must verify");
  c.send({ type: "device_auth", proof: proofFor(cred.deviceSecret, sp.nonce, "device") });
  return { c, ready: await c.next() };
}

test("a pairing link enrols a device and hands back a permanent credential", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    assert.equal(reply.type, "enrolled");
    assert.match(reply.deviceId, /^dev_[0-9a-f]{16}$/);
    assert.ok(reply.deviceSecret && reply.serverKey);
    assert.equal(reply.name, "Laptop DB");
    c.ws.close();
  });
});

test("the paired device appears in list_devices, and as a PC once attached", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);

    const listed = server.listDevices();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, "Laptop DB");
    assert.equal(listed[0].elevated, true, "the install reported elevation");
    assert.equal(listed[0].online, true, "enrolling also attaches it");

    // The whole point of adopting it into the PC table: everything else works.
    const pcs = server.listPcs();
    assert.equal(pcs.length, 1);
    assert.equal(pcs[0].label, "Laptop DB");
    c.ws.close();
  });
});

test("after a reboot the device re-authenticates with no link and no human", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();                       // the laptop powers off
    await new Promise((r) => setTimeout(r, 60));

    const { ready, c: c2 } = await attach(base, reply);   // ...and comes back
    assert.equal(ready.type, "device_ready");
    assert.equal(ready.name, "Laptop DB");
    assert.equal(ready.elevated, true);
    c2.ws.close();
  });
});

test("a paired device actually runs commands — the point of the feature", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    const { c: c2 } = await attach(base, reply);
    const pcId = server.listPcs()[0].id;

    const running = server.exec(pcId, "whoami /priv", 5_000);
    const cmd = await c2.next();
    assert.equal(cmd.type, "exec");
    assert.equal(cmd.command, "whoami /priv");
    c2.send({ type: "exec_result", reqId: cmd.reqId, output: "SeDebugPrivilege Enabled", exitCode: 0 });

    const res = await running;
    assert.match(res.output, /SeDebugPrivilege/);
    c2.ws.close();
  });
});

test("a pairing link is single-use — forwarding it cannot enrol a second machine", async () => {
  await withServer(async (server, base) => {
    const link = await server.generatePairingLink("Laptop DB");

    const a = await connect(base);
    a.send({ type: "enroll", token: link.token, hostname: "A", os: "Windows", username: "u" });
    assert.equal((await a.next()).type, "enrolled");

    const b = await connect(base);
    b.send({ type: "enroll", token: link.token, hostname: "B", os: "Windows", username: "u" });
    const second = await b.next();
    assert.equal(second.type, "error", "a burned token must not enrol anything");
    assert.equal(server.listDevices().length, 1);
    a.ws.close(); b.ws.close();
  });
});

test("a one-time HELP link cannot be used to pair permanently", async () => {
  // Otherwise a five-minute favour silently becomes permanent elevated access.
  await withServer(async (server, base) => {
    const help = await server.generateToken("Sarah's PC");
    const c = await connect(base);
    c.send({ type: "enroll", token: help.token, hostname: "SARAH", os: "Windows", username: "sarah" });
    assert.equal((await c.next()).type, "error");
    assert.equal(server.listDevices().length, 0);
    c.ws.close();
  });
});

test("a forged device proof is refused", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    const c2 = await connect(base);
    c2.send({ type: "device_hello", deviceId: reply.deviceId, nonce: mintNonce() });
    const sp = await c2.next();
    assert.equal(sp.type, "server_proof");
    c2.send({ type: "device_auth", proof: "f".repeat(64) });
    const res = await c2.next();
    assert.equal(res.type, "error");
    assert.equal(res.reason, "bad-proof");
    c2.ws.close();
  });
});

test("authenticating without a challenge is refused", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    const c2 = await connect(base);
    c2.send({ type: "device_auth", proof: proofFor(reply.deviceSecret, "anything", "device") });
    const res = await c2.next();
    assert.equal(res.type, "error");
    assert.match(res.message, /hello first/);
    c2.ws.close();
  });
});

test("an unpaired device is told to stop rather than left retrying", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(await server.unpairDevice(reply.deviceId));
    assert.equal(server.listDevices().length, 0);

    const { refused } = await attach(base, reply);
    assert.equal(refused.type, "error");
    assert.equal(refused.fatal, true, "the connector must give up, not loop forever");
    assert.match(refused.message, /not paired/);
  });
});

test("renaming does not break the credential", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    await server.renameDevice(reply.deviceId, "Database Box");
    const { ready, c: c2 } = await attach(base, reply);
    assert.equal(ready.type, "device_ready");
    assert.equal(ready.name, "Database Box");
    c2.ws.close();
  });
});

test("a reconnect replaces the old entry instead of accumulating ghosts", async () => {
  await withServer(async (server, base) => {
    const { reply, c } = await enrol(server, base);
    c.ws.close();
    await new Promise((r) => setTimeout(r, 60));

    const first = await attach(base, reply);
    assert.equal(first.ready.type, "device_ready");
    const second = await attach(base, reply);   // e.g. a flaky link reconnecting
    assert.equal(second.ready.type, "device_ready");

    assert.equal(server.listPcs().length, 1, "one machine, one entry");
    assert.equal(server.listDevices().filter((d) => d.online).length, 1);
    second.c.ws.close();
  });
});

// ─── the pages the owner actually sees ─────────────────────────────────────

test("the pairing page states the cost plainly before anything is installed", async () => {
  await withServer(async (server, base) => {
    const link = await server.generatePairingLink("Laptop DB");
    const html = await (await fetch(`${base}/pair?token=${link.token}`)).text();
    assert.match(html, /permanent/i);
    assert.match(html, /administrator rights/i);
    assert.match(html, /before anyone\s*\n?\s*logs in/i);
    assert.match(html, /machine you own/i);
    assert.match(html, /unpair/i, "the off switch is on the page");
  });
});

test("the installer registers a boot task as the owner, elevated", async () => {
  await withServer(async (server, base) => {
    const link = await server.generatePairingLink("Laptop DB");
    const ps = await (await fetch(`${base}/pair-install.ps1?token=${link.token}`)).text();
    assert.match(ps, /-AtStartup/);
    assert.ok(!/-AtLogOn/.test(ps), "must not wait for a login");
    assert.match(ps, /-RunLevel Highest/);
    assert.match(ps, /Get-Credential/, "runs as the owner, with network credentials");
    assert.ok(!/S-1-5-18/.test(ps), "SYSTEM would not match how the owner runs commands");
    assert.match(ps, /New-NetFirewallRule/, "opens the ports the device needs");
    assert.match(ps, /IsInRole/, "refuses to run unelevated");
  });
});

test("the connector served to the device carries a live token and address", async () => {
  await withServer(async (server, base) => {
    const link = await server.generatePairingLink("Laptop DB");
    const ps1 = await (await fetch(`${base}/pair.ps1?token=${link.token}`)).text();
    assert.ok(!/__ARES_/.test(ps1), "no unsubstituted placeholders");
    assert.match(ps1, new RegExp(link.token));
    assert.match(ps1, /while \(\$true\)/, "reconnects forever");
  });
});

test("an expired or bogus pairing token serves no installer", async () => {
  await withServer(async (_server, base) => {
    for (const route of ["/pair", "/pair.ps1", "/pair-install.ps1"]) {
      const res = await fetch(`${base}${route}?token=deadbeef`);
      assert.ok(res.status >= 400, `${route} must refuse an unknown token (got ${res.status})`);
    }
  });
});
