// `ares mind tidy` — the one-shot migration for a MEMORY.md written before
// curated memory was typed facts (see @ares/mind curated.ts for the field
// evidence). Identical entries collapse to one; raw "User asked:" quotes move
// out to today's daily log, where conversation history belongs; every other
// entry is re-rendered as `- [type] fact`. The original is copied beside the
// daily logs first, so a tidy is always reversible. --dry-run reports only.

import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { tidyCuratedMemory } from "@ares/mind";
import { agentPaths, aresAgentHome } from "../paths.js";
import { writeFileAtomic } from "../files.js";

export interface TidyMemoryResult {
  memoryFile: string;
  /** False when MEMORY.md does not exist. */
  found: boolean;
  changed: boolean;
  dryRun: boolean;
  kept: number;
  deduped: number;
  /** Raw quotes moved (or, on a dry run, that would move) to the daily log. */
  movedQuotes: number;
  /** Where the quotes went / the pre-tidy copy was saved (not on a dry run). */
  dailyLog?: string;
  backup?: string;
}

export async function tidyMemoryFile(opts: { home?: string; dryRun?: boolean; now?: Date } = {}): Promise<TidyMemoryResult> {
  const home = aresAgentHome(opts.home);
  const paths = agentPaths(home);
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const text = await readFile(paths.memory, "utf8").catch(() => null);
  if (text === null) return { memoryFile: paths.memory, found: false, changed: false, dryRun, kept: 0, deduped: 0, movedQuotes: 0 };
  const report = tidyCuratedMemory(text);
  const base = { memoryFile: paths.memory, found: true, changed: report.changed, dryRun, kept: report.kept, deduped: report.deduped, movedQuotes: report.quotes.length };
  if (dryRun || !report.changed) return base;
  const day = now.toISOString().slice(0, 10);
  await mkdir(paths.memoryDir, { recursive: true });
  const backup = path.join(paths.memoryDir, `MEMORY.before-tidy-${now.toISOString().replace(/[:.]/g, "-")}.md`);
  await copyFile(paths.memory, backup);
  const dailyLog = path.join(paths.memoryDir, `${day}.md`);
  if (report.quotes.length > 0) {
    await appendFile(dailyLog, ["", "## Moved from MEMORY.md by `ares mind tidy` (chat lines, not facts)", ...report.quotes.map((q) => `- ${q}`), ""].join("\n"), "utf8");
  }
  await writeFileAtomic(paths.memory, report.text);
  return { ...base, backup, ...(report.quotes.length > 0 ? { dailyLog } : {}) };
}
