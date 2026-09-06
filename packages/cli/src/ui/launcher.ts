// Launcher screens as row stacks — the same engine and visual language as the
// chat screen, so the app is one face from the first frame. No splash: the
// first thing you see is the picker.
//
// Geometry (1-based rows, frame top-anchored):
//   1  header   " ARES  {title}            workspace  │  theme"
//   2  hairline
//   3  blank
//   4  section title
//   5  subtitle
//   6  blank
//   7… list items, one per row (LIST_FIRST_ROW)
//   H  footer

import type { Row, Span } from "./rows.js";
import { justify, truncateSpans, shed } from "./rows.js";
import type { Theme } from "./theme.js";
import type { GlyphSet } from "./term.js";
import { textWidth } from "../tuiChrome.js";

export const LIST_FIRST_ROW = 7;

/** Items a list can show in a frame of `height` rows. */
export function listCapacity(height: number): number {
  return Math.max(3, height - (LIST_FIRST_ROW - 1) - 1);
}

export interface ListItem {
  key: string;
  label: string;
  /** Secondary text after the label (description). */
  detail?: string;
  /** Right-aligned status: text + color role. */
  status?: { text: string; color: string };
  /** Right-aligned hint (dim). */
  hint?: string;
  /** Marks the current/persisted choice. */
  current?: boolean;
  /** Favorite marker. */
  favorite?: boolean;
  /** Swatch colors drawn before the label (theme rows). */
  swatch?: string[];
}

export interface LauncherScreen {
  theme: Theme;
  glyphs: GlyphSet;
  width: number;
  height: number;
  title: string;
  workspace: string;
  themeLabel: string;
  section: string;
  subtitle: string;
  items: ListItem[];
  selected: number;
  /** Window start for long lists. */
  scroll?: number;
  total?: number;
  /** Replaces the list with an input line (workspace phase). */
  input?: { value: string; cursorOn: boolean };
  footer: string;
}

export function launcherRows(s: LauncherScreen): Row[] {
  const { theme: t, glyphs: g, width, height } = s;
  const rows: Row[] = [];
  // 1-2 header
  const left: Span[] = [{ text: " " }, { text: "ARES", color: t.primary, bold: true }, { text: `  ${s.title}`, color: t.text }];
  const sep: Span = { text: `  ${g.vbar}  `, color: t.line };
  const right = shed(left, [{ spans: [{ text: s.workspace, color: t.muted }], prio: 1 }, { spans: [{ text: s.themeLabel, color: t.secondary }], prio: 2 }], width - 1, sep);
  right.push({ text: " " });
  rows.push(justify(left, right, width, g.ellipsis));
  rows.push([{ text: g.hbar.repeat(width), color: t.line }]);
  rows.push([]);
  // 4-6 section
  const counter = s.total != null && s.total > s.items.length ? `${(s.scroll ?? 0) + 1}-${(s.scroll ?? 0) + s.items.length} of ${s.total} ` : "";
  rows.push(justify([{ text: ` ${s.section}`, color: t.text, bold: true }], counter ? [{ text: counter, color: t.faint }] : [], width, g.ellipsis));
  rows.push(truncateSpans([{ text: ` ${s.subtitle}`, color: t.muted }], width, g.ellipsis));
  rows.push([]);
  // 7… list or input
  if (s.input) {
    rows.push(truncateSpans([{ text: ` ${g.prompt} `, color: t.primary, bold: true }, { text: s.input.value, color: t.text }, { text: s.input.cursorOn ? g.cursor : " ", color: t.primary }], width, g.ellipsis));
  } else {
    const labelW = Math.min(18, Math.max(8, ...s.items.map((i) => textWidth(i.label))));
    s.items.forEach((item, i) => {
      const on = i === s.selected;
      const leftSpans: Span[] = [{ text: on ? ` ${g.prompt} ` : "   ", color: t.primary, bold: true }];
      if (i < 9) leftSpans.push({ text: `${i + 1} `, color: on ? t.muted : t.faint });
      else leftSpans.push({ text: "  " });
      if (item.swatch && item.swatch.length > 0) {
        for (const c of item.swatch) leftSpans.push({ text: g.dot, color: c });
        leftSpans.push({ text: " " });
      }
      const label = item.label + " ".repeat(Math.max(0, labelW - textWidth(item.label)));
      leftSpans.push({ text: label, color: on ? t.primary : t.text, bold: on });
      if (item.favorite) leftSpans.push({ text: ` ${g.check}`, color: t.warn });
      if (item.detail) leftSpans.push({ text: "   " }, { text: item.detail, color: on ? t.muted : t.faint });
      const rightSpans: Span[] = [];
      if (item.current) rightSpans.push({ text: `${g.check} current`, color: t.success }, { text: "   " });
      if (item.status) rightSpans.push({ text: `${item.status.text}`, color: item.status.color });
      else if (item.hint) rightSpans.push({ text: item.hint, color: t.faint });
      rightSpans.push({ text: " " });
      rows.push(justify(leftSpans, rightSpans, width, g.ellipsis));
    });
  }
  while (rows.length < height - 1) rows.push([]);
  rows.length = Math.min(rows.length, height - 1);
  rows.push(truncateSpans([{ text: ` ${s.footer}`, color: t.faint }], width, g.ellipsis));
  return rows.slice(0, height);
}
