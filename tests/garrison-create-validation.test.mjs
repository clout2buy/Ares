// session.create is validated at the gateway, not on the first send.
//
// Sessions materialise lazily, so before this a bad hint was accepted,
// session.created was broadcast to every client, and the failure arrived on the
// first session.send as a raw errno ("ENOTDIR: … mkdir '/etc/passwd/.ares/…'")
// for a session that could never run. Pins:
//  1. non-string provider/model/workspace are refused in words — never Node's
//     ERR_INVALID_ARG_TYPE text.
//  2. a workspace that is missing, or is a regular file, is refused.
//  3. a refused create never reaches SessionManager.create and is never
//     broadcast.
//  4. a real directory (and no workspace at all) still creates.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GarrisonServer, ensureToken } from "../packages/garrison/dist/index.js";

const wsModule = await import("ws").catch(
  () => import("../packages/garrison/node_modules/ws/wrapper.mjs"),
);
const WebSocket = wsModule.default ?? wsModule.WebSocket;

function fakeSessions() {
  const created = [];
  return {
    created,
    list: () => [],
    create: (opts) => {
      created.push(opts);
      return { id: `s${created.length}`, title: "", model: "m", provider: "p", busy: false };
    },
    attach: () => () => {},
    ensureLive: async () => ({}),
    send: async () => {},
    interrupt: () => {},
    respondPermission: () => true,
    lastActivityAt: () => Date.now(),
    flush: async () => {},
  };
}

function connect(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const frames = [];
    const waiters = [];
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, client: "test", proto: 1 })));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.on("error", reject);
    const next = () =>
      new Promise((res) => {
        const buffered = frames.shift();
        if (buffered) res(buffered);
        else waiters.push(res);
      });
    next().then((first) => resolve({ ws, next, first, send: (f) => ws.send(JSON.stringify(f)) }));
  });
}

test("session.create: bad hints are refused at the gateway, good ones still create", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ares-create-validate-"));
  const realDir = await mkdtemp(path.join(tmpdir(), "ares-create-ws-"));
  const aFile = path.join(realDir, "not-a-dir.txt");
  await writeFile(aFile, "x");
  const sessions = fakeSessions();
  const server = new GarrisonServer({ home, sessions, port: 0 });
  try {
    const { port } = await server.start();
    const c = await connect(port, await ensureToken(home));
    assert.equal(c.first.type, "welcome");

    const refused = [
      [{ provider: 5 }, /provider must be a string/],
      [{ model: [] }, /model must be a string/],
      [{ workspace: {} }, /workspace must be a string/],
      [{ workspace: path.join(realDir, "missing") }, /workspace is not a directory/],
      [{ workspace: aFile }, /workspace is not a directory/],
    ];
    for (const [extra, expected] of refused) {
      c.send({ type: "session.create", ...extra });
      const reply = await c.next();
      assert.equal(reply.type, "error", JSON.stringify(extra));
      assert.match(reply.message, expected);
      assert.doesNotMatch(reply.message, /"path" argument|ENOTDIR|EACCES|ENOENT/, "no raw Node/errno text");
    }
    assert.equal(sessions.created.length, 0, "a refused create must never reach the SessionManager");

    c.send({ type: "session.create", workspace: realDir });
    assert.equal((await c.next()).type, "session.created");
    c.send({ type: "session.create" });
    assert.equal((await c.next()).type, "session.created");
    assert.equal(sessions.created.length, 2);
    assert.equal(sessions.created[0].workspace, realDir);

    c.ws.terminate();
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
    await rm(realDir, { recursive: true, force: true });
  }
});
