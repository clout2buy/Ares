// Empty sessions: lazy creation + the registry prune.
//   1. SessionManager.create() writes NO meta.json until the first send; an
//      unsent session archived or rehydrated leaves no record behind.
//   2. pruneEmptySessions moves ONLY entries with no transcript anywhere, no
//      messages, no title, older than the minimum age — and keeps everything
//      it cannot prove empty. It never deletes, writes a ledger, and a second
//      run is a no-op.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager, pruneEmptySessions, prunedSessionsDir } from "../packages/garrison/dist/index.js";
import { QueryEngine, MockEchoProvider } from "../packages/core/dist/index.js";

function makeFactory(workspace) {
  return ({ sessionId, model, signal, requestPermission }) => {
    const engine = QueryEngine.forTesting(
      { provider: new MockEchoProvider(), model: model ?? "mock", systemPrompt: "lazy test", tools: [], workspace, signal, requestPermission },
      sessionId,
    );
    return { engine, providerName: "mock-echo", model: model ?? "mock", workspace };
  };
}

const exists = (p) => fs.stat(p).then(() => true, () => false);
const sessionsDir = (home) => path.join(home, "garrison", "sessions");
const metaOf = (home, id) => path.join(sessionsDir(home), `${id}.meta.json`);

test("create() writes no registry entry until the first owner message", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-"));
  const m = new SessionManager({ home, factory: makeFactory(home), audit: false });
  const blank = m.create({ surface: "desktop", tenant: { role: "owner" } });
  const used = m.create({ surface: "desktop", tenant: { role: "owner" } });
  await m.flush();
  assert.equal(await exists(metaOf(home, blank.id)), false, "an untouched session has no meta.json");
  assert.ok(m.has(blank.id), "but it is live and attachable");

  await m.send(used.id, "hello there");
  await m.flush();
  const meta = JSON.parse(await fs.readFile(metaOf(home, used.id), "utf8"));
  assert.equal(meta.title, "hello there");
  assert.equal(meta.surface, "desktop");

  assert.equal(await m.archive(blank.id), true);
  await m.flush();
  assert.equal(await exists(metaOf(home, blank.id)), false, "archiving a never-used session writes no record");

  // A fresh manager rehydrates only what was written: the used session.
  const m2 = new SessionManager({ home, factory: makeFactory(home), audit: false });
  const back = await m2.rehydrate();
  assert.deepEqual(back.map((s) => s.id), [used.id]);
});

test("rehydrating a session with no events does not (re)write its meta.json", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-lazy-rehydrate-"));
  await fs.mkdir(sessionsDir(home), { recursive: true });
  await fs.writeFile(path.join(sessionsDir(home), "sess_emptyrollout.jsonl"), "");
  const m = new SessionManager({ home, factory: makeFactory(home), audit: false });
  await m.rehydrate();
  await m.flush();
  assert.equal(await exists(metaOf(home, "sess_emptyrollout")), false);
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-02T12:00:00Z");
const OLD = new Date(NOW - 3 * DAY);

async function writeMeta(home, id, meta, { mtime = OLD } = {}) {
  const file = metaOf(home, id);
  await fs.writeFile(file, typeof meta === "string" ? meta : JSON.stringify(meta));
  await fs.utimes(file, mtime, mtime);
}

test("pruneEmptySessions moves only provably empty, old, untitled entries — and is idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-prune-"));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "ares-prune-ws-"));
  await fs.mkdir(sessionsDir(home), { recursive: true });
  const base = { provider: "anthropic", model: "m", workspace: ws, createdAt: OLD.toISOString(), surface: "desktop", tenant: { role: "owner" } };
  const untitled = (id) => ({ id, title: "untitled session", ...base });

  // Prunable
  await writeMeta(home, "sess_nojsonl", untitled("sess_nojsonl"));
  await writeMeta(home, "sess_emptyjsonl", untitled("sess_emptyjsonl"));
  await fs.writeFile(path.join(sessionsDir(home), "sess_emptyjsonl.jsonl"), "");
  await writeMeta(home, "sess_blanklines", untitled("sess_blanklines"));
  await fs.writeFile(path.join(sessionsDir(home), "sess_blanklines.jsonl"), "\n\r\n  \n");
  await writeMeta(home, "sess_emptywsdir", untitled("sess_emptywsdir"));
  await fs.mkdir(path.join(ws, ".ares", "sessions", "sess_emptywsdir"), { recursive: true });
  await fs.writeFile(path.join(ws, ".ares", "sessions", "sess_emptywsdir", "events.jsonl"), "");
  await writeMeta(home, "sess_notitle", { id: "sess_notitle", ...base });
  await writeMeta(home, "sess_archived", { ...untitled("sess_archived"), archived: true });

  // Must be kept
  await writeMeta(home, "sess_rollout", untitled("sess_rollout"));
  await fs.writeFile(path.join(sessionsDir(home), "sess_rollout.jsonl"), JSON.stringify({ ts: "x", event: { type: "turn_start" } }) + "\n");
  await writeMeta(home, "sess_titled", { ...base, id: "sess_titled", title: "fix the build" });
  await writeMeta(home, "sess_young", { ...untitled("sess_young"), createdAt: new Date(NOW - 60_000).toISOString() });
  await writeMeta(home, "sess_touched", untitled("sess_touched"), { mtime: new Date(NOW - 60_000) });
  await writeMeta(home, "sess_nocreated", { id: "sess_nocreated", title: "untitled session", workspace: ws });
  await writeMeta(home, "sess_wstranscript", untitled("sess_wstranscript"));
  await fs.mkdir(path.join(ws, ".ares", "sessions", "sess_wstranscript"), { recursive: true });
  await fs.writeFile(path.join(ws, ".ares", "sessions", "sess_wstranscript", "events.jsonl"), "{}\n");
  await writeMeta(home, "sess_kernel", untitled("sess_kernel"));
  await writeMeta(home, "sess_kernelthrows", untitled("sess_kernelthrows"));
  await writeMeta(home, "sess_corrupt", "{not json");
  await writeMeta(home, "sess_live", untitled("sess_live"));

  const hasContent = (id) => {
    if (id === "sess_kernel") return true;
    if (id === "sess_kernelthrows") throw new Error("kernel locked");
    return false;
  };
  const report = await pruneEmptySessions({ home, now: () => NOW, minAgeMs: DAY, liveIds: new Set(["sess_live"]), hasContent });
  const expected = ["sess_archived", "sess_blanklines", "sess_emptyjsonl", "sess_emptywsdir", "sess_nojsonl", "sess_notitle"];
  assert.deepEqual([...report.pruned].sort(), expected);

  for (const id of expected) {
    assert.equal(await exists(metaOf(home, id)), false, `${id} left the registry`);
    assert.equal(await exists(path.join(prunedSessionsDir(home), `${id}.meta.json`)), true, `${id} was moved, not deleted`);
  }
  assert.equal(await exists(path.join(prunedSessionsDir(home), "sess_emptyjsonl.jsonl")), true, "its empty rollout moved with it");
  for (const id of ["sess_rollout", "sess_titled", "sess_young", "sess_touched", "sess_nocreated", "sess_wstranscript", "sess_kernel", "sess_kernelthrows", "sess_corrupt", "sess_live"]) {
    assert.equal(await exists(metaOf(home, id)), true, `${id} must be kept`);
  }
  assert.equal(await exists(path.join(sessionsDir(home), "sess_rollout.jsonl")), true, "a rollout with content is never moved");
  assert.equal(await exists(path.join(ws, ".ares", "sessions", "sess_wstranscript", "events.jsonl")), true);

  const ledger = (await fs.readFile(path.join(prunedSessionsDir(home), "ledger.jsonl"), "utf8")).trim().split("\n");
  assert.equal(ledger.length, expected.length);

  const before = (await fs.readdir(sessionsDir(home))).sort();
  const again = await pruneEmptySessions({ home, now: () => NOW, minAgeMs: DAY, liveIds: new Set(["sess_live"]), hasContent });
  assert.deepEqual(again.pruned, [], "a second run finds nothing");
  assert.deepEqual((await fs.readdir(sessionsDir(home))).sort(), before, "and changes nothing");
});

test("pruneEmptySessions: dry run changes nothing; a missing sessions dir is fine", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-prune-dry-"));
  assert.deepEqual((await pruneEmptySessions({ home, now: () => NOW })).pruned, []);
  await fs.mkdir(sessionsDir(home), { recursive: true });
  await writeMeta(home, "sess_x", { id: "sess_x", title: "untitled session", createdAt: OLD.toISOString() });
  const r = await pruneEmptySessions({ home, now: () => NOW, minAgeMs: DAY, dryRun: true });
  assert.deepEqual(r.pruned, ["sess_x"]);
  assert.equal(await exists(metaOf(home, "sess_x")), true);
});
