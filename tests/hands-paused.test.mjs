// The operator kill switch, made visible (field: ONE HALT engaged 2026-09-09
// stayed on for 41 days — 72 halted Browser effects, 30 tool errors in 21
// sessions — because operator_status never reported it, so the desktop always
// showed "Halt" and never offered Resume). Now: every status frame carries the
// real state, the chat shows "Ares's hands are paused (since ..., reason: ...)
// [Resume]", and the model gets one clear note instead of an error per call.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { KillSwitch } from "../packages/effects/dist/index.js";
import { handsPausedState } from "../packages/cli/dist/entry/daemon/handsPaused.js";
import { browserPausedResult } from "../packages/cli/dist/entry/browserBridge.js";

test("handsPausedState reports off, then on with when and why", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-hands-"));
  const file = path.join(dir, "HALT");
  assert.deepEqual(await handsPausedState(file), { halted: false });
  await new KillSwitch(file).engage("the Pause hands button in the Background panel");
  const on = await handsPausedState(file);
  assert.equal(on.halted, true);
  assert.match(on.haltedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(on.haltReason, "the Pause hands button in the Background panel");
  await new KillSwitch(file).release();
  assert.deepEqual(await handsPausedState(file), { halted: false });
});

test("a halted Browser action is a clear non-error result: full note once per session, then a one-liner", () => {
  const noted = new Set();
  const msg = "operator halted: kill switch engaged (since 2026-10-20T17:00:00.000Z, reason: manual)";
  const first = browserPausedResult("open", msg, "sess_a", noted);
  assert.equal(first.output.status, "paused");
  assert.equal(first.output.performed, false);
  assert.match(first.output.note, /^ACTION NOT PERFORMED\. Ares's hands are paused: operator halted/);
  assert.match(first.output.note, /do not retry/i);
  assert.match(first.output.note, /Resume on the "hands are paused" card in chat/);
  const second = browserPausedResult("click", msg, "sess_a", noted);
  assert.match(second.output.note, /still paused/);
  assert.ok(second.output.note.length < 200, "later refusals are one line");
  const otherSession = browserPausedResult("click", msg, "sess_b", noted);
  assert.match(otherSession.output.note, /Ares's hands are paused: operator halted/, "each session is told once");
});

test("the daemon reports the switch on every status frame and on Halt/Resume", async () => {
  const daemon = await fs.readFile(new URL("../packages/cli/src/entry/daemon.ts", import.meta.url), "utf8");
  assert.equal((daemon.match(/\.\.\.\(await handsPausedState\(live\.context\.effects\.killSwitchFile\)\)/g) ?? []).length, 2, "both operator_status emitters");
  assert.match(daemon, /type: "operator_control_set", action, engaged: paused\.halted, \.\.\.paused/);
});

test("the desktop shows the paused card with Resume and names who paused", async () => {
  const app = await fs.readFile(new URL("../tauri/src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /handsPausedTitle\(activeAgent\?\.name \?\? "Ares", opHaltInfo\.at, opHaltInfo\.reason\)/);
  assert.match(app, /action: "resume" }\); setOpHalted\(false\); }}>Resume<\/button>/);
  assert.match(app, /case "operator_control_set":/);
  assert.match(app, /reason: "the Pause hands button in the Background panel"/);
  assert.match(app, /reason: "the Halt operator switch in HELM"/);
  assert.match(app, /opStatus=\{opStatus \? \{ \.\.\.opStatus, halted: opHalted \} : null\}/, "the Background panel sees the real state");
});

test("card title: since <time>, reason", { skip: !process.features?.typescript }, async () => {
  const { handsPausedTitle } = await import("../tauri/src/handsPaused.ts");
  const now = new Date(2026, 9, 20, 18, 0);
  const at = new Date(2026, 9, 20, 15, 14).toISOString();
  const title = handsPausedTitle("Ares", at, "the Halt operator switch in HELM", now);
  assert.match(title, /^Ares's hands are paused \(since 3:14\s?PM, reason: the Halt operator switch in HELM\)$/);
  assert.equal(handsPausedTitle("Nova"), "Nova's hands are paused");
  assert.match(handsPausedTitle("Ares", new Date(2026, 8, 9, 9, 5).toISOString(), undefined, now), /since Sep 9, 9:05/);
});
