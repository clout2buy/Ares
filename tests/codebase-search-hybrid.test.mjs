// CodebaseSearch — hybrid (embedding + TF-IDF) ranking with a fake embedder.
//
// A two-concept fake embedder stands in for Ollama: any text about signing in
// maps to concept A, everything else to concept B. That makes the paraphrase
// case deterministic ("how do users sign in" must find authenticate() even
// though the chunk shares no tokens with the query), lets the budget test use
// a deliberately slow embedder, and proves the sidecar refresh is incremental.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CodebaseSearchTool,
  setCodebaseSearchEmbedder,
  resetCodebaseSearchSidecars,
  codebaseSearchSidecarIdle,
  chunkVectorSidecarPath,
} from "../packages/tools/dist/index.js";
import { resetSymbolIndexMemo } from "../packages/core/dist/index.js";

const AUTH_WORDS = /sign in|sign-in|login|authenticate|credential|password/i;

function fakeEmbedder({ delayMs = 0, delayBatchesOnly = false } = {}) {
  const calls = [];
  return {
    calls,
    async embed(texts) {
      calls.push(texts.length);
      if (delayMs > 0 && (!delayBatchesOnly || texts.length > 1)) await new Promise((r) => setTimeout(r, delayMs));
      return texts.map((t) => (AUTH_WORDS.test(t) ? [1, 0.05] : [0.05, 1]));
    },
  };
}

async function makeWorkspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "ares-cs-hybrid-"));
  await fs.mkdir(path.join(ws, "src"), { recursive: true });
  // The auth chunk shares NO tokens with the query "how do users sign in".
  await fs.writeFile(
    path.join(ws, "src", "auth.ts"),
    "export function authenticate(credentials: Credentials) {\n  return verifyPassword(credentials);\n}\n",
    "utf8",
  );
  // The chart chunk shares the token "users" → wins on TF-IDF alone.
  await fs.writeFile(
    path.join(ws, "src", "chart.ts"),
    "export function renderChart(users: number[]) {\n  return users.map((u) => u * 2);\n}\n",
    "utf8",
  );
  resetCodebaseSearchSidecars();
  resetSymbolIndexMemo(ws);
  return ws;
}

function ctx(workspace) {
  return {
    workspace,
    sessionId: "sess_cs_hybrid",
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
}

const QUERY = "how do users sign in";
const input = { query: QUERY, target_directories: [], max_results: 10 };

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("CodebaseSearch: no embedder → pure TF-IDF, ranker 'tfidf', symbols still reported", async () => {
  const ws = await makeWorkspace();
  setCodebaseSearchEmbedder(null);
  try {
    const r = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(r.output.ranker, "tfidf");
    assert.equal(r.output.embedding, undefined);
    assert.equal(r.output.hits.length, 1);
    assert.match(r.output.hits[0].path, /chart\.ts$/);
    assert.ok(Array.isArray(r.output.symbols));
    const auth = await CodebaseSearchTool.call({ ...input, query: "where is auth handled" }, ctx(ws));
    assert.ok(auth.output.symbols.some((s) => s.name === "authenticate" && s.kind === "function"), JSON.stringify(auth.output.symbols));
    assert.ok(path.isAbsolute(auth.output.symbols[0].path));
  } finally {
    setCodebaseSearchEmbedder(undefined);
  }
});

test("CodebaseSearch: hybrid ranking surfaces the paraphrase that TF-IDF misses", async () => {
  const ws = await makeWorkspace();
  const embedder = fakeEmbedder();
  setCodebaseSearchEmbedder(embedder);
  try {
    const r = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(r.output.ranker, "hybrid");
    assert.equal(r.output.embedding.vectors, 2);
    assert.equal(r.output.embedding.embeddedNow, 2);
    assert.equal(r.output.embedding.pending, 0);
    assert.equal(r.output.embedding.budgetExhausted, false);
    assert.equal(r.output.hits.length, 2);
    assert.match(r.output.hits[0].path, /auth\.ts$/, "meaning beats keyword overlap");
    assert.ok(r.output.hits[0].cosine > r.output.hits[1].cosine);
    assert.match(r.display, /hybrid/);

    // Sidecar exists and is content-addressed.
    await codebaseSearchSidecarIdle(ws);
    const raw = await fs.readFile(chunkVectorSidecarPath(ws), "utf8");
    const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => typeof row.h === "string" && Array.isArray(row.v) && row.file && row.start === 1));
  } finally {
    setCodebaseSearchEmbedder(undefined);
  }
});

test("CodebaseSearch: sidecar refresh is incremental — only changed chunks re-embed", async () => {
  const ws = await makeWorkspace();
  const embedder = fakeEmbedder();
  setCodebaseSearchEmbedder(embedder);
  try {
    await CodebaseSearchTool.call(input, ctx(ws));
    await codebaseSearchSidecarIdle(ws);
    const callsAfterFirst = embedder.calls.length;

    const second = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(second.output.embedding.embeddedNow, 0);
    assert.equal(embedder.calls.length, callsAfterFirst + 1, "only the query was embedded");

    // Re-open the workspace cold (new process semantics): vectors load from disk.
    resetCodebaseSearchSidecars();
    const cold = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(cold.output.embedding.embeddedNow, 0);
    assert.equal(cold.output.ranker, "hybrid");

    const chart = path.join(ws, "src", "chart.ts");
    await fs.writeFile(chart, "export function renderChart(users: number[]) {\n  return users.map((u) => u * 3);\n}\n", "utf8");
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(chart, future, future);
    const third = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(third.output.embedding.embeddedNow, 1, "one changed chunk re-embedded");
    assert.equal(third.output.embedding.pending, 0);
  } finally {
    setCodebaseSearchEmbedder(undefined);
  }
});

test("CodebaseSearch: budget exhaustion falls back to TF-IDF cleanly, then benefits next time", async () => {
  const ws = await makeWorkspace();
  const embedder = fakeEmbedder({ delayMs: 400, delayBatchesOnly: true });
  setCodebaseSearchEmbedder(embedder);
  try {
    await withEnv({ ARES_CODESEARCH_EMBED_BUDGET_MS: "120" }, async () => {
      const r = await CodebaseSearchTool.call(input, ctx(ws));
      assert.equal(r.output.ranker, "tfidf", "no chunk vectors landed in time");
      assert.equal(r.output.embedding.budgetExhausted, true);
      assert.equal(r.output.embedding.vectors, 0);
      assert.ok(r.output.durationMs < 1000);
      assert.equal(r.output.hits.length, 1);
      assert.match(r.output.hits[0].path, /chart\.ts$/);

      // The overrun batch keeps running and lands in the sidecar.
      await new Promise((res) => setTimeout(res, 600));
      await codebaseSearchSidecarIdle(ws);
      const again = await CodebaseSearchTool.call(input, ctx(ws));
      assert.equal(again.output.ranker, "hybrid");
      assert.equal(again.output.embedding.embeddedNow, 0);
      assert.match(again.output.hits[0].path, /auth\.ts$/);
    });
  } finally {
    setCodebaseSearchEmbedder(undefined);
  }
});

test("CodebaseSearch: embedder failure → tfidf with error noted, no throw", async () => {
  const ws = await makeWorkspace();
  setCodebaseSearchEmbedder({
    async embed() {
      throw new Error("ollama embedder unreachable at http://127.0.0.1:11434");
    },
  });
  try {
    const r = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(r.output.ranker, "tfidf");
    assert.match(r.output.embedding.error, /unreachable/);
    assert.equal(r.output.hits.length, 1);
    // Negative cache: the next call does not even try.
    const next = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(next.output.ranker, "tfidf");
    assert.equal(next.output.embedding, undefined);
  } finally {
    setCodebaseSearchEmbedder(undefined);
  }
});

test("CodebaseSearch: ARES_CODESEARCH_EMBED=0 disables embeddings entirely", async () => {
  const ws = await makeWorkspace();
  setCodebaseSearchEmbedder(undefined);
  await withEnv({ ARES_CODESEARCH_EMBED: "0" }, async () => {
    const r = await CodebaseSearchTool.call(input, ctx(ws));
    assert.equal(r.output.ranker, "tfidf");
    assert.equal(r.output.embedding, undefined);
  });
});
