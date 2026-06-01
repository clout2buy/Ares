// Verifies O2 — Effects + rails (the conscience):
//   1. A reversible effect under budget commits; ledger = proposed->simulated->committed.
//   2. An irreversible effect on a leash-1 domain is STAGED, not committed.
//   3. The recoverable gradient: staged at leash 1, committed at leash 2.
//   4. Idempotency: re-running a committed key does not double-commit.
//   5. Kill switch: engaging it makes every commit throw HaltedError.
//   6. Budget: daily cap and per-domain ceiling deny over-limit commits.
//   7. undoEffect runs undo() and records an "undone" entry.
//   8. File-backed ledger persists committed keys across a reopen (resume).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runEffect,
  undoEffect,
  Ledger,
  Budget,
  KillSwitch,
  HaltedError,
} from "../packages/effects/dist/index.js";

function makeEffect(o = {}) {
  const state = { simulated: 0, committed: 0, undone: 0 };
  const effect = {
    kind: o.kind ?? "test.effect",
    domain: o.domain ?? "test",
    cost: o.cost,
    irreversibility: o.irreversibility ?? "reversible",
    idempotencyKey: o.idempotencyKey ?? `key-${Math.random().toString(36).slice(2)}`,
    predict: o.predict,
    async simulate() {
      state.simulated++;
    },
    async commit() {
      state.committed++;
      return o.result ?? "ok";
    },
    async undo() {
      state.undone++;
    },
  };
  return { effect, state };
}

function makeCtx({ leash, limits } = {}) {
  return {
    ledger: Ledger.memory(),
    budget: new Budget(limits ?? {}),
    killSwitch: KillSwitch.memory(),
    leashOf: leash !== undefined ? () => leash : undefined,
  };
}

// ── 1. commit + ledger phases ───────────────────────────────────────────────

test("rails: a reversible effect commits; ledger shows proposed -> simulated -> committed", async () => {
  const ctx = makeCtx({ leash: 1 });
  const { effect, state } = makeEffect({ irreversibility: "reversible", result: 42 });
  const res = await runEffect(effect, ctx);
  assert.equal(res.status, "committed");
  assert.equal(res.result, 42);
  assert.equal(state.simulated, 1);
  assert.equal(state.committed, 1);
  assert.deepEqual(ctx.ledger.all().map((e) => e.phase), ["proposed", "simulated", "committed"]);
});

// ── 2 & 3. irreversibility gate ─────────────────────────────────────────────

test("rails: an irreversible effect on a leash-1 domain is staged, not committed", async () => {
  const ctx = makeCtx({ leash: 1 });
  const { effect, state } = makeEffect({ irreversibility: "irreversible" });
  const res = await runEffect(effect, ctx);
  assert.equal(res.status, "staged");
  assert.equal(state.committed, 0, "commit() must never run for a staged effect");
  assert.ok(ctx.ledger.all().some((e) => e.phase === "staged"));
});

test("rails: recoverable needs leash 2 — staged at 1, committed at 2", async () => {
  const staged = await runEffect(makeEffect({ irreversibility: "recoverable", idempotencyKey: "r1" }).effect, makeCtx({ leash: 1 }));
  assert.equal(staged.status, "staged");
  const ok = await runEffect(makeEffect({ irreversibility: "recoverable", idempotencyKey: "r2" }).effect, makeCtx({ leash: 2 }));
  assert.equal(ok.status, "committed");
});

test("rails: a free irreversible effect is still gated (irreversibility outranks cost)", async () => {
  const ctx = makeCtx({ leash: 1 }); // no cost at all
  const res = await runEffect(makeEffect({ irreversibility: "irreversible", cost: undefined }).effect, ctx);
  assert.equal(res.status, "staged", "even a $0 irreversible effect faces scrutiny");
});

// ── 4. idempotency ──────────────────────────────────────────────────────────

test("rails: re-running a committed idempotencyKey does not double-commit", async () => {
  const ctx = makeCtx({ leash: 1 });
  const first = makeEffect({ irreversibility: "reversible", idempotencyKey: "fixed" });
  assert.equal((await runEffect(first.effect, ctx)).status, "committed");

  // A fresh effect object with the SAME key — e.g. the same step retried after a resume.
  const second = makeEffect({ irreversibility: "reversible", idempotencyKey: "fixed" });
  const res = await runEffect(second.effect, ctx);
  assert.equal(res.status, "already");
  assert.equal(second.state.committed, 0, "second commit() skipped");
  assert.equal(first.state.committed, 1, "still exactly one real commit");
});

// ── 5. kill switch ──────────────────────────────────────────────────────────

test("rails: engaging the kill switch makes commits throw HaltedError", async () => {
  const ctx = makeCtx({ leash: 5 });
  await ctx.killSwitch.engage("test halt");
  const { effect, state } = makeEffect({ irreversibility: "reversible" });
  await assert.rejects(() => runEffect(effect, ctx), (e) => e instanceof HaltedError);
  assert.equal(state.committed, 0, "nothing commits while halted");
});

// ── 6. budget ───────────────────────────────────────────────────────────────

test("rails: exceeding the daily cap denies the commit", async () => {
  const ctx = makeCtx({ leash: 5, limits: { daily: 10 } });
  const first = makeEffect({ domain: "spend:ads", cost: { dollars: 8 }, idempotencyKey: "k1" });
  assert.equal((await runEffect(first.effect, ctx)).status, "committed");

  const second = makeEffect({ domain: "spend:ads", cost: { dollars: 5 }, idempotencyKey: "k2" });
  const res = await runEffect(second.effect, ctx);
  assert.equal(res.status, "denied");
  assert.equal(second.state.committed, 0);
  assert.match(res.reason, /daily cap/);
});

test("rails: a per-domain ceiling denies an over-limit commit", async () => {
  const ctx = makeCtx({ leash: 5, limits: { perDomain: { "spend:ads": 20 } } });
  assert.equal((await runEffect(makeEffect({ domain: "spend:ads", cost: { dollars: 15 }, idempotencyKey: "d1" }).effect, ctx)).status, "committed");
  const res = await runEffect(makeEffect({ domain: "spend:ads", cost: { dollars: 10 }, idempotencyKey: "d2" }).effect, ctx);
  assert.equal(res.status, "denied");
  assert.match(res.reason, /domain/);
});

// ── 7. undo ─────────────────────────────────────────────────────────────────

test("rails: undoEffect runs undo() and records an 'undone' ledger entry", async () => {
  const ctx = makeCtx({ leash: 5 });
  const { effect, state } = makeEffect({ irreversibility: "recoverable", idempotencyKey: "u1" });
  await runEffect(effect, ctx);
  await undoEffect(effect, ctx);
  assert.equal(state.undone, 1);
  assert.ok(ctx.ledger.all().some((e) => e.phase === "undone"));
});

// ── 8. file-backed persistence across reopen ────────────────────────────────

test("ledger: a file-backed ledger persists committed keys across a reopen (resume)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crix-effects-"));
  const file = path.join(dir, "ledger.jsonl");

  const ledger1 = await Ledger.open(file);
  const ctx1 = { ledger: ledger1, budget: new Budget(), killSwitch: KillSwitch.memory(), leashOf: () => 1 };
  await runEffect(makeEffect({ idempotencyKey: "persist" }).effect, ctx1);

  // Reopen from disk — simulating an Operator restart.
  const ledger2 = await Ledger.open(file);
  assert.ok(ledger2.committed("persist"), "committed key survived the reopen");

  const ctx2 = { ledger: ledger2, budget: new Budget(), killSwitch: KillSwitch.memory(), leashOf: () => 1 };
  const retry = makeEffect({ idempotencyKey: "persist" });
  assert.equal((await runEffect(retry.effect, ctx2)).status, "already");
  assert.equal(retry.state.committed, 0, "no double-commit after restart");

  await fs.rm(dir, { recursive: true, force: true });
});
