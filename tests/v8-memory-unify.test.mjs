// Phase 2C — Live Brain Wiring, foundation (steps 1 & 2 only):
//   schema versioning + one canonical recall interface.
//
// Proves:
//   1. v6 living memory still reads/writes, and every record carries a schema `v`.
//   2. The legacy v4 vector store is still recallable — through the unified interface.
//   3. Live recall uses ONE interface that merges v6 + v4 and dedupes overlap.
//   4. Corrupt and unknown-(future)-version records are skipped safely.
//   5. No destructive migration: unknown-version records survive a load→persist
//      round-trip verbatim; pre-versioned records are backfilled, not dropped.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore, MEMORY_SCHEMA_VERSION } from "../packages/mind/dist/index.js";
import { unifiedRecallForTurn } from "../packages/agent/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "ares-unify-"));
}

// ── 1. v6 still reads/writes, and records are schema-versioned ────────────────

test("v6: memory writes carry the schema version and round-trip on disk", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const store = await MemoryStore.open(file);
  const node = await store.add({ kind: "semantic", content: "The user prefers TypeScript for Ares" });
  assert.equal(node.v, MEMORY_SCHEMA_VERSION, "new nodes are stamped with the current schema version");

  const reopened = await MemoryStore.open(file);
  const all = reopened.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].v, MEMORY_SCHEMA_VERSION);
  assert.match(all[0].content, /TypeScript/);
});

// ── 2 & 3. One interface merges v6 (primary) + v4 (legacy), deduped ───────────

test("unified recall merges living + vector memory and dedupes overlap", async () => {
  // Fake v6 living store: surfaces a unique item + one that ALSO lives in v4.
  const openLiving = async () => ({
    async remember() {
      return [
        { node: { content: "Living-only fact about the launcher" } },
        { node: { content: "Shared installer lesson" }, viaAssociation: true },
      ];
    },
  });
  // Fake v4 vector store: surfaces the shared item again + a vector-only item.
  const recallVector = async () => ({
    results: [
      { memory: { content: "Shared installer lesson" }, distance: 0.1 },
      { memory: { content: "Vector-only dependency note" }, distance: 0.2 },
    ],
    reminder: "",
    usedEmbedding: "lexical",
  });

  const out = await unifiedRecallForTurn({
    query: "installer",
    workspace: "/ws",
    livingMemoryFile: "/unused",
    vector: { config: {} },
    openLiving,
    recallVector,
  });

  const contents = out.items.map((i) => i.content);
  assert.deepEqual(contents, [
    "Living-only fact about the launcher",
    "Shared installer lesson",
    "Vector-only dependency note",
  ], "living first, vector tops up, the shared item appears exactly once");
  assert.equal(out.sources.living, 2);
  assert.equal(out.sources.vector, 1);
  assert.ok(out.reminder.includes("Shared installer lesson"));
  assert.ok(out.reminder.includes("<- "), "association marker is preserved in the block");
  assert.equal(out.reminder.split("BACKGROUND MEMORY from earlier").length, 2, "exactly ONE reminder block");
});

test("unified recall works from living memory alone when no v4 store is given", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const store = await MemoryStore.open(file);
  await store.add({ kind: "semantic", content: "Ares runs missions, not just turns" });

  const out = await unifiedRecallForTurn({
    query: "what does ares run",
    workspace: dir,
    livingMemoryFile: file,
  });
  assert.ok(out.items.length >= 1);
  assert.equal(out.sources.vector, 0);
  assert.equal(out.items[0].origin, "living");
});

test("unified recall short-circuits when shouldRecall is false or query is empty", async () => {
  const tripped = { hit: false };
  const openLiving = async () => ({ async remember() { tripped.hit = true; return []; } });

  const off = await unifiedRecallForTurn({ query: "anything", workspace: "/ws", livingMemoryFile: "/x", shouldRecall: false, openLiving });
  assert.equal(off.reminder, "");
  assert.equal(off.items.length, 0);

  const empty = await unifiedRecallForTurn({ query: "   ", workspace: "/ws", livingMemoryFile: "/x", openLiving });
  assert.equal(empty.reminder, "");
  assert.equal(tripped.hit, false, "no store was even opened");
});

// ── 4 & 5. Corrupt + unknown-version records: skipped safely, never destroyed ─

test("v6 load skips corrupt and unknown-version records without destroying them", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");

  const valid = { v: 1, id: "mem_keep01", kind: "semantic", content: "keep me", at: new Date().toISOString(), strength: 2, activations: 0, lastActivatedAt: new Date().toISOString(), links: [] };
  const future = { v: 999, id: "mem_future1", kind: "semantic", content: "from a newer Ares", at: new Date().toISOString(), strength: 5, activations: 3, lastActivatedAt: new Date().toISOString(), links: [] };
  await fs.writeFile(file, [JSON.stringify(valid), JSON.stringify(future), "{ this is not json"].join("\n") + "\n");

  const store = await MemoryStore.open(file);
  // Only the valid record is active — corrupt + future are excluded.
  assert.equal(store.count(), 1);
  assert.equal(store.all()[0].id, "mem_keep01");

  // Force a persist (the write path), then confirm the future record SURVIVED.
  await store.add({ kind: "episodic", content: "a brand new memory" });
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const ids = lines.map((n) => n.id);
  assert.ok(ids.includes("mem_keep01"), "valid record retained");
  assert.ok(ids.includes("mem_future1"), "unknown-version record preserved verbatim across persist");
  const futureBack = lines.find((n) => n.id === "mem_future1");
  assert.equal(futureBack.v, 999, "future record kept its own version untouched");
  assert.equal(futureBack.strength, 5, "future record fields untouched (no destructive migration)");
});

test("v6 load backfills pre-versioned records to the current schema version", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  // A record written before `v` existed — no version field.
  const legacy = { id: "mem_legacy1", kind: "semantic", content: "from before versioning", at: new Date().toISOString(), strength: 1, activations: 0, lastActivatedAt: new Date().toISOString(), links: [] };
  await fs.writeFile(file, JSON.stringify(legacy) + "\n");

  const store = await MemoryStore.open(file);
  assert.equal(store.count(), 1, "pre-versioned record is loaded, not dropped");
  assert.equal(store.all()[0].v, MEMORY_SCHEMA_VERSION, "backfilled to the current version");
  assert.match(store.all()[0].content, /before versioning/, "content preserved intact");
});

// ── reinforce:false — read-only inspection never mutates memory strength ───────

test("unified recall: reinforce:false surfaces memory without strengthening it", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const store = await MemoryStore.open(file);
  await store.add({ kind: "semantic", content: "The launcher uses Inno Setup packaging" });

  const before = (await MemoryStore.open(file)).all()[0];

  // Read-only recall (what `ares recap` / `/whathappened` use).
  const ro = await unifiedRecallForTurn({ query: "launcher packaging", workspace: dir, livingMemoryFile: file, reinforce: false });
  assert.ok(ro.items.length >= 1, "still surfaces the memory");
  const afterPeek = (await MemoryStore.open(file)).all()[0];
  assert.equal(afterPeek.strength, before.strength, "strength unchanged by inspection");
  assert.equal(afterPeek.activations, before.activations, "activations unchanged by inspection");

  // Control: the default (live-turn) recall DOES reinforce.
  await unifiedRecallForTurn({ query: "launcher packaging", workspace: dir, livingMemoryFile: file });
  const afterRecall = (await MemoryStore.open(file)).all()[0];
  assert.ok(afterRecall.activations > before.activations, "default recall reinforces (control)");
});
