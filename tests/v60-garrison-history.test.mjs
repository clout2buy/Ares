// Leaving a chat must not erase it.
//
// The garrison records each session to <home>/garrison/sessions/<id>.jsonl, but
// session.history was served from the WORKSPACE rollout store — a different
// place entirely. Every history request answered with zero entries, so the
// phone re-attached to a live conversation and rendered an empty screen: swipe
// out, come back, the whole thread was gone. It had been on disk all along.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadGarrisonRollout, rolloutPath, sessionsDir } from "../packages/garrison/dist/index.js";

async function home(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-garrison-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(sessionsDir(dir), { recursive: true });
  return dir;
}

const line = (ts, event) => JSON.stringify({ ts, event }) + "\n";

test("history replays the events the garrison actually recorded", async (t) => {
  const dir = await home(t);
  await fsp.writeFile(
    rolloutPath(dir, "sess_a"),
    line("2026-09-22T08:00:00.000Z", { type: "turn_start" }) +
      line("2026-09-22T08:00:01.000Z", { type: "text_delta", text: "hi" }) +
      line("2026-09-22T08:00:02.000Z", { type: "turn_end" }),
  );
  const entries = await loadGarrisonRollout(dir, "sess_a");
  assert.equal(entries.length, 3, "the thread is not empty — this was the whole bug");
  assert.deepEqual(entries.map((e) => e.event.type), ["turn_start", "text_delta", "turn_end"]);
  assert.equal(entries[0].ts, "2026-09-22T08:00:00.000Z", "timestamps survive, so replay dates the bubbles");
});

test("limit takes the NEWEST events — a long thread scrolls back, not forward", async (t) => {
  const dir = await home(t);
  await fsp.writeFile(
    rolloutPath(dir, "sess_b"),
    Array.from({ length: 50 }, (_, i) => line(undefined, { type: "text_delta", text: String(i) })).join(""),
  );
  const entries = await loadGarrisonRollout(dir, "sess_b", { limit: 5 });
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((e) => e.event.text), ["45", "46", "47", "48", "49"]);
  assert.equal((await loadGarrisonRollout(dir, "sess_b", { limit: 0 })).length, 50, "no limit means everything");
});

test("a torn tail line costs one event, not the whole history", async (t) => {
  const dir = await home(t);
  await fsp.writeFile(
    rolloutPath(dir, "sess_c"),
    line(undefined, { type: "turn_start" }) + '{"ts":"2026","event":{"type":"text_de',
  );
  const entries = await loadGarrisonRollout(dir, "sess_c");
  assert.deepEqual(entries.map((e) => e.event.type), ["turn_start"], "a crash mid-append must not erase the thread");
});

test("a session with no rollout is empty, not an error", async (t) => {
  const dir = await home(t);
  assert.deepEqual(await loadGarrisonRollout(dir, "sess_never_existed"), []);
});

test("a session id is a filename and cannot escape the sessions directory", async (t) => {
  const dir = await home(t);
  const secret = path.join(dir, "token");
  await fsp.writeFile(secret, line(undefined, { type: "text_delta", text: "the garrison token" }));
  for (const id of ["../token", "../../etc/passwd", "sub/dir", ""]) {
    assert.deepEqual(await loadGarrisonRollout(dir, id), [], `${JSON.stringify(id)} reads nothing`);
  }
});

test("lines without a usable event are skipped, not counted", async (t) => {
  const dir = await home(t);
  await fsp.writeFile(
    rolloutPath(dir, "sess_d"),
    line(undefined, { type: "turn_start" }) + "\n" + '{"ts":"x"}\n' + "null\n" + '{"event":{}}\n' +
      line(undefined, { type: "turn_end" }),
  );
  assert.deepEqual((await loadGarrisonRollout(dir, "sess_d")).map((e) => e.event.type), ["turn_start", "turn_end"]);
});
