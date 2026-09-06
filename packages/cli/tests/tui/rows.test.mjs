// The row engine — wrapping, truncation, justification, and the transcript
// flattening that makes height arithmetic instead of layout.
import test from "node:test";
import assert from "node:assert/strict";
import { wrapSpans, truncateSpans, justify, shed, cut, spanWidth, flattenTranscript, flattenLine } from "../../dist/ui/rows.js";
import { AQUA } from "../../dist/ui/theme.js";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";

const txt = (row) => row.map((s) => s.text).join("");
const opts = (over = {}) => ({ theme: AQUA, glyphs: UNICODE_GLYPHS, tick: 0, width: 40, cursorOn: true, ...over });

test("wrapSpans: breaks on spaces, indents continuations, keeps styles", () => {
  const rows = wrapSpans([{ text: "the quick brown fox jumps over the lazy dog", color: "red", bold: true }], 12, "  ");
  assert.deepEqual(rows.map(txt), ["the quick", "  brown fox", "  jumps over", "  the lazy", "  dog"]);
  for (const r of rows) assert.ok(spanWidth(r) <= 12);
  assert.equal(rows[1][1].color, "red");
  assert.equal(rows[1][1].bold, true);
});

test("wrapSpans: hard-breaks oversized words and never returns zero rows", () => {
  const rows = wrapSpans([{ text: "x".repeat(25) }], 10);
  assert.deepEqual(rows.map(txt), ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  assert.equal(wrapSpans([], 10).length, 1);
  assert.equal(wrapSpans([{ text: "" }], 10).length, 1);
});

test("wrapSpans: mixed-style runs wrap as one line", () => {
  const rows = wrapSpans([{ text: "bold ", bold: true }, { text: "plain text that is long" }], 14);
  assert.deepEqual(rows.map(txt), ["bold plain", "text that is", "long"]);
});

test("truncateSpans / cut: cell-accurate with an ellipsis", () => {
  assert.equal(txt(truncateSpans([{ text: "hello " }, { text: "world" }], 8)), "hello w…");
  assert.equal(txt(truncateSpans([{ text: "hi" }], 8)), "hi");
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(cut("abcdef", 4, "..."), "a...");
  assert.equal(cut("abc", 0), "");
});

test("justify: right cluster wins; left ellipsizes; exact width", () => {
  const row = justify([{ text: "a long left label" }], [{ text: "right" }], 20);
  assert.equal(spanWidth(row), 20);
  assert.equal(txt(row), "a long left la…right");
});

test("shed: drops lowest priority items until the cluster fits", () => {
  const sep = { text: " | " };
  const items = [
    { spans: [{ text: "version" }], prio: 0 },
    { spans: [{ text: "msgs" }], prio: 5 },
    { spans: [{ text: "tools" }], prio: 3 },
  ];
  assert.equal(txt(shed([{ text: "L" }], items, 80, sep)), "version | msgs | tools");
  assert.equal(txt(shed([{ text: "L" }], items, 18, sep)), "msgs | tools");
  assert.equal(txt(shed([{ text: "L" }], items, 8, sep)), "msgs");
});

test("flattenLine: tool cards — running vs settled vs failed, elbow + preview", () => {
  const run = flattenLine({ tone: "tool", name: "Bash", desc: "pnpm build", running: true, elapsed: "2.1s", text: "" }, 1, opts({ tick: 0 }));
  assert.equal(run.length, 1);
  assert.match(txt(run[0]), /^  ◐ Bash  pnpm build  2\.1s$/);
  const ok = flattenLine({ tone: "tool", name: "Read", desc: "src/a.ts", text: "120 lines", ok: true, elapsed: "0.3s", preview: ["p1", "p2"] }, 1, opts());
  assert.deepEqual(ok.map(txt), ["  ● Read  src/a.ts  0.3s", "    ⎿ 120 lines", "      p1", "      p2"]);
  assert.equal(ok[0][1].color, AQUA.success);
  const bad = flattenLine({ tone: "tool", name: "Write", desc: "x", text: "EPERM", ok: false }, 1, opts());
  assert.equal(bad[0][1].color, AQUA.danger);
  assert.equal(bad[1][1].color, AQUA.danger, "failed headline is red");
  const edit = flattenLine({ tone: "tool", name: "Edit", desc: "t.ts", text: "", ok: true, adds: 12, dels: 3 }, 1, opts());
  assert.match(txt(edit[0]), /\+12 −3/);
});

test("flattenLine: user / notice / error(×N) / muted / assistant markdown", () => {
  assert.match(txt(flattenLine({ tone: "user", text: "hi" }, 1, opts())[0]), /^› hi$/);
  assert.match(txt(flattenLine({ tone: "notice", text: "n" }, 1, opts())[0]), /● n$/);
  assert.match(txt(flattenLine({ tone: "error", text: "boom" }, 3, opts())[0]), /✕ boom  ×3$/);
  assert.match(txt(flattenLine({ tone: "error", text: "boom" }, 3, opts({ glyphs: ASCII_GLYPHS }))[0]), /x boom  x3$/);
  const md = flattenLine({ tone: "assistant", md: true, text: "# Title\n\nsome `code` here\n\n```ts\nconst x = 1;\n```" }, 1, opts());
  assert.match(txt(md[0]), /^● Title/);
  assert.ok(md.some((r) => /const x = 1;/.test(txt(r))));
  const streaming = flattenLine({ tone: "assistant", md: true, stream: true, text: "hello" }, 1, opts());
  assert.match(txt(streaming[streaming.length - 1]), /▏$/, "stream cursor on the last row");
});

test("flattenTranscript: identical errors collapse; user turns get a breath", () => {
  const rows = flattenTranscript(
    [
      { tone: "user", text: "a" },
      { tone: "error", text: "E" },
      { tone: "error", text: "E" },
      { tone: "error", text: "E" },
      { tone: "user", text: "b" },
    ],
    opts(),
  );
  const t = rows.map(txt);
  assert.deepEqual(t, ["› a", "  ✕ E  ×3", "", "› b"]);
  for (const r of rows) assert.ok(spanWidth(r) <= 40);
});

test("flattenTranscript: every row respects width with wide/odd content", () => {
  const rows = flattenTranscript(
    [{ tone: "assistant", md: true, text: "日本語のテキスト ".repeat(20) + "\n\n- " + "word ".repeat(60) }],
    opts({ width: 30 }),
  );
  for (const r of rows) assert.ok(spanWidth(r) <= 30, `row too wide: ${txt(r)}`);
});
