// Verifies the Telegram remote-command parser/handler and its wiring: commands
// are recognized, unknown text falls through to chat, /status & /war_map render
// compact state, /run_next is dry-run only, pause/resume/stop emit a control
// action, secrets are redacted, and the operator loop respects a remote pause.

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseTelegramCommand,
  handleTelegramCommand,
  TelegramBridge,
} from "../packages/channels/dist/index.js";
import {
  OperatorBackgroundLoop,
  setOperatorControl,
  isOperatorPaused,
  createGoal,
  saveGoal,
  loadGoal,
} from "../packages/operator/dist/index.js";

// ── Parser ────────────────────────────────────────────────────────────────────

test("parser: recognizes slash and bare one-word commands", () => {
  assert.equal(parseTelegramCommand("/status"), "status");
  assert.equal(parseTelegramCommand("status"), "status");
  assert.equal(parseTelegramCommand("/status@ares_bot"), "status");
  assert.equal(parseTelegramCommand("/war_map"), "war_map");
  assert.equal(parseTelegramCommand("/run_next"), "run_next");
  assert.equal(parseTelegramCommand("PAUSE"), "pause");
  assert.equal(parseTelegramCommand("/help"), "help");
});

test("parser: unknown / multi-word / chat text falls through (null)", () => {
  assert.equal(parseTelegramCommand("pause the music please"), null, "multi-word is chat, not a command");
  assert.equal(parseTelegramCommand("/deploy"), null, "unknown slash command falls through");
  assert.equal(parseTelegramCommand("what's the status of the build"), null);
  assert.equal(parseTelegramCommand(""), null);
});

// ── Handler: state commands ───────────────────────────────────────────────────

const sampleState = () => ({
  project: "Ares",
  campaign: "Memory OS then autonomy",
  nextActions: ["wire telegram commands", "HELM UI", "approval polish"],
  lastGate: "637/637, CI green",
  recentWins: ["wired TelegramBridge reports", "wired OperatorBackgroundLoop"],
  operatorPaused: false,
});

test("/status returns compact state incl. operator running/paused", async () => {
  const r = await handleTelegramCommand("status", { state: sampleState });
  assert.match(r.text, /Ares online/);
  assert.match(r.text, /Project: Ares/);
  assert.match(r.text, /Operator: running/);
  assert.match(r.text, /Gate: 637\/637, CI green/);
  assert.ok(r.text.split("\n").length <= 7, "compact, not a scroll");

  const paused = await handleTelegramCommand("status", { state: () => ({ ...sampleState(), operatorPaused: true }) });
  assert.match(paused.text, /Operator: paused/);
});

test("/war_map includes the mission/project packet", async () => {
  const r = await handleTelegramCommand("war_map", { state: sampleState });
  assert.match(r.text, /war map/i);
  assert.match(r.text, /Campaign: Memory OS/);
  assert.match(r.text, /Recent: wired TelegramBridge/);
  assert.match(r.text, /Next: wire telegram commands/);
});

test("/next and /summary surface nextActions and recentWins", async () => {
  assert.match((await handleTelegramCommand("next", { state: sampleState })).text, /wire telegram commands/);
  assert.match((await handleTelegramCommand("summary", { state: sampleState })).text, /wired TelegramBridge reports/);
});

// ── /run_next is dry-run only ─────────────────────────────────────────────────

test("/run_next is DRY-RUN: shows the move + why, never executes", async () => {
  let executed = false;
  const r = await handleTelegramCommand("run_next", {
    state: sampleState,
    runNextDryRun: () => { /* still just returns a proposal */ return { action: "wire telegram commands", why: "top of the war map" }; },
    control: () => { executed = true; }, // must NOT be called
  });
  assert.match(r.text, /dry-run/i);
  assert.match(r.text, /Action: wire telegram commands/);
  assert.match(r.text, /Why: top of the war map/);
  assert.match(r.text, /[Nn]ot executed/);
  assert.equal(r.control, undefined, "run_next emits NO control action");
  assert.equal(executed, false, "nothing was run");
});

// ── Control commands emit the intended action ─────────────────────────────────

test("pause / resume / stop emit the intended control action", async () => {
  assert.equal((await handleTelegramCommand("pause")).control, "pause");
  assert.equal((await handleTelegramCommand("resume")).control, "resume");
  assert.equal((await handleTelegramCommand("stop")).control, "stop");
  assert.match((await handleTelegramCommand("pause")).text, /paused/i);
});

// ── Redaction ─────────────────────────────────────────────────────────────────

test("command output redacts secrets and home paths", async () => {
  const r = await handleTelegramCommand("status", {
    state: () => ({ project: "Ares", campaign: "running at C:\\Users\\Noah\\.ares with token 7654321:ABCdefGHIjklMNOpqrstUVwx0123456789yz" }),
  });
  assert.ok(!/Users\\Noah/.test(r.text), "home path collapsed");
  assert.ok(!/7654321:ABC/.test(r.text), "token redacted");
});

// ── Operator control flag + loop pause ────────────────────────────────────────

test("operator control: pause flag round-trips and the loop skips ticks when paused", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ares-v33-"));
  await saveGoal(home, createGoal({ id: "g1", statement: "do work" }));

  assert.equal(await isOperatorPaused(home), false, "default: not paused");
  await setOperatorControl({ paused: true }, home);
  assert.equal(await isOperatorPaused(home), true);

  let dispatched = 0;
  const loop = new OperatorBackgroundLoop(
    { home, dispatcher: { async runStep() { dispatched++; return { moved: true, goalMet: true }; } } },
    { paused: () => isOperatorPaused(home) },
  );
  const paused = await loop.tickOnce();
  assert.equal(paused.ran.length, 0, "paused → no goal advanced");
  assert.equal(dispatched, 0, "the dispatcher never fired while paused");
  assert.equal((await loadGoal(home, "g1")).status, "active", "goal untouched");

  await setOperatorControl({ paused: false }, home);
  const resumed = await loop.tickOnce();
  assert.equal(resumed.ran.length, 1, "resumed → the goal advances");
});

// ── Bridge interception: a command is handled; chat falls through ─────────────

class FakeWs {
  on() { return this; }
  send() {}
  close() {}
}

function bridgeHarness(updates, commands) {
  const sent = [];
  let drained = false;
  const api = {
    async getUpdates(_offset, _timeoutS, signal) {
      if (drained) {
        // Park until the bridge aborts (stop()), then unblock cleanly.
        return new Promise((resolve) => {
          if (signal?.aborted) return resolve([]);
          signal?.addEventListener("abort", () => resolve([]), { once: true });
        });
      }
      drained = true;
      return updates;
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; },
    async editMessageText() {},
    async answerCallbackQuery() {},
  };
  const bridge = new TelegramBridge({
    api,
    gateway: { url: "ws://unused", token: "t" },
    allowedChatIds: [42],
    wsImpl: () => new FakeWs(),
    commands,
  });
  return { bridge, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("bridge: a /status DM is answered locally as a command", async () => {
  const { bridge, sent } = bridgeHarness(
    [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, text: "/status" } }],
    { state: sampleState },
  );
  bridge.start();
  await tick();
  await bridge.stop();
  assert.ok(sent.some((s) => /Ares online/.test(s.text)), "the command produced a local status reply");
});

test("bridge: a plain message is NOT treated as a command (falls through to chat)", async () => {
  const { bridge, sent } = bridgeHarness(
    [{ update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private" }, text: "hey what's up" } }],
    { state: sampleState },
  );
  bridge.start();
  await tick();
  await bridge.stop();
  assert.ok(!sent.some((s) => /Ares online/.test(s.text)), "no command reply — it routed to chat, not the parser");
});
