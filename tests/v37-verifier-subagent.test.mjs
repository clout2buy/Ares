// The adversarial "verifier" subagent — Ares's "done means proven" gate.
// It is TOOL-RESTRICTED so it cannot fix-and-pass: it can Read/Grep/Bash to run
// the real build/tests + adversarial probes, but has NO Edit/Write/Task. These
// tests lock that contract (a whitelist regression would let it silently mutate
// the project it's supposed to be adversarially checking).

import test from "node:test";
import assert from "node:assert/strict";

import { SubagentRegistry } from "../packages/core/dist/index.js";

test("verifier: registered as a built-in subagent type", () => {
  const reg = new SubagentRegistry();
  assert.equal(reg.get("verifier") !== undefined, true, "verifier is a built-in type");
});

test("verifier: is tool-restricted — no Edit/Write/Task (can't fix-and-pass)", () => {
  const def = new SubagentRegistry().get("verifier");
  assert.ok(def.toolWhitelist, "verifier has an explicit tool whitelist");
  for (const banned of ["Edit", "Write", "NotebookEdit", "Task", "Conductor", "CodingBackend"]) {
    assert.equal(def.toolWhitelist.includes(banned), false, `verifier must NOT be able to call ${banned}`);
  }
  // It DOES get what it needs to actually run checks.
  for (const needed of ["Read", "Bash", "Grep"]) {
    assert.equal(def.toolWhitelist.includes(needed), true, `verifier needs ${needed} to run real checks`);
  }
});

test("verifier: prompt mandates a parseable VERDICT and command evidence", () => {
  const def = new SubagentRegistry().get("verifier");
  assert.match(def.systemPrompt, /VERDICT: PASS/, "must instruct the literal VERDICT line");
  assert.match(def.systemPrompt, /VERDICT: FAIL/);
  assert.match(def.systemPrompt, /Command run|command output|Output observed/i, "must require command evidence, not prose");
  assert.match(def.systemPrompt, /break it|try to break|adversar/i, "must be adversarial, not confirmatory");
});
