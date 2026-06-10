// V6 — consequence wiring. Strength stops meaning "often recalled" and starts
// meaning "present when reality moved": wins reinforce, losses weaken — no
// matter how often the memory is recalled in between.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryStore, currentStrength } from "../packages/mind/dist/index.js";

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-consequence-"));
  const store = await MemoryStore.open(path.join(dir, "memory.jsonl"));
  return { dir, store };
}

test("a win reinforces and appends evidence with the note and fingerprint", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({ kind: "semantic", content: "the dev server runs on port 1420" });
  const before = currentStrength(store.get(node.id), new Date());

  const touched = await store.recordOutcome([node.id], {
    won: true,
    note: "in play for a turn that completed",
    fingerprint: "fp_abc123",
  });
  assert.equal(touched, 1);

  const after = store.get(node.id);
  assert.ok(currentStrength(after, new Date()) > before, "win raised strength");
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].won, true);
  assert.equal(after.evidence[0].fingerprint, "fp_abc123");
  await rm(dir, { recursive: true, force: true });
});

test("losses decay strength even while the memory keeps being recalled", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({ kind: "semantic", content: "deploys are safe to run on fridays" });
  const start = currentStrength(store.get(node.id), new Date());

  for (let i = 0; i < 3; i++) {
    // The memory keeps surfacing (recall reinforces it a little)…
    await store.remember("deploys fridays safe");
    // …but every turn it rides keeps failing.
    await store.recordOutcome([node.id], { won: false, note: `turn ${i} failed` });
  }

  const after = store.get(node.id);
  assert.ok(
    currentStrength(after, new Date()) < start,
    "three losses out-debit three recall bumps — popularity does not save a wrong memory",
  );
  assert.equal(after.evidence.length, 3);
  assert.ok(after.evidence.every((e) => e.won === false));
  await rm(dir, { recursive: true, force: true });
});

test("evidence is capped at 20 entries, newest kept", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({ kind: "procedural", content: "use the retry helper for flaky api calls" });
  for (let i = 0; i < 25; i++) {
    await store.recordOutcome([node.id], { won: true, note: `outcome ${i}` });
  }
  const after = store.get(node.id);
  assert.equal(after.evidence.length, 20);
  assert.equal(after.evidence.at(-1).note, "outcome 24");
  assert.equal(after.evidence[0].note, "outcome 5");
  await rm(dir, { recursive: true, force: true });
});

test("unknown ids are ignored; nothing persists when nothing matched", async () => {
  const { dir, store } = await makeStore();
  const touched = await store.recordOutcome(["mem_nope", "mem_missing"], { won: true, note: "x" });
  assert.equal(touched, 0);
  await rm(dir, { recursive: true, force: true });
});

test("setStatus moves a candidate through the lifecycle and records the reason", async () => {
  const { dir, store } = await makeStore();
  const node = await store.add({
    kind: "semantic",
    content: "the smoke suite needs the daemon built first",
    status: "candidate",
    check: { type: "command", cmd: "node --version" },
  });
  assert.equal(store.candidates().length, 1);

  const confirmed = await store.setStatus(node.id, "confirmed", "trial passed: probe met twice");
  assert.equal(confirmed.status, "confirmed");
  assert.equal(store.candidates().length, 0);
  assert.match(confirmed.evidence.at(-1).note, /trial passed/);

  const demoted = await store.setStatus(node.id, "candidate", "probe started failing after the rebrand");
  assert.equal(demoted.status, "candidate");
  assert.equal(demoted.evidence.at(-1).won, false);
  await rm(dir, { recursive: true, force: true });
});

test("crucible fields round-trip through persistence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-consequence-"));
  const file = path.join(dir, "memory.jsonl");
  {
    const store = await MemoryStore.open(file);
    const node = await store.add({
      kind: "semantic",
      content: "the gateway listens on 7421 by default",
      status: "candidate",
      check: { type: "command", cmd: "node -e 1", expect: "" },
    });
    await store.recordOutcome([node.id], { won: true, note: "health probe answered" });
  }
  {
    const store = await MemoryStore.open(file);
    const [node] = store.all();
    assert.equal(node.status, "candidate");
    assert.equal(node.check.type, "command");
    assert.equal(node.evidence.length, 1);
    assert.equal(node.v, 3);
  }
  await rm(dir, { recursive: true, force: true });
});
