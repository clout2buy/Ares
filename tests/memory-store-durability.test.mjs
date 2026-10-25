// Memory store durability — the four data-loss bugs (issues #23-#26):
//   #25 a malformed line, or an unreadable file, must never cost the memories
//       around it: bad lines are skipped and counted (loading continues), an
//       unreadable file makes the store refuse to write (never overwrite what
//       it could not read).
//       Same contract for the agent's JSON vector fallback.
//   #24 concurrent writers each re-read + merge under a file lock, so N
//       parallel adds all survive; the lock is truly exclusive and a directory
//       or future-mtime lock path is stale, not a deadlock.
//   #23 a 0-hit recall never persists; a long-lived holder (the Mnemosyne
//       server) refresh()es from disk and merges on write, so it can never
//       wipe what landed since it opened.
//   #26 consolidate() dedupes WITHIN a scope; the keeper prefers confirmed
//       over candidate and semantic over episodic.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

import { MemoryStore, withConsolidationLock, withFileLock } from "../packages/mind/dist/index.js";
import { createMemoryStore, loadAgentConfig } from "../packages/agent/dist/index.js";

const execFileAsync = promisify(execFile);
const makeDir = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-store-dur-"));
const readLines = async (file) => (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
const contentsOf = (store) => store.all().map((n) => n.content).sort();
const node = (id, content, extra = {}) => ({
  v: 3, id, kind: "semantic", content, at: "2026-10-01T00:00:00.000Z", strength: 1, activations: 0,
  lastActivatedAt: "2026-10-01T00:00:00.000Z", links: [], ...extra,
});

// ── #25 loader ───────────────────────────────────────────────────────────────

test("#25: malformed lines are skipped and counted; every good line after them loads and survives a write", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  await fs.writeFile(file, [
    JSON.stringify(node("mem_a", "alpha fact")),
    "null",
    "{}",
    '"x"',
    "[1,2]",
    '{"id":"mem_half","kind":"semantic","content":"half-writ',
    JSON.stringify(node("mem_b", "beta fact")),
    JSON.stringify(node("mem_c", "gamma fact")),
  ].join("\n") + "\n");

  const store = await MemoryStore.open(file);
  assert.deepEqual(contentsOf(store), ["alpha fact", "beta fact", "gamma fact"], "loading continued past every bad line");
  assert.equal(store.loadReport.malformed, 5, "each unparseable / non-node line was counted");
  assert.equal(store.readOnly, false);

  await store.add({ kind: "episodic", content: "delta fact" });
  const reopened = await MemoryStore.open(file);
  assert.deepEqual(contentsOf(reopened), ["alpha fact", "beta fact", "delta fact", "gamma fact"], "nothing good was lost by the write");
  const lines = await readLines(file);
  assert.equal(lines.length, 4, "torn/foreign lines are not carried forward; every persisted line parses");
  for (const line of lines) JSON.parse(line);
});

test("#25: an unreadable memory file opens READ-ONLY and refuses to overwrite", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  // A directory where the file should be: readFile fails with EISDIR, which is
  // NOT "no memory yet" — the old loader's catch-all treated it as empty and
  // the next write replaced it.
  await fs.mkdir(file);
  const store = await MemoryStore.open(file);
  assert.equal(store.readOnly, true);
  assert.match(store.loadReport.unreadable, /EISDIR|illegal operation|directory/i);
  assert.equal(store.count(), 0);
  await assert.rejects(() => store.add({ kind: "semantic", content: "must not land" }), /refusing to write memory/);
  assert.ok((await fs.stat(file)).isDirectory(), "the path was left exactly as it was");
});

test("#25: a missing file is the ONLY thing that means an empty store", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const store = await MemoryStore.open(file);
  assert.equal(store.readOnly, false);
  await store.add({ kind: "semantic", content: "first" });
  assert.deepEqual(contentsOf(await MemoryStore.open(file)), ["first"]);
});

test("#25 (agent JSON fallback): a corrupt vectors file is read as empty but never written over", async () => {
  const home = await makeDir();
  const config = await loadAgentConfig(home);
  // Point the sqlite path at a directory so better-sqlite3 fails and the JSON
  // fallback is the backend under test.
  const dbDir = path.join(home, "db-as-dir");
  await fs.mkdir(dbDir, { recursive: true });
  const jsonFile = path.join(home, "vectors.json");
  config.memory.dbPath = dbDir;
  config.memory.jsonFallbackPath = jsonFile;
  await fs.writeFile(jsonFile, '{"version":1,"memories":[{"id":1,"category":"fact","content":"keep me"');
  const store = await createMemoryStore(config, home);
  assert.equal(store.status().backend, "json");
  assert.deepEqual(await store.list(), [], "a corrupt file reads as empty");
  await assert.rejects(() => store.add({ category: "fact", content: "clobber" }), /refusing to write memory/);
  assert.match(await fs.readFile(jsonFile, "utf8"), /keep me/, "the corrupt file was not replaced");

  // Fixed on disk → writes flow again.
  await fs.writeFile(jsonFile, '{"version":1,"memories":[]}\n');
  const entry = await store.add({ category: "fact", content: "now it lands" });
  assert.equal(entry.content, "now it lands");
  assert.equal((await store.list()).length, 1);
});

// ── #24 concurrent writers ───────────────────────────────────────────────────

test("#24: eight stores adding in parallel from one file all survive", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const seed = await MemoryStore.open(file);
  await seed.add({ kind: "semantic", content: "seed" });

  const stores = await Promise.all(Array.from({ length: 8 }, () => MemoryStore.open(file)));
  await Promise.all(stores.map((s, i) => s.add({ kind: "episodic", content: `mem-${i}` })));

  const final = await MemoryStore.open(file);
  assert.deepEqual(contentsOf(final), ["mem-0", "mem-1", "mem-2", "mem-3", "mem-4", "mem-5", "mem-6", "mem-7", "seed"]);
  assert.equal((await readLines(file)).length, 9, "one line per node, no duplicates");
  assert.equal(await fs.readdir(dir).then((names) => names.filter((n) => n.endsWith(".lock")).length), 0, "every lock released");
});

test("#24: eight PROCESSES adding in parallel (the `ares mind add` repro) all survive", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const dist = path.resolve("packages/mind/dist/index.js");
  const script = `
    import { MemoryStore } from ${JSON.stringify(new URL(`file:///${dist.replace(/\\/g, "/")}`).href)};
    const store = await MemoryStore.open(process.argv[1]);
    await store.add({ kind: "episodic", content: "mem-" + process.argv[2] });
  `;
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    execFileAsync(process.execPath, ["--input-type=module", "-e", script, file, String(i)], { env: { ...process.env } })));
  const final = await MemoryStore.open(file);
  assert.deepEqual(contentsOf(final), Array.from({ length: 8 }, (_, i) => `mem-${i}`));
});

test("#24: a write from a stale snapshot keeps a sibling's add AND honours the sibling's forget", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const a = await MemoryStore.open(file);
  const kept = await a.add({ kind: "semantic", content: "kept" });
  const doomed = await a.add({ kind: "semantic", content: "doomed" });

  const b = await MemoryStore.open(file);
  await b.add({ kind: "semantic", content: "from b" });
  await b.forget(doomed.id);

  // `a` still holds its boot snapshot (kept + doomed). Its next write merges.
  await a.add({ kind: "semantic", content: "from a" });
  assert.deepEqual(contentsOf(await MemoryStore.open(file)), ["from a", "from b", "kept"]);
  assert.ok(a.get(kept.id), "a's own view converged too");
  assert.equal(a.get(doomed.id), undefined, "a learned that b forgot it");
});

test("#24: a directory or future-dated file at the lock path is stale, never a deadlock", async () => {
  const dir = await makeDir();
  const memoryFile = path.join(dir, "memory.jsonl");
  await fs.mkdir(path.join(dir, ".consolidation.lock"));
  assert.equal(await withConsolidationLock(memoryFile, async () => "ran"), "ran", "a directory at the lock path is stolen");

  const lockFile = path.join(dir, ".consolidation.lock");
  await fs.writeFile(lockFile, "1 x\n");
  const future = new Date(Date.now() + 24 * 60 * 60_000);
  await fs.utimes(lockFile, future, future);
  assert.equal(await withConsolidationLock(memoryFile, async () => "ran again"), "ran again", "a future mtime is stolen");

  // A LIVE lock is still respected — the fix did not make every lock stealable.
  await fs.writeFile(lockFile, "1 x\n");
  assert.equal(await withConsolidationLock(memoryFile, async () => "wrong"), undefined);
  await fs.unlink(lockFile);
});

test("#24: the write lock is exclusive — two waiters never run the critical section together", async () => {
  const dir = await makeDir();
  const memoryFile = path.join(dir, "memory.jsonl");
  let inside = 0;
  let maxInside = 0;
  const work = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 15));
    inside--;
  };
  await Promise.all(Array.from({ length: 6 }, () => withFileLock(memoryFile, work)));
  assert.equal(maxInside, 1);
});

// ── #23 the long-lived holder ────────────────────────────────────────────────

test("#23: a 0-hit recall from a stale snapshot leaves the file untouched", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const server = await MemoryStore.open(file); // opened at "boot", before anything existed
  const cli = await MemoryStore.open(file);
  await cli.add({ kind: "semantic", content: "written after the server booted" });
  const before = await fs.stat(file);
  const raw = await fs.readFile(file, "utf8");

  const hits = await server.remember("zzz qqq nothing matches this");
  assert.equal(hits.length, 0);
  assert.equal(await fs.readFile(file, "utf8"), raw, "0 hits → not one byte written");
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test("#23: a HIT recall from a stale snapshot merges — the sibling's memories survive the reinforce", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const server = await MemoryStore.open(file);
  await server.add({ kind: "semantic", content: "the deploy script lives in scripts/release.mjs" });
  const cli = await MemoryStore.open(file);
  await cli.add({ kind: "semantic", content: "the owner prefers pnpm over npm" });

  const hits = await server.remember("where is the deploy script");
  assert.ok(hits.length >= 1);
  assert.deepEqual(contentsOf(await MemoryStore.open(file)), [
    "the deploy script lives in scripts/release.mjs",
    "the owner prefers pnpm over npm",
  ]);
});

test("#23: refresh() picks up what another process wrote, without losing unpersisted local changes", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "memory.jsonl");
  const server = await MemoryStore.open(file);
  assert.equal(await server.refresh(), false, "nothing changed yet");
  const cli = await MemoryStore.open(file);
  await cli.add({ kind: "semantic", content: "from the cli" });
  assert.equal(await server.refresh(), true);
  assert.deepEqual(contentsOf(server), ["from the cli"]);
  assert.equal(await server.refresh(), false, "stamp recorded — a second refresh is a no-op");
  assert.deepEqual(server.peek("from the cli").map((r) => r.node.content), ["from the cli"], "a recall now sees it");
});

// ── #26 scope-aware dedupe ───────────────────────────────────────────────────

test("#26: consolidate never merges the same content across tenant scopes", async () => {
  const store = MemoryStore.memory();
  await store.add({ kind: "semantic", content: "My favourite colour is blue" });
  await store.add({ kind: "semantic", content: "my favourite colour is blue", scope: "guest:4242" });
  await store.add({ kind: "semantic", content: "My favourite colour is  blue ", scope: "guest:9999" });
  await store.add({ kind: "semantic", content: "MY FAVOURITE COLOUR IS BLUE", scope: "guest:4242" });

  const report = await store.consolidate();
  assert.equal(report.deduped, 1, "only the two guest:4242 twins merged");
  const scopes = store.all().map((n) => n.scope ?? "<owner>").sort();
  assert.deepEqual(scopes, ["<owner>", "guest:4242", "guest:9999"], "every tenant kept its own node");
});

test("#26: the keeper prefers confirmed over candidate, and semantic over episodic", async () => {
  const store = MemoryStore.memory();
  const candidate = await store.add({ kind: "semantic", content: "Tests run with node --test", status: "candidate", strength: 9 });
  const confirmed = await store.add({ kind: "semantic", content: "tests run with node --test", status: "confirmed", strength: 1 });
  let report = await store.consolidate();
  assert.equal(report.deduped, 1);
  assert.ok(store.get(confirmed.id), "the confirmed node is the keeper despite being weaker");
  assert.equal(store.get(candidate.id), undefined);
  assert.equal(store.get(confirmed.id).status, "confirmed");

  const store2 = MemoryStore.memory();
  const episode = await store2.add({ kind: "episodic", content: "The build uses tsc -b", strength: 9 });
  const fact = await store2.add({ kind: "semantic", content: "the build uses tsc -b", strength: 1 });
  report = await store2.consolidate();
  assert.equal(report.deduped, 1);
  assert.ok(store2.get(fact.id), "the semantic node is the keeper despite being weaker");
  assert.equal(store2.get(episode.id), undefined);
  assert.equal(store2.get(fact.id).kind, "semantic");
  assert.equal(store2.get(fact.id).strength, 10, "strength still pooled from the merged twin");
});
