// Field report 2026-11-06: one turn cost millions of input tokens because every
// model call carried 130-175k tokens. Compaction fired late (0.8 of the budget)
// and, when it fired, pinned up to 120k chars of whole files into a recap that
// every later call carried. These pin the diet.

import test from "node:test";
import assert from "node:assert/strict";
import { COMPACTION_PIN_FILES, COMPACTION_PIN_FILE_CHARS, COMPACTION_PIN_TOTAL_CHARS, COMPACTION_THRESHOLD_RATIO } from "../packages/core/dist/index.js";

test("compaction fires at 0.6 of the budget, not 0.8", () => {
  assert.equal(COMPACTION_THRESHOLD_RATIO, 0.6);
  // On the desktop's 192k budget that is ~115k; microcompact then clears old
  // tool output down to half of that, so prompts settle near 60-115k.
  assert.equal(Math.floor(192_000 * COMPACTION_THRESHOLD_RATIO), 115_200);
});

test("a recap pins a head and a tail of a few files, never 120k chars of them", () => {
  assert.equal(COMPACTION_PIN_FILES, 3);
  assert.ok(COMPACTION_PIN_FILE_CHARS <= 10_000);
  assert.ok(COMPACTION_PIN_TOTAL_CHARS <= 30_000);
  assert.ok(COMPACTION_PIN_FILES * COMPACTION_PIN_FILE_CHARS <= COMPACTION_PIN_TOTAL_CHARS + COMPACTION_PIN_FILE_CHARS, "the total cap can hold the files it promises");
});
