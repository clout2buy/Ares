// Verifies the cross-surface digest ("Elsewhere today") + the turn pipeline's
// plan-pressure grading:
//   1. Two owner sessions on different surfaces appear, most recent first; the
//      guest session and the current session are excluded.
//   2. The char budget is honoured (oldest sessions dropped first).
//   3. A 3MB rollout is tail-read, not slurped (< 500ms).
//   4. Injection gating: first turn yes, second turn no, new activity yes;
//      guests never get one; ARES_CROSS_SURFACE=0 disables.
//   5. prepareUserTurn grades plan pressure: a substantial coding message sets
//      planPressure.next, a greeting leaves it false.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCrossSurfaceDigest,
  crossSurfaceBeforeTurn,
  resetCrossSurfaceGate,
} from "../packages/cli/dist/entry/crossSurfaceDigest.js";
import { prepareUserTurn } from "../packages/cli/dist/entry/turnPipeline.js";
import { createPlanPressure } from "../packages/cli/dist/entry/planPressure.js";

process.env.ARES_MNEMOSYNE = "0";

const NOW = Date.parse("2026-09-02T18:00:00Z");
const HOUR = 3_600_000;

function line(ts, event) {
  return JSON.stringify({ ts: new Date(ts).toISOString(), event }) + "\n";
}
function userTurn(ts, text, id = `u_${ts}`) {
  return line(ts, { type: "turn_start", userMessage: { id, role: "user", content: [{ type: "text", text }], createdAt: new Date(ts).toISOString() } });
}
function assistantDone(ts, text, id = `a_${ts}`) {
  return line(ts, { type: "message_done", message: { id, role: "assistant", content: [{ type: "text", text }], createdAt: new Date(ts).toISOString() } });
}

/** Write one garrison-style session (meta + rollout) into a temp home. */
async function writeSession(home, { id, title, surface, tenant, turns }) {
  const dir = path.join(home, "garrison", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const meta = { id, title, provider: "mock", model: "mock", workspace: home, createdAt: new Date(NOW - 5 * HOUR).toISOString() };
  if (surface) meta.surface = surface;
  if (tenant) meta.tenant = tenant;
  await fs.writeFile(path.join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + "\n");
  let body = "";
  let last = NOW;
  for (const [ts, user, assistant] of turns) {
    body += userTurn(ts, user) + assistantDone(ts + 30_000, assistant);
    last = ts + 30_000;
  }
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, body);
  await fs.utimes(file, new Date(last), new Date(last));
  return file;
}

async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-xsurface-"));
  await writeSession(home, {
    id: "sess_desktop", title: "kitchen remodel budget", surface: "desktop", tenant: { role: "owner" },
    turns: [[NOW - 3 * HOUR, "how much did we say for the cabinets", "You budgeted $6,400 for cabinets."]],
  });
  await writeSession(home, {
    id: "sess_phone", title: "lunch plans", surface: "telegram", tenant: { role: "owner" },
    turns: [[NOW - 1 * HOUR, "remind me to call the contractor at 4", "Set: call the contractor at 4pm."]],
  });
  await writeSession(home, {
    id: "sess_guest", title: "sarah chat", surface: "telegram", tenant: { role: "guest", chatId: "99" },
    turns: [[NOW - 10 * 60_000, "can you help me plan a birthday party", "Of course, Sarah."]],
  });
  await writeSession(home, {
    id: "sess_current", title: "this one", surface: "tui", tenant: { role: "owner" },
    turns: [[NOW - 5 * 60_000, "what's up", "Nothing yet."]],
  });
  return home;
}

test("digest: owner sessions on other surfaces, most recent first; guest + current excluded", async () => {
  const home = await makeHome();
  const digest = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_current", tenant: { role: "owner" }, now: NOW });
  assert.deepEqual(digest.sessions.map((s) => s.id), ["sess_phone", "sess_desktop"], "recency order, guest and current excluded");
  assert.match(digest.text, /^Elsewhere today/);
  assert.match(digest.text, /\[telegram\] lunch plans \(59m ago\)/);
  assert.match(digest.text, /you: remind me to call the contractor at 4/);
  assert.match(digest.text, /ares: Set: call the contractor at 4pm\./);
  assert.match(digest.text, /\[desktop\] kitchen remodel budget \(2h ago\)/);
  assert.ok(!digest.text.includes("birthday"), "a guest's conversation never reaches the owner's digest");
  assert.ok(!digest.text.includes("this one"), "the current session is not its own digest");
  assert.equal(digest.newestActivityAt, NOW - HOUR + 30_000);
  // A stale window excludes everything.
  const stale = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_current", now: NOW + 48 * HOUR });
  assert.equal(stale.text, "");
  // A guest tenant sees nothing at all.
  const guest = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_x", tenant: { role: "guest", chatId: "99" }, now: NOW });
  assert.equal(guest.text, "");
  assert.equal(guest.sessions.length, 0);
});

test("digest: respects the char budget by dropping the oldest sessions first", async () => {
  const home = await makeHome();
  const full = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_current", now: NOW });
  const tight = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_current", now: NOW, budgetChars: full.text.length - 10 });
  assert.equal(tight.sessions.length, 1, "one session dropped to fit");
  assert.equal(tight.sessions[0].id, "sess_phone", "the most recent survives");
  assert.ok(tight.text.length <= full.text.length - 10);
  const tiny = await buildCrossSurfaceDigest({ home, currentSessionId: "sess_current", now: NOW, budgetChars: 120 });
  assert.ok(tiny.text.length <= 120, "hard cap even when one entry is oversized");
  assert.ok(tiny.text.endsWith("…"));
});

test("digest: a 3MB rollout is tail-read, not slurped", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-xsurface-big-"));
  const dir = path.join(home, "garrison", "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "sess_big.meta.json"), JSON.stringify({ id: "sess_big", title: "long haul", surface: "desktop" }));
  const chunks = [];
  let ts = NOW - 6 * HOUR;
  const filler = "x".repeat(900);
  while (chunks.reduce((n, c) => n + c.length, 0) < 3 * 1024 * 1024) {
    chunks.push(line(ts, { type: "tool_end", id: `t_${ts}`, output: filler }));
    ts += 1000;
  }
  chunks.push(userTurn(NOW - 2 * HOUR, "the final question"), assistantDone(NOW - 2 * HOUR + 1000, "the final answer"));
  await fs.writeFile(path.join(dir, "sess_big.jsonl"), chunks.join(""));
  const started = performance.now();
  const digest = await buildCrossSurfaceDigest({ home, currentSessionId: "other", now: NOW });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `tail read took ${elapsed.toFixed(0)}ms`);
  assert.equal(digest.sessions.length, 1);
  assert.match(digest.text, /you: the final question/);
  assert.match(digest.text, /ares: the final answer/);
});

function fakeLive(home, id = "sess_current") {
  const reminders = [];
  const workspace = path.join(home, "ws");
  return {
    reminders,
    session: { meta: { id } },
    context: { aresHome: home, home, workspace, mind: { memoryFile: path.join(home, "memory.jsonl") } },
    planPressure: createPlanPressure(),
    codingJournal: { beginTurn: () => null, snapshot: () => ({ touchedFiles: [] }), persistedVerificationDebtForCurrentTurn: () => false },
    verifier: { scheduleFor() {} },
    queueSystemReminder(text, source) { reminders.push({ text, source }); },
  };
}

test("injection gating: first turn yes, second turn no, new activity yes; never for guests; knob off", async () => {
  const home = await makeHome();
  await fs.mkdir(path.join(home, "ws"), { recursive: true });
  const live = fakeLive(home);
  const owner = { role: "owner" };
  const first = await crossSurfaceBeforeTurn(live, owner, { now: NOW });
  assert.ok(first && first.startsWith("Elsewhere today"), "first turn injects");
  assert.equal(live.reminders.length, 1);
  assert.equal(live.reminders[0].source, "memory");

  const second = await crossSurfaceBeforeTurn(live, owner, { now: NOW + 60_000 });
  assert.equal(second, null, "nothing new elsewhere → no second injection");
  assert.equal(live.reminders.length, 1);

  // The phone surface moves on → the next turn gets a fresh digest.
  await writeSession(home, {
    id: "sess_phone", title: "lunch plans", surface: "telegram", tenant: { role: "owner" },
    turns: [[NOW + 2 * 60_000, "actually make it 5", "Moved: call the contractor at 5pm."]],
  });
  const third = await crossSurfaceBeforeTurn(live, owner, { now: NOW + 5 * 60_000 });
  assert.ok(third && third.includes("actually make it 5"), "new activity elsewhere re-injects");
  assert.equal(live.reminders.length, 2);

  // Guests never get one, even on their first turn.
  const guestLive = fakeLive(home, "sess_guest");
  assert.equal(await crossSurfaceBeforeTurn(guestLive, { role: "guest", chatId: "99" }, { now: NOW }), null);
  assert.equal(guestLive.reminders.length, 0);

  // Knob off.
  const offLive = fakeLive(home, "sess_off");
  process.env.ARES_CROSS_SURFACE = "0";
  try {
    assert.equal(await crossSurfaceBeforeTurn(offLive, owner, { now: NOW }), null);
  } finally {
    delete process.env.ARES_CROSS_SURFACE;
  }
  resetCrossSurfaceGate(live);
  assert.ok(await crossSurfaceBeforeTurn(live, owner, { now: NOW + 6 * 60_000 }), "reset gate → first-turn semantics again");
});

test("prepareUserTurn: grades plan pressure and injects the digest on the first turn", async () => {
  const home = await makeHome();
  await fs.mkdir(path.join(home, "ws"), { recursive: true });
  const live = fakeLive(home);
  await prepareUserTurn(live, "hey");
  assert.equal(live.planPressure.next, false, "a greeting never forces a plan");
  assert.ok(live.reminders.some((r) => r.text.startsWith("Elsewhere today")), "first turn carries the digest");

  await prepareUserTurn(live, "Refactor the session persistence layer: split checkpoints.ts into a writer and a reader module, migrate the daemon's undo handler to the new reader, add tests for both and keep the CLI building green.");
  assert.equal(live.planPressure.next, true, "a substantial coding task sets plan pressure");
  assert.match(live.planPressure.reason, /substantial/);
});
