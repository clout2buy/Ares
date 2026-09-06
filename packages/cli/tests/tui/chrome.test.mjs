// The chrome row builders + their geometry contracts with tuiChrome.
import test from "node:test";
import assert from "node:assert/strict";
import { headerRows } from "../../dist/ui/chat/header.js";
import { statusRow, inputRows, toolbarRow, todoRow, permissionRows } from "../../dist/ui/chat/bottom.js";
import { activityRows, activityWants } from "../../dist/ui/chat/activity.js";
import { paletteRows } from "../../dist/ui/chat/palette.js";
import { spanWidth } from "../../dist/ui/rows.js";
import { AQUA } from "../../dist/ui/theme.js";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";
import { toolbarButtons, toolbarHitTest, slateModelSpan, permHitTest, permButtonsRow, TOOLBAR_ITEMS, textWidth } from "../../dist/tuiChrome.js";
import { computeLayout, layoutTotal, HEADER_ROWS, INPUT_ROWS, PERM_ROWS } from "../../dist/ui/layout.js";

const txt = (row) => row.map((s) => s.text).join("");
const base = { theme: AQUA, glyphs: UNICODE_GLYPHS, width: 80 };

test("header: 2 rows; model chip geometry matches slateModelSpan; sheds tokens first", () => {
  const rows = headerRows({ ...base, model: "deepseek-v4-pro", workspace: "D:/Ares", branch: "main", dirty: true, mode: "plan", tokens: 48210 });
  assert.equal(rows.length, HEADER_ROWS);
  const r1 = txt(rows[0]);
  assert.equal(spanWidth(rows[0]), 80);
  assert.match(r1, /^ ARES  deepseek-v4-pro ⌄/);
  assert.match(r1, / plan /); assert.match(r1, /main ●/); assert.match(r1, /48k tok/);
  const span = slateModelSpan("deepseek-v4-pro");
  // columns are 1-based; the chip covers "deepseek-v4-pro ⌄" starting at col 8
  assert.equal(r1.slice(span.start - 1, span.end), "  deepseek-v4-pro ⌄");
  assert.equal(txt(rows[1]), "─".repeat(80));
  const narrow = txt(headerRows({ ...base, width: 44, model: "deepseek-v4-pro", workspace: "D:/Ares", branch: "main", tokens: 48210 })[0]);
  assert.match(narrow, /deepseek-v4-pro ⌄/, "chip never truncates");
  assert.doesNotMatch(narrow, /tok/, "tokens shed first");
  assert.match(txt(headerRows({ ...base, busy: true, tick: 3, model: "m", workspace: "w" })[0]), /ARES/);
});

test("status: ready vs working; sheds version/ttft on narrow widths; scroll marker", () => {
  const ready = txt(statusRow({ ...base, width: 110, working: false, tick: 0, msgs: 2, tools: 3, agents: 1, errors: 0, ttft: 0.6, version: "0.47.0" }));
  assert.match(ready, /● Ready/); assert.doesNotMatch(ready, /ctrl\+p/, "hints moved to the toolbar edge"); assert.match(ready, /2 msgs/); assert.match(ready, /v0\.47\.0/); assert.match(ready, /0\.6s ttft/);
  const busy = txt(statusRow({ ...base, working: true, tick: 2, turnElapsed: 12.4, msgs: 2, version: "0.47.0" }));
  assert.match(busy, /Working  12s/); assert.match(busy, /type to steer/);
  const narrow = txt(statusRow({ ...base, width: 50, working: false, tick: 0, msgs: 2, tools: 3, agents: 1, errors: 1, ttft: 0.6, version: "0.47.0" }));
  assert.doesNotMatch(narrow, /v0\.47/); assert.match(narrow, /2 msgs/); assert.match(narrow, /1 err/);
  const scrolled = txt(statusRow({ ...base, working: false, tick: 0, msgs: 2, version: "", scrolled: 7 }));
  assert.match(scrolled, /↓ 7 newer/);
});

test("composer: 3 rows, exact width, placeholder / value / multi-line / search / busy", () => {
  const empty = inputRows({ ...base, value: "", cursorOn: true });
  assert.equal(empty.length, INPUT_ROWS);
  for (const r of empty) assert.equal(spanWidth(r), 80);
  assert.match(txt(empty[0]), /^╭─+╮$/); assert.match(txt(empty[2]), /^╰─+╯$/);
  assert.match(txt(empty[1]), /^│ › What are we building\?▏\s+│$/);
  assert.match(txt(inputRows({ ...base, value: "hello", cursorOn: false })[1]), /› hello \s+│$/);
  assert.match(txt(inputRows({ ...base, value: "a\nb\nc", cursorOn: true })[1]), /\[2 more lines\] c▏/);
  const long = txt(inputRows({ ...base, width: 30, value: "x".repeat(100), cursorOn: true })[1]);
  assert.equal(textWidth(long), 30); assert.match(long, /…x+▏/);
  assert.match(txt(inputRows({ ...base, value: "", busy: true })[1]), /type to steer the running turn/);
  assert.match(txt(inputRows({ ...base, value: "", search: { query: "te", match: "tests" } })[1]), /search: te.*› tests/);
  const ascii = inputRows({ ...base, glyphs: ASCII_GLYPHS, value: "" });
  assert.match(txt(ascii[0]), /^\+-+\+$/); assert.match(txt(ascii[1]), /^\| > /);
});

test("toolbar: renders TOOLBAR_ITEMS verbatim at the hit-test columns (both glyph sets)", () => {
  for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
    const row = txt(toolbarRow({ ...base, glyphs }));
    for (const b of toolbarButtons()) {
      const item = TOOLBAR_ITEMS.find((i) => i.id === b.id);
      assert.equal(row.slice(b.start - 1, b.end), item.label, `${b.id} glyphs at cols ${b.start}-${b.end}`);
      assert.equal(toolbarHitTest(b.start, 23, 23, 80), b.id);
      assert.equal(toolbarHitTest(b.end, 23, 23, 80), b.id);
    }
    assert.equal(toolbarHitTest(1, 23, 23, 80), null, "col 1 is dead space");
    assert.match(row, /ctrl\+p commands  ctrl\+o models $/, "hints on the right edge");
  }
  const labels = TOOLBAR_ITEMS.map((i) => i.label).join("");
  assert.match(labels, /^[A-Za-z ]+$/, "labels are ASCII so widths agree on every terminal");
});

test("permission card: 4 rows, buttons on row H-6 land on permHitTest spans", () => {
  const rows = permissionRows({ ...base, toolName: "Bash", reason: "rm -rf outside the workspace", suggestion: "deny", tick: 0 });
  assert.equal(rows.length, PERM_ROWS);
  for (const r of rows) assert.equal(spanWidth(r), 80);
  assert.match(txt(rows[1]), /! Bash  │  rm -rf outside the workspace/);
  const buttons = txt(rows[2]);
  const H = 23;
  assert.equal(permButtonsRow(H), H - 6);
  // content starts at col 3: "│ " then the labels
  assert.equal(buttons.indexOf("[1] allow once") + 1, 3);
  assert.equal(permHitTest(3, H - 6, H), "allow_once");
  assert.equal(permHitTest(buttons.indexOf("[3] deny") + 1, H - 6, H), "deny");
  assert.equal(permHitTest(buttons.indexOf("[2] always allow") + 1, H - 6, H), "allow_always");
});

test("todo strip: progress track + current task; activity strip bounded", () => {
  const t = txt(todoRow({ ...base, todos: [{ content: "a", status: "completed" }, { content: "b", activeForm: "Doing b", status: "in_progress" }, { content: "c", status: "pending" }] }));
  assert.match(t, /1\/3  › Doing b/);
  assert.match(t, /█+░+/);
  assert.equal(activityWants({ theme: AQUA, glyphs: UNICODE_GLYPHS, tick: 0 }), 0);
  const many = { theme: AQUA, glyphs: UNICODE_GLYPHS, tick: 0, thinking: true, fleet: { summary: "5", rows: Array.from({ length: 5 }, (_, i) => ({ glyph: "◆", name: `a${i}`, activity: "x" })) } };
  assert.equal(activityWants(many), 4);
  assert.equal(activityRows({ ...many, width: 80, max: 3 }).length, 3, "clamped by the budget");
  assert.equal(activityRows({ ...many, width: 80, max: 0 }).length, 0);
  assert.match(txt(activityRows({ ...many, width: 80, max: 3 })[0]), /Thinking…/);
  assert.match(txt(activityRows({ theme: AQUA, glyphs: UNICODE_GLYPHS, tick: 0, inFlight: 3, width: 80, max: 1 })[0]), /3 tools in flight/);
});

test("palette: header + bounded windowed items with the selection chevron", () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ cmd: `/c${i}`, desc: `d${i}` }));
  const rows = paletteRows({ ...base, items, selected: 15, query: "c", max: 6 });
  assert.equal(rows.length, 6);
  assert.match(txt(rows[0]), /Commands  \/c/);
  assert.ok(rows.slice(1).some((r) => /› \/c15/.test(txt(r))), "selection visible in the window");
  assert.match(txt(paletteRows({ ...base, items: [], selected: 0, query: "zz", max: 4 })[1]), /no matching command/);
});

test("layout: fixed budget sums to height; strips squeeze before the transcript starves", () => {
  const l = computeLayout({ columns: 80, rows: 24, activityRows: 3, hasTodos: true, paletteRows: 9, hasPerm: true });
  assert.equal(l.height, 24); assert.equal(l.width, 80);
  assert.equal(layoutTotal(l), 24);
  assert.ok(l.transcriptRows >= 3);
  const tiny = computeLayout({ columns: 80, rows: 14, activityRows: 3, hasTodos: true, paletteRows: 9, hasPerm: true });
  assert.equal(layoutTotal(tiny), 14);
  assert.ok(tiny.paletteRows < 9 || tiny.activityRows < 3, "something was squeezed");
  assert.ok(computeLayout({ columns: 49, rows: 24, activityRows: 0, hasTodos: false, paletteRows: 0, hasPerm: false }).tooSmall);
});
