import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    action: z.enum(["add", "update", "search", "recall", "forget", "list"]),
    scope: z.enum(["user", "project"]).default("project"),
    id: z.string().optional().describe("Memory id for update/forget."),
    category: z.string().default("General").describe("Section name, e.g. Preferences, Project, Commands."),
    content: z.string().optional().describe("Memory body for add/update."),
    tags: z.array(z.string()).default([]),
    query: z.string().optional().describe("Search query for search/recall/list filtering."),
    limit: z.number().int().positive().max(100).default(20),
  })
  .strict();

export interface MemoryItem {
  id: string;
  category: string;
  content: string;
  tags: string[];
  updatedAt: string;
}

export interface MemoryOutput {
  scope: "user" | "project";
  path: string;
  items: MemoryItem[];
  changed: boolean;
  message: string;
}

export const MemoryTool = buildTool({
  name: "Memory",
  description:
    "Read or update persistent Ares memory. Use add/update for stable preferences, project conventions, commands, or decisions worth remembering across sessions. Use search/list before writing if unsure.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Memory ${i.action} ${i.scope}`,

  async call(i, ctx): Promise<{ output: MemoryOutput; touchedFiles?: string[]; display: string }> {
    const file = memoryPath(i.scope, ctx.workspace);
    const doc = await readMemoryFile(file);
    let changed = false;
    let message = "";

    if (i.action === "add") {
      const content = requireContent(i.content, "add");
      const item: MemoryItem = {
        id: `mem_${randomUUID().slice(0, 8)}`,
        category: normalizeCategory(i.category),
        content,
        tags: normalizeTags(i.tags),
        updatedAt: new Date().toISOString(),
      };
      doc.items.push(item);
      await writeMemoryFile(file, doc.items);
      changed = true;
      message = `added ${item.id}`;
    } else if (i.action === "update") {
      const id = requireId(i.id, "update");
      const item = doc.items.find((entry) => entry.id === id);
      if (!item) throw new Error(`memory not found: ${id}`);
      item.content = requireContent(i.content, "update");
      item.category = normalizeCategory(i.category || item.category);
      item.tags = normalizeTags(i.tags.length > 0 ? i.tags : item.tags);
      item.updatedAt = new Date().toISOString();
      await writeMemoryFile(file, doc.items);
      changed = true;
      message = `updated ${id}`;
    } else if (i.action === "forget") {
      const id = requireId(i.id, "forget");
      const before = doc.items.length;
      doc.items = doc.items.filter((entry) => entry.id !== id);
      if (doc.items.length === before) throw new Error(`memory not found: ${id}`);
      await writeMemoryFile(file, doc.items);
      changed = true;
      message = `forgot ${id}`;
    } else {
      message = i.action === "recall"
        ? `recalled ${i.query ?? ""}`
        : i.action === "search"
          ? `searched ${i.query ?? ""}`
          : "listed memory";
    }

    const items = (i.action === "recall" ? recallItems(doc.items, i.query) : filterItems(doc.items, i.query)).slice(0, i.limit);
    return {
      output: { scope: i.scope, path: file, items, changed, message },
      touchedFiles: changed ? [file] : undefined,
      display: `${message}; ${items.length} item${items.length === 1 ? "" : "s"}`,
    };
  },
});

function memoryPath(scope: "user" | "project", workspace: string): string {
  if (scope === "user") {
    return path.join(process.env.ARES_HOME || path.join(os.homedir(), ".ares"), "memory.md");
  }
  return path.join(workspace, ".ares", "memory.md");
}

async function readMemoryFile(file: string): Promise<{ items: MemoryItem[] }> {
  const text = await fs.readFile(file, "utf8").catch(() => "");
  const items: MemoryItem[] = [];
  let category = "General";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      category = normalizeCategory(heading[1]);
      continue;
    }
    const item = parseMemoryLine(line, category);
    if (item) items.push(item);
  }
  return { items };
}

async function writeMemoryFile(file: string, items: readonly MemoryItem[]): Promise<void> {
  const grouped = new Map<string, MemoryItem[]>();
  for (const item of items) {
    const category = normalizeCategory(item.category);
    const list = grouped.get(category) ?? [];
    list.push({ ...item, category });
    grouped.set(category, list);
  }

  const lines = ["# Ares Memory", ""];
  for (const [category, categoryItems] of grouped) {
    lines.push(`## ${category}`);
    for (const item of categoryItems) {
      const tags = item.tags.length ? ` tags=${item.tags.join(",")}` : "";
      lines.push(`- [${item.id}] ${item.content} <!-- updated=${item.updatedAt}${tags} -->`);
    }
    lines.push("");
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join("\n"), "utf8");
}

function parseMemoryLine(line: string, category: string): MemoryItem | null {
  const match = line.match(/^\s*-\s+\[([^\]]+)]\s+(.+?)(?:\s+<!--\s*(.*?)\s*-->)?\s*$/);
  if (!match) return null;
  const meta = parseMeta(match[3] ?? "");
  return {
    id: match[1],
    category,
    content: match[2].trim(),
    tags: meta.tags ? meta.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    updatedAt: meta.updated ?? new Date(0).toISOString(),
  };
}

function parseMeta(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

function filterItems(items: readonly MemoryItem[], query?: string): MemoryItem[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((item) =>
    [item.id, item.category, item.content, ...item.tags].some((part) => part.toLowerCase().includes(q)),
  );
}

function recallItems(items: readonly MemoryItem[], query?: string): MemoryItem[] {
  const q = query?.trim().toLowerCase();
  if (!q) return [...items];
  const queryTokens = tokens(q);
  return [...items]
    .map((item) => ({ item, score: scoreItem(item, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    .map((entry) => entry.item);
}

function scoreItem(item: MemoryItem, queryTokens: Set<string>): number {
  const haystack = tokens([item.id, item.category, item.content, ...item.tags].join(" "));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 2;
    for (const candidate of haystack) {
      if (candidate.includes(token) || token.includes(candidate)) score += 0.25;
    }
  }
  return score;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []);
}

function requireId(id: string | undefined, action: string): string {
  if (!id?.trim()) throw new Error(`Memory.${action} requires id`);
  return id.trim();
}

function requireContent(content: string | undefined, action: string): string {
  if (!content?.trim()) throw new Error(`Memory.${action} requires content`);
  return content.trim();
}

function normalizeCategory(category: string): string {
  const clean = category.trim().replace(/^#+\s*/, "");
  return clean || "General";
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
