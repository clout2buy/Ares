import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createMemoryStore,
  defaultAgentConfig,
  formatRecallReminder,
  lexicalEmbedding,
  recallForTurn,
} from "../packages/agent/dist/index.js";
import { MemoryTool } from "../packages/tools/dist/index.js";

async function makeTmp(prefix = "crix-v4-memory-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("V4 V2: memory store inserts and recalls with deterministic local embeddings", async () => {
  const home = await makeTmp();
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  const store = await createMemoryStore(config, home);
  const embedding = lexicalEmbedding("always use pnpm verify", 32);
  await store.add({ category: "USER", workspace: "D:/repo", content: "User prefers pnpm verify before claiming done.", embedding, embeddingDim: 32 });

  const results = await store.recall({ query: "how do I verify", embedding: lexicalEmbedding("pnpm verify", 32), workspace: "D:/repo", limit: 3 });

  assert.equal(results.length, 1);
  assert.equal(results[0].memory.category, "USER");
  assert.equal((await store.list())[0].hits, 1);
  assert.match(formatRecallReminder(results), /USER#1/);
});

test("V4 V2: vector memory stores and recalls bounded atomic entries", async () => {
  const home = await makeTmp();
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  const store = await createMemoryStore(config, home);
  await store.add({
    category: "PROJECT",
    workspace: "D:/repo",
    content: `Use pnpm verify. ${"huge ".repeat(2_000)}`,
    embeddingDim: 32,
  });

  const [stored] = await store.list();
  assert.ok(stored.content.length < 1_250, `stored memory too large: ${stored.content.length}`);
  const results = await store.recall({ query: "pnpm verify", embedding: lexicalEmbedding("pnpm verify", 32), workspace: "D:/repo" });
  const reminder = formatRecallReminder(results);
  assert.ok(reminder.length < 650, `recall reminder too large: ${reminder.length}`);
  assert.match(reminder, /truncated/);
});

test("V4 V2: recallForTurn formats a system reminder without Ollama", async () => {
  const home = await makeTmp();
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  config.memory.maxResults = 2;
  const store = await createMemoryStore(config, home);
  await store.add({ category: "PROJECT", workspace: "D:/repo", content: "This repo uses pnpm and TypeScript.", embeddingDim: 32 });

  const recall = await recallForTurn({ home, workspace: "D:/repo", query: "typescript package manager", config });

  assert.equal(recall.usedEmbedding, "lexical");
  assert.match(recall.reminder, /pnpm and TypeScript/);
});

test("V4 V2: recallForTurn skips casual greetings", async () => {
  const home = await makeTmp();
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  const store = await createMemoryStore(config, home);
  await store.add({ category: "USER", workspace: "D:/repo", content: "User prefers blunt no-fluff answers.", embeddingDim: 32 });

  const recall = await recallForTurn({ home, workspace: "D:/repo", query: "hey homie", config });

  assert.deepEqual(recall.results, []);
  assert.equal(recall.reminder, "");
});

test("V4 V2: Memory tool supports lexical recall over flat memory", async () => {
  const workspace = await makeTmp("crix-v4-flat-memory-");
  const ctx = {
    workspace,
    signal: new AbortController().signal,
    permissionMode: "workspace-write",
    fileReadStamps: new Map(),
  };
  await MemoryTool.call({ action: "add", scope: "project", category: "Preferences", content: "Use pnpm for scripts.", tags: ["tooling"], limit: 20 }, ctx);

  const recalled = await MemoryTool.call({ action: "recall", scope: "project", category: "General", query: "package scripts", tags: [], limit: 20 }, ctx);

  assert.equal(recalled.output.items.length, 1);
  assert.match(await fs.readFile(path.join(workspace, ".crix", "memory.md"), "utf8"), /Use pnpm/);
});
