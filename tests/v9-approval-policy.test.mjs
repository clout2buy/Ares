// Verifies the Approval Rail Phase 1 — the pure policy/risk classifier.
// No runtime behavior; pure functions only.

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateAction, classifyAction, permits, permissionModeFor } from "../packages/effects/dist/index.js";

const act = (category, policyMode) => evaluateAction({ category }, policyMode ? { mode: policyMode } : undefined);

test("policy: unset (legacy) preserves current permit behavior, flagged as compat", () => {
  const local = act("file_write"); // unset → legacy
  assert.equal(local.effectiveMode, "legacy");
  assert.equal(local.decision, "allow", "local reversible work still permitted");
  assert.equal(act("shell_mutating").decision, "allow");
  // documented as legacy, not the ideal default
  assert.ok(local.warnings.some((w) => /legacy/i.test(w)));
  // a risky external action under legacy is permitted but recorded (never silent)
  const push = act("git_push");
  assert.ok(permits(push.decision), "git_push still permitted under legacy");
  assert.notEqual(push.decision, "allow", "but not a silent plain allow — it's log-only");
});

test("policy: Observe never commits (mutating → preview-only, read-only → allow)", () => {
  assert.equal(act("file_read", "observe").decision, "allow");
  assert.equal(act("shell_readonly", "observe").decision, "allow");
  assert.equal(act("file_write", "observe").decision, "preview-only");
  assert.equal(act("shell_destructive", "observe").decision, "preview-only");
  assert.equal(act("git_push", "observe").decision, "preview-only");
});

test("policy: Assist asks for destructive/external/irreversible, allows safe local", () => {
  assert.equal(act("file_write", "assist").decision, "allow");
  assert.equal(act("shell_mutating", "assist").decision, "allow");
  assert.equal(act("file_delete", "assist").decision, "ask");
  assert.equal(act("git_push", "assist").decision, "ask");
  assert.equal(act("browser_submit", "assist").decision, "ask");
});

test("policy: Act stages irreversible/external, allows recoverable/local", () => {
  assert.equal(act("file_write", "act").decision, "allow");
  assert.equal(act("file_delete", "act").decision, "allow"); // recoverable via checkpoint
  assert.equal(act("browser_navigate", "act").decision, "allow"); // reversible external
  assert.equal(act("git_push", "act").decision, "ask");
  assert.equal(act("browser_submit", "act").decision, "ask");
  assert.equal(act("shell_destructive", "act").decision, "ask");
});

test("policy: Bypass preserves allow behavior but warns on risky actions", () => {
  const push = act("git_push", "bypass");
  assert.ok(permits(push.decision), "still permitted under bypass");
  assert.ok(push.warnings.length > 0, "but emits a warning");
  assert.equal(act("file_write", "bypass").decision, "allow"); // safe → plain allow
});

test("policy: hard blocks deny in every mode (incl. bypass)", () => {
  for (const mode of ["observe", "assist", "act", "bypass", undefined]) {
    for (const cat of ["credential_or_secret", "payment_or_purchase", "email_send", "external_account"]) {
      const r = evaluateAction({ category: cat }, mode ? { mode } : undefined);
      assert.equal(r.decision, "deny", `${cat} denied in ${mode ?? "legacy"}`);
      assert.equal(r.hardBlocked, true);
    }
  }
  // email_draft is NOT blocked (drafting is allowed)
  assert.notEqual(act("email_draft", "act").decision, "deny");
});

test("policy: browser_navigate is lower risk than browser_submit", () => {
  const nav = classifyAction({ category: "browser_navigate" });
  const sub = classifyAction({ category: "browser_submit" });
  assert.equal(nav.irreversibility, "reversible");
  assert.equal(sub.irreversibility, "irreversible");
  assert.equal(act("browser_navigate", "act").decision, "allow");
  assert.equal(act("browser_submit", "act").decision, "ask");
});

test("policy: shell_readonly is lower risk than shell_destructive", () => {
  assert.equal(classifyAction({ category: "shell_readonly" }).safetyClass, "read-only");
  assert.equal(classifyAction({ category: "shell_destructive" }).safetyClass, "destructive");
  assert.equal(act("shell_readonly", "observe").decision, "allow");
  assert.equal(act("shell_destructive", "observe").decision, "preview-only");
});

test("policy: git_push is staged/ask, never a silent allow", () => {
  assert.equal(act("git_push", "act").decision, "ask");
  assert.equal(act("git_push", "assist").decision, "ask");
  assert.notEqual(act("git_push", "bypass").decision, "allow"); // log-only, not silent
});

test("policy: unknown action gets conservative handling, never silently allowed", () => {
  assert.equal(act("unknown", "act").decision, "ask");
  assert.equal(act("unknown", "assist").decision, "ask");
  assert.equal(act("unknown", "observe").decision, "preview-only");
  const bypass = act("unknown", "bypass");
  assert.notEqual(bypass.decision, "allow", "never a silent allow");
  assert.ok(bypass.warnings.some((w) => /unknown/i.test(w)));
});

test("policy: every evaluation carries cited reasons", () => {
  for (const mode of ["observe", "assist", "act", "bypass"]) {
    for (const cat of ["file_write", "git_push", "browser_navigate"]) {
      const r = evaluateAction({ category: cat }, { mode });
      assert.ok(r.reasons.length > 0, `${cat}/${mode} has reasons`);
    }
  }
});

test("policy: ActionMode maps onto existing PermissionMode values", () => {
  assert.equal(permissionModeFor("observe"), "plan");
  assert.equal(permissionModeFor("assist"), "auto-safe");
  assert.equal(permissionModeFor("act"), "workspace-write");
  assert.equal(permissionModeFor("bypass"), "bypass");
  assert.equal(permissionModeFor("legacy"), "bypass");
});

test("policy: pure — inputs are not mutated", () => {
  const action = { category: "file_write", domain: "fs" };
  const policy = { mode: "act" };
  const a = JSON.stringify(action);
  const p = JSON.stringify(policy);
  evaluateAction(action, policy);
  assert.equal(JSON.stringify(action), a);
  assert.equal(JSON.stringify(policy), p);
});
