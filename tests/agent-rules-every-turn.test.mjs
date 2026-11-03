// An agent's standing rules are facts, not background: they reach the model
// on EVERY turn of that agent — in the system prompt (unbudgeted, like
// LAWS.md) and restated in the turn's own reminder — and they are still there
// after the conversation is compacted.
//
// Owner, 2026-10-20: "I give it a rule... they can't really persist, and it
// doesn't remember. They don't recognize the group chats at all." 2026-10-25:
// "assigned roles AND rules dont really seem to be facts". Pinned here against
// the built daemon over its real stdio protocol, reading what the mock
// provider actually received (ARES_MOCK_REQUEST_LOG).
//
// Also pinned: the phone/Telegram persona layer carries the same rules (it
// used to carry only the role, so a rule set on the desktop did not exist
// when the same agent answered on the phone).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "packages", "cli", "dist", "entry.js");
const START_TIMEOUT_MS = 90_000;
const RULE = "Always sign off with the word PINEAPPLE.";

async function startDaemon(extraEnv = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ares-rules-home-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ares-rules-ws-"));
  const requestLog = path.join(home, "mock-requests.jsonl");
  const child = spawn(process.execPath, [ENTRY, "daemon", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      ARES_HOME: home,
      ARES_PROVIDER: "mock",
      ARES_MODEL: "mock-default",
      ARES_AGENT_ENABLED: "1",
      ARES_REFLECT: "0",
      ARES_SELFTEST_DAILY: "0",
      ARES_MOCK_REQUEST_LOG: requestLog,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const events = () => stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const waitFor = async (pred, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`daemon exited early (code ${child.exitCode}): ${stderr.slice(0, 400)}`);
      const hit = events().find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  };
  const requests = async () =>
    (await readFile(requestLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const send = (command) => child.stdin.write(JSON.stringify(command) + "\n");
  return { send, events, waitFor, requests, stderr: () => stderr, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

/** Every text-ish block of the LAST user message (reminders included). */
function lastUserText(request) {
  const user = [...request.messages].reverse().find((m) => m.role === "user");
  return (user?.content ?? []).map((b) => b.text ?? "").join("\n");
}

async function turn(daemon, sessionId, goal, n) {
  daemon.send({ type: "send", goal, sessionId });
  const ended = await daemon.waitFor((e) => e.type === "turn_end" && e.sessionId === sessionId && daemon.events().filter((x) => x.type === "turn_end" && x.sessionId === sessionId).length >= n, 60_000);
  assert.ok(ended, `turn ${n} ended`);
}

test("an agent's rule reaches the model on every turn, and still after compaction", async (t) => {
  try { await access(ENTRY); } catch { t.skip("packages/cli/dist not built — run pnpm build"); return; }
  // A small budget so a few long turns force a real compaction.
  const daemon = await startDaemon({ ARES_CONTEXT_BUDGET: "9000" });
  t.after(() => daemon.stop());
  assert.ok(await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", START_TIMEOUT_MS), `daemon up. stderr: ${daemon.stderr().slice(0, 600)}`);

  daemon.send({ type: "agent_create", agent: { name: "Rex", provider: "mock", model: "mock-rex", instructions: "Fruit stand manager.", rules: [RULE] } });
  const created = await daemon.waitFor((e) => e.type === "agent_created");
  assert.ok(created, "agent_created");
  const chat = "sess_rex_chat";
  daemon.send({ type: "agent_bind", sessionId: chat, agentId: created.agent.id });
  assert.ok(await daemon.waitFor((e) => e.type === "agent_bound" && e.sessionId === chat), "agent_bound");

  await turn(daemon, chat, "hello rex", 1);
  let reqs = (await daemon.requests()).filter((r) => r.model === "mock-rex");
  assert.ok(reqs.length >= 1, "the turn reached the mock provider on Rex's brain");
  const first = reqs.at(-1);
  assert.ok(first.system.includes(RULE), "the rule is in the system prompt (the unbudgeted agent layer)");
  assert.ok(lastUserText(first).includes(RULE), "the rule is restated in the turn's own reminder");

  // Grow the conversation past the budget until the engine compacts.
  const filler = "the quick brown fox jumps over the lazy dog while counting apples and pears. ".repeat(110);
  let n = 1;
  for (let i = 0; i < 8 && !daemon.events().some((e) => e.sessionId === chat && e.type === "compaction"); i++) {
    n += 1;
    await turn(daemon, chat, `inventory note ${i}: ${filler}`, n);
  }
  assert.ok(daemon.events().some((e) => e.sessionId === chat && e.type === "compaction"), `the conversation was compacted: ${JSON.stringify(daemon.events().filter((e) => e.sessionId === chat).map((e) => e.type).slice(-30))}`);

  n += 1;
  await turn(daemon, chat, "what are your rules?", n);
  reqs = (await daemon.requests()).filter((r) => r.model === "mock-rex");
  const after = reqs.at(-1);
  assert.ok(after.system.includes(RULE), "after compaction the rule is still in the system prompt");
  assert.ok(lastUserText(after).includes(RULE), "after compaction the rule is still restated on the turn");
  // Every TURN request carried it (the compaction summarizer is a separate
  // one-shot call with its own prompt, not a turn of Rex).
  const turnReqs = reqs.filter((r) => !r.system.startsWith("You are compacting"));
  assert.ok(turnReqs.length >= n, `one request per turn at least (${turnReqs.length} for ${n} turns)`);
  for (const r of turnReqs) assert.ok(r.system.includes(RULE), `every turn request carried the rule: ${r.system.slice(0, 200)}`);
});

test("in a room seat, the agent is told which group chat it is in and keeps its rules", async (t) => {
  try { await access(ENTRY); } catch { t.skip("packages/cli/dist not built — run pnpm build"); return; }
  const daemon = await startDaemon();
  t.after(() => daemon.stop());
  assert.ok(await daemon.waitFor((e) => e.type === "daemon_ready" || e.type === "ready", START_TIMEOUT_MS), `daemon up. stderr: ${daemon.stderr().slice(0, 600)}`);

  daemon.send({ type: "agent_create", agent: { name: "Rex", provider: "mock", model: "mock-rex", instructions: "Fruit stand manager.", rules: [RULE] } });
  const created = await daemon.waitFor((e) => e.type === "agent_created");
  assert.ok(created, "agent_created");
  daemon.send({ type: "room_create", room: { name: "Fruit Council", purpose: "Plan the summer fruit stand.", agents: [created.agent.id] } });
  const room = await daemon.waitFor((e) => e.type === "room_created");
  assert.ok(room, "room_created");
  daemon.send({ type: "room_post", roomId: room.room.id, text: "@Rex what is the plan?" });
  const summoned = await daemon.waitFor((e) => e.type === "room_turn" && e.roomId === room.room.id);
  assert.ok(summoned, "Rex was summoned to his seat");
  assert.ok(await daemon.waitFor((e) => e.type === "turn_end" && e.sessionId === summoned.sessionId, 60_000), "the seat's turn ended");
  const req = (await daemon.requests()).filter((r) => r.model === "mock-rex" || r.system.includes("Fruit Council")).at(-1);
  assert.ok(req, "the seat turn reached the provider");
  assert.ok(req.system.includes(RULE), "the rule rides the seat's system prompt");
  assert.ok(req.system.includes("Fruit Council"), "the room layer rides the seat's system prompt");
  const reminder = lastUserText(req);
  assert.ok(reminder.includes(RULE), "the rule is restated on the seat's turn");
  assert.match(reminder, /group chat "Fruit Council" \(what it is for: Plan the summer fruit stand\.\)/, "the turn names the group and its purpose");
});

test("the phone/Telegram persona layer carries the agent's standing rules", async () => {
  const { personaLayerBlock, sessionPromptLayers } = await import(pathToFileURL(path.join(REPO, "packages", "cli", "dist", "entry", "prompt", "texting.js")).href);
  const layer = personaLayerBlock({ name: "Rex", instructions: "Fruit stand manager.", rules: [RULE] });
  assert.match(layer, /Your standing rules/);
  assert.ok(layer.includes(`- ${RULE}`));
  assert.ok(sessionPromptLayers("telegram", { name: "Rex", instructions: "x", rules: [RULE] }).includes(RULE), "telegram threads carry it");
  assert.doesNotMatch(personaLayerBlock({ name: "Rex", instructions: "x" }), /standing rules/, "no rules, no block");
});
