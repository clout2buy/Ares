import type { AresAgentConfig } from "./config.js";
import { aresAgentHome } from "./paths.js";
import { createMemoryStore, formatRecallReminder } from "./memory/vectorStore.js";
import { embedText, lexicalEmbedding } from "./memory/embed.js";
import type { MemoryCategory, RecallResult } from "./memory/types.js";

export interface RecallOptions {
  home?: string;
  workspace: string;
  query: string;
  category?: MemoryCategory;
  config: AresAgentConfig;
  useOllama?: boolean;
}

export async function recallForTurn(opts: RecallOptions): Promise<{ results: RecallResult[]; reminder: string; usedEmbedding: "ollama" | "lexical" }> {
  if (isLowSignalRecallQuery(opts.query)) {
    return { results: [], reminder: "", usedEmbedding: "lexical" };
  }
  const home = aresAgentHome(opts.home);
  let embedding: number[];
  let usedEmbedding: "ollama" | "lexical" = "lexical";
  if (opts.useOllama) {
    try {
      embedding = await embedText(opts.query, {
        host: opts.config.slots.embed.host,
        model: opts.config.memory.embedModel,
        dimensions: opts.config.memory.dimensions,
      });
      usedEmbedding = "ollama";
    } catch {
      embedding = lexicalEmbedding(opts.query, opts.config.memory.dimensions);
    }
  } else {
    embedding = lexicalEmbedding(opts.query, opts.config.memory.dimensions);
  }
  const store = await createMemoryStore(opts.config, home);
  const results = await store.recall({
    query: opts.query,
    embedding,
    workspace: opts.workspace,
    category: opts.category,
    limit: opts.config.memory.maxResults,
  });
  return { results, reminder: formatRecallReminder(results), usedEmbedding };
}

function isLowSignalRecallQuery(query: string): boolean {
  const normalized = query.trim().toLowerCase().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
  if (!normalized) return true;
  return /^(hi|hey|hello|yo|sup|hiya|howdy|hey there|hey homie|good morning|good afternoon|good evening|what's up|whats up)$/u.test(normalized);
}
