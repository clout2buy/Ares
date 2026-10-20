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
import { MemoryStore, nodesInScope, OWNER_SCOPE } from "../packages/mind/dist/index.js";
import { agentMemories, exportAgentMemory, forgetAgentMemory, handMemories } from "../packages/cli/dist/entry/agentMemory.js";

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

// A 1x1 PNG — the smallest real image the avatar store accepts.
const PNG_1PX = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");

test("profile pictures: the phone's avatar store, set by the owner or by the agent itself", async () => {
  const { home, agents } = await harness();
  const ava = await agents.create({ name: "Ava", instructions: "Designer." });
  await agents.bind(ava.id, "sess_ava");
  assert.equal(agents.list()[0].avatar, undefined);

  const version = await agents.setAvatar(ava.id, `data:image/png;base64,${PNG_1PX.toString("base64")}`);
  assert.ok(version);
  assert.equal(agents.list().find((a) => a.id === ava.id).avatar, version, "the list carries the version");
  const data = await agents.avatarData(ava.id);
  assert.match(data.image, /^data:image\/png;base64,/);
  // Same file the phone's /gateway/avatar/<id> serves.
  assert.ok((await fs.readdir(path.join(home, "phone", "avatars"))).includes(`${ava.id}.png`));

  // SVG (or anything that is not JPEG/PNG/WebP) is refused: it can carry script.
  await assert.rejects(agents.setAvatar(ava.id, Buffer.from("<svg onload=alert(1)>")), /JPEG, PNG or WebP/);
  await assert.rejects(agents.setAvatar("p_nobody00000", PNG_1PX), /unknown agent/);

  // The agent sets its own picture through the Agents tool.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-pic-"));
  await fs.writeFile(path.join(dir, "me.png"), PNG_1PX);
  setAgentsHost(agents.host());
  try {
    const out = await makeAgentsTool().call({ action: "avatar", image: "me.png" }, { sessionId: "sess_ava", workspace: dir });
    assert.equal(out.output.agent.name, "Ava");
  } finally {
    setAgentsHost(undefined);
  }

  await agents.setAvatar(ava.id, null);
  assert.equal(await agents.avatarData(ava.id), null);
  await agents.setAvatar(ava.id, PNG_1PX);
  await agents.remove(ava.id);
  assert.equal(await agents.avatarData(ava.id), null, "deleting an agent drops its picture");
});

test("memory hand-off: copy from Ares or an agent, by topic or all, export, forget — never another agent's by asking", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-mem-"));
  const memoryFile = path.join(dir, "memory.jsonl");
  const store = await MemoryStore.open(memoryFile);
  await store.add({ kind: "semantic", content: "Owner's rent is paid on the 1st from checking" });
  await store.add({ kind: "semantic", content: "Owner's Amex card has a $5000 limit and bills on the 20th" });
  await store.add({ kind: "semantic", content: "Owner likes neon racing games with drift physics" });
  await store.add({ kind: "episodic", content: "Penny found a forgotten Dropbox plan", scope: "agent:p_penny0000000" });
  await store.add({ kind: "episodic", content: "Rex refactored the auth guard", scope: "agent:p_rex000000000" });

  // Everything from Ares's main memory.
  const all = await handMemories(memoryFile, { from: "ares", to: "p_atlas0000000" });
  assert.equal(all.copied, 3, "the owner's three, never an agent's private ones");
  let atlas = await agentMemories(memoryFile, "p_atlas0000000");
  assert.equal(atlas.total, 3);
  assert.ok(atlas.items.every((m) => m.tags.includes("handed-from:ares")));
  // Handing again duplicates nothing.
  assert.equal((await handMemories(memoryFile, { from: "ares", to: "p_atlas0000000" })).copied, 0);

  // Only what is about a topic.
  const topic = await handMemories(memoryFile, { from: "ares", to: "p_penny0000000", about: "Amex card bills" });
  assert.ok(topic.copied >= 1);
  const penny = await agentMemories(memoryFile, "p_penny0000000");
  assert.ok(penny.items.some((m) => /Amex/.test(m.content)));
  assert.ok(!penny.items.some((m) => /racing/.test(m.content)), "an off-topic memory is not handed");

  // Agent → agent hands only the source agent's OWN memories.
  await handMemories(memoryFile, { from: "p_penny0000000", to: "p_muse00000000" });
  const muse = await agentMemories(memoryFile, "p_muse00000000");
  assert.ok(muse.items.some((m) => /Dropbox/.test(m.content)));
  assert.ok(!muse.items.some((m) => /auth guard/.test(m.content)), "Rex's memory never leaks through Penny");

  // Forget is scoped to the agent.
  const rexNode = (await MemoryStore.open(memoryFile)).all().find((n) => n.scope === "agent:p_rex000000000");
  assert.equal(await forgetAgentMemory(memoryFile, "p_penny0000000", rexNode.id), false, "Penny's profile can't forget Rex's memory");
  assert.equal(await forgetAgentMemory(memoryFile, "p_muse00000000", muse.items[0].id), true);

  // Export: Markdown + JSON on disk.
  const out = await exportAgentMemory(memoryFile, { id: "p_atlas0000000", name: "Atlas", instructions: "Research." }, path.join(dir, "exports"), new Date("2026-10-17T12:00:00Z"));
  assert.equal(out.count, 3);
  assert.match(out.markdown, /Atlas-memory-2026-10-17\.md$/);
  const md = await fs.readFile(out.markdown, "utf8");
  assert.match(md, /# Atlas — memory/);
  assert.match(md, /rent is paid/);
  assert.equal(JSON.parse(await fs.readFile(out.json, "utf8")).memories.length, 3);
});

test("handing a chat to an agent rebinds it (the history stays, the agent takes over)", async () => {
  const { agents } = await harness();
  const ava = await agents.create({ name: "Ava", instructions: "Designer." });
  const rex = await agents.create({ name: "Rex", instructions: "Engineer." });
  await agents.bind(ava.id, "sess_old_ares_chat");
  assert.equal(agentOfSession("sess_old_ares_chat"), ava.id);
  await agents.bind(rex.id, "sess_old_ares_chat");
  assert.equal(agentOfSession("sess_old_ares_chat"), rex.id);
  assert.deepEqual(agents.get(ava.id).desktopThreads, []);
  assert.deepEqual(agents.get(rex.id).desktopThreads, ["sess_old_ares_chat"]);
});

test("the desktop agent layer texts like a person (owner, 2026-10-19: no console, say what you're doing) and names the texting protocol", () => {
  const block = desktopAgentLayerBlock({ name: "Ava", instructions: "Designer." }, [{ name: "Rex", role: "Engineer" }]);
  assert.match(block, /texting them from their desktop/);
  assert.match(block, /text thread, not a console/);
  assert.match(block, /Say what you are about to do, then do it/);
  assert.match(block, /every Ares tool — the Forge/);
  assert.match(block, /\[text from <name>\]/);
  assert.match(block, /Agents \(action avatar\)/);
  assert.match(block, /hand_memory/);
  assert.doesNotMatch(block, /texting them from their phone/);
});
