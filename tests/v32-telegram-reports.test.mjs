// Verifies operator → Telegram reports: compact lines for meaningful events,
// idle suppressed unless debug, secrets/home paths redacted, and a send failure
// that never escapes into the operator loop.

import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOperatorReport,
  formatWarMapBriefing,
  redactForTelegram,
  OperatorTelegramReporter,
} from "../packages/channels/dist/index.js";

// A fake Telegram api that records sends (and can be told to fail).
function fakeApi({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) {
      if (fail) throw new Error("telegram 502");
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    async getUpdates() { return []; },
    async editMessageText() {},
    async answerCallbackQuery() {},
  };
}

// ── Meaningful events → compact lines ─────────────────────────────────────────

test("started / tick / error / stopped produce compact one-liners", () => {
  assert.match(formatOperatorReport({ type: "operator_started", everyMs: 1_800_000 }), /Operator online/);
  const tick = formatOperatorReport({ type: "operator_tick", goalId: "g1", status: "done", summary: "advance the campaign" });
  assert.match(tick, /advance the campaign/);
  assert.match(tick, /done/);
  assert.ok(tick.length < 200, "a line, not an essay");
  assert.match(formatOperatorReport({ type: "operator_error", message: "worker exploded" }), /Operator error: worker exploded/);
  assert.equal(formatOperatorReport({ type: "operator_stopped" }), "🜂 Operator stopped.");
  assert.ok(!/awakened|moon|dragon/i.test(tick), "no haunted war-diary prose");
});

// ── Idle is suppressed unless debug ───────────────────────────────────────────

test("idle is suppressed by default and only surfaces under debug", () => {
  const idle = { type: "operator_idle", suggestions: ["wire telegram", "wire HELM"] };
  assert.equal(formatOperatorReport(idle), null, "no idle spam by default");
  assert.match(formatOperatorReport(idle, { debug: true }), /Idle/);
  assert.match(formatOperatorReport(idle, { debug: true }), /wire telegram/);
});

// ── Redaction ─────────────────────────────────────────────────────────────────

test("secrets and home paths are redacted before anything ships", () => {
  const dirty = "error using token 7654321:ABCdefGHIjklMNOpqrstUVwxyz0123456789 at C:\\Users\\Noah\\.ares\\state";
  const clean = redactForTelegram(dirty);
  assert.ok(!/7654321:ABC/.test(clean), "bot token redacted");
  assert.ok(!/Users\\Noah/.test(clean), "home path collapsed");
  assert.match(clean, /\[redacted\]/);

  const report = formatOperatorReport({ type: "operator_error", message: "boom sk-abcdefABCDEF123456789012 from /home/noah/.ares" });
  assert.ok(!/sk-abcdef/.test(report), "secret in an event message is redacted");
  assert.ok(!/home\/noah/.test(report));
});

// ── War-map briefing ──────────────────────────────────────────────────────────

test("the war-map briefing is compact and carries the key state", () => {
  const text = formatWarMapBriefing({
    project: "Ares",
    campaign: "Memory OS then autonomy",
    nextActions: ["wire telegram", "HELM UI", "approval bridge", "extra"],
    lastGate: "630/630, CI green",
    recentAction: "wired OperatorBackgroundLoop",
  });
  assert.match(text, /Project: Ares/);
  assert.match(text, /Campaign: Memory OS/);
  assert.match(text, /Gate: 630\/630, CI green/);
  assert.match(text, /Next: wire telegram; HELM UI; approval bridge/, "capped to a few next actions");
  assert.ok(text.split("\n").length <= 6, "a status card, not a scroll");
});

// ── Reporter routing + failure isolation ──────────────────────────────────────

test("the reporter sends meaningful events to every chat and skips suppressed ones", async () => {
  const api = fakeApi();
  const reporter = new OperatorTelegramReporter({ api, chatIds: [111, 222] });
  await reporter.report({ type: "operator_started", everyMs: 60_000 });
  await reporter.report({ type: "operator_idle", suggestions: ["x"] }); // suppressed
  await reporter.report({ type: "operator_tick", summary: "did a thing", status: "moved" });
  assert.equal(api.sent.length, 4, "2 events × 2 chats; idle sent nothing");
  assert.deepEqual([...new Set(api.sent.map((s) => s.chatId))], [111, 222]);
});

test("a Telegram send failure NEVER throws into the operator loop", async () => {
  const reporter = new OperatorTelegramReporter({ api: fakeApi({ fail: true }), chatIds: [111], log: () => {} });
  await assert.doesNotReject(reporter.report({ type: "operator_error", message: "x" }));
  await assert.doesNotReject(reporter.send("hi"));
});

test("debug reporter surfaces idle too", async () => {
  const api = fakeApi();
  const reporter = new OperatorTelegramReporter({ api, chatIds: [9], debug: true });
  await reporter.report({ type: "operator_idle", suggestions: ["next thing"] });
  assert.equal(api.sent.length, 1, "idle reported under debug");
  assert.match(api.sent[0].text, /Idle/);
});
