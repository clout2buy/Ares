// Unit tests for the God-of-War FX library (packages/cli/src/tuiFx.ts):
// determinism (pure functions of tick+geometry), width discipline, the surge
// settle contract, wordmark shape/ignition, strike lifecycle, sweep reveal,
// and the boot-intro storyboard budget. Ink-free by design.
// Run: pnpm --filter @ares/cli build && node --test tests/tui-fx.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FX_PALETTE,
  flameLine,
  emberRain,
  fireWordmark,
  forgeStrike,
  ultraSurgeFrame,
  bladeSweep,
  moltenCursor,
  coolingLine,
  introStageAt,
  INTRO_STORYBOARD,
  INTRO_TOTAL_MS,
  INTRO_HARD_CAP_MS,
  INTRO_TICK_MS,
  STRIKE_FRAME_COUNT,
  SURGE_FRAMES,
  WORDMARK_ROWS,
  WORDMARK_WIDTH,
  WORDMARK_LETTERS,
} from "../packages/cli/dist/tuiFx.js";

/** Concatenated text of one span row. */
const rowText = (spans) => spans.map((s) => s.text).join("");
/** Cell count of a row (code points, so ✦/⟫/ᐟ count as 1). */
const rowWidth = (spans) => [...rowText(spans)].length;
/** Every color used across a row. */
const rowColors = (spans) => new Set(spans.filter((s) => s.color).map((s) => s.color));

const CUSTOM = { ember: "EMB", crimson: "CRI", gold: "GLD", steel: "STL", dim: "DIM" };
const CUSTOM_COLORS = new Set(Object.values(CUSTOM));

// ─── Determinism: same (tick, geometry) → identical frames ───────────────────

test("flameLine is deterministic for the same tick and width", () => {
  assert.deepEqual(flameLine(7, 40), flameLine(7, 40));
  assert.deepEqual(flameLine(123456, 80), flameLine(123456, 80));
});

test("emberRain is deterministic for the same tick and geometry", () => {
  assert.deepEqual(emberRain(11, 60, 8), emberRain(11, 60, 8));
});

test("fireWordmark is deterministic for the same tick", () => {
  assert.deepEqual(fireWordmark(9), fireWordmark(9));
  assert.deepEqual(fireWordmark(9, DEFAULT_FX_PALETTE, 2), fireWordmark(9, DEFAULT_FX_PALETTE, 2));
});

test("ultraSurgeFrame and bladeSweep are deterministic", () => {
  assert.deepEqual(ultraSurgeFrame(7, 44), ultraSurgeFrame(7, 44));
  assert.deepEqual(bladeSweep(3, 30), bladeSweep(3, 30));
});

test("frames differ across ticks (the fire actually moves)", () => {
  assert.notDeepEqual(flameLine(4, 40), flameLine(8, 40));
  assert.notDeepEqual(ultraSurgeFrame(3, 44), ultraSurgeFrame(7, 44));
});

// ─── Width discipline: no row wider than asked ───────────────────────────────

test("flameLine fills exactly `width` cells", () => {
  for (const [tick, width] of [[0, 1], [5, 20], [99, 77]]) {
    assert.equal(rowWidth(flameLine(tick, width)), width);
  }
});

test("flameLine handles zero and negative width", () => {
  assert.deepEqual(flameLine(3, 0), []);
  assert.deepEqual(flameLine(3, -5), []);
});

test("emberRain returns `height` rows of exactly `width` cells", () => {
  const frame = emberRain(21, 50, 6);
  assert.equal(frame.length, 6);
  for (const row of frame) assert.equal(rowWidth(row), 50);
});

test("emberRain is sparse — at most one ember per column", () => {
  const frame = emberRain(13, 40, 10);
  const embers = frame.reduce((n, row) => n + [...rowText(row)].filter((ch) => ch !== " ").length, 0);
  assert.ok(embers > 0, "some embers exist");
  assert.ok(embers <= 40, `at most one per column (got ${embers})`);
});

test("ultraSurgeFrame and bladeSweep fill exactly `width` cells", () => {
  assert.equal(rowWidth(ultraSurgeFrame(6, 64)), 64);
  assert.equal(rowWidth(ultraSurgeFrame(30, 64)), 64); // settle frame too
  assert.equal(rowWidth(bladeSweep(2, 33)), 33);
  assert.equal(rowWidth(bladeSweep(99, 33)), 33); // settled rail too
});

// ─── Wordmark shape ──────────────────────────────────────────────────────────

test("fireWordmark is 5 rows × WORDMARK_WIDTH cols", () => {
  const rows = fireWordmark(4);
  assert.equal(rows.length, WORDMARK_ROWS);
  assert.equal(WORDMARK_ROWS, 5);
  for (const row of rows) assert.equal(rowWidth(row), WORDMARK_WIDTH);
});

test("fireWordmark letters are present (A R E S bitmaps intact)", () => {
  const rows = fireWordmark(0);
  // Rows 1..4 never flicker (tips only touch spaces on the crown row), so
  // their text is the raw font: A|R|E|S joined by 2-space gaps.
  assert.equal(rowText(rows[1]), "█   █  █   █  █      █    ");
  assert.equal(rowText(rows[2]), "█▀▀▀█  █▀▀▀▄  █▀▀▀   ▀▀▀▀▄");
  assert.equal(rowText(rows[4]), "█   █  █   █  █▄▄▄▄  ▄▄▄▄▀");
  assert.equal(WORDMARK_LETTERS.join(""), "ARES");
});

test("fireWordmark crown row keeps the letter glyphs (flicker only in gaps)", () => {
  const crown = rowText(fireWordmark(37)[0]);
  // Strip flame tips back to spaces → must equal the raw crown bitmap.
  assert.equal(crown.replace(/[ᐟᐞ]/gu, " "), "▄▀▀▀▄  █▀▀▀▄  █▀▀▀▀  ▄▀▀▀▀");
});

test("fireWordmark lit=0 renders everything as cold dim metal", () => {
  for (const row of fireWordmark(5, CUSTOM, 0)) {
    for (const span of row) {
      assert.equal(span.color, "DIM");
      assert.equal(span.dim, true);
    }
  }
});

test("fireWordmark lit=2 leaves letters E and S cold", () => {
  const litWidth = 2 * 7 - 2; // two letters + one gap
  for (const row of fireWordmark(5, CUSTOM, 2)) {
    let col = 0;
    for (const span of row) {
      if (col >= litWidth) assert.equal(span.color, "DIM", `col ${col} beyond lit region is cold`);
      col += [...span.text].length;
    }
    // Hot region exists too: the first span of each row must not be ash-dim.
    assert.notEqual(row[0].color, "DIM");
  }
});

// ─── Palette re-tinting ──────────────────────────────────────────────────────

test("generators only emit colors from the supplied palette", () => {
  const frames = [
    flameLine(9, 40, CUSTOM),
    ultraSurgeFrame(6, 40, CUSTOM),
    ultraSurgeFrame(40, 40, CUSTOM),
    bladeSweep(4, 40, CUSTOM),
    forgeStrike(2, CUSTOM),
    ...emberRain(9, 40, 6, CUSTOM),
    ...fireWordmark(9, CUSTOM),
  ];
  for (const frame of frames) {
    for (const color of rowColors(frame)) {
      assert.ok(CUSTOM_COLORS.has(color), `unexpected color ${color}`);
    }
  }
});

// ─── forgeStrike lifecycle ───────────────────────────────────────────────────

test("forgeStrike burns for exactly STRIKE_FRAME_COUNT frames", () => {
  assert.equal(STRIKE_FRAME_COUNT, 7);
  for (let t = 0; t < STRIKE_FRAME_COUNT; t++) {
    const frame = forgeStrike(t);
    assert.ok(frame.length > 0, `frame ${t} exists`);
    assert.equal(rowWidth(frame), 5, `frame ${t} is 5 cells wide`);
  }
  assert.deepEqual(forgeStrike(STRIKE_FRAME_COUNT), []);
  assert.deepEqual(forgeStrike(99), []);
  assert.deepEqual(forgeStrike(-1), []);
});

test("forgeStrike expands then cools (gold core early, dim ash late)", () => {
  assert.ok(forgeStrike(0, CUSTOM).some((s) => s.color === "GLD" && s.bold));
  const last = forgeStrike(STRIKE_FRAME_COUNT - 1, CUSTOM);
  assert.ok(last.some((s) => s.color === "DIM" && s.dim));
  assert.ok(!last.some((s) => s.color === "GLD"), "no gold left in the final frame");
});

// ─── ultraSurge settle contract ──────────────────────────────────────────────

test("ultraSurge surges for SURGE_FRAMES then settles to the calm pulse", () => {
  assert.equal(SURGE_FRAMES, 15);
  const surge = rowText(ultraSurgeFrame(7, 60));
  assert.ok(/[▄▅▆▇✦]/u.test(surge), "mid-surge frame has tall crests");
  for (const t of [15, 16, 40, 1000]) {
    const settle = ultraSurgeFrame(t, 60);
    assert.equal(rowText(settle), "▂".repeat(60), `frame ${t} is the calm pool`);
    assert.equal(settle.length, 1, "settle frame is a single merged span");
  }
});

test("ultraSurge settle pulses slowly between crimson and gold", () => {
  const a = ultraSurgeFrame(16, 30, CUSTOM)[0].color; // (16>>3)&1 = 0 → crimson
  const b = ultraSurgeFrame(24, 30, CUSTOM)[0].color; // (24>>3)&1 = 1 → gold
  assert.equal(a, "CRI");
  assert.equal(b, "GLD");
});

test("ultraSurge mid-surge contains a gold sparkle at some crest", () => {
  let sparkles = 0;
  for (let t = 0; t < SURGE_FRAMES; t++) {
    if (rowText(ultraSurgeFrame(t, 80)).includes("✦")) sparkles++;
  }
  assert.ok(sparkles > 0, "at least one frame carries a ✦ crest");
});

// ─── bladeSweep ──────────────────────────────────────────────────────────────

test("bladeSweep starts at the left edge and sweeps right", () => {
  const start = rowText(bladeSweep(0, 20));
  assert.ok(start.startsWith("⟫"), "edge at col 0 on tick 0");
  const mid = rowText(bladeSweep(2, 20)); // pos = 10
  assert.equal(mid[10], "⟫");
  assert.ok(mid.slice(0, 10).split("").every((ch) => ch === "━"), "rail behind the edge");
  assert.ok(mid.slice(11).split("").every((ch) => ch === " "), "dark ahead of the edge");
});

test("bladeSweep settles to a full dim-steel rail once the edge passes", () => {
  const settled = bladeSweep(50, 24, CUSTOM);
  assert.equal(rowText(settled), "━".repeat(24));
  assert.ok(settled.every((s) => s.color === "STL" && s.dim === true));
});

// ─── Molten polish helpers ───────────────────────────────────────────────────

test("moltenCursor alternates glyph and heat each tick", () => {
  assert.deepEqual(moltenCursor(0, CUSTOM), { text: "▌", color: "EMB", bold: true });
  assert.deepEqual(moltenCursor(1, CUSTOM), { text: "▐", color: "GLD", bold: true });
  assert.deepEqual(moltenCursor(2, CUSTOM), moltenCursor(0, CUSTOM));
});

test("coolingLine fades ember→steel→dim and clamps at both ends", () => {
  assert.deepEqual(coolingLine(0, CUSTOM), { color: "EMB", dim: false });
  assert.deepEqual(coolingLine(1, CUSTOM), { color: "STL", dim: false });
  assert.deepEqual(coolingLine(2, CUSTOM), { color: "STL", dim: true });
  assert.deepEqual(coolingLine(3, CUSTOM), { color: "DIM", dim: true });
  assert.deepEqual(coolingLine(99, CUSTOM), coolingLine(3, CUSTOM)); // stays cold
  assert.deepEqual(coolingLine(-4, CUSTOM), coolingLine(0, CUSTOM));
});

// ─── Intro storyboard budget ─────────────────────────────────────────────────

test("storyboard stages sum to INTRO_TOTAL_MS and respect the hard cap", () => {
  const sum = INTRO_STORYBOARD.reduce((n, s) => n + s.ms, 0);
  assert.equal(sum, INTRO_TOTAL_MS);
  assert.equal(INTRO_TOTAL_MS, 1800);
  assert.ok(INTRO_TOTAL_MS <= INTRO_HARD_CAP_MS, "storyboard fits the 2.2s budget");
  assert.equal(INTRO_HARD_CAP_MS, 2200);
  assert.equal(
    INTRO_STORYBOARD.map((s) => s.stage).join(","),
    "embers,ignite,sweep,settle",
  );
});

test("introStageAt maps elapsed time onto the right stage", () => {
  assert.equal(introStageAt(0).stage, "embers");
  assert.equal(introStageAt(399).stage, "embers");
  assert.equal(introStageAt(400).stage, "ignite");
  assert.equal(introStageAt(1099).stage, "ignite");
  assert.equal(introStageAt(1100).stage, "sweep");
  assert.equal(introStageAt(1500).stage, "settle");
  assert.equal(introStageAt(1799).stage, "settle");
  assert.deepEqual(introStageAt(1800), { stage: "done", progress: 1 });
  assert.deepEqual(introStageAt(99999), { stage: "done", progress: 1 });
});

test("introStageAt progress stays in [0,1) within a stage and is total", () => {
  for (let ms = 0; ms < INTRO_TOTAL_MS; ms += INTRO_TICK_MS) {
    const { progress } = introStageAt(ms);
    assert.ok(progress >= 0 && progress < 1, `progress in range at ${ms}ms`);
  }
  assert.equal(introStageAt(-50).stage, "embers"); // clamps negatives
  assert.equal(introStageAt(Number.NaN).stage, "embers"); // total on garbage
});
