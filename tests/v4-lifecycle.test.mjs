import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  beforeAgentFinalizeSignal,
  defaultAgentConfig,
  emitLifecycle,
  onLifecycle,
  proposeSkills,
  recordToolPattern,
  createMemoryStore,
  runDeepDream,
  runHeartbeatTick,
  runLightDream,
  runRemDream,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "ares-v4-life-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("V4 V3: lifecycle bus emits heartbeat and dream events", () => {
  const seen = [];
  const off = onLifecycle((event) => seen.push(event.type));
  emitLifecycle({ type: "heartbeat_tick", reason: "test" });
  emitLifecycle({ type: "dream_phase_started", phase: "light" });
  off();
  emitLifecycle({ type: "dream_phase_ended", phase: "light", promoted: 0, pruned: 0 });

  assert.deepEqual(seen, ["heartbeat_tick", "dream_phase_started"]);
});

test("V4 V3: heartbeat skips empty HEARTBEAT.md and alerts on configured task", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-heartbeat-workspace-");
  const config = defaultAgentConfig(home);
  await fs.writeFile(path.join(home, "HEARTBEAT.md"), "# empty\n", "utf8");
  const skipped = await runHeartbeatTick({ home, workspace, config, now: new Date("2026-05-28T14:00:00Z") });
  assert.equal(skipped.status, "skipped");

  await fs.writeFile(path.join(home, "HEARTBEAT.md"), "- Check custom thing\n", "utf8");
  const alert = await runHeartbeatTick({ home, workspace, config, now: new Date("2026-05-28T14:00:00Z") });
  assert.equal(alert.status, "alert");
  assert.match(alert.text, /custom thing/);
});

test("V4 V4: LIGHT dreaming stages durable session signals", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-dream-workspace-");
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  const transcript = path.join(workspace, "events.jsonl");
  await fs.writeFile(
    transcript,
    JSON.stringify({
      event: {
        type: "turn_start",
        userMessage: { content: [{ type: "text", text: "Remember: use pnpm verify before done." }] },
      },
    }) + "\n",
    "utf8",
  );

  const result = await runLightDream({ home, workspace, sessionId: "sess_test", transcriptPath: transcript, config });

  assert.equal(result.phase, "light");
  assert.equal(result.promoted, 1);
  assert.match(await fs.readFile(path.join(home, "DREAMS.md"), "utf8"), /LIGHT staged/);
});

test("V4 V6: self-revise signal fires when tools errored", () => {
  const signal = beforeAgentFinalizeSignal([{ type: "tool_error", error: "boom" }]);
  assert.equal(signal.shouldRevise, true);
  assert.match(signal.reason, /tool error/);
});

test("V4 V7: DEEP dreaming promotes memories and reinforced SELF rules into SOUL.md", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-v4-deep-workspace-");
  const config = defaultAgentConfig(home);
  config.memory.dimensions = 32;
  config.dreaming.minRecallCount = 2;
  config.dreaming.soulRewriteThreshold = 3;
  await fs.writeFile(path.join(home, "SOUL.md"), "# SOUL.md - Who I Am\n\n## Learned Rules\n", "utf8");
  const store = await createMemoryStore(config, home);
  const self = await store.add({ category: "SELF", workspace, content: "Never use emoji in commits.", score: 0.9, embeddingDim: 32 });
  self.hits = 3;
  await store.update(self);
  await store.add({ category: "PROJECT", workspace, content: "Use pnpm verify.", score: 0.9, embeddingDim: 32, source: "light-dreaming" });

  const result = await runDeepDream({ home, workspace, config });

  assert.equal(result.phase, "deep");
  assert.match(await fs.readFile(path.join(home, "MEMORY.md"), "utf8"), /Use pnpm verify/);
  assert.match(await fs.readFile(path.join(home, "SOUL.md"), "utf8"), /Never use emoji in commits/);
});

test("V4 V8: REM dreaming writes cross-workspace scan report", async () => {
  const home = await makeTmp();
  const config = defaultAgentConfig(home);
  await fs.mkdir(path.join(home, "memory"), { recursive: true });
  await fs.writeFile(path.join(home, "memory", "2026-05-28.md"), "- Use pnpm verify.\n", "utf8");

  const result = await runRemDream({ home, config, now: new Date("2026-05-31T05:00:00Z") });

  assert.equal(result.phase, "rem");
  assert.match(await fs.readFile(path.join(home, "DREAMS.md"), "utf8"), /REM scanned 1 daily memory/);
});

test("V4 V9: repeated tool patterns propose markdown-only skills", async () => {
  const home = await makeTmp();
  const now = new Date("2026-05-28T12:00:00Z");
  for (let i = 0; i < 5; i++) {
    await recordToolPattern({ home, key: "format-after-edit", description: "Run formatter after edits.", now });
  }

  const proposals = await proposeSkills({ home, now, minHits: 5 });

  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].approved, false);
  assert.match(await fs.readFile(proposals[0].path, "utf8"), /markdown-only|proposed/i);
});
