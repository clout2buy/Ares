// A room's shared files — the "same spot" agents on two machines work in
// (owner, 2026-10-20: "they can't edit properly or work together"; Bop:
// "neon-brawl.html isn't in the room folder on my side").
//
// Pinned here:
//   1. Across two installs, a file one agent shares into a directory-hosted
//      room is the file the other side fetches, byte for byte, and updates
//      replace it in place.
//   2. Anyone with the link can open it; it is served sandboxed (its own
//      opaque origin), never as the server's origin.
//   3. Names are confined (no dot-segments, no hidden files); writes need a
//      member's token.
//   4. A join made from the guest side is announced once, not twice.

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
import { makeRoomsTool } from "../packages/cli/dist/entry/roomsTool.js";
import { setRoomsHost } from "../packages/cli/dist/entry/roomScope.js";
import { isRoomFileName } from "../packages/cli/dist/rooms.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-files-"));

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
  const rooms = new DesktopRooms({ home, workspace: ws, agents, deliver: (sid, goal) => delivered.push({ sid, goal }), busy: () => false, emit: (e) => events.push(e), publicOrigin: async () => origin, relayer: () => undefined });
  await rooms.load();
  await rooms.rename(name);
  process.env.ARES_DIRECTORY_URL = directoryUrl;
  const dir = new DesktopDirectory({ home, agents, rooms, publicOrigin: async () => origin, emit: (e) => events.push(e) });
  await dir.load();
  return { home, ws, agents, rooms, dir, events, delivered, close: async () => { dir.stop(); rooms.stop(); server.closeAllConnections?.(); server.close(); } };
}

test("room file names are confined", () => {
  for (const ok of ["neon-brawl.html", "game/index.html", "a/b/c/d.png", "_x.js"]) assert.equal(isRoomFileName(ok), true, ok);
  for (const bad of ["../x", "a/../b", ".env", "a/.git/config", "a/b/c/d/e.txt", "a\\b", "", "x y.html"]) assert.equal(isRoomFileName(bad), false, bad);
});

test("two installs share one copy of a file through a directory-hosted room", async () => {
  const data = await tmp();
  const d = await serveDirectory({ dataDir: data, port: 0 });
  const url = `http://127.0.0.1:${d.port}`;
  const A = await install("Crix", url);
  const B = await install("OhCupid", url);
  try {
    await A.dir.claim("crix", "Crix");
    await B.dir.claim("cupid", "OhCupid");
    const g = await A.dir.group("Brawl", ["cupid"], "a fighting game");
    const bob = await A.agents.create({ name: "bob", instructions: "builder" });
    await A.rooms.addAgent(g.roomId, bob.id);
    for (let i = 0; i < 60 && !B.events.some((e) => e.type === "directory_invite"); i++) await new Promise((r) => setTimeout(r, 100));
    const inv = B.events.find((e) => e.type === "directory_invite");
    const bop = await B.agents.create({ name: "bop", instructions: "playtester" });
    const mirrorB = await B.rooms.join(inv.item.link, []);
    await B.rooms.addAgent(mirrorB.id, bop.id);

    // bob writes the game on A's machine and shares it into the room
    const game = "<!doctype html><title>Neon Brawl</title><script>window.v=1</script>";
    await fs.mkdir(path.join(A.ws, "build"), { recursive: true });
    await fs.writeFile(path.join(A.ws, "build", "brawl.html"), game);
    await A.agents.bind(bob.id, "sess_bob_private");
    setRoomsHost(A.rooms.host());
    const shared = await makeRoomsTool().call({ action: "share", path: "build/brawl.html", name: "neon-brawl.html", room: "Brawl" }, { sessionId: "sess_bob_private" });
    assert.match(shared.display, /shared neon-brawl\.html v1 in Brawl — http/);
    const link = shared.output.url;
    assert.ok(link.startsWith(url), "the link is on the directory, reachable by everyone in the room");

    // bop on B's machine lists and fetches the same bytes
    await B.agents.bind(bop.id, "sess_bop_private");
    setRoomsHost(B.rooms.host());
    const list = await makeRoomsTool().call({ action: "files", room: mirrorB.name }, { sessionId: "sess_bop_private" });
    assert.match(list.display, /neon-brawl\.html/);
    const got = await makeRoomsTool().call({ action: "fetch", name: "neon-brawl.html", room: mirrorB.name }, { sessionId: "sess_bop_private" });
    assert.equal(await fs.readFile(got.output.path, "utf8"), game);

    // bop edits and shares back (he fetched first, so his v1 base is current); bob fetches the update
    await fs.writeFile(got.output.path, game.replace("window.v=1", "window.v=2"));
    const back = await makeRoomsTool().call({ action: "share", path: got.output.path, name: "neon-brawl.html", room: mirrorB.name }, { sessionId: "sess_bop_private" });
    assert.match(back.display, /updated neon-brawl\.html/);
    assert.equal((await A.rooms.fetchFile(g.roomId, "neon-brawl.html")).toString(), game.replace("window.v=1", "window.v=2"));

    // the link opens for anyone, sandboxed
    const page = await fetch(link);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("content-security-policy"), /^sandbox allow-scripts/);
    assert.match(await page.text(), /window\.v=2/);

    // writes need a member's token; names are confined on the server too
    const hostRoomId = A.rooms.get(g.roomId).host.roomId;
    assert.equal((await fetch(`${url}/gateway/rooms/${hostRoomId}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x.html", data: "eA==" }) })).status, 401);
    assert.equal((await fetch(`${url}/gateway/rooms/${hostRoomId}/files/..%2F..%2Fusers.json`)).status, 404);

    // each join/add is announced ONCE (the host records it; the guest no longer repeats it)
    for (let i = 0; i < 60 && !(await A.rooms.store.messages(g.roomId)).some((m) => /added bop/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    const thread = await A.rooms.store.messages(g.roomId);
    const adds = thread.filter((m) => /added bop/.test(m.text));
    assert.equal(adds.length, 1, `"added bop" once, got ${adds.length}`);
  } finally {
    await A.close();
    await B.close();
    await d.close();
  }
});
