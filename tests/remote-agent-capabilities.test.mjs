// Remote agent v2: HTTP from the device, local→remote forwarding, and the
// connector self-update channel.
//
// The owner's ask: "improve the remote to handle anything, and make Ares be
// able to send updates to the remote tool on my laptop so it's never not able
// to do anything." Three things have to hold for that to be true rather than
// just wired:
//
//   1. A device that reports an old connector version gets a FAST, actionable
//      refusal on a new op — not silence until a timeout. Silence is what made
//      the previous session look like a bottleneck.
//   2. fetch + forward really carry a request to the device and the response
//      back, because the whole point is reaching a service on ITS localhost.
//   3. Every script Ares can push to a machine PARSES on real PowerShell
//      before it is ever sent. A syntax error in the connector is a bricked
//      device that has to be fixed by hand — the one failure mode that costs
//      more than the feature is worth.

import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { RemoteAgentServer } from "../packages/cli/dist/remoteAgentServer.js";
import {
  buildDeviceConnectorPs1,
  buildV1UpdateScript,
  DEVICE_CONNECTOR_VERSION,
} from "../packages/cli/dist/remoteDeviceConnector.js";
import { proofFor, mintNonce, _resetDeviceKeyCache } from "../packages/cli/dist/remoteDeviceCrypto.js";

const run = promisify(execFile);

async function withServer(fn) {
  const prev = process.env.ARES_DEVICES_HOME;
  process.env.ARES_DEVICES_HOME = await mkdtemp(path.join(tmpdir(), "ares-cap-"));
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

/** A fake connector that enrols, then answers whatever `ops` says. */
async function attachDevice(server, base, { connectorVersion, ops = {} } = {}) {
  const { token } = await server.generatePairingLink("test laptop");
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  const seen = [];
  let cred = null;
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type === "enrolled") { cred = msg; return; }
    seen.push(msg);
    const handler = ops[msg.type];
    if (handler) ws.send(JSON.stringify({ ...handler(msg), reqId: msg.reqId }));
  });
  ws.send(JSON.stringify({
    type: "enroll", token, hostname: "TRICKFOOL", os: "Windows", username: "Clout",
    elevated: true, ...(connectorVersion ? { connectorVersion } : {}),
  }));
  for (let i = 0; i < 200 && server.listPcs().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  const pc = server.listPcs()[0];
  assert.ok(pc, "device never attached");
  return { ws, pc, seen, cred: () => cred };
}

/** Come back on a fresh socket the way a restarted connector does. */
async function reattach(server, base, cred, connectorVersion) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws");
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    const w = waiters.shift();
    if (w) w(msg); else inbox.push(msg);
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r)));
  const myNonce = mintNonce();
  ws.send(JSON.stringify({ type: "device_hello", deviceId: cred.deviceId, nonce: myNonce }));
  const sp = await next();
  assert.equal(sp.type, "server_proof");
  assert.equal(sp.proof, proofFor(cred.serverKey, myNonce, "server"));
  ws.send(JSON.stringify({
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, sp.nonce, "device"),
    connectorVersion,
  }));
  const ready = await next();
  assert.equal(ready.type, "device_ready", `reattach refused: ${ready.message ?? ""}`);
  return { ws };
}

test("a device reports its connector version, and old ones are refused fast with the fix", async () => {
  await withServer(async (server, base) => {
    const { ws, pc } = await attachDevice(server, base, { connectorVersion: 1 });
    try {
      assert.equal(server.connectorVersionOf(pc.id), 1);
      assert.equal(server.availableConnectorVersion(), DEVICE_CONNECTOR_VERSION);

      // The refusal must arrive immediately (not after the 30s request
      // timeout) and must name the remedy.
      const started = Date.now();
      await assert.rejects(
        () => server.fetchVia(pc.id, { url: "http://localhost:8090/api/overview" }),
        (err) => {
          assert.match(err.message, /connector v1/);
          assert.match(err.message, /update_agent/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 2_000, "an unsupported op should fail fast, not hang");
    } finally { ws.close(); }
  });
});

test("fetch_on_pc carries a request to the device and the response back", async () => {
  await withServer(async (server, base) => {
    const { ws, pc, seen } = await attachDevice(server, base, {
      connectorVersion: 2,
      ops: {
        fetch: (msg) => ({
          type: "fetch_result",
          status: 200,
          headers: { "content-type": "application/json" },
          dataBase64: Buffer.from(JSON.stringify({ url: msg.url, method: msg.method, containers: 13 })).toString("base64"),
          size: 64,
        }),
      },
    });
    try {
      const r = await server.fetchVia(pc.id, {
        url: "http://localhost:8090/api/overview",
        headers: { Cookie: "mkey=abc" },
      });
      assert.equal(r.status, 200);
      const body = JSON.parse(Buffer.from(r.dataBase64, "base64").toString("utf8"));
      assert.equal(body.containers, 13);
      // The device's own localhost, not the caller's — that is the whole point.
      assert.equal(body.url, "http://localhost:8090/api/overview");
      assert.equal(body.method, "GET");
      const sent = seen.find((m) => m.type === "fetch");
      assert.equal(sent.headers.Cookie, "mkey=abc");
    } finally { ws.close(); }
  });
});

test("forward_http serves the remote service on a loopback port", async () => {
  await withServer(async (server, base) => {
    const { ws, pc } = await attachDevice(server, base, {
      connectorVersion: 2,
      ops: {
        fetch: (msg) => ({
          type: "fetch_result",
          status: 200,
          headers: { "content-type": "text/html", "transfer-encoding": "chunked" },
          dataBase64: Buffer.from(`<h1>dashboard ${msg.url}</h1>`).toString("base64"),
        }),
      },
    });
    try {
      const f = await server.startForward(pc.id, "http://localhost:8090");
      assert.match(f.localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const res = await fetch(`${f.localUrl}/dashboard`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<h1>dashboard http://localhost:8090/dashboard</h1>");
      // The relay re-frames the body; a forwarded transfer-encoding would
      // describe bytes that no longer exist.
      assert.equal(res.headers.get("transfer-encoding"), null);

      assert.equal(server.listForwards().length, 1);
      assert.equal(server.listForwards()[0].requests, 1);
      assert.equal(await server.stopForward(f.id), true);
      assert.equal(server.listForwards().length, 0);
    } finally { ws.close(); }
  });
});

test("update_agent sends the current connector, hash-verified, and reports the version that comes back", async () => {
  await withServer(async (server, base) => {
    const first = await attachDevice(server, base, { connectorVersion: 2 });
    let pushed = null;
    first.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== "update") return;
      pushed = msg;
      first.ws.send(JSON.stringify({ type: "update_result", reqId: msg.reqId, ok: true, version: msg.version }));
      // A real device swaps its script and reattaches on a NEW socket.
      setTimeout(() => first.ws.close(), 50);
    });

    const done = server.updateAgent(first.pc.id, { waitMs: 8_000 });
    // Re-attach as the updated connector once the push lands.
    for (let i = 0; i < 200 && !pushed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(pushed, "no update was pushed");

    const script = Buffer.from(pushed.scriptBase64, "base64").toString("utf8");
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(Buffer.from(pushed.scriptBase64, "base64")).digest("hex"), pushed.sha256);
    assert.equal(pushed.version, DEVICE_CONNECTOR_VERSION);
    // An enrolled device authenticates from its stored credential; shipping a
    // live pairing token in an update would turn the script into a way in.
    assert.doesNotMatch(script, /\$Token\s*=\s*'[^']+'/);

    const again = await reattach(server, base, first.cred(), DEVICE_CONNECTOR_VERSION);
    const r = await done;
    assert.equal(r.ok, true);
    assert.equal(r.from, 2);
    assert.equal(r.to, DEVICE_CONNECTOR_VERSION);
    assert.equal(r.reconnected, true);
    again.ws.close();
  });
});

// ─── the scripts Ares can push must be valid PowerShell ────────────────────

const isWindows = process.platform === "win32";

test("the generated connector parses on real PowerShell", { skip: !isWindows }, async () => {
  const script = buildDeviceConnectorPs1({
    token: "tok", wsUrl: "ws://127.0.0.1:7422/ws", baseUrl: "http://127.0.0.1:7422", discoveryPort: 7423,
  });
  assert.doesNotMatch(script, /__ARES_/, "a placeholder survived into the shipped script");
  await assertParses(script, "connector");
});

test("the update watchdog embedded in the connector parses on real PowerShell", { skip: !isWindows }, async () => {
  const script = buildDeviceConnectorPs1({
    token: "tok", wsUrl: "ws://127.0.0.1:7422/ws", baseUrl: "http://127.0.0.1:7422", discoveryPort: 7423,
  });
  // The watchdog lives inside a single-quoted here-string, so the outer parse
  // above proves nothing about it — and it is the code that has to work when
  // the connector is already broken.
  const m = script.match(/\$wdBody = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(m, "could not find the watchdog body in the connector");
  await assertParses(m[1], "watchdog");
});

test("the v1 bootstrap update script parses on real PowerShell", { skip: !isWindows }, async () => {
  const script = buildV1UpdateScript("a".repeat(64));
  // It travels as powershell -Command "<script>", which escapes double quotes;
  // any double quote of our own would be mangled in transit.
  assert.doesNotMatch(script, /"/, "the v1 update script must use single quotes only");
  await assertParses(script, "v1-bootstrap");
});

async function assertParses(text, label) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "ares-ps-")), `${label}.ps1`);
  await writeFile(file, text, "utf8");
  const probe =
    "$e=$null; $t=$null; " +
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$t, [ref]$e); ` +
    "if ($e.Count -eq 0) { 'PARSE_OK' } else { $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message } }";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], { timeout: 60_000 });
  assert.match(stdout, /PARSE_OK/, `${label} does not parse:\n${stdout}`);
}

// ─── guards on what may be pushed ──────────────────────────────────────────

test("an unrendered connector template is refused rather than pushed", async () => {
  await withServer(async (server, base) => {
    const { ws, pc } = await attachDevice(server, base, { connectorVersion: 2 });
    try {
      const dir = await mkdtemp(path.join(tmpdir(), "ares-tmpl-"));
      const raw = path.join(dir, "template.ps1");
      // The raw template still says __ARES_WS_URL__: a device running it has
      // no address to call home to, and the only fix is walking to the machine.
      await writeFile(raw, "# Ares Remote\n$SeedWs = '__ARES_WS_URL__'\n" + "#".repeat(5000), "utf8");
      await assert.rejects(
        () => server.updateAgent(pc.id, { scriptPath: raw }),
        /placeholder __ARES_WS_URL__/,
      );

      const tiny = path.join(dir, "tiny.ps1");
      await writeFile(tiny, "# Ares Remote\n", "utf8");
      await assert.rejects(() => server.updateAgent(pc.id, { scriptPath: tiny }), /too small/);

      const wrong = path.join(dir, "wrong.ps1");
      await writeFile(wrong, "#".repeat(5000), "utf8");
      await assert.rejects(() => server.updateAgent(pc.id, { scriptPath: wrong }), /does not look like an Ares connector/);
    } finally { ws.close(); }
  });
});

test("update_agent asks the owner even in bypass mode; other actions keep the normal gate", async () => {
  const { RemotePCTool } = await import("../packages/tools/dist/index.js");
  const bypass = { permissionMode: "bypass", workspace: process.cwd() };

  const push = await RemotePCTool.checkPermissions({ action: "update_agent", pc_id: "abc" }, bypass);
  assert.equal(push.kind, "ask", "replacing the connector must always be the owner's call");
  assert.match(push.prompt, /replace the Ares Remote connector/);

  const authored = await RemotePCTool.checkPermissions(
    { action: "update_agent", pc_id: "abc", script_path: "C:\tmp\mine.ps1" }, bypass);
  assert.match(authored.prompt, /a connector it wrote itself/);

  // Everything else keeps the behaviour it had before this override existed.
  assert.equal((await RemotePCTool.checkPermissions({ action: "list_pcs" }, bypass)).kind, "allow");
  assert.equal(
    (await RemotePCTool.checkPermissions({ action: "update_agent", pc_id: "abc" }, { permissionMode: "plan", workspace: process.cwd() })).kind,
    "deny",
  );
});

test("the v1 bootstrap leaves behind a watchdog that itself parses", { skip: !isWindows }, async () => {
  const script = buildV1UpdateScript("b".repeat(64));
  // The watchdog is written as an array of single-quoted PowerShell literals,
  // so recover it the way the device does: evaluate that array and join it.
  const m = script.match(/\$lines=@\((.*)\); Set-Content/s);
  assert.ok(m, "the bootstrap no longer writes a relaunch script");
  const body = m[1]
    .split(/', '/)
    .join("\n")
    .replace(/^'/, "")
    .replace(/'$/, "")
    .replace(/''/g, "'");
  assert.match(body, /rolling back/, "the bootstrap watchdog must be able to roll back");
  await assertParses(body, "v1-watchdog");
});

test("a forward keeps working after the device reconnects with a new pc id", async () => {
  await withServer(async (server, base) => {
    // update_agent reconnects the device on purpose, and every reconnect mints
    // a new pcId. A forward pinned to the old one would break exactly when the
    // owner updates the machine it points at.
    const answer = (msg) => ({
      type: "fetch_result",
      status: 200,
      headers: { "content-type": "text/plain" },
      dataBase64: Buffer.from(`served ${msg.url}`).toString("base64"),
    });
    const first = await attachDevice(server, base, { connectorVersion: 2, ops: { fetch: answer } });
    const f = await server.startForward(first.pc.id, "http://localhost:8090");
    assert.equal(await (await fetch(`${f.localUrl}/a`)).text(), "served http://localhost:8090/a");

    first.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const again = await reattach(server, base, first.cred(), 2);
    again.ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "fetch") again.ws.send(JSON.stringify({ ...answer(msg), reqId: msg.reqId }));
    });
    for (let i = 0; i < 100 && server.listPcs().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.notEqual(server.listPcs()[0].id, first.pc.id, "a reconnect must mint a new pcId");

    assert.equal(await (await fetch(`${f.localUrl}/b`)).text(), "served http://localhost:8090/b");
    assert.equal(server.listForwards()[0].pcId, server.listPcs()[0].id, "the forward should report the id it now uses");
    await server.stopForward(f.id);
    again.ws.close();
  });
});

test("RemotePC caps itself instead of being severed by the 20s external-state watchdog", async () => {
  const { RemotePCTool } = await import("../packages/tools/dist/index.js");
  // exec_on_pc documents a 30s default and accepts up to 120s; fetch and
  // update_agent run longer still. The class default would abort all of them
  // at 20s while the work kept running on the remote machine.
  assert.equal(RemotePCTool.schema.watchdogTimeoutMs, 0);
});
