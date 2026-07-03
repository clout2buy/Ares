// tuiFx.ts — the God-of-War FX library. Every generator here is a PURE
// function of (tick, geometry, palette): same inputs → byte-identical frames.
// No Math.random, no timers, no Date — inkLauncher.ts (and later inkTui) own
// the clocks; this file owns the fire. Frames are rows of styled spans in the
// same shape mdRender/tuiElite feed Ink (MdSpan-compatible), with adjacent
// same-style cells merged so a row is a handful of spans, not `width` objects.
// Perf contract: every generator is O(width) (emberRain O(width·height) since
// it returns a grid), integer math throughout. Unit-tested Ink-free in
// tests/tui-fx.test.mjs.

/** One styled run — structurally assignable to mdRender's MdSpan. */
export interface FxSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** Theme hook: callers pass launcher/TUI theme colors so every theme re-tints
 *  the fire instead of fighting a hardcoded orange. Defaults = the rage theme. */
export interface FxPalette {
  /** Hot working orange — the body of every flame. */
  ember: string;
  /** Deep red base — coals, afterglow. */
  crimson: string;
  /** White-hot tips, crests, sparks. */
  gold: string;
  /** Cooled metal. */
  steel: string;
  /** Ash / dead metal. */
  dim: string;
}

export const DEFAULT_FX_PALETTE: FxPalette = {
  ember: "#ff6a44",
  crimson: "#d6402e",
  gold: "#ffd877",
  steel: "#9aa7b0",
  dim: "#8b756d",
};

// ─── Deterministic noise ─────────────────────────────────────────────────────

/** Cheap 2-input integer hash (xorshift-multiply). Replaces Math.random so
 *  every frame is reproducible from (tick, column) alone. */
function fxHash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Triangle wave 0..p over period 2p — the integer stand-in for sin(). */
function tri(x: number, p: number): number {
  const m = (((x | 0) % (2 * p)) + 2 * p) % (2 * p);
  return Math.abs(m - p);
}

/** Append a cell, merging into the previous span when the style matches — this
 *  is what keeps rows at ~5 spans instead of `width` allocations. */
function push(out: FxSpan[], text: string, color?: string, bold?: boolean, dim?: boolean): void {
  const last = out[out.length - 1];
  if (last && last.color === color && !!last.bold === !!bold && !!last.dim === !!dim) {
    last.text += text;
    return;
  }
  const span: FxSpan = { text };
  if (color !== undefined) span.color = color;
  if (bold) span.bold = true;
  if (dim) span.dim = true;
  out.push(span);
}

// ─── flameLine: one-row living flame strip ───────────────────────────────────

const FLAME_GLYPHS = "▁▂▃▅▇";

/** A one-row flame strip `width` cells wide. Heights evolve per (tick, column);
 *  colors ramp dim-red → ember → gold tips; occasional ᐞ/ᐟ tips lick above the
 *  tallest cells. Height changes every 2 ticks so it flickers, not strobes. */
export function flameLine(tick: number, width: number, palette: FxPalette = DEFAULT_FX_PALETTE): FxSpan[] {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return [];
  const t = Math.floor(tick);
  const out: FxSpan[] = [];
  for (let col = 0; col < w; col++) {
    // Two octaves: a per-column flicker plus a component shared with the
    // neighbor (col+1)>>1 so adjacent cells lean together — reads as one
    // breathing flame instead of TV static.
    const a = fxHash(t >> 1, col) % 3;
    const b = fxHash((t >> 1) + 0x9e37, (col + 1) >> 1) % 3;
    const hgt = a + b; // 0..4
    if (hgt === 4 && fxHash(t, col) % 3 === 0) {
      // A tall cell occasionally throws a tip glyph above the strip line.
      push(out, (fxHash(t, col + 7) & 1) === 0 ? "ᐟ" : "ᐞ", palette.gold, true);
      continue;
    }
    const glyph = FLAME_GLYPHS[hgt] ?? "▁";
    if (hgt <= 0) push(out, glyph, palette.crimson, false, true); // coals
    else if (hgt <= 2) push(out, glyph, palette.crimson);
    else if (hgt === 3) push(out, glyph, palette.ember);
    else push(out, glyph, palette.gold, true); // white-hot peak
  }
  return out;
}

// ─── emberRain: sparse rising particles ──────────────────────────────────────

const EMBER_GLYPHS = ["·", "˚", "✦"];

/** `height` rows of sparse embers drifting UP (row index 0 = top). Each column
 *  owns at most one ember on a hashed phase/speed cycle with an off-grid gap,
 *  so embers wink out at the top and relight at the bottom instead of looping
 *  visibly. Color cools with altitude: gold at birth → ember → dim crimson. */
export function emberRain(
  tick: number,
  width: number,
  height: number,
  palette: FxPalette = DEFAULT_FX_PALETTE,
): FxSpan[][] {
  const w = Math.max(0, Math.floor(width));
  const hgt = Math.max(0, Math.floor(height));
  if (w === 0 || hgt === 0) return [];
  const t = Math.floor(tick);
  // Sparse col→style map per row; rows are assembled with merged space runs.
  const cells: Array<Map<number, { g: string; c: string; b: boolean; d: boolean }>> = [];
  for (let r = 0; r < hgt; r++) cells.push(new Map());
  for (let col = 0; col < w; col++) {
    const seed = fxHash(0xa11ce, col);
    if (seed % 3 === 0) continue; // barren column — keeps the field sparse
    const cycle = hgt + 3 + (seed % 5); // > height → time spent dark off-grid
    const speed = 1 + ((seed >>> 4) % 2); // some embers climb every tick, some every other
    const pos = (Math.floor(t / speed) + (seed % cycle)) % cycle; // rows climbed since birth
    const row = hgt - 1 - pos;
    if (row < 0 || row >= hgt) continue; // in the off-grid gap right now
    const g = EMBER_GLYPHS[(seed >>> 8) % 3] ?? "·";
    const third = Math.max(1, Math.floor(hgt / 3));
    if (pos < third) cells[row].set(col, { g, c: palette.gold, b: g === "✦", d: false });
    else if (pos < third * 2) cells[row].set(col, { g, c: palette.ember, b: false, d: false });
    else cells[row].set(col, { g, c: palette.crimson, b: false, d: true }); // cooling near the top
  }
  return cells.map((rowMap) => {
    const out: FxSpan[] = [];
    for (let col = 0; col < w; col++) {
      const cell = rowMap.get(col);
      if (!cell) push(out, " ");
      else push(out, cell.g, cell.c, cell.b, cell.d);
    }
    return out;
  });
}

// ─── fireWordmark: the ARES block letters, on fire ───────────────────────────

const LETTER_ROWS = 5;
const LETTER_W = 5;
const LETTER_GAP = 2;

// 5×5 block-letter font, drawn from █ ▀ ▄ only so the fire gradient reads as
// solid metal. Every row is exactly LETTER_W chars (padded) — the width
// invariant below depends on it.
const FIRE_FONT: Record<string, readonly string[]> = {
  A: ["▄▀▀▀▄", "█   █", "█▀▀▀█", "█   █", "█   █"],
  R: ["█▀▀▀▄", "█   █", "█▀▀▀▄", "█  ▀▄", "█   █"],
  E: ["█▀▀▀▀", "█    ", "█▀▀▀ ", "█    ", "█▄▄▄▄"],
  S: ["▄▀▀▀▀", "█    ", "▀▀▀▀▄", "    █", "▄▄▄▄▀"],
};

export const WORDMARK_LETTERS = ["A", "R", "E", "S"] as const;
export const WORDMARK_ROWS = LETTER_ROWS;
export const WORDMARK_WIDTH = WORDMARK_LETTERS.length * LETTER_W + (WORDMARK_LETTERS.length - 1) * LETTER_GAP; // 26

/** The ARES wordmark as WORDMARK_ROWS rows × WORDMARK_WIDTH cols. A 4-band
 *  fire gradient (dim-red → crimson → ember → gold) sweeps left-to-right with
 *  tick; flame tips (ᐞ/ᐟ) flicker in the gaps of the crown row. `lit` caps how
 *  many letters are ignited (intro lights them one hammer-blow at a time) —
 *  unlit letters render as cold dim metal, never flicker. */
export function fireWordmark(
  tick: number,
  palette: FxPalette = DEFAULT_FX_PALETTE,
  lit: number = WORDMARK_LETTERS.length,
): FxSpan[][] {
  const t = Math.floor(tick);
  const litCount = Math.max(0, Math.min(WORDMARK_LETTERS.length, Math.floor(lit)));
  const litWidth = litCount <= 0 ? 0 : litCount * (LETTER_W + LETTER_GAP) - LETTER_GAP;
  // 4 bands × 4 cols = 16-col cycle; band origin slides right one col per tick,
  // so the gradient visibly rolls through the metal.
  const ramp: Array<{ c: string; b: boolean; d: boolean }> = [
    { c: palette.crimson, b: false, d: true },
    { c: palette.crimson, b: false, d: false },
    { c: palette.ember, b: false, d: false },
    { c: palette.gold, b: true, d: false },
  ];
  const gap = " ".repeat(LETTER_GAP);
  const rows: FxSpan[][] = [];
  for (let r = 0; r < LETTER_ROWS; r++) {
    const line = WORDMARK_LETTERS.map((l) => FIRE_FONT[l][r]).join(gap);
    const out: FxSpan[] = [];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (col >= litWidth) {
        // Cold, unstruck metal — keep the silhouette so ignition reads as a reveal.
        push(out, ch, palette.dim, false, true);
        continue;
      }
      if (r === 0 && ch === " " && fxHash(t, col) % 5 === 0) {
        // Flame tips licking out of the crown-row gaps.
        push(out, (fxHash(t, col + 13) & 1) === 0 ? "ᐟ" : "ᐞ", palette.ember);
        continue;
      }
      if (ch === " ") {
        push(out, ch);
        continue;
      }
      const band = (((col - t) % 16) + 16) % 16;
      const style = ramp[band >> 2] ?? ramp[1];
      push(out, ch, style.c, style.b, style.d);
    }
    rows.push(out);
  }
  return rows;
}

// ─── forgeStrike: hammer-on-anvil spark burst ────────────────────────────────

// kinds: core = the impact point (gold bold) · spark = flying metal (ember) ·
// cool = falling spark losing heat (steel) · ash = last dull mote (dim).
type StrikeKind = "core" | "spark" | "cool" | "ash" | "pad";
const STRIKE_FRAMES: ReadonlyArray<ReadonlyArray<{ t: string; k: StrikeKind }>> = [
  [{ t: "  ", k: "pad" }, { t: "✦", k: "core" }, { t: "  ", k: "pad" }],
  [{ t: " ", k: "pad" }, { t: "˟", k: "spark" }, { t: "✦", k: "core" }, { t: "˟", k: "spark" }, { t: " ", k: "pad" }],
  [{ t: "✦", k: "spark" }, { t: "˟", k: "spark" }, { t: "⚡", k: "core" }, { t: "˟", k: "spark" }, { t: "✦", k: "spark" }],
  [{ t: "˟", k: "spark" }, { t: " ", k: "pad" }, { t: "✦", k: "core" }, { t: " ", k: "pad" }, { t: "˟", k: "spark" }],
  [{ t: " ", k: "pad" }, { t: "˟", k: "cool" }, { t: "·", k: "cool" }, { t: "˟", k: "cool" }, { t: " ", k: "pad" }],
  [{ t: "  ", k: "pad" }, { t: "·", k: "cool" }, { t: "  ", k: "pad" }],
  [{ t: "  ", k: "pad" }, { t: "·", k: "ash" }, { t: "  ", k: "pad" }],
];

export const STRIKE_FRAME_COUNT = STRIKE_FRAMES.length; // 7

/** A 7-frame hammer-strike burst, always 5 cells wide so it sits stably at a
 *  line start. Expands (0-2), holds (3), cools (4-6). Ticks outside [0,7)
 *  return [] — the burst is over and the caller drops the slot. */
export function forgeStrike(tick: number, palette: FxPalette = DEFAULT_FX_PALETTE): FxSpan[] {
  const t = Math.floor(tick);
  if (t < 0 || t >= STRIKE_FRAME_COUNT) return [];
  const out: FxSpan[] = [];
  for (const cell of STRIKE_FRAMES[t]) {
    if (cell.k === "pad") push(out, cell.t);
    else if (cell.k === "core") push(out, cell.t, palette.gold, true);
    else if (cell.k === "spark") push(out, cell.t, palette.ember);
    else if (cell.k === "cool") push(out, cell.t, palette.steel);
    else push(out, cell.t, palette.dim, false, true);
  }
  return out;
}

// ─── ultraSurgeFrame: the molten interference wave ───────────────────────────

export const SURGE_FRAMES = 15;
const SURGE_GLYPHS = " ▁▂▃▄▅▆▇█";

/** Full-width molten wave: three integer triangle-wave bands interfering, block
 *  glyphs by summed height, color strobing crimson→ember→gold in 4-col cells,
 *  ✦ sparkles at full-height crests. Frames 0..SURGE_FRAMES-1 are the surge;
 *  any tick past that returns the SETTLE frame — a calm ▂ pulse alternating
 *  slow crimson/gold (period 8 ticks) — so callers can just keep ticking. */
export function ultraSurgeFrame(tick: number, width: number, palette: FxPalette = DEFAULT_FX_PALETTE): FxSpan[] {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return [];
  const t = Math.floor(tick);
  if (t >= SURGE_FRAMES || t < 0) {
    // Settled: molten pool breathing slowly between crimson and gold.
    const color = ((t >> 3) & 1) === 0 ? palette.crimson : palette.gold;
    return [{ text: "▂".repeat(w), color, dim: true }];
  }
  const strobe = [palette.crimson, palette.ember, palette.gold];
  const out: FxSpan[] = [];
  for (let col = 0; col < w; col++) {
    // Three counter-moving bands: different spatial and temporal frequencies so
    // crests wander instead of scrolling in lockstep.
    const a = tri(col * 2 + t * 5, 16); // 0..16
    const b = tri(col * 3 - t * 7 + 5, 22); // 0..22
    const c = tri(col + t * 3 + 11, 9); // 0..9
    const hgtRaw = Math.floor(a / 4 + b / 6 + c / 3); // ~0..10
    const hgt = hgtRaw > 8 ? 8 : hgtRaw;
    if (hgt === 8) {
      push(out, "✦", palette.gold, true); // sparkle at the crest
      continue;
    }
    const color = strobe[(((t + (col >> 2)) % 3) + 3) % 3];
    push(out, SURGE_GLYPHS[hgt] ?? " ", color, false, hgt <= 1);
  }
  return out;
}

// ─── bladeSweep: the reveal slash ────────────────────────────────────────────

const SWEEP_SPEED = 5; // cols per tick — crosses the wordmark in ~6 frames (≈0.4s at 66ms)
const SWEEP_TRAIL_GOLD = 2;
const SWEEP_TRAIL_EMBER = 7;
const SWEEP_TRAIL_CRIMSON = 14;

/** A horizontal slash: bright ⟫ edge sweeping left→right at SWEEP_SPEED, ━
 *  afterglow cooling gold→ember→crimson→steel behind it, spaces ahead of it.
 *  Once the edge passes width+trail the line is fully settled dim steel. */
export function bladeSweep(tick: number, width: number, palette: FxPalette = DEFAULT_FX_PALETTE): FxSpan[] {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return [];
  const pos = Math.max(0, Math.floor(tick)) * SWEEP_SPEED;
  const out: FxSpan[] = [];
  for (let col = 0; col < w; col++) {
    if (col === pos) {
      push(out, "⟫", palette.gold, true);
    } else if (col > pos) {
      push(out, " ");
    } else {
      const d = pos - col;
      if (d <= SWEEP_TRAIL_GOLD) push(out, "━", palette.gold, true);
      else if (d <= SWEEP_TRAIL_EMBER) push(out, "━", palette.ember);
      else if (d <= SWEEP_TRAIL_CRIMSON) push(out, "━", palette.crimson);
      else push(out, "━", palette.steel, false, true); // cooled rail
    }
  }
  return out;
}

// ─── Streaming/molten polish helpers ─────────────────────────────────────────

/** Streaming caret: ▌/▐ alternating ember/gold each tick — molten drip. */
export function moltenCursor(tick: number, palette: FxPalette = DEFAULT_FX_PALETTE): FxSpan {
  return (Math.floor(tick) & 1) === 0
    ? { text: "▌", color: palette.ember, bold: true }
    : { text: "▐", color: palette.gold, bold: true };
}

/** 4-frame "metal cooling" style for a just-completed tool line:
 *  ember → steel → steel(dim) → dim(dim). Clamps past the end — a finished
 *  line can keep asking forever and stays cold. */
export function coolingLine(tick: number, palette: FxPalette = DEFAULT_FX_PALETTE): { color: string; dim: boolean } {
  const frames: Array<{ color: string; dim: boolean }> = [
    { color: palette.ember, dim: false },
    { color: palette.steel, dim: false },
    { color: palette.steel, dim: true },
    { color: palette.dim, dim: true },
  ];
  const t = Math.floor(tick);
  return frames[t < 0 ? 0 : t > 3 ? 3 : t];
}

// ─── Boot-intro storyboard ───────────────────────────────────────────────────
// The launcher drives ONE ~66ms interval and maps elapsed time through this
// table — timing lives here so tests can pin the budget without an Ink render.

export type IntroStage = "embers" | "ignite" | "sweep" | "settle" | "done";

export const INTRO_TICK_MS = 66;

export const INTRO_STORYBOARD: ReadonlyArray<{ stage: Exclude<IntroStage, "done">; ms: number }> = [
  { stage: "embers", ms: 400 }, // embers rise over a dark screen
  { stage: "ignite", ms: 700 }, // A·R·E·S land one forge-strike at a time
  { stage: "sweep", ms: 400 }, //  blade slash reveals the tagline
  { stage: "settle", ms: 300 }, // fire calms, deck fades in
];

export const INTRO_TOTAL_MS = INTRO_STORYBOARD.reduce((sum, s) => sum + s.ms, 0); // 1800
/** Wall-clock kill switch: even if the event loop stalls and ticks lag, the
 *  launcher force-ends the intro at this elapsed time. */
export const INTRO_HARD_CAP_MS = 2200;

/** Map elapsed ms → { stage, progress 0..1 within that stage }. Past the end
 *  of the storyboard: { stage: "done", progress: 1 }. Pure and total. */
export function introStageAt(elapsedMs: number): { stage: IntroStage; progress: number } {
  let t = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  for (const step of INTRO_STORYBOARD) {
    if (t < step.ms) return { stage: step.stage, progress: t / step.ms };
    t -= step.ms;
  }
  return { stage: "done", progress: 1 };
}
