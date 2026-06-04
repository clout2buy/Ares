// Phase 2C step 3 — advisory cognition wiring (the A2 plan).
//
// Proves cognition whispers but never grabs the keyboard:
//   1. Injected recall is REUSED — consider() does not re-query memory.
//   2. commitDecision defaults false — advisory runs write no "Decided to…" memory.
//   3. Trivial turns (or nothing recalled) skip propose() entirely.
//   4. The suggestion is injected as clearly-labeled advisory CONTEXT, never a command.
//   5. The thought stream emits its beats in order (observe → recall → idea → decide → intend).
//   6. The heuristic reasoner flags a past failure when memory records one.

import test from "node:test";
import assert from "node:assert/strict";

import { consider } from "../packages/mind/dist/index.js";
import { deliberateForTurn, memoryGroundedPropose } from "../packages/agent/dist/index.js";

// ── 1. injected recall prevents a second memory.remember() ────────────────────

test("cognition: injected recall is reused — consider does not re-query memory", async () => {
  let remembered = 0;
  const memory = {
    remember: async () => { remembered++; return [{ node: { content: "should-not-be-used" } }]; },
    add: async () => {},
  };
  let seenCount = -1;
  await consider("build a launcher", {
    memory, // present, but recall is provided — so remember() must NOT run
    recalled: [{ node: { content: "Inno Setup worked for the Xile installer" } }],
    propose: (_s, recalled) => { seenCount = recalled.length; return [{ action: "reuse it", pro: "worked before", score: 0.8 }]; },
  });
  assert.equal(remembered, 0, "the unified recall was reused; the store was not queried again");
  assert.equal(seenCount, 1, "the reasoner saw the injected constellation");
});

// ── 2. commitDecision gate ────────────────────────────────────────────────────

test("cognition: advisory runs (commitDecision false) write no decision memory", async () => {
  let added = 0;
  const memory = { remember: async () => [], add: async () => { added++; } };

  await consider("s", { memory, recalled: [], propose: () => [{ action: "do x", pro: "p", score: 0.8 }] });
  assert.equal(added, 0, "default is advisory — no decision persisted");

  await consider("s", { memory, commitDecision: true, recalled: [], propose: () => [{ action: "do x", pro: "p", score: 0.8 }] });
  assert.equal(added, 1, "opting in persists the decision (the act-on-it path still works)");
});

// ── 3. gate: trivial turns / empty recall skip propose() ──────────────────────

test("advisory: trivial turns and empty recall skip propose() entirely", async () => {
  let proposeCalls = 0;
  const propose = () => { proposeCalls++; return [{ action: "x", pro: "y", score: 0.7 }]; };

  const trivial = await deliberateForTurn({ situation: "hey homie", recalled: [{ node: { content: "z" } }], shouldDeliberate: false, propose });
  assert.equal(proposeCalls, 0, "a trivial turn never reasons");
  assert.equal(trivial.intention, null);
  assert.equal(trivial.reminder, "");

  const nothing = await deliberateForTurn({ situation: "build it", recalled: [], shouldDeliberate: true, propose });
  assert.equal(proposeCalls, 0, "nothing recalled → nothing to reason about");
  assert.equal(nothing.reminder, "");
});

// ── 4. the suggestion is advisory context, not a command ──────────────────────

test("advisory: the suggestion is injected as non-binding context, never a command", async () => {
  const out = await deliberateForTurn({
    situation: "build a launcher",
    recalled: [{ node: { content: "Inno Setup + portable bootstrapper worked for the Xile installer" } }],
    shouldDeliberate: true,
  });
  assert.ok(out.intention, "a suggestion was formed from memory");
  assert.match(out.reminder, /advisory/i, "the block announces itself as advisory");
  assert.match(out.reminder, /not a command/i, "explicitly not a command");
  assert.match(out.reminder, /do not auto-run/i, "explicitly forbids auto-execution");
  assert.ok(out.reminder.includes("→"), "renders a non-binding suggestion arrow, not a tool call");
});

// ── 5. thought stream order ───────────────────────────────────────────────────

test("advisory: thoughts stream in order (observe → recall → idea → decide → intend)", async () => {
  const kinds = [];
  await deliberateForTurn({
    situation: "ship the installer",
    recalled: [{ node: { content: "installer signing pattern from MiniChat" } }],
    shouldDeliberate: true,
    emit: (t) => kinds.push(t.kind),
  });
  const order = ["observe", "recall", "idea", "decide", "intend"];
  let last = -1;
  for (const k of order) {
    const i = kinds.indexOf(k);
    assert.ok(i > last, `expected "${k}" to come after the previous beat (got order ${JSON.stringify(kinds)})`);
    last = i;
  }
});

// ── 6. heuristic reasoner flags past failures ─────────────────────────────────

test("advisory: the heuristic reasoner flags a past failure when memory records one", () => {
  const options = memoryGroundedPropose("build installer", [
    { node: { content: "The installer broke last time on the bootstrapper" } },
    { node: { content: "Used Inno Setup for packaging" } },
  ]);
  assert.equal(options.length, 1);
  assert.match(options[0].con ?? "", /past failure/i, "the caution about prior failure is surfaced");
  assert.ok(options[0].score > 0.5);
});
