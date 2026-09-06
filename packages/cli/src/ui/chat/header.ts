// Header — 2 rows. A menu-bar read: wordmark, the model chip (click target),
// then workspace · branch · mode on the right, and a hairline under it.
//
// Geometry contract (tuiChrome.slateModelSpan): row 1 is
//   " ARES  {model} ⌄" — col 1 pad · ARES 2-5 · two spaces · model from col 8.

import type { Row, Span } from "../rows.js";
import { justify, shed } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";
import { LOGO_GRADIENT } from "../theme.js";

export interface HeaderProps {
  theme: Theme;
  glyphs: GlyphSet;
  model: string;
  workspace: string;
  branch?: string;
  dirty?: boolean;
  mode?: "plan" | "bypass" | null;
  tokens?: number;
  busy?: boolean;
  tick?: number;
  width: number;
}

export function headerRows(p: HeaderProps): Row[] {
  const { theme: t, glyphs: g, width, tick = 0 } = p;
  const mark: Span[] = p.busy
    ? "ARES".split("").map((ch, i) => ({ text: ch, color: LOGO_GRADIENT[(i + Math.floor(tick / 3)) % LOGO_GRADIENT.length], bold: true }))
    : [{ text: "ARES", color: t.primary, bold: true }];
  const left: Span[] = [{ text: " " }, ...mark, { text: "  " }, { text: p.model, color: t.text, bold: true }, { text: ` ${g.caret}`, color: t.faint }];
  // Right cluster — drawn left→right, shed lowest-priority-first when narrow,
  // so the model chip (a click target) never truncates.
  const sep: Span = { text: `  ${g.vbar}  `, color: t.line };
  const right = shed(
    left,
    [
      { spans: p.mode ? [{ text: p.mode === "bypass" ? " bypass " : " plan ", color: p.mode === "bypass" ? t.danger : t.warn, bold: true, inverse: true }] : [], prio: 9 },
      { spans: [{ text: p.workspace, color: t.muted }], prio: 2 },
      { spans: p.branch ? [{ text: p.branch, color: p.dirty ? t.active : t.success }, ...(p.dirty ? [{ text: ` ${g.dot}`, color: t.active }] : [])] : [], prio: 3 },
      { spans: p.tokens && p.tokens > 0 ? [{ text: `${compact(p.tokens)} tok`, color: t.faint }] : [], prio: 1 },
    ].filter((it) => it.spans.length > 0),
    width - 1,
    sep,
  );
  right.push({ text: " " });
  return [justify(left, right, width, g.ellipsis), [{ text: g.hbar.repeat(width), color: t.line }]];
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
