// Snapshot tests for the slate theme + primitives + logo. Structure via strip(),
// color via fg()/bg() escape assertions. All deterministic (fixed tick).
import test from "node:test";
import assert from "node:assert/strict";
import { h, frame, strip, fg, bg, Text } from "./helpers.mjs";

import { SLATE, LOGO_GRADIENT, gradientAt } from "../../dist/ui/theme.js";
import { Panel, Rule, TitleTab, HintBar, SelectRow, GridCard } from "../../dist/ui/primitives.js";
import { Logo, LOGO_ROWS } from "../../dist/ui/Logo.js";
import { spinnerFrame, pulse } from "../../dist/ui/useTick.js";

test("theme: slate has all 15 roles and a distinct non-fire primary", () => {
  for (const role of ["bg","surface","surfaceAlt","line","faint","muted","text","primary","primaryDim","secondary","active","success","danger","warn","accentText"]) {
    assert.match(SLATE[role], /^#[0-9a-f]{6}$/i, `${role} is a hex color`);
  }
  assert.equal(SLATE.primary, "#4ec9b0", "primary is cyan-teal (not fire)");
  assert.equal(LOGO_GRADIENT.length, 5, "5-stop logo gradient");
  // top stop cool-blue, bottom stop mint — no crimson/ember anywhere.
  assert.equal(gradientAt(0, 6), "#6ea8fe");
  assert.equal(gradientAt(5, 6), "#7dd3c0");
});

test("Panel: rounded border, focused tints primary / idle tints line", () => {
  const focused = frame(h(Panel, { theme: SLATE, focused: true }, h(Text, null, "x")));
  assert.match(strip(focused), /╭/, "rounded top-left");
  assert.match(strip(focused), /╰/, "rounded bottom-left");
  assert.ok(focused.includes(fg(SLATE.primary)), "focused border is primary");
  const idle = frame(h(Panel, { theme: SLATE, focused: false }, h(Text, null, "x")));
  assert.ok(idle.includes(fg(SLATE.line)), "idle border is line");
});

test("Rule / TitleTab / HintBar render their glyphs in role colors", () => {
  assert.match(strip(frame(h(Rule, { theme: SLATE, width: 10 }))), /^─{10}$/);
  const tab = frame(h(TitleTab, { title: "MODELS", color: SLATE.secondary, theme: SLATE }));
  assert.match(strip(tab), /╴ MODELS ╶/);
  assert.ok(tab.includes(fg(SLATE.secondary)), "tab title uses its color");
  assert.match(strip(frame(h(HintBar, { text: "click a card", theme: SLATE }))), /─╴ click a card ╶─/);
});

test("SelectRow: selected shows ▸ + band + primary indicator", () => {
  const sel = frame(h(SelectRow, { theme: SLATE, label: "gpt-5.5", hint: "128k", selected: true, width: 40 }));
  assert.match(strip(sel), /▸ gpt-5\.5/);
  assert.match(strip(sel), /128k/);
  assert.ok(sel.includes(fg(SLATE.primary)), "▸ indicator is primary");
  assert.ok(sel.includes(bg(SLATE.surfaceAlt)), "selected row has the surfaceAlt band");
  const idle = frame(h(SelectRow, { theme: SLATE, label: "gpt-5.5", selected: false, width: 40 }));
  assert.doesNotMatch(strip(idle), /▸/, "idle row has no indicator");
});

test("GridCard: renders icon/title/body/status; selected border pulses", () => {
  const card = frame(h(GridCard, {
    theme: SLATE, icon: "◈", title: "ollama", body: "local + cloud",
    status: { text: "● ready", color: SLATE.success }, selected: true, tick: 0, width: 26,
  }));
  const s = strip(card);
  assert.match(s, /◈ ollama/);
  assert.match(s, /local \+ cloud/);
  assert.match(s, /● ready/);
  assert.ok(card.includes(fg(SLATE.success)), "readiness dot in success color");
  // tick 0 → pulse true → primary border; tick 5 → secondary border.
  assert.ok(frame(h(GridCard, { theme: SLATE, icon: "◈", title: "o", body: "b", status: { text: "x", color: SLATE.muted }, selected: true, tick: 0, width: 26 })).includes(fg(SLATE.primary)));
  assert.ok(frame(h(GridCard, { theme: SLATE, icon: "◈", title: "o", body: "b", status: { text: "x", color: SLATE.muted }, selected: true, tick: 5, width: 26 })).includes(fg(SLATE.secondary)));
});

test("Logo: full wordmark is 6 rows, gradient-tinted; revealCols clips L→R", () => {
  const full = strip(frame(h(Logo, { theme: SLATE }))).split("\n").filter((l) => l.trim());
  assert.equal(full.length, LOGO_ROWS, "wordmark is all rows");
  assert.ok(full.some((l) => l.includes("█")), "block art present");
  // top row tinted the top gradient stop; a mid row a middle stop.
  assert.ok(frame(h(Logo, { theme: SLATE })).includes(fg(LOGO_GRADIENT[0])), "top row = top stop");
  // reveal clip: only the first N columns show.
  const clipped = strip(frame(h(Logo, { theme: SLATE, revealCols: 6 }))).split("\n");
  assert.ok(clipped.every((l) => l.length <= 6), "revealCols clips every row");
});

test("useTick phase helpers are pure fns of tick", () => {
  assert.equal(spinnerFrame(0), spinnerFrame(1), "spinner advances every 2 ticks");
  assert.notEqual(spinnerFrame(0), spinnerFrame(2));
  assert.equal(pulse(0), true);
  assert.equal(pulse(5), false);
});
