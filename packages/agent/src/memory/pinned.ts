import { agentPaths, aresAgentHome } from "../paths.js";
import { loadAgentConfig } from "../config.js";
import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../files.js";
import { createMemoryStore } from "./vectorStore.js";
import type { MemoryCategory } from "./types.js";

export const PINNED_MEMORY_MAX_CHARS = 600;

/**
 * "Remember this" from the owner. Stored as an owner-pinned memory (deep
 * dreaming always carries those into MEMORY.md, which it rewrites wholesale)
 * and written into MEMORY.md now, so it shapes the very next turn.
 */
export async function pinOwnerMemory(opts: {
  text: string;
  category?: MemoryCategory;
  home?: string;
}): Promise<{ id: number; content: string; memoryFile: string }> {
  const content = opts.text.replace(/\s+/g, " ").trim().slice(0, PINNED_MEMORY_MAX_CHARS);
  if (!content) throw new Error("nothing to remember");
  const home = aresAgentHome(opts.home);
  const config = await loadAgentConfig(home);
  const store = await createMemoryStore(config, home);
  const category = opts.category ?? "USER";
  const entry = await store.add({ category, content, source: "owner-pinned", score: 1 });
  const paths = agentPaths(home);
  // Read whole: a capped read would truncate the file on rewrite.
  const existing = await readFile(paths.memory, "utf8").catch(() => "");
  const line = `- [${category}#${entry.id}] ${content}`;
  const body = existing.trim()
    ? `${existing.replace(/\s*$/, "")}\n${line}\n`
    : ["# Memory", "", "_(Curated long-term memory. Only DEEP dreaming writes here.)_", "", line, ""].join("\n");
  await writeFileAtomic(paths.memory, body);
  return { id: entry.id, content, memoryFile: paths.memory };
}
