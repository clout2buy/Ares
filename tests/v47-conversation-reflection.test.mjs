// Conversation reflection — distilling durable facts from chat into Living Memory,
// deduped. The LLM distillation is injected; everything here is pure + testable.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationDigest,
  mergeDurableFacts,
} from "../packages/mind/dist/index.js";

// A tiny in-memory store matching ReflectStoreLike.
function fakeStore(seed = []) {
  const nodes = seed.map((content) => ({ content }));
  return {
    nodes,
    all() { return nodes; },
    async add(input) { nodes.push({ content: input.content, kind: input.kind, tags: input.tags, source: input.source, strength: input.strength }); },
  };
}

test("buildConversationDigest tags roles and drops empties", () => {
  const digest = buildConversationDigest([
    { role: "user", text: "I work 12-hour welding shifts" },
    { role: "assistant", text: "Respect, that's a grind" },
    { role: "user", text: "   " },
  ]);
  assert.match(digest, /Owner: I work 12-hour welding shifts/);
  assert.match(digest, /Ares: Respect/);
  assert.doesNotMatch(digest, /Owner:\s*$/m);
});

test("buildConversationDigest keeps the most RECENT content under budget", () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `fact number ${i} padding padding padding` }));
  const digest = buildConversationDigest(turns, 200);
  assert.ok(digest.length <= 200);
  assert.match(digest, /fact number 49/); // tail kept
  assert.doesNotMatch(digest, /fact number 0 /); // head dropped
});

test("mergeDurableFacts writes new facts as semantic memory with reflected tags", async () => {
  const store = fakeStore();
  const res = await mergeDurableFacts(store, [
    { content: "Crix works 12-hour welding shifts from 6am to 6pm", kind: "fact", importance: 0.9 },
    { content: "Crix prefers concise, direct answers", kind: "preference", importance: 0.8 },
  ]);
  assert.equal(res.added, 2);
  assert.equal(res.skipped, 0);
  assert.equal(store.nodes.length, 2);
  assert.equal(store.nodes[0].kind, "semantic");
  assert.ok(store.nodes[0].tags.includes("reflected"));
});

test("mergeDurableFacts skips near-duplicates of existing memory", async () => {
  const store = fakeStore(["Crix works twelve hour welding shifts from 6am to 6pm"]);
  const res = await mergeDurableFacts(store, [
    { content: "Crix works 12-hour welding shifts from 6am to 6pm", kind: "fact", importance: 0.9 },
    { content: "Crix's girlfriend is named Jamara", kind: "relationship", importance: 0.9 },
  ]);
  assert.equal(res.added, 1, "the welding-shift paraphrase is a dup; only the new fact lands");
  assert.equal(res.skipped, 1);
  assert.match(res.addedFacts[0], /Jamara/);
});

test("mergeDurableFacts dedups WITHIN a single batch", async () => {
  const store = fakeStore();
  const res = await mergeDurableFacts(store, [
    { content: "Crix lives in New York and works as a welder", kind: "fact", importance: 0.8 },
    { content: "Crix is a welder living in New York", kind: "fact", importance: 0.8 },
  ]);
  assert.equal(res.added, 1);
  assert.equal(res.skipped, 1);
});

test("mergeDurableFacts drops low-importance and trivially short facts", async () => {
  const store = fakeStore();
  const res = await mergeDurableFacts(store, [
    { content: "Crix said hi today", kind: "fact", importance: 0.1 },
    { content: "ok", kind: "fact", importance: 0.9 },
    { content: "Crix is allergic to penicillin", kind: "fact", importance: 0.95 },
  ]);
  assert.equal(res.added, 1);
  assert.match(res.addedFacts[0], /penicillin/);
});
