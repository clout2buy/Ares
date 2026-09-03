// Memory hygiene (v0.46 batch, item 1a–d).
//
//   a. raw user turns ride the "turn" channel: near-duplicates within 7 days
//      collapse into the existing node (and bump its activation), verbatim
//      repeats collapse at any age, greetings/acks/one-word messages are dropped.
//   b. "what you know" ranks by decayed strength + recency, so a stale
//      high-strength node no longer sticks to the prompt forever.
//   c. the periodic consolidation tick (the ONE scheduler's "consolidate"
//      cadence) runs only past the uptime cadence, only when the store grew,
//      never during a turn, and shares its record across schedulers.
//   d. guest tenants recall from / write to an isolated `guest:<chatId>` scope,
//      never the owner pool — and never leak into the owner's prompt.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryRouter,
  MEMORY_CHANNEL_POLICIES,
  MemoryStore,
  isLowSignalUtterance,
  textSimilarity,
  livenessScore,
  nodesInScope,
  isIsolatedScope,
  turnSimilarityThreshold,
} from "../packages/mind/dist/index.js";
import {
  ReflectionScheduler,
  periodicConsolidationPass,
  resetPeriodicConsolidation,
  markTurnStarted,
  markTurnEnded,
  isAnyTurnActive,
  resetTurnActivity,
} from "../packages/agent/dist/index.js";
import { memoryScopeForTenant, rankLiveMindNodes, loadLiveMindContext } from "../packages/cli/dist/entry/turnPipeline.js";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n, from = Date.now()) => new Date(from - n * DAY);
const makeDir = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-hygiene-"));

// ── a. the turn channel ──────────────────────────────────────────────────────

test("hygiene: the turn channel exists, manual stays ungated", () => {
  assert.equal(MEMORY_CHANNEL_POLICIES.turn.dedupe.kind, "near");
  assert.equal(MEMORY_CHANNEL_POLICIES.turn.lowSignalGate, true);
  assert.equal(MEMORY_CHANNEL_POLICIES.manual.dedupe.kind, "none", "explicit Memory-tool writes stay ungated");
});

test("hygiene: near-duplicate turns collapse into the existing node and bump its activation", async () => {
  const store = MemoryStore.memory();
  const router = new MemoryRouter(store);
  const first = await router.write("turn", [{ kind: "episodic", content: "fix the login bug in auth.ts" }]);
  assert.equal(first.written.length, 1);
  const id = first.written[0].node.id;
  const before = store.get(id).activations;

  const again = await router.write("turn", [{ kind: "episodic", content: "fix the login bug in auth.ts please" }]);
  assert.equal(again.written.length, 0, "the rephrase is not a new node");
  assert.equal(again.skipped[0].reason, "duplicate");
  assert.equal(again.skipped[0].collapsedInto, id, "reports which node it folded into");
  assert.equal(store.count(), 1);
  assert.equal(store.get(id).activations, before + 1, "the existing node was touched");
  assert.ok(store.get(id).strength > 1, "and reinforced");
});

test("hygiene: the 7-day window — an old near-duplicate does not collapse, a verbatim repeat always does", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "episodic", content: "refactor the payment module for stripe", at: daysAgo(10) });
  const router = new MemoryRouter(store);
  const near = await router.write("turn", [{ kind: "episodic", content: "refactor the payment module for stripe now" }]);
  assert.equal(near.written.length, 1, "outside the window a near-match is a fresh episode");
  const verbatim = await router.write("turn", [{ kind: "episodic", content: "Refactor the payment module for Stripe" }]);
  assert.equal(verbatim.written.length, 0, "verbatim (normalized) repeats collapse at any age");
  assert.equal(verbatim.skipped[0].reason, "duplicate");
});

test("hygiene: the salience floor drops greetings, acks, 'ok'/'thanks' and one-word messages", async () => {
  for (const s of ["hi", "hey bro", "ok", "okay thanks", "thanks a lot", "lol", "deploy", "sounds good", "got it"]) {
    assert.ok(isLowSignalUtterance(s), `low signal: ${JSON.stringify(s)}`);
  }
  for (const s of ["thanks for fixing the bug", "deploy the site tonight", "ok now run the tests"]) {
    assert.ok(!isLowSignalUtterance(s), `real signal: ${JSON.stringify(s)}`);
  }
  const store = MemoryStore.memory();
  const report = await new MemoryRouter(store).write("turn", [
    { kind: "episodic", content: "ok" },
    { kind: "episodic", content: "thanks!" },
    { kind: "episodic", content: "hello there" },
    { kind: "episodic", content: "build the dashboard with live charts" },
  ]);
  assert.equal(report.written.length, 1);
  assert.match(report.written[0].input.content, /dashboard/);
  assert.equal(store.count(), 1);
});

test("hygiene: ARES_TURN_MEMORY_SIM tunes the near-dup threshold", async () => {
  const a = "add a dark mode toggle to settings";
  const b = "add a dark mode toggle to the settings page";
  const sim = textSimilarity(a, b);
  assert.ok(sim > 0.6 && sim < 0.95, `fixture similarity should be mid-range, got ${sim}`);
  const prev = process.env.ARES_TURN_MEMORY_SIM;
  try {
    process.env.ARES_TURN_MEMORY_SIM = "0.99";
    assert.equal(turnSimilarityThreshold(), 0.99);
    const strict = MemoryStore.memory();
    await strict.add({ kind: "episodic", content: a });
    const r1 = await new MemoryRouter(strict).write("turn", [{ kind: "episodic", content: b }]);
    assert.equal(r1.written.length, 1, "at 0.99 the variant is a new node");

    process.env.ARES_TURN_MEMORY_SIM = String(Math.max(0.5, sim - 0.05));
    const loose = MemoryStore.memory();
    await loose.add({ kind: "episodic", content: a });
    const r2 = await new MemoryRouter(loose).write("turn", [{ kind: "episodic", content: b }]);
    assert.equal(r2.written.length, 0, "below the measured similarity it collapses");
  } finally {
    if (prev === undefined) delete process.env.ARES_TURN_MEMORY_SIM;
    else process.env.ARES_TURN_MEMORY_SIM = prev;
  }
});

// ── b. decayed ranking ───────────────────────────────────────────────────────

const node = (over) => ({
  v: 3, id: over.id, kind: "semantic", content: over.content, at: over.at, strength: over.strength,
  activations: 0, lastActivatedAt: over.last ?? over.at, links: [], scope: over.scope,
});

test("hygiene: 'what you know' ranks by liveness, not raw strength", async () => {
  const now = new Date("2026-09-01T12:00:00Z");
  const stale = node({ id: "stale", content: "Old fact hammered in March", strength: 40, at: daysAgo(150, now.getTime()).toISOString() });
  const fresh = node({ id: "fresh", content: "Learned this yesterday", strength: 1, at: daysAgo(1, now.getTime()).toISOString() });
  assert.ok(stale.strength > fresh.strength, "raw strength would rank the stale node first");
  assert.ok(livenessScore(fresh, now) > livenessScore(stale, now), "liveness ranks the fresh node first");
  assert.deepEqual(rankLiveMindNodes([stale, fresh], now).map((n) => n.id), ["fresh", "stale"]);

  // End to end through loadLiveMindContext on a real file.
  const home = await makeDir();
  const memoryFile = path.join(home, "memory.jsonl");
  await fs.writeFile(memoryFile, [stale, fresh].map((n) => JSON.stringify(n)).join("\n") + "\n");
  const block = await loadLiveMindContext({ home, aresHome: home, workspace: home, mind: { memoryFile } });
  assert.ok(block.indexOf("Learned this yesterday") < block.indexOf("Old fact hammered in March"), `fresh first:\n${block}`);
});

// ── c. the periodic consolidation tick ───────────────────────────────────────

function fakeStore(initialCount) {
  let count = initialCount;
  const consolidations = [];
  return {
    get consolidations() { return consolidations; },
    grow(n) { count += n; },
    count: () => count,
    async consolidate({ now }) {
      consolidations.push(now.getTime());
      count = Math.max(0, count - 2);
      return { pruned: 2, deduped: 0, promoted: [], kept: count };
    },
  };
}

test("hygiene: the tick consolidates on cadence, only when the store grew, never mid-turn", async () => {
  resetPeriodicConsolidation();
  resetTurnActivity();
  const store = fakeStore(50);
  let locks = 0;
  const t0 = Date.parse("2026-09-01T00:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const pass = periodicConsolidationPass({
    memoryFile: "fake://memory-a",
    everyMs: 90 * 60 * 1000,
    minNewNodes: 5,
    openStore: async () => store,
    lock: async (_file, fn) => { locks++; return fn(); },
    startedAt: t0,
  });
  const scheduler = new ReflectionScheduler({ setInterval: () => ({}), clearInterval: () => {} })
    .register("consolidate", "periodic-consolidate", pass);
  const fire = async (at) => (await scheduler.fire("consolidate", { now: new Date(at) }))[0].result.directives[0];

  assert.match(await fire(t0 + HOUR), /cadence/, "before 90 minutes of uptime: nothing");
  assert.match(await fire(t0 + 2 * HOUR), /^consolidated/, "first eligible tick on a non-trivial store runs");
  assert.equal(store.consolidations.length, 1);
  assert.equal(locks, 1, "ran under the consolidation lock");

  assert.match(await fire(t0 + 4 * HOUR), /quiet/, "no growth since → skipped");
  store.grow(3);
  assert.match(await fire(t0 + 6 * HOUR), /quiet/, "3 new < floor of 5 → skipped");
  store.grow(4);
  markTurnStarted();
  assert.ok(isAnyTurnActive());
  assert.match(await fire(t0 + 8 * HOUR), /turn-active/, "a live turn defers the tick");
  markTurnEnded();
  assert.match(await fire(t0 + 8 * HOUR + 1), /^consolidated/, "grown past the floor and idle → runs");
  assert.equal(store.consolidations.length, 2);
  assert.match(await fire(t0 + 9 * HOUR), /cadence/, "the anchor moved: 90 minutes from the last run");
});

test("hygiene: two schedulers in one process share the record — one window, one consolidation", async () => {
  resetPeriodicConsolidation();
  resetTurnActivity();
  const store = fakeStore(40);
  const opts = { memoryFile: "fake://memory-b", everyMs: 1000, minNewNodes: 1, openStore: async () => store, lock: async (_f, fn) => fn(), startedAt: 0 };
  const a = new ReflectionScheduler({ setInterval: () => ({}), clearInterval: () => {} }).register("consolidate", "c", periodicConsolidationPass(opts));
  const b = new ReflectionScheduler({ setInterval: () => ({}), clearInterval: () => {} }).register("consolidate", "c", periodicConsolidationPass(opts));
  await a.fire("consolidate", { now: new Date(5000) });
  await b.fire("consolidate", { now: new Date(5001) });
  assert.equal(store.consolidations.length, 1, "the second session's tick skipped on the shared cadence");
});

test("hygiene: the scheduler owns the consolidation timer (start/stop, injectable clock)", () => {
  const intervals = [];
  let cleared = 0;
  const scheduler = new ReflectionScheduler({
    setInterval: (fn, ms) => { intervals.push(ms); return { fn, ms }; },
    clearInterval: () => { cleared++; },
  });
  scheduler.startConsolidation(90 * 60_000);
  assert.deepEqual(intervals, [90 * 60_000]);
  assert.equal(scheduler.consolidationRunning, true);
  scheduler.startConsolidation(0);
  assert.equal(scheduler.consolidationRunning, false, "0 disables");
  assert.equal(cleared, 1);
  scheduler.startConsolidation(60_000);
  scheduler.stop();
  assert.equal(scheduler.consolidationRunning, false);
  assert.equal(cleared, 2);
});

// ── d. guest scope isolation ─────────────────────────────────────────────────

test("hygiene: tenant → scope mapping", () => {
  assert.equal(memoryScopeForTenant(undefined), "owner");
  assert.equal(memoryScopeForTenant({ role: "owner" }), "owner");
  assert.equal(memoryScopeForTenant({ role: "guest", chatId: 4242, name: "Sam" }), "guest:4242");
  assert.ok(isIsolatedScope("guest:4242"));
  assert.ok(!isIsolatedScope("owner"));
});

test("hygiene: a guest scope never recalls the owner pool, and the owner never sees guest nodes", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "The owner's Stripe account balance is private business data" });
  await store.add({ kind: "semantic", content: "Sam likes hiking on weekends and asked about trail maps", scope: "guest:4242" });

  const guest = await store.remember("stripe account balance business", { scope: "guest:4242" });
  assert.ok(guest.every((r) => r.node.scope === "guest:4242"), "guest recall is confined to its own nodes");
  assert.ok(!guest.some((r) => /Stripe/.test(r.node.content)));

  const guestPeek = store.peek("hiking trail maps", { scope: "guest:4242" });
  assert.ok(guestPeek.some((r) => /hiking/.test(r.node.content)), "guest sees its own memories");

  const owner = await store.remember("hiking trail maps weekends", { scope: "owner" });
  assert.ok(!owner.some((r) => r.node.scope === "guest:4242"), "owner recall excludes guest nodes");

  assert.deepEqual(nodesInScope(store.all(), "guest:4242").map((n) => n.scope), ["guest:4242"]);
  assert.equal(rankLiveMindNodes(store.all(), new Date()).some((n) => n.scope === "guest:4242"), false, "guest nodes never reach the owner's prompt");
});

test("hygiene: guest turn writes land in the guest scope and dedupe only within it", async () => {
  const store = MemoryStore.memory();
  const router = new MemoryRouter(store);
  await router.write("turn", [{ kind: "episodic", content: "plan the product launch for october" }]);
  const guest = await router.write("turn", [{ kind: "episodic", content: "plan the product launch for october", scope: "guest:7" }]);
  assert.equal(guest.written.length, 1, "the same words from a guest are the guest's own node, not a collapse into the owner's");
  assert.equal(guest.written[0].node.scope, "guest:7");
  assert.equal(store.all().filter((n) => n.scope === undefined).length, 1);
  assert.equal(store.all().filter((n) => n.scope === undefined)[0].activations, 0, "the owner's node was not touched");
});
