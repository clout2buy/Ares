import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord } from "@crix/protocol";
import { id, nowIso, scoreText } from "./util.js";

export class MemoryStore {
  private readonly file: string;

  constructor(private readonly workspace: string) {
    this.file = path.join(workspace, ".crix", "memory", "memory.jsonl");
  }

  async remember(text: string, tags: string[] = [], scope: MemoryRecord["scope"] = "project", source?: string): Promise<MemoryRecord> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const memory: MemoryRecord = {
      id: id("mem"),
      text,
      tags,
      scope,
      source,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await appendFile(this.file, `${JSON.stringify(memory)}\n`, "utf8");
    return memory;
  }

  async all(): Promise<MemoryRecord[]> {
    try {
      const text = await readFile(this.file, "utf8");
      return text
        .split(/\r?\n/g)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MemoryRecord);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async search(query: string, limit = 8): Promise<MemoryRecord[]> {
    const memories = await this.all();
    return memories
      .map((memory) => ({ memory, score: scoreText(query, `${memory.text} ${memory.tags.join(" ")}`) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.memory);
  }

  async forget(memoryId: string, reason: string): Promise<{ removed: boolean; tombstone: MemoryRecord }> {
    const memories = await this.all();
    const remaining = memories.filter((memory) => memory.id !== memoryId);
    await mkdir(path.dirname(this.file), { recursive: true });
    const body = remaining.map((memory) => JSON.stringify(memory)).join("\n");
    await writeFile(this.file, body ? `${body}\n` : "", "utf8");
    const tombstone = await this.remember(`Forgot memory ${memoryId}: ${reason}`, ["memory", "forget"], "project", "memory_forget");
    return { removed: remaining.length !== memories.length, tombstone };
  }
}

