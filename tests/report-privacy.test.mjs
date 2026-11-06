// Nothing that identifies the owner or their project leaves in a bug report or
// a downloaded chat, at either level, while every failure stays readable.

import test from "node:test";
import assert from "node:assert/strict";
import { scrubRollout, scrubText } from "../packages/protocol/dist/index.js";
import { reportSummary } from "../packages/cli/dist/entry/daemon/report.js";

const who = { home: "C:\\Users\\noah", workspace: "C:\\Users\\noah\\Desktop\\Ares Workspace", aresHome: "C:\\Users\\noah\\.ares", username: "noah", hostname: "NOAH-DESKTOP" };
const KEY = "sk-ant-api03-" + "q".repeat(80);
const SOURCE = "export function secretSauce() {\n  return 42;\n}\n".repeat(4);

const user = (text) => ({ id: "m1", role: "user", content: [{ type: "text", text }], createdAt: "2026-11-06T20:00:00.000Z" });
const say = (text) => ({ id: "m2", role: "assistant", content: [{ type: "text", text }], createdAt: "2026-11-06T20:00:01.000Z" });
const t = (i) => new Date(Date.parse("2026-11-06T20:00:00.000Z") + i * 1000).toISOString();
const entries = [
  { ts: t(0), seq: 0, event: { type: "turn_start", turnId: "t1", sessionId: "s", userMessage: user("fix the build in C:\\Users\\noah\\Desktop\\Ares Workspace\\app, my key is " + KEY) } },
  { ts: t(1), seq: 1, event: { type: "text_delta", text: "Rea" } },
  { ts: t(1), seq: 2, event: { type: "tool_start", id: "a", name: "Read", input: { file_path: "C:\\Users\\noah\\Desktop\\Ares Workspace\\app\\index.ts" }, activityDescription: "Reading index.ts" } },
  { ts: t(2), seq: 3, event: { type: "tool_end", id: "a", output: SOURCE, durationMs: 12 } },
  { ts: t(2), seq: 4, event: { type: "tool_start", id: "b", name: "Write", input: { file_path: "C:\\Users\\noah\\Desktop\\Ares Workspace\\app\\out.ts", content: SOURCE }, activityDescription: "Writing out.ts" } },
  { ts: t(3), seq: 5, event: { type: "tool_error", id: "b", error: "EACCES: permission denied, open 'C:\\Users\\noah\\Desktop\\Ares Workspace\\app\\out.ts'", durationMs: 3 } },
  { ts: t(3), seq: 6, event: { type: "message_done", message: say("Here is the fix:\n```ts\n" + SOURCE + "```\nmail me at noah@example.com"), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" } },
  { ts: t(4), seq: 7, event: { type: "turn_end", status: "completed", durationMs: 4000, provider: "anthropic", model: "claude-x" } },
  { ts: t(60), seq: 8, event: { type: "turn_start", turnId: "t2", sessionId: "s", userMessage: user("try again") } },
  { ts: t(61), seq: 9, event: { type: "message_done", message: say(""), usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "end_turn" } },
  { ts: t(61), seq: 10, event: { type: "turn_end", status: "failed", durationMs: 1000, provider: "anthropic", model: "claude-x" } },
];

const leaks = ["noah", "NOAH-DESKTOP", "example.com", KEY, "secretSauce", "Ares Workspace"];

test("private: the project and the person are gone, the failure is not", () => {
  const { events, removed } = scrubRollout(entries, who, "private");
  const text = JSON.stringify(events);
  for (const leak of leaks) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.match(text, /EACCES: permission denied, open '<workspace>/);
  assert.match(text, /\[content: \d+ chars, \d+ lines, sha256:[0-9a-f]{10}\]/, "written code is a digest");
  assert.match(text, /\[code ts: \d+ chars/, "code in the reply is a digest");
  assert.ok(!text.includes('"text_delta"'), "deltas are dropped");
  assert.ok(removed.some((r) => /contents of files/.test(r)));
});

test("full: the code stays, the person still does not", () => {
  const text = JSON.stringify(scrubRollout(entries, who, "full").events);
  assert.ok(text.includes("secretSauce"));
  for (const leak of ["noah", "NOAH-DESKTOP", "example.com", KEY]) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.match(text, /<workspace>/);
});

test("a date or a version is not a phone number, a private address is kept", () => {
  assert.equal(scrubText("v0.68.2 built 2026-11-06 14:37 at 192.168.1.41", who), "v0.68.2 built 2026-11-06 14:37 at 192.168.1.41");
});

test("the summary names where it broke and how to get there", () => {
  const { events } = scrubRollout(entries, who, "private");
  const summary = reportSummary(events, { appVersion: "0.68.2", os: "win32 x64", provider: "anthropic", model: "claude-x", genui: true, level: "private", removed: ["x"], note: "it broke" });
  assert.match(summary, /turn 1: Write failed: EACCES/);
  assert.match(summary, /turn 2: ended failed/);
  assert.match(summary, /turn 2: empty reply/);
  assert.match(summary, /1\. Send: "fix the build in <workspace>/);
  assert.match(summary, /GenUI on/);
  assert.ok(!summary.includes("noah"));
});
