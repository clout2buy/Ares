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

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEVICE_REGISTRY_VERSION = 1;

export interface PairedDevice {
  id: string;
  /** Owner-facing name ("Database Box"). Renameable; never an identifier. */
  name: string;
  /** SHA-256 of the device secret, hex. The secret itself is never stored. */
  secretHash: string;
  hostname: string;
  os: string;
  addedAt: number;
  lastSeenAt?: number;
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
  deviceSecret: string;
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

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Constant-time compare of a presented secret against a stored hash. */
export function deviceSecretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashDeviceSecret(secret), "hex");
  let stored: Buffer;
  try { stored = Buffer.from(storedHash, "hex"); }
  catch { return false; }
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
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
    const secretHash = typeof d["secretHash"] === "string" ? d["secretHash"] : "";
    // An entry without a usable credential is not a device — dropping it is
    // better than keeping a row that can never authenticate.
    if (!id || !secretHash) continue;
    devices.push({
      id,
      name: typeof d["name"] === "string" && d["name"] ? d["name"] : id,
      secretHash,
      hostname: typeof d["hostname"] === "string" ? d["hostname"] : "unknown",
      os: typeof d["os"] === "string" ? d["os"] : "unknown",
      addedAt: typeof d["addedAt"] === "number" ? d["addedAt"] : 0,
      ...(typeof d["lastSeenAt"] === "number" ? { lastSeenAt: d["lastSeenAt"] } : {}),
      ...(typeof d["revokedAt"] === "number" ? { revokedAt: d["revokedAt"] } : {}),
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
  | { ok: false; reason: "unknown" | "revoked" | "bad-secret" };

export function authenticateDevice(
  registry: DeviceRegistryFile,
  deviceId: string,
  deviceSecret: string,
): DeviceAuth {
  const device = registry.devices.find((d) => d.id === deviceId);
  if (!device) return { ok: false, reason: "unknown" };
  // Secret is checked BEFORE revocation is reported, so a wrong guess can't be
  // used to enumerate which device ids exist and which are merely revoked.
  if (!deviceSecretMatches(deviceSecret, device.secretHash)) return { ok: false, reason: "bad-secret" };
  if (device.revokedAt) return { ok: false, reason: "revoked" };
  return { ok: true, device };
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
