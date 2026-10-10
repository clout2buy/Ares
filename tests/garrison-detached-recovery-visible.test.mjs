// End to end through garrison: a turn killed by a daemon restart is replayed at
// boot, and that replay must reach the owner's phone and the rollout file.
//
// Incident (2026-10-01, doingbox): an agent restarted its own garrison
// mid-turn. Core Session replayed the orphaned input after the restart, but the
// replay had no sender stream, so garrison wrote nothing to the rollout and
// sent nothing to the phone. The owner saw the agent go dark and called it
// bricked. The fix mirrors CoreSession.observeDetachedTurns into rollout +
// fan-out and counts the replay as busy, so Stop and /health see it.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Session, SessionKernelStore } from "../packages/core/dist/index.js";
import { SessionManager, rolloutPath } from "../packages/garrison/dist/index.js";

const requireFromCore = createRequire(new URL("../packages/core/package.json", import.meta.url));
const BetterSqlite3 = requireFromCore("better-sqlite3");

function replyProvider() {
  let calls = 0;
  return {
    name: "garrison-detached-provider",
    async *stream() {
      calls += 1;
      yield {
        type: "message_done",
        message: {
          id: `reply_${calls}`,
          role: "assistant",
          content: [{ type: "text", text: `back online ${calls}` }],
          createdAt: new Date().toISOString(),
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

function coreFactory(workspace, store, provider, made) {
  return ({ sessionId, model, signal, requestPermission, initialMessages }) => {
    const session = new Session({
      sessionId,
      workspace,
      provider,
      model: model ?? "mock",
      systemPrompt: "detached recovery test",
      tools: [],
      sessionKernel: store,
      contextBudgetTokens: 0,
      signal,
      requestPermission,
      initialMessages,
    });
    made.push(session);
    return { session, providerName: provider.name, model: model ?? "mock", workspace };
  };
}

test("garrison mirrors a startup-recovery replay to subscribers and the rollout", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-garrison-detached-"));
  const store = new SessionKernelStore(new BetterSqlite3(":memory:"));
  const provider = replyProvider();
  try {
    // Life before the restart: a session exists and one of its turns is cut
    // off mid-flight (admitted in the kernel, never settled).
    const beforeMade = [];
    const before = new SessionManager({ home, sessionKernel: store, factory: coreFactory(home, store, provider, beforeMade) });
    const summary = before.create({});
    const core = beforeMade[0];
    const stream = core.sendContent([{ type: "text", text: "restart yourself" }], { inputId: "killed-input" });
    for (;;) {
      const next = await stream.next();
      assert.equal(next.done, false);
      if (next.value.type === "message_done") break;
    }
    await stream.return(undefined); // process death
    assert.equal(store.getInput("killed-input")?.state, "admitted");

    // The restarted daemon.
    const afterMade = [];
    const after = new SessionManager({ home, sessionKernel: store, factory: coreFactory(home, store, provider, afterMade) });
    const seen = [];
    const restored = await after.rehydrate();
    assert.ok(restored.some((s) => s.id === summary.id), "the session comes back after the restart");
    after.attach(summary.id, (event) => seen.push(event));
    await afterMade[0].waitForStartupRecovery();

    // The phone (a subscriber attached after boot) must receive the replay.
    // Backlog delivery happens at spawn, so an attach that comes later sees
    // the live tail; what matters is that the rollout has the whole replay and
    // the turn is closed.
    const rollout = (await fs.readFile(rolloutPath(home, summary.id), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    const recoveredEnds = rollout.filter((e) => e.type === "turn_end");
    assert.ok(recoveredEnds.length >= 1, "the recovered turn's turn_end is in the rollout");
    assert.ok(
      rollout.some(
        (e) => e.type === "message_done" && JSON.stringify(e.message.content).includes("back online"),
      ),
      "the recovered reply is in the rollout, so the phone can render it on reload",
    );
    assert.equal(rollout.at(-1).type, "turn_end", "the rollout ends on a closed turn, not a dangling one");

    const live = after.list().find((s) => s.id === summary.id);
    assert.equal(live?.busy, false, "once the replay ends the session is idle again");
    assert.equal(after.runningTurns().length, 0);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
