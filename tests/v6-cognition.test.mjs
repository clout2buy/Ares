// Verifies M2 — Cognition (the thought process):
//   1. consider() thinks WITH memory: recalls relevant context, narrates a
//      stream (observe → recall → idea → decide → intend), and forms an intention.
//   2. The recalled memory is fed to the reasoner (memory informs deliberation).
//   3. Deciding writes the decision back to memory (next time it's wiser).
//   4. No good option → no intention + an honest doubt ("research or ask").
//   5. Drives: capabilities flagged "want" become intentions (curiosity).
//   6. ThoughtStream narrates the inner monologue.

import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStore, consider, detectDrives, ThoughtStream } from "../packages/mind/dist/index.js";

// ── 1–3. deliberation with memory ────────────────────────────────────────────

test("cognition: consider recalls memory, deliberates, decides, and forms an intention", async () => {
  const memory = MemoryStore.memory();
  await memory.add({ kind: "semantic", content: "The user prefers cheap, fast options for shopify tasks" });

  let sawRecalled = 0;
  const stream = new ThoughtStream();
  const deliberation = await consider("how should I post a shopify listing", {
    memory,
    commitDecision: true, // act-on-it path: persist the decision (advisory default is false)
    emit: (t) => stream.record(t),
    propose: (_situation, recalled) => {
      sawRecalled = recalled.length;
      return [
        { action: "use the Shopify API", pro: "reliable and cheap", score: 0.9 },
        { action: "drive the browser", pro: "always works", con: "slower", score: 0.5 },
      ];
    },
  });

  assert.ok(sawRecalled >= 1, "the reasoner saw recalled memory (memory informed deliberation)");
  assert.ok(deliberation.intention, "an intention was formed");
  assert.equal(deliberation.intention.goal, "use the Shopify API", "it chose the highest-scored option");
  assert.ok(deliberation.intention.confidence > 0.8);

  const kinds = deliberation.thoughts.map((t) => t.kind);
  assert.ok(kinds.includes("recall"), "it consulted memory");
  assert.ok(kinds.includes("idea"), "it considered options");
  assert.ok(kinds.includes("decide"), "it committed");
  assert.ok(kinds.includes("intend"), "it formed an intention");

  // The decision was written back to memory.
  const after = memory.all().filter((n) => n.kind === "episodic" && /Decided to use the Shopify API/.test(n.content));
  assert.equal(after.length, 1, "the decision became an episodic memory");
});

// ── 4. honest doubt ──────────────────────────────────────────────────────────

test("cognition: no viable option → no intention, and an honest doubt", async () => {
  const deliberation = await consider("do something impossible", {
    propose: () => [],
  });
  assert.equal(deliberation.intention, null);
  assert.ok(deliberation.thoughts.some((t) => t.kind === "doubt"), "it admits it needs to research or ask");
});

test("cognition: decision memories distill huge working situations", async () => {
  const memory = MemoryStore.memory();
  const hugeSituation = `fix context handling ${"raw transcript ".repeat(5_000)}`;
  const deliberation = await consider(hugeSituation, {
    memory,
    commitDecision: true, // act-on-it path: persist the decision (advisory default is false)
    propose: () => [{ action: `ship bounded memory ${"details ".repeat(2_000)}`, pro: "prevents prompt bloat", score: 0.95 }],
  });

  assert.ok(deliberation.intention);
  assert.ok(deliberation.intention.goal.length < 540, `intention goal too large: ${deliberation.intention.goal.length}`);
  const stored = memory.all().find((node) => node.kind === "episodic" && /Decided to ship bounded memory/.test(node.content));
  assert.ok(stored, "decision should be remembered");
  assert.ok(stored.content.length < 1_400, `decision memory too large: ${stored.content.length}`);
  assert.match(stored.content, /truncated/);
});

// ── 5. drives / curiosity ────────────────────────────────────────────────────

test("cognition: capabilities flagged 'want' become intentions to pursue", () => {
  const drives = detectDrives([
    { name: "send-email", status: "want" },
    { name: "make-shopify", status: "mastered" },
    { name: "run-ads", status: "want" },
  ]);
  assert.equal(drives.length, 2, "only the gaps drive curiosity");
  assert.ok(drives.every((d) => d.goal.startsWith("acquire")));
});

// ── 6. narration ─────────────────────────────────────────────────────────────

test("cognition: ThoughtStream narrates the inner monologue", () => {
  const stream = new ThoughtStream();
  stream.record({ kind: "observe", text: "Considering: x", at: new Date().toISOString() });
  stream.record({ kind: "decide", text: "Going with: y", at: new Date().toISOString() });
  const narration = stream.narrate();
  assert.match(narration, /Considering: x/);
  assert.match(narration, /Going with: y/);
  assert.equal(stream.all().length, 2);
});
