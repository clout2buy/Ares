// The people directory (owner, 2026-10-19: "search people as a sort of
// discovery… create a username, look other people up, message them or group
// chat, or users' agents can talk to each other").
//
// Pinned here:
//   1. A username belongs to one install: claiming a taken name is refused,
//      re-claiming from the same install rotates the token, claiming a new
//      name releases the old one.
//   2. Lookups never leak install ids, tokens or raw origins; search ranks
//      exact > prefix > contains, and shows presence.
//   3. An invite only relays a room link into the other person's inbox; the
//      inbox long-polls; acks stick.
//   4. End to end across two installs: A claims, B claims, A "messages" B —
//      a two-person room is made on A, the invite reaches B's inbox, B joins
//      it with the ordinary room_join, and what B says lands on A.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { DirectoryStore, createDirectoryHandler, serveDirectory, USERNAME_RE } from "../packages/cli/dist/directoryServer.js";
import { DesktopDirectory } from "../packages/cli/dist/entry/daemon/directory.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { createRoomsApi } from "../packages/cli/dist/phoneRooms.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-dir-"));

async function directory() {
  const data = await tmp();
  const srv = await serveDirectory({ dataDir: data, port: 0 });
  return { url: `http://127.0.0.1:${srv.port}`, close: srv.close, data };
}

const post = (url, body, token) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test("directory: usernames are rules-checked, unique per install, and re-claimable by their owner", async () => {
  const d = await directory();
  assert.equal(USERNAME_RE.test("oh_cupid"), true);
  assert.equal(USERNAME_RE.test("Oh Cupid"), false);
  const a = await post(`${d.url}/v1/claim`, { username: "crix", displayName: "Crix", installId: "me_aaaaaaaaaaaa" });
  assert.equal(a.status, 200);
  const aj = await a.json();
  assert.ok(aj.token);
  assert.equal(aj.user.username, "crix");
  assert.equal(aj.user.installId, undefined, "install ids never leave the server");
  const taken = await post(`${d.url}/v1/claim`, { username: "crix", displayName: "X", installId: "me_bbbbbbbbbbbb" });
  assert.equal(taken.status, 409);
  const again = await post(`${d.url}/v1/claim`, { username: "CRIX", displayName: "Crix B", installId: "me_aaaaaaaaaaaa" });
  assert.equal(again.status, 200);
  const againJ = await again.json();
  assert.notEqual(againJ.token, aj.token, "re-claiming rotates the token");
  // the old token is dead, the new one works
  assert.equal((await fetch(`${d.url}/v1/me`, { headers: { authorization: `Bearer ${aj.token}` } })).status, 401);
  assert.equal((await fetch(`${d.url}/v1/me`, { headers: { authorization: `Bearer ${againJ.token}` } })).status, 200);
  // a new name from the same install releases the old one
  const moved = await (await post(`${d.url}/v1/claim`, { username: "crix_builder", displayName: "Crix", installId: "me_aaaaaaaaaaaa" })).json();
  assert.equal(moved.user.username, "crix_builder");
  assert.equal((await fetch(`${d.url}/v1/users/crix`)).status, 404);
  assert.equal((await post(`${d.url}/v1/claim`, { username: "bad name", displayName: "x", installId: "me_cccccccccccc" })).status, 400);
  await d.close();
});

test("directory: search ranks exact > prefix > contains, shows presence, and leaks nothing", async () => {
  const data = await tmp();
  const store = new DirectoryStore(data);
  await store.load();
  let clock = Date.now();
  const handler = createDirectoryHandler(store, { now: () => clock });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [u, dn] of [["cupid", "OhCupid"], ["cupcake", "Cup Cake"], ["dawg", "Dawg"], ["grizzly", "Grizz the cupid fan"]]) {
    assert.equal((await post(`${url}/v1/claim`, { username: u, displayName: dn, installId: `me_${u.padEnd(12, "0")}`, origin: "https://ares.example.com", agents: [{ name: "bob", role: "builder" }] })).status, 200);
  }
  const r = await (await fetch(`${url}/v1/users?q=cup`)).json();
  assert.deepEqual(r.users.map((x) => x.username), ["cupid", "cupcake", "grizzly"]);
  const top = r.users[0];
  assert.equal(top.online, true);
  assert.equal(top.reachable, true);
  assert.equal(top.origin, undefined, "raw origins stay private");
  assert.equal(top.tokenHash, undefined);
  assert.deepEqual(top.agents, [{ name: "bob", role: "builder" }]);
  clock += 10 * 60_000;
  const later = await (await fetch(`${url}/v1/users/cupid`)).json();
  assert.equal(later.user.online, false, "no heartbeat for ten minutes = offline");
  server.closeAllConnections?.();
  server.close();
});

test("directory: an invite is a relayed room link; the inbox long-polls and acks stick", async () => {
  const d = await directory();
  const a = await (await post(`${d.url}/v1/claim`, { username: "crix", displayName: "Crix", installId: "me_aaaaaaaaaaaa" })).json();
  const b = await (await post(`${d.url}/v1/claim`, { username: "cupid", displayName: "OhCupid", installId: "me_bbbbbbbbbbbb" })).json();
  assert.equal((await post(`${d.url}/v1/users/cupid/invite`, { kind: "room", link: "https://evil/x", roomName: "Agency" }, a.token)).status, 400, "only ares://room links");
  assert.equal((await post(`${d.url}/v1/users/cupid/invite`, { kind: "room", link: "ares://room?url=https%3A%2F%2Fa.example&room=room_abcdef123456&code=k7m2p9qx", roomName: "Agency" })).status, 401, "unclaimed cannot invite");
  // the inbox waits for something to arrive
  const waiting = fetch(`${d.url}/v1/inbox?since=0&wait=10`, { headers: { authorization: `Bearer ${b.token}` } });
  await new Promise((r) => setTimeout(r, 300));
  const sent = await post(`${d.url}/v1/users/cupid/invite`, { kind: "room", link: "ares://room?url=https%3A%2F%2Fa.example&room=room_abcdef123456&code=k7m2p9qx", roomName: "Agency", text: "come build" }, a.token);
  assert.equal(sent.status, 200);
  const got = await (await waiting).json();
  assert.equal(got.items.length, 1);
  assert.equal(got.items[0].from.username, "crix");
  assert.equal(got.items[0].roomName, "Agency");
  assert.equal(got.items[0].text, "come build");
  assert.equal((await post(`${d.url}/v1/inbox/${got.items[0].id}/ack`, {}, b.token)).status, 200);
  const after = await (await fetch(`${d.url}/v1/inbox?since=0`, { headers: { authorization: `Bearer ${b.token}` } })).json();
  assert.equal(after.items[0].acked, true);
  await d.close();
});

/** One whole install: agents + rooms (+ the garrison door for guests) + directory client. */
async function install(name, directoryUrl) {
  const home = await tmp();
  const ws = await tmp();
  const events = [];
  const delivered = [];
  const agents = new DesktopAgents({ home, defaultBrain: () => ({ provider: "mock", model: "m" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
  await agents.load();
  const api = createRoomsApi({ home });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rooms = new DesktopRooms({ home, workspace: ws, agents, deliver: (sid, goal, inputId) => delivered.push({ sid, goal, inputId }), busy: () => false, emit: (e) => events.push(e), publicOrigin: async () => origin, relayer: () => undefined });
  await rooms.load();
  await rooms.rename(name);
  process.env.ARES_DIRECTORY_URL = directoryUrl;
  const dir = new DesktopDirectory({ home, agents, rooms, publicOrigin: async () => origin, emit: (e) => events.push(e) });
  await dir.load();
  return { home, agents, rooms, dir, events, delivered, close: async () => { dir.stop(); rooms.stop(); server.closeAllConnections?.(); server.close(); } };
}

test("directory: two installs — A messages B through a room the DIRECTORY hosts, B joins, both agents can come", async () => {
  const d = await directory();
  const A = await install("Crix", d.url);
  const B = await install("OhCupid", d.url);
  await A.dir.claim("crix");
  await B.dir.claim("cupid");
  assert.equal(A.dir.wire().username, "crix");
  const found = await A.dir.search("cup");
  assert.equal(found[0].username, "cupid");

  // nobody needs a public address: the room is made on the directory
  const sent = await A.dir.dm("cupid", "yo, room for us two");
  const roomOnA = A.rooms.get(sent.roomId);
  assert.ok(roomOnA);
  assert.equal(roomOnA.host.kind, "remote");
  assert.equal(roomOnA.host.origin, d.url);
  assert.match(roomOnA.name, /Crix & OhCupid/);

  // B's inbox poll delivers the invite as an event
  for (let i = 0; i < 60 && !B.events.some((e) => e.type === "directory_invite"); i++) await new Promise((r) => setTimeout(r, 100));
  const inv = B.events.find((e) => e.type === "directory_invite");
  assert.ok(inv, "the invite reached B");
  assert.equal(inv.item.from.username, "crix");
  assert.equal(inv.item.kind, "dm");
  assert.equal(inv.item.text, "yo, room for us two");
  assert.ok(inv.item.link.startsWith(`ares://room?url=${encodeURIComponent(d.url)}`), "the link points at the directory");

  // B joins with the ordinary room_join, brings an agent, speaks; A sees it
  const mirror = await B.rooms.join(inv.item.link, []);
  assert.equal(mirror.host.kind, "remote");
  await B.rooms.postAsOwner(mirror.id, "hey crix");
  for (let i = 0; i < 80 && !(await A.rooms.store.messages(roomOnA.id)).some((m) => m.text === "hey crix"); i++) await new Promise((r) => setTimeout(r, 100));
  const onA = await A.rooms.store.messages(roomOnA.id);
  const hey = onA.find((m) => m.text === "hey crix");
  assert.ok(hey, "B's message reached A through the directory");
  assert.equal(hey.from.kind, "person");
  assert.equal(hey.from.name, "OhCupid");
  // B brings an agent in later; A sees it at the table, as B's — and A's own words go the other way
  const cupid = await B.agents.create({ name: "cupid bot", instructions: "matchmaker" });
  await B.rooms.addAgent(mirror.id, cupid.id);
  for (let i = 0; i < 60 && !A.rooms.get(roomOnA.id).members.some((m) => m.name === "cupid bot"); i++) await new Promise((r) => setTimeout(r, 100));
  const seat = A.rooms.get(roomOnA.id).members.find((m) => m.name === "cupid bot");
  assert.ok(seat, "B's agent is listed on A's side");
  assert.notEqual(seat.home, "local");
  await A.rooms.postAsOwner(roomOnA.id, "@cupid bot who should we pair?");
  for (let i = 0; i < 80 && B.delivered.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(B.delivered.length, 1, "A's mention summoned B's agent on B's machine");
  assert.match(B.delivered[0].goal, /Crix \(a person, not your owner\)/);
  await B.dir.ack(inv.item.id);
  assert.equal(B.dir.wire().inbox.length, 0);

  // a second "message them" reuses the same DM room
  const again = await A.dir.dm("cupid");
  assert.equal(again.roomId, sent.roomId);

  // a group: made on the directory, invites fan out
  const g = await A.dir.group("Agency", ["cupid"], "build sites together");
  assert.deepEqual(g.invited, ["cupid"]);
  for (let i = 0; i < 60 && B.events.filter((e) => e.type === "directory_invite").length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(B.events.filter((e) => e.type === "directory_invite").length, 2);
  await A.close();
  await B.close();
  await d.close();
});
