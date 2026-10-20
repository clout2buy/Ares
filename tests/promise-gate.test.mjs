// The promise gate (2026-10-20): an agent asked to "keep going till it's
// something I'd play every day" ended its turn with "I'll keep going in that
// order unless you want something different first" — and stopped. A reply that
// itself promises more work, and is not waiting on the owner, gets one nudge.
import test from "node:test";
import assert from "node:assert/strict";
import { promisesMoreWork } from "../packages/core/dist/queryEngine.js";

test("a reply that promises to keep working, then stops, is caught", () => {
  assert.equal(promisesMoreWork("Fixed the spawn damage.\n\nI'll keep going in that order unless you want something different first."), true);
  assert.equal(promisesMoreWork("Done with the HUD.\n\nNext, I'll tackle the progression system."), true);
  assert.equal(promisesMoreWork("I'll continue with the cave pass now."), true);
});

test("a finished report or a real question to the owner is left alone", () => {
  assert.equal(promisesMoreWork("All 39 tests pass and the win screen renders. Done."), false);
  assert.equal(promisesMoreWork("Should I add armour next, or more mobs?"), false);
  assert.equal(promisesMoreWork("I'll keep going once you tell me which seed you want — let me know."), false);
  assert.equal(promisesMoreWork("Want me to keep going on the caves?"), false);
  assert.equal(promisesMoreWork(""), false);
});
