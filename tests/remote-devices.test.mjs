// Paired-device credentials and LAN rendezvous — the persistent half of Ares
// Remote. Link tokens are built for ephemeral help (one-time, 10 min, exits on
// "bye"); a device the owner keeps forever needs a credential that survives
// reboots, tunnel churn and daemon restarts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  mintDeviceCredential,
  hashDeviceSecret,
  deviceSecretMatches,
  authenticateDevice,
  parseDeviceRegistry,
  loadDeviceRegistry,
  saveDeviceRegistry,
  uniqueDeviceName,
  deviceRegistryPath,
  deviceHome,
} from "../packages/cli/dist/remoteDevices.js";
import {
  buildDiscoveryProbe,
  parseDiscoveryProbe,
  buildDiscoveryReply,
  parseDiscoveryReply,
  DiscoveryResponder,
  DISCOVERY_PORT,
  broadcastTargets,
  subnetBroadcast,
  probeForServer,
} from "../packages/cli/dist/remoteRendezvous.js";
import {
  remotePortNeeds,
  firewallFixCommand,
  firewallAdvice,
} from "../packages/cli/dist/remoteFirewall.js";

const home = () => mkdtemp(path.join(tmpdir(), "ares-devices-"));

function registryWith(device) {
  return { version: 1, devices: [device] };
}

function pairedDevice(overrides = {}) {
  const cred = mintDeviceCredential();
  return {
    cred,
    device: {
      id: cred.deviceId,
      name: "Database Box",
      secretHash: hashDeviceSecret(cred.deviceSecret),
      hostname: "ares-db",
      os: "Linux",
      addedAt: Date.now(),
      ...overrides,
    },
  };
}

// ─── credentials ───────────────────────────────────────────────────────────

test("a minted credential authenticates; a near-miss secret does not", () => {
  const { cred, device } = pairedDevice();
  const reg = registryWith(device);

  const ok = authenticateDevice(reg, cred.deviceId, cred.deviceSecret);
  assert.equal(ok.ok, true);
  assert.equal(ok.device.name, "Database Box");

  const bad = authenticateDevice(reg, cred.deviceId, cred.deviceSecret.slice(0, -1) + "x");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-secret");
});

test("the plaintext secret is never written to the registry", async () => {
  const dir = await home();
  const { cred, device } = pairedDevice();
  await saveDeviceRegistry(dir, registryWith(device));
  const onDisk = await readFile(deviceRegistryPath(dir), "utf8");
  assert.ok(!onDisk.includes(cred.deviceSecret), "secret must not be recoverable from the file");
  assert.ok(onDisk.includes(device.secretHash), "only the hash is stored");
});

test("secrets are long enough to be worth storing hashed", () => {
  const { cred } = pairedDevice();
  // 32 random bytes, base64url — a permanent key to the owner's machine.
  assert.ok(cred.deviceSecret.length >= 40, `secret too short: ${cred.deviceSecret.length}`);
  assert.match(cred.deviceId, /^dev_[0-9a-f]{16}$/);
});

test("a revoked device is refused, and told WHY rather than looping in silence", () => {
  const { cred, device } = pairedDevice({ revokedAt: Date.now() });
  const res = authenticateDevice(registryWith(device), cred.deviceId, cred.deviceSecret);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "revoked");
});

test("a wrong secret on a revoked device reports bad-secret, not revoked", () => {
  // Otherwise the reason code is an oracle: guess an id, learn whether it exists.
  const { cred, device } = pairedDevice({ revokedAt: Date.now() });
  const res = authenticateDevice(registryWith(device), cred.deviceId, "wrong");
  assert.equal(res.reason, "bad-secret");
});

test("an unknown device id is refused without touching secrets", () => {
  const { cred } = pairedDevice();
  const res = authenticateDevice({ version: 1, devices: [] }, cred.deviceId, cred.deviceSecret);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unknown");
});

test("a mismatched-length hash does not throw (timingSafeEqual is strict)", () => {
  assert.equal(deviceSecretMatches("whatever", "abcd"), false);
  assert.equal(deviceSecretMatches("whatever", "not-hex-at-all"), false);
});

// ─── registry durability ───────────────────────────────────────────────────

test("a corrupt registry reads as empty instead of taking the daemon down", async () => {
  const dir = await home();
  await writeFile(deviceRegistryPath(dir), "{ this is not json", "utf8");
  const reg = await loadDeviceRegistry(dir);
  assert.deepEqual(reg.devices, []);
});

test("a missing registry reads as empty", async () => {
  assert.deepEqual((await loadDeviceRegistry(await home())).devices, []);
});

test("entries without a usable credential are dropped, not kept as ghosts", () => {
  const reg = parseDeviceRegistry(JSON.stringify({
    version: 1,
    devices: [
      { id: "dev_1", secretHash: "aa", name: "real" },
      { id: "dev_2" },                    // no secret — can never authenticate
      { secretHash: "bb" },               // no id
      "nonsense",
    ],
  }));
  assert.equal(reg.devices.length, 1);
  assert.equal(reg.devices[0].id, "dev_1");
});

test("save → load round-trips a device", async () => {
  const dir = await home();
  const { cred, device } = pairedDevice();
  await saveDeviceRegistry(dir, registryWith(device));
  const reg = await loadDeviceRegistry(dir);
  assert.equal(reg.devices.length, 1);
  assert.equal(authenticateDevice(reg, cred.deviceId, cred.deviceSecret).ok, true);
});

// ─── naming ────────────────────────────────────────────────────────────────

test("device names stay unique and never empty", () => {
  const reg = { version: 1, devices: [{ id: "a", name: "Database Box", secretHash: "x" }] };
  assert.equal(uniqueDeviceName(reg, "Database Box"), "Database Box 2");
  assert.equal(uniqueDeviceName(reg, "  "), "device");
  assert.equal(uniqueDeviceName(reg, "Laptop"), "Laptop");
});

test("a revoked device's name is freed for reuse", () => {
  const reg = { version: 1, devices: [{ id: "a", name: "Database Box", secretHash: "x", revokedAt: 1 }] };
  assert.equal(uniqueDeviceName(reg, "Database Box"), "Database Box");
});

// ─── LAN discovery ─────────────────────────────────────────────────────────

test("probe and reply round-trip", () => {
  const probe = parseDiscoveryProbe(buildDiscoveryProbe("dev_abc"));
  assert.equal(probe.deviceId, "dev_abc");
  const reply = parseDiscoveryReply(buildDiscoveryReply({ baseUrl: "http://10.0.0.2:7422", host: "TOWER" }));
  assert.deepEqual(reply, { baseUrl: "http://10.0.0.2:7422", host: "TOWER" });
});

test("stray LAN traffic is not mistaken for a probe or a reply", () => {
  assert.equal(parseDiscoveryProbe(Buffer.from("hello")), null);
  assert.equal(parseDiscoveryProbe(Buffer.from(JSON.stringify({ deviceId: "x" }))), null, "magic required");
  assert.equal(parseDiscoveryReply(Buffer.from(JSON.stringify({ baseUrl: "http://x" }))), null, "magic required");
});

test("a reply without a usable URL is rejected", () => {
  assert.equal(parseDiscoveryReply(buildDiscoveryReply({ baseUrl: "", host: "TOWER" })), null);
});

test("the responder answers a paired device and ignores an unpaired one", async () => {
  const port = DISCOVERY_PORT + 101; // keep off the real port in tests
  const responder = new DiscoveryResponder({
    currentBaseUrl: () => "http://10.0.0.2:7422",
    knowsDevice: (id) => id === "dev_known",
    host: "TOWER",
    port,
  });
  const bound = await responder.start();
  assert.equal(bound, true, "responder bound");

  const { createSocket } = await import("node:dgram");
  const ask = (deviceId, timeoutMs = 400) =>
    new Promise((resolve) => {
      const sock = createSocket("udp4");
      const done = (v) => { try { sock.close(); } catch {} resolve(v); };
      const timer = setTimeout(() => done(null), timeoutMs);
      sock.on("message", (raw) => { clearTimeout(timer); done(parseDiscoveryReply(raw)); });
      sock.send(buildDiscoveryProbe(deviceId), port, "127.0.0.1");
    });

  try {
    const good = await ask("dev_known");
    assert.ok(good, "paired device got an answer");
    assert.equal(good.baseUrl, "http://10.0.0.2:7422");

    const stranger = await ask("dev_stranger");
    assert.equal(stranger, null, "an unpaired machine learns nothing — silence, not a refusal");
  } finally {
    responder.close();
  }
});

test("the responder withholds an answer when there is no URL to give", async () => {
  const port = DISCOVERY_PORT + 102;
  const responder = new DiscoveryResponder({
    currentBaseUrl: () => undefined, // server still coming up
    knowsDevice: () => true,
    host: "TOWER",
    port,
  });
  assert.equal(await responder.start(), true);
  const { createSocket } = await import("node:dgram");
  const answer = await new Promise((resolve) => {
    const sock = createSocket("udp4");
    const done = (v) => { try { sock.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done(null), 300);
    sock.on("message", (raw) => { clearTimeout(timer); done(parseDiscoveryReply(raw)); });
    sock.send(buildDiscoveryProbe("dev_any"), port, "127.0.0.1");
  });
  responder.close();
  assert.equal(answer, null, "better silent than handing out a stale address");
});

// ─── multi-interface probing (Ethernet PC ↔ WiFi device) ───────────────────
// The global broadcast alone goes out ONE interface of the kernel's choosing.
// On a host with WiFi + Ethernet + a VM switch + a VPN adapter that is the
// wrong one about as often as the right one, so every interface gets its own
// subnet-directed probe.

test("subnet broadcast is derived from the interface's own netmask", () => {
  assert.equal(subnetBroadcast("192.168.1.42", "255.255.255.0"), "192.168.1.255");
  assert.equal(subnetBroadcast("10.0.0.7", "255.255.0.0"), "10.0.255.255");
  assert.equal(subnetBroadcast("172.16.5.9", "255.255.248.0"), "172.16.7.255");
});

test("a /32 yields no broadcast — probing it would look like working discovery that never answers", () => {
  assert.equal(subnetBroadcast("192.168.1.42", "255.255.255.255"), null);
});

test("garbage addresses are rejected rather than producing a bogus target", () => {
  assert.equal(subnetBroadcast("not.an.ip.addr", "255.255.255.0"), null);
  assert.equal(subnetBroadcast("192.168.1.1", "junk"), null);
  assert.equal(subnetBroadcast("999.1.1.1", "255.255.255.0"), null);
});

test("an Ethernet + WiFi host probes BOTH subnets, plus the global backstop", () => {
  // The owner's exact setup: PC wired, device on wifi, same router.
  const targets = broadcastTargets({
    "Ethernet": [{ family: "IPv4", internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }],
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.55", netmask: "255.255.255.0" }],
    "Loopback": [{ family: "IPv4", internal: true, address: "127.0.0.1", netmask: "255.0.0.0" }],
  });
  assert.ok(targets.includes("192.168.1.255"), "the shared subnet is probed");
  assert.ok(targets.includes("255.255.255.255"), "global backstop kept");
  assert.ok(!targets.some((t) => t.startsWith("127.")), "loopback is not a discovery target");
});

test("a VM switch or VPN adapter on another subnet gets its own probe", () => {
  const targets = broadcastTargets({
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.55", netmask: "255.255.255.0" }],
    "vEthernet (WSL)": [{ family: "IPv4", internal: false, address: "172.20.16.1", netmask: "255.255.240.0" }],
  });
  assert.ok(targets.includes("192.168.1.255"));
  assert.ok(targets.includes("172.20.31.255"), "the other subnet is probed too, not guessed at");
});

test("duplicate subnets collapse to one target", () => {
  const targets = broadcastTargets({
    a: [{ family: "IPv4", internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }],
    b: [{ family: "IPv4", internal: false, address: "192.168.1.11", netmask: "255.255.255.0" }],
  });
  assert.equal(targets.filter((t) => t === "192.168.1.255").length, 1);
});

test("node's newer numeric family value is accepted", () => {
  const targets = broadcastTargets({
    eth: [{ family: 4, internal: false, address: "192.168.1.10", netmask: "255.255.255.0" }],
  });
  assert.ok(targets.includes("192.168.1.255"), "family:4 must not be silently skipped");
});

test("probe → responder → answer, end to end over real sockets", async () => {
  const port = DISCOVERY_PORT + 103;
  const responder = new DiscoveryResponder({
    currentBaseUrl: () => "http://192.168.1.10:7422",
    knowsDevice: (id) => id === "dev_db",
    host: "TOWER",
    port,
  });
  assert.equal(await responder.start(), true);
  try {
    const found = await probeForServer("dev_db", { targets: ["127.0.0.1"], port, timeoutMs: 800 });
    assert.ok(found, "device located its owner");
    assert.equal(found.baseUrl, "http://192.168.1.10:7422");
    assert.equal(found.host, "TOWER");
  } finally {
    responder.close();
  }
});

test("probing with nobody listening times out cleanly rather than hanging", async () => {
  const found = await probeForServer("dev_db", { targets: ["127.0.0.1"], port: DISCOVERY_PORT + 104, timeoutMs: 300 });
  assert.equal(found, null);
});

// ─── firewall preflight ────────────────────────────────────────────────────
// Windows blocks inbound by default, so a paired device on the LAN retries
// forever and nothing says why. Detect and explain instead of shipping a
// device that can never connect.

test("the fix command opens exactly the two ports needed, and only on private networks", () => {
  const cmd = firewallFixCommand(remotePortNeeds(7422, 7423));
  assert.match(cmd, /-Protocol TCP -LocalPort 7422/);
  assert.match(cmd, /-Protocol UDP -LocalPort 7423/);
  assert.match(cmd, /-Profile Private/);
  assert.ok(!/-Profile Any/.test(cmd), "must not open the port on public networks too");
  assert.ok(!/-Profile Public/.test(cmd), "a coffee-shop network is not where this should listen");
});

test("advice is silent when everything is already allowed", () => {
  assert.equal(firewallAdvice({ platform: "windows", allowed: true, checked: true, missing: [] }), null);
  assert.equal(firewallAdvice({ platform: "other", allowed: true, checked: false, missing: [] }), null);
});

test("advice names the ports, the symptom, and the exact command", () => {
  const needs = remotePortNeeds(7422, 7423);
  const advice = firewallAdvice({
    platform: "windows",
    allowed: false,
    checked: true,
    missing: needs,
    fixCommand: firewallFixCommand(needs),
  });
  assert.match(advice, /7422/);
  assert.match(advice, /7423/);
  assert.match(advice, /retry forever/i, "the symptom is what the owner will actually observe");
  assert.match(advice, /New-NetFirewallRule/, "and a command they can paste");
});

test("an unreadable firewall reports uncertainty rather than claiming it is fine", () => {
  const advice = firewallAdvice({ platform: "windows", allowed: false, checked: false, missing: [] });
  assert.match(advice, /[Cc]ould not read/);
});

// ─── machine-scoped registry ───────────────────────────────────────────────
// Devices deliberately do NOT follow ARES_HOME. Ares runs with two homes in
// practice (the CLI's ~/.ares and the desktop app's %APPDATA%/Ares/home), and a
// device is paired to the physical MACHINE, not to an app profile. Following
// ARES_HOME would mean pairing from the desktop app and then having a CLI
// garrison refuse the same device as `unknown` while it retried forever.

test("the registry ignores ARES_HOME so both garrisons see the same devices", () => {
  const prevAres = process.env.ARES_HOME;
  try {
    process.env.ARES_HOME = path.join(tmpdir(), "some-app-profile-home");
    const underDesktopHome = deviceRegistryPath();
    process.env.ARES_HOME = path.join(tmpdir(), "a-completely-different-home");
    const underCliHome = deviceRegistryPath();
    assert.equal(underDesktopHome, underCliHome, "ARES_HOME must not move the device registry");
  } finally {
    if (prevAres === undefined) delete process.env.ARES_HOME;
    else process.env.ARES_HOME = prevAres;
  }
});

test("ARES_DEVICES_HOME is the deliberate override, so tests can isolate", () => {
  const prev = process.env.ARES_DEVICES_HOME;
  try {
    process.env.ARES_DEVICES_HOME = path.join(tmpdir(), "explicit-devices-home");
    assert.equal(deviceHome(), path.join(tmpdir(), "explicit-devices-home"));
    assert.equal(deviceRegistryPath(), path.join(tmpdir(), "explicit-devices-home", "devices.json"));
  } finally {
    if (prev === undefined) delete process.env.ARES_DEVICES_HOME;
    else process.env.ARES_DEVICES_HOME = prev;
  }
});

test("the test harness has isolated the device home away from the real one", () => {
  // Guards the isolation shim itself: if this ever fails, a test run is writing
  // paired devices into the developer's actual ~/.ares.
  assert.ok(process.env.ARES_DEVICES_HOME, "ARES_DEVICES_HOME set by _isolate-home.mjs");
  assert.ok(
    !deviceRegistryPath().startsWith(path.join(os.homedir(), ".ares")),
    `device registry must not point at the real home: ${deviceRegistryPath()}`,
  );
});

test("an explicit home still wins over the machine default", async () => {
  const dir = await home();
  const { device } = pairedDevice();
  await saveDeviceRegistry(dir, registryWith(device));
  assert.equal((await loadDeviceRegistry(dir)).devices.length, 1);
  // ...and did not leak into the default location.
  assert.equal((await loadDeviceRegistry()).devices.length, 0);
});
