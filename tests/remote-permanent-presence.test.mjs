// "They need to literally be paired 24/7 and never go ghost again."
//
// A paired device that is powered on and online should be reachable, full
// stop — no re-pairing, no approving an update, no touching the laptop. Three
// things have to hold, and each one is a way the old build lost a machine:
//
//   1. The address must stay valid. A quick tunnel returns on a NEW random
//      hostname every restart; a connector holding the old one, off-LAN, has
//      nothing left to try and retries dead candidates forever. Either the
//      owner pins a permanent origin, or the server hands out the new address
//      while the socket is still up.
//   2. The connector must catch up by itself. A device pinned on an old
//      version isn't visibly broken — it just silently can't do the newest
//      things, and nobody finds out until an op fails.
//   3. The installer must survive contact with PowerShell. A syntax error in
//      the script that registers the boot task is a machine that never comes
//      back, fixable only by walking over to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import { DEVICE_CONNECTOR_VERSION } from "../packages/cli/dist/remoteDeviceConnector.js";
import { _resetDeviceKeyCache } from "../packages/cli/dist/remoteDeviceCrypto.js";

const run = promisify(execFile);
const isWindows = process.platform === "win32";

async function withServer(opts, fn) {
  const prev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_DEVICES_HOME = await mkdtemp(path.join(tmpdir(), "ares-perm-"));
  _resetDeviceKeyCache();
  const server = new RemoteAgentServer({ port: 0, host: "127.0.0.1", tunnelMode: "none", ...opts });
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

/** A connector double that records what the server pushes at it. */
async function enrol(server, base, { connectorVersion, answer = {} } = {}) {
  const { token } = await server.generatePairingLink("my laptop");
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const seen = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    seen.push(msg);
    const reply = answer[msg.type];
    if (reply) ws.send(JSON.stringify({ ...reply(msg), reqId: msg.reqId }));
  });
  ws.send(JSON.stringify({
    type: "enroll", token, hostname: "TRICKFOOL", os: "Windows",
    username: "Clout", elevated: true, ...(connectorVersion ? { connectorVersion } : {}),
  }));
  for (let i = 0; i < 300 && server.listPcs().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(server.listPcs()[0], "device never attached");
  return { ws, seen, waitFor: async (type, ms = 12_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = seen.find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  } };
}

test("a permanent public address is used verbatim, so a link never goes stale", async () => {
  await withServer({ publicUrl: "https://remote.example.com/", tunnelMode: "auto" }, async (server) => {
    // Trailing slash trimmed, scope is public, and — the point — no quick
    // tunnel was started, so there is no random hostname to expire.
    assert.equal(server.linkBaseUrl(), "https://remote.example.com");
    assert.equal(server.linkScope(), "public");
    const link = await server.generatePairingLink("my laptop");
    assert.ok(link.url.startsWith("https://remote.example.com/pair?token="), link.url);
  });

  await assert.rejects(
    () => withServer({ publicUrl: "remote.example.com" }, async () => {}),
    /must be an http\(s\) origin/,
    "a bare hostname would produce a connector that cannot dial anything",
  );
});

test("a live connector is told the new address when the tunnel moves", async () => {
  await withServer({}, async (server, base) => {
    const { ws, waitFor } = await enrol(server, base, { connectorVersion: DEVICE_CONNECTOR_VERSION });
    try {
      // What scheduleTunnelRestart does when cloudflared comes back elsewhere.
      server.publicBaseUrl = "https://brand-new-hostname.trycloudflare.com";
      server.broadcastHome();

      const home = await waitFor("home");
      assert.ok(home, "a connected device was never told where home moved to");
      assert.equal(home.wsUrl, "wss://brand-new-hostname.trycloudflare.com/ws");
    } finally { ws.close(); }
  });
});

test("a device on an old connector is updated on sight, once, without being asked", async () => {
  await withServer({}, async (server, base) => {
    const pushes = [];
    const { ws, waitFor } = await enrol(server, base, {
      connectorVersion: DEVICE_CONNECTOR_VERSION - 1,
      answer: {
        update: (msg) => { pushes.push(msg); return { type: "update_result", ok: true }; },
      },
    });
    try {
      const push = await waitFor("update", 15_000);
      assert.ok(push, "an out-of-date device was left out of date");
      assert.equal(push.version, DEVICE_CONNECTOR_VERSION);
      assert.equal(typeof push.sha256, "string");
      assert.ok(push.scriptBase64.length > 1000, "the push carried no connector");

      // Once per device per version: a device that rolls back must not be
      // hammered in a loop for the life of the process.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(pushes.length, 1, "the connector was pushed more than once");
    } finally { ws.close(); }
  });
});

test("auto-update can be switched off, and a current device is left alone", async () => {
  await withServer({ autoUpdateDevices: false }, async (server, base) => {
    const { ws, waitFor } = await enrol(server, base, { connectorVersion: 1 });
    try {
      assert.equal(await waitFor("update", 4_500), null, "auto-update ran while disabled");
    } finally { ws.close(); }
  });

  await withServer({}, async (server, base) => {
    const { ws, waitFor } = await enrol(server, base, { connectorVersion: DEVICE_CONNECTOR_VERSION });
    try {
      assert.equal(await waitFor("update", 4_500), null, "an up-to-date device was pushed to anyway");
    } finally { ws.close(); }
  });
});

test("the install script the machine downloads parses on real PowerShell", { skip: !isWindows }, async () => {
  // It registers the boot task. A syntax error here is a device that never
  // reconnects and can only be fixed in person — the one failure this whole
  // feature cannot absorb.
  await withServer({}, async (server, base) => {
    const { token } = await server.generatePairingLink("my laptop");
    const res = await fetch(`${base}/pair-install.ps1?token=${token}`);
    assert.equal(res.status, 200);
    const script = await res.text();
    assert.match(script, /RepetitionInterval/, "the self-healing trigger is missing from the install");

    const file = path.join(await mkdtemp(path.join(tmpdir(), "ares-ps-")), "install.ps1");
    await writeFile(file, script, "utf8");
    const { stdout } = await run("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "$e = $null; $t = $null; " +
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$t, [ref]$e); ` +
      "if ($e.Count -eq 0) { 'PARSE_OK' } else { $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message } }",
    ]);
    assert.match(stdout, /PARSE_OK/, `the pairing installer does not parse:\n${stdout}`);
  });
});

test("a tunnelled request cannot reach the control API, token or not", async () => {
  // cloudflared runs on this machine and dials the origin over loopback, so a
  // request from the internet arrives with remoteAddress 127.0.0.1 and the
  // loopback gate passes. That left one static token between a stranger and
  // POST /api/exec on a paired machine — and it stops being obscure the moment
  // the address is a permanent hostname instead of a random one.
  const controlToken = "a".repeat(32);
  await withServer({ controlToken }, async (server, base) => {
    const auth = { authorization: `Bearer ${controlToken}` };

    const direct = await fetch(`${base}/api/pcs`, { headers: auth });
    assert.equal(direct.status, 200, "a genuine local call must still work");

    for (const header of ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "forwarded"]) {
      const viaTunnel = await fetch(`${base}/api/pcs`, { headers: { ...auth, [header]: "203.0.113.9" } });
      assert.equal(viaTunnel.status, 401, `${header} still reached the control API`);
      assert.deepEqual(await viaTunnel.json(), { error: "unauthorized" });
    }

    // The connector's own endpoints are meant to be public and stay reachable —
    // the fix must not lock the devices out of their own front door.
    const { token } = await server.generatePairingLink("my laptop");
    const pairPage = await fetch(`${base}/pair?token=${token}`, { headers: { "cf-connecting-ip": "203.0.113.9" } });
    assert.equal(pairPage.status, 200, "pairing over the tunnel is the whole point of the tunnel");
  });
});

test("a device that attaches over the LAN is still told the permanent address", async () => {
  // The failure this prevents: the laptop attaches at home, stores a 192.168.*
  // URL, and the day it leaves the house its candidates are that dead LAN
  // address and a seed that may be an expired quick tunnel. Paired 24/7 has to
  // mean away from home too.
  await withServer({ publicUrl: "https://remote.example.com" }, async (server, base) => {
    const { ws, waitFor } = await enrol(server, base, { connectorVersion: DEVICE_CONNECTOR_VERSION });
    try {
      const home = await waitFor("home");
      assert.ok(home, "the device was never told the permanent address");
      assert.equal(home.wsUrl, "wss://remote.example.com/ws");
      assert.equal(home.permanent, true, "it must be stored apart from the address it connected on");
    } finally { ws.close(); }
  });
});
