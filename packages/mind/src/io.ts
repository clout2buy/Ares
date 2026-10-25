// Crash-safe filesystem IO for the mind. Mind owns this so the memory layer has
// zero dependency on packages above it — the foundational layer reaches up to
// nothing.

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Windows refuses to rename over a file another process has open for reading
 * (EPERM/EBUSY). Readers (a sibling `MemoryStore.open()`, a tail -f, an
 * antivirus scan) hold the memory file for milliseconds at a time, so the
 * rename is retried for this long before the write is given up as failed.
 * Surfaced by the 8-parallel-adds repro for #24: one of eight writers lost to
 * a reader that had just started loading.
 */
const RENAME_RETRY_MS = 3_000;

function isTransientRenameError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

/** Write via a temp file + atomic rename, so a crash mid-write never corrupts. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  const deadline = Date.now() + RENAME_RETRY_MS;
  let delay = 5;
  for (;;) {
    try {
      await rename(tmp, file);
      return;
    } catch (err) {
      if (!isTransientRenameError(err) || Date.now() >= deadline) {
        // Never leave the temp file behind: the content is lost either way and
        // a stray .tmp beside memory.jsonl only confuses the next reader.
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(100, delay * 2);
    }
  }
}
