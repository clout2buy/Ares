// v48 — the effects-gate invariant: every outward-effect tool action routes
// through the conscience gate. Regression guard for the bug where Gmail(send),
// GoogleCalendar(create/delete), and Connect(set_credentials/disconnect) were
// tagged workspace-write and AUTO-ALLOWED, bypassing the gate entirely.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolRequest, gateToolPermission } from "../packages/cli/dist/policyGate.js";

const req = (toolName, input) => ({ toolName, input, reason: "", id: "t" });

test("Gmail send is classified as email_send; reads are not gated", () => {
  assert.equal(classifyToolRequest(req("Gmail", { action: "send", to: "x@y.z" })), "email_send");
  assert.equal(classifyToolRequest(req("Gmail", { action: "list_messages" })), null);
  assert.equal(classifyToolRequest(req("Gmail", { action: "search", query: "q" })), null);
});

test("GoogleCalendar create/delete are gated; list is not", () => {
  assert.equal(classifyToolRequest(req("GoogleCalendar", { action: "create_event" })), "browser_submit");
  assert.equal(classifyToolRequest(req("GoogleCalendar", { action: "delete_event" })), "browser_submit");
  assert.equal(classifyToolRequest(req("GoogleCalendar", { action: "list_events" })), null);
});

test("Connect set_credentials/disconnect are credential-gated; list/status are not", () => {
  assert.equal(classifyToolRequest(req("Connect", { action: "set_credentials", provider: "google" })), "credential_or_secret");
  assert.equal(classifyToolRequest(req("Connect", { action: "disconnect", provider: "google" })), "credential_or_secret");
  assert.equal(classifyToolRequest(req("Connect", { action: "list" })), null);
});

test("UNATTENDED, the gated outward effects DENY (no owner to approve)", () => {
  for (const r of [
    req("Gmail", { action: "send", to: "x@y.z" }),
    req("GoogleCalendar", { action: "delete_event" }),
    req("Connect", { action: "set_credentials", provider: "google" }),
  ]) {
    const gate = gateToolPermission(r, { attended: false });
    assert.equal(gate.kind, "deny", `${r.toolName}/${r.input.action} must deny when unattended`);
  }
});

test("ATTENDED, the same effects ESCALATE (ask) rather than auto-allow", () => {
  const gate = gateToolPermission(req("Gmail", { action: "send", to: "x@y.z" }), { attended: true });
  assert.equal(gate.kind, "ask");
});
