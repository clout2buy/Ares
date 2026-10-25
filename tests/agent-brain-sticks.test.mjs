// An agent's chat runs on the agent's brain — no matter which of the three
// pickers the owner touched last.
//
// Field log 2026-10-25 (another user's export, 4,209 lines): a DeepSeek agent
// chat showed `model pinned · deepseek/deepseek-flash` followed within the
// same second by `routing_mode_set · engine_config_set · reasoning_set ·
// model pinned · ollama/glm-5.3-flash`, thirteen times. Every model_switch
// rewrote the DAEMON DEFAULT and the desktop replayed that default (Settings:
// Ollama) back onto the agent's chat. Turns then died on an unreachable
// Ollama with nothing on screen.
//
// Pinned here, against the built daemon over its real stdio protocol:
//   1. model_switch aimed at an agent's chat changes THAT AGENT's brain
//      (saved on its profile) and leaves the owner's default alone.
//   2. model_switch with no session (Settings → "New agents start with")
//      changes the default and leaves every agent's brain alone.
//   3. A turn on the agent's chat runs on the agent's brain.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");
const START_TIMEOUT_MS = 90_000;
const REPLY_TIMEOUT_MS = 30_000;

async function startDaemon() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-brain-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-brain-ws-"));
  const child = spawn(process.execPath, [ENTRY, "daemon", "--json"], {
    cwd: workspace,
    env: { ...process.env, ARES_HOME: home, ARES_PROVIDER: "mock", ARES_MODEL: "mock-default", ARES_AGENT_ENABLED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const events = () => stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const waitFor = async (pred, ms = REPLY_TIMEOUT_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(0, 400)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
  return { send, events, waitFor, stderr: () => stderr, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

test("an agent's brain sticks: pickers change the agent, Settings changes the default, turns run on the agent's brain", async (t) => {
  try { await access(ENTRY); } catch { t.skip("packages/cli/dist not built — run pnpm build"); return; }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());

  const ready = await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", START_TIMEOUT_MS);
  assert.ok(ready, `daemon announced itself. stderr: ${daemon.stderr().slice(0, 600)}`);

  daemon.send({ type: "agent_create", agent: { name: "Bob", emoji: "💸", color: "#4cd28a", provider: "mock", model: "mock-bob", instructions: "Finance guy.", rules: ["Always answer in one line."] } });
  const created = await daemon.waitFor((e) => e.type === "agent_created");
  assert.ok(created, "agent_created");
  const bobId = created.agent.id;
  assert.equal(created.agent.model, "mock-bob");

  const chat = "sess_bob_chat";
  daemon.send({ type: "agent_bind", sessionId: chat, agentId: bobId });
  const bound = await daemon.waitFor((e) => e.type === "agent_bound" && e.sessionId === chat);
  assert.ok(bound, "agent_bound");

  // 1. The picker under the input bar, while talking to Bob.
  daemon.send({ type: "model_switch", provider: "mock", model: "mock-bob-two", sessionId: chat });
  const switched = await daemon.waitFor((e) => e.type === "model_switched" && e.sessionId === chat);
  assert.ok(switched, `model_switched for the agent chat: ${JSON.stringify(daemon.events().filter((e) => /model_switch/.test(e.type)))}`);
  assert.equal(switched.model, "mock-bob-two");
  assert.equal(switched.agentId, bobId, "the switch names the agent it changed");
  const updated = await daemon.waitFor((e) => e.type === "agent_updated" && e.agent.id === bobId && e.agent.model === "mock-bob-two");
  assert.ok(updated, "Bob's profile now carries the new brain");

  // 2. Settings → "New agents start with": the default lane, nobody's chat.
  daemon.send({ type: "model_switch", provider: "mock", model: "mock-new-default" });
  const defaultSwitched = await daemon.waitFor((e) => e.type === "model_switched" && e.model === "mock-new-default");
  assert.ok(defaultSwitched, "the default lane switched");
  assert.equal(defaultSwitched.agentId, undefined, "the default switch is nobody's agent");
  daemon.send({ type: "agents_list" });
  await new Promise((r) => setTimeout(r, 400));
  const lists = daemon.events().filter((e) => e.type === "agents_list");
  const bobNow = lists.at(-1)?.agents?.find((a) => a.id === bobId);
  assert.equal(bobNow?.model, "mock-bob-two", "Bob kept his brain through the default change");

  // 3. A turn on Bob's chat runs on Bob's brain, not the default.
  daemon.send({ type: "send", goal: "hi", sessionId: chat });
  const ended = await daemon.waitFor((e) => e.type === "turn_end" && e.sessionId === chat, 60_000);
  assert.ok(ended, "the turn ended");
  const route = daemon.events().filter((e) => e.sessionId === chat && (e.type === "route_resolved" || e.type === "turn_start")).at(-1);
  const turnModel = route?.model ?? daemon.events().filter((e) => e.sessionId === chat && e.model).at(-1)?.model;
  assert.equal(turnModel, "mock-bob-two", `the turn ran on Bob's brain: ${JSON.stringify(daemon.events().filter((e) => e.sessionId === chat && e.model).map((e) => [e.type, e.model]))}`);
  assert.ok(!daemon.events().some((e) => e.sessionId === chat && e.model === "mock-new-default"), "the default never reached Bob's chat");
});
