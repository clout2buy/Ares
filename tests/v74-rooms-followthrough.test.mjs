// Rooms follow-through (owner, 2026-10-20): "I give my agent a rule for group
// chats — it doesn't remember. They don't recognize the group chats at all. I
// told my agent to talk to Cupid's agent; his responded, and it stopped."
//
// Pinned here:
//   1. An agent that names nobody is answering the agent before it: the reply
//      is dispatched back to that agent (cross-machine too), until a person
//      speaks or the run cap trips.
//   2. Standing rules live on the agent, survive a reload, and ride in every
//      chat AND every room seat's prompt.
//   3. An agent's private chat lists the rooms it sits in; Rooms read works
//      from there.
//   4. Profile pictures load through a data: URL (the CSP has no blob:).

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dispatchFor, previousAgentSpeaker, DEFAULT_RULES } from "../packages/cli/dist/rooms.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { makeRoomsTool } from "../packages/cli/dist/entry/roomsTool.js";
import { makeAgentsTool } from "../packages/cli/dist/entry/agentsTool.js";
import { setRoomsHost } from "../packages/cli/dist/entry/roomScope.js";
import { setAgentsHost } from "../packages/cli/dist/entry/agentScope.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-follow-"));
const msg = (seq, from, text, kind = "text") => ({ seq, id: `rm_${seq}`, at: new Date(seq * 1000).toISOString(), from, text, kind });
const owner = { kind: "person", id: "owner", name: "Crix", home: "local" };
const mine = { kind: "agent", id: "p_frankie00000", name: "frankie", home: "local" };
const theirs = { kind: "agent", id: "p_cupidbot0000", name: "cupid bot", home: "me_guest1" };
const room = {
  id: "room_abcdef123456", name: "Us", purpose: "", rules: { ...DEFAULT_RULES }, board: [], notes: "", host: { kind: "local" }, invites: [], guests: [], threads: {}, seq: 0,
  createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
  members: [
    { kind: "person", id: "owner", name: "Crix", home: "local", joinedAt: "" },
    { kind: "agent", id: mine.id, name: "frankie", home: "local", owner: "person:local:owner", joinedAt: "" },
    { kind: "agent", id: theirs.id, name: "cupid bot", home: "me_guest1", owner: "person:me_guest1:me_guest1", joinedAt: "" },
  ],
};

test("a reply with no @ goes back to the agent it answers — across machines — and a person resets it", () => {
  const m1 = msg(1, owner, "@frankie say hi to cupid bot");
  const m2 = msg(2, mine, "@cupid bot yo, Crix says hi");
  const m3 = msg(3, theirs, "hey! tell Crix I said what's up");
  assert.deepEqual(previousAgentSpeaker(m3, [m1, m2, m3]), mine);
  assert.deepEqual(dispatchFor(room, m3, [m1, m2, m3]).agents, [mine.id], "frankie hears cupid bot's reply");
  // and the other way: frankie answers with no @ → it would go to cupid bot, who lives on the other machine
  const m4 = msg(4, mine, "he says what's up back");
  assert.deepEqual(previousAgentSpeaker(m4, [m1, m2, m3, m4]), theirs, "frankie's no-@ reply is addressed to cupid bot");
  assert.deepEqual(dispatchFor(room, m4, [m1, m2, m3, m4]).agents, [], "cupid bot runs on the other machine, so nothing is dispatched here");
  // a person in between resets the chain
  const m5 = msg(5, owner, "ok cool");
  const m6 = msg(6, theirs, "nice");
  assert.equal(previousAgentSpeaker(m6, [m1, m2, m3, m4, m5, m6]), undefined);
  // the run cap still stops two agents chatting forever
  const capped = { ...room, rules: { ...DEFAULT_RULES, maxAgentRun: 2 } };
  assert.equal(dispatchFor(capped, m3, [m1, m2, m3]).waitingForHuman, true);
});

test("standing rules live on the agent, survive a reload, and ride into every chat and room seat", async () => {
  const home = await tmp();
  const ws = await tmp();
  const agents = new DesktopAgents({ home, defaultBrain: () => ({ provider: "mock", model: "m" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
  await agents.load();
  const frankie = await agents.create({ name: "frankie", instructions: "the homie", rules: "in group chats keep it to one line\n- never curse at Cupid" });
  assert.deepEqual(frankie.rules, ["in group chats keep it to one line", "never curse at Cupid"]);

  // the agent saves a rule itself, from its own chat
  await agents.bind(frankie.id, "sess_private1");
  setAgentsHost(agents.host());
  const tool = makeAgentsTool();
  const out = await tool.call({ action: "rule", add_rule: "always @ the person you're answering in rooms" }, { sessionId: "sess_private1" });
  assert.match(out.display, /always @ the person/);

  // reload from disk
  const again = new DesktopAgents({ home, defaultBrain: () => ({ provider: "mock", model: "m" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
  await again.load();
  const loaded = again.get(frankie.id);
  assert.equal(loaded.rules.length, 3);
  assert.match(again.layerFor(frankie.id), /Your standing rules[\s\S]*in group chats keep it to one line[\s\S]*always @ the person/);

  // and a room seat carries them too: the seat is the same agent
  const rooms = new DesktopRooms({ home, workspace: ws, agents: again, deliver: () => undefined, busy: () => false, emit: () => undefined, publicOrigin: async () => null, relayer: () => undefined });
  await rooms.load();
  const r = await rooms.create({ name: "Agency", agents: [frankie.id] });
  await rooms.postAsOwner(r.id, "@frankie hi");
  const seat = rooms.get(r.id).threads[frankie.id];
  assert.ok(seat);
  assert.match(again.layerFor(again.agentForSession(seat).id), /never curse at Cupid/);

  // removing a rule
  setAgentsHost(again.host());
  await tool.call({ action: "rule", remove_rule: "curse" }, { sessionId: seat });
  assert.equal(again.get(frankie.id).rules.some((x) => /curse/.test(x)), false);
  rooms.stop();
});

test("an agent's private chat knows its rooms, and can read one", async () => {
  const home = await tmp();
  const ws = await tmp();
  const agents = new DesktopAgents({ home, defaultBrain: () => ({ provider: "mock", model: "m" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
  await agents.load();
  const frankie = await agents.create({ name: "frankie", instructions: "the homie" });
  const rooms = new DesktopRooms({ home, workspace: ws, agents, deliver: () => undefined, busy: () => false, emit: () => undefined, publicOrigin: async () => null, relayer: () => undefined });
  await rooms.load();
  const r = await rooms.create({ name: "Agency", purpose: "build sites", agents: [frankie.id] });
  await rooms.postAsOwner(r.id, "first site is the plumber");
  assert.match(rooms.privateLayerFor(frankie.id), /Rooms you are in[\s\S]*Agency[\s\S]*build sites/);
  assert.equal(rooms.privateLayerFor("p_nobody000000"), "");

  await agents.bind(frankie.id, "sess_private2");
  setRoomsHost(rooms.host());
  const read = await makeRoomsTool().call({ action: "read", room: "Agency" }, { sessionId: "sess_private2" });
  assert.match(read.display, /first site is the plumber/);
  rooms.stop();
});

test("profile pictures load through a data: URL — the desktop CSP has no blob: in img-src", async () => {
  const src = await fs.readFile(path.resolve("tauri/src/agents.tsx"), "utf8");
  const fn = src.slice(src.indexOf("export async function squareAvatar"), src.indexOf("export interface AgentRowVm"));
  assert.match(fn, /readAsDataURL/);
  assert.doesNotMatch(fn, /=\s*URL\.createObjectURL\(/);
  const conf = JSON.parse(await fs.readFile(path.resolve("tauri/src-tauri/tauri.conf.json"), "utf8"));
  assert.match(conf.app.security.csp, /img-src[^;]*data:/);
});
