// C8 — crash safety for the long-lived daemon/garrison processes.
//
// Until now these processes had NO global error handlers, so an uncaught error
// or stray unhandled rejection could tear them down silently on a coworker's
// machine with nothing on disk. This pins the net: synchronous crash logging,
// a bounded recent-event ring, and handler install/uninstall that keeps the
// process alive on a rejection (logs it) instead of letting Node terminate.
//
// We deliberately do NOT throw a real uncaughtException (that would kill the
// test runner) — we grab the installed listener and invoke it directly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  crashDir,
  writeCrashLogSync,
  installGlobalCrashHandlers,
  EventRing,
} from "../packages/core/dist/index.js";

function tmpHome() {
  const dir = path.join(os.tmpdir(), `ares-crash-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("writeCrashLogSync creates the crashes dir and round-trips a record", () => {
  const home = tmpHome();
  const file = writeCrashLogSync(home, {
    at: new Date().toISOString(),
    kind: "manual",
    process: "daemon",
    message: "boom",
    stack: "Error: boom\n  at x",
    context: { sessions: 3 },
    recentEvents: [{ type: "turn_start" }],
  });
  assert.ok(file, "should return a file path");
  assert.ok(file.startsWith(crashDir(home)), "file lives under <home>/crashes");
  assert.ok(fs.existsSync(crashDir(home)), "crashes dir was created");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(parsed.message, "boom");
  assert.equal(parsed.process, "daemon");
  assert.equal(parsed.context.sessions, 3);
  assert.equal(parsed.recentEvents[0].type, "turn_start");
});

test("writeCrashLogSync never throws on a bad home", () => {
  // A NUL byte makes mkdir/append fail; the helper must swallow and return null.
  const file = writeCrashLogSync("\0::invalid", {
    at: new Date().toISOString(),
    kind: "manual",
    process: "daemon",
    message: "x",
  });
  assert.equal(file, null);
});

test("EventRing is bounded and preserves order", () => {
  const ring = new EventRing(3);
  for (let i = 0; i < 5; i++) ring.record({ i });
  const snap = ring.snapshot();
  assert.equal(snap.length, 3);
  assert.deepEqual(snap.map((e) => e.i), [2, 3, 4]);
});

test("installed unhandledRejection handler logs but does NOT exit; pulls context + events", () => {
  const home = tmpHome();
  const ring = new EventRing(10);
  ring.record({ type: "turn_start", sid: "s1" });
  const beforeUncaught = process.listenerCount("uncaughtException");
  const beforeReject = process.listenerCount("unhandledRejection");
  let emitted = null;

  const uninstall = installGlobalCrashHandlers({
    home,
    process: "daemon",
    getContext: () => ({ activeSessions: 2 }),
    getRecentEvents: () => ring.snapshot(),
    emit: (n) => {
      emitted = n;
    },
    handleSignals: false, // don't fight the test runner's signal handling
  });

  assert.equal(process.listenerCount("uncaughtException"), beforeUncaught + 1);
  assert.equal(process.listenerCount("unhandledRejection"), beforeReject + 1);

  // Invoke the registered rejection listener directly (no real rejection → no
  // risk to the runner). It must write a crash file and surface a notice.
  const handler = process.listeners("unhandledRejection").at(-1);
  handler(new Error("background task died"));

  const files = fs.readdirSync(crashDir(home)).filter((f) => f.startsWith("daemon-"));
  assert.equal(files.length, 1, "one crash file written");
  const rec = JSON.parse(fs.readFileSync(path.join(crashDir(home), files[0]), "utf8").trim());
  assert.equal(rec.kind, "unhandledRejection");
  assert.equal(rec.message, "background task died");
  assert.equal(rec.context.activeSessions, 2);
  assert.equal(rec.recentEvents[0].sid, "s1");
  assert.ok(emitted && emitted.type === "crash" && emitted.kind === "unhandledRejection");

  uninstall();
  assert.equal(process.listenerCount("uncaughtException"), beforeUncaught, "uninstall removes uncaught handler");
  assert.equal(process.listenerCount("unhandledRejection"), beforeReject, "uninstall removes rejection handler");
});
