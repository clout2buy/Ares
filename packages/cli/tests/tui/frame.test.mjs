// THE regression class: the chat frame must be exactly (rows-1) tall and never
// wider than (columns-1), for ANY content, at ANY terminal size — and the
// header, composer and toolbar must always be on screen. The old TUI failed
// this the moment one reply was longer than the viewport, on every OS.
import test from "node:test";
import assert from "node:assert/strict";
import { chatMainRows } from "../../dist/ui/chat/ChatMain.js";
import { AQUA } from "../../dist/ui/theme.js";
import { UNICODE_GLYPHS, ASCII_GLYPHS } from "../../dist/ui/term.js";
import { textWidth } from "../../dist/tuiChrome.js";
import { MIN_COLUMNS, MIN_ROWS, layoutTotal } from "../../dist/ui/layout.js";

const longMd =
  "# Plan\n\n" +
  Array.from({ length: 40 }, (_, i) => `- bullet ${i + 1} with a long explanation that wraps on narrow terminals for sure and then some more`).join("\n") +
  "\n\n```ts\nconst x = 1;\n```";

const LINES = [
  { tone: "user", text: "redesign the tui" },
  { tone: "assistant", md: true, text: longMd },
  { tone: "tool", name: "Read", desc: "src/inkTui.ts", text: "2,806 lines", ok: true, elapsed: "0.3s" },
  { tone: "tool", name: "Bash", desc: "pnpm test", text: "47 pass", ok: true, elapsed: "8.9s", preview: ["a", "b", "c", "d", "e", "f", "g"] },
  { tone: "tool", name: "Write", desc: "x.ts", text: "EPERM", ok: false, elapsed: "5ms" },
  { tone: "error", text: "EPERM" },
  { tone: "error", text: "EPERM" },
  { tone: "tool", name: "Bash", desc: "pnpm build", running: true, text: "", elapsed: "2.1s" },
  { tone: "assistant", md: true, stream: true, text: "Rebuilding **now** with a very long streaming line that has to wrap several times on an eighty column terminal " + "x".repeat(300) },
];

function props(over = {}) {
  return {
    theme: AQUA,
    glyphs: UNICODE_GLYPHS,
    columns: 80,
    rows: 24,
    snapshot: { model: "claude-opus-5", workspace: "D:/Ares/some/deep/workspace/path", mode: "plan" },
    git: { branch: "feature/really-long-branch-name", dirty: true },
    lines: LINES,
    stats: { msgs: 4, tokens: 48210, ttft: 0.6, turnElapsed: 12.4, tools: 5, agents: 2, errors: 1 },
    busy: true,
    thinking: true,
    thinkingTokens: 8400,
    currentTool: "Bash",
    inFlight: 1,
    tick: 4,
    cursorOn: true,
    input: "",
    fleet: { summary: "2 agents", rows: [{ glyph: "◆", name: "scout", activity: "scanning" }, { glyph: "◆", name: "builder", activity: "writing", last: true }] },
    todos: [{ content: "a", status: "completed" }, { content: "b", activeForm: "Doing b", status: "in_progress" }],
    perm: { toolName: "Bash", reason: "runs rm -rf outside the workspace", suggestion: "deny" },
    palette: { items: [{ cmd: "/model", desc: "switch" }, { cmd: "/plan", desc: "plan" }], selected: 0, query: "" },
    version: "0.47.0",
    ...over,
  };
}

function check(p) {
  const f = chatMainRows(p);
  const text = f.rows.map((r) => r.map((s) => s.text).join(""));
  assert.equal(f.rows.length, p.bleed === false ? p.rows - 1 : p.rows, `frame height at ${p.columns}x${p.rows}`);
  assert.equal(layoutTotal(f.layout), f.rows.length, "layout total matches drawn rows");
  for (const [i, l] of text.entries()) {
    const maxW = p.bleed === false ? p.columns - 1 : p.columns;
    assert.ok(textWidth(l) <= maxW, `row ${i} width ${textWidth(l)} > ${maxW} at ${p.columns}x${p.rows}: ${JSON.stringify(l)}`);
  }
  return { f, text };
}

test("frame: exact height + width at every size, unicode and ascii, dense content", () => {
  const sizes = [[80, 24], [120, 40], [60, 18], [50, 14], [200, 60], [79, 25], [100, 15]];
  for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
    for (const [columns, rows] of sizes) {
      const { text } = check(props({ columns, rows, glyphs }));
      assert.match(text[0], /ARES/, `header present at ${columns}x${rows}`);
      assert.match(text[0], /claude-opus-5/, `model chip present at ${columns}x${rows}`);
      assert.match(text[text.length - 1], /Models/, `toolbar is the LAST row at ${columns}x${rows}`);
      assert.ok(/steer|What are we building/.test(text[text.length - 3]), `composer content row at ${columns}x${rows}`);
    }
  }
});

test("frame: legacy consoles keep a one-cell safety margin", () => {
  const { f } = check(props({ bleed: false }));
  assert.equal(f.layout.width, 79);
  assert.equal(f.layout.height, 23);
});

test("frame: too-small terminals get a resize notice, never garbage", () => {
  for (const [columns, rows] of [[40, 10], [MIN_COLUMNS - 1, 30], [120, MIN_ROWS - 1], [10, 5]]) {
    const { f, text } = check(props({ columns, rows }));
    assert.ok(f.layout.tooSmall);
    assert.ok(text.some((l) => /Termin|small/.test(l)), `notice at ${columns}x${rows}`);
  }
});

test("frame: idle + empty transcript renders the welcome, no activity strip", () => {
  const { f, text } = check(props({ lines: [], busy: false, thinking: false, currentTool: undefined, inFlight: 0, fleet: undefined, todos: undefined, perm: undefined, palette: undefined }));
  assert.equal(f.layout.activityRows, 0);
  assert.ok(text.some((l) => /Ready\. What are we building\?/.test(l)));
  assert.ok(text.some((l) => /● Ready/.test(l)), "status shows ready");
});

test("frame: scrolling is measured in rendered rows and clamps", () => {
  const p = props({ perm: undefined, palette: undefined });
  const bottom = chatMainRows({ ...p, scrolled: 0 });
  assert.ok(bottom.maxScroll > 20, "a long reply yields many rows to scroll");
  const up = chatMainRows({ ...p, scrolled: 10 });
  const way = chatMainRows({ ...p, scrolled: 10_000 });
  const t0 = bottom.rows.map((r) => r.map((s) => s.text).join(""));
  const t1 = up.rows.map((r) => r.map((s) => s.text).join(""));
  const t2 = way.rows.map((r) => r.map((s) => s.text).join(""));
  assert.notDeepEqual(t0, t1, "scrolling changes the viewport");
  assert.ok(t2.some((l) => /redesign the tui/.test(l)), "scrolled to the top shows the first user turn");
  assert.ok(t1.some((l) => /↓ 10 newer/.test(l)), "status shows the newer-rows marker");
  assert.equal(up.rows.length, bottom.rows.length);
});

test("frame: the permission card sits directly above the status row (buttons row = H-6)", () => {
  const p = props({ palette: undefined });
  const { text } = check(p);
  const H = p.rows;
  assert.match(text[H - 6 - 1], /\[1\] allow once\s+\[2\] always allow\s+\[3\] deny/, "buttons on row H-6 (0-based H-7)");
  assert.match(text[H - 5 - 1], /^╰─+╯$/, "card bottom border on H-5");
  assert.match(text[H - 4 - 1], /Working/, "status row right under the card (H-4)");
});

test("frame: fuzz — random content never breaks the invariants", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const tones = ["user", "assistant", "tool", "notice", "error", "muted"];
  for (let iter = 0; iter < 60; iter++) {
    const n = 1 + Math.floor(rnd() * 30);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const tone = tones[Math.floor(rnd() * tones.length)];
      const len = Math.floor(rnd() * 400);
      const text = Array.from({ length: len }, () => (rnd() < 0.15 ? " " : rnd() < 0.05 ? "\n" : String.fromCharCode(33 + Math.floor(rnd() * 90)))).join("");
      lines.push({ tone, text, md: tone === "assistant" && rnd() < 0.7, name: "Tool", desc: "x".repeat(Math.floor(rnd() * 120)), running: rnd() < 0.2, ok: rnd() < 0.8, preview: rnd() < 0.5 ? ["p".repeat(Math.floor(rnd() * 200))] : undefined });
    }
    const columns = 50 + Math.floor(rnd() * 150);
    const rows = 14 + Math.floor(rnd() * 50);
    check(props({ columns, rows, lines, scrolled: Math.floor(rnd() * 50), glyphs: rnd() < 0.5 ? UNICODE_GLYPHS : ASCII_GLYPHS }));
  }
});
