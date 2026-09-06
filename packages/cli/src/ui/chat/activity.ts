// The live activity strip — bounded to a few rows above the transcript.
//   ◐ Thinking…  ~8.4k tokens of thought        (deep reasoning stays visibly alive)
//   ◐ Running Bash…
//   ├ ◆ @scout   scanning the repo              (fleet tree, capped)
//   └ ◆ @builder writing tests

import type { Row, Span } from "../rows.js";
import { truncateSpans } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";

export interface FleetRowVm {
  glyph: string;
  name: string;
  activity: string;
  elapsed?: string;
  last?: boolean;
}

export interface ActivityProps {
  theme: Theme;
  glyphs: GlyphSet;
  tick: number;
  thinking?: boolean;
  thinkingTokens?: number;
  currentTool?: string;
  /** Tools in flight right now (drives the "N tools in flight" line). */
  inFlight?: number;
  fleet?: { summary: string; rows: FleetRowVm[] };
  width: number;
  /** Row budget from the layout (0 = render nothing). */
  max: number;
}

const THINK = ["Thinking", "Planning", "Working", "Composing"];

/** How many rows this strip WANTS (the layout clamps). */
export function activityWants(p: Omit<ActivityProps, "max" | "width">): number {
  let n = 0;
  if (p.thinking || p.currentTool || (p.inFlight ?? 0) > 1) n += 1;
  if (p.fleet && p.fleet.rows.length > 0) n += Math.min(3, p.fleet.rows.length);
  return n;
}

export function activityRows(p: ActivityProps): Row[] {
  const { theme: t, glyphs: g, tick, width, max } = p;
  if (max <= 0) return [];
  const rows: Row[] = [];
  const spin = g.spinner[Math.floor(tick / 2) % g.spinner.length];
  const dots = g.ellipsis === "…" ? "…" : "...";
  if ((p.inFlight ?? 0) > 1) {
    rows.push([{ text: ` ${spin} `, color: t.active, bold: true }, { text: `${p.inFlight} tools in flight`, color: t.active }]);
  } else if (p.currentTool) {
    rows.push([{ text: ` ${spin} `, color: t.active, bold: true }, { text: `Running ${p.currentTool}${dots}`, color: t.text }]);
  } else if (p.thinking) {
    const phase = THINK[Math.floor(tick / 25) % THINK.length];
    const spans: Span[] = [{ text: ` ${spin} `, color: t.purple, bold: true }, { text: `${phase}${dots}`, color: t.text }];
    if (p.thinkingTokens && p.thinkingTokens > 0) {
      const pretty = p.thinkingTokens >= 1000 ? `${(p.thinkingTokens / 1000).toFixed(1)}k` : String(p.thinkingTokens);
      spans.push({ text: `  ~${pretty} tokens of thought`, color: t.faint });
    }
    rows.push(spans);
  }
  if (p.fleet && p.fleet.rows.length > 0) {
    const budget = max - rows.length;
    const shown = p.fleet.rows.slice(0, Math.max(0, budget));
    shown.forEach((r, i) => {
      const last = i === shown.length - 1;
      rows.push(
        truncateSpans(
          [
            { text: ` ${last ? g.last : g.branch} `, color: t.line },
            { text: `${r.glyph} @${r.name}`, color: t.purple, bold: true },
            { text: "  " },
            { text: r.activity, color: t.muted },
            r.elapsed ? { text: `  ${r.elapsed}`, color: t.faint } : { text: "" },
          ],
          width,
          g.ellipsis,
        ),
      );
    });
  }
  return rows.slice(0, max);
}
