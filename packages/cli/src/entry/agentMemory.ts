// Desktop agents' memory — see it, hand it over, take it with you.
//
// Owner, 2026-10-17: "they would have to still have old chat history memory,
// just request to hand memory to an agent or export it."
//
// Each agent writes into its own living-memory scope (agent:<id>) and reads
// that plus the owner's shared pool (see agentScope.ts). What this adds:
//   - list   an agent's OWN memories (what it learned, not the shared pool)
//   - hand   copy memories into an agent: everything, or just what is about a
//            topic, from Ares's main memory or from another agent. A copy, so
//            the source keeps them; tagged with where they came from.
//   - export an agent's memories to Markdown + JSON the owner can keep
//   - forget one of an agent's own memories
//
// A caller can only hand what it can itself see: Ares (the owner's main chat)
// gives from the owner pool; an agent gives from its own scope. Nobody reads
// another agent's private memories by asking.

import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryRouter, MemoryStore, OWNER_SCOPE, nodesInScope, withConsolidationLock, type MemoryNode } from "@ares/mind";
import { agentMemoryScope } from "./agentScope.js";

export const HAND_LIMIT_MAX = 1_000;
const LIST_LIMIT_MAX = 500;

export interface AgentMemoryItem {
  id: string;
  kind: string;
  content: string;
  at: string;
  tags?: string[];
  source?: string;
}

const toItem = (n: MemoryNode): AgentMemoryItem => ({
  id: n.id,
  kind: n.kind,
  content: n.content,
  at: n.at,
  ...(n.tags?.length ? { tags: [...n.tags] } : {}),
  ...(n.source ? { source: n.source } : {}),
});

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** The memories an agent formed or was handed — its own scope only, newest first. */
export async function agentMemories(memoryFile: string, agentId: string, limit = 200): Promise<{ total: number; items: AgentMemoryItem[] }> {
  const store = await MemoryStore.open(memoryFile);
  const scope = agentMemoryScope(agentId);
  const own = store.all().filter((n) => n.scope === scope).sort((a, b) => b.at.localeCompare(a.at));
  return { total: own.length, items: own.slice(0, Math.max(1, Math.min(LIST_LIMIT_MAX, limit))).map(toItem) };
}

/** "ares" = the owner's main memory; otherwise an agent id. */
function sourceScope(from: string): string {
  return from === "ares" ? OWNER_SCOPE : agentMemoryScope(from);
}

function poolOf(store: MemoryStore, from: string): MemoryNode[] {
  const scope = sourceScope(from);
  return from === "ares"
    ? [...nodesInScope(store.all(), OWNER_SCOPE)]
    : store.all().filter((n) => n.scope === scope);
}

/**
 * Copy memories into an agent. `about` narrows it to what recalls for that
 * topic (the same association recall a turn uses, without reinforcing it);
 * absent = everything in the source, newest first, up to `limit`.
 */
export async function handMemories(
  memoryFile: string,
  opts: { from: string; to: string; about?: string; limit?: number; fromName?: string },
): Promise<{ copied: number; skipped: number; considered: number }> {
  if (opts.from === opts.to) throw new Error("that agent already has its own memories");
  const limit = Math.max(1, Math.min(HAND_LIMIT_MAX, opts.limit ?? HAND_LIMIT_MAX));
  const toScope = agentMemoryScope(opts.to);
  const result = await withConsolidationLock(memoryFile, async () => {
    const store = await MemoryStore.open(memoryFile);
    let picked: MemoryNode[];
    const about = opts.about?.trim();
    if (about) {
      const scope = sourceScope(opts.from);
      const hits = store.peek(about, { scope, limit });
      // peek() over a non-isolated scope also returns unscoped owner nodes;
      // an agent source must hand only what is its own.
      picked = hits.map((h) => h.node).filter((n) => (opts.from === "ares" ? true : n.scope === scope));
    } else {
      picked = poolOf(store, opts.from).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    }
    const already = new Set(store.all().filter((n) => n.scope === toScope).map((n) => norm(n.content)));
    const fresh = picked.filter((n) => {
      const key = norm(n.content);
      if (!key || already.has(key)) return false;
      already.add(key);
      return true;
    });
    const tag = `handed-from:${opts.from}`;
    const report = fresh.length
      ? await new MemoryRouter(store).write(
          "manual",
          fresh.map((n) => ({
            kind: n.kind,
            content: n.content,
            tags: [...new Set([...(n.tags ?? []), tag])],
            source: n.source ?? `handed:${opts.fromName ?? opts.from}`,
            scope: toScope,
          })),
        )
      : { written: [], skipped: [] };
    return { copied: report.written.length, skipped: picked.length - report.written.length, considered: picked.length };
  });
  if (!result) throw new Error("memory is busy (another Ares process is consolidating it) — try again in a moment");
  return result;
}

/** Forget one of an agent's own memories (never the shared pool from here). */
export async function forgetAgentMemory(memoryFile: string, agentId: string, memoryId: string): Promise<boolean> {
  const scope = agentMemoryScope(agentId);
  const done = await withConsolidationLock(memoryFile, async () => {
    const store = await MemoryStore.open(memoryFile);
    const node = store.all().find((n) => n.id === memoryId);
    if (!node || node.scope !== scope) return false;
    return store.forget(memoryId);
  });
  if (done === null || done === undefined) throw new Error("memory is busy — try again in a moment");
  return done;
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

/** Write an agent's memories to <dir>/<Name>-memory-<date>.{md,json}. */
export async function exportAgentMemory(
  memoryFile: string,
  agent: { id: string; name: string; instructions?: string },
  dir: string,
  now = new Date(),
): Promise<{ markdown: string; json: string; count: number }> {
  const { items } = await agentMemories(memoryFile, agent.id, LIST_LIMIT_MAX);
  const all = items.length >= LIST_LIMIT_MAX
    ? (await MemoryStore.open(memoryFile)).all().filter((n) => n.scope === agentMemoryScope(agent.id)).sort((a, b) => b.at.localeCompare(a.at)).map(toItem)
    : items;
  await fs.mkdir(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  const base = path.join(dir, `${safeName(agent.name)}-memory-${stamp}`);
  const byKind = new Map<string, AgentMemoryItem[]>();
  for (const m of all) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
  const label: Record<string, string> = { semantic: "What they know", procedural: "How they do things", episodic: "What happened" };
  const md = [
    `# ${agent.name} — memory`,
    "",
    `Exported ${now.toISOString()} · ${all.length} memor${all.length === 1 ? "y" : "ies"} of their own (the shared memory with Ares is not included).`,
    ...(agent.instructions?.trim() ? ["", `> ${agent.instructions.trim().replace(/\n/g, "\n> ")}`] : []),
    ...[...byKind.entries()].flatMap(([kind, list]) => [
      "",
      `## ${label[kind] ?? kind}`,
      "",
      ...list.map((m) => `- ${m.content.replace(/\s+/g, " ").trim()}  _(${m.at.slice(0, 10)}${m.tags?.find((t) => t.startsWith("handed-from:")) ? ", handed over" : ""})_`),
    ]),
    "",
  ].join("\n");
  await fs.writeFile(`${base}.md`, md, "utf8");
  await fs.writeFile(`${base}.json`, JSON.stringify({ agent: { id: agent.id, name: agent.name }, exportedAt: now.toISOString(), memories: all }, null, 2) + "\n", "utf8");
  return { markdown: `${base}.md`, json: `${base}.json`, count: all.length };
}
