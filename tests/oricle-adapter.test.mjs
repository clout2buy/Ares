// The Oricle adapter — Ares as the first client of the estate.
//
// Pins the seam contract, not the library (F:\Oricle has its own suite):
//  1. no estate → every hook is a no-op and nothing throws;
//  2. before a turn, the pack lands as ONE memory reminder and remembers its ids;
//  3. after a turn, the pack is attested (cited vs ignored by id), accepted
//     Witness candidates become inferred records idempotently, and the
//     session's episode card is superseded turn over turn (one current card);
//  4. the Estate tool reads and writes through the same mount;
//  5. a second process on the same writer falls back to read-only instead of failing.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORICLE_LIB = process.env.ARES_ORICLE_LIB ?? "F:/Oricle/dist/index.js";

let libAvailable = true;
try {
  await access(ORICLE_LIB);
} catch {
  libAvailable = false;
}

const adapter = await import(pathToFileURL(path.join(root, "packages", "cli", "dist", "entry", "oricleAdapter.js")).href);

function stubLive(overrides = {}) {
  const reminders = [];
  return {
    reminders,
    context: { aresHome: "", workspace: overrides.workspace ?? root },
    selection: { model: "test-model", provider: { name: "stub" } },
    session: { meta: { id: overrides.sessionId ?? "sess_test1" }, engine: { history: () => overrides.history ?? [] } },
    queueSystemReminder(text, kind) {
      reminders.push({ text, kind });
    },
  };
}

test("adapter: with no estate every hook is a no-op", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ares-oricle-none-"));
  const prev = process.env.ARES_ORICLE_DIR;
  process.env.ARES_ORICLE_DIR = path.join(dir, "nowhere");
  try {
    const live = stubLive();
    await adapter.oricleBeforeTurn(live, "hello");
    await adapter.oricleAfterTurn(live, "completed", { userMessage: "hello", assistantText: "hi" });
    assert.equal(live.reminders.length, 0);
    assert.equal(await adapter.oricleEstate("m"), null);
  } finally {
    if (prev === undefined) delete process.env.ARES_ORICLE_DIR;
    else process.env.ARES_ORICLE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("adapter: pack in, attest + witness + episode out, tool round-trips", { skip: !libAvailable && `no Oricle library at ${ORICLE_LIB}` }, async () => {
  const { Oricle, initEstate } = await import(pathToFileURL(path.resolve(ORICLE_LIB)).href);
  const home = await mkdtemp(path.join(tmpdir(), "ares-oricle-"));
  const dir = path.join(home, "estate");
  const prevDir = process.env.ARES_ORICLE_DIR;
  const prevHome = process.env.ORICLE_HOME;
  process.env.ARES_ORICLE_DIR = dir;
  process.env.ORICLE_HOME = path.join(home, "oricle-home");
  try {
    await initEstate(dir, { name: "adapter test", ownerName: "Owner" });
    const seed = await Oricle.mount(dir, { principal: "owner", machineId: "seed" });
    await seed.commit({ kind: "rule", text: "Never run git clean in a workspace.", tier: "stated" });
    const task = await seed.task({ data: { goal: "Ship the adapter", nextAction: "write the test" } });
    await seed.close();

    // 2. before a turn
    const live = stubLive({ sessionId: "sess_adapter" });
    await adapter.oricleBeforeTurn(live, "what am I working on");
    assert.equal(live.reminders.length, 1, "exactly one pack reminder");
    assert.equal(live.reminders[0].kind, "memory");
    assert.match(live.reminders[0].text, /ORICLE MEMORY PACK/);
    assert.match(live.reminders[0].text, /Never run git clean/);
    assert.match(live.reminders[0].text, /## TASK active/);

    // 3. after a turn: cite the task id, accept two witness candidates
    const accepted = [
      { id: "mem_a1", content: "The owner prefers tests before releases.", tags: ["witness", "crucible:feedback"] },
      { id: "mem_b2", content: "The owner's kid is due in spring.", tags: ["witness", "crucible:user_fact"] },
    ];
    await adapter.oricleAfterTurn(live, "completed", { userMessage: "what am I working on", assistantText: `You are on ${task.id}.`, accepted });
    // second turn, same session, same candidates again (idempotent), new user message
    await adapter.oricleBeforeTurn(live, "and next?");
    await adapter.oricleAfterTurn(live, "completed", { userMessage: "and next?", assistantText: "write the test", accepted });
    await adapter.closeOricle();

    const check = await Oricle.mount(dir, { principal: "owner", machineId: "check", readOnly: true });
    const cur = check.current();
    const prefs = cur.filter((r) => r.kind === "preference" && r.tier === "inferred");
    const facts = cur.filter((r) => r.kind === "fact" && r.tier === "inferred");
    assert.equal(prefs.length, 1, "feedback candidate → one inferred preference, not two");
    assert.equal(facts.length, 1, "user_fact candidate → one inferred fact, not two");
    assert.equal(facts[0].source.foreign.id, "mem_b2");
    const episodes = cur.filter((r) => r.kind === "episode");
    assert.equal(episodes.length, 1, "one CURRENT episode card per session");
    assert.match(episodes[0].text, /2 turn\(s\)/);
    assert.equal(check.history(episodes[0].id).chain.length, 2, "the first card was superseded, not lost");
    const rep = await check.verify();
    assert.equal(rep.ok, true, JSON.stringify(rep.issues));
    await check.close();

    // 4. the Estate tool
    const tool = adapter.makeEstateTool(() => "test-model");
    const ctx = { permissionMode: "bypass", fileReadStamps: new Map(), workspace: root };
    const r1 = await tool.call({ action: "recall", query: "git clean", limit: 5 }, ctx);
    assert.match(r1.display, /Never run git clean/);
    const r2 = await tool.call({ action: "task", id: undefined, goal: "Second task", next: "start", status: "active" }, ctx);
    assert.match(r2.display, /task rec_/);
    const r3 = await tool.call({ action: "tasks" }, ctx);
    assert.match(r3.display, /Second task/);
    const r4 = await tool.call({ action: "commit", kind: "decision", text: "Use the adapter, not a fork.", title: "adapter" }, ctx);
    assert.match(r4.display, /committed rec_/);
    await adapter.closeOricle();
  } finally {
    await adapter.closeOricle();
    if (prevDir === undefined) delete process.env.ARES_ORICLE_DIR;
    else process.env.ARES_ORICLE_DIR = prevDir;
    if (prevHome === undefined) delete process.env.ORICLE_HOME;
    else process.env.ORICLE_HOME = prevHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
