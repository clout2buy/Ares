import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expandHomePath, type AresAgentConfig } from "../config.js";
import { readTextIfExists, writeFileAtomic } from "../files.js";
import { lexicalEmbedding } from "./embed.js";
import type { AddMemoryInput, MemoryCategory, MemoryEntry, MemoryStoreStatus, RecallInput, RecallResult } from "./types.js";

type DynamicImport = (specifier: string) => Promise<any>;
const dynamicImport = new Function("specifier", "return import(specifier)") as DynamicImport;
const MAX_MEMORY_CONTENT_CHARS = 1_200;
const MAX_RECALL_ITEM_CHARS = 420;

export interface MemoryStore {
  status(): MemoryStoreStatus;
  add(input: AddMemoryInput): Promise<MemoryEntry>;
  recall(input: RecallInput): Promise<RecallResult[]>;
  list(): Promise<MemoryEntry[]>;
  update(entry: MemoryEntry): Promise<void>;
}

export async function createMemoryStore(config: AresAgentConfig, home: string): Promise<MemoryStore> {
  const dbPath = expandHomePath(config.memory.dbPath, home);
  const jsonPath = expandHomePath(config.memory.jsonFallbackPath, home);
  const sqlite = await tryCreateSqliteStore(dbPath, config);
  if (sqlite) return sqlite;
  return new JsonMemoryStore(jsonPath, config);
}

async function tryCreateSqliteStore(file: string, config: AresAgentConfig): Promise<MemoryStore | null> {
  try {
    const mod = await dynamicImport("better-sqlite3");
    const Database = mod.default ?? mod;
    const db = new Database(file);
    let vectorEnabled = false;
    try {
      const sqliteVec = await dynamicImport("sqlite-vec");
      if (typeof sqliteVec.load === "function") {
        sqliteVec.load(db);
        vectorEnabled = true;
      }
    } catch {
      vectorEnabled = false;
    }
    return new SqliteMemoryStore(file, db, config, vectorEnabled);
  } catch {
    return null;
  }
}

class JsonMemoryStore implements MemoryStore {
  constructor(
    private readonly file: string,
    private readonly config: AresAgentConfig,
  ) {}

  status(): MemoryStoreStatus {
    return {
      backend: "json",
      vectorEnabled: false,
      path: this.file,
      warning: "better-sqlite3/sqlite-vec not available; using JSON vector fallback",
    };
  }

  async add(input: AddMemoryInput): Promise<MemoryEntry> {
    const entries = await this.read();
    const now = Date.now();
    const content = trimMemoryContent(input.content);
    const entry: MemoryEntry = {
      id: nextId(entries),
      category: input.category,
      workspace: input.workspace ?? null,
      content,
      source: input.source ?? "manual",
      score: input.score ?? 1,
      hits: 0,
      contradicts: 0,
      embeddingModel: input.embeddingModel ?? this.config.memory.embedModel,
      embeddingDim: input.embeddingDim ?? this.config.memory.dimensions,
      embedding: input.embedding ?? lexicalEmbedding(content, this.config.memory.dimensions),
      createdAt: now,
      updatedAt: now,
      promotedToSoul: false,
    };
    entries.push(entry);
    await this.write(entries);
    return entry;
  }

  async recall(input: RecallInput): Promise<RecallResult[]> {
    const entries = await this.read();
    const query = input.embedding ?? lexicalEmbedding(input.query, this.config.memory.dimensions);
    const results = rank(entries, query, input);
    if (results.length > 0) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const now = Date.now();
      for (const result of results) {
        const entry = byId.get(result.memory.id);
        if (!entry) continue;
        entry.hits += 1;
        entry.lastRecalledAt = now;
        entry.updatedAt = now;
      }
      await this.write(entries);
    }
    return results;
  }

  async list(): Promise<MemoryEntry[]> {
    return this.read();
  }

  async update(entry: MemoryEntry): Promise<void> {
    const entries = await this.read();
    const next = sanitizeEntry(entry);
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) entries[index] = next;
    else entries.push(next);
    await this.write(entries);
  }

  private async read(): Promise<MemoryEntry[]> {
    const raw = await readTextIfExists(this.file, 20_000_000);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as { memories?: MemoryEntry[] };
      return (parsed.memories ?? []).map(normalizeEntry).filter(Boolean) as MemoryEntry[];
    } catch {
      return [];
    }
  }

  private async write(entries: readonly MemoryEntry[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileAtomic(this.file, JSON.stringify({ version: 1, memories: entries }, null, 2) + "\n");
  }
}

class SqliteMemoryStore implements MemoryStore {
  constructor(
    private readonly file: string,
    private readonly db: any,
    private readonly config: AresAgentConfig,
    private readonly vectorEnabled: boolean,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        workspace TEXT,
        content TEXT NOT NULL,
        source TEXT,
        score REAL DEFAULT 1.0,
        hits INTEGER DEFAULT 0,
        contradicts INTEGER DEFAULT 0,
        embedding_model TEXT NOT NULL,
        embedding_dim INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER,
        promoted_to_soul INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_workspace ON memories(workspace);
      CREATE INDEX IF NOT EXISTS idx_memories_score ON memories(score DESC);
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run("version", "1");
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run("embed_model", config.memory.embedModel);
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run("embed_dim", String(config.memory.dimensions));
  }

  status(): MemoryStoreStatus {
    return { backend: "sqlite", vectorEnabled: this.vectorEnabled, path: this.file };
  }

  async add(input: AddMemoryInput): Promise<MemoryEntry> {
    const now = Date.now();
    const content = trimMemoryContent(input.content);
    const embedding = input.embedding ?? lexicalEmbedding(content, this.config.memory.dimensions);
    const info = this.db.prepare(`
      INSERT INTO memories(category, workspace, content, source, score, hits, contradicts, embedding_model, embedding_dim, embedding_json, created_at, updated_at, promoted_to_soul)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 0)
    `).run(
      input.category,
      input.workspace ?? null,
      content,
      input.source ?? "manual",
      input.score ?? 1,
      input.embeddingModel ?? this.config.memory.embedModel,
      input.embeddingDim ?? this.config.memory.dimensions,
      JSON.stringify(embedding),
      now,
      now,
    );
    return (await this.get(Number(info.lastInsertRowid)))!;
  }

  async recall(input: RecallInput): Promise<RecallResult[]> {
    const entries = await this.list();
    const query = input.embedding ?? lexicalEmbedding(input.query, this.config.memory.dimensions);
    const results = rank(entries, query, input);
    const now = Date.now();
    for (const result of results) {
      this.db.prepare("UPDATE memories SET hits = hits + 1, last_recalled_at = ?, updated_at = ? WHERE id = ?").run(now, now, result.memory.id);
    }
    return results;
  }

  async list(): Promise<MemoryEntry[]> {
    const rows = this.db.prepare("SELECT * FROM memories ORDER BY score DESC, updated_at DESC").all() as unknown[];
    return rows.map(rowToEntry);
  }

  async update(entry: MemoryEntry): Promise<void> {
    const next = sanitizeEntry(entry);
    this.db.prepare(`
      UPDATE memories
      SET category = ?, workspace = ?, content = ?, source = ?, score = ?, hits = ?, contradicts = ?,
          embedding_model = ?, embedding_dim = ?, embedding_json = ?, updated_at = ?, last_recalled_at = ?, promoted_to_soul = ?
      WHERE id = ?
    `).run(
      next.category,
      next.workspace,
      next.content,
      next.source,
      next.score,
      next.hits,
      next.contradicts,
      next.embeddingModel,
      next.embeddingDim,
      JSON.stringify(next.embedding),
      Date.now(),
      next.lastRecalledAt ?? null,
      next.promotedToSoul ? 1 : 0,
      next.id,
    );
  }

  private async get(id: number): Promise<MemoryEntry | null> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? rowToEntry(row) : null;
  }
}

function rank(entries: readonly MemoryEntry[], query: readonly number[], input: RecallInput): RecallResult[] {
  return entries
    .filter((entry) => !input.workspace || entry.workspace === input.workspace || entry.workspace === null)
    .filter((entry) => !input.category || entry.category === input.category)
    .map((memory) => ({ memory, distance: l2(query, memory.embedding) }))
    .sort((a, b) => a.distance - b.distance || b.memory.score - a.memory.score)
    .slice(0, Math.max(1, input.limit ?? 8));
}

function l2(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum + Math.abs(a.length - b.length));
}

function nextId(entries: readonly MemoryEntry[]): number {
  return entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
}

function normalizeEntry(entry: MemoryEntry): MemoryEntry | null {
  if (!entry || typeof entry !== "object" || !entry.content) return null;
  return sanitizeEntry({
    ...entry,
    category: normalizeCategory(entry.category),
    workspace: entry.workspace ?? null,
    embedding: Array.isArray(entry.embedding) ? entry.embedding.map(Number) : [],
    promotedToSoul: Boolean(entry.promotedToSoul),
  });
}

function rowToEntry(row: any): MemoryEntry {
  return {
    id: Number(row.id),
    category: normalizeCategory(row.category),
    workspace: row.workspace ?? null,
    content: trimMemoryContent(String(row.content)),
    source: row.source ?? "manual",
    score: Number(row.score ?? 1),
    hits: Number(row.hits ?? 0),
    contradicts: Number(row.contradicts ?? 0),
    embeddingModel: String(row.embedding_model),
    embeddingDim: Number(row.embedding_dim),
    embedding: JSON.parse(String(row.embedding_json ?? "[]")) as number[],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastRecalledAt: row.last_recalled_at === null || row.last_recalled_at === undefined ? undefined : Number(row.last_recalled_at),
    promotedToSoul: Boolean(row.promoted_to_soul),
  };
}

function normalizeCategory(category: string): MemoryCategory {
  if (category === "SELF" || category === "USER" || category === "PROJECT" || category === "DECISION" || category === "FEEDBACK") {
    return category;
  }
  return "PROJECT";
}

export function formatRecallReminder(results: readonly RecallResult[]): string {
  if (results.length === 0) return "";
  const lines = ["Recall surfaced these Ares memories:"];
  for (const result of results) {
    lines.push(`- [${result.memory.category}#${result.memory.id}] ${compactMemoryText(result.memory.content, MAX_RECALL_ITEM_CHARS)}`);
  }
  return lines.join("\n");
}

function sanitizeEntry(entry: MemoryEntry): MemoryEntry {
  const content = trimMemoryContent(entry.content);
  return content === entry.content ? entry : { ...entry, content };
}

function trimMemoryContent(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  return compactMemoryText(clean, MAX_MEMORY_CONTENT_CHARS);
}

function compactMemoryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const visible = Math.max(0, maxChars - 48);
  return `${text.slice(0, visible).trimEnd()} [truncated ${text.length - maxChars} chars]`;
}
