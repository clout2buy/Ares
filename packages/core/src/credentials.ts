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

import { mkdir, readFile, writeFile, chmod, rename, copyFile, stat, unlink } from "node:fs/promises";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import path from "node:path";
import { aresHome } from "./providers/openaiAuth.js";

const PREFIX = "enc:v1:";
let keyPromise: Promise<Buffer | null> | null = null;
let warnedPlaintext = false;
let warnedUndecryptable = false;
/** Vault files already copied aside this process — one .corrupt copy per
 *  process, not one per getCredential call (tools poll the vault constantly). */
const quarantined = new Set<string>();

/** Thrown when ~/.ares/.keysecret exists but cannot be a key (wrong length).
 *  Issue #27: a 16-byte .keysecret used to be silently REPLACED by a fresh
 *  random key, which orphaned every ciphertext in the vault for good. The key
 *  is the only way back into those secrets, so a damaged one is never
 *  overwritten — the owner restores it from backup or deletes it on purpose. */
export class KeySecretCorruptError extends Error {
  constructor(file: string, length: number) {
    super(
      `credential machine secret ${file} is ${length} bytes (need 32). Refusing to regenerate it: every secret in credentials.json was encrypted with the original key. ` +
        `Restore the file from a backup, or delete it yourself if the vault is empty.`,
    );
    this.name = "KeySecretCorruptError";
  }
}

/** Thrown when credentials.json exists but is not a JSON object. The bad bytes
 *  are copied to `credentials.json.corrupt-<timestamp>` first and the original
 *  is left in place, so nothing is lost; writers refuse until it is fixed. */
export class CredentialVaultCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly copy: string | undefined,
    cause: unknown,
  ) {
    super(
      `credential vault ${file} is unreadable (${cause instanceof Error ? cause.message : String(cause)}). ` +
        (copy ? `A copy was saved to ${copy}. ` : "") +
        `Refusing to write until it is repaired or removed — overwriting it would delete every stored secret.`,
    );
    this.name = "CredentialVaultCorruptError";
  }
}

/** Thrown when the vault lock could not be taken within the retry window. */
export class CredentialVaultLockedError extends Error {
  constructor(lock: string) {
    super(`credential vault is locked by another writer (${lock}) — timed out waiting for it`);
    this.name = "CredentialVaultLockedError";
  }
}

function warnOnce(line: string): void {
  try {
    process.stderr.write(line.endsWith("\n") ? line : line + "\n");
  } catch {
    // stderr unavailable — nothing more we can do
  }
}

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

/** Read the key file. Null when it does not exist; throws KeySecretCorruptError
 *  when it exists but is too short to have ever been a key. (>= 32 is kept, not
 *  === 32, because that is what every existing install was written against.) */
async function readKeyFile(file: string): Promise<Buffer | null> {
  let existing: Buffer;
  try {
    existing = await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (existing.length >= 32) return existing.subarray(0, 32);
  throw new KeySecretCorruptError(file, existing.length);
}

async function secretKey(): Promise<Buffer | null> {
  keyPromise ??= (async () => {
    const file = path.join(aresHome(), ".keysecret");
    try {
      const existing = await readKeyFile(file);
      if (existing) return existing;
      const key = randomBytes(32);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        // 'wx' = O_EXCL: two first-run processes (daemon + CLI setup racing on a
        // fresh machine) used to each write their own key; whichever landed
        // second won the file and the other's secrets were unreadable forever.
        await writeFile(file, key, { mode: 0o600, flag: "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // Lost the race — the other process's key is the key.
        const theirs = await readKeyFile(file);
        if (theirs) return theirs;
        throw err;
      }
      try {
        await chmod(file, 0o600);
      } catch {
        // chmod is a no-op on some Windows filesystems — fine
      }
      return key;
    } catch (err) {
      if (err instanceof KeySecretCorruptError) throw err; // a damaged key is loud, never replaced
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
  let key: Buffer | null;
  try {
    key = await secretKey();
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
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

/** Decrypt a stored secret. Plaintext / non-token values pass through unchanged.
 *  A token that cannot be decrypted (no key, damaged key, GCM tag mismatch)
 *  resolves to undefined — it used to come back as the raw `enc:v1:…` string,
 *  which tools then sent to Stripe/Resend as if it were the API key (#27). */
export async function decryptSecret(token: string | undefined): Promise<string | undefined> {
  if (!token || !token.startsWith(PREFIX)) return token;
  let reason = "no machine secret";
  try {
    const key = await secretKey();
    if (key) {
      const raw = Buffer.from(token.slice(PREFIX.length), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const ct = raw.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    }
  } catch (err) {
    reason = err instanceof KeySecretCorruptError ? err.message : "the machine secret does not match this ciphertext";
  }
  if (!warnedUndecryptable) {
    warnedUndecryptable = true;
    warnOnce(`⚠️  Ares credential vault: a stored secret could not be decrypted (${reason}); it resolves as unset rather than as ciphertext.`);
  }
  return undefined;
}

function credentialsFile(home?: string): string {
  return path.join(home ?? aresHome(), "credentials.json");
}

type CredentialMap = Record<string, string>;

/**
 * Read the vault. ONLY a missing file is an empty vault. Anything else that
 * fails is thrown: #27 found that a credentials.json truncated to 40 bytes
 * (a crashed editor, a half-synced drive) read as `{}`, and the very next
 * setCredential wrote that `{}` back — every other OAuth and MCP token gone,
 * no error, no backup. Before throwing, the bad bytes are copied aside as
 * credentials.json.corrupt-<timestamp> so the owner (or a repair) can get
 * them back; the original is NOT moved, so a human can still see the state.
 */
async function loadMap(home?: string): Promise<CredentialMap> {
  const file = credentialsFile(home);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err; // EACCES/EIO: a vault we cannot read is not an empty vault
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as CredentialMap;
    throw new Error("not a JSON object");
  } catch (cause) {
    let copy: string | undefined;
    if (!quarantined.has(file)) {
      quarantined.add(file);
      copy = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        await copyFile(file, copy);
      } catch {
        copy = undefined; // could not quarantine; the original is still there
      }
      warnOnce(`⚠️  Ares credential vault ${file} is unreadable${copy ? `; copied to ${copy}` : ""}. Writes are refused until it is repaired.`);
    }
    throw new CredentialVaultCorruptError(file, copy, cause);
  }
}

/** Reads treat a corrupt vault as empty (it was already quarantined and
 *  logged); only WRITES refuse, since a write is what destroys it. */
async function loadMapForRead(home?: string): Promise<CredentialMap> {
  try {
    return await loadMap(home);
  } catch (err) {
    if (err instanceof CredentialVaultCorruptError) return {};
    throw err;
  }
}

const LOCK_RETRY_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/**
 * Run `fn` holding the vault's lock file. setCredential was a bare
 * read-modify-rename; eight parallel calls (every MCP server storing its
 * token on first connect) each read the same map, so the last rename won and
 * one credential of eight survived. The lock is `credentials.json.lock`,
 * created with 'wx' (O_EXCL, atomic on every filesystem we ship to), retried
 * with a short backoff, and treated as stale — a writer that died holding it —
 * after LOCK_STALE_MS. The atomic tmp+rename inside is kept: the lock orders
 * writers, the rename keeps readers from ever seeing a half-written file.
 */
async function withVaultLock<T>(home: string | undefined, fn: () => Promise<T>): Promise<T> {
  const file = credentialsFile(home);
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_RETRY_MS;
  let delay = 5;
  for (;;) {
    try {
      await writeFile(lock, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(lock); // dead holder; the next loop pass takes it
          continue;
        }
      } catch {
        // lock vanished between our attempts — just retry
        continue;
      }
      if (Date.now() > deadline) throw new CredentialVaultLockedError(lock);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 50);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      await unlink(lock);
    } catch {
      // already gone (stale-reaped by a waiter) — fine
    }
  }
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
  const map = await loadMapForRead(opts.home);
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

/** Store (or overwrite) a secret, encrypted at rest. Throws
 *  CredentialVaultCorruptError (vault unparseable — never overwritten) or
 *  KeySecretCorruptError (damaged key — never regenerated). */
export async function setCredential(name: string, value: string, opts: { home?: string } = {}): Promise<void> {
  const enc = await encryptSecret(value.trim());
  if (enc === undefined) return;
  // Read → modify → write all under the lock, so a concurrent writer's entry
  // is in the map we write back.
  await withVaultLock(opts.home, async () => {
    const map = await loadMap(opts.home);
    map[name] = enc;
    await saveMap(map, opts.home);
  });
}

/** Remove a secret. Returns true if one was present. */
export async function deleteCredential(name: string, opts: { home?: string } = {}): Promise<boolean> {
  return withVaultLock(opts.home, async () => {
    const map = await loadMap(opts.home);
    if (map[name] === undefined) return false;
    delete map[name];
    await saveMap(map, opts.home);
    return true;
  });
}

/** Names of stored secrets — NEVER the values. Sorted for stable display. */
export async function listCredentialNames(opts: { home?: string } = {}): Promise<string[]> {
  return Object.keys(await loadMapForRead(opts.home)).sort();
}

/** True if the named secret resolves to a non-empty value (vault or env). */
export async function hasCredential(name: string, opts: CredentialLookup = {}): Promise<boolean> {
  return (await getCredential(name, opts)) !== undefined;
}
