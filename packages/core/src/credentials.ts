// The credential vault — ONE in-house place every tool reads its secrets from.
//
// Before this, each tool read its key straight from process.env (RESEND_API_KEY,
// STRIPE_SECRET_KEY, …). That works for a developer who exports vars, but a
// self-running operator can't ask the absent owner to set an env var mid-task.
// This stores secrets encrypted-at-rest under ~/.ares/credentials.json (the same
// AES-256-GCM-under-~/.ares/.keysecret scheme the CLI key vault uses) and resolves
// them with an env-var FALLBACK, so:
//   • the owner adds a secret ONCE (CLI / Telegram setup) and it persists, and
//   • every existing env-var setup keeps working untouched.
//
// Crypto lives here (the leaf core layer) so both @ares/tools and @ares/cli read
// from the same vault; cli/keyVault.ts re-exports encryptSecret/decryptSecret
// from this module so there is exactly one implementation.

import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";

const PREFIX = "enc:v1:";
let keyPromise: Promise<Buffer | null> | null = null;
let warnedPlaintext = false;

/** Thrown when encryption is unavailable AND the operator demanded it
 *  (ARES_REQUIRE_ENCRYPTION=1). Prevents silently writing plaintext keys. */
export class EncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`credential encryption unavailable: ${reason}. Refusing to store a plaintext secret because ARES_REQUIRE_ENCRYPTION is set.`);
    this.name = "EncryptionUnavailableError";
  }
}

/** True when the operator insists secrets must be encrypted at rest. */
function encryptionRequired(): boolean {
  const v = process.env.ARES_REQUIRE_ENCRYPTION;
  return v === "1" || v === "true" || v === "yes";
}

/** Emit a one-time, redaction-safe warning that the vault fell back to plaintext.
 *  Silent plaintext storage was the single worst finding of the security audit. */
function warnPlaintextOnce(reason: string): void {
  if (warnedPlaintext) return;
  warnedPlaintext = true;
  try {
    process.stderr.write(
      `⚠️  Ares credential vault could not create a machine secret (${reason}); secrets will be stored WITHOUT encryption at ~/.ares/credentials.json. ` +
        `Set ARES_REQUIRE_ENCRYPTION=1 to refuse plaintext storage instead.\n`,
    );
  } catch {
    // stderr unavailable — nothing more we can do
  }
}

async function secretKey(): Promise<Buffer | null> {
  keyPromise ??= (async () => {
    try {
      const file = path.join(aresHome(), ".keysecret");
      try {
        const existing = await readFile(file);
        if (existing.length >= 32) return existing.subarray(0, 32);
      } catch {
        // no secret yet — create one
      }
      const key = randomBytes(32);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, key, { mode: 0o600 });
      try {
        await chmod(file, 0o600);
      } catch {
        // chmod is a no-op on some Windows filesystems — fine
      }
      return key;
    } catch {
      return null; // can't persist a secret → caller decides (warn or hard-fail)
    }
  })();
  return keyPromise;
}

/**
 * Report whether encryption-at-rest is actually live on this machine. The daemon
 * calls this at startup so a plaintext-fallback situation is surfaced loudly
 * instead of discovered later in a leaked credentials.json.
 */
export async function probeCredentialEncryption(): Promise<{ available: boolean; reason?: string }> {
  const key = await secretKey();
  if (key) return { available: true };
  return { available: false, reason: "could not create or read ~/.ares/.keysecret" };
}

/** Encrypt a secret for storage. Idempotent: already-encrypted or empty values
 *  pass through. Falls back to plaintext if no machine secret is available. */
export async function encryptSecret(plain: string | undefined): Promise<string | undefined> {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const key = await secretKey();
  if (!key) {
    if (encryptionRequired()) throw new EncryptionUnavailableError("no machine secret");
    warnPlaintextOnce("no machine secret");
    return plain;
  }
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
  } catch {
    return plain;
  }
}

/** Decrypt a stored secret. Plaintext / non-token values pass through unchanged. */
export async function decryptSecret(token: string | undefined): Promise<string | undefined> {
  if (!token || !token.startsWith(PREFIX)) return token;
  const key = await secretKey();
  if (!key) return token;
  try {
    const raw = Buffer.from(token.slice(PREFIX.length), "base64");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return token;
  }
}

function credentialsFile(home?: string): string {
  return path.join(home ?? aresHome(), "credentials.json");
}

type CredentialMap = Record<string, string>;

async function loadMap(home?: string): Promise<CredentialMap> {
  try {
    const raw = await readFile(credentialsFile(home), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CredentialMap;
  } catch {
    // missing / unreadable / corrupt → empty vault
  }
  return {};
}

async function saveMap(map: CredentialMap, home?: string): Promise<void> {
  const file = credentialsFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
  try {
    await chmod(file, 0o600);
  } catch {
    // unsupported on some filesystems — fine
  }
}

export interface CredentialLookup {
  /** Explicit home override (tests). Defaults to the resolved Ares home. */
  home?: string;
  /** Also try these process.env names as a fallback, in order. */
  envFallback?: string[];
}

/**
 * Resolve a secret by name. Order: the encrypted vault file → process.env[name]
 * → each envFallback name → undefined. The returned value is always plaintext,
 * decrypted and trimmed; an empty value resolves to undefined.
 */
export async function getCredential(name: string, opts: CredentialLookup = {}): Promise<string | undefined> {
  const map = await loadMap(opts.home);
  if (map[name] !== undefined) {
    const value = (await decryptSecret(map[name]))?.trim();
    if (value) return value;
  }
  for (const envName of [name, ...(opts.envFallback ?? [])]) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return fromEnv;
  }
  return undefined;
}

/** Store (or overwrite) a secret, encrypted at rest. */
export async function setCredential(name: string, value: string, opts: { home?: string } = {}): Promise<void> {
  const map = await loadMap(opts.home);
  const enc = await encryptSecret(value.trim());
  if (enc === undefined) return;
  map[name] = enc;
  await saveMap(map, opts.home);
}

/** Remove a secret. Returns true if one was present. */
export async function deleteCredential(name: string, opts: { home?: string } = {}): Promise<boolean> {
  const map = await loadMap(opts.home);
  if (map[name] === undefined) return false;
  delete map[name];
  await saveMap(map, opts.home);
  return true;
}

/** Names of stored secrets — NEVER the values. Sorted for stable display. */
export async function listCredentialNames(opts: { home?: string } = {}): Promise<string[]> {
  return Object.keys(await loadMap(opts.home)).sort();
}

/** True if the named secret resolves to a non-empty value (vault or env). */
export async function hasCredential(name: string, opts: CredentialLookup = {}): Promise<boolean> {
  return (await getCredential(name, opts)) !== undefined;
}
