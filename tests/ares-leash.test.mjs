// V8 — the leash dividend. A domain's autonomy is EARNED from the Crucible:
// confirmed procedures with net-positive records lengthen the leash, debits
// shorten it, and every change lands in the ledger with its evidence.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryStore } from "../packages/mind/dist/index.js";
import { TrustGovernor, deriveLeash } from "../packages/operator/dist/index.js";

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-leash-"));
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  return { dir, store };
}

async function provenProcedure(store, domain, content) {
  const node = await store.add({
    kind: "procedural",
    content,
    status: "candidate",
    tags: [`domain:${domain}`],
  });
  await store.recordOutcome([node.id], { won: true, note: "w1" });
  await store.recordOutcome([node.id], { won: true, note: "w2" });
  await store.setStatus(node.id, "confirmed", "trial passed");
  return store.get(node.id);
}

test("a domain with no confirmed procedures stays on the base leash", async () => {
  const { dir, store } = await makeStore();
  await store.add({ kind: "procedural", content: "guess about email", status: "candidate", tags: ["domain:email"] });
  assert.equal(deriveLeash(store.all(), "email").level, 1, "hypotheses earn nothing");
  await rm(dir, { recursive: true, force: true });
});

test("confirmed procedures with net-positive records raise the leash, capped at 5", async () => {
  const { dir, store } = await makeStore();
  for (let i = 0; i < 6; i++) {
    await provenProcedure(store, "email", `proven email procedure ${i} that keeps working reliably`);
  }
  const basis = deriveLeash(store.all(), "email");
  assert.equal(basis.level, 5, "level caps at 5 (irreversible tier)");
  assert.equal(basis.proven.length, 6);
  assert.equal(deriveLeash(store.all(), "payments").level, 1, "other domains unaffected");
  await rm(dir, { recursive: true, force: true });
});

test("a debited record drops the leash automatically", async () => {
  const { dir, store } = await makeStore();
  const node = await provenProcedure(store, "deploy", "deploy procedure with a good record so far");
  const governor = new TrustGovernor({ nodes: () => store.all() });
  assert.equal(governor.leashOf("deploy"), 2);

  // setStatus(confirmed) added one win to the evidence (3W/0L). Three losses
  // bring the margin below the proven threshold.
  await store.recordOutcome([node.id], { won: false, note: "deploy broke prod" });
  await store.recordOutcome([node.id], { won: false, note: "deploy broke staging" });
  assert.equal(governor.leashOf("deploy"), 1, "margin fell below proven threshold");
  await rm(dir, { recursive: true, force: true });
});

test("every leash CHANGE hits the ledger with evidence; repeats do not", async () => {
  const { dir, store } = await makeStore();
  const changes = [];
  const governor = new TrustGovernor({ nodes: () => store.all(), append: (c) => changes.push(c) });

  assert.equal(governor.leashOf("email"), 1);
  assert.equal(changes.length, 0, "base level is not a change");

  await provenProcedure(store, "email", "send the weekly digest through the proven pipeline");
  assert.equal(governor.leashOf("email"), 2);
  assert.equal(governor.leashOf("email"), 2);
  assert.equal(changes.length, 1, "one change, one ledger entry — repeats are silent");
  assert.equal(changes[0].domain, "email");
  assert.equal(changes[0].prevLevel, 1);
  assert.equal(changes[0].level, 2);
  assert.match(changes[0].evidence[0], /\dW\/\dL/, "the entry carries the records that justified it");
  await rm(dir, { recursive: true, force: true });
});
