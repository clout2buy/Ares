import type { AresAgentConfig } from "../config.js";

export interface EmbedOptions {
  host?: string;
  model?: string;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

export async function embedText(text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const host = opts.host ?? "http://localhost:11434";
  const model = opts.model ?? "bge-m3";
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is not available for Ollama embeddings");
  const response = await fetchImpl(`${host.replace(/\/$/, "")}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding request failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { embedding?: unknown };
  if (!Array.isArray(json.embedding)) throw new Error("Ollama embedding response did not include embedding[]");
  const vector = json.embedding.map((value) => Number(value));
  if (opts.dimensions && vector.length !== opts.dimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${opts.dimensions}, got ${vector.length}`);
  }
  return vector;
}

export function embedOptionsFromConfig(config: AresAgentConfig): EmbedOptions {
  return {
    host: config.slots.embed.host,
    model: config.slots.embed.model,
    dimensions: config.memory.dimensions,
  };
}

export function lexicalEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of text.toLowerCase().match(/[a-z0-9_:-]+/g) ?? []) {
    const idx = stableHash(token) % dimensions;
    vector[idx] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function stableHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

