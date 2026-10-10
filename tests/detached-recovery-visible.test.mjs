// A turn replayed by startup recovery must be visible to the host.
//
// Incident (2026-10-01, doingbox): a garrison restart killed an agent mid-turn.
// Core Session replayed the orphaned input at boot, but that replay has no
// sender stream, so garrison never wrote it to the rollout or fanned it out to
// the phone. The owner saw no reply and no end of turn for the whole replay,
// and called the agent bricked. observeDetachedTurns is the hook garrison now
// mirrors, so these tests pin its contract: every replay event is delivered,
// including the ones emitted before the host could subscribe, and a replay
// that fails still delivers a closing turn_end.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadSessionSnapshot, Session, SessionKernelStore } from "../packages/core/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function replyProvider(counter, failFirst = 0) {
  return {
    name: "detached-visible-provider",
    async *stream() {
      counter.calls += 1;
      if (counter.calls <= failFirst) throw new Error(`simulated provider failure ${counter.calls}`);
      yield {
        type: "message_done",
        message: {
          id: `reply_${counter.calls}`,
          role: "assistant",
          content: [{ type: "text", text: `recovered ${counter.calls}` }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function orphanAndRestart(name, provider) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `ares-${name}-`));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const options = { workspace, provider, model: "mock", systemPrompt: "test", tools: [], sessionKernel: store, contextBudgetTokens: 0 };
  const first = new Session({ ...options, sessionId: name });
  const stream = first.sendContent([{ type: "text", text: "do the thing" }], { inputId: `${name}-input` });
  for (;;) {
    const next = await stream.next();
    assert.equal(next.done, false);
    if (next.value.type === "message_done") break;
  }
  // Process death mid-turn: the turn never committed its turn_end.
  await stream.return(undefined);
  assert.equal(store.getInput(`${name}-input`)?.state, "admitted");

  const snapshot = await loadSessionSnapshot(workspace, name, { maxMessages: 10_000 });
  const restarted = new Session({
    ...options,
    sessionMeta: snapshot.meta,
    initialMessages: snapshot.messages,
    initialTodos: snapshot.todos,
    initialSeq: snapshot.nextSeq,
  });
  return { restarted, workspace };
}

test("a startup-recovery replay reaches the host, including events emitted before it subscribed", async () => {
  const counter = { calls: 0 };
  const { restarted, workspace } = await orphanAndRestart("detached-visible", replyProvider(counter));
  try {
    // Let the replay run to completion BEFORE subscribing: this is the
    // constructor-then-await window garrison actually has.
    await restarted.waitForStartupRecovery();
    const seen = [];
    restarted.observeDetachedTurns((event) => seen.push(event));
    const types = seen.map((e) => e.type);
    assert.ok(types.includes("turn_start"), `expected turn_start in ${types.join(",")}`);
    assert.ok(types.includes("message_done"), "the replayed reply must be delivered");
    const end = seen.filter((e) => e.type === "turn_end");
    assert.equal(end.length, 1, "exactly one turn_end closes the replay");
    assert.equal(end[0].status, "completed");
    assert.equal(types.at(-1), "turn_end");

    // Backlog is handed over once, not replayed to every later subscriber.
    const later = [];
    restarted.observeDetachedTurns((event) => later.push(event));
    assert.equal(later.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a live subscriber sees the replay stream as it happens", async () => {
  const counter = { calls: 0 };
  const { restarted, workspace } = await orphanAndRestart("detached-live", replyProvider(counter));
  try {
    const seen = [];
    restarted.observeDetachedTurns((event) => seen.push(event));
    await restarted.waitForStartupRecovery();
    assert.equal(seen.filter((e) => e.type === "turn_end").length, 1);
    assert.ok(seen.some((e) => e.type === "message_done"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a replay that fails still closes the turn on every surface", async () => {
  // Same shape as the poison-orphan incident: the original run fails and is
  // requeued, then the boot replay fails too (provider outage).
  const counter = { calls: 0 };
  const provider = replyProvider(counter, 2);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-detached-fail-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const options = { workspace, provider, model: "mock", systemPrompt: "test", tools: [], sessionKernel: store, contextBudgetTokens: 0 };
  try {
    const first = new Session({ ...options, sessionId: "detached-fail" });
    for await (const _ of first.sendContent([{ type: "text", text: "doomed" }], { inputId: "detached-fail-input" })) { /* drain */ }
    assert.equal(store.getInput("detached-fail-input")?.state, "admitted");
    const snapshot = await loadSessionSnapshot(workspace, "detached-fail", { maxMessages: 10_000 });
    const restarted = new Session({
      ...options,
      sessionMeta: snapshot.meta,
      initialMessages: snapshot.messages,
      initialTodos: snapshot.todos,
      initialSeq: snapshot.nextSeq,
    });
    await assert.rejects(restarted.waitForStartupRecovery(), /ended failed/);
    const seen = [];
    restarted.observeDetachedTurns((event) => seen.push(event));
    const ends = seen.filter((e) => e.type === "turn_end");
    assert.ok(ends.length >= 1, "a failed replay must still emit turn_end");
    assert.equal(seen.at(-1).type, "turn_end");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
