import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROGRESS_MARKER, runSkill } from "../packages/agent/dist/index.js";
import { LiveFeedHub, rpcCall } from "../packages/cli/dist/entry/daemon/liveFeed.js";

/** A fake engine speaking the newline-JSON RPC: serves frames, records input. */
function fakeEngine() {
  const calls = [];
  let frames = 0;
  let alive = true;
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const req = JSON.parse(line);
        calls.push(req);
        let response;
        if (!alive) response = { id: req.id, ok: false, error: "gone" };
        else if (req.method === "frame" || req.method === "editor.frame") {
          frames += 1;
          response = { id: req.id, ok: true, result: { image: Buffer.from(`frame-${frames}`).toString("base64"), width: 320, height: 180 } };
        } else if (req.method.startsWith("input.")) response = { id: req.id, ok: true, result: { echoed: req.params } };
        else response = { id: req.id, ok: false, error: `unknown ${req.method}` };
        socket.write(JSON.stringify(response) + "\n");
      }
    });
  });
  return {
    calls,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    kill() {
      alive = false;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("runSkill streams marker lines to onProgress and keeps them out of the logs", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-progress-home-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "skills", "streamer");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\ndescription: fixture\n---\n", "utf8");
  await fs.writeFile(path.join(dir, "handler.js"), `
export default async function handler(input) {
  process.stdout.write("plain log line\\n");
  process.stdout.write(${JSON.stringify(PROGRESS_MARKER)} + " " + JSON.stringify({ kind: "live_frame", image: "x".repeat(70000), width: 1, height: 1 }) + "\\n");
  process.stdout.write(${JSON.stringify(PROGRESS_MARKER)} + " not json\\n");
  process.stdout.write("partial " );
  await new Promise((r) => setTimeout(r, 30));
  process.stdout.write("line\\n");
  process.stdout.write(${JSON.stringify(PROGRESS_MARKER)} + " " + JSON.stringify({ kind: "live_step", label: "done" }));
  return { ok: true };
}
`, "utf8");
  const events = [];
  const run = await runSkill({ home, name: "streamer", input: {}, onProgress: (e) => events.push(e) });
  assert.equal(run.ok, true, run.error);
  assert.deepEqual(events.map((e) => e.kind), ["live_frame", "live_step"], "well-formed markers are delivered in order; malformed ones are dropped");
  assert.equal(events[0].image.length, 70000, "a frame larger than one pipe chunk arrives intact");
  assert.match(run.logs, /plain log line/);
  assert.match(run.logs, /partial line/);
  assert.doesNotMatch(run.logs, /ares-progress/, "marker lines never pollute the retained logs");
});

test("LiveFeedHub polls a detached target, forwards input, stops on loss, and ignores non-game input", async (t) => {
  const engine = fakeEngine();
  const port = await engine.listen();
  t.after(() => engine.close());
  const emitted = [];
  const hub = new LiveFeedHub({ emit: (obj, sessionId) => emitted.push({ ...obj, sessionId }), fps: 20, maxMisses: 3 });
  t.after(() => hub.dispose());

  // A provider streaming its own frames: the hub only records the offer.
  hub.onControl({ source: "godot", side: "game", port, state: "running", label: "Fixture — main" }, "s1");
  assert.equal(emitted.at(-1).state, "streaming");
  assert.equal(hub.status().watching, null);

  // Left running for the owner → the hub polls frames itself.
  hub.onControl({ source: "godot", side: "game", host: "127.0.0.1", port, method: "frame", state: "detached", label: "Fixture — main" }, "s1");
  assert.equal(emitted.find((e) => e.type === "live_feed" && e.state === "watching")?.interactive, true);
  await sleep(260);
  const frames = emitted.filter((e) => e.type === "live_frame");
  assert.ok(frames.length >= 3, `frames streamed (${frames.length})`);
  assert.equal(frames[0].sessionId, "s1");
  assert.equal(Buffer.from(frames[0].image, "base64").toString(), "frame-1");
  assert.equal(frames[0].width, 320);

  // Owner input reaches the engine's input methods with explicit edges.
  const sent = await hub.input([
    { kind: "key", key: "W", pressed: true },
    { kind: "mouse", x: 10, y: 20, button: 1, pressed: true },
    { kind: "mouse", x: 3, y: -4, relative: true },
    { kind: "wheel", x: 1, y: 1, delta: -120 },
    { kind: "key", key: "W", pressed: false },
  ], "s1");
  assert.equal(sent.sent, 5, sent.error);
  const inputs = engine.calls.filter((c) => c.method.startsWith("input."));
  assert.deepEqual(inputs.map((c) => c.method), ["input.key", "input.mouse", "input.mouse", "input.mouse", "input.key"]);
  assert.deepEqual(inputs[0].params, { key: "W", pressed: true, shift: false, ctrl: false, alt: false });
  assert.deepEqual(inputs[1].params, { x: 10, y: 20, button: 1, pressed: true, move: true });
  assert.deepEqual(inputs[2].params, { x: 3, y: -4, relative: true });
  assert.equal(inputs[3].params.button, 4, "wheel up is Godot mouse button 4");
  assert.equal(inputs[4].params.pressed, false);

  // Editor feeds are view-only.
  hub.onControl({ source: "godot", side: "editor", port, method: "editor.frame", state: "available", label: "editor" }, "s1");
  assert.equal(emitted.at(-1).state, "offered");
  hub.startWatching({ source: "godot", side: "editor" }, "s1");
  assert.equal(hub.status().watching.side, "editor");
  const refused = await hub.input([{ kind: "key", key: "A", pressed: true }], "s1");
  assert.equal(refused.sent, 0);
  assert.match(refused.error, /view-only/);

  // Back to the game; when it dies the feed is declared lost and offers clear.
  hub.startWatching({ source: "godot", side: "game" }, "s1");
  engine.kill();
  await sleep(400);
  const lost = emitted.find((e) => e.type === "live_feed" && e.state === "lost");
  assert.ok(lost, "feed reports the lost game");
  assert.equal(hub.status().watching, null);
  assert.equal(hub.status().offers.some((o) => o.side === "game"), false);
  hub.stopWatching();
  assert.equal(hub.startWatching({ source: "godot", side: "game" }, "s1"), false, "nothing left to watch");
  assert.equal(emitted.at(-1).state, "unavailable");
});

test("rpcCall surfaces engine errors and connection refusals as errors", async (t) => {
  const engine = fakeEngine();
  const port = await engine.listen();
  t.after(() => engine.close());
  const frame = await rpcCall("127.0.0.1", port, "frame", {});
  assert.equal(frame.width, 320);
  await assert.rejects(rpcCall("127.0.0.1", port, "nope", {}), /unknown nope/);
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  await assert.rejects(rpcCall("127.0.0.1", deadPort, "frame", {}, 1500), /ECONNREFUSED|closed|timed out/);
});
