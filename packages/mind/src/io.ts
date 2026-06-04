// Crash-safe filesystem IO for the mind. Mind owns this so the memory layer has
// zero dependency on packages above it — the foundational layer reaches up to
// nothing.

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Write via a temp file + atomic rename, so a crash mid-write never corrupts. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}
