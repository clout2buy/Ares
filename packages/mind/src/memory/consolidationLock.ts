// Cross-process locks over the memory file (core-redesign critic fix #3, and
// the issue #24 write lock).
//
// The daemon AND the garrison both run reflection over the same ~/.ares memory
// file; without a lock two processes can fire consolidate()/synthesize()
// concurrently and the second persist() clobbers the first (each rewrites the
// whole JSONL from its own in-memory map). This is the mtime-style lock the
// redesign calls for: exclusive-create a lock file beside the memory file,
// steal it only when stale, always release.
//
// Two flavours share one acquire():
//   withConsolidationLock() runs `fn` iff the lock is acquired and returns its
//     result; when another live process holds the lock it returns undefined
//     WITHOUT running fn (reflection is periodic — skipping a pass is always
//     safe; double-writing is not).
//   withFileLock() WAITS (bounded) for the lock — the persist() path needs
//     every write to land, so "skip" is not an option there.

import path from "node:path";
import { promises as fs } from "node:fs";

const DEFAULT_STALE_MS = 5 * 60_000;
/** A persist() is milliseconds of work; a lock this old belongs to a corpse. */
const WRITE_LOCK_STALE_MS = 30_000;
/** How long a writer waits for the file lock before giving up loudly. */
const WRITE_LOCK_WAIT_MS = 15_000;
/**
 * A lock whose mtime is this far in the FUTURE was written by a clock that has
 * since been corrected (or by a different machine's clock on a shared drive).
 * Measured against `now` it would never age past staleMs — a permanent
 * deadlock — so it counts as stale instead. Small enough that ordinary NTP
 * drift between a write and a read never trips it.
 */
const FUTURE_SKEW_MS = 60_000;

export interface ConsolidationLockOptions {
  /** A lock older than this is considered abandoned and stolen. */
  staleMs?: number;
  now?: Date;
}

function lockPath(memoryFile: string): string {
  return path.join(path.dirname(memoryFile), ".consolidation.lock");
}

/** The write lock sits BESIDE the memory file, named after it, so two stores
 *  in one directory (memory.jsonl + a --root override) never share a lock. */
function writeLockPath(memoryFile: string): string {
  return path.join(path.dirname(memoryFile), `.${path.basename(memoryFile)}.lock`);
}

function lockBody(now: Date): string {
  return `${process.pid} ${now.toISOString()}\n`;
}

/**
 * Exclusive-create the lock. On contention, steal ONLY when the existing lock
 * is stale — and steal with the same exclusive create, never a plain
 * writeFile: two processes that both decided the lock was stale used to both
 * "win" with writeFile (#24), which is exactly the double-writer the lock
 * exists to prevent. Stale means: older than staleMs, OR an mtime in the
 * future (clock skew — it would never age out), OR a directory at the lock
 * path (something that can never be a lock yet blocked every acquire forever).
 */
async function acquire(file: string, staleMs: number, now: Date): Promise<boolean> {
  try {
    await fs.writeFile(file, lockBody(now), { flag: "wx" });
    return true;
  } catch {
    // Lock exists — fall through to the staleness check.
  }
  try {
    const stat = await fs.stat(file);
    const age = now.getTime() - stat.mtimeMs;
    const stale = stat.isDirectory() || age >= staleMs || age < -FUTURE_SKEW_MS;
    if (!stale) return false;
    await fs.rm(file, { recursive: true, force: true });
    // Re-create exclusively: if a sibling stole it between our rm and this
    // create, their wx wins and ours throws → we did NOT acquire.
    await fs.writeFile(file, lockBody(now), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` under the cross-process consolidation lock for `memoryFile`'s
 * directory. Returns fn's result, or undefined when another process holds a
 * live lock (the pass is skipped, never queued). Errors from fn propagate;
 * the lock is released either way.
 */
export async function withConsolidationLock<T>(
  memoryFile: string,
  fn: () => Promise<T>,
  opts: ConsolidationLockOptions = {},
): Promise<T | undefined> {
  const file = lockPath(memoryFile);
  const now = opts.now ?? new Date();
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  if (!(await acquire(file, opts.staleMs ?? DEFAULT_STALE_MS, now))) return undefined;
  try {
    return await fn();
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}

export interface FileLockOptions {
  staleMs?: number;
  /** Give up (throw) after waiting this long. */
  waitMs?: number;
}

/**
 * Run `fn` holding the exclusive WRITE lock for `memoryFile`, waiting (short
 * polls) for a live holder to finish. This is what makes every persist() a
 * read-modify-write instead of a last-writer-wins (#24): 8 parallel
 * `ares mind add` each take the lock, re-read the file, merge, write, release.
 * A lock that outlives WRITE_LOCK_STALE_MS belongs to a dead process and is
 * stolen; a wait past waitMs throws rather than silently skipping the write —
 * a memory that fails to land must be LOUD, never lost.
 */
export async function withFileLock<T>(memoryFile: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const file = writeLockPath(memoryFile);
  const staleMs = opts.staleMs ?? WRITE_LOCK_STALE_MS;
  const waitMs = opts.waitMs ?? WRITE_LOCK_WAIT_MS;
  await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined);
  const deadline = Date.now() + waitMs;
  let delay = 2;
  while (!(await acquire(file, staleMs, new Date()))) {
    if (Date.now() >= deadline) {
      throw new Error(`memory write lock held too long: ${file} (another Ares process may be wedged)`);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    // Back off a little under contention; stay snappy for the common case of
    // one other writer finishing a few-millisecond persist.
    delay = Math.min(25, delay * 2);
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}
