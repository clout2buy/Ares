// Verifies Approval Rail Phase 2 — the request/decision/proof/rollback types
// and their pure helpers (redaction, expiry, rollback derivation). No wiring.

import test from "node:test";
import assert from "node:assert/strict";

import { redactPreview, isApprovalExpired, defaultRollbackHint, classifyAction } from "../packages/effects/dist/index.js";

test("approval: redactPreview strips obvious secrets and flags it", () => {
  const out = redactPreview({ kind: "command", summary: "push", payload: "git push https://x:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com", redacted: false });
  assert.ok(!/ghp_ABCDEFG/.test(out.payload));
  assert.match(out.payload, /\[redacted\]/);
  assert.equal(out.redacted, true);
});

test("approval: redactPreview leaves clean payloads untouched", () => {
  const clean = { kind: "url", summary: "open github", payload: "https://github.com/clout2buy/Ares", redacted: false };
  const out = redactPreview(clean);
  assert.equal(out.payload, clean.payload);
  assert.equal(out.redacted, false);
});

test("approval: redactPreview is pure (input not mutated)", () => {
  const input = { kind: "raw", summary: "x", payload: "token=abcdef0123456789abcdef0123456789abcdef01", redacted: false };
  const before = JSON.stringify(input);
  redactPreview(input);
  assert.equal(JSON.stringify(input), before);
});

test("approval: isApprovalExpired respects expiresAt", () => {
  const base = { id: "a", category: "git_push", domain: "git", risk: classifyAction({ category: "git_push" }), preview: { kind: "command", summary: "push", redacted: false }, reason: "outward", createdAt: "2026-06-06T00:00:00.000Z" };
  assert.equal(isApprovalExpired({ ...base }, "2026-06-06T01:00:00.000Z"), false, "no expiry → never expired");
  assert.equal(isApprovalExpired({ ...base, expiresAt: "2026-06-06T00:30:00.000Z" }, "2026-06-06T00:10:00.000Z"), false, "before expiry");
  assert.equal(isApprovalExpired({ ...base, expiresAt: "2026-06-06T00:30:00.000Z" }, "2026-06-06T01:00:00.000Z"), true, "after expiry");
});

test("approval: defaultRollbackHint derives from risk", () => {
  // git/fs that ARE rollback-available → checkpoint
  const commit = defaultRollbackHint(classifyAction({ category: "git_commit" }));
  assert.equal(commit.kind, "checkpoint");
  assert.equal(commit.reversible, true);

  const write = defaultRollbackHint(classifyAction({ category: "file_write" }));
  assert.equal(write.kind, "checkpoint");

  // browser fill is reversible but not files/git → undo
  const fill = defaultRollbackHint(classifyAction({ category: "browser_fill" }));
  assert.equal(fill.kind, "undo");
  assert.equal(fill.reversible, true);

  // git_push and shell_destructive are NOT rollback-available → none
  assert.equal(defaultRollbackHint(classifyAction({ category: "git_push" })).kind, "none");
  const destructive = defaultRollbackHint(classifyAction({ category: "shell_destructive" }));
  assert.equal(destructive.kind, "none");
  assert.equal(destructive.reversible, false);
});
