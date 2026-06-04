// Verifies M0 — the unleash posture: owner-trusted by default, dial in your hand.
//   1. With ownerLeash() everything auto-commits, even irreversible — no friction.
//   2. The owner can still pull specific domains back to require approval, while
//      everything else stays open.

import test from "node:test";
import assert from "node:assert/strict";

import { runEffect, Ledger, Budget, KillSwitch, ownerLeash } from "../packages/effects/dist/index.js";

function effect(domain, key) {
  let committed = 0;
  const spec = {
    kind: `${domain}.act`,
    domain,
    irreversibility: "irreversible",
    idempotencyKey: key,
    async simulate() {},
    async commit() {
      committed++;
      return "done";
    },
  };
  return { spec, committed: () => committed };
}

function ctx(leashOf) {
  return { ledger: Ledger.memory(), budget: new Budget(), killSwitch: KillSwitch.memory(), leashOf };
}

test("unleash: owner posture auto-commits even irreversible effects by default", async () => {
  const e = effect("email", "k1");
  const res = await runEffect(e.spec, ctx(ownerLeash()));
  assert.equal(res.status, "committed", "no friction — the owner trusts it");
  assert.equal(e.committed(), 1);
});

test("unleash: the owner can pull a single domain back without restricting the rest", async () => {
  const leashOf = ownerLeash({ restricted: { "spend:ads": 1 } });

  const spend = effect("spend:ads", "s1");
  assert.equal((await runEffect(spend.spec, ctx(leashOf))).status, "staged", "restricted domain pauses for approval");
  assert.equal(spend.committed(), 0);

  const email = effect("email", "e1");
  assert.equal((await runEffect(email.spec, ctx(leashOf))).status, "committed", "everything else stays wide open");
});
