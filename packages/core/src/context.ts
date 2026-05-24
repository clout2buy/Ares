import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextBundle, Message } from "@crix/protocol";
import { MemoryStore } from "./memory.js";

const IGNORE = new Set(["node_modules", "target", ".crix", ".git", "dist", "build"]);
const IMPORTANT = new Set(["package.json", "pnpm-workspace.yaml", "tsconfig.json", "README.md"]);

export class ContextBuilder {
  constructor(private readonly workspace: string, private readonly memory: MemoryStore) {}

  async build(goal: string, messages: Message[] = [], maxChars = 24_000): Promise<ContextBundle> {
    const memories = await this.memory.search(goal, 8);
    const files = await this.scanFiles(this.workspace, maxChars / 2);
    const usedChars = files.reduce((sum, file) => sum + file.summary.length, 0) + memories.reduce((sum, memory) => sum + memory.text.length, 0) + messages.reduce((sum, message) => sum + message.content.length, 0);
    return { workspace: this.workspace, goal, messages, memories, files, budget: { maxChars, usedChars } };
  }

  private async scanFiles(dir: string, budget: number): Promise<Array<{ path: string; summary: string }>> {
    const out: Array<{ path: string; summary: string }> = [];
    let used = 0;
    const visit = async (current: string, depth: number): Promise<void> => {
      if (depth > 3 || used >= budget) return;
      let entries = await readdir(current, { withFileTypes: true });
      entries = entries.sort((a, b) => Number(IMPORTANT.has(b.name)) - Number(IMPORTANT.has(a.name)) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (IGNORE.has(entry.name) || used >= budget) continue;
        const full = path.join(current, entry.name);
        const relative = path.relative(this.workspace, full);
        if (entry.isDirectory()) {
          await visit(full, depth + 1);
        } else if (entry.isFile() && shouldRead(entry.name)) {
          const info = await stat(full);
          if (info.size > 80_000) continue;
          const text = await readFile(full, "utf8").catch(() => "");
          const summary = text.slice(0, 2_000);
          used += summary.length;
          out.push({ path: relative, summary });
        }
      }
    };
    await visit(dir, 0);
    return out.slice(0, 40);
  }
}

function shouldRead(name: string): boolean {
  return IMPORTANT.has(name) || /\.(ts|tsx|js|mjs|json|md|java|toml|yaml|yml)$/i.test(name);
}

