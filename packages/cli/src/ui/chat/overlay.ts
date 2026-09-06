// Fullscreen overlays — Models · Effort · Settings — as exact-height row
// stacks that REPLACE the chat screen. The row contract tuiChrome.modalHitTest
// assumes is preserved verbatim:
//   row 1 title · row 2 tabs (from CHROME_START_COL, sep 3 cells) · row 3 hint ·
//   rows 4… body (one row per item) · last row footer.

import type { Row, Span } from "../rows.js";
import { justify, truncateSpans, spanWidth } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";
import { CHROME_SEPARATOR, MODAL_BODY_START_ROW, SLIDER_LEVELS, keyForIndex, textWidth } from "../../tuiChrome.js";

export type OverlayKind = "models" | "effort" | "settings";

export interface OverlayProps {
  theme: Theme;
  glyphs: GlyphSet;
  kind: OverlayKind;
  width: number;
  height: number;
  tabs: readonly string[];
  activeTab: number;
  hint: string;
  footer: string;
  /** Body rows — each entry is ONE row; the overlay windows them by capacity. */
  body: Row[];
}

/** Capacity for one-row-per-item bodies: rows 4 … height-2 (footer is last). */
export function overlayCapacity(height: number): number {
  return Math.max(1, height - MODAL_BODY_START_ROW - 1);
}

export function overlayRows(p: OverlayProps): Row[] {
  const { theme: t, glyphs: g, width, height } = p;
  const rows: Row[] = [];
  const title = p.kind === "models" ? "Models" : p.kind === "effort" ? "Effort" : "Settings";
  rows.push(justify([{ text: ` ${title}`, color: t.primary, bold: true }], [{ text: "esc close ", color: t.faint }], width, g.ellipsis));
  const sep = textWidth(g.sep) === textWidth(CHROME_SEPARATOR) ? g.sep : CHROME_SEPARATOR;
  const tabs: Span[] = [{ text: " " }];
  if (p.tabs.length === 0) tabs.push({ text: "reasoning dial", color: t.faint });
  p.tabs.forEach((tab, i) => {
    if (i > 0) tabs.push({ text: sep, color: t.line });
    const on = i === p.activeTab;
    // Width must not change with selection (hit-test spans are label widths).
    tabs.push({ text: tab, color: on ? t.primary : t.muted, bold: on, underline: on });
  });
  rows.push(truncateSpans(tabs, width, g.ellipsis));
  rows.push([{ text: ` ${p.hint}`, color: t.faint }]);
  const cap = overlayCapacity(height);
  const body = p.body.slice(0, cap);
  rows.push(...body);
  while (rows.length < height - 1) rows.push([]);
  rows.push([{ text: ` ${p.footer}`, color: t.faint }]);
  return rows.slice(0, height);
}

// ── body builders ────────────────────────────────────────────────────────────

export interface ModelRowVm {
  id: string;
  label?: string;
  hint?: string;
}

export function modelsBody(p: { theme: Theme; glyphs: GlyphSet; models: ModelRowVm[]; sel: number; scroll: number; capacity: number; custom: string | null; width: number; loading?: boolean; current?: string }): Row[] {
  const { theme: t, glyphs: g, width } = p;
  if (p.custom != null) {
    return [
      [{ text: " " }, { text: "custom model id: ", color: t.primary, bold: true }, { text: p.custom, color: t.text }, { text: g.cursor, color: t.primary }, { text: "   enter apply · esc back", color: t.faint }],
    ];
  }
  if (p.loading && p.models.length === 0) return [[{ text: ` ${g.spinner[0]} loading catalog${g.ellipsis}`, color: t.muted }]];
  const items = p.models.map((m, i) => ({ abs: i, label: m.label ?? m.id, hint: m.hint ?? m.id, custom: false, current: m.id === p.current }));
  items.push({ abs: p.models.length, label: `custom model id${g.ellipsis}`, hint: "type any id", custom: true, current: false });
  return items.slice(p.scroll, p.scroll + p.capacity).map((it) => {
    const on = it.abs === p.sel;
    const key = keyForIndex(it.abs) ?? " ";
    return justify(
      [
        { text: on ? ` ${g.prompt} ` : "   ", color: t.primary, bold: true },
        { text: `${key} `, color: t.faint },
        { text: it.label, color: it.custom ? t.purple : on ? t.primary : t.text, bold: on },
        it.current ? { text: `  ${g.check} current`, color: t.success } : { text: "" },
      ],
      [{ text: `${it.hint} `, color: t.faint }],
      width,
      g.ellipsis,
    );
  });
}

// Effort — a native segmented control. Three body rows:
//   row 4  pills   [ off ] [ minimal ] [ low ] [ medium ] ...   (click / 1-7)
//   row 5  what the chosen level means
//   row 6  what it dispatches
export const EFFORT_FIRST_ROW = MODAL_BODY_START_ROW;
export const EFFORT_PILL_ROW = MODAL_BODY_START_ROW;
export const EFFORT_LAST_ROW = MODAL_BODY_START_ROW + 2;
const PILL_START_COL = 2;
const PILL_GAP = 1;

const EFFORT_MEANING: Record<string, string> = {
  off: "no hidden reasoning — fastest, cheapest",
  minimal: "a moment's thought before acting",
  low: "quick reasoning for routine work",
  medium: "balanced thinking — the everyday setting",
  high: "deliberate reasoning for hard problems",
  xhigh: "extended reasoning — slower, more thorough",
  max: "everything the model has — slowest, deepest",
};

/** 1-based inclusive column spans of each pill, in level order. */
export function effortPillSpans(): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let col = PILL_START_COL;
  for (const name of SLIDER_LEVELS) {
    const w = textWidth(` ${name} `);
    out.push({ start: col, end: col + w - 1 });
    col += w + PILL_GAP;
  }
  return out;
}

/** Which level sits under column x on the pill row? null = miss. */
export function effortPillIndexAt(x: number): number | null {
  const spans = effortPillSpans();
  for (let i = 0; i < spans.length; i++) if (x >= spans[i].start && x <= spans[i].end) return i;
  return null;
}

export function effortBody(p: { theme: Theme; glyphs: GlyphSet; level: number; width: number }): Row[] {
  const { theme: t, glyphs: g, width } = p;
  const n = SLIDER_LEVELS.length;
  const level = Math.max(0, Math.min(n - 1, p.level));
  const pills: Span[] = [{ text: " ".repeat(PILL_START_COL - 1) }];
  SLIDER_LEVELS.forEach((name, i) => {
    if (i > 0) pills.push({ text: " ".repeat(PILL_GAP) });
    const on = i === level;
    pills.push({ text: ` ${name} `, color: on ? (i === n - 1 ? t.purple : t.primary) : t.muted, bold: on, inverse: on });
  });
  const meaning: Span[] = [{ text: "  " }, { text: `${level + 1} `, color: t.faint }, { text: EFFORT_MEANING[SLIDER_LEVELS[level]] ?? "", color: t.text }];
  const dispatch: Span[] = [{ text: "  " }, { text: `sets /reasoning ${SLIDER_LEVELS[level]} — applies on your next message`, color: t.faint }];
  return [truncateSpans(pills, width, g.ellipsis), truncateSpans(meaning, width, g.ellipsis), truncateSpans(dispatch, width, g.ellipsis)];
}

/** Theme rows for the Appearance tab: swatch · name · tagline · current. */
export function themesBody(p: { theme: Theme; glyphs: GlyphSet; themes: ReadonlyArray<{ id: string; label: string; tagline: string; swatch: string[] }>; current: string; scroll: number; capacity: number; width: number }): Row[] {
  const { theme: t, glyphs: g, width } = p;
  return p.themes.slice(p.scroll, p.scroll + p.capacity).map((th, i) => {
    const abs = p.scroll + i;
    const on = th.id === p.current;
    const left: Span[] = [{ text: on ? ` ${g.prompt} ` : "   ", color: t.primary, bold: true }, { text: `${keyForIndex(abs) ?? " "} `, color: t.faint }];
    for (const c of th.swatch) left.push({ text: g.dot, color: c });
    left.push({ text: "  " }, { text: th.label.padEnd(10), color: on ? t.primary : t.text, bold: on }, { text: th.tagline, color: t.muted });
    return justify(left, on ? [{ text: `${g.check} current `, color: t.success }] : [{ text: " " }], width, g.ellipsis);
  });
}

export function listBody(p: { theme: Theme; glyphs: GlyphSet; items: Array<{ label: string; hint?: string; current?: boolean }>; sel?: number; scroll: number; capacity: number; width: number }): Row[] {
  const { theme: t, glyphs: g, width } = p;
  return p.items.slice(p.scroll, p.scroll + p.capacity).map((it, i) => {
    const abs = p.scroll + i;
    const on = abs === p.sel;
    return justify(
      [
        { text: on ? ` ${g.prompt} ` : "   ", color: t.primary, bold: true },
        { text: `${keyForIndex(abs) ?? " "} `, color: t.faint },
        { text: it.label, color: on ? t.primary : t.text, bold: on },
        it.current ? { text: `  ${g.check}`, color: t.success } : { text: "" },
      ],
      [{ text: `${it.hint ?? ""} `, color: t.faint }],
      width,
      g.ellipsis,
    );
  });
}

export function infoBody(p: { theme: Theme; glyphs: GlyphSet; lines: string[]; width: number; firstBright?: boolean }): Row[] {
  const { theme: t, glyphs: g, width } = p;
  return p.lines.map((line, i) => truncateSpans([{ text: ` ${line}`, color: i === 0 && p.firstBright ? t.text : t.muted }], width, g.ellipsis));
}

export function keyCaptureBody(p: { theme: Theme; glyphs: GlyphSet; provider: string; length: number; width: number }): Row[] {
  const { theme: t, glyphs: g } = p;
  const dots = g.dot.repeat(Math.min(48, p.length)) || " ";
  return [
    [{ text: ` ${p.provider} API key`, color: t.primary, bold: true }],
    [{ text: ` ${g.prompt} `, color: t.primary }, { text: dots, color: t.text }, { text: g.cursor, color: t.primary }],
    [{ text: " paste or type · enter saves · esc cancels — stored encrypted, never shown", color: t.faint }],
  ];
}

export function rowWidth(r: Row): number {
  return spanWidth(r);
}
