// 429 → provider failover (roadmap move 1; 76 field 429s). A rate-limited turn
// used to back off up to four times (Retry-After up to 60s each) on a provider
// that had said "not now". When the host's failover probe says another
// provider can take the turn, the engine now ends the attempt at once so the
// daemon's failover ladder moves it; otherwise it backs off as before.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueryEngine, isRateLimitError, setRateLimitFailoverProbe } from "../packages/core/dist/index.js";

function rateLimitedThenOk(retryAfterMs) {
  let calls = 0;
  return {
    get calls() { return calls; },
    name: "rl-provider",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "error",
          error: { code: "http_429", message: "Anthropic returned 429: rate_limit_error", retriable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
        };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "ok", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function run(provider) {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-rl-"));
  const engine = QueryEngine.forTesting({ provider, model: "m", systemPrompt: "s", tools: [], workspace: ws, maxTurns: 2 }, "sess_rl");
  engine.appendUserMessage("go");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("isRateLimitError tells a rate limit from overload", () => {
  assert.equal(isRateLimitError({ code: "http_429", message: "x" }), true);
  assert.equal(isRateLimitError({ code: "provider_error", message: "rate_limit_error: slow down" }), true);
  assert.equal(isRateLimitError({ code: "http_529", message: "overloaded_error" }), false);
  assert.equal(isRateLimitError({ code: "http_500", message: "boom" }), false);
});

test("with a backup available, a 429 ends the attempt at once for the failover ladder", async () => {
  const probes = [];
  setRateLimitFailoverProbe(async (info) => { probes.push(info); return true; });
  try {
    const provider = rateLimitedThenOk(30_000);
    const started = Date.now();
    const events = await run(provider);
    assert.ok(Date.now() - started < 3_000, "no 30s Retry-After wait");
    assert.equal(provider.calls, 1, "the same provider is not retried");
    assert.deepEqual(probes, [{ sessionId: "sess_rl", model: "m" }]);
    const end = events.find((ev) => ev.type === "turn_end");
    assert.equal(end.status, "failed");
  } finally {
    setRateLimitFailoverProbe(null);
  }
});

test("a short Retry-After is still waited out, and no probe means the old back-off", async () => {
  setRateLimitFailoverProbe(async () => true);
  try {
    const provider = rateLimitedThenOk(100);
    const events = await run(provider);
    assert.equal(provider.calls, 2);
    assert.equal(events.find((ev) => ev.type === "turn_end").status, "completed");
  } finally {
    setRateLimitFailoverProbe(null);
  }
  const provider = rateLimitedThenOk(100);
  const events = await run(provider);
  assert.equal(provider.calls, 2);
  assert.equal(events.find((ev) => ev.type === "turn_end").status, "completed");
});

test("a probe that says no backup keeps the back-off", async () => {
  setRateLimitFailoverProbe(async () => false);
  try {
    const provider = rateLimitedThenOk(200);
    process.env.ARES_RATE_LIMIT_WAIT_MS = "0";
    const events = await run(provider);
    assert.equal(provider.calls, 2);
    assert.equal(events.find((ev) => ev.type === "turn_end").status, "completed");
  } finally {
    delete process.env.ARES_RATE_LIMIT_WAIT_MS;
    setRateLimitFailoverProbe(null);
  }
});
