// Paired-device credentials and LAN rendezvous — the persistent half of Ares
// Remote. Link tokens are built for ephemeral help (one-time, 10 min, exits on
// "bye"); a device the owner keeps forever needs a credential that survives
// reboots, tunnel churn and daemon restarts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
} from "../packages/cli/dist/remoteDevices.js";
import {
  buildDiscoveryProbe,
  parseDiscoveryProbe,
  buildDiscoveryReply,
  parseDiscoveryReply,
  DiscoveryResponder,
  DISCOVERY_PORT,
} from "../packages/cli/dist/remoteRendezvous.js";

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
