// getUpdates failures back off exponentially (1s → 60s cap, jittered), log
// quietly (first failure, escalations, every 20th at the cap, one recovery line),
// reset on success, and leave the 409 Conflict path alone.

import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { TelegramBridge, TelegramApiError, nextBackoffMs, seedOwners, emptyRoster } from "../packages/channels/dist/index.js";

test("nextBackoffMs: 1s, 2s, 4s... capped at 60s", () => {
  const full = (n) => nextBackoffMs(n, () => 1);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(full), [1000, 2000, 4000, 8000, 16000, 32000]);
  for (const n of [7, 8, 20, 500, 100000]) assert.equal(full(n), 60000);
});

test("nextBackoffMs: jitter stays within 50-100% of the step and never exceeds the cap", () => {
  for (const n of [1, 2, 5, 7, 30]) {
    const base = nextBackoffMs(n, () => 1);
    assert.equal(nextBackoffMs(n, () => 0), Math.round(base / 2));
    for (const r of [0, 0.1, 0.5, 0.999]) {
      const d = nextBackoffMs(n, () => r);
      assert.ok(d >= base / 2 - 1 && d <= base && d <= 60000, `n=${n} r=${r} d=${d}`);
    }
  }
});

async function harness(script) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "welcome" })));
  const delays = [];
  const logs = [];
  let calls = 0;
  let finish;
  const done = new Promise((r) => (finish = r));
  const api = {
    async getUpdates(_o, _t, signal) {
      const step = script(calls++);
      if (step === "hang") {
        finish();
        return new Promise((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      }
      if (step) throw step;
      return [];
    },
    async sendMessage() { return { message_id: 1, chat: { id: 1, type: "private" } }; },
    async editMessageText() {},
    async answerCallbackQuery() {},
    async sendChatAction() {},
  };
  const timers = {
    setTimeout(fn, ms) { delays.push(ms); return setTimeout(fn, 0); },
    clearTimeout(h) { clearTimeout(h); },
  };
  const bridge = new TelegramBridge({
    api,
    gateway: { url: `ws://127.0.0.1:${wss.address().port}`, token: "tok" },
    allowedChatIds: [1],
    ownerChatIds: [1],
    initialRoster: seedOwners(emptyRoster(), [1], "Crix"),
    timers,
    random: () => 1,
    pollTimeoutS: 1,
    log: (l) => logs.push(l),
  });
  bridge.start();
  await done;
  await bridge.stop();
  await new Promise((r) => wss.close(r));
  return { delays, logs };
}

const netErr = () => new Error("telegram getUpdates failed (0): network failure: fetch failed");

test("loop: delays follow the backoff, and reset to 1s after a success", async () => {
  // fail x3, succeed, fail x2, then hang
  const script = (i) => (i < 3 ? netErr() : i === 3 ? null : i < 6 ? netErr() : "hang");
  const { delays } = await harness(script);
  assert.deepEqual(delays.filter((d) => d >= 1000 && d <= 60000).slice(0, 5), [1000, 2000, 4000, 1000, 2000]);
});

test("loop: 50 consecutive failures log far fewer than 50 lines; recovery logs once", async () => {
  const script = (i) => (i < 50 ? netErr() : i === 50 ? null : "hang");
  const { logs, delays } = await harness(script);
  const failed = logs.filter((l) => /getUpdates failed/.test(l));
  const recovered = logs.filter((l) => /recovered after 50 failures/.test(l));
  assert.ok(failed.length < 15, `expected quiet logging, got ${failed.length} lines`);
  assert.ok(failed.length >= 1);
  assert.match(failed[0], /x1\b/);
  assert.equal(recovered.length, 1);
  assert.equal(Math.max(...delays.filter((d) => d <= 60000)), 60000);
});

test("loop: 409 Conflict keeps its own 10s-first backoff and message", async () => {
  const err = new TelegramApiError("getUpdates", 409, "Conflict: terminated by other getUpdates request");
  const { logs, delays } = await harness((i) => (i < 2 ? err : "hang"));
  const c = logs.filter((l) => /409 Conflict/.test(l));
  assert.equal(c.length, 2);
  assert.match(c[0], /another bot instance is polling this token\. Retrying in 10s/);
  assert.match(c[1], /Retrying in 20s/);
  assert.ok(delays.includes(10_000) && delays.includes(20_000));
  assert.ok(!logs.some((l) => /getUpdates failed/.test(l)));
});
