// M0 smoke test — proves the streaming loop wires end-to-end.
//
// Runs `crix run --goal "ping"` against the mock provider and verifies the
// NDJSON event stream contains turn_start → text_delta(s) → message_done →
// turn_end in order.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(__dirname, "..", "packages", "cli", "dist", "entry.js");

function runCrix(args) {
  return spawnSync(process.execPath, [cliEntry, ...args], { encoding: "utf8", windowsHide: true });
}

test("M0: crix help exits 0 with usage on stdout", () => {
  const r = runCrix(["help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /crix v0\.3\.0-alpha\.1/);
  assert.match(r.stdout, /streaming coding-agent harness/);
});

test("M0: crix run --goal emits ordered event stream", () => {
  const r = runCrix(["run", "--goal", "ping"]);
  assert.equal(r.status, 0, `crix run failed: ${r.stderr}`);
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 4, `expected >=4 events, got ${lines.length}`);

  const events = lines.map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);

  // First event is turn_start
  assert.equal(types[0], "turn_start");
  // Last event is turn_end with status: completed
  assert.equal(types[types.length - 1], "turn_end");
  assert.equal(events[events.length - 1].status, "completed");

  // Stream contains text_delta and message_done
  assert.ok(types.includes("text_delta"));
  assert.ok(types.includes("message_done"));

  // turn_start carries the user message
  assert.equal(events[0].userMessage.role, "user");

  // message_done carries the assistant message
  const messageDone = events.find((e) => e.type === "message_done");
  assert.equal(messageDone.message.role, "assistant");
  assert.match(messageDone.message.content[0].text, /^echo: ping$/);

  // Echo response is delivered via text_delta chunks
  const textDeltas = events.filter((e) => e.type === "text_delta");
  const joined = textDeltas.map((e) => e.text).join("");
  assert.equal(joined, "echo: ping");
});

test("M0: crix run --goal requires --goal flag", () => {
  const r = runCrix(["run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--goal is required/);
});

test("M0: crix unknown command returns 2", () => {
  const r = runCrix(["nope"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});
