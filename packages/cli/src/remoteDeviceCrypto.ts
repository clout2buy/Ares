// Device credential crypto — mutual proof-of-possession, machine-scoped.
//
// WHY THIS REPLACED HASHED SECRETS
//
// The first cut stored a SHA-256 of the device secret, which is the textbook
// shape for a password: the server never needs the plaintext, it just hashes
// what it is handed and compares. That works only because the client is
// expected to TRANSMIT the secret.
//
// Two things make that wrong here. On the LAN the transport is plain ws://
// (TLS exists only when traffic happens to go through the Cloudflare tunnel),
// so a transmitted secret is readable by anyone on the same wifi — and this
// secret is permanent, not a session token. And once a paired device runs
// commands ELEVATED, the server→device direction has to be authenticated too:
// discovery is an unauthenticated UDP reply, so an attacker who answers a probe
// first becomes the device's "owner" and gets remote SYSTEM execution. The
// device must be able to verify the server before it obeys anything.
//
// Proving knowledge in both directions without transmitting anything means the
// server has to HOLD key material, not a one-way hash. So both keys are stored
// ENCRYPTED at rest (AES-256-GCM under a machine key) and used as HMAC keys:
//
//   device -> server:  HMAC(deviceSecret, serverNonce)
//   server -> device:  HMAC(serverKey,    deviceNonce)
//
// Neither secret ever crosses the wire, in either direction, ever.
//
// The trade against hashing is real and deliberate: someone who can read
// devices.json AND the key file can impersonate either side. But that attacker
// already has code execution as the owner on the machine that legitimately
// commands these devices, so the marginal loss is small — whereas leaking a
// permanent credential to every device on the wifi, on every reconnect, is not.
//
// The key file is machine-scoped alongside devices.json, NOT under ARES_HOME:
// the desktop app and a CLI garrison must decrypt the same registry, which was
// the whole point of making the registry machine-scoped in the first place.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import path from "node:path";

import { deviceHome } from "./remoteDevices.js";

const PREFIX = "encv1:";
const KEY_FILE = ".devicekey";

let keyPromise: Promise<Buffer | null> | null = null;

/** Reset memoised key state. Tests only — the key path is process-wide. */
export function _resetDeviceKeyCache(): void {
  keyPromise = null;
}

function keyPath(): string {
  return path.join(deviceHome(), KEY_FILE);
}

/**
 * The machine key, created on first use. 0600 where the platform honours it.
 *
 * Returns null rather than throwing when it cannot be created: a device
 * registry that cannot be read is a lockout from every paired machine at once,
 * so callers degrade explicitly instead of the daemon dying at import time.
 */
async function machineKey(): Promise<Buffer | null> {
  keyPromise ??= (async () => {
    const file = keyPath();
    try {
      const existing = await readFile(file);
      if (existing.length >= 32) return existing.subarray(0, 32);
    } catch {
      // not created yet — fall through and mint one
    }
    try {
      const key = randomBytes(32);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, key, { mode: 0o600 });
      try { await chmod(file, 0o600); } catch { /* windows / no-op fs */ }
      return key;
    } catch {
      return null;
    }
  })();
  return keyPromise;
}

export async function deviceKeyAvailable(): Promise<boolean> {
  return (await machineKey()) !== null;
}

/** AES-256-GCM. Returns null when no machine key can be established — callers
 *  must refuse to pair rather than silently storing a plaintext SYSTEM key. */
export async function sealDeviceKey(plain: string): Promise<string | null> {
  const key = await machineKey();
  if (!key) return null;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
  } catch {
    return null;
  }
}

export async function openDeviceKey(sealed: string | undefined): Promise<string | null> {
  if (!sealed || !sealed.startsWith(PREFIX)) return null;
  const key = await machineKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key or tampered ciphertext. Never guess — a failed open means this
    // device cannot authenticate, which is the safe direction.
    return null;
  }
}

/** A fresh challenge. 32 bytes: replayed nonces are the classic way these
 *  handshakes rot, and there is no reason to be stingy. */
export function mintNonce(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * HMAC-SHA256 proof of possession.
 *
 * The label binds a proof to its DIRECTION, so a proof captured from the server
 * can never be replayed back as a device proof (and vice versa) even though
 * both sides HMAC over the same nonce.
 */
export function proofFor(key: string, nonce: string, label: "device" | "server"): string {
  return createHmac("sha256", key).update(`${label}:${nonce}`, "utf8").digest("hex");
}

/** Constant-time proof comparison. */
export function proofMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented ?? "", "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
