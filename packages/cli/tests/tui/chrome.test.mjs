// Phase 4 — main chrome snapshots: Header, StatusBar, Transcript/LogRow, InputDeck.
import test from "node:test";
import assert from "node:assert/strict";
import { h, frame, strip, fg, bg } from "./helpers.mjs";

import { SLATE } from "../../dist/ui/theme.js";
import { Header } from "../../dist/ui/chat/Header.js";
import { StatusBar } from "../../dist/ui/chat/StatusBar.js";
import { Transcript, LogRow } from "../../dist/ui/chat/LogRow.js";
import { InputDeck } from "../../dist/ui/chat/InputDeck.js";

test("Header: wordmark, model, tokens, workspace, branch, mode pill", () => {
  const f = frame(h(Header, { theme: SLATE, model: "ares-internal", tokens: 12345, workspace: "D:/Ares", branch: "main", dirty: true, mode: "plan", width: 80 }));
  const s = strip(f);
  assert.match(s, /ARES/); assert.match(s, /ares-internal/);
  assert.match(s, /12,345 tokens/);
  assert.match(s, /D:\/Ares/); assert.match(s, /main ●/, "branch + dirty dot");
  assert.match(s, /\[PLAN\]/);
  assert.ok(f.includes(fg(SLATE.primary)), "wordmark primary");
  assert.ok(f.includes(fg(SLATE.active)), "dirty branch in active");
});

test("StatusBar: ready vs working, stats on the right", () => {
  const ready = strip(frame(h(StatusBar, { theme: SLATE, working: false, tick: 0, msgs: 3, themeName: "slate", version: "0.15.0", width: 90 })));
  assert.match(ready, /● ready/);
  assert.match(ready, /ctrl\+p/);
  assert.match(ready, /3 msgs/); assert.match(ready, /slate/); assert.match(ready, /v0\.15\.0/);
  const working = strip(frame(h(StatusBar, { theme: SLATE, working: true, tick: 0, ttft: 0.8, total: 4.2, msgs: 3, agents: 2, themeName: "slate", version: "0.15.0", width: 90 })));
  assert.match(working, /working/);
  assert.match(working, /esc/);
  assert.match(working, /0\.8s/); assert.match(working, /→4\.2s/);
  assert.match(working, /🤖 2/);
});

test("Transcript: empty state, and user/assistant/tool tones", () => {
  assert.match(strip(frame(h(Transcript, { theme: SLATE, lines: [], width: 60 }))), /What are we building/);
  const lines = [
    { tone: "user", text: "fix the bug" },
    { tone: "assistant", text: "on it" },
    { tone: "tool", name: "Bash", text: "npm test", ok: true, elapsed: "1.2s" },
    { tone: "error", text: "boom" },
  ];
  const f = frame(h(Transcript, { theme: SLATE, lines, width: 60 }));
  const s = strip(f);
  assert.match(s, /▌ fix the bug/, "user row has spine");
  assert.match(s, /on it/);
  assert.match(s, /✓ Bash │ npm test/, "tool row");
  assert.match(s, /boom/);
  assert.ok(f.includes(bg(SLATE.surfaceAlt)), "user row band");
  assert.ok(f.includes(fg(SLATE.success)), "tool ✓ success color");
  assert.ok(f.includes(fg(SLATE.danger)), "error row danger");
});

test("LogRow: failed tool shows ✗ in danger", () => {
  const f = frame(h(LogRow, { theme: SLATE, line: { tone: "tool", name: "Edit", text: "no match", ok: false }, width: 60 }));
  assert.match(strip(f), /✗ Edit │ no match/);
  assert.ok(f.includes(fg(SLATE.danger)));
});

test("InputDeck: placeholder vs value, spine + focused border", () => {
  const empty = frame(h(InputDeck, { theme: SLATE, value: "", tick: 0, width: 60 }));
  assert.match(strip(empty), /▌ What are we building/);
  assert.ok(empty.includes(fg(SLATE.primary)), "focused border + spine primary");
  const typed = strip(frame(h(InputDeck, { theme: SLATE, value: "hello", tick: 0, width: 60 })));
  assert.match(typed, /▌ hello/);
});
