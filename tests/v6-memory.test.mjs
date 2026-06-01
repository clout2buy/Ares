// Verifies M1 — Living Memory (the brain-like memory):
//   1. remember() recalls relevant memories AND reinforces them (recalling makes
//      them stick — activations + strength rise).
//   2. Fading: an old, unused memory has lower effective strength than a fresh one.
//   3. Spreading activation: recalling a cue that matches A also surfaces a LINKED
//      memory B — even though the cue never matched B's text.
//   4. Consolidation: forgets faded one-off episodes; crystallizes a recurring
//      theme into a new semantic memory linked to its episodes.
//   5. Pluggable home: a file-backed store persists and reopens (the flashdrive).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryStore, currentStrength, reinforce } from "../packages/mind/dist/index.js";

async function makeDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "crix-mem-"));
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// ── 1. recall reinforces ─────────────────────────────────────────────────────

test("memory: remember surfaces relevant memories and strengthens them", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "The user prefers TypeScript for the Crix harness" });
  await store.add({ kind: "episodic", content: "Cooked pasta for dinner" });

  const results = await store.remember("what language does the user prefer for crix");
  assert.ok(results.length >= 1);
  assert.match(results[0].node.content, /TypeScript/);
  assert.equal(results[0].node.activations, 1, "recalling reinforced it (activation recorded)");
  assert.ok(results[0].node.strength > 1, "strength grew from being recalled");
});

// ── 2. fading ────────────────────────────────────────────────────────────────

test("memory: an old unused memory fades below a fresh one", () => {
  const now = new Date();
  const fresh = { id: "a", kind: "episodic", content: "x", at: now.toISOString(), strength: 1, activations: 0, lastActivatedAt: now.toISOString(), links: [] };
  const old = { id: "b", kind: "episodic", content: "y", at: daysAgo(60).toISOString(), strength: 1, activations: 0, lastActivatedAt: daysAgo(60).toISOString(), links: [] };
  assert.ok(currentStrength(old, now) < currentStrength(fresh, now));
  assert.ok(currentStrength(old, now) < 0.05, "a 60-day-untouched memory has nearly faded");
  // using it brings it back
  const revived = reinforce(old, now);
  assert.ok(currentStrength(revived, now) > currentStrength(old, now));
});

// ── 3. spreading activation ──────────────────────────────────────────────────

test("memory: recall spreads along associations to surface a linked memory", async () => {
  const store = MemoryStore.memory();
  const a = await store.add({ kind: "semantic", content: "Dropshipping store runs on Shopify" });
  const b = await store.add({ kind: "semantic", content: "Payments settle every Friday to the bank" });
  await store.link(a.id, b.id); // associated, but very different words

  const results = await store.remember("tell me about the shopify dropshipping setup");
  const ids = results.map((r) => r.node.id);
  assert.ok(ids.includes(a.id), "direct match surfaced");
  assert.ok(ids.includes(b.id), "the associated memory surfaced via spreading activation");
  assert.ok(results.find((r) => r.node.id === b.id)?.viaAssociation, "and it was flagged as an association hit");
});

// ── 4. consolidation ─────────────────────────────────────────────────────────

test("memory: consolidation forgets trivia and crystallizes a recurring theme", async () => {
  const store = MemoryStore.memory();
  // a faded one-off episode (old, never reinforced) → should be pruned
  await store.add({ kind: "episodic", content: "random idle chatter", at: daysAgo(90) });
  // a recurring theme across 3 fresh episodes → should be promoted to semantic
  await store.add({ kind: "episodic", content: "Researched shopify product trends" });
  await store.add({ kind: "episodic", content: "Posted a shopify listing" });
  await store.add({ kind: "episodic", content: "Checked shopify revenue dashboard" });

  const report = await store.consolidate();
  assert.ok(report.pruned >= 1, "the faded one-off episode was forgotten");
  assert.ok(report.promoted.includes("shopify"), "the recurring theme was crystallized");
  const semantic = store.all().find((n) => n.kind === "semantic" && n.tags?.includes("theme:shopify"));
  assert.ok(semantic, "a durable semantic memory now exists for the theme");
  assert.ok(semantic.links.length >= 3, "and it's linked to the episodes it came from");
});

// ── 5. pluggable home (the flashdrive) ───────────────────────────────────────

test("memory: a file-backed store persists and reopens from its home", async () => {
  const home = await makeDir();
  const store1 = await MemoryStore.open(home);
  await store1.add({ kind: "semantic", content: "This drive is my home now" });

  const store2 = await MemoryStore.open(home); // reopen — like remounting the flashdrive
  assert.equal(store2.count(), 1, "memory persisted to the home and reloaded");
  const results = await store2.remember("where is home");
  assert.match(results[0].node.content, /home/);

  await fs.rm(home, { recursive: true, force: true });
});
