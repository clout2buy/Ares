// Rooms — group chats of people + agents (owner, 2026-10-19: "group chats
// through users too… invite OhCupid… watch them talk / intervene").
//
// Pinned here:
//   1. A room is a file-backed thread: messages are numbered, appended a line
//      at a time, and survive a reload.
//   2. Who answers follows the rules: mention mode summons only the agents
//      named (a person naming nobody gets the lead; an agent naming nobody
//      ends the exchange); the run cap stops agents until a person speaks;
//      a paused room, a muted agent, and someone else's agent never answer.
//   3. An agent's seat is one daemon session bound to it; a message lands
//      there as a turn carrying what it missed; its reply is posted back —
//      through Rooms say, or its turn's final text, but never a pass.
//   4. Guests come in by invite on a per-room token through the garrison
//      door, can speak only as themselves or the agents they brought, and
//      the host's daemon drains what they wrote.
//   5. Invite links round-trip.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { RoomStore, dispatchFor, mentionedMembers, agentRun, parseInvite, inviteLink, isPass, roomTurnText, DEFAULT_RULES } from "../packages/cli/dist/rooms.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { createRoomsApi } from "../packages/cli/dist/phoneRooms.js";
import { makeRoomsTool } from "../packages/cli/dist/entry/roomsTool.js";
import { setRoomsHost } from "../packages/cli/dist/entry/roomScope.js";

async function home() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ares-rooms-"));
}

function member(kind, id, name, extra = {}) {
  return { kind, id, name, home: "local", joinedAt: "2026-10-19T00:00:00.000Z", ...extra };
}
function msg(seq, from, text, kind = "text") {
  return { seq, id: `rm_${seq}`, at: new Date(seq * 1000).toISOString(), from, text, kind };
}
const owner = { kind: "person", id: "owner", name: "Crix", home: "local" };
const bob = { kind: "agent", id: "p_bob000000000", name: "bob", home: "local" };
const andy = { kind: "agent", id: "p_andy00000000", name: "audit andy", home: "local" };
const theirs = { kind: "agent", id: "p_theirs000000", name: "cupid", home: "me_guest1" };

function room(over = {}) {
  return {
    id: "room_abcdef123456",
    name: "Agency",
    purpose: "web agency",
    members: [member("person", "owner", "Crix"), member("agent", bob.id, "bob", { owner: "person:local:owner" }), member("agent", andy.id, "audit andy", { owner: "person:local:owner" }), { ...member("agent", theirs.id, "cupid"), home: "me_guest1", owner: "person:me_guest1:me_guest1" }],
    rules: { ...DEFAULT_RULES },
    board: [],
    notes: "",
    host: { kind: "local" },
    invites: [],
    guests: [],
    threads: {},
    seq: 0,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...over,
  };
}

test("rooms: a thread on disk — numbered, appended, reloaded", async () => {
  const h = await home();
  const store = new RoomStore(h);
  const r = room();
  await store.save(r);
  await store.append(r.id, msg(1, owner, "yo"));
  await store.append(r.id, msg(2, bob, "sup"));
  assert.equal(await store.lastSeq(r.id), 2);
  const again = new RoomStore(h);
  await again.load();
  assert.equal(again.get(r.id)?.name, "Agency");
  const all = await again.messages(r.id);
  assert.deepEqual(all.map((m) => m.text), ["yo", "sup"]);
  assert.deepEqual((await again.since(r.id, 1)).map((m) => m.seq), [2]);
});

test("rooms: @mentions find members by full name, first or last word, or everyone", () => {
  const members = room().members.filter((m) => m.kind === "agent");
  assert.deepEqual(mentionedMembers("@bob take it", members).map((m) => m.name), ["bob"]);
  assert.deepEqual(mentionedMembers("over to @andy", members).map((m) => m.name), ["audit andy"]);
  assert.deepEqual(mentionedMembers("@audit andy check this", members).map((m) => m.name), ["audit andy"]);
  assert.deepEqual(mentionedMembers("@everyone standup", members).length, 3);
  assert.deepEqual(mentionedMembers("bob@example.com is not a mention", members), []);
});

test("rooms: mention mode — named agents answer; the lead takes an unaddressed person; an agent naming nobody ends it", () => {
  const r = room();
  const recent = [msg(1, owner, "hey")];
  assert.deepEqual(dispatchFor(r, recent[0], recent).agents, [bob.id]);
  const m2 = msg(2, owner, "@andy audit this");
  assert.deepEqual(dispatchFor(r, m2, [...recent, m2]).agents, [andy.id]);
  const m3 = msg(3, andy, "done, PASS");
  assert.deepEqual(dispatchFor(r, m3, [...recent, m2, m3]), { agents: [], waitingForHuman: false, reason: "nobody mentioned" });
  // someone else's agent is never dispatched here, even when named
  const m4 = msg(4, owner, "@cupid hi");
  assert.deepEqual(dispatchFor(r, m4, [...recent, m2, m3, m4]).agents, []);
});

test("rooms: the run cap, pause and mute all silence agents", () => {
  const r = room({ rules: { ...DEFAULT_RULES, turns: "free", maxAgentRun: 3 } });
  const recent = [msg(1, owner, "go"), msg(2, bob, "@andy a"), msg(3, andy, "@bob b"), msg(4, bob, "@andy c")];
  assert.equal(agentRun(recent), 3);
  const d = dispatchFor(r, recent[3], recent);
  assert.equal(d.waitingForHuman, true);
  assert.deepEqual(d.agents, []);
  const human = msg(5, owner, "keep going");
  assert.deepEqual(dispatchFor(r, human, [...recent, human]).agents.sort(), [andy.id, bob.id].sort());
  const paused = room({ rules: { ...DEFAULT_RULES, paused: true } });
  assert.deepEqual(dispatchFor(paused, human, [human]).agents, []);
  const muted = room();
  muted.members[1].muted = true;
  assert.deepEqual(dispatchFor(muted, msg(1, owner, "@bob hey"), [msg(1, owner, "@bob hey")]).agents, []);
});

test("rooms: round mode walks the agents in order, people hand to the first", () => {
  const r = room({ rules: { ...DEFAULT_RULES, turns: "round" } });
  const m1 = msg(1, owner, "start");
  assert.deepEqual(dispatchFor(r, m1, [m1]).agents, [bob.id]);
  const m2 = msg(2, bob, "my bit");
  assert.deepEqual(dispatchFor(r, m2, [m1, m2]).agents, [andy.id]);
  const m3 = msg(3, andy, "mine");
  // next in order is cupid, who lives on another machine: nothing here
  assert.deepEqual(dispatchFor(r, m3, [m1, m2, m3]).agents, []);
});

test("rooms: what an agent reads names who is who, and pass is recognised", () => {
  const r = room();
  const viewer = r.members[1];
  const text = roomTurnText(r, viewer, [msg(1, owner, "hi"), msg(2, theirs, "yo")], msg(3, owner, "@bob build it"));
  assert.match(text, /Crix \(your owner\): hi/);
  assert.match(text, /cupid \(an agent\): yo/);
  assert.match(text, /\[room "Agency"\] Crix \(your owner\): @bob build it$/);
  assert.equal(isPass("pass"), true);
  assert.equal(isPass("(pass)"), true);
  assert.equal(isPass("Nothing to add."), true);
  assert.equal(isPass("I passed the audit"), false);
});

test("rooms: invite links round-trip and reject junk", () => {
  const link = inviteLink("https://ares.example.com", "room_abcdef123456", "k7m2p9qx");
  assert.deepEqual(parseInvite(link), { origin: "https://ares.example.com", roomId: "room_abcdef123456", code: "k7m2p9qx" });
  assert.equal(parseInvite("https://evil/room?url=javascript:x&room=room_abcdef123456&code=abc"), null);
  assert.equal(parseInvite("ares://room?url=https://h&room=nope&code=abcdefgh"), null);
});

/** A daemon stand-in: records deliveries, lets a test "answer" a seat. */
function harness(h, ws) {
  const delivered = [];
  const events = [];
  const agents = new DesktopAgents({
    home: h,
    defaultBrain: () => ({ provider: "mock", model: "m" }),
    deliver: () => undefined,
    busy: () => false,
    emit: () => undefined,
  });
  const rooms = new DesktopRooms({
    home: h,
    workspace: ws,
    agents,
    deliver: (sessionId, goal, inputId) => delivered.push({ sessionId, goal, inputId }),
    busy: () => false,
    emit: (e) => events.push(e),
    publicOrigin: async () => "https://host.example",
    relayer: () => undefined,
  });
  return { agents, rooms, delivered, events };
}

test("rooms: a seat per agent, turns carry the catch-up, replies post back (tool or final text, never a pass)", async () => {
  const h = await home();
  const ws = await home();
  const { agents, rooms, delivered, events } = harness(h, ws);
  await agents.load();
  const b = await agents.create({ name: "bob", instructions: "engineer" });
  const a = await agents.create({ name: "audit andy", instructions: "auditor" });
  await rooms.load();
  const r = await rooms.create({ name: "Agency", purpose: "build sites", agents: [b.id, a.id] });
  assert.equal(r.members.length, 3);
  assert.ok(events.some((e) => e.type === "room_message" && e.message.kind === "system"), "opening line");

  await rooms.postAsOwner(r.id, "@bob build the plumber site, then hand it to @andy");
  assert.equal(delivered.length, 2, "both named agents got a turn");
  const seatBob = delivered.find((d) => d.goal.includes("your owner"))?.sessionId;
  assert.ok(seatBob);
  const current = rooms.get(r.id);
  assert.equal(current.threads[b.id], delivered[0].sessionId, "the seat is remembered on the room");
  assert.equal(agents.agentForSession(delivered[0].sessionId)?.id, b.id, "the seat is bound to the agent");
  assert.match(rooms.layerFor(delivered[0].sessionId), /your seat in the room "Agency"/);
  assert.match(delivered[0].goal, /\[room "Agency"\] Crix|\(your owner\)/);

  // bob answers with the tool
  setRoomsHost(rooms.host());
  const tool = makeRoomsTool();
  const said = await tool.call({ action: "say", text: "on it. @andy you're up after" }, { sessionId: delivered[0].sessionId });
  assert.match(said.display, /said in Agency/);
  const thread = await rooms.store.messages(r.id);
  assert.equal(thread.at(-1).from.name, "bob");
  assert.equal(thread.at(-1).from.kind, "agent");
  // andy was summoned by bob's message (a third delivery)
  assert.equal(delivered.length, 3);
  assert.equal(agents.agentForSession(delivered[2].sessionId)?.id, a.id);

  // andy's turn ends with plain text and no tool call: it is posted for him
  rooms.onAssistantText(delivered[2].sessionId, "Will do. Waiting on the link.");
  await rooms.onTurnEnd(delivered[2].sessionId);
  assert.equal((await rooms.store.messages(r.id)).at(-1).text, "Will do. Waiting on the link.");
  // a pass posts nothing
  const before = (await rooms.store.messages(r.id)).length;
  rooms.onAssistantText(delivered[2].sessionId, "pass");
  await rooms.onTurnEnd(delivered[2].sessionId);
  assert.equal((await rooms.store.messages(r.id)).length, before);
  // after Rooms say, the final text is NOT posted twice
  await tool.call({ action: "say", text: "PASS — ship it" }, { sessionId: delivered[2].sessionId });
  rooms.onAssistantText(delivered[2].sessionId, "I said PASS in the room.");
  await rooms.onTurnEnd(delivered[2].sessionId);
  assert.equal((await rooms.store.messages(r.id)).at(-1).text, "PASS — ship it");

  // the board through the tool, as the owner reads it
  const job = await tool.call({ action: "job", title: "plumber site", owner: "bob", status: "working", link: "agency/sites/x" }, { sessionId: delivered[0].sessionId });
  assert.match(job.display, /\[working\] plumber site — bob/);
  assert.match(rooms.layerFor(delivered[0].sessionId), /\[working\] plumber site — bob/);

  // owner controls: mute silences; recall drops the seat
  await rooms.setMuted(r.id, b.id, true);
  const n = delivered.length;
  await rooms.postAsOwner(r.id, "@bob status?");
  assert.equal(delivered.length, n, "a muted agent is not summoned");
  await rooms.removeAgent(r.id, b.id);
  assert.equal(rooms.get(r.id).members.some((m) => m.id === b.id), false);
  rooms.stop();
});

test("rooms: a pending invite can be retracted; a used one cannot (that is a guest)", async () => {
  const h = await home();
  const ws = await home();
  const { agents, rooms, events } = harness(h, ws);
  await agents.load();
  await rooms.load();
  const r = await rooms.create({ name: "Agency" });
  const one = await rooms.invite(r.id, "for cupid");
  const two = await rooms.invite(r.id);
  assert.equal(rooms.get(r.id).invites.filter((i) => !i.usedBy).length, 2);
  events.length = 0;
  const after = await rooms.revokeInvite(r.id, one.code);
  assert.deepEqual(after.invites.map((i) => i.code), [two.code], "the retracted link is gone, the other stays");
  assert.ok(events.some((e) => e.type === "room_changed" && e.room.invites.length === 1), "the desktop hears the change");
  assert.equal((await rooms.revokeInvite(r.id, "nope")).invites.length, 1, "an unknown code is a no-op");
  const wired = rooms.wire(after);
  assert.equal(wired.invites.length, 1, "invites ride the wire for the members panel");
});

test("rooms: guests join by invite on their own token, speak only as themselves, and the host drains it", async () => {
  const h = await home();
  const ws = await home();
  const { agents, rooms, delivered } = harness(h, ws);
  await agents.load();
  const b = await agents.create({ name: "bob", instructions: "engineer" });
  await rooms.load();
  const r = await rooms.create({ name: "Agency", agents: [b.id] });
  const inv = await rooms.invite(r.id, "for cupid");
  const parsed = parseInvite(inv.link);
  assert.equal(parsed.roomId, r.id);

  const api = createRoomsApi({ home: h });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    void api(req, res, url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = (route, body, token) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

  // a bad code is refused
  assert.equal((await post("/gateway/rooms/join", { room: r.id, code: "nopenope", guest: { id: "me_guest1", name: "OhCupid" } })).status, 403);
  const joined = await post("/gateway/rooms/join", { room: r.id, code: parsed.code, guest: { id: "me_guest1", name: "OhCupid" }, agents: [{ kind: "agent", id: "p_cupid0000000", name: "cupid", home: "me_guest1" }] });
  assert.equal(joined.status, 200);
  const j = await joined.json();
  assert.ok(j.token);
  assert.equal(j.room.members.length, 4);
  assert.ok(j.room.members.find((m) => m.name === "cupid")?.home === "me_guest1");
  assert.equal(j.room.invites, undefined, "guests never see invites or other guests' tokens");

  // speaks as a person; cannot speak as the host's agent
  const bad = await post(`/gateway/rooms/${r.id}/messages`, { from: { kind: "agent", id: b.id }, text: "I am bob" }, j.token);
  assert.equal(bad.status, 403);
  const ok = await post(`/gateway/rooms/${r.id}/messages`, { from: { kind: "person" }, text: "@bob hey from cupid's owner" }, j.token);
  assert.equal(ok.status, 200);
  const posted = (await ok.json()).message;
  assert.equal(posted.from.name, "OhCupid");
  assert.equal(posted.from.home, "me_guest1");
  assert.equal((await post(`/gateway/rooms/${r.id}/messages`, { from: { kind: "person" }, text: "x" }, "wrong")).status, 401);

  // the host's daemon notices on its drain and summons bob (a guest is NOT the owner)
  const n = delivered.length;
  await rooms["drainAll"]();
  assert.equal(delivered.length, n + 1);
  assert.match(delivered.at(-1).goal, /OhCupid \(a person, not your owner\)/);

  // long-poll returns the thread past a seq, with the room
  const got = await fetch(`${base}/gateway/rooms/${r.id}/messages?since=0&wait=0`, { headers: { authorization: `Bearer ${j.token}` } });
  const body = await got.json();
  assert.ok(body.messages.some((m) => m.text.includes("hey from cupid")));
  assert.ok(body.messages.some((m) => m.kind === "system" && /OhCupid joined with cupid/.test(m.text)));
  assert.equal(body.room.name, "Agency");

  // the host can throw a guest out
  await rooms.revokeGuest(r.id, "me_guest1");
  assert.equal((await fetch(`${base}/gateway/rooms/${r.id}/messages?since=0`, { headers: { authorization: `Bearer ${j.token}` } })).status, 401);
  rooms.stop();
  server.closeAllConnections?.();
  server.close();
});

test("rooms: a guest install mirrors a remote room, dispatches to ITS agents only, and posts back through the host", async () => {
  // host
  const hostHome = await home();
  const hostApi = createRoomsApi({ home: hostHome });
  const hostStore = new RoomStore(hostHome);
  const r = room({ members: [member("person", "owner", "Crix"), member("agent", bob.id, "bob", { owner: "person:local:owner" })], invites: [{ code: "k7m2p9qx", createdAt: "2026-10-19T00:00:00.000Z" }] });
  await hostStore.save(r);
  await hostStore.append(r.id, msg(1, owner, "welcome"));
  await hostStore.save({ ...r, seq: 1 });
  const server = createServer((req, res) => { void hostApi(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // guest
  const gh = await home();
  const gws = await home();
  const { agents, rooms, delivered } = harness(gh, gws);
  try {
  await agents.load();
  const cupid = await agents.create({ name: "cupid", instructions: "matchmaker" });
  await rooms.load();
  const mirror = await rooms.join(inviteLink(origin, r.id, "k7m2p9qx"), [cupid.id]);
  assert.equal(mirror.host.kind, "remote");
  const names = mirror.members.map((m) => `${m.name}@${m.home}`).sort();
  assert.deepEqual(names, ["Crix@host", "bob@host", "cupid@local", rooms.whoami().name + "@local"].sort());
  assert.equal((await rooms.store.messages(mirror.id)).length >= 1, true, "history came along");
  assert.equal(delivered.length, 0, "history is context, not a summons");

  // the host's owner speaks: the guest's poll picks it up and summons cupid (not bob — bob is the host's)
  const hostRoom = (await hostStore.load(), hostStore.get(r.id));
  await hostStore.append(r.id, msg(hostRoom.seq + 1, owner, "@cupid who should we pair?"));
  await hostStore.save({ ...hostRoom, seq: hostRoom.seq + 1 });
  for (let i = 0; i < 40 && delivered.length === 0; i++) await new Promise((x) => setTimeout(x, 100));
  assert.equal(delivered.length, 1);
  assert.equal(agents.agentForSession(delivered[0].sessionId)?.id, cupid.id);
  assert.match(delivered[0].goal, /Crix \(a person, not your owner\)/);

  // cupid answers: it reaches the host under the guest's install id
  rooms.onAssistantText(delivered[0].sessionId, "Pair bob with andy.");
  await rooms.onTurnEnd(delivered[0].sessionId);
  await hostStore.refresh();
  const onHost = await hostStore.messages(r.id);
  const reply = onHost.find((m) => m.text === "Pair bob with andy.");
  assert.ok(reply, "the guest agent's reply landed on the host");
  assert.equal(reply.from.kind, "agent");
  assert.equal(reply.from.home, rooms.whoami().id);
  } finally {
    rooms.stop();
    server.closeAllConnections?.();
    server.close();
  }
});

// A revoke written in the same file-time tick as the previous save was never
// re-read by another RoomStore (refresh compared mtime only), so the guest API
// kept serving a room that still listed the revoked guest. Flaked the gate.
test("rooms: a change written in the same mtime tick is still picked up by refresh", async () => {
  const h = await home();
  const writer = new RoomStore(h);
  const reader = new RoomStore(h);
  const r = room({ name: "Before" });
  const file = path.join(h, "rooms", `${r.id}.json`);
  const tick = Math.floor(Date.now() / 1000); // whole seconds: exact on every filesystem
  await writer.save(r);
  await fs.utimes(file, tick, tick);
  await reader.load();
  await writer.save({ ...r, name: "After" });
  await fs.utimes(file, tick, tick); // same tick as the previous write
  await reader.refresh();
  assert.equal(reader.get(r.id)?.name, "After");
});
