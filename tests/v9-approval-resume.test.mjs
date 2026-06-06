// Verifies Approval Rail Phase 3 — a STAGED effect now pauses for a human
// decision via ctx.requestApproval and resumes (commit) or refuses (rejected).
// Backward-compatible: with no requestApproval, staging keeps legacy behavior.

import test from "node:test";
import assert from "node:assert/strict";

import { runEffect, Ledger, Budget, KillSwitch } from "../packages/effects/dist/index.js";

function makeEffect(o = {}) {
  const state = { simulated: 0, committed: 0 };
  const effect = {
    kind: o.kind ?? "test.outward",
    domain: o.domain ?? "test",
    cost: o.cost,
    irreversibility: o.irreversibility ?? "irreversible", // stages by default at leash 1
    idempotencyKey: o.idempotencyKey ?? `key-${Math.random().toString(36).slice(2)}`,
    async simulate() {
      state.simulated++;
      return o.preview;
    },
    async commit() {
      state.committed++;
      return "ok";
    },
  };
  return { effect, state };
}

function ctxWith(requestApproval) {
  return { ledger: Ledger.memory(), budget: new Budget({}), killSwitch: KillSwitch.memory(), leashOf: () => 1, requestApproval };
}

test("rail resume: staged + approve → committed (ledger: staged → approved → committed)", async () => {
  const { effect, state } = makeEffect();
  const ctx = ctxWith(async (s) => ({ id: s.id, verb: "allow_once", at: "2026-06-06T00:00:00.000Z", approver: "noah" }));
  const r = await runEffect(effect, ctx);
  assert.equal(r.status, "committed");
  assert.equal(state.committed, 1);
  const phases = ctx.ledger.all().map((e) => e.phase);
  assert.ok(phases.includes("staged"), "logged staged");
  assert.ok(phases.includes("approved"), "logged approved");
  assert.ok(phases.includes("committed"), "logged committed");
  const approved = ctx.ledger.all().find((e) => e.phase === "approved");
  assert.equal(approved.approver, "noah", "approver recorded");
});

test("rail resume: staged + deny → denied, never commits, logs rejected", async () => {
  const { effect, state } = makeEffect();
  const ctx = ctxWith(async (s) => ({ id: s.id, verb: "deny", at: "2026-06-06T00:00:00.000Z", note: "not now" }));
  const r = await runEffect(effect, ctx);
  assert.equal(r.status, "denied");
  assert.equal(state.committed, 0, "rejected effect never commits");
  assert.ok(ctx.ledger.all().some((e) => e.phase === "rejected"));
});

test("rail resume: no requestApproval → legacy staged behavior, never commits", async () => {
  const { effect, state } = makeEffect();
  const ctx = { ledger: Ledger.memory(), budget: new Budget({}), killSwitch: KillSwitch.memory(), leashOf: () => 1 };
  const r = await runEffect(effect, ctx);
  assert.equal(r.status, "staged");
  assert.equal(state.committed, 0);
});

test("rail resume: simulate() output is surfaced to the approver as preview", async () => {
  const { effect } = makeEffect({ preview: { would: "post to github.com" } });
  let seen;
  const ctx = ctxWith(async (s) => {
    seen = s.preview;
    return { id: s.id, verb: "deny", at: "2026-06-06T00:00:00.000Z" };
  });
  await runEffect(effect, ctx);
  assert.deepEqual(seen, { would: "post to github.com" });
});

test("rail resume: a reversible effect auto-commits — approver is never consulted", async () => {
  const { effect, state } = makeEffect({ irreversibility: "reversible" });
  let calls = 0;
  const ctx = ctxWith(async (s) => {
    calls++;
    return { id: s.id, verb: "deny", at: "2026-06-06T00:00:00.000Z" };
  });
  const r = await runEffect(effect, ctx);
  assert.equal(r.status, "committed");
  assert.equal(state.committed, 1);
  assert.equal(calls, 0, "reversible never staged, so no approval prompt");
});
