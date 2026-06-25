// C9 — owner-toggleable permission policy (security-critical).
//
// Pins the decision matrix so the toggles can't silently drift into "auto-approve
// everything" or "deny everything." Defaults MUST equal the prior hardcoded
// behavior: guarded, non-sensitive flows, sensitive asks, fleets inherit.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decidePermission,
  classifyPermissionRequest,
  DEFAULT_PERMISSIONS,
} from "../packages/cli/dist/permissionPolicy.js";

const req = (toolName, reason = "") => ({ toolName, reason, input: {} });

test("classify: tools map to the right category; sensitive wins", () => {
  assert.equal(classifyPermissionRequest(req("Write", "write a file")), "fileWrite");
  assert.equal(classifyPermissionRequest(req("Edit", "edit code")), "fileWrite");
  assert.equal(classifyPermissionRequest(req("Bash", "run tests")), "shell");
  assert.equal(classifyPermissionRequest(req("WebFetch", "fetch a url")), "network");
  assert.equal(classifyPermissionRequest(req("Browser", "open page")), "network");
  assert.equal(classifyPermissionRequest(req("Todo", "note something")), "other");
  // sensitive overrides the tool category
  assert.equal(classifyPermissionRequest(req("Bash", "rm -rf the workspace")), "sensitive");
  assert.equal(classifyPermissionRequest(req("Write", "store the api key")), "sensitive");
  assert.equal(classifyPermissionRequest(req("Stripe", "create a payment link")), "sensitive");
});

test("defaults preserve prior behavior: non-sensitive flows, sensitive asks", () => {
  assert.equal(decidePermission(req("Edit", "edit"), undefined), "allow");
  assert.equal(decidePermission(req("Bash", "ls"), undefined), "allow");
  assert.equal(decidePermission(req("WebFetch", "get"), undefined), "allow");
  assert.equal(decidePermission(req("Todo", "x"), undefined), "allow");
  assert.equal(decidePermission(req("Bash", "delete data, drop database"), undefined), "ask");
  assert.equal(decidePermission(req("ComputerUse", "control the mouse"), undefined), "ask");
});

test("per-category toggles: turning a category OFF makes it ask", () => {
  assert.equal(decidePermission(req("Bash", "ls"), { shell: false }), "ask");
  assert.equal(decidePermission(req("Edit", "edit"), { fileWrite: false }), "ask");
  assert.equal(decidePermission(req("WebFetch", "get"), { network: false }), "ask");
  // turning sensitive ON lets the sensitive set flow
  assert.equal(decidePermission(req("Stripe", "payment"), { sensitive: true }), "allow");
});

test("free mode allows everything, including sensitive", () => {
  assert.equal(decidePermission(req("Stripe", "create payment link"), { mode: "free" }), "allow");
  assert.equal(decidePermission(req("Bash", "rm -rf"), { mode: "free" }), "allow");
  assert.equal(decidePermission(req("Edit", "edit"), { mode: "free" }), "allow");
});

test("fleet leaves: an 'ask' becomes 'deny' (they can't prompt)", () => {
  // default fleetsInherit:true → allowed categories pass, ask→deny
  assert.equal(decidePermission(req("Edit", "edit"), undefined, { fleet: true }), "allow");
  assert.equal(decidePermission(req("Stripe", "payment"), undefined, { fleet: true }), "deny");
  // fleetsInherit OFF → leaves are denied even for normally-allowed actions
  assert.equal(decidePermission(req("Edit", "edit"), { fleetsInherit: false }, { fleet: true }), "deny");
  // free mode + fleet → allowed (owner opted into full freedom)
  assert.equal(decidePermission(req("Stripe", "payment"), { mode: "free" }, { fleet: true }), "allow");
});

test("DEFAULT_PERMISSIONS shape is the conservative baseline", () => {
  assert.equal(DEFAULT_PERMISSIONS.mode, "guarded");
  assert.equal(DEFAULT_PERMISSIONS.sensitive, false);
  assert.equal(DEFAULT_PERMISSIONS.fleetsInherit, true);
});
