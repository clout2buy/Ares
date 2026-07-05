// Phase 6 — the composed main screen, verified with a realistic fixture so the
// integration (not just isolated components) is proven before cutover.
import test from "node:test";
import assert from "node:assert/strict";
import { h, frame, strip } from "./helpers.mjs";
import { ChatMain, mapTone } from "../../dist/ui/chat/ChatMain.js";

const FIXTURE = {
  snapshot: { model: "ares-internal", workspace: "D:/Ares", mode: "ask" },
  lines: [
    { tone: "user", text: "add a test" },
    { tone: "assistant", text: "on it — writing the test now" },
    { tone: "tool", name: "Write", text: "foo.test.ts", ok: true, elapsed: "0.2s" },
  ],
  stats: { msgs: 2, tokens: 8421, ttft: 0.6, total: 3.1, agents: 0 },
  git: { branch: "main", dirty: false },
  busy: false,
  tick: 0,
  input: "",
  themeName: "slate",
  version: "0.15.0",
  width: 80,
  height: 24,
};

test("ChatMain: composes header + transcript + input + status coherently", () => {
  const s = strip(frame(h(ChatMain, FIXTURE)));
  // header
  assert.match(s, /ARES/); assert.match(s, /ares-internal/); assert.match(s, /8,421 tokens/);
  assert.match(s, /D:\/Ares/); assert.match(s, /main/);
  // transcript
  assert.match(s, /▌ add a test/); assert.match(s, /on it/); assert.match(s, /✓ Write │ foo\.test\.ts/);
  // input + status
  assert.match(s, /What are we building/);
  assert.match(s, /● ready/); assert.match(s, /2 msgs/); assert.match(s, /slate/); assert.match(s, /v0\.15\.0/);
});

test("ChatMain: busy state shows working + thinking + a fleet tree", () => {
  const s = strip(frame(h(ChatMain, {
    ...FIXTURE, busy: true, thinking: true,
    fleet: { summary: "2 agents", rows: [{ glyph: "◆", name: "a", activity: "scanning", last: true }] },
    stats: { ...FIXTURE.stats, agents: 2 },
  })));
  assert.match(s, /working/);
  assert.match(s, /├─|└─/, "fleet tree branch");
  assert.match(s, /🤖 2/);
});

test("mapTone: engine tones fold into the slate row model", () => {
  assert.equal(mapTone("user"), "user");
  assert.equal(mapTone("tool"), "tool");
  assert.equal(mapTone("verify"), "notice");
  assert.equal(mapTone("diff-file"), "muted");
  assert.equal(mapTone("diff-add"), "assistant");
  assert.equal(mapTone("error"), "error");
});
