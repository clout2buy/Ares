// Nightly encrypted backup of the state that cannot be regenerated, and the
// matching restore. Used by the garrison's housekeeping hook and by
// scripts/elite/restore.mjs.
//
// What goes in: everything under the Ares home except bulky or derived trees
// (BACKUP_EXCLUDE: browser profile, checkpoint blobs, wire logs, screenshots,
// media, rollouts the kernel already holds, logs...), plus a consistent copy of
// each workspace's session-kernel SQLite (VACUUM INTO via the live store, never
// a raw copy of a database being written). If the plain size would pass the
// cap the backup FAILS loudly rather than silently leaving things out.
//
// Format (one file per day, ares-<date>.arcbak, beside a plain manifest.json):
//   "ARESBK01" | 12-byte IV | AES-256-GCM( gzip( entries... ) ) | 16-byte tag
//   entry = u32be headerLen | header JSON {p,size,mode,mtimeMs} | bytes | sha256(bytes)
//   the stream ends with a header {end:true,entries:N}
// Every entry carries its own SHA-256, the whole blob's SHA-256 is in the
// manifest, and GCM authenticates the lot: a flipped bit anywhere is caught by
// verify before restore writes a byte.
//
// Key: ~/backups/ares/.backup.key (0600, random 32 bytes, base64), or
// ARES_BACKUP_KEY. The key is NOT inside the home it protects; offsite copies
// of the .arcbak are useless without it (see docs/OPS-HEALTH.md).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const MAGIC = Buffer.from("ARESBK01");
const IV_LEN = 12;
const TAG_LEN = 16;
const HEAD_LEN = MAGIC.length + IV_LEN;
const MAX_HEADER = 64 * 1024;

export const BACKUP_EXCLUDE = new Set([
  "browser-profile", "checkpoints", "wire-log", "screenshots", "media", "snapshots", "tmp", "logs", "crashes", "tool-results",
  "dropped", "backups", "housekeeping", "system", "compactions", "vectors.db", "vectors.json", "mcp-tools-cache.json",
]);
const EXCLUDE_ANYWHERE = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".cache", "filmstrip", "Cache", "GPUCache"]);
const EXCLUDE_RELATIVE = [/^garrison\/sessions(\/|$)/, /^operator\/browser(\/|$)/, /^assistant-eval-/, /^agents\/.*\/transcript\.jsonl$/];
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface BackupEntryHeader {
  p: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  host: string;
  homeName: string;
  entries: number;
  plainBytes: number;
  blob: { name: string; size: number; sha256: string };
  keyId: string;
  kernels: string[];
  skipped: Array<{ p: string; reason: string }>;
}

export interface BackupStatus {
  lastAttemptAt?: string;
  lastOkAt?: string;
  ok: boolean;
  error?: string;
  lastDir?: string;
  bytes?: number;
  entries?: number;
  count: number;
  /** No successful backup in 36 hours. */
  stale: boolean;
  offsite?: { ok: boolean; at: string; error?: string };
}

export function backupRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARES_BACKUP_DIR || path.join(os.homedir(), "backups", "ares");
}

export const dateKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// ─── Key ────────────────────────────────────────────────────────────────

export async function loadKey(root: string, opts: { create: boolean; env?: NodeJS.ProcessEnv }): Promise<Buffer> {
  const env = opts.env ?? process.env;
  if (env.ARES_BACKUP_KEY) {
    const key = Buffer.from(env.ARES_BACKUP_KEY.trim(), "base64");
    if (key.length !== 32) throw new Error("ARES_BACKUP_KEY must be 32 bytes, base64 encoded");
    return key;
  }
  const file = path.join(root, ".backup.key");
  try {
    const key = Buffer.from((await fs.readFile(file, "utf8")).trim(), "base64");
    if (key.length === 32) return key;
    throw new Error(`${file} is not a 32-byte base64 key`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    if (!opts.create) throw new Error(`no backup key at ${file}`);
  }
  const key = randomBytes(32);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  return key;
}

export const keyId = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

// ─── Selecting what to back up ──────────────────────────────────────────

export interface Picked {
  abs: string;
  p: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

export async function pickHomeFiles(home: string): Promise<{ files: Picked[]; skipped: Array<{ p: string; reason: string }> }> {
  const files: Picked[] = [];
  const skipped: Array<{ p: string; reason: string }> = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && BACKUP_EXCLUDE.has(e.name)) continue;
      if (EXCLUDE_ANYWHERE.has(e.name) || EXCLUDE_RELATIVE.some((re) => re.test(r))) continue;
      if (e.name.includes(".tmp") || e.name.endsWith(".lock") || /\.(sock|pid)$/.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await walk(abs, r);
      } else if (e.isFile()) {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) continue;
        if (st.size > MAX_FILE_BYTES) {
          skipped.push({ p: r, reason: `larger than ${MAX_FILE_BYTES / 1_048_576} MB` });
          continue;
        }
        files.push({ abs, p: `home/${r}`, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
      }
    }
  };
  await walk(home, "");
  return { files, skipped };
}

// ─── Writing ────────────────────────────────────────────────────────────

async function* entryStream(files: Picked[], tally: { entries: number; bytes: number; skipped: Array<{ p: string; reason: string }> }): AsyncGenerator<Buffer> {
  for (const f of files) {
    let fh: import("node:fs/promises").FileHandle | undefined;
    try {
      fh = await fs.open(f.abs, "r");
      const st = await fh.stat();
      // A file that changes under us is read as far as its size at open time; the per-entry hash covers what was written.
      const header = Buffer.from(JSON.stringify({ p: f.p, size: st.size, mode: f.mode, mtimeMs: st.mtimeMs } satisfies BackupEntryHeader), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(header.length);
      yield len;
      yield header;
      const hash = createHash("sha256");
      let remaining = st.size;
      const buf = Buffer.allocUnsafe(256 * 1024);
      while (remaining > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, remaining), null);
        if (bytesRead === 0) {
          // Truncated while reading: pad with zeros so the framing stays valid; the sha256 below records what we wrote.
          const pad = Buffer.alloc(remaining);
          hash.update(pad);
          yield pad;
          tally.skipped.push({ p: f.p, reason: "file shrank while being read" });
          remaining = 0;
          break;
        }
        const chunk = Buffer.from(buf.subarray(0, bytesRead));
        hash.update(chunk);
        remaining -= bytesRead;
        yield chunk;
      }
      yield hash.digest();
      tally.entries += 1;
      tally.bytes += st.size;
    } catch (err) {
      // An unreadable file must not corrupt the framing mid-entry; it can only fail before the header was yielded.
      if (fh === undefined) {
        tally.skipped.push({ p: f.p, reason: `unreadable: ${(err as Error).message.slice(0, 80)}` });
        continue;
      }
      throw err;
    } finally {
      await fh?.close().catch(() => {});
    }
  }
  const end = Buffer.from(JSON.stringify({ end: true, entries: tally.entries }), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(end.length);
  yield len;
  yield end;
}

export async function writeArchive(outFile: string, key: Buffer, files: Picked[]): Promise<{ entries: number; plainBytes: number; skipped: Array<{ p: string; reason: string }>; size: number; sha256: string }> {
  const tally = { entries: 0, bytes: 0, skipped: [] as Array<{ p: string; reason: string }> };
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const out = createWriteStream(outFile, { mode: 0o600 });
  const blobHash = createHash("sha256");
  let size = 0;
  const put = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      blobHash.update(chunk);
      size += chunk.length;
      out.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
  await put(Buffer.concat([MAGIC, iv]));
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      put(chunk).then(() => cb(), cb);
    },
    final(cb) {
      put(cipher.getAuthTag()).then(() => cb(), cb);
    },
  });
  try {
    await pipeline(Readable.from(entryStream(files, tally), { objectMode: false }), createGzip({ level: 6 }), cipher, sink);
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fs.rm(outFile, { force: true });
    throw err;
  }
  return { entries: tally.entries, plainBytes: tally.bytes, skipped: tally.skipped, size, sha256: blobHash.digest("hex") };
}

// ─── Reading ────────────────────────────────────────────────────────────

class ChunkReader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Buffer>;
  constructor(src: AsyncIterable<Buffer>) {
    this.it = src[Symbol.asyncIterator]();
  }
  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length === 0 ? Buffer.from(r.value) : Buffer.concat([this.buf, r.value]);
    }
  }
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    if (this.buf.length < n) throw new Error("archive ended unexpectedly");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Stream n bytes to `onChunk` without holding them. */
  async pump(n: number, onChunk: (c: Buffer) => Promise<void> | void): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(1);
      if (this.buf.length === 0) throw new Error("archive ended unexpectedly");
      const take = Math.min(left, this.buf.length);
      const piece = this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
      await onChunk(piece);
    }
  }
}

async function decryptStream(file: string, key: Buffer): Promise<{ plain: AsyncIterable<Buffer>; size: number }> {
  const st = await fs.stat(file);
  if (st.size < HEAD_LEN + TAG_LEN) throw new Error("not a backup file (too small)");
  const fh = await fs.open(file, "r");
  let head: Buffer;
  let tag: Buffer;
  try {
    head = Buffer.alloc(HEAD_LEN);
    await fh.read(head, 0, HEAD_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, st.size - TAG_LEN);
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not an Ares backup (bad magic)");
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const body = createReadStream(file, { start: HEAD_LEN, end: st.size - TAG_LEN - 1 });
  const gunzip = createGunzip();
  body.on("error", (e) => gunzip.destroy(e));
  decipher.on("error", (e) => gunzip.destroy(e));
  gunzip.on("close", () => body.destroy());
  body.pipe(decipher).pipe(gunzip);
  return { plain: gunzip, size: st.size };
}

export interface ArchiveWalkOptions {
  /** Called per entry with its header and a pump for the content. Must consume exactly the bytes via `pump`. */
  onEntry?: (h: BackupEntryHeader, pump: (sink: (c: Buffer) => Promise<void> | void) => Promise<void>) => Promise<void>;
}

/** Walk and verify an archive. Throws on any integrity failure. */
export async function walkArchive(file: string, key: Buffer, opts: ArchiveWalkOptions = {}): Promise<{ entries: number; plainBytes: number; paths: string[] }> {
  const { plain } = await decryptStream(file, key);
  const reader = new ChunkReader(plain);
  let entries = 0;
  let plainBytes = 0;
  const paths: string[] = [];
  try {
    for (;;) {
      const len = (await reader.read(4)).readUInt32BE(0);
      if (len === 0 || len > MAX_HEADER) throw new Error("corrupt entry header");
      const header = JSON.parse((await reader.read(len)).toString("utf8")) as BackupEntryHeader & { end?: boolean; entries?: number };
      if (header.end) {
        if (header.entries !== entries) throw new Error(`entry count mismatch (${header.entries} recorded, ${entries} read)`);
        break;
      }
      if (typeof header.p !== "string" || !Number.isInteger(header.size) || header.size < 0) throw new Error("corrupt entry header");
      const hash = createHash("sha256");
      let consumed = 0;
      const pump = async (sink: (c: Buffer) => Promise<void> | void): Promise<void> => {
        await reader.pump(header.size - consumed, async (c) => {
          hash.update(c);
          consumed += c.length;
          await sink(c);
        });
      };
      if (opts.onEntry) await opts.onEntry(header, pump);
      if (consumed < header.size) await pump(() => undefined);
      const trailer = await reader.read(32);
      if (!hash.digest().equals(trailer)) throw new Error(`checksum mismatch in ${header.p}`);
      entries += 1;
      plainBytes += header.size;
      paths.push(header.p);
    }
    // Drain so the GCM tag is verified by the decipher's final().
    for (;;) {
      try {
        await reader.read(1);
      } catch (err) {
        if (err instanceof Error && err.message === "archive ended unexpectedly") break;
        throw err;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unable to authenticate|auth|incorrect header check|unexpected end of file|invalid (stored|distance|code|block)/i.test(msg)) throw new Error("wrong key or the backup was modified (authentication failed)");
    throw err;
  }
  return { entries, plainBytes, paths };
}

export async function verifyBackup(file: string, key: Buffer, manifest?: BackupManifest): Promise<{ ok: boolean; entries: number; plainBytes: number; error?: string }> {
  try {
    if (manifest) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== manifest.blob.sha256) throw new Error("file checksum differs from the manifest");
      if (keyId(key) !== manifest.keyId) throw new Error("this is not the key the backup was made with");
    }
    const r = await walkArchive(file, key);
    if (manifest && r.entries !== manifest.entries) throw new Error(`manifest says ${manifest.entries} entries, archive has ${r.entries}`);
    return { ok: true, entries: r.entries, plainBytes: r.plainBytes };
  } catch (err) {
    return { ok: false, entries: 0, plainBytes: 0, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

// ─── Running a backup ───────────────────────────────────────────────────

export interface BackupOptions {
  home: string;
  workspaces?: string[];
  root?: string;
  now?: () => number;
  /** Consistent copy of one workspace's session-kernel DB to `dest` (must not exist). Absent = copy db + wal files. */
  snapshotKernel?: (workspace: string, dest: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  maxPlainBytes?: number;
  retention?: { daily: number; weekly: number };
  log?: (line: string) => void;
}

export interface BackupResult {
  ok: boolean;
  dir?: string;
  file?: string;
  entries?: number;
  plainBytes?: number;
  size?: number;
  pruned: string[];
  error?: string;
}

export async function runBackup(opts: BackupOptions): Promise<BackupResult> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? backupRoot(env);
  const now = opts.now ?? Date.now;
  const scratch = path.join(root, `.scratch-${process.pid}`);
  const attemptAt = new Date(now()).toISOString();
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const key = await loadKey(root, { create: true, env });
    const picked = await pickHomeFiles(opts.home);
    const files = [...picked.files];
    const kernels: string[] = [];
    await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
    let i = 0;
    for (const ws of opts.workspaces ?? []) {
      const db = path.join(ws, ".ares", "session-kernel.sqlite");
      if (!(await fs.stat(db).catch(() => null))) continue;
      const tag = `${i++}-${path.basename(ws) || "ws"}`.replace(/[^A-Za-z0-9._-]/g, "_");
      const copy = path.join(scratch, `${tag}.sqlite`);
      if (opts.snapshotKernel && (await opts.snapshotKernel(ws, copy).catch(() => false))) {
        const st = await fs.stat(copy);
        files.push({ abs: copy, p: `kernel/${tag}.sqlite`, size: st.size, mode: 0o600, mtimeMs: st.mtimeMs });
        kernels.push(`${tag}.sqlite`);
      } else {
        // No live store to ask: SQLite recovers a db + its WAL copied together, so take both.
        for (const suffix of ["", "-wal"]) {
          const src = db + suffix;
          const dst = path.join(scratch, `${tag}.sqlite${suffix}`);
          if (await fs.copyFile(src, dst).then(() => true, () => false)) {
            const st = await fs.stat(dst);
            files.push({ abs: dst, p: `kernel/${tag}.sqlite${suffix}`, size: st.size, mode: 0o600, mtimeMs: st.mtimeMs });
          }
        }
        kernels.push(`${tag}.sqlite`);
      }
    }
    const planned = files.reduce((n, f) => n + f.size, 0);
    const cap = opts.maxPlainBytes ?? (Number(env.ARES_BACKUP_MAX_MB) || 1024) * 1_048_576;
    if (planned > cap) throw new Error(`state is ${Math.round(planned / 1_048_576)} MB, over the ${Math.round(cap / 1_048_576)} MB backup cap (raise ARES_BACKUP_MAX_MB)`);

    const day = dateKey(now());
    const dir = path.join(root, day);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `ares-${day}.arcbak`;
    const file = path.join(dir, name);
    const tmp = `${file}.partial`;
    const written = await writeArchive(tmp, key, files);
    await fs.rename(tmp, file);
    const manifest: BackupManifest = {
      format: 1,
      createdAt: attemptAt,
      host: os.hostname(),
      homeName: path.basename(opts.home),
      entries: written.entries,
      plainBytes: written.plainBytes,
      blob: { name, size: written.size, sha256: written.sha256 },
      keyId: keyId(key),
      kernels,
      skipped: [...picked.skipped, ...written.skipped].slice(0, 50),
    };
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    // Prove it before we trust it: a backup nobody has verified is a hope.
    const check = await verifyBackup(file, key, manifest);
    if (!check.ok) {
      await fs.rm(dir, { recursive: true, force: true });
      throw new Error(`verification failed: ${check.error}`);
    }
    const pruned = await pruneBackups(root, now(), opts.retention);
    let offsite: BackupStatus["offsite"];
    const offDir = env.ARES_BACKUP_OFFSITE_DIR;
    if (offDir) {
      try {
        await fs.mkdir(path.join(offDir, day), { recursive: true });
        await fs.copyFile(file, path.join(offDir, day, name));
        await fs.copyFile(path.join(dir, "manifest.json"), path.join(offDir, day, "manifest.json"));
        offsite = { ok: true, at: new Date(now()).toISOString() };
      } catch (err) {
        offsite = { ok: false, at: new Date(now()).toISOString(), error: (err as Error).message.slice(0, 120) };
      }
    }
    await writeStatus(root, { ok: true, lastAttemptAt: attemptAt, lastOkAt: attemptAt, lastDir: day, bytes: written.size, entries: written.entries, ...(offsite ? { offsite } : {}) });
    opts.log?.(`backup: ${written.entries} files, ${(written.size / 1_048_576).toFixed(1)} MB encrypted -> ${day}`);
    return { ok: true, dir, file, entries: written.entries, plainBytes: written.plainBytes, size: written.size, pruned };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 240);
    await writeStatus(root, { ok: false, lastAttemptAt: attemptAt, error }).catch(() => {});
    opts.log?.(`backup: FAILED: ${error}`);
    return { ok: false, pruned: [], error };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Retention and status ───────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoWeekKey(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3); // the Thursday of this ISO week
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Which of the dated dirs to KEEP: the newest `daily`, plus the newest of each of the `weekly` older ISO weeks. Pure. */
export function retentionKeep(days: string[], retention = { daily: 7, weekly: 4 }): Set<string> {
  const sorted = [...days].sort().reverse();
  const keep = new Set(sorted.slice(0, retention.daily));
  const weeks = new Set<string>();
  for (const day of sorted.slice(retention.daily)) {
    const wk = isoWeekKey(day);
    if (weeks.has(wk)) continue;
    if (weeks.size >= retention.weekly) break;
    weeks.add(wk);
    keep.add(day);
  }
  return keep;
}

/** Delete dated backup dirs beyond retention. Only `YYYY-MM-DD` dirs that contain a manifest are ever removed. */
export async function pruneBackups(root: string, _now = Date.now(), retention = { daily: 7, weekly: 4 }): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const days: string[] = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink() && DAY_RE.test(e.name) && (await fs.stat(path.join(root, e.name, "manifest.json")).catch(() => null))) days.push(e.name);
  }
  const keep = retentionKeep(days, retention);
  const pruned: string[] = [];
  for (const day of days) {
    if (keep.has(day)) continue;
    await fs.rm(path.join(root, day), { recursive: true, force: true });
    pruned.push(day);
  }
  return pruned;
}

async function writeStatus(root: string, patch: Partial<BackupStatus> & { ok: boolean }): Promise<void> {
  const file = path.join(root, "status.json");
  let prev: Partial<BackupStatus> = {};
  try {
    prev = JSON.parse(await fs.readFile(file, "utf8")) as Partial<BackupStatus>;
  } catch {
    // first run
  }
  const next = { ...prev, ...patch };
  if (patch.ok) delete next.error;
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

export async function readBackupStatus(root: string, now = Date.now()): Promise<BackupStatus | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, "status.json"), "utf8")) as Partial<BackupStatus>;
    const dirs = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && DAY_RE.test(e.name)).length;
    const lastOk = raw.lastOkAt ? Date.parse(raw.lastOkAt) : NaN;
    return { ok: raw.ok !== false, ...raw, count: dirs, stale: !Number.isFinite(lastOk) || now - lastOk > 36 * 3_600_000 } as BackupStatus;
  } catch {
    return undefined;
  }
}

/** True when tonight's backup has not run and the local hour is at or past `hour`. */
export async function backupDue(root: string, now: number, hour = 3): Promise<boolean> {
  if (new Date(now).getHours() < hour) return false;
  const status = await readBackupStatus(root, now);
  if (status?.lastOkAt && dateKey(Date.parse(status.lastOkAt)) === dateKey(now)) return false;
  // A failed attempt is retried at most hourly.
  if (status && !status.ok && status.lastAttemptAt && now - Date.parse(status.lastAttemptAt) < 3_600_000) return false;
  return true;
}

// ─── Restore ────────────────────────────────────────────────────────────

export interface RestoreOptions {
  /** A dated backup dir, the .arcbak itself, or the backup root (newest wins). */
  from: string;
  /** Destination Ares home. */
  to: string;
  key: Buffer;
  dryRun?: boolean;
  force?: boolean;
  /** Where kernel DBs go; default <to>/restored-kernel. */
  kernelTo?: string;
}

export interface RestoreReport {
  ok: boolean;
  dryRun: boolean;
  archive: string;
  entries: number;
  plainBytes: number;
  wrote: number;
  conflicts: string[];
  kernels: string[];
  error?: string;
}

export async function resolveArchive(from: string): Promise<{ file: string; manifest?: BackupManifest }> {
  const st = await fs.stat(from);
  let file = from;
  let dir = path.dirname(from);
  if (st.isDirectory()) {
    dir = from;
    let names = await fs.readdir(from);
    if (!names.some((n) => n.endsWith(".arcbak"))) {
      const days = names.filter((n) => DAY_RE.test(n)).sort();
      const newest = days[days.length - 1];
      if (!newest) throw new Error(`no backups under ${from}`);
      dir = path.join(from, newest);
      names = await fs.readdir(dir);
    }
    const blob = names.filter((n) => n.endsWith(".arcbak")).sort().pop();
    if (!blob) throw new Error(`no .arcbak in ${dir}`);
    file = path.join(dir, blob);
  }
  let manifest: BackupManifest | undefined;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as BackupManifest;
  } catch {
    // restoring a lone file is allowed; GCM still authenticates it
  }
  return { file, manifest };
}

function safeRelative(p: string): string | null {
  const norm = path.posix.normalize(p);
  if (norm.startsWith("/") || norm === ".." || norm.startsWith("../") || norm.includes("\0")) return null;
  return norm;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestoreReport> {
  const dryRun = opts.dryRun === true;
  const { file, manifest } = await resolveArchive(opts.from);
  const report: RestoreReport = { ok: false, dryRun, archive: file, entries: 0, plainBytes: 0, wrote: 0, conflicts: [], kernels: [] };
  try {
    // Pass 1: nothing is written until the whole archive has authenticated and every checksum matched.
    const verified = await verifyBackup(file, opts.key, manifest);
    if (!verified.ok) throw new Error(verified.error);
    report.entries = verified.entries;
    report.plainBytes = verified.plainBytes;
    const kernelDir = opts.kernelTo ?? path.join(opts.to, "restored-kernel");
    // Pass 2: place files (or, in a dry run, only decide).
    await walkArchive(file, opts.key, {
      onEntry: async (h, pump) => {
        const rel = safeRelative(h.p);
        if (!rel) throw new Error(`unsafe path in archive: ${JSON.stringify(h.p).slice(0, 80)}`);
        let dest: string;
        if (rel.startsWith("home/")) dest = path.join(opts.to, ...rel.slice(5).split("/"));
        else if (rel.startsWith("kernel/")) {
          dest = path.join(kernelDir, ...rel.slice(7).split("/"));
          if (rel.endsWith(".sqlite")) report.kernels.push(dest);
        } else throw new Error(`unknown entry kind: ${rel.split("/")[0]}`);
        const exists = await fs.lstat(dest).then(() => true, () => false);
        if (exists && !opts.force) report.conflicts.push(dest);
        if (dryRun || (exists && !opts.force)) return;
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const part = `${dest}.restore-${process.pid}`;
        const out = createWriteStream(part, { mode: h.mode & 0o777 || 0o600 });
        await pump((c) => new Promise<void>((resolve, reject) => out.write(c, (e) => (e ? reject(e) : resolve()))));
        await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
        await fs.rename(part, dest);
        report.wrote += 1;
      },
    });
    report.ok = report.conflicts.length === 0 || dryRun;
    if (report.conflicts.length > 0 && !opts.force && !dryRun) report.error = `${report.conflicts.length} existing files would be overwritten; pass --force`;
    return report;
  } catch (err) {
    report.error = (err instanceof Error ? err.message : String(err)).slice(0, 240);
    return report;
  }
}
