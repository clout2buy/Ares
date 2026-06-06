// Verifies the salience-weighted recall upgrade (opt-in via corpusIdf):
//   1. IDF weighting — a memory matching a RARE cue token outranks memories that
//      match only a COMMON one (rare tokens carry the signal).
//   2. Multi-hop spreading — a 2-hop-linked memory surfaces at depth:2 but NOT at
//      depth:1 (geometric reach along associations).

import test from "node:test";
import assert from "node:assert/strict";

import { recall, buildIdf, MemoryStore } from "../packages/mind/dist/index.js";

const NOW = new Date("2026-06-05T00:00:00.000Z");
const mk = (id, content, links = []) => ({
  v: 2,
  id,
  kind: "semantic",
  content,
  at: NOW.toISOString(),
  strength: 1,
  activations: 0,
  lastActivatedAt: NOW.toISOString(),
  links,
});

test("recall: IDF weighting ranks a rare-token match above a common-token match", () => {
  const nodes = [
    mk("rare", "zebra sighting"),
    mk("common", "quarterly report"),
    // Filler floods the corpus with "report" so it becomes low-salience, while
    // "zebra" stays rare (and therefore high-salience).
    ...Array.from({ length: 8 }, (_, i) => mk(`f${i}`, "quarterly report summary")),
  ];
  const idf = buildIdf(nodes);

  const results = recall("zebra report", nodes, { corpusIdf: idf, spread: false, now: NOW });
  assert.match(results[0].node.content, /zebra/, "the rare-token memory ranks first");

  const rare = results.find((r) => r.node.id === "rare");
  const common = results.find((r) => r.node.id === "common");
  assert.ok(rare && common);
  assert.ok(rare.score > common.score, "rare-token match scores strictly higher than the common one");
});

test("recall: multi-hop spreading reaches a 2-hop link only at depth:2", async () => {
  const store = MemoryStore.memory();
  const seed = await store.add({ kind: "semantic", content: "zebra quokka note" });
  const mid = await store.add({ kind: "semantic", content: "quokka ledger note" });
  const far = await store.add({ kind: "semantic", content: "ledger vault note" });
  await store.link(seed.id, mid.id);
  await store.link(mid.id, far.id);

  const idf = buildIdf(store.all());
  const has = (res, id) => res.some((r) => r.node.id === id);

  const d1 = store.peek("zebra", { corpusIdf: idf, depth: 1, limit: 20, now: NOW });
  assert.ok(has(d1, seed.id), "seed surfaces at depth 1");
  assert.ok(has(d1, mid.id), "the 1-hop neighbor surfaces at depth 1");
  assert.ok(!has(d1, far.id), "the 2-hop node is NOT reached at depth 1");

  const d2 = store.peek("zebra", { corpusIdf: idf, depth: 2, limit: 20, now: NOW });
  assert.ok(has(d2, far.id), "the 2-hop node IS reached at depth 2");
});
