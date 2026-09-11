// Enrollment and steady-state auth for paired devices.
//
// Kept out of remoteAgentServer.ts so the protocol can be unit-tested without
// standing up an HTTP server, a WebSocket and a tunnel. The server owns
// transport; this owns "who is this, and may they run commands here".
//
// TWO PHASES, and the difference is the whole point of the feature:
//
//   enrol   ONCE, against a short-lived link the owner generated. The device
//           proves nothing (it cannot yet) and receives a permanent credential.
//
//   attach  EVERY TIME AFTER, forever. Both sides prove possession by HMAC over
//           a fresh nonce; neither secret ever crosses the wire. The SERVER
//           proves itself first, because the device is about to take commands
//           that run elevated and discovery is an unauthenticated UDP reply —
//           whoever answers a probe first would otherwise own the machine.

import {
  type DeviceRegistryFile,
  type PairedDevice,
  authenticateDevice,
  mintDeviceCredential,
  sealCredential,
  serverProofFor,
  uniqueDeviceName,
} from "./remoteDevices.js";
import { mintNonce } from "./remoteDeviceCrypto.js";

/** Messages a device may send. Anything else is ignored, not answered. */
export type DeviceInbound =
  | { type: "enroll"; token: string; hostname: string; os: string; username: string; elevated?: boolean }
  | { type: "device_hello"; deviceId: string; nonce: string }
  | { type: "device_auth"; proof: string };

export interface EnrollContext {
  /** Validate the one-time pairing token; returns the owner's chosen name. */
  claimPairingToken: (token: string) => { name: string } | null;
  registry: DeviceRegistryFile;
  /** Persist after a mutation. */
  save: (registry: DeviceRegistryFile) => Promise<void>;
}

export type EnrollResult =
  | { ok: true; device: PairedDevice; reply: Record<string, unknown> }
  | { ok: false; reply: Record<string, unknown> };

/**
 * Phase 1. Trade a one-time pairing link for a permanent credential.
 *
 * The plaintext secrets exist exactly once, here, on their way to the device.
 * If sealing fails there is no safe way to continue — storing a usable
 * credential in the clear would put a permanent elevated key on disk — so the
 * enrolment is refused rather than downgraded.
 */
export async function enrollDevice(
  ctx: EnrollContext,
  msg: Extract<DeviceInbound, { type: "enroll" }>,
): Promise<EnrollResult> {
  const claim = ctx.claimPairingToken(msg.token);
  if (!claim) {
    return { ok: false, reply: { type: "error", message: "invalid or expired pairing link" } };
  }

  const cred = mintDeviceCredential();
  const sealed = await sealCredential(cred);
  if (!sealed) {
    return {
      ok: false,
      reply: {
        type: "error",
        message:
          "could not secure the device credential on this machine (no machine key) — pairing refused rather than storing it unencrypted",
      },
    };
  }

  const device: PairedDevice = {
    id: cred.deviceId,
    name: uniqueDeviceName(ctx.registry, claim.name),
    secretEnc: sealed.secretEnc,
    serverKeyEnc: sealed.serverKeyEnc,
    hostname: msg.hostname || "unknown",
    os: msg.os || "unknown",
    addedAt: Date.now(),
    lastSeenAt: Date.now(),
    // The DEVICE reports whether its install actually got elevation; the owner
    // opted in when they generated the link, but only the installer knows
    // whether it succeeded. Recording the truth beats recording the intent.
    ...(msg.elevated === true ? { allowElevated: true as const } : {}),
  };

  ctx.registry.devices.push(device);
  await ctx.save(ctx.registry);

  return {
    ok: true,
    device,
    reply: {
      type: "enrolled",
      deviceId: cred.deviceId,
      deviceSecret: cred.deviceSecret,
      serverKey: cred.serverKey,
      name: device.name,
    },
  };
}

/** Per-connection handshake state. One device, one socket, one nonce pair. */
export interface AttachState {
  serverNonce: string;
  deviceId: string;
  device: PairedDevice;
}

export type HelloResult =
  | { ok: true; state: AttachState; reply: Record<string, unknown> }
  | { ok: false; reply: Record<string, unknown> };

/**
 * Phase 2a. The device says who it is and challenges us; we answer with proof
 * and a counter-challenge.
 *
 * An unknown id gets the same shaped refusal as a bad one, and we do not say
 * which — the registry is not an oracle for "does this machine know device X".
 */
export async function handleDeviceHello(
  registry: DeviceRegistryFile,
  msg: Extract<DeviceInbound, { type: "device_hello" }>,
): Promise<HelloResult> {
  const device = registry.devices.find((d) => d.id === msg.deviceId);
  if (!device || device.revokedAt) {
    return { ok: false, reply: { type: "error", message: "this device is not paired with this machine", fatal: true } };
  }
  if (!msg.nonce || msg.nonce.length < 16) {
    // A device that challenges with a weak or absent nonce is not one of ours,
    // or is being replayed at. Either way, do not sign it.
    return { ok: false, reply: { type: "error", message: "bad challenge" } };
  }
  const proof = await serverProofFor(device, msg.nonce);
  if (!proof) {
    return {
      ok: false,
      reply: {
        type: "error",
        message: "this machine can no longer read that device's credential — re-pair it",
        fatal: true,
      },
    };
  }
  const serverNonce = mintNonce();
  return {
    ok: true,
    state: { serverNonce, deviceId: device.id, device },
    reply: { type: "server_proof", proof, nonce: serverNonce },
  };
}

export type AttachResult =
  | { ok: true; device: PairedDevice; reply: Record<string, unknown> }
  | { ok: false; reply: Record<string, unknown> };

/** Phase 2b. The device answers our challenge; now it may run commands. */
export async function handleDeviceAuth(
  ctx: Pick<EnrollContext, "registry" | "save">,
  state: AttachState,
  msg: Extract<DeviceInbound, { type: "device_auth" }>,
): Promise<AttachResult> {
  const auth = await authenticateDevice(ctx.registry, state.deviceId, state.serverNonce, msg.proof ?? "");
  if (!auth.ok) {
    // The reason is deliberately surfaced: a device retrying forever with no
    // explanation is the failure mode this whole workstream exists to remove.
    const message =
      auth.reason === "revoked"
        ? "this device was unpaired — stop and uninstall"
        : auth.reason === "unreadable"
          ? "this machine can no longer read that device's credential — re-pair it"
          : "authentication failed";
    return { ok: false, reply: { type: "error", message, reason: auth.reason, fatal: true } };
  }

  auth.device.lastSeenAt = Date.now();
  // Best-effort: losing a lastSeen timestamp must never fail an otherwise good
  // attach, and this fires on every reconnect.
  await ctx.save(ctx.registry).catch(() => {});

  return {
    ok: true,
    device: auth.device,
    reply: {
      type: "device_ready",
      deviceId: auth.device.id,
      name: auth.device.name,
      elevated: auth.device.allowElevated === true,
    },
  };
}

/** Owner action: stop trusting a device. Kept (not deleted) so the connector
 *  can be TOLD it was unpaired instead of retrying into silence forever. */
export async function revokeDevice(
  ctx: Pick<EnrollContext, "registry" | "save">,
  deviceId: string,
): Promise<PairedDevice | null> {
  const device = ctx.registry.devices.find((d) => d.id === deviceId && !d.revokedAt);
  if (!device) return null;
  device.revokedAt = Date.now();
  await ctx.save(ctx.registry);
  return device;
}

/** Owner action: rename. Names are labels, never identifiers, so this is safe
 *  at any time and never invalidates a credential. */
export async function renameDevice(
  ctx: Pick<EnrollContext, "registry" | "save">,
  deviceId: string,
  wanted: string,
): Promise<PairedDevice | null> {
  const device = ctx.registry.devices.find((d) => d.id === deviceId && !d.revokedAt);
  if (!device) return null;
  const others: DeviceRegistryFile = {
    ...ctx.registry,
    devices: ctx.registry.devices.filter((d) => d.id !== deviceId),
  };
  device.name = uniqueDeviceName(others, wanted);
  await ctx.save(ctx.registry);
  return device;
}
