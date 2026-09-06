// Launcher screens on the row engine — exact height, list geometry from
// LIST_FIRST_ROW (the mouse contract), every phase, both glyph sets.
import test from "node:test";
import assert from "node:assert/strict";
import { launcherRows, LIST_FIRST_ROW, listCapacity } from "../../dist/ui/launcher.js";
import { spanWidth } from "../../dist/ui/rows.js";
import { AQUA } from "../../dist/ui/theme.js";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";
import { TUI_THEMES, resolveTheme, tuiTheme, DEFAULT_TUI_THEME, isTuiTheme } from "../../dist/ui/themes.js";

const txt = (r) => r.map((s) => s.text).join("");
const base = (over = {}) => ({
  theme: AQUA, glyphs: UNICODE_GLYPHS, width: 100, height: 24, workspace: "D:/Ares", themeLabel: "midnight",
  title: "Choose a provider", section: "Providers", subtitle: "Ready to chat.",
  items: [
    { key: "ares", label: "In-House", detail: "The Ares account — frontier models on us.", status: { text: "● ready", color: AQUA.success }, current: true },
    { key: "ollama", label: "Ollama Cloud", detail: "Cloud and local models.", status: { text: "● ready", color: AQUA.success } },
    { key: "openai", label: "OpenAI", detail: "ChatGPT OAuth login.", status: { text: "◐ sign in", color: AQUA.secondary } },
    { key: "anthropic", label: "Anthropic", detail: "Claude API models.", status: { text: "○ no key", color: AQUA.danger } },
  ],
  selected: 1,
  footer: "enter open · q quit",
  ...over,
});

test("launcher: provider list — exact frame, header, items from LIST_FIRST_ROW, footer last", () => {
  for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
    for (const [width, height] of [[100, 24], [60, 14], [160, 50]]) {
      const rows = launcherRows(base({ glyphs, width, height }));
      const t = rows.map(txt);
      assert.equal(rows.length, height, `height at ${width}x${height}`);
      for (const r of rows) assert.ok(spanWidth(r) <= width, `row too wide at ${width}: ${txt(r)}`);
      assert.match(t[0], /^ ARES  Choose a provider/);
      assert.match(t[0], /midnight/);
      assert.match(t[3], /Providers/);
      assert.match(t[LIST_FIRST_ROW - 1], /1 In-House/);
      assert.match(t[LIST_FIRST_ROW], /2 Ollama Cloud/);
      assert.match(t[LIST_FIRST_ROW], glyphs === ASCII_GLYPHS ? /^ > / : /^ › /, "selection chevron on the selected row");
      assert.match(t[height - 1], /enter open/);
    }
  }
});

test("launcher: current marker + status align right; labels pad to a column", () => {
  const t = launcherRows(base()).map(txt);
  assert.match(t[LIST_FIRST_ROW - 1], /✓ current\s+● ready $/);
  assert.match(t[LIST_FIRST_ROW + 2], /○ no key $/);
  const col = (line) => line.indexOf("The Ares");
  assert.equal(col(t[LIST_FIRST_ROW - 1]) > 0, true);
});

test("launcher: windowed model list shows the counter; workspace phase shows the input", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ key: `m${i}`, label: `model-${i + 20}`, hint: `${i}k`, favorite: i === 0 }));
  const t = launcherRows(base({ title: "Models", section: "Models", items, selected: 2, scroll: 20, total: 60, height: 20 })).map(txt);
  assert.match(t[3], /21-28 of 60/);
  assert.match(t[LIST_FIRST_ROW - 1], /model-20 ✓/, "favorite check");
  const ws = launcherRows(base({ title: "Workspace", items: [], input: { value: "D:/Proj", cursorOn: true } })).map(txt);
  assert.match(ws[LIST_FIRST_ROW - 1], /^ › D:\/Proj▏/);
  assert.equal(listCapacity(24), 24 - 6 - 1);
});

test("themes: registry resolves by tier; every theme is complete in both tiers", () => {
  assert.ok(TUI_THEMES.length >= 5);
  assert.equal(tuiTheme(undefined).id, DEFAULT_TUI_THEME);
  assert.equal(tuiTheme("nope").id, DEFAULT_TUI_THEME);
  assert.ok(isTuiTheme("daylight"));
  for (const t of TUI_THEMES) {
    for (const role of Object.keys(AQUA)) {
      assert.match(t.truecolor[role], /^#[0-9a-f]{6}$/i, `${t.id}.${role} truecolor`);
      assert.match(t.ansi[role], /^[a-zA-Z]+$/, `${t.id}.${role} ansi`);
    }
  }
  assert.equal(resolveTheme("rose", 3).primary, "#ff375f");
  assert.equal(resolveTheme("rose", 1).primary, "redBright");
  assert.equal(resolveTheme("daylight", 3).text, "#1d1d1f", "light theme uses ink text");
});
