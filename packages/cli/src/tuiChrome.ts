// Pure clickable-chrome logic — NO Ink imports. The owner's device has no
// arrow keys, so the TUI is mouse-first: this module holds the deterministic
// geometry (toolbar/modal hit-tests), the number-key fallback map, the effort
// slider math, and the ULTRA surge frame math. Everything is data in → data
// out, unit-tested without a terminal (tests/tui-mouse.test.mjs). inkTui.ts
// renders these EXACT layouts so the hit-tests and the pixels can't drift.

import type { ReasoningLevel } from "@ares/protocol";

// ─── Display width (hit-tests must count cells, not code units) ──────────────

/** Terminal cell width of one code point. Covers what the toolbar/modals use:
 *  emoji planes + CJK render double-wide; ZWJ/variation selectors/combining
 *  marks render zero-wide; everything else single. Not a full wcwidth — just
 *  enough that our own labels hit-test correctly. */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji (🔥 🎨 …)
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a string in terminal cells. */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of String(text ?? "")) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

// ─── Bottom toolbar — always-visible click bar ────────────────────────────────

export interface ToolbarItem {
  id: string;
  label: string;
}

/** The one-line click bar pinned to the app frame's bottom row. */
export const TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { id: "models", label: "⚔ Models ▾" },
  { id: "effort", label: "🔥 Effort" },
  { id: "themes", label: "🎨 Themes" },
  { id: "settings", label: "⚙ Settings" },
  { id: "ultra", label: "✦ Ultra" },
];

/** Separator between toolbar buttons / modal tabs. Rendered verbatim. */
export const CHROME_SEPARATOR = " · ";

/** First content column: the app renders chrome rows with paddingX 1, so
 *  1-based column 2 is where labels start. */
export const CHROME_START_COL = 2;

export interface ButtonSpan {
  id: string;
  /** 1-based inclusive terminal columns. */
  start: number;
  end: number;
}

/** Column span of every toolbar button, derived from the rendered label widths
 *  — the same math the renderer uses, so clicks land exactly on the glyphs. */
export function toolbarButtons(items: readonly ToolbarItem[] = TOOLBAR_ITEMS, startCol = CHROME_START_COL): ButtonSpan[] {
  const spans: ButtonSpan[] = [];
  let col = startCol;
  const sep = textWidth(CHROME_SEPARATOR);
  for (const item of items) {
    const w = textWidth(item.label);
    spans.push({ id: item.id, start: col, end: col + w - 1 });
    col += w + sep;
  }
  return spans;
}

/** The toolbar occupies the app frame's BOTTOM row — deterministic because the
 *  main view pins its bottom cluster (status → input → toolbar) with a flex
 *  spacer, so the last rendered row is always the toolbar. */
export function toolbarRow(screenH: number): number {
  return screenH;
}

/** Which toolbar button (id) sits under app-space (x, row)? null = miss.
 *  Gaps between buttons are dead zones on purpose — fat-finger safety. */
export function toolbarHitTest(
  x: number,
  row: number,
  screenH: number,
  screenW: number,
  items: readonly ToolbarItem[] = TOOLBAR_ITEMS,
): string | null {
  if (row !== toolbarRow(screenH)) return null;
  if (x < 1 || x > screenW) return null;
  for (const span of toolbarButtons(items)) {
    if (x >= span.start && x <= span.end) return span.id;
  }
  return null;
}

/** Map a raw terminal row (1-based from the top of the terminal) into the app
 *  frame's row space. The frame is height `screenH`, bottom-aligned in a
 *  terminal of `terminalRows` rows, so the frame's row 1 sits at terminal row
 *  (terminalRows − screenH + 1). */
export function terminalRowToAppRow(y: number, terminalRows: number, screenH: number): number {
  return y - Math.max(0, terminalRows - screenH);
}

// ─── Fullscreen modal geometry ────────────────────────────────────────────────

// When a modal opens it REPLACES the main view — a fullscreen panel anchored at
// app row 1 — so every row is computable:
//   row 1: title      row 2: tabs      row 3: hint
//   rows 4…: list items (item i at row MODAL_BODY_START_ROW + i)
export const MODAL_TITLE_ROW = 1;
export const MODAL_TAB_ROW = 2;
export const MODAL_BODY_START_ROW = 4;

export type ModalHit = { kind: "tab"; index: number } | { kind: "item"; index: number };

/** Column span of each modal tab across MODAL_TAB_ROW. */
export function modalTabSpans(tabs: readonly string[], startCol = CHROME_START_COL): Array<{ index: number; start: number; end: number }> {
  const spans: Array<{ index: number; start: number; end: number }> = [];
  let col = startCol;
  const sep = textWidth(CHROME_SEPARATOR);
  tabs.forEach((tab, index) => {
    const w = textWidth(tab);
    spans.push({ index, start: col, end: col + w - 1 });
    col += w + sep;
  });
  return spans;
}

/** Hit-test a fullscreen modal in app-space. `visibleItems` is how many list
 *  rows are currently rendered; the returned item index is the VISIBLE slot
 *  (caller adds its scroll offset). */
export function modalHitTest(x: number, row: number, tabs: readonly string[], visibleItems: number): ModalHit | null {
  if (row === MODAL_TAB_ROW && tabs.length > 0) {
    for (const span of modalTabSpans(tabs)) {
      if (x >= span.start && x <= span.end) return { kind: "tab", index: span.index };
    }
    return null;
  }
  const slot = row - MODAL_BODY_START_ROW;
  if (slot >= 0 && slot < Math.max(0, visibleItems)) return { kind: "item", index: slot };
  return null;
}

// ─── Number-key fallback (no arrow keys required, ever) ──────────────────────

/** List selection keys: 1-9 for the first nine items, then a-z. Returns the
 *  0-based item index, or null for anything that isn't a selection key. */
export function indexForKey(ch: string): number | null {
  if (typeof ch !== "string" || ch.length !== 1) return null;
  if (ch >= "1" && ch <= "9") return ch.charCodeAt(0) - 49;
  if (ch >= "a" && ch <= "z") return ch.charCodeAt(0) - 97 + 9;
  return null;
}

/** Inverse of indexForKey — the key glyph rendered in front of item `index`. */
export function keyForIndex(index: number): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  if (index < 9) return String(index + 1);
  if (index < 9 + 26) return String.fromCharCode(97 + index - 9);
  return null;
}

// ─── The effort slider — off · low · medium · high · MAX ─────────────────────

/** Slider stops, in dial order. Mirrors @ares/protocol REASONING_LEVELS (type-
 *  checked against ReasoningLevel so drift is a compile error) — kept literal
 *  here so this module stays runtime-dependency-free for the test harness. */
export const SLIDER_LEVELS: readonly ReasoningLevel[] = ["off", "low", "medium", "high", "max"];

/** The color ramp tokens the slider burns through as it slides right. */
export interface SliderTokens {
  steel: string;
  ember: string;
  crimson: string;
  gold: string;
  dim: string;
}

export interface StyledSpan {
  text: string;
  color: string;
  bold?: boolean;
}

function clampLevel(level: number, levels = SLIDER_LEVELS.length): number {
  return Math.max(0, Math.min(levels - 1, Math.floor(Number.isFinite(level) ? level : 0)));
}

/** Which level a click/drag at column `x` lands on. The bar spans barWidth
 *  cells starting at barStart; stops are evenly spaced, nearest wins. */
export function sliderIndexAt(x: number, barStart: number, barWidth: number, levels = SLIDER_LEVELS.length): number {
  if (levels <= 1 || barWidth <= 1) return 0;
  const rel = (x - barStart) / (barWidth - 1);
  return Math.max(0, Math.min(levels - 1, Math.round(rel * (levels - 1))));
}

/** The handle's 0-based cell offset within a bar of `width` cells. */
export function sliderHandleOffset(level: number, width: number, levels = SLIDER_LEVELS.length): number {
  const l = clampLevel(level, levels);
  return Math.round((l / (levels - 1)) * (Math.max(2, width) - 1));
}

/** Fill color ramps steel→ember→crimson→gold as the dial climbs. */
export function sliderFillColor(level: number, t: SliderTokens): string {
  const l = clampLevel(level);
  return [t.dim, t.steel, t.ember, t.crimson, t.gold][l];
}

/** Fill glyphs get denser with the level: ─ → ━ → ▬. */
export function sliderGlyph(level: number): string {
  const l = clampLevel(level);
  if (l >= 3) return "▬";
  if (l === 2) return "━";
  return "─";
}

/** The bar itself as styled spans: dense colored fill up to the handle (●),
 *  dim track after. Concatenated text is always exactly `width` cells. */
export function sliderSpans(level: number, width: number, t: SliderTokens): StyledSpan[] {
  const w = Math.max(2, Math.floor(width));
  const l = clampLevel(level);
  const handle = sliderHandleOffset(l, w);
  const spans: StyledSpan[] = [];
  if (handle > 0) spans.push({ text: sliderGlyph(l).repeat(handle), color: sliderFillColor(l, t), bold: l >= 3 });
  spans.push({ text: "●", color: l === 0 ? t.dim : sliderFillColor(l, t), bold: true });
  if (handle < w - 1) spans.push({ text: "─".repeat(w - 1 - handle), color: t.dim });
  return spans;
}

/** Flame row rendered ABOVE the bar: sparks (ᐟ) accumulate over the filled
 *  span as the dial climbs; MAX earns real fire (🔥, 2 cells wide — the width
 *  bookkeeping accounts for it). Display width never exceeds `width`. */
export function sliderFlameRow(level: number, width: number): string {
  const w = Math.max(2, Math.floor(width));
  const l = clampLevel(level);
  if (l <= 1) return "";
  const handle = sliderHandleOffset(l, w);
  const step = l === 2 ? 6 : l === 3 ? 3 : 2;
  let out = "";
  let col = 0; // display cells emitted so far
  let flameCount = 0;
  while (col <= handle && col < w) {
    if (col % step === 0) {
      // Every third MAX-level spark upgrades to 🔥 (2 cells) when it fits.
      if (l === 4 && flameCount % 3 === 2 && col + 2 <= w) {
        out += "🔥";
        col += 2;
      } else {
        out += "ᐟ";
        col += 1;
      }
      flameCount++;
    } else {
      out += " ";
      col += 1;
    }
  }
  return out.replace(/\s+$/, "");
}

// ─── THE ULTRA SURGE ─────────────────────────────────────────────────────────

// ~1.2s of mayhem when the handle lands on MAX: an ember wave ripples the
// slider row ± one row, colors strobe crimson→ember→gold every tick (80ms),
// the modal title jitters ±1 column — then it all settles into the pulsing
// ✦ U L T R A ✦ badge. Frame math is pure; inkTui drives it with one
// self-stopping interval.

export const SURGE_TICK_MS = 80;
export const SURGE_TICKS = 15; // 15 × 80ms ≈ 1.2s

const SURGE_RAMP = ["▁", "▂", "▃", "▅", "▇"] as const;

/** Strobe color for tick t: crimson→ember→gold, cycling every 3 ticks. */
export function surgeStrobeColor(tick: number, t: SliderTokens): string {
  const i = ((Math.floor(tick) % 3) + 3) % 3;
  return [t.crimson, t.ember, t.gold][i];
}

/** One rippling wave row: block glyphs ▁▂▃▅▇ marching left→right two cells per
 *  tick. `phase` offsets the pattern so the rows above/below counter-ripple. */
export function surgeWaveRow(tick: number, width: number, phase = 0): string {
  const w = Math.max(1, Math.floor(width));
  let out = "";
  for (let i = 0; i < w; i++) {
    const idx = (((i + phase - Math.floor(tick) * 2) % SURGE_RAMP.length) + SURGE_RAMP.length) % SURGE_RAMP.length;
    out += SURGE_RAMP[idx];
  }
  return out;
}

export interface SurgeFrame {
  /** Wave row rendered one row above the bar. Empty when done. */
  above: string;
  /** The bar row itself — a solid strobing block wall. */
  bar: string;
  /** Wave row rendered one row below the bar. */
  below: string;
  /** Strobe color for all three rows this tick. */
  color: string;
  /** Title jitter in columns: −1 | 0 | +1. */
  titleOffset: number;
  /** True once the surge has run its course — settle into the ULTRA badge. */
  done: boolean;
}

/** The complete surge frame for `tick` — spans for the slider row and its
 *  neighbors. Pure; inkTui just paints it. */
export function surgeFrame(tick: number, width: number, t: SliderTokens): SurgeFrame {
  const w = Math.max(1, Math.floor(width));
  if (!Number.isFinite(tick) || tick >= SURGE_TICKS) {
    return { above: "", bar: "", below: "", color: t.gold, titleOffset: 0, done: true };
  }
  const tt = Math.max(0, Math.floor(tick));
  return {
    above: surgeWaveRow(tt, w, 0),
    bar: "▇".repeat(w),
    below: surgeWaveRow(tt, w, 2),
    color: surgeStrobeColor(tt, t),
    titleOffset: (tt % 3) - 1,
    done: false,
  };
}

/** The persistent post-surge badge. */
export const ULTRA_BADGE = "✦ U L T R A ✦";

/** Slow breathe between crimson and gold — the caller ticks this every 600ms.
 *  Static fallback (no motion): call with tick 1 for the settled gold face. */
export function ultraBadgeFrame(tick: number, t: SliderTokens): StyledSpan {
  const even = ((Math.floor(tick) % 2) + 2) % 2 === 0;
  return { text: ULTRA_BADGE, color: even ? t.crimson : t.gold, bold: true };
}

// ─── Reasoning-line parsing (seed the slider from the live dial) ─────────────

/** Pull the live level out of the host's `/reasoning` reply — the line reads
 *  "Reasoning: <label> (<level>). …". Null when no level is present. */
export function parseReasoningLevel(lines: readonly string[]): ReasoningLevel | null {
  for (const line of lines ?? []) {
    const m = /\((off|low|medium|high|max)\)/.exec(String(line ?? ""));
    if (m) return m[1] as ReasoningLevel;
  }
  return null;
}
