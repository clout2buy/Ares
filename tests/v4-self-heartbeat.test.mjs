// Verifies reflection is wired into the autonomous loops:
//   1. Heartbeat with no HEARTBEAT.md tasks still alerts on a broken skill.
//   2. Heartbeat stays "skipped" when the self-model is healthy and no tasks.
//   3. DEEP dream surfaces self-directives and counts them in its report.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runHeartbeatTick,
  runDeepDream,
  recordOutcome,
  defaultAgentConfig,
} from "../packages/agent/dist/index.js";

async function makeTmp(prefix = "ares-hb-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const NOON = new Date("2026-05-28T12:00:00");

test("heartbeat alerts on a broken skill even with no HEARTBEAT.md tasks", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-hb-ws-");
  const config = defaultAgentConfig(home);
  // an always-fail skill -> prune directive (severity high)
  for (let i = 0; i < 3; i++) await recordOutcome(home, { id: "skill/bad", kind: "skill", name: "bad", ok: false, error: "explodes" });

  const r = await runHeartbeatTick({ home, workspace, config, now: NOON });
  assert.equal(r.status, "alert");
  assert.match(r.text, /Self-directive/);
  assert.match(r.text, /bad/);
});

test("heartbeat stays skipped when self is healthy and no tasks", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-hb-ws-");
  const config = defaultAgentConfig(home);
  for (let i = 0; i < 3; i++) await recordOutcome(home, { id: "skill/good", kind: "skill", name: "good", ok: true, ms: 5 });

  const r = await runHeartbeatTick({ home, workspace, config, now: NOON });
  assert.equal(r.status, "skipped");
});

test("DEEP dream surfaces self-directives in its report", async () => {
  const home = await makeTmp();
  const workspace = await makeTmp("ares-hb-ws-");
  const config = defaultAgentConfig(home);
  for (let i = 0; i < 3; i++) await recordOutcome(home, { id: "skill/leak", kind: "skill", name: "leak", ok: false, error: "drip" });

  const r = await runDeepDream({ home, workspace, config });
  assert.equal(r.phase, "deep");
  assert.match(r.report, /self-directive/);

  const diary = await fs.readFile(path.join(home, "DREAMS.md"), "utf8");
  assert.match(diary, /Self-reflection/);
  assert.match(diary, /leak/);
});
