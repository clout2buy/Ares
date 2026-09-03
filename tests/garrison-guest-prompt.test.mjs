// A guest session never carries the owner's live-mind prompt tail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptTailForTenant } from "../packages/cli/dist/entry/sessionSurface.js";

test("guests get the git-only tail; owner and unstamped sessions keep the full tail", () => {
  const owner = "## Living memory\n- the owner's secret\n## Git\nmain";
  const gitOnly = "## Git\nmain";
  assert.equal(promptTailForTenant({ role: "guest", chatId: "99" }, owner, gitOnly), gitOnly);
  assert.equal(promptTailForTenant({ role: "owner" }, owner, gitOnly), owner);
  assert.equal(promptTailForTenant(undefined, owner, gitOnly), owner);
  assert.equal(promptTailForTenant(null, owner, gitOnly), owner);
});
