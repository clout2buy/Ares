// Browser under the owner's operator kill switch (roadmap move 1: 47 field
// "kill switch engaged" errors, each retried). The error now says whose switch
// it is, that retrying cannot help, and how the owner releases it.

import test from "node:test";
import assert from "node:assert/strict";
import { haltedBrowserMessage } from "../packages/cli/dist/entry/browserBridge.js";

test("a halted Browser call tells the model not to retry and how the owner releases it", () => {
  const text = haltedBrowserMessage("operator halted: kill switch engaged (since 2026-10-01T00:00:00.000Z, reason: manual)");
  assert.match(text, /^operator halted: kill switch engaged \(since 2026-10-01/);
  assert.match(text, /do not retry/i);
  assert.match(text, /ares operator resume/);
  assert.match(text, /still open/);
  assert.equal(haltedBrowserMessage(text), text, "idempotent");
});
