// CodebaseSearch — ranked search over workspace chunks: TF-IDF always, with
// an optional embedding sidecar for hybrid (meaning-aware) ranking.
//
// Ranker honesty: the lexical core is term-frequency / inverse-document-frequency
// over 40-line chunks. When a local embedder (Ollama /api/embed) is reachable
// the tool also keeps a chunk-level vector sidecar at
// <workspace>/.ares/index/chunks.vec.jsonl and blends cosine similarity with
// the lexical score (0.6 / 0.4). Every output states which ranker produced it:
// `ranker: "tfidf"` (no vectors were usable) or `ranker: "hybrid"`.
//
// The sidecar is refreshed lazily and incrementally: only chunks whose content
// hash is missing get embedded, most-lexically-relevant first, and never past
// ARES_CODESEARCH_EMBED_BUDGET_MS per search (default 1500). A batch that
// overruns the budget keeps running in the background and lands in the
// sidecar for the NEXT search; the current search ranks whatever it has.
// Unembedded chunks fall back to their TF-IDF score, so a cold repo degrades to
// today's behavior rather than to nothing.
//
// The symbol index (packages/core symbolIndex.ts) rides along: the top name
// matches for the query's tokens are returned as `symbols`, so "where is auth
// handled" surfaces `authenticate()` next to the chunk hits.
//
// Tool description copies the GOOD/BAD QUERY pattern Cursor uses, so the model
// learns to phrase queries as full questions, not keywords.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  buildSymbolIndex,
  querySymbols,
  type SymbolIndex,
  type SymbolMatch,
} from "@ares/core";
import { buildTool, resolveWorkspacePath } from "./_shared.js";
import { cosineSimilarity, embedModelName, ollamaEmbedClient, type Embedder } from "./embedClient.js";

export interface CodebaseSearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  /** Present on hybrid results: the cosine similarity that fed the blend. */
  cosine?: number;
}

export interface CodebaseSearchSymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine?: number;
  container?: string;
  signature: string;
}

export interface CodebaseSearchEmbeddingStats {
  model: string;
  /** Chunks that had a vector when ranking ran. */
  vectors: number;
  /** Chunks embedded during this call (within budget). */
  embeddedNow: number;
  /** Chunks still lacking a vector after this call. */
  pending: number;
  budgetMs: number;
  budgetExhausted: boolean;
  error?: string;
}

export interface CodebaseSearchOutput {
  query: string;
  hits: CodebaseSearchHit[];
  symbols: CodebaseSearchSymbolHit[];
  ranker: "tfidf" | "hybrid";
  embedding?: CodebaseSearchEmbeddingStats;
  filesScanned: number;
  chunksRanked: number;
  durationMs: number;
}

const inputSchema = z
  .object({
    query: z
      .string()
      .min(3)
      .describe(
        "A natural-language question — NOT a keyword. Phrase as you'd ask a colleague.",
      ),
    target_directories: z
      .array(z.string())
      .default([])
      .describe(
        "Optional list of subdirectories to scope the search. Empty array = whole workspace.",
      ),
    max_results: z.number().int().positive().max(50).default(10),
  })
  .strict();

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  ".pnpm-store",
  ".ares",
  "coverage",
  ".turbo",
  ".cache",
]);

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".swift",
  ".m",
  ".mm",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".lua",
  ".sh",
  ".ps1",
  ".sql",
  ".md",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
]);

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;
// Large generated artifacts are ignored by directory rules, but real product
// entrypoints routinely exceed 256 KiB (Ares' desktop App.tsx did). Excluding
// them made repository search silently blind to a central ownership surface.
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const HYBRID_COSINE_WEIGHT = 0.6;
const HYBRID_TFIDF_WEIGHT = 0.4;
const SYMBOL_HITS = 5;

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** Per-search wall-clock cap on embedding work. 0 disables embedding for the call. */
export function embedBudgetMs(): number {
  return envInt("ARES_CODESEARCH_EMBED_BUDGET_MS", 1500);
}
/** Chunks per /api/embed request. */
function embedBatchSize(): number {
  return Math.max(1, envInt("ARES_CODESEARCH_EMBED_BATCH", 32));
}
/** After an embedder failure, how long to run pure TF-IDF before probing again. */
function embedRetryMs(): number {
  return envInt("ARES_CODESEARCH_EMBED_RETRY_MS", 60_000);
}
/** How long a symbol index may be reused across searches in one process. */
function symbolMemoMs(): number {
  return envInt("ARES_SYMBOL_INDEX_MEMO_MS", 3_000);
}
function embeddingEnabled(): boolean {
  return process.env.ARES_CODESEARCH_EMBED !== "0";
}

// ─── Embedder injection (tests) ────────────────────────────────────────

let embedderOverride: Embedder | null | undefined;
const embedderFailures = new Map<string, number>();

/**
 * Replace the embedder for this process (tests pass a fake; `null` forces the
 * pure-TF-IDF path; `undefined` restores the Ollama default). Also clears the
 * negative cache so a fresh fake is used immediately.
 */
export function setCodebaseSearchEmbedder(embedder: Embedder | null | undefined): void {
  embedderOverride = embedder;
  embedderFailures.clear();
}

function resolveEmbedder(): Embedder | null {
  if (embedderOverride === null) return null;
  if (embedderOverride) return embedderOverride;
  if (!embeddingEnabled()) return null;
  return ollamaEmbedClient();
}

export const CodebaseSearchTool = buildTool({
  name: "CodebaseSearch",
  description: `Ranked search over the workspace. Lexical core (token/TF-IDF overlap); when a local embedding model is reachable (Ollama, ARES_EMBED_MODEL) results are HYBRID (0.6 cosine + 0.4 TF-IDF) and can surface paraphrases/synonyms — the output's \`ranker\` field says which one ran ("tfidf" = keyword-only, may miss synonyms; "hybrid" = meaning-aware). Also returns \`symbols\`: top declarations whose NAMES match the query's words (every language, regex symbol index). For exact strings prefer Grep.

WHEN TO USE:
- "How does X work?" / "Where is Y handled?" / "Show me Z usage"
- Exploring unfamiliar code
- Finding the right entry point before reading whole files

WHEN NOT TO USE:
- Exact text matches → use Grep
- Filename patterns → use Glob
- Known specific file → use Read

QUERY GUIDANCE (this matters):
Good queries are complete questions phrased like you'd ask a colleague:
  ✓ "Where is user authentication implemented in the frontend?"
  ✓ "How do we handle file upload progress?"
  ✓ "What happens when the API rate-limits us?"

Bad queries:
  ✗ "auth"                    → too vague, use Grep for keywords
  ✗ "AuthService"             → single symbol, use Grep or LSP workspace_symbol
  ✗ "What is X? How does Y?"  → two questions, run two searches in parallel

SEARCH STRATEGY:
1. Start broad with target_directories=[] (whole repo).
2. If results point to a directory, rerun with target_directories=["src/foo/"] to drill in.
3. Break complex questions into focused parallel sub-searches.

Pair CodebaseSearch with Task(researcher) when the investigation needs many follow-up reads — the researcher subagent will use CodebaseSearch itself and return a summary, keeping YOUR context clean.`,
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Searching the codebase for ${truncate(i.query, 60)}`,

  async call(i, ctx): Promise<{ output: CodebaseSearchOutput; display: string }> {
    const t0 = Date.now();
    // Confine every target_directories entry to the workspace (or an explicitly
    // granted out-of-workspace path), same as Grep/Glob/Read. Previously this
    // path.resolve'd straight off ctx.workspace with no guard — the one read tool
    // that could be steered to read ../../etc with a "../" target.
    const dirs = i.target_directories ?? [];
    const roots =
      dirs.length > 0
        ? await Promise.all(dirs.map((d) => resolveWorkspacePath(ctx, d, "target_directories", "read")))
        : [ctx.workspace];
    const maxResults = i.max_results ?? 10;

    // 1. Tokenize query.
    const queryTokens = tokenize(i.query);
    if (queryTokens.length === 0) {
      return {
        output: { query: i.query, hits: [], symbols: [], ranker: "tfidf", filesScanned: 0, chunksRanked: 0, durationMs: 0 },
        display: "no tokens in query",
      };
    }

    // 2. Walk + chunk.
    const allChunks: Chunk[] = [];
    let filesScanned = 0;
    for (const root of roots) {
      await walk(root, async (file) => {
        const ext = path.extname(file).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) return;
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || stat.size > MAX_FILE_BYTES) return;
        filesScanned++;
        const cached = chunkCache.get(file);
        // Skip the read entirely when mtime+size are unchanged.
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          for (const c of cached.chunks) allChunks.push(c);
          return;
        }
        const content = await fs.readFile(file, "utf8").catch(() => "");
        if (!content) return;
        for (const c of chunksForFile(file, content, stat.mtimeMs, stat.size)) allChunks.push(c);
      });
    }

    // 3. Lexical score for every chunk.
    const df = computeDocFrequency(allChunks, queryTokens);
    const totalChunks = allChunks.length;
    const lexical = allChunks.map((c) => tfIdfScore(c, queryTokens, df, totalChunks));

    // 4. Optional hybrid pass: query vector + chunk vectors from the sidecar.
    const hybrid = await hybridScores(ctx.workspace, i.query, allChunks, lexical, t0);

    const maxLex = Math.max(0, ...lexical);
    const scored: { idx: number; score: number; cosine?: number }[] = [];
    for (let k = 0; k < allChunks.length; k++) {
      const lexNorm = maxLex > 0 ? lexical[k] / maxLex : 0;
      const cos = hybrid?.cosNorm.get(k);
      if (cos === undefined) {
        if (lexical[k] > 0) scored.push({ idx: k, score: lexNorm });
        continue;
      }
      scored.push({
        idx: k,
        score: HYBRID_COSINE_WEIGHT * cos + HYBRID_TFIDF_WEIGHT * lexNorm,
        cosine: hybrid!.cosRaw.get(k),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter((s) => s.score > 0).slice(0, maxResults);

    const hits: CodebaseSearchHit[] = top.map(({ idx, score, cosine }) => {
      const chunk = allChunks[idx];
      const hit: CodebaseSearchHit = {
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: Math.round(score * 1000) / 1000,
        snippet: chunk.text.length > 600 ? chunk.text.slice(0, 600) + "\n…" : chunk.text,
      };
      if (cosine !== undefined) hit.cosine = Math.round(cosine * 1000) / 1000;
      return hit;
    });

    // 5. Symbol hits by name for each query token.
    const symbols = await symbolHits(ctx.workspace, queryTokens, roots);

    const ranker: CodebaseSearchOutput["ranker"] = hybrid && hybrid.cosNorm.size > 0 ? "hybrid" : "tfidf";
    const output: CodebaseSearchOutput = {
      query: i.query,
      hits,
      symbols,
      ranker,
      filesScanned,
      chunksRanked: totalChunks,
      durationMs: Date.now() - t0,
    };
    if (hybrid) output.embedding = hybrid.stats;
    return {
      output,
      display: `${hits.length} hit${hits.length === 1 ? "" : "s"} from ${filesScanned} file${filesScanned === 1 ? "" : "s"} (${ranker})${symbols.length ? `, ${symbols.length} symbol${symbols.length === 1 ? "" : "s"}` : ""}`,
    };
  },
});

// ─── Chunking + lexical ranking ────────────────────────────────────────

interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  tokens: Map<string, number>;
  /** 16-hex sha256 of text — the sidecar's content-addressed key. */
  hash: string;
}

// Per-process chunk cache keyed by path → (mtime,size). A query previously
// re-read+re-chunked the WHOLE workspace every time; now only files that
// changed since last seen are re-chunked.
//
// Bounded LRU: the Map is module-level and was never evicted, so a long-lived
// process searching many repos grew it without limit. Map keeps insertion
// order, so the oldest entry is the first key — evict it once we exceed the cap.
const CHUNK_CACHE_MAX = 5_000;
const chunkCache = new Map<string, { mtimeMs: number; size: number; chunks: Chunk[] }>();

function cacheChunks(filePath: string, entry: { mtimeMs: number; size: number; chunks: Chunk[] }): void {
  // Re-insert moves the key to the most-recently-used end (Map ordering).
  chunkCache.delete(filePath);
  chunkCache.set(filePath, entry);
  while (chunkCache.size > CHUNK_CACHE_MAX) {
    const oldest = chunkCache.keys().next().value;
    if (oldest === undefined) break;
    chunkCache.delete(oldest);
  }
}

function chunksForFile(filePath: string, content: string, mtimeMs: number, size: number): Chunk[] {
  const cached = chunkCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.chunks;
  const chunks: Chunk[] = [];
  chunkify(filePath, content, chunks);
  cacheChunks(filePath, { mtimeMs, size, chunks });
  return chunks;
}

function chunkHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function chunkify(filePath: string, content: string, out: Chunk[]): void {
  const lines = content.split("\n");
  if (lines.length <= CHUNK_LINES) {
    out.push({
      path: filePath,
      startLine: 1,
      endLine: lines.length,
      text: content,
      tokens: bagOfWords(content),
      hash: chunkHash(content),
    });
    return;
  }
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + CHUNK_LINES);
    const text = lines.slice(start, end).join("\n");
    out.push({
      path: filePath,
      startLine: start + 1,
      endLine: end,
      text,
      tokens: bagOfWords(text),
      hash: chunkHash(text),
    });
    if (end === lines.length) break;
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function bagOfWords(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const tok of tokenize(s)) m.set(tok, (m.get(tok) ?? 0) + 1);
  return m;
}

function computeDocFrequency(chunks: Chunk[], queryTokens: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tok of queryTokens) {
    let count = 0;
    for (const c of chunks) if (c.tokens.has(tok)) count++;
    df.set(tok, count);
  }
  return df;
}

function tfIdfScore(
  chunk: Chunk,
  queryTokens: string[],
  df: Map<string, number>,
  totalChunks: number,
): number {
  let score = 0;
  for (const tok of queryTokens) {
    const tf = chunk.tokens.get(tok) ?? 0;
    if (tf === 0) continue;
    const docFreq = df.get(tok) ?? 0;
    if (docFreq === 0) continue;
    const idf = Math.log((totalChunks + 1) / (docFreq + 1)) + 1;
    score += Math.sqrt(tf) * idf;
  }
  // Slight boost for code-shaped chunks (lots of identifiers).
  if (chunk.tokens.size > 30) score *= 1.05;
  return score;
}

// ─── Embedding sidecar ─────────────────────────────────────────────────

interface VectorSidecar {
  file: string;
  /** content hash → vector */
  vectors: Map<string, number[]>;
  /** Hashes appended since the last flush. */
  appended: Map<string, { file: string; start: number; end: number }>;
  loaded: boolean;
  writing: Promise<void>;
}

const sidecars = new Map<string, VectorSidecar>();

export function chunkVectorSidecarPath(workspace: string): string {
  return path.join(workspace, ".ares", "index", "chunks.vec.jsonl");
}

/** Drop the in-process sidecar cache (tests re-open a workspace after tampering). */
export function resetCodebaseSearchSidecars(): void {
  sidecars.clear();
}

async function openSidecar(workspace: string): Promise<VectorSidecar> {
  const file = chunkVectorSidecarPath(path.resolve(workspace));
  let sc = sidecars.get(file);
  if (sc?.loaded) return sc;
  sc = { file, vectors: new Map(), appended: new Map(), loaded: false, writing: Promise.resolve() };
  sidecars.set(file, sc);
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { h?: string; v?: unknown };
      if (typeof rec.h === "string" && Array.isArray(rec.v) && rec.v.every((x) => typeof x === "number")) {
        sc.vectors.set(rec.h, rec.v as number[]);
      }
    } catch {
      // A torn trailing line from an interrupted append is expected; skip it.
    }
  }
  sc.loaded = true;
  return sc;
}

/**
 * Append newly embedded vectors. Append-only on the hot path (cheap, crash-safe:
 * a torn last line is skipped on load); compaction to the live chunk set happens
 * only when the file has clearly outgrown what the workspace references.
 */
function flushSidecar(sc: VectorSidecar, liveHashes: Set<string>): void {
  if (sc.appended.size === 0) return;
  const batch = sc.appended;
  sc.appended = new Map();
  sc.writing = sc.writing
    .then(async () => {
      await fs.mkdir(path.dirname(sc.file), { recursive: true });
      const lines: string[] = [];
      for (const [h, meta] of batch) {
        const v = sc.vectors.get(h);
        if (!v) continue;
        lines.push(JSON.stringify({ file: meta.file, start: meta.start, end: meta.end, h, v: v.map((x) => Math.round(x * 1e6) / 1e6) }));
      }
      if (sc.vectors.size > liveHashes.size * 2 + 256) {
        // Compact: rewrite only vectors the workspace still references.
        const kept: string[] = [];
        for (const [h, v] of sc.vectors) {
          if (!liveHashes.has(h)) {
            sc.vectors.delete(h);
            continue;
          }
          kept.push(JSON.stringify({ h, v: v.map((x) => Math.round(x * 1e6) / 1e6) }));
        }
        const tmp = `${sc.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "", "utf8");
        await fs.rename(tmp, sc.file);
        return;
      }
      if (lines.length) await fs.appendFile(sc.file, lines.join("\n") + "\n", "utf8");
    })
    .catch(() => {
      // Unwritable workspace: vectors stay in memory for this process.
    });
}

/** Wait for pending sidecar writes (tests). */
export async function codebaseSearchSidecarIdle(workspace: string): Promise<void> {
  const sc = sidecars.get(chunkVectorSidecarPath(path.resolve(workspace)));
  if (sc) await sc.writing;
}

interface HybridResult {
  cosRaw: Map<number, number>;
  cosNorm: Map<number, number>;
  stats: CodebaseSearchEmbeddingStats;
}

async function hybridScores(
  workspace: string,
  query: string,
  chunks: Chunk[],
  lexical: number[],
  t0: number,
): Promise<HybridResult | null> {
  const budgetMs = embedBudgetMs();
  const embedder = resolveEmbedder();
  if (!embedder || budgetMs === 0 || chunks.length === 0) return null;
  const failKey = path.resolve(workspace);
  const lastFail = embedderFailures.get(failKey);
  if (lastFail && Date.now() - lastFail < embedRetryMs()) return null;

  const model = embedModelName();
  const deadline = t0 + budgetMs;
  const stats: CodebaseSearchEmbeddingStats = {
    model,
    vectors: 0,
    embeddedNow: 0,
    pending: 0,
    budgetMs,
    budgetExhausted: false,
  };
  const sc = await openSidecar(workspace);

  // Query vector first — without it nothing else matters.
  let queryVec: number[];
  try {
    const [qv] = await withinBudget(embedder.embed([query]), deadline);
    if (!qv) throw new Error("empty query embedding");
    queryVec = qv;
  } catch (err) {
    stats.error = err instanceof Error ? err.message : String(err);
    if (!/budget/.test(stats.error)) embedderFailures.set(failKey, Date.now());
    else stats.budgetExhausted = true;
    return finish(stats, sc, chunks, null);
  }

  // Embed missing chunks, most lexically relevant first, until the budget ends.
  const missing: number[] = [];
  for (let k = 0; k < chunks.length; k++) if (!sc.vectors.has(chunks[k].hash)) missing.push(k);
  missing.sort((a, b) => lexical[b] - lexical[a]);
  const batchSize = embedBatchSize();
  let cursor = 0;
  while (cursor < missing.length) {
    if (Date.now() >= deadline) {
      stats.budgetExhausted = true;
      break;
    }
    const batchIdx = missing.slice(cursor, cursor + batchSize);
    cursor += batchIdx.length;
    const texts = batchIdx.map((k) => chunks[k].text);
    const pending = embedder.embed(texts);
    // Whether or not we wait for it, the result lands in the sidecar.
    const landed = pending
      .then((vecs) => {
        for (let j = 0; j < batchIdx.length && j < vecs.length; j++) {
          const c = chunks[batchIdx[j]];
          sc.vectors.set(c.hash, vecs[j]);
          sc.appended.set(c.hash, { file: c.path, start: c.startLine, end: c.endLine });
        }
        return vecs.length;
      })
      .catch((err: unknown) => {
        embedderFailures.set(failKey, Date.now());
        stats.error = err instanceof Error ? err.message : String(err);
        return 0;
      });
    try {
      const n = await withinBudget(landed, deadline);
      stats.embeddedNow += n;
      if (stats.error) break;
    } catch {
      // Budget hit mid-batch: the batch keeps running and flushes on its own.
      stats.budgetExhausted = true;
      void landed.then(() => flushSidecar(sc, liveHashes(chunks)));
      break;
    }
  }

  return finish(stats, sc, chunks, queryVec);
}

function liveHashes(chunks: Chunk[]): Set<string> {
  return new Set(chunks.map((c) => c.hash));
}

function finish(
  stats: CodebaseSearchEmbeddingStats,
  sc: VectorSidecar,
  chunks: Chunk[],
  queryVec: number[] | null,
): HybridResult {
  flushSidecar(sc, liveHashes(chunks));
  const cosRaw = new Map<number, number>();
  const cosNorm = new Map<number, number>();
  let pending = 0;
  if (queryVec) {
    let min = Infinity;
    let max = -Infinity;
    for (let k = 0; k < chunks.length; k++) {
      const v = sc.vectors.get(chunks[k].hash);
      if (!v) {
        pending++;
        continue;
      }
      const c = cosineSimilarity(queryVec, v);
      cosRaw.set(k, c);
      if (c < min) min = c;
      if (c > max) max = c;
    }
    // Min-max over the embedded set: raw cosines from sentence embedders cluster
    // in a narrow band, so an unscaled blend would let TF-IDF dominate anyway.
    for (const [k, c] of cosRaw) {
      cosNorm.set(k, cosRaw.size >= 2 && max > min ? (c - min) / (max - min) : Math.min(1, Math.max(0, c)));
    }
  } else {
    pending = chunks.filter((c) => !sc.vectors.has(c.hash)).length;
  }
  stats.vectors = cosRaw.size;
  stats.pending = pending;
  return { cosRaw, cosNorm, stats };
}

function withinBudget<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("embedding budget exhausted"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("embedding budget exhausted")), remaining);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── Symbol hits ───────────────────────────────────────────────────────

async function symbolHits(workspace: string, queryTokens: string[], roots: string[]): Promise<CodebaseSearchSymbolHit[]> {
  let index: SymbolIndex;
  try {
    index = await buildSymbolIndex(workspace, { maxAgeMs: symbolMemoMs() });
  } catch {
    return [];
  }
  const scoped = roots.map((r) => path.resolve(r));
  const best = new Map<string, SymbolMatch>();
  for (const tok of queryTokens) {
    if (tok.length < 3) continue;
    for (const m of querySymbols(index, tok, { limit: SYMBOL_HITS * 2 })) {
      // Only prefix-or-better tiers: a loose subsequence on a 3-letter token is noise.
      if (m.tier === "subsequence" || m.tier === "substring") continue;
      const abs = path.join(index.workspace, ...m.file.split("/"));
      if (!scoped.some((r) => abs === r || abs.startsWith(r + path.sep))) continue;
      const key = `${m.file}:${m.line}`;
      const prev = best.get(key);
      if (!prev || prev.score < m.score) best.set(key, m);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, SYMBOL_HITS)
    .map((m) => ({
      name: m.name,
      kind: m.kind,
      path: path.join(index.workspace, ...m.file.split("/")),
      line: m.line,
      endLine: m.endLine,
      container: m.container,
      signature: m.signature,
    }));
}

// ─── Walk ──────────────────────────────────────────────────────────────

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      // Search code-bearing dot directories such as .github; explicit cache,
      // VCS, and Ares-state directories are already denied above.
      await walk(full, visit);
    } else if (e.isFile()) {
      if (e.name.startsWith(".")) {
        const ext = path.extname(e.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
      }
      await visit(full);
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ─── Stopwords ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "for",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "must",
  "can",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "how",
  "with",
  "from",
  "as",
  "if",
  "then",
  "than",
  "we",
  "us",
  "you",
  "your",
  "it",
  "its",
  "i",
  "me",
  "my",
  "our",
]);
