// Plan pressure — the host-side verdict behind the engine's structural
// plan-before-edit gate. Substantial coding work opens with a plan; greetings,
// questions, slash commands and one-line fixes stay instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlanPressure, createPlanPressure, shouldPlanBeforeEdit } from "../packages/cli/dist/entry/planPressure.js";

test("substantial coding work asks for a plan", () => {
  const verdict = shouldPlanBeforeEdit(
    "Refactor the checkpoint store to use git trees, then wire /rewind into the daemon and add tests end-to-end",
  );
  assert.equal(verdict.plan, true);
  assert.match(verdict.reason, /substantial/);
});

test("greetings, short questions and slash commands never ask for a plan", () => {
  for (const text of ["hey homie", "what time is it?", "/undo", "", "   "]) {
    assert.equal(shouldPlanBeforeEdit(text).plan, false, JSON.stringify(text));
  }
});

test("an external action is not plan-worthy even when graded substantial", () => {
  const verdict = shouldPlanBeforeEdit("send the invoice email to the client and then post the tweet");
  assert.equal(verdict.plan, false);
});

test("applyPlanPressure records the verdict on the holder and tolerates a missing holder", () => {
  const holder = createPlanPressure();
  assert.equal(holder.next, false);
  applyPlanPressure(holder, "implement the LRU cache, migrate the config file, and rewrite the tests");
  assert.equal(holder.next, true);
  applyPlanPressure(holder, "lol ok");
  assert.equal(holder.next, false);
  assert.doesNotThrow(() => applyPlanPressure(undefined, "anything"));
});
