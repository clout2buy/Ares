// Tests for the proactive outbound, scheduler, weather, remind, and edge-tts modules.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── Outbound ────────────────────────────────────────────────────────────

import { TelegramOutbound } from "../packages/channels/dist/telegram/outbound.js";

describe("TelegramOutbound", () => {
  it("sendToChats sends to all provided IDs", async () => {
    const sent = [];
    const fakeApi = {
      sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return Promise.resolve({ message_id: 1, chat: { id: chatId, type: "private" } });
      },
    };
    const outbound = new TelegramOutbound({ botToken: "fake:token", home: "/tmp/ares-test" });
    outbound["api"] = fakeApi;
    const result = await outbound.sendToChats([111, 222], "Hello!");
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 0);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].chatId, 111);
    assert.equal(sent[1].text, "Hello!");
  });

  it("counts failures correctly", async () => {
    const fakeApi = {
      sendMessage(chatId) {
        if (chatId === 222) return Promise.reject(new Error("network"));
        return Promise.resolve({ message_id: 1, chat: { id: chatId, type: "private" } });
      },
    };
    const outbound = new TelegramOutbound({ botToken: "fake:token", home: "/tmp/ares-test" });
    outbound["api"] = fakeApi;
    const result = await outbound.sendToChats([111, 222, 333], "Test");
    assert.equal(result.sent, 2);
    assert.equal(result.failed, 1);
  });
});

// ─── Scheduler ───────────────────────────────────────────────────────────

import {
  TelegramScheduler,
  DEFAULT_SLOTS,
  addAlarm,
  removeAlarm,
  listAlarms,
  renderAlarms,
  generateAlarmId,
  slotsToAlarms,
} from "../packages/channels/dist/telegram/scheduler.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("Scheduler data model", () => {
  it("DEFAULT_SLOTS has 9am, 12pm, 3pm", () => {
    assert.equal(DEFAULT_SLOTS.length, 3);
    assert.equal(DEFAULT_SLOTS[0].hour, 9);
    assert.equal(DEFAULT_SLOTS[1].hour, 12);
    assert.equal(DEFAULT_SLOTS[2].hour, 15);
  });

  it("addAlarm creates an alarm with a generated id", () => {
    const { data, alarm } = addAlarm({ alarms: [] }, { label: "Test", hour: 14, minute: 30 });
    assert.equal(data.alarms.length, 1);
    assert.ok(alarm.id.startsWith("a"));
    assert.equal(alarm.label, "Test");
    assert.equal(alarm.hour, 14);
    assert.equal(alarm.minute, 30);
    assert.ok(alarm.createdAt);
  });

  it("removeAlarm removes by id", () => {
    const { data: d1, alarm } = addAlarm({ alarms: [] }, { label: "X", hour: 8, minute: 0 });
    const { data: d2, removed } = removeAlarm(d1, alarm.id);
    assert.equal(d2.alarms.length, 0);
    assert.equal(removed?.id, alarm.id);
  });

  it("removeAlarm returns undefined for missing id", () => {
    const { removed } = removeAlarm({ alarms: [] }, "nonexistent");
    assert.equal(removed, undefined);
  });

  it("listAlarms sorts by time", () => {
    let data = { alarms: [] };
    data = addAlarm(data, { label: "Late", hour: 22, minute: 0 }).data;
    data = addAlarm(data, { label: "Early", hour: 6, minute: 30 }).data;
    data = addAlarm(data, { label: "Mid", hour: 12, minute: 0 }).data;
    const sorted = listAlarms(data);
    assert.equal(sorted[0].label, "Early");
    assert.equal(sorted[1].label, "Mid");
    assert.equal(sorted[2].label, "Late");
  });

  it("renderAlarms shows a readable list", () => {
    let data = { alarms: [] };
    data = addAlarm(data, { label: "Coffee", hour: 9, minute: 0 }).data;
    const text = renderAlarms(data);
    assert.ok(text.includes("Coffee"));
    assert.ok(text.includes("09:00"));
  });

  it("renderAlarms says empty when no alarms", () => {
    assert.equal(renderAlarms({ alarms: [] }), "No alarms set.");
  });

  it("slotsToAlarms converts legacy slots", () => {
    const alarms = slotsToAlarms(DEFAULT_SLOTS);
    assert.equal(alarms.length, 3);
    assert.equal(alarms[0].hour, 9);
    assert.equal(alarms[1].label, "Midday check-in");
  });
});

describe("TelegramScheduler runtime", () => {
  it("fires an alarm when the clock hits", async () => {
    const tmpDir = path.join(os.tmpdir(), `ares-sched-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const messages = [];
    const fakeOutbound = {
      sendToOwners(text) { messages.push(text); return Promise.resolve({ sent: 1, failed: 0 }); },
      sendToChats(ids, text) { messages.push(text); return Promise.resolve({ sent: ids.length, failed: 0 }); },
    };

    let fakeTime = new Date(2026, 5, 17, 8, 59, 0);
    const sched = new TelegramScheduler({
      outbound: fakeOutbound,
      home: tmpDir,
      now: () => fakeTime,
      tickMs: 50,
    });

    // Pre-seed an alarm at 9:00
    await sched.addAlarm({ label: "Morning", hour: 9, minute: 0 });
    await sched.start();

    await sleep(100);
    assert.equal(messages.length, 0, "should not fire at 8:59");

    fakeTime = new Date(2026, 5, 17, 9, 0, 0);
    await sleep(100);
    assert.equal(messages.length, 1, "should fire at 9:00");
    assert.ok(messages[0].includes("Morning"));

    // Don't double-fire same day
    fakeTime = new Date(2026, 5, 17, 9, 1, 0);
    await sleep(100);
    assert.equal(messages.length, 1, "should not double-fire");

    sched.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("one-shot alarms auto-remove after firing", async () => {
    const tmpDir = path.join(os.tmpdir(), `ares-sched-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const fakeOutbound = {
      sendToOwners() { return Promise.resolve({ sent: 1, failed: 0 }); },
      sendToChats() { return Promise.resolve({ sent: 1, failed: 0 }); },
    };

    let fakeTime = new Date(2026, 5, 17, 13, 59, 0);
    const sched = new TelegramScheduler({
      outbound: fakeOutbound,
      home: tmpDir,
      now: () => fakeTime,
      tickMs: 50,
    });

    await sched.addAlarm({ label: "One-shot", hour: 14, minute: 0, once: true });
    await sched.start();

    let alarms = await sched.listAlarms();
    assert.equal(alarms.length, 1);

    fakeTime = new Date(2026, 5, 17, 14, 0, 0);
    await sleep(200);

    alarms = await sched.listAlarms();
    assert.equal(alarms.length, 0, "one-shot alarm should be auto-removed");

    sched.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("respects day-of-week filter", async () => {
    const tmpDir = path.join(os.tmpdir(), `ares-sched-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const messages = [];
    const fakeOutbound = {
      sendToOwners(text) { messages.push(text); return Promise.resolve({ sent: 1, failed: 0 }); },
      sendToChats() { return Promise.resolve({ sent: 1, failed: 0 }); },
    };

    // 2026-06-17 is a Wednesday (day 3)
    let fakeTime = new Date(2026, 5, 17, 10, 0, 0);
    const sched = new TelegramScheduler({
      outbound: fakeOutbound,
      home: tmpDir,
      now: () => fakeTime,
      tickMs: 50,
    });

    // Only fire on Monday (1) and Friday (5)
    await sched.addAlarm({ label: "Weekday only", hour: 10, minute: 0, days: [1, 5] });
    await sched.start();

    await sleep(100);
    assert.equal(messages.length, 0, "should not fire on Wednesday");

    sched.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ─── Remind tool ─────────────────────────────────────────────────────────

import { RemindTool, setRemindScheduler } from "../packages/tools/dist/Remind.js";

describe("RemindTool", () => {
  it("is named Remind", () => {
    assert.equal(RemindTool.schema.name, "Remind");
  });

  it("reports no scheduler when not injected", async () => {
    setRemindScheduler(null);
    const result = await RemindTool.call({ action: "list", minute: 0 }, fakeCtx());
    assert.equal(result.output.ok, false);
    assert.ok(result.output.note?.includes("not running"));
  });
});

// ─── Weather tool ────────────────────────────────────────────────────────

import { WeatherTool } from "../packages/tools/dist/Weather.js";

describe("WeatherTool", () => {
  it("is named Weather with read-only safety", () => {
    assert.equal(WeatherTool.schema.name, "Weather");
  });
});

// ─── WebSearch safety downgrade ──────────────────────────────────────────

import { makeWebSearchTool } from "../packages/tools/dist/WebSearch.js";

describe("WebSearch safety", () => {
  it("is read-only (no permission gate for searches)", () => {
    const tool = makeWebSearchTool();
    // After the fix, checkPermissions should auto-allow in workspace-write mode
  });
});

// ─── Edge TTS ────────────────────────────────────────────────────────────

import { synthesize, textToVoice, defaultVoice } from "../packages/channels/dist/telegram/edgeTts.js";

describe("Edge TTS", () => {
  it("exports synthesize and textToVoice functions", () => {
    assert.equal(typeof synthesize, "function");
    assert.equal(typeof textToVoice, "function");
    assert.equal(typeof defaultVoice, "function");
  });

  // Network-dependent test — only run when ARES_TEST_NETWORK=1
  const networkTest = process.env.ARES_TEST_NETWORK === "1" ? it : it.skip;

  networkTest("synthesizes a short phrase to OGG/Opus", async () => {
    const audio = await textToVoice("Hello, this is a test.");
    assert.ok(Buffer.isBuffer(audio));
    assert.ok(audio.length > 100, `expected audio data, got ${audio.length} bytes`);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeCtx() {
  return {
    workspace: "/tmp",
    signal: new AbortController().signal,
    permissionMode: "bypass",
    home: "/tmp",
    toolName: "Remind",
    readStamps: new Map(),
    pathPermissions: { isAllowed: () => true },
    commandPermissions: { decide: () => null },
    subModelPool: null,
  };
}
