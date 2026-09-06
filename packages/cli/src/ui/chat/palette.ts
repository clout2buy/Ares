// Command palette rows — slots under the transcript, bounded by the layout.
//   ⌘ Commands   /mod                       12 · ↑↓ · enter · esc
//   › /model     switch the live model
//     /models    list models for a provider

import type { Row } from "../rows.js";
import { justify, truncateSpans } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";

export interface PaletteItem {
  cmd: string;
  desc: string;
}

export function paletteWants(count: number): number {
  return 1 + Math.min(8, Math.max(1, count));
}

export function paletteRows(p: { theme: Theme; glyphs: GlyphSet; items: PaletteItem[]; selected: number; query: string; width: number; max: number }): Row[] {
  const { theme: t, glyphs: g, items, width, max } = p;
  if (max <= 0) return [];
  const rows: Row[] = [];
  const sel = items.length ? Math.min(p.selected, items.length - 1) : 0;
  rows.push(
    justify(
      [{ text: " Commands", color: t.primary, bold: true }, { text: p.query ? `  /${p.query.replace(/^\//, "")}` : "", color: t.text }],
      [{ text: `${items.length}`, color: t.muted }, { text: `  ${g.upArrow}${g.downArrow} move  enter run  esc close `, color: t.faint }],
      width,
      g.ellipsis,
    ),
  );
  const body = max - 1;
  if (items.length === 0) {
    rows.push([{ text: "   no matching command", color: t.faint }]);
  } else {
    const start = items.length > body ? Math.min(Math.max(0, sel - Math.floor(body / 2)), items.length - body) : 0;
    const shown = items.slice(start, start + body);
    shown.forEach((it, i) => {
      const on = start + i === sel;
      const pad = " ".repeat(Math.max(1, 12 - it.cmd.length));
      rows.push(
        truncateSpans(
          [
            { text: on ? ` ${g.prompt} ` : "   ", color: t.primary, bold: true },
            { text: it.cmd, color: on ? t.primary : t.text, bold: on },
            { text: pad },
            { text: it.desc, color: on ? t.muted : t.faint },
          ],
          width,
          g.ellipsis,
        ),
      );
    });
  }
  return rows.slice(0, max);
}
