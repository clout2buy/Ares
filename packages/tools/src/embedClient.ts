// embedClient — the smallest possible embedding seam for tools.
//
// WHY this exists instead of importing @ares/mind: tools depends on protocol +
// core only, and mind depends on nothing in tools; pulling mind into tools for
// one interface + one fetch would create a dependency purely for convenience
// (and drag the living-memory store into every tool consumer). The Embedder
// contract below is intentionally identical to packages/mind/src/memory/
// embedIndex.ts so a future shared package can absorb both without a rename.

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface OllamaEmbedClientOptions {
  /** Ollama HTTP host. Default: ARES_CODESEARCH_EMBED_URL, ARES_MIND_EMBED_URL, OLLAMA_HOST, then 127.0.0.1:11434. */
  baseUrl?: string;
  /** Embedding model. Default: ARES_EMBED_MODEL or "nomic-embed-text". */
  model?: string;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export function embedModelName(): string {
  return process.env.ARES_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
}

export function embedBaseUrl(): string {
  return (
    process.env.ARES_CODESEARCH_EMBED_URL?.trim() ||
    process.env.ARES_MIND_EMBED_URL?.trim() ||
    process.env.OLLAMA_HOST?.trim() ||
    "http://127.0.0.1:11434"
  ).replace(/\/+$/, "");
}

/**
 * Local embeddings via Ollama's POST /api/embed. Throws a clean, attributable
 * error when the host is unreachable or answers malformed; CodebaseSearch's
 * budget + negative cache decide how long to stay away afterwards.
 */
export function ollamaEmbedClient(opts: OllamaEmbedClientOptions = {}): Embedder {
  const baseUrl = (opts.baseUrl ?? embedBaseUrl()).replace(/\/+$/, "");
  const model = opts.model ?? embedModelName();
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
        });
      } catch (err) {
        throw new Error(`ollama embedder unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`ollama embed failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      }
      const data = (await res.json()) as { embeddings?: unknown };
      const embeddings = data.embeddings;
      if (
        !Array.isArray(embeddings) ||
        embeddings.length !== texts.length ||
        !embeddings.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)))
      ) {
        throw new Error(`ollama embed returned a malformed response for ${texts.length} input(s)`);
      }
      return embeddings as number[][];
    },
  };
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < n; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
