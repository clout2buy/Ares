// A dropped connection ("fetch failed", DNS, reset) got four retries inside
// ~12 s; 23 turns in the field logs were lost that way. Connection failures
// now ride a patient ladder (6 tries, about a minute) and say they are
// waiting for the network.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ARES_CAPACITY_BACKOFF_MS = "5";
process.env.ARES_CAPACITY_BACKOFF_MAX_MS = "10";
const { QueryEngine, isConnectivityError } = await import("../packages/core/dist/index.js");

function offlineFor(failures) {
  let calls = 0;
  return {
    get calls() { return calls; },
    name: "offline-provider",
    async *stream() {
      calls += 1;
      if (calls <= failures) {
        yield { type: "error", error: { code: "network_error", message: "fetch failed", retriable: true } };
        return;
      }
      yield {
        type: "message_done",
        message: { id: "ok", role: "assistant", content: [{ type: "text", text: "back online" }], createdAt: new Date().toISOString() },
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
}

async function run(provider) {
  const ws = mkdtempSync(path.join(os.tmpdir(), "ares-net-"));
  const engine = QueryEngine.forTesting({ provider, model: "m", systemPrompt: "s", tools: [], workspace: ws, maxTurns: 2 }, "sess_net");
  engine.appendUserMessage("go");
  const events = [];
  for await (const ev of engine.streamTurn()) events.push(ev);
  return events;
}

test("connection failures are told apart from other provider errors", () => {
  assert.equal(isConnectivityError({ code: "network_error", message: "fetch failed" }), true);
  assert.equal(isConnectivityError({ code: "network_error", message: "getaddrinfo ENOTFOUND api.anthropic.com" }), true);
  assert.equal(isConnectivityError({ code: "http_500", message: "fetch failed" }), false);
  assert.equal(isConnectivityError({ code: "network_error", message: "bad request body" }), false);
});

test("a turn survives five dropped connections in a row and says it is waiting", async () => {
  const provider = offlineFor(5);
  const events = await run(provider);
  assert.equal(provider.calls, 6);
  const end = events.find((e) => e.type === "turn_end");
  assert.equal(end.status, "completed");
  assert.ok(events.some((e) => e.type === "system_reminder_injected" && /waiting for the connection/.test(e.text ?? "")));
});

test("it still gives up when the connection never comes back", async () => {
  const provider = offlineFor(100);
  const events = await run(provider);
  assert.equal(provider.calls, 7, "1 try + 6 retries");
  assert.equal(events.find((e) => e.type === "turn_end").status, "failed");
});

test("a connection lost while a tool call is being drafted retries; nothing has run yet", async () => {
  let calls = 0;
  const provider = {
    name: "drops-mid-draft",
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: "tool_use_start", id: "t1", name: "Surface" };
        yield { type: "tool_use_input_delta", id: "t1", deltaJson: '{"html' };
        yield { type: "error", error: { code: "stream_read_error", message: "terminated", retriable: true } };
        return;
      }
      yield { type: "message_done", message: { id: "ok", role: "assistant", content: [{ type: "text", text: "made it" }], createdAt: new Date().toISOString() }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  };
  const events = await run(provider);
  assert.equal(calls, 2, "it tried again");
  assert.equal(events.at(-1).status ?? events.find((e) => e.type === "turn_end")?.status, "completed");
});

test("a connection lost after the owner saw text does not silently repeat it", async () => {
  let calls = 0;
  const provider = {
    name: "drops-mid-text",
    async *stream() {
      calls += 1;
      yield { type: "text_delta", text: "half a sen" };
      yield { type: "error", error: { code: "stream_read_error", message: "terminated", retriable: true } };
    },
  };
  await run(provider);
  assert.equal(calls, 1);
});
