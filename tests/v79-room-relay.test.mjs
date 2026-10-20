// The room's game relay + Rooms playtest (owner, 2026-10-20, room "Doing &
// Cupid"): FaxWare's stick-fight game went through five revisions because
// its hand-rolled relay forwarded `ws` Buffers raw — binary frames, a Blob in
// the browser, a JSON.parse that failed silently, a grey screen — and nobody
// ran two real clients. Agents also kept putting pages and screenshots on
// the owner's screen unasked.
//
// Pinned here:
//   1. The relay a room's gateway serves pairs players by code and sends
//      every frame as TEXT, verbatim — on the directory's dependency-free
//      socket and on the garrison's `ws` socket alike.
//   2. Every failure closes with a code and a reason a page can show:
//      binary 1003, too big 1009, no room 4404, full 4409.
//   3. The relay says hello/join/leave and who hosts (the oldest player).
//   4. twoClientCheck passes on the relay and FAILS, naming the binary frame,
//      against a relay with the stick-fight bug.
//   5. Rooms playtest runs it from an agent's turn; room work no longer tells
//      agents to Open things unasked, and asked, it opens the real link live.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "../packages/cli/node_modules/ws/wrapper.mjs";

import { serveDirectory } from "../packages/cli/dist/directoryServer.js";
import { createRoomRelay, roomRelayUrl } from "../packages/cli/dist/roomRelay.js";
import { twoClientCheck, pageFindings } from "../packages/cli/dist/entry/daemon/roomPlaytest.js";
import { RoomStore, newRoomId, normalizeRoom } from "../packages/cli/dist/rooms.js";
import { createRoomsApi } from "../packages/cli/dist/phoneRooms.js";
import { DesktopRooms } from "../packages/cli/dist/entry/daemon/rooms.js";
import { DesktopAgents } from "../packages/cli/dist/entry/daemon/agents.js";
import { makeRoomsTool } from "../packages/cli/dist/entry/roomsTool.js";
import { setRoomsHost } from "../packages/cli/dist/entry/roomScope.js";
import { roomLayerBlock } from "../packages/cli/dist/entry/prompt/texting.js";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ares-relay-"));

async function roomIn(home) {
  const id = newRoomId();
  await new RoomStore(home).save(normalizeRoom({ id, name: "Game night" }));
  return id;
}

/** A client that records frames (text vs binary) and how it closed. */
function client(url) {
  const ws = new WebSocket(url);
  const c = { ws, frames: [], closed: null };
  c.opened = new Promise((resolve) => { ws.once("open", resolve); ws.once("error", resolve); });
  ws.on("message", (data, isBinary) => c.frames.push({ text: data.toString("utf8"), binary: isBinary }));
  c.done = new Promise((resolve) => ws.on("close", (code, reason) => { c.closed = { code, reason: reason.toString() }; resolve(c.closed); }));
  ws.on("error", () => undefined);
  return c;
}
const until = async (fn, ms = 4000) => {
  for (let t = 0; t < ms; t += 20) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error("timed out");
};
const json = (c) => c.frames.map((f) => JSON.parse(f.text));

test("relay on the directory: pairs by code, text frames verbatim, hello/join/leave and host hand-over", async () => {
  const data = await tmp();
  const roomId = await roomIn(data);
  const d = await serveDirectory({ dataDir: data, port: 0 });
  const base = `ws://127.0.0.1:${d.port}/gateway/rooms/${roomId}/relay`;
  try {
    const a = client(`${base}/ABCD`);
    await until(() => a.frames.length === 1);
    const helloA = json(a)[0];
    assert.equal(helloA.relay, "hello");
    assert.equal(helloA.host, helloA.you, "first in hosts");
    const b = client(`${base}/abcd`); // codes are case-insensitive
    const other = client(`${base}/WXYZ`);
    await until(() => b.frames.length === 1 && a.frames.length === 2 && other.frames.length === 1);
    const helloB = json(b)[0];
    assert.equal(helloB.host, helloA.you);
    assert.deepEqual(json(a)[1], { relay: "join", id: helloB.you, host: helloA.you, peers: [helloA.you, helloB.you] });

    const msg = '{"t":"move","x":3,  "y":4}';
    a.ws.send(msg);
    await until(() => b.frames.length === 2);
    assert.equal(b.frames[1].binary, false, "TEXT frame — a browser hands the page a string, not a Blob");
    assert.equal(b.frames[1].text, msg, "verbatim");
    // a message split over continuation frames arrives whole
    b.ws.send('{"t":"chat",', { fin: false });
    b.ws.send('"text":"hi"}', { fin: true });
    await until(() => a.frames.length === 3);
    assert.deepEqual(JSON.parse(a.frames[2].text), { t: "chat", text: "hi" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(other.frames.length, 1, "another code is another game");

    a.ws.close();
    await until(() => b.frames.length === 3);
    assert.deepEqual(json(b)[2], { relay: "leave", id: helloA.you, host: helloB.you, peers: [helloB.you] });
    b.ws.close();
    other.ws.close();
  } finally {
    await d.close();
  }
});

test("relay on the directory: every failure is a close code with a reason", async () => {
  const data = await tmp();
  const roomId = await roomIn(data);
  const d = await serveDirectory({ dataDir: data, port: 0 });
  const base = `ws://127.0.0.1:${d.port}/gateway/rooms/${roomId}/relay`;
  try {
    const bin = client(`${base}/BINS`);
    await until(() => bin.frames.length === 1);
    bin.ws.send(Buffer.from('{"t":"move"}')); // what the stick-fight relay did
    const c1 = await bin.done;
    assert.equal(c1.code, 1003);
    assert.match(c1.reason, /send JSON as text/);

    const big = client(`${base}/BIGS`);
    await until(() => big.frames.length === 1);
    assert.equal(json(big)[0].maxBytes, 16384);
    big.ws.send("x".repeat(20_000));
    assert.equal((await big.done).code, 1009);

    const none = client(`ws://127.0.0.1:${d.port}/gateway/rooms/room_000000000000/relay/ABCD`);
    const c3 = await none.done;
    assert.equal(c3.code, 4404);
    assert.match(c3.reason, /no such room/);

    // anything else that asks to upgrade here is refused
    const stray = new WebSocket(`ws://127.0.0.1:${d.port}/gateway`);
    const refused = await new Promise((resolve) => { stray.on("unexpected-response", (_q, res) => resolve(res.statusCode)); stray.on("error", () => resolve("error")); });
    assert.equal(refused, 404);
  } finally {
    await d.close();
  }
});

test("relay on the garrison's ws sockets: same protocol, and a full game says so", async () => {
  const home = await tmp();
  const roomId = await roomIn(home);
  const relay = createRoomRelay({ home, maxPeers: 2 });
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws, req) => {
    const p = (req.url ?? "/").split("?")[0];
    if (relay.handles(p)) void relay.accept(ws, p); else ws.close(1008, "no");
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `ws://127.0.0.1:${http.address().port}/gateway/rooms/${roomId}/relay/DUEL`;
  try {
    const a = client(base);
    const b = client(base);
    await until(() => a.frames.length >= 1 && b.frames.length >= 1);
    a.ws.send('{"hit":1}');
    await until(() => b.frames.some((f) => f.text === '{"hit":1}'));
    assert.equal(b.frames.find((f) => f.text === '{"hit":1}').binary, false);
    const c = client(base);
    const closed = await c.done;
    assert.equal(closed.code, 4409);
    assert.match(closed.reason, /full \(2 players\)/);
    assert.deepEqual(relay.stats(), { [roomId]: { DUEL: 2 } });
    a.ws.close(); b.ws.close();
  } finally {
    relay.close();
    wss.close();
    http.closeAllConnections?.();
    http.close();
  }
});

test("twoClientCheck passes on the room relay and names the binary-frame bug on a broken one", async () => {
  const data = await tmp();
  const roomId = await roomIn(data);
  const d = await serveDirectory({ dataDir: data, port: 0 });
  // the stick-fight relay as it was on the box: ws.send(m) with m a Buffer
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const peers = new Set();
  wss.on("connection", (ws) => {
    peers.add(ws);
    ws.send(JSON.stringify({ relay: "hello", you: `p${peers.size}`, host: "p1" }));
    for (const p of peers) if (p !== ws) p.send(JSON.stringify({ relay: "join", id: `p${peers.size}` }));
    ws.on("message", (m) => { for (const p of peers) if (p !== ws) p.send(m); });
    ws.on("close", () => peers.delete(ws));
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  try {
    const good = await twoClientCheck(roomRelayUrl(`http://127.0.0.1:${d.port}/gateway/rooms/${roomId}/files/game.html`, "TEST"));
    assert.equal(good.ok, true, good.problems.join("; "));
    assert.ok(good.steps.some((s) => /A → B: JSON arrived as a text frame/.test(s)));
    assert.ok(good.steps.some((s) => /A saw B leave/.test(s)));

    const bad = await twoClientCheck(`ws://127.0.0.1:${http.address().port}/x`, 2000);
    assert.equal(bad.ok, false);
    assert.match(bad.problems[0], /client B .*BINARY frame/);
  } finally {
    await d.close();
    wss.close();
    http.closeAllConnections?.();
    http.close();
  }
});

test("pageFindings flags what broke multiplayer before, and is quiet on a relay page", () => {
  const p2p = pageFindings('<script src="https://unpkg.com/peerjs"></script><script>new Peer()</script>');
  assert.ok(p2p.some((f) => /peer-to-peer/.test(f)));
  const own = pageFindings('<script>const ws=new WebSocket("wss://stick.oruna.org");ws.onmessage=(e)=>{const m=JSON.parse(e.data)}</script>');
  assert.ok(own.some((f) => /not the room relay/.test(f)));
  assert.ok(own.some((f) => /no close handler/.test(f)));
  assert.ok(own.some((f) => /JSON\.parse/.test(f)));
  const good = pageFindings(`<script>const ws=new WebSocket(location.host+location.pathname.replace(/\\/files\\/.*$/,'/relay/')+code);
ws.onclose=(e)=>show(e.code+' '+e.reason);ws.onmessage=(e)=>{try{handle(JSON.parse(e.data))}catch(err){show(err)}}</script>`);
  assert.deepEqual(good, []);
  assert.equal(roomRelayUrl("https://people.mistiqueai.com/gateway/rooms/room_abc123/files/game/index.html", "ab12"), "wss://people.mistiqueai.com/gateway/rooms/room_abc123/relay/AB12");
});

test("Rooms playtest from an agent's turn; room work doesn't push things onto the owner's screen", async () => {
  const home = await tmp();
  const ws = await tmp();
  const delivered = [];
  const agents = new DesktopAgents({ home, defaultBrain: () => ({ provider: "mock", model: "m" }), deliver: () => undefined, busy: () => false, emit: () => undefined });
  await agents.load();
  const api = createRoomsApi({ home });
  const relay = createRoomRelay({ home });
  const server = createServer((req, res) => { void api(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) { res.writeHead(404); res.end(); } }); });
  server.on("upgrade", (req, socket, head) => relay.acceptUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rooms = new DesktopRooms({ home, workspace: ws, agents, deliver: (sid, goal) => delivered.push({ sid, goal }), busy: () => false, emit: () => undefined, publicOrigin: async () => origin, relayer: () => undefined });
  await rooms.load();
  try {
    const fax = await agents.create({ name: "FaxWare", instructions: "builder" });
    const room = await rooms.create({ name: "Doing & Cupid", agents: [fax.id] });
    await agents.bind(fax.id, "sess_fax_private");
    setRoomsHost(rooms.host());
    const page = '<script>const ws=new WebSocket("wss://stick.oruna.org")</script>';
    await fs.writeFile(path.join(ws, "stickfight.html"), page);
    await makeRoomsTool().call({ action: "share", path: "stickfight.html", room: room.name }, { sessionId: "sess_fax_private" });
    const out = await makeRoomsTool().call({ action: "playtest", name: "stickfight.html", room: room.name }, { sessionId: "sess_fax_private" });
    assert.equal(out.output.ok, true, out.display);
    assert.match(out.display, /two clients connected through ws:\/\/127\.0\.0\.1:\d+\/gateway\/rooms\/room_[a-z0-9]+\/relay\/T/);
    assert.match(out.display, /page: opens its own WebSocket server, not the room relay/);
    assert.match(out.display, /not proven: .*does not prove the game itself/);

    // the work hand-off no longer tells agents to Open things on the owner's screen
    const sid = await rooms.startWork(room, fax.id, "make a stick-figure fighting game");
    const goal = delivered.find((d) => d.sid === sid).goal;
    assert.doesNotMatch(goal, /use Open/);
    assert.match(goal, /Don't put things on your owner's screen unasked/);
    assert.match(goal, /open the REAL link live in the Forge .* never a screenshot, never a local copy/);
    assert.match(goal, /Rooms playtest/);
    // the work thread is never "blocked" from opening a link (a game on the owner's own domain)
    assert.equal(await rooms.mayOpen(sid, "https://stick.example.org/"), true);
    assert.equal(await rooms.mayOpen("sess_fax_private", "https://example.com/"), true, "a private chat may");

    const layer = roomLayerBlock({ name: "x", purpose: "", turns: "mention", maxAgentRun: 4, members: [], board: "", notes: "", folder: "/tmp/x" });
    assert.match(layer, /on YOUR owner's screen only when they ask — then the real link, live/);
    assert.match(layer, /Rooms playtest/);
  } finally {
    rooms.stop();
    relay.close();
    server.closeAllConnections?.();
    server.close();
  }
});
