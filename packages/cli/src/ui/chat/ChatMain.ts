// The composed chat screen — a stack of exactly `layout.height` rows.
//
// Nothing here is a flex box that can grow: header, activity strip, the
// transcript viewport, todo strip, palette, permission card, status, composer,
// toolbar — every piece is a fixed number of pre-built rows (see layout.ts), so
// the frame is always terminal-height-minus-one and Ink never overflows. The
// pure `chatMainRows()` is what the harness pins; `ChatMain` just paints it.

import React from "react";
import { RowsView } from "../RowText.js";
import { computeLayout, layoutTotal, type Layout } from "../layout.js";
import { flattenTranscript, truncateSpans, type LogLine, type Row, type Span } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";
import { headerRows } from "./header.js";
import { activityRows, activityWants, type FleetRowVm } from "./activity.js";
import { inputRows, permissionRows, statusRow, todoRow, toolbarRow, type TodoVm } from "./bottom.js";
import { paletteRows, paletteWants, type PaletteItem } from "./palette.js";

const h = React.createElement;

/** Map the engine's rich tones down to the transcript row model. */
export function mapTone(tone: string): LogLine["tone"] {
  switch (tone) {
    case "user": return "user";
    case "tool": return "tool";
    case "error": return "error";
    case "notice":
    case "verify": return "notice";
    case "muted":
    case "diff-meta":
    case "diff-file": return "muted";
    default: return "assistant";
  }
}

export interface ChatMainProps {
  theme: Theme;
  glyphs: GlyphSet;
  columns: number;
  rows: number;
  bleed?: boolean;
  snapshot: { model: string; workspace: string; mode?: string };
  git?: { branch?: string; dirty?: boolean };
  /** Either raw lines (flattened here) or pre-flattened rows (host memoizes). */
  lines?: LogLine[];
  flat?: Row[];
  stats: { msgs: number; tokens?: number; ttft?: number; turnElapsed?: number; tools?: number; agents?: number; errors?: number };
  busy: boolean;
  tick: number;
  cursorOn?: boolean;
  input: string;
  search?: { query: string; match?: string };
  thinking?: boolean;
  thinkingTokens?: number;
  currentTool?: string;
  inFlight?: number;
  fleet?: { summary: string; rows: FleetRowVm[] };
  /** Rows scrolled up from the bottom. */
  scrolled?: number;
  todos?: TodoVm[];
  palette?: { items: PaletteItem[]; selected: number; query: string };
  perm?: { toolName: string; reason: string; suggestion?: string };
  version: string;
}

export interface ChatFrame {
  rows: Row[];
  layout: Layout;
  /** Largest valid `scrolled` for this content. */
  maxScroll: number;
}

export function chatMainRows(p: ChatMainProps): ChatFrame {
  const { theme: t, glyphs: g } = p;
  const activityWanted = activityWants({ theme: t, glyphs: g, tick: p.tick, thinking: p.busy && p.thinking, currentTool: p.currentTool, inFlight: p.inFlight, fleet: p.fleet });
  const layout = computeLayout({
    columns: p.columns,
    rows: p.rows,
    bleed: p.bleed,
    activityRows: activityWanted,
    hasTodos: (p.todos?.length ?? 0) > 0,
    paletteRows: p.palette ? paletteWants(p.palette.items.length) : 0,
    hasPerm: Boolean(p.perm),
  });
  const width = layout.width;
  if (layout.tooSmall) return { rows: tooSmallRows(p, layout), layout, maxScroll: 0 };

  const rows: Row[] = [];
  rows.push(...headerRows({ theme: t, glyphs: g, model: p.snapshot.model, workspace: p.snapshot.workspace, branch: p.git?.branch, dirty: p.git?.dirty, mode: modeOf(p.snapshot.mode), tokens: p.stats.tokens, busy: p.busy, tick: p.tick, width }));
  rows.push(...fit(activityRows({ theme: t, glyphs: g, tick: p.tick, thinking: p.busy && p.thinking, thinkingTokens: p.thinkingTokens, currentTool: p.currentTool, inFlight: p.inFlight, fleet: p.fleet, width, max: layout.activityRows }), layout.activityRows));

  // ── transcript viewport ──
  const flat = p.flat ?? flattenTranscript(p.lines ?? [], { theme: t, glyphs: g, tick: p.tick, width: width - 2, cursorOn: p.cursorOn });
  const visible = layout.transcriptRows;
  const maxScroll = Math.max(0, flat.length + 1 - visible);
  const scrolled = Math.max(0, Math.min(maxScroll, p.scrolled ?? 0));
  if (flat.length === 0) rows.push(...fit(emptyRows(p, width, visible), visible));
  else {
    // A breath under the hairline, then the rows, each with a one-cell margin.
    const padded: Row[] = [[], ...flat.map((r) => (r.length ? [{ text: " " }, ...r] : r))];
    const end = padded.length - scrolled;
    const start = Math.max(0, end - visible);
    rows.push(...fit(padded.slice(start, end), visible));
  }

  if (layout.todoRows > 0) rows.push(todoRow({ theme: t, glyphs: g, todos: p.todos ?? [], width }));
  if (layout.paletteRows > 0 && p.palette) rows.push(...fit(paletteRows({ theme: t, glyphs: g, ...p.palette, width, max: layout.paletteRows }), layout.paletteRows));
  if (layout.permRows > 0 && p.perm) rows.push(...permissionRows({ theme: t, glyphs: g, ...p.perm, tick: p.tick, width }));
  rows.push(statusRow({ theme: t, glyphs: g, working: p.busy, tick: p.tick, turnElapsed: p.stats.turnElapsed, ttft: p.stats.ttft, msgs: p.stats.msgs, tools: p.stats.tools, agents: p.stats.agents, errors: p.stats.errors, version: p.version, scrolled, width }));
  rows.push(...inputRows({ theme: t, glyphs: g, value: p.input, busy: p.busy, cursorOn: p.cursorOn, search: p.search, width }));
  rows.push(toolbarRow({ theme: t, glyphs: g, width }));

  // Invariant: the frame is exactly layout.height rows. Guard it loudly in dev,
  // quietly in prod (pad/trim) — a wrong count is the whole bug class.
  const want = layoutTotal(layout);
  if (rows.length !== want) {
    while (rows.length < want) rows.splice(rows.length - 5, 0, []);
    while (rows.length > want) rows.splice(rows.length - 6, 1);
  }
  return { rows, layout, maxScroll };
}

function modeOf(mode?: string): "plan" | "bypass" | null {
  return mode === "plan" ? "plan" : mode === "bypass" ? "bypass" : null;
}

/** Pad (with blank rows) or trim a block to exactly `n` rows. */
function fit(block: Row[], n: number): Row[] {
  const out = block.slice(0, n);
  while (out.length < n) out.push([]);
  return out;
}

function emptyRows(p: ChatMainProps, width: number, n: number): Row[] {
  const { theme: t, glyphs: g } = p;
  if (n < 4) return [[{ text: "  Ready. What are we building?", color: t.faint }]];
  const pad = Math.max(0, Math.floor((n - 4) / 2));
  const rows: Row[] = [];
  for (let i = 0; i < pad; i++) rows.push([]);
  rows.push([{ text: `  ${g.dot} `, color: t.primary }, { text: "Ready.", color: t.text, bold: true }, { text: " What are we building?", color: t.muted }]);
  rows.push([]);
  rows.push([{ text: "    Type a task and press enter.  ", color: t.faint }, { text: "/", color: t.text }, { text: " for commands.  ", color: t.faint }, { text: "ctrl+p", color: t.text }, { text: " palette.", color: t.faint }]);
  rows.push([{ text: `    Click `, color: t.faint }, { text: "Models", color: t.muted }, { text: " below to switch the brain.", color: t.faint }]);
  void width;
  return rows;
}

function tooSmallRows(p: ChatMainProps, layout: Layout): Row[] {
  const { theme: t } = p;
  const rows: Row[] = [];
  const msg: Span[] = [{ text: " Terminal too small ", color: t.warn, bold: true }];
  const need: Span[] = [{ text: ` need 50×14, have ${p.columns}×${p.rows}`, color: t.muted }];
  const pad = Math.max(0, Math.floor(layout.height / 2) - 1);
  for (let i = 0; i < pad; i++) rows.push([]);
  rows.push(truncateSpans(msg, layout.width, p.glyphs.ellipsis), truncateSpans(need, layout.width, p.glyphs.ellipsis));
  while (rows.length < layout.height) rows.push([]);
  return rows.slice(0, layout.height);
}

export function ChatMain(props: ChatMainProps): React.ReactElement {
  const frame = chatMainRows(props);
  return h(RowsView, { rows: frame.rows, width: frame.layout.width });
}
