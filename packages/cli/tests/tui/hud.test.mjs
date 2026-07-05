// Phase 5 — the flat activity HUD.
import test from "node:test";
import assert from "node:assert/strict";
import { h, frame, strip, fg } from "./helpers.mjs";
import { SLATE } from "../../dist/ui/theme.js";
import { ActivityHUD } from "../../dist/ui/chat/ActivityHUD.js";

test("HUD: renders nothing when idle", () => {
  assert.equal(frame(h(ActivityHUD, { theme: SLATE, tick: 0 })), "");
});

test("HUD: thinking cycles phases; current tool shows ⚡", () => {
  assert.match(strip(frame(h(ActivityHUD, { theme: SLATE, tick: 0, thinking: true }))), /✦ Analyzing…/);
  assert.match(strip(frame(h(ActivityHUD, { theme: SLATE, tick: 25, thinking: true }))), /✦ Planning…/);
  const tool = frame(h(ActivityHUD, { theme: SLATE, tick: 0, thinking: true, currentTool: "Bash" }));
  assert.match(strip(tool), /⚡ Running Bash…/);
  assert.ok(tool.includes(fg(SLATE.active)));
});

test("HUD: activity feed shows ✓/✗ + elapsed, last 5", () => {
  const feed = [
    { kind: "read", label: "Read foo.ts", status: "done", elapsed: "0.1s" },
    { kind: "bash", label: "npm test", status: "failed", elapsed: "3s" },
    { kind: "edit", label: "Edit bar.ts", status: "running" },
  ];
  const f = frame(h(ActivityHUD, { theme: SLATE, tick: 0, feed }));
  const s = strip(f);
  assert.match(s, /✓ Read foo\.ts  0\.1s/);
  assert.match(s, /✗ npm test  3s/);
  assert.match(s, /Edit bar\.ts/);
  assert.ok(f.includes(fg(SLATE.success)) && f.includes(fg(SLATE.danger)));
});

test("HUD: fleet renders a flat box-drawing tree (no cutscene)", () => {
  const fleet = {
    summary: "3 agents · 1 running",
    rows: [
      { glyph: "◆", name: "correctness", activity: "scanning diff" },
      { glyph: "◆", name: "security", activity: "done", last: true },
    ],
  };
  const s = strip(frame(h(ActivityHUD, { theme: SLATE, tick: 0, fleet })));
  assert.match(s, /╴ 3 agents · 1 running ╶/);
  assert.match(s, /├─ ◆ @correctness: scanning diff/);
  assert.match(s, /└─ ◆ @security: done/);
});
