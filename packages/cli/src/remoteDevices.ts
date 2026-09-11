// Paired devices — the persistent half of Ares Remote.
//
// RemoteAgentServer's link tokens are built for ephemeral help: one-time, ten
// minutes, bound to a hostname, twelve hours of reconnect grace, and the
// connector exits when Ares says "bye". That is the right shape for "a friend
// needs help once" and the wrong shape for "this is MY database box, be
// connected to it forever".
//
// So a paired device carries a credential instead of a link token:
//
//   enrollment link (one-time, short) -> device proves it, receives
//   {deviceId, deviceSecret} -> device stores it and authenticates with it
//   forever after, across reboots, tunnel churn and daemon restarts.
//
// The secret is stored here ONLY as a SHA-256 hash. A device registry is a
// list of permanent keys to the owner's machines; if this file leaks it must
// not be a set of working credentials. Comparison is constant-time.

import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDeviceKey, sealDeviceKey, proofFor, proofMatches } from "./remoteDeviceCrypto.js";

export const DEVICE_REGISTRY_VERSION = 1;

export interface PairedDevice {
  id: string;
  /** Owner-facing name ("Database Box"). Renameable; never an identifier. */
  name: string;
  /** Sealed device secret (device proves possession to the server). Encrypted,
   *  not hashed: see remoteDeviceCrypto.ts — the server must be able to verify
   *  an HMAC rather than receive the secret over a plain-ws LAN hop. */
  secretEnc: string;
  /** Sealed server key (server proves ITSELF to the device). Without this the
   *  device obeys whoever answers its discovery probe first, which on an
   *  elevated connector is remote SYSTEM execution for anyone on the wifi. */
  serverKeyEnc: string;
  hostname: string;
  os: string;
  addedAt: number;
  lastSeenAt?: number;
  /**
   * May this device run commands ELEVATED (Windows: the connector installed as
   * a highest-privileges task; unix: via the configured escalation)?
   *
   * Off unless the owner opts in per device at pairing time. An elevated
   * connector is a permanent remote root shell on that machine: worth having
   * deliberately, never worth acquiring by default because a flag defaulted to
   * true once.
   */
  allowElevated?: boolean;
  /** Set when the owner unpairs. Kept (not deleted) so a revoked device that
   *  keeps dialling in can be told why, and so the name isn't silently reused. */
  revokedAt?: number;
}

export interface DeviceRegistryFile {
  version: number;
  devices: PairedDevice[];
}

/** A freshly enrolled device: the ONLY time the plaintext secret exists here. */
export interface DeviceCredential {
  deviceId: string;
  /** Device -> server proof key. Lives on the device; sealed on the server. */
  deviceSecret: string;
  /** Server -> device proof key. Lives on BOTH, sealed on the server. */
  serverKey: string;
}

/**
 * Where paired devices live — MACHINE-scoped, deliberately not ARES_HOME.
 *
 * Ares has two homes in practice: the CLI's ~/.ares and the desktop app's own
 * (ARES_HOME -> %APPDATA%/Ares/home on Windows). Every other state file follows
 * ARES_HOME, and for sessions or auth that is right. For paired devices it is
 * actively wrong: a device is paired to a PHYSICAL MACHINE, not to an app
 * profile. Following ARES_HOME would mean pairing from the desktop app and then
 * having a CLI garrison refuse the same device as `unknown` while it retries
 * forever — the silent-failure shape this whole workstream exists to kill.
 *
 * ARES_DEVICES_HOME overrides, so the test harness can isolate itself the same
 * way it isolates ARES_HOME. A deliberate caller still wins.
 */
export function deviceHome(): string {
  return process.env["ARES_DEVICES_HOME"] ?? path.join(os.homedir(), ".ares");
}

export function deviceRegistryPath(home?: string): string {
  return path.join(home ?? deviceHome(), "devices.json");
}

/** Tolerant of a missing/corrupt file: a registry that fails to parse must not
 *  take the daemon down, it must read as "no devices paired yet". */
export function parseDeviceRegistry(raw: string): DeviceRegistryFile {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { version: DEVICE_REGISTRY_VERSION, devices: [] }; }
  if (!value || typeof value !== "object") return { version: DEVICE_REGISTRY_VERSION, devices: [] };
  const obj = value as Record<string, unknown>;
  const list = Array.isArray(obj["devices"]) ? obj["devices"] : [];
  const devices: PairedDevice[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const d = entry as Record<string, unknown>;
    const id = typeof d["id"] === "string" ? d["id"] : "";
    const secretEnc = typeof d["secretEnc"] === "string" ? d["secretEnc"] : "";
    const serverKeyEnc = typeof d["serverKeyEnc"] === "string" ? d["serverKeyEnc"] : "";
    // An entry without BOTH keys is not a usable device: missing secretEnc
    // means it can never authenticate, missing serverKeyEnc means the device
    // could never verify US — and a half-authenticated elevated connector is
    // exactly the thing that must not exist. Dropping beats keeping a ghost.
    if (!id || !secretEnc || !serverKeyEnc) continue;
    devices.push({
      id,
      name: typeof d["name"] === "string" && d["name"] ? d["name"] : id,
      secretEnc,
      serverKeyEnc,
      hostname: typeof d["hostname"] === "string" ? d["hostname"] : "unknown",
      os: typeof d["os"] === "string" ? d["os"] : "unknown",
      addedAt: typeof d["addedAt"] === "number" ? d["addedAt"] : 0,
      ...(typeof d["lastSeenAt"] === "number" ? { lastSeenAt: d["lastSeenAt"] } : {}),
      ...(typeof d["revokedAt"] === "number" ? { revokedAt: d["revokedAt"] } : {}),
      ...(d["allowElevated"] === true ? { allowElevated: true } : {}),
    });
  }
  return { version: DEVICE_REGISTRY_VERSION, devices };
}

export async function loadDeviceRegistry(home?: string): Promise<DeviceRegistryFile> {
  try {
    return parseDeviceRegistry(await readFile(deviceRegistryPath(home), "utf8"));
  } catch {
    return { version: DEVICE_REGISTRY_VERSION, devices: [] };
  }
}

/** Atomic write — a half-written registry would lock the owner out of every
 *  paired machine at once, and this file is rewritten on every lastSeen touch. */
export async function saveDeviceRegistry(home: string | undefined, file: DeviceRegistryFile): Promise<void> {
  const target = deviceRegistryPath(home);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...file, version: DEVICE_REGISTRY_VERSION }, null, 2), "utf8");
  await rename(tmp, target);
}

export function mintDeviceCredential(): DeviceCredential {
  return {
    // Prefixed so a value that turns up in a log is recognisable at a glance.
    deviceId: `dev_${randomBytes(8).toString("hex")}`,
    deviceSecret: randomBytes(32).toString("base64url"),
    serverKey: randomBytes(32).toString("base64url"),
  };
}

/**
 * Find the device a presented credential belongs to.
 *
 * Returns a reason rather than a bare null so the connector can be TOLD why it
 * was refused: a revoked device that reconnects forever with no explanation is
 * exactly the silent-failure class this whole workstream is about.
 */
export type DeviceAuth =
  | { ok: true; device: PairedDevice }
  | { ok: false; reason: "unknown" | "revoked" | "bad-proof" | "unreadable" };

export async function authenticateDevice(
  registry: DeviceRegistryFile,
  deviceId: string,
  serverNonce: string,
  presentedProof: string,
): Promise<DeviceAuth> {
  const device = registry.devices.find((d) => d.id === deviceId);
  if (!device) return { ok: false, reason: "unknown" };
  const secret = await openDeviceKey(device.secretEnc);
  // Sealed with a key we can no longer read (moved machine, wiped .devicekey).
  // Reported distinctly so the owner is told to re-pair rather than hunting a
  // credential bug that isn't one.
  if (!secret) return { ok: false, reason: "unreadable" };
  if (!proofMatches(proofFor(secret, serverNonce, "device"), presentedProof)) {
    return { ok: false, reason: "bad-proof" };
  }
  // Checked only AFTER the proof, so the reason code can't be used to
  // enumerate which device ids exist and which are merely revoked.
  if (device.revokedAt) return { ok: false, reason: "revoked" };
  return { ok: true, device };
}

/**
 * Our half of the handshake: prove to the DEVICE that we are its real owner.
 *
 * This is what stops an attacker who answers a discovery probe first from
 * becoming the device's server. On a connector that runs elevated, skipping it
 * would hand remote SYSTEM execution to anyone on the same network.
 */
export async function serverProofFor(device: PairedDevice, deviceNonce: string): Promise<string | null> {
  const serverKey = await openDeviceKey(device.serverKeyEnc);
  if (!serverKey) return null;
  return proofFor(serverKey, deviceNonce, "server");
}

/** Seal a freshly minted credential for storage. Null when no machine key can
 *  be established — the caller must refuse to pair rather than store plaintext. */
export async function sealCredential(
  cred: DeviceCredential,
): Promise<{ secretEnc: string; serverKeyEnc: string } | null> {
  const secretEnc = await sealDeviceKey(cred.deviceSecret);
  const serverKeyEnc = await sealDeviceKey(cred.serverKey);
  if (!secretEnc || !serverKeyEnc) return null;
  return { secretEnc, serverKeyEnc };
}

/** Names are for humans: unique, trimmed, and never allowed to be empty. */
export function uniqueDeviceName(registry: DeviceRegistryFile, wanted: string): string {
  const base = wanted.trim() || "device";
  const taken = new Set(registry.devices.filter((d) => !d.revokedAt).map((d) => d.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}
