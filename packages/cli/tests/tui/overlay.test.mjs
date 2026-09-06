// Overlays keep the modalHitTest row contract: title row 1, tabs row 2, hint
// row 3, one item per row from row 4, footer last — and are exactly `height`.
import test from "node:test";
import assert from "node:assert/strict";
import { overlayRows, overlayCapacity, modelsBody, effortBody, listBody, keyCaptureBody, themesBody, EFFORT_PILL_ROW, EFFORT_FIRST_ROW, EFFORT_LAST_ROW, effortPillSpans, effortPillIndexAt } from "../../dist/ui/chat/overlay.js";
import { spanWidth } from "../../dist/ui/rows.js";
import { AQUA } from "../../dist/ui/theme.js";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";
import { modalHitTest, modalTabSpans, MODAL_BODY_START_ROW, SLIDER_LEVELS } from "../../dist/tuiChrome.js";

const txt = (row) => row.map((s) => s.text).join("");
const base = { theme: AQUA, glyphs: UNICODE_GLYPHS, width: 80 };
const TABS = ["ollama", "openai", "anthropic"];

test("models overlay: exact height, tabs at hit-test columns, items from row 4, footer last", () => {
  const models = Array.from({ length: 30 }, (_, i) => ({ id: `model-${i}`, hint: `h${i}` }));
  const height = 23;
  const cap = overlayCapacity(height);
  const body = modelsBody({ ...base, models, sel: 2, scroll: 0, capacity: cap, custom: null, current: "model-2" });
  const rows = overlayRows({ ...base, kind: "models", height, tabs: TABS, activeTab: 1, hint: "30 models", footer: "esc close", body });
  assert.equal(rows.length, height);
  for (const r of rows) assert.ok(spanWidth(r) <= 80);
  assert.match(txt(rows[0]), /^ Models/);
  const tabRow = txt(rows[1]);
  for (const span of modalTabSpans(TABS)) {
    assert.equal(tabRow.slice(span.start - 1, span.end), TABS[span.index], `tab ${span.index} at its span`);
    assert.deepEqual(modalHitTest(span.start, 2, TABS, cap), { kind: "tab", index: span.index });
  }
  assert.match(txt(rows[2]), /30 models/);
  assert.match(txt(rows[MODAL_BODY_START_ROW - 1]), /model-0/);
  assert.match(txt(rows[MODAL_BODY_START_ROW + 1]), /› .*model-2.*✓ current/);
  assert.deepEqual(modalHitTest(10, MODAL_BODY_START_ROW + 2, TABS, cap), { kind: "item", index: 2 });
  assert.match(txt(rows[height - 1]), /esc close/);
  const custom = modelsBody({ ...base, models, sel: 0, scroll: 0, capacity: cap, custom: "gpt-x" });
  assert.match(txt(custom[0]), /custom model id: gpt-x/);
});

test("effort: native pills on the documented row; pill spans map clicks to levels", () => {
  const n = SLIDER_LEVELS.length;
  const spans = effortPillSpans();
  assert.equal(spans.length, n);
  for (const level of [0, 3, n - 1]) {
    const body = effortBody({ ...base, level });
    assert.equal(body.length, EFFORT_LAST_ROW - EFFORT_FIRST_ROW + 1);
    assert.equal(EFFORT_PILL_ROW, EFFORT_FIRST_ROW);
    const pillRow = txt(body[0]);
    const label = ` ${SLIDER_LEVELS[level]} `;
    assert.equal(pillRow.slice(spans[level].start - 1, spans[level].end), label, "pill text sits on its span");
    const on = body[0].find((s) => s.text === label);
    assert.equal(on.inverse, true, "active pill is inverse");
    assert.equal(effortPillIndexAt(spans[level].start), level);
    assert.equal(effortPillIndexAt(spans[level].end), level);
    assert.match(txt(body[2]), new RegExp(`sets /reasoning ${SLIDER_LEVELS[level]}`));
  }
  assert.equal(effortPillIndexAt(1), null, "col 1 is dead space");
  const rows = overlayRows({ ...base, kind: "effort", height: 20, tabs: [], activeTab: -1, hint: "h", footer: "f", body: effortBody({ ...base, level: 2 }) });
  assert.equal(rows.length, 20);
  assert.match(txt(rows[1]), /reasoning dial/);
  const th = themesBody({ ...base, themes: [{ id: "a", label: "A", tagline: "ta", swatch: ["#fff", "#000"] }, { id: "b", label: "B", tagline: "tb", swatch: [] }], current: "b", scroll: 0, capacity: 5 });
  assert.match(txt(th[1]), /› .*B .*tb.*✓ current/);
  assert.match(txt(th[0]), /●●  A/);
});

test("settings bodies: list rows with key glyphs; masked key capture never shows the value", () => {
  const list = listBody({ ...base, items: [{ label: "anthropic", hint: "set key" }, { label: "openai", hint: "set key", current: true }], scroll: 0, capacity: 5 });
  assert.match(txt(list[0]), /1 anthropic.*set key/);
  assert.match(txt(list[1]), /2 openai  ✓.*set key/);
  const kc = keyCaptureBody({ ...base, provider: "anthropic", length: 5 });
  assert.match(txt(kc[1]), /› ●●●●●▏/);
  assert.doesNotMatch(kc.map(txt).join("\n"), /sk-/);
  const ascii = txt(keyCaptureBody({ ...base, glyphs: ASCII_GLYPHS, provider: "x", length: 3 })[1]);
  assert.match(ascii, /> \*\*\*_/);
});
