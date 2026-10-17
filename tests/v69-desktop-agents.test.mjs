// Desktop agents — "Instead of new chats it will be agents, the same as the
// iOS app, still with the Forge and all abilities. Each agent: different
// memories, different forges, different models." (owner, 2026-10-17)
//
// Pinned here:
//   1. An agent is a Persona: the desktop directory reads and writes the same
//      <home>/personas the phone uses, and desktop chats live in their own
//      desktopThreads field (never the phone's one garrison thread).
//   2. Binding a chat routes it to the agent everywhere: memory scope,
//      Forge studio ids, and the prompt layer naming its role and contacts.
//   3. An agent's memory sees the owner's shared memories and its own —
//      never another agent's; the owner pool never sees an agent's.
//   4. Agent-to-agent texts are fire-and-acknowledge, land in the
//      recipient's newest chat, and a pair is rate-capped (no ping-pong).
//   5. Agents may create agents; deleting is owner-only and keeps the chats.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PersonaStore } from "../packages/cli/dist/personas.js";
import { DesktopAgents, PAIR_TEXT_LIMIT, agentTextGoal } from "../packages/cli/dist/entry/daemon/agents.js";
import { agentOfSession, agentStudioId, agentMemoryScope, setAgentsHost } from "../packages/cli/dist/entry/agentScope.js";
import { memoryScopeForTenant } from "../packages/cli/dist/entry/turnPipeline.js";
import { makeAgentsTool } from "../packages/cli/dist/entry/agentsTool.js";
import { desktopAgentLayerBlock } from "../packages/cli/dist/entry/prompt/texting.js";
import { nodesInScope, OWNER_SCOPE } from "../packages/mind/dist/index.js";

async function harness() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-agents-"));
  const delivered = [];
  const events = [];
  const busy = new Set();
  const agents = new DesktopAgents({
    home,
    defaultBrain: () => ({ provider: "anthropic", model: "claude-test" }),
    deliver: (sessionId, goal, inputId) => delivered.push({ sessionId, goal, inputId }),
    busy: (sid) => busy.has(sid),
    emit: (e) => events.push(e),
  });
  await agents.load();
  return { home, agents, delivered, events, busy };
}

test("an agent is a persona on disk, with desktop chats kept apart from the phone thread", async () => {
  const { home, agents, events } = await harness();
  const bob = await agents.create({ name: "Bob", emoji: "💸", color: "#4cd28a", instructions: "Finance guy." });
  assert.equal(bob.provider, "anthropic");
  assert.equal(bob.model, "claude-test");
  assert.equal(bob.sessionId, "");
  assert.ok(events.some((e) => e.type === "agents_list"));

  await agents.bind(bob.id, "sess_a");
  await agents.bind(bob.id, "sess_b");
  const phone = new PersonaStore(home);
  await phone.load();
  const onDisk = phone.get(bob.id);
  assert.deepEqual(onDisk.desktopThreads, ["sess_a", "sess_b"]);
  assert.equal(onDisk.sessionId, "", "the phone thread is untouched");
  assert.equal(phone.byDesktopThread("sess_b").id, bob.id);
  assert.equal(phone.bySession("sess_b"), undefined, "a desktop chat is never mistaken for the garrison thread");

  await assert.rejects(agents.create({ name: "bob" }), /already an agent/);
  await assert.rejects(agents.create({ name: "Ares" }), /default agent/);
});

test("binding a chat routes memory, the Forge and the prompt layer to the agent", async () => {
  const { agents } = await harness();
  const ava = await agents.create({ name: "Ava", instructions: "Game developer. Builds in the Forge." });
  const rex = await agents.create({ name: "Rex", instructions: "Senior engineer." });
  await agents.bind(ava.id, "sess_ava");
  assert.equal(agentOfSession("sess_ava"), ava.id);
  assert.equal(agentStudioId("sess_ava", "car"), `${ava.id.replace(/^p_/, "")}-car`);
  assert.equal(agentStudioId("sess_plain", "car"), "car", "plain Ares keeps the old studio ids");
  assert.equal(memoryScopeForTenant({ role: "owner", agent: ava.id }), agentMemoryScope(ava.id));
  assert.equal(memoryScopeForTenant({ role: "owner" }), OWNER_SCOPE);

  const layer = agents.layerFor(ava.id);
  assert.match(layer, /You are Ava/);
  assert.match(layer, /Game developer/);
  assert.match(layer, /- Rex — Senior engineer/);
  assert.doesNotMatch(layer, /- Ava —/, "an agent is not its own contact");
  assert.equal(agents.layerFor(undefined), "");

  // Handing the chat back to Ares unbinds everything.
  await agents.bind(null, "sess_ava");
  assert.equal(agentOfSession("sess_ava"), undefined);
  assert.deepEqual(agents.get(ava.id).desktopThreads, []);
  void rex;
});

test("an agent's memory: the owner's shared pool plus its own, never another agent's", () => {
  const nodes = [
    { id: "1", content: "owner unscoped" },
    { id: "2", content: "owner stamped", scope: OWNER_SCOPE },
    { id: "3", content: "ava private", scope: "agent:p_ava000" },
    { id: "4", content: "rex private", scope: "agent:p_rex000" },
    { id: "5", content: "guest", scope: "guest:42" },
  ];
  const ids = (scope) => nodesInScope(nodes, scope).map((n) => n.id).sort();
  assert.deepEqual(ids("agent:p_ava000"), ["1", "2", "3"]);
  assert.deepEqual(ids("agent:p_rex000"), ["1", "2", "4"]);
  assert.deepEqual(ids(OWNER_SCOPE), ["1", "2"], "the owner chat never recalls an agent's private memories");
});

test("agents text each other: fire-and-acknowledge into the newest chat, rate-capped per pair", async () => {
  const { agents, delivered, events, busy } = await harness();
  const penny = await agents.create({ name: "Penny", instructions: "Finance." });
  const atlas = await agents.create({ name: "Atlas", instructions: "Research." });
  await agents.bind(penny.id, "sess_penny");

  // Atlas has no chat yet: the text opens one for them.
  const first = await agents.text("sess_penny", "atlas", "Is the 2nd Spotify a Duo plan?", false);
  assert.equal(first.to.id, atlas.id);
  assert.equal(agentOfSession(first.threadId), atlas.id);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessionId, first.threadId);
  assert.equal(delivered[0].goal, agentTextGoal("Penny", "Is the 2nd Spotify a Duo plan?", false));
  assert.match(delivered[0].goal, /^\[text from Penny\] /);
  const shown = events.find((e) => e.type === "agent_text");
  assert.equal(shown.sender.name, "Penny");
  assert.equal(shown.threadId, first.threadId);

  // A reply goes to Penny's newest chat.
  const back = await agents.text(first.threadId, "Penny", "Yes — safe to cancel.", false);
  assert.equal(back.threadId, "sess_penny");

  // Busy + not urgent waits; urgent goes now.
  busy.add("sess_penny");
  const before = delivered.length;
  await agents.text(first.threadId, "Penny", "urgent one", true);
  assert.equal(delivered.length, before + 1, "urgent texts are not held back");

  await assert.rejects(agents.text("sess_penny", "Penny", "hi me", false), /that is you/);
  await assert.rejects(agents.text("sess_penny", "Nobody", "hi", false), /no agent called/);
  for (let i = 1; i < PAIR_TEXT_LIMIT; i++) await agents.text("sess_penny", "Atlas", `ping ${i}`, true);
  await assert.rejects(agents.text("sess_penny", "Atlas", "one too many", true), /wait for their reply/);
});

test("the Agents tool: list, text and create — but never delete", async () => {
  const { agents } = await harness();
  const maker = await agents.create({ name: "Forge", instructions: "Game dev." });
  await agents.bind(maker.id, "sess_forge");
  setAgentsHost(agents.host());
  try {
    const tool = makeAgentsTool();
    const listed = await tool.call({ action: "list" }, { sessionId: "sess_forge" });
    assert.equal(listed.output.self.name, "Forge");
    const made = await tool.call({ action: "create", name: "Muse", role: "Designer for my games." }, { sessionId: "sess_forge" });
    assert.equal(made.output.agent.name, "Muse");
    assert.equal(agents.get(made.output.agent.id).createdBy, maker.id);
    assert.match(agents.layerFor(made.output.agent.id), /Forge \(another agent\) created you/);
    const texted = await tool.call({ action: "text", to: "Muse", message: "Need a logo." }, { sessionId: "sess_forge" });
    assert.equal(texted.output.ok, true);
    assert.throws(() => tool.inputZod.parse({ action: "delete", to: "Muse" }));

    // Owner delete keeps the chats (they fall back to plain Ares).
    const threads = await agents.remove(maker.id);
    assert.deepEqual(threads, ["sess_forge"]);
    assert.equal(agentOfSession("sess_forge"), undefined);
  } finally {
    setAgentsHost(undefined);
  }
});

test("the desktop agent layer keeps the working voice and names the texting protocol", () => {
  const block = desktopAgentLayerBlock({ name: "Ava", instructions: "Designer." }, [{ name: "Rex", role: "Engineer" }]);
  assert.match(block, /on their desktop/);
  assert.match(block, /every Ares tool — the Forge/);
  assert.match(block, /\[text from <name>\]/);
  assert.doesNotMatch(block, /texting them from their phone/);
});
