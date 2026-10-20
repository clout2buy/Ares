// Smarter agents in rooms (owner, 2026-10-20): "they need to be able to do
// shit right… opened screenshots or served variants instead of what we could
// play… add all of 1, 2 and 3… accept the smaller / stronger model idea."
//
// Pinned here:
//   1. Shared files are versioned: a share over a newer copy is refused until
//      you fetch; a fetch-then-share goes through.
//   2. Rooms work hands a job to the agent's WORK thread (bound to the agent,
//      not a seat — so it runs on the full model) with the room in the goal.
//   3. Open: a private chat may open any link; a room seat only that room's
//      shared-file links.
//   4. The lead takes requests nobody was named for.
//   5. Presence: an agent working on one machine shows on the other's side.
//   6. An agent's chat model is saved and comes back.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { serveDirectory } from "../packages/cli/dist/directoryServer.js";
import { DesktopDirectory } from "../packages/cli/dist/entry/daemon/directory.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { createRoomsApi } from "../packages/cli/dist/phoneRooms.js";
import { dispatchFor, memberKey, DEFAULT_RULES } from "../packages/cli/dist/rooms.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-smart-"));

async function install(name, directoryUrl) {
  const home = await tmp();
  const ws = await tmp();
  const events = [];
  const delivered = [];
  const agents = new DesktopAgents({ home, defaultBrain: () => ({ provider: "anthropic", model: "claude-opus-5-5" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
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
  return { home, ws, agents, rooms, dir, events, delivered, close: async () => { dir.stop(); rooms.stop(); server.closeAllConnections?.(); server.close(); } };
}

test("versioned files, work threads, Open limits and presence across two installs", async () => {
  const data = await tmp();
  const d = await serveDirectory({ dataDir: data, port: 0 });
  const url = `http://127.0.0.1:${d.port}`;
  const A = await install("Crix", url);
  const B = await install("OhCupid", url);
  try {
    await A.dir.claim("crix", "Crix");
    await B.dir.claim("cupid", "OhCupid");
    const bob = await A.agents.create({ name: "bob", instructions: "builder", chatModel: "claude-haiku-5-5" });
    const g = await A.dir.group("Brawl", ["cupid"]);
    await A.rooms.addAgent(g.roomId, bob.id);
    for (let i = 0; i < 60 && !B.events.some((e) => e.type === "directory_invite"); i++) await new Promise((r) => setTimeout(r, 100));
    const inv = B.events.find((e) => e.type === "directory_invite");
    const bop = await B.agents.create({ name: "bop", instructions: "tester" });
    const mB = await B.rooms.join(inv.item.link, []);
    await B.rooms.addAgent(mB.id, bop.id);

    // 6. chat model saved
    assert.equal(A.agents.get(bob.id).chatModel, "claude-haiku-5-5");

    // 1. versions: bob shares v1; bop fetches, edits, shares v2; bob's stale share is refused
    const v1 = await A.rooms.shareFile(g.roomId, "brawl.html", Buffer.from("v1"), "bob");
    assert.equal(v1.rev, 1);
    await B.rooms.fetchFile(mB.id, "brawl.html");
    const v2 = await B.rooms.shareFile(mB.id, "brawl.html", Buffer.from("v2"), "bop");
    assert.equal(v2.rev, 2);
    await assert.rejects(A.rooms.shareFile(g.roomId, "brawl.html", Buffer.from("v1-edit"), "bob"), /at v2 \(by bop\) — fetch it first/);
    assert.equal((await A.rooms.fetchFile(g.roomId, "brawl.html")).toString(), "v2");
    const v3 = await A.rooms.shareFile(g.roomId, "brawl.html", Buffer.from("v3"), "bob");
    assert.equal(v3.rev, 3);
    const files = await A.rooms.listFiles(g.roomId);
    assert.equal(files.find((f) => f.name === "brawl.html").rev, 3);

    // 2. work: a separate thread, bound to bob, not a seat, with the room in the goal
    await A.rooms.postAsOwner(g.roomId, "@bob hi");
    const seat = A.rooms.get(g.roomId).threads[bob.id];
    assert.ok(seat);
    const host = A.rooms.host();
    const w = await host.work(seat, "make the fireball slower and playtest it");
    assert.notEqual(w.threadId, seat);
    assert.equal(A.agents.agentForSession(w.threadId).id, bob.id);
    assert.equal(A.rooms.isSeat(w.threadId), false, "the work thread is not a seat — it runs on the full model");
    assert.equal(A.rooms.isWorkThread(w.threadId), true);
    const job = A.delivered.find((x) => x.sid === w.threadId);
    assert.match(job.goal, /\[work for room "[^"]+"\] make the fireball slower/);
    assert.match(job.goal, /Rooms share/);

    // 3. Open: the seat may open the room's file link, not anything else; private chats may
    const link = (await A.rooms.fileUrl(A.rooms.get(g.roomId), "brawl.html"));
    assert.equal(await A.rooms.mayOpen(seat, link), true);
    assert.equal(await A.rooms.mayOpen(seat, "https://evil.example/phish"), false);
    assert.equal(await A.rooms.mayOpen("sess_private_anything", "https://evil.example/phish"), true);

    // 5. presence: bob's turn starting on A shows as working on B
    A.rooms.onTurnStart(seat);
    for (let i = 0; i < 80 && !(B.rooms.presenceOf(mB.id).length); i++) await new Promise((r) => setTimeout(r, 100));
    const pres = B.rooms.presenceOf(mB.id);
    assert.equal(pres.length, 1, "bob shows as working on Cupid's side");
    assert.equal(pres[0].name, "bob");
    await A.rooms.onTurnEnd(seat);
    for (let i = 0; i < 80 && B.rooms.presenceOf(mB.id).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(B.rooms.presenceOf(mB.id).length, 0, "and stops when the turn ends");
  } finally {
    await A.close();
    await B.close();
    await d.close();
  }
});

test("the lead takes requests nobody was named for", () => {
  const owner = { kind: "person", id: "owner", name: "Crix", home: "local" };
  const a = { kind: "agent", id: "p_a00000000000", name: "bob", home: "local", owner: "person:local:owner", joinedAt: "" };
  const b = { kind: "agent", id: "p_b00000000000", name: "andy", home: "local", owner: "person:local:owner", joinedAt: "" };
  const room = { id: "room_abcdef123456", name: "R", purpose: "", members: [{ kind: "person", id: "owner", name: "Crix", home: "local", joinedAt: "" }, a, b], rules: { ...DEFAULT_RULES, lead: memberKey(b) }, board: [], notes: "", host: { kind: "local" }, invites: [], guests: [], threads: {}, seq: 0, createdAt: "", updatedAt: "" };
  const m = { seq: 1, id: "rm_1", at: "", from: owner, text: "build us a game", kind: "text" };
  assert.deepEqual(dispatchFor(room, m, [m]).agents, [b.id]);
  assert.deepEqual(dispatchFor({ ...room, rules: { ...DEFAULT_RULES } }, m, [m]).agents, [a.id], "no lead set: the first agent");
});
