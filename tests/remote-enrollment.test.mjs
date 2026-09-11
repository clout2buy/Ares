// Enrollment and steady-state auth for a permanently paired device.
//
// The goal is "download Ares Remote on the laptop, connect it to my agent, and
// it runs the admin commands instead of me" -- so the credential has to survive
// reboots, and the device has to be able to tell its real owner from anyone
// else on the network before it obeys an elevated command.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enrollDevice,
  handleDeviceHello,
  handleDeviceAuth,
  revokeDevice,
  renameDevice,
} from "../packages/cli/dist/remoteEnrollment.js";
import { proofFor, mintNonce, proofMatches } from "../packages/cli/dist/remoteDeviceCrypto.js";

function freshCtx({ name = "Laptop DB" } = {}) {
  const registry = { version: 1, devices: [] };
  const saved = [];
  let validToken = "tok-good";
  return {
    registry,
    saved,
    save: async (r) => { saved.push(JSON.parse(JSON.stringify(r))); },
    claimPairingToken: (t) => (t === validToken ? { name } : null),
    burnToken: () => { validToken = "__used__"; },
  };
}

/** Full enrol -> attach, the way the connector does it. */
async function enrolAndAttach(ctx, opts = {}) {
  const enrolled = await enrollDevice(ctx, {
    type: "enroll",
    token: "tok-good",
    hostname: "MIKE-LAPTOP",
    os: "Windows 11",
    username: "mike",
    ...opts,
  });
  assert.equal(enrolled.ok, true, "enrolment succeeded");
  const cred = enrolled.reply;

  const deviceNonce = mintNonce();
  const hello = await handleDeviceHello(ctx.registry, {
    type: "device_hello",
    deviceId: cred.deviceId,
    nonce: deviceNonce,
  });
  assert.equal(hello.ok, true, "hello accepted");

  return { cred, deviceNonce, hello };
}

// ─── enrolment ─────────────────────────────────────────────────────────────

test("a valid pairing link yields a permanent credential and registers the device", async () => {
  const ctx = freshCtx();
  const res = await enrollDevice(ctx, {
    type: "enroll", token: "tok-good", hostname: "MIKE-LAPTOP", os: "Windows 11", username: "mike",
  });

  assert.equal(res.ok, true);
  assert.equal(res.reply.type, "enrolled");
  assert.match(res.reply.deviceId, /^dev_[0-9a-f]{16}$/);
  assert.ok(res.reply.deviceSecret, "device secret returned exactly once");
  assert.ok(res.reply.serverKey, "server key returned so the device can verify US");
  assert.equal(ctx.registry.devices.length, 1);
  assert.equal(ctx.saved.length, 1, "persisted immediately — a reboot must not lose the pairing");
});

test("an invalid or expired pairing link enrols nothing", async () => {
  const ctx = freshCtx();
  const res = await enrollDevice(ctx, {
    type: "enroll", token: "nope", hostname: "X", os: "Windows", username: "x",
  });
  assert.equal(res.ok, false);
  assert.equal(ctx.registry.devices.length, 0);
  assert.equal(ctx.saved.length, 0, "nothing persisted on a refused enrolment");
});

test("the registry stores neither secret in the clear", async () => {
  const ctx = freshCtx();
  const res = await enrollDevice(ctx, {
    type: "enroll", token: "tok-good", hostname: "MIKE-LAPTOP", os: "Windows 11", username: "mike",
  });
  const onDisk = JSON.stringify(ctx.registry);
  assert.ok(!onDisk.includes(res.reply.deviceSecret), "device secret sealed");
  assert.ok(!onDisk.includes(res.reply.serverKey), "server key sealed");
});

test("elevation is recorded from what the INSTALL achieved, not what was hoped", async () => {
  const plain = freshCtx();
  await enrollDevice(plain, { type: "enroll", token: "tok-good", hostname: "H", os: "Windows", username: "u" });
  assert.notEqual(plain.registry.devices[0].allowElevated, true, "absent means not elevated");

  const elevated = freshCtx();
  await enrollDevice(elevated, { type: "enroll", token: "tok-good", hostname: "H", os: "Windows", username: "u", elevated: true });
  assert.equal(elevated.registry.devices[0].allowElevated, true);
});

test("two devices enrolled with the same label get distinguishable names", async () => {
  const ctx = freshCtx();
  await enrollDevice(ctx, { type: "enroll", token: "tok-good", hostname: "A", os: "Windows", username: "u" });
  await enrollDevice(ctx, { type: "enroll", token: "tok-good", hostname: "B", os: "Windows", username: "u" });
  const names = ctx.registry.devices.map((d) => d.name);
  assert.notEqual(names[0], names[1], `names must differ: ${names.join(", ")}`);
});

// ─── attach: mutual proof ──────────────────────────────────────────────────

test("a paired device attaches, and the server proves itself first", async () => {
  const ctx = freshCtx();
  const { cred, deviceNonce, hello } = await enrolAndAttach(ctx);

  // The DEVICE verifies us before obeying anything. This is what stops an
  // attacker who answered the discovery probe from owning an elevated box.
  assert.equal(hello.reply.type, "server_proof");
  assert.ok(
    proofMatches(proofFor(cred.serverKey, deviceNonce, "server"), hello.reply.proof),
    "server proof verifies under the device's copy of the server key",
  );

  const auth = await handleDeviceAuth(ctx, hello.state, {
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, hello.reply.nonce, "device"),
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.reply.type, "device_ready");
  assert.equal(auth.reply.name, "Laptop DB");
});

test("an impostor server cannot produce the proof the device demands", async () => {
  const ctx = freshCtx();
  const { cred, deviceNonce, hello } = await enrolAndAttach(ctx);
  const impostor = proofFor("key-the-attacker-guessed", deviceNonce, "server");
  assert.ok(!proofMatches(hello.reply.proof, impostor));
  assert.ok(!proofMatches(proofFor(cred.serverKey, deviceNonce, "server"), impostor));
});

test("a wrong device proof is refused", async () => {
  const ctx = freshCtx();
  const { hello } = await enrolAndAttach(ctx);
  const auth = await handleDeviceAuth(ctx, hello.state, { type: "device_auth", proof: "garbage" });
  assert.equal(auth.ok, false);
  assert.equal(auth.reply.reason, "bad-proof");
});

test("a proof from an earlier session does not replay", async () => {
  const ctx = freshCtx();
  const { cred, hello } = await enrolAndAttach(ctx);
  const captured = proofFor(cred.deviceSecret, mintNonce(), "device"); // different nonce
  const auth = await handleDeviceAuth(ctx, hello.state, { type: "device_auth", proof: captured });
  assert.equal(auth.ok, false);
});

test("a weak or missing challenge is never signed", async () => {
  const ctx = freshCtx();
  const enrolled = await enrollDevice(ctx, {
    type: "enroll", token: "tok-good", hostname: "H", os: "Windows", username: "u",
  });
  for (const nonce of ["", "short", undefined]) {
    const hello = await handleDeviceHello(ctx.registry, {
      type: "device_hello", deviceId: enrolled.reply.deviceId, nonce,
    });
    assert.equal(hello.ok, false, `nonce ${JSON.stringify(nonce)} must not be signed`);
  }
});

test("an unknown device is refused fatally, so it stops rather than looping", async () => {
  const ctx = freshCtx();
  const hello = await handleDeviceHello(ctx.registry, {
    type: "device_hello", deviceId: "dev_0000000000000000", nonce: mintNonce(),
  });
  assert.equal(hello.ok, false);
  assert.equal(hello.reply.fatal, true, "the connector must be told to give up, not retry forever");
});

test("attaching refreshes lastSeen, and a save failure does not break the attach", async () => {
  const ctx = freshCtx();
  const { cred, hello } = await enrolAndAttach(ctx);
  ctx.save = async () => { throw new Error("disk full"); };

  const auth = await handleDeviceAuth(ctx, hello.state, {
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, hello.reply.nonce, "device"),
  });
  assert.equal(auth.ok, true, "a bookkeeping write must never cost the connection");
  assert.ok(ctx.registry.devices[0].lastSeenAt > 0);
});

// ─── owner actions ─────────────────────────────────────────────────────────

test("unpairing refuses the device AND tells it why", async () => {
  const ctx = freshCtx();
  const { cred, hello } = await enrolAndAttach(ctx);
  assert.ok(await revokeDevice(ctx, cred.deviceId));

  const auth = await handleDeviceAuth(ctx, hello.state, {
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, hello.reply.nonce, "device"),
  });
  assert.equal(auth.ok, false);
  assert.equal(auth.reply.reason, "revoked");
  assert.match(auth.reply.message, /unpaired/);
  assert.equal(auth.reply.fatal, true, "a revoked connector must stop, not retry forever");
});

test("a revoked device cannot even start the handshake again", async () => {
  const ctx = freshCtx();
  const { cred } = await enrolAndAttach(ctx);
  await revokeDevice(ctx, cred.deviceId);
  const hello = await handleDeviceHello(ctx.registry, {
    type: "device_hello", deviceId: cred.deviceId, nonce: mintNonce(),
  });
  assert.equal(hello.ok, false);
});

test("unpairing twice is not an error", async () => {
  const ctx = freshCtx();
  const { cred } = await enrolAndAttach(ctx);
  assert.ok(await revokeDevice(ctx, cred.deviceId));
  assert.equal(await revokeDevice(ctx, cred.deviceId), null);
});

test("renaming keeps the credential working", async () => {
  const ctx = freshCtx();
  const { cred, hello } = await enrolAndAttach(ctx);
  const renamed = await renameDevice(ctx, cred.deviceId, "Database Box");
  assert.equal(renamed.name, "Database Box");

  const auth = await handleDeviceAuth(ctx, hello.state, {
    type: "device_auth",
    proof: proofFor(cred.deviceSecret, hello.reply.nonce, "device"),
  });
  assert.equal(auth.ok, true, "a name is a label, never an identifier");
  assert.equal(auth.reply.name, "Database Box");
});

test("renaming to its own name is a no-op, not a collision", async () => {
  const ctx = freshCtx();
  const { cred } = await enrolAndAttach(ctx);
  const renamed = await renameDevice(ctx, cred.deviceId, "Laptop DB");
  assert.equal(renamed.name, "Laptop DB", "must not become 'Laptop DB 2'");
});
