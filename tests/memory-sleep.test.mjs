// Field report 2026-11-06: "it was remembering things not necessary, and not
// compacting memory along with the session". A store that only slept when the
// daemon exited grew for months. Now it has a cap, the weakest go first, and
// the daemon sleeps it when the conversation compacts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore, maxMemoryNodes } from "../packages/mind/dist/index.js";

test("past the cap, sleep forgets the weakest and keeps synthesized insight", async () => {
  process.env.ARES_MIND_MAX_NODES = "60";
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "ares-sleep-")), "memory.md");
  const store = await MemoryStore.open(file);
  for (let i = 0; i < 90; i++) await store.add({ kind: "semantic", content: `durable fact number ${i} about the owner's setup` });
  const insight = await store.add({ kind: "semantic", content: "the owner prefers short answers", source: "synthesis" });
  assert.equal(store.all().length, 91);
  const report = await store.consolidate();
  assert.ok(report.pruned >= 31, `pruned ${report.pruned}`);
  assert.ok(store.all().length <= 60, `kept ${store.all().length}`);
  assert.ok(store.all().some((n) => n.id === insight.id), "synthesis survives the cap");
  delete process.env.ARES_MIND_MAX_NODES;
  assert.equal(maxMemoryNodes(), 600);
});

test("the daemon sleeps memory on compaction, throttled, and only ever on exit before", async () => {
  const daemon = await readFile(new URL("../packages/cli/src/entry/daemon.ts", import.meta.url), "utf8");
  const branch = daemon.slice(daemon.indexOf('event.type === "compaction"'), daemon.indexOf('event.type === "turn_end"'));
  assert.match(branch, /sleepMemoryAfterCompaction\(\)/);
  assert.match(daemon, /MEMORY_SLEEP_EVERY_MS = 10 \* 60 \* 1000/);
  assert.match(daemon, /REFLECT_EVERY\) \|\| 6\)/, "reflection runs every 6 turns, not 3");
  assert.match(daemon, /REFLECT_MAX_FACTS = 3/);
});

test("project state fades once nothing recalls it; who the owner is does not", async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), "ares-fade-")), "memory.md");
  const store = await MemoryStore.open(file);
  const stale = await store.add({ kind: "semantic", content: "the owner is rebuilding the theater panel this week", tags: ["type:project"] });
  const identity = await store.add({ kind: "semantic", content: "the owner is called Noah and works nights", tags: ["type:user"] });
  const later = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000);
  await store.consolidate({ now: later });
  const ids = new Set(store.all().map((n) => n.id));
  assert.ok(!ids.has(stale.id), "stale project state is gone");
  assert.ok(ids.has(identity.id), "the owner's identity stays");
});
