// A session's history must never be able to kill the garrison.
//
// 2026-09-22: every Bash output chunk was persisted as tool_progress, whole.
// One session's rollout reached 240MB (224MB of it progress), and serving the
// phone that session's history read the file into one string and parsed all
// of it — the garrison died with a JavaScript heap OOM mid-morning and took
// Telegram and the phone down with it.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compactRolloutEvent,
  loadGarrisonRollout,
  rehydrateSession,
  rolloutPath,
  sessionsDir,
  ROLLOUT_PROGRESS_TEXT_CAP,
} from "../packages/garrison/dist/index.js";

async function home(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ares-rollout-mem-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(sessionsDir(dir), { recursive: true });
  return dir;
}

const line = (event) => JSON.stringify({ ts: "2026-09-22T08:00:00.000Z", event }) + "\n";

test("tool_progress keeps only the tail of its output on disk", () => {
  const text = "a".repeat(10_000) + "THE-END";
  const out = compactRolloutEvent({ type: "tool_progress", id: "t1", data: { kind: "shell_output", stream: "stdout", text } });
  assert.equal(out.data.text.length, ROLLOUT_PROGRESS_TEXT_CAP);
  assert.ok(out.data.text.endsWith("THE-END"), "the newest output is what a re-attaching client wants");
  assert.equal(out.data.truncatedChars, text.length - ROLLOUT_PROGRESS_TEXT_CAP);
  assert.equal(out.data.kind, "shell_output", "non-string fields pass through");
});

test("every other event is stored exactly as emitted", () => {
  const big = "x".repeat(50_000);
  for (const event of [
    { type: "tool_end", id: "t1", output: big, durationMs: 1 },
    { type: "text_delta", text: big },
    { type: "tool_progress", id: "t2", data: { kind: "grep_match", file: "a.ts", line: 3, total: 1 } },
  ]) {
    assert.equal(compactRolloutEvent(event), event);
  }
});

test("an already-bloated rollout loads compacted, and the tool results survive", async (t) => {
  const dir = await home(t);
  const chunk = "y".repeat(200_000);
  let body = line({ type: "turn_start" });
  for (let i = 0; i < 50; i++) {
    body += line({ type: "tool_progress", id: "t1", data: { kind: "shell_output", stream: "stdout", text: chunk } });
  }
  body += line({ type: "tool_end", id: "t1", output: "done", durationMs: 5 });
  body += line({ type: "turn_end" });
  await fsp.writeFile(rolloutPath(dir, "sess_big"), body);

  const entries = await loadGarrisonRollout(dir, "sess_big");
  assert.equal(entries.length, 53, "nothing is dropped, only shrunk");
  const retained = entries.reduce((n, e) => n + JSON.stringify(e).length, 0);
  assert.ok(retained < 200_000, `history held in memory stays small (was ${retained} bytes of a ${body.length}-byte file)`);
  assert.equal(entries.at(-2).event.output, "done");

  const tail = await loadGarrisonRollout(dir, "sess_big", { limit: 2 });
  assert.deepEqual(tail.map((e) => e.event.type), ["tool_end", "turn_end"]);
});

test("a missing rollout is empty history, not a crash", async (t) => {
  const dir = await home(t);
  assert.deepEqual(await loadGarrisonRollout(dir, "sess_nope"), []);
  assert.equal(await rehydrateSession(dir, "sess_nope"), null);
});

test("CRLF and torn tail lines still load", async (t) => {
  const dir = await home(t);
  await fsp.writeFile(
    rolloutPath(dir, "sess_crlf"),
    line({ type: "turn_start" }).replace("\n", "\r\n") + line({ type: "turn_end" }) + '{"ts":"x","event":{"ty',
  );
  const entries = await loadGarrisonRollout(dir, "sess_crlf");
  assert.deepEqual(entries.map((e) => e.event.type), ["turn_start", "turn_end"]);
});
