// The bottom cluster — status row, the composer, the toolbar — plus the todo
// strip and the permission card that sit above it. All fixed-height row
// builders; geometry contracts with tuiChrome are spelled out per builder.

import type { Row, Span } from "../rows.js";
import { justify, truncateSpans, cut, spanWidth, shed } from "../rows.js";
import type { Theme } from "../theme.js";
import type { GlyphSet } from "../term.js";
import { CHROME_SEPARATOR, PERM_BUTTONS, PERM_BUTTON_GAP, TOOLBAR_ITEMS, textWidth } from "../../tuiChrome.js";

// ── status ───────────────────────────────────────────────────────────────────

export interface StatusProps {
  theme: Theme;
  glyphs: GlyphSet;
  working: boolean;
  tick: number;
  turnElapsed?: number;
  ttft?: number;
  msgs: number;
  tools?: number;
  agents?: number;
  errors?: number;
  version: string;
  /** >0 = the user scrolled up N rows. */
  scrolled?: number;
  width: number;
}

export function statusRow(p: StatusProps): Row {
  const { theme: t, glyphs: g, width } = p;
  const sep: Span = { text: `  ${g.vbar}  `, color: t.line };
  const left: Span[] = [];
  // Quiet by default: one state word. Hints live on the toolbar row.
  if (p.working) {
    const spin = g.spinner[Math.floor(p.tick / 2) % g.spinner.length];
    left.push({ text: ` ${spin} Working`, color: t.active, bold: true });
    if (p.turnElapsed != null && p.turnElapsed >= 1) left.push({ text: `  ${Math.floor(p.turnElapsed)}s`, color: t.muted });
    left.push({ text: "   type to steer", color: t.faint });
  } else {
    left.push({ text: ` ${g.dot} Ready`, color: t.success, bold: true });
  }
  if (p.scrolled && p.scrolled > 0) {
    left.push(sep, { text: `${g.downArrow} ${p.scrolled} newer`, color: t.primary }, { text: "  end", color: t.text }, { text: " jumps back", color: t.muted });
  }
  // Right cluster — drawn left→right, shed lowest-priority-first when narrow.
  const right = shed(
    left,
    [
      { spans: p.version ? [{ text: `v${p.version}`, color: t.faint }] : [], prio: 0 },
      { spans: p.ttft != null ? [{ text: `${p.ttft.toFixed(1)}s ttft`, color: t.faint }] : [], prio: 1 },
      { spans: [{ text: `${p.msgs} msgs`, color: t.muted }], prio: 5 },
      { spans: p.tools && p.tools > 0 ? [{ text: `${p.tools} tools`, color: t.muted }] : [], prio: 3 },
      { spans: p.agents && p.agents > 0 ? [{ text: `${p.agents} agents`, color: t.purple }] : [], prio: 2 },
      { spans: p.errors && p.errors > 0 ? [{ text: `${p.errors} err`, color: t.danger }] : [], prio: 4 },
    ].filter((it) => it.spans.length > 0),
    width - 1,
    sep,
  );
  right.push({ text: " " });
  return justify(left, right, width, g.ellipsis);
}

// ── composer ─────────────────────────────────────────────────────────────────

export interface InputProps {
  theme: Theme;
  glyphs: GlyphSet;
  value: string;
  placeholder?: string;
  busy?: boolean;
  /** Cursor blink phase. */
  cursorOn?: boolean;
  /** Ctrl+R reverse search overlay text (replaces the value while open). */
  search?: { query: string; match?: string };
  width: number;
}

const CORNERS = {
  round: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  classic: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
} as const;

/** Three rows: top border · content · bottom border. */
export function inputRows(p: InputProps): Row[] {
  const { theme: t, glyphs: g, width } = p;
  const c = CORNERS[g.border];
  // Blue ring while you're typing (a focused field); calm hairline otherwise.
  const border = p.busy ? t.line : p.value.length > 0 || p.search ? t.primary : t.faint;
  const inner = Math.max(1, width - 2);
  const top: Row = [{ text: `${c.tl}${c.h.repeat(inner)}${c.tr}`, color: border }];
  const bottom: Row = [{ text: `${c.bl}${c.h.repeat(inner)}${c.br}`, color: border }];
  const content: Span[] = [{ text: `${c.v} `, color: border }];
  const room = inner - 2 - 1; // padding left, cursor cell
  if (p.search) {
    content.push({ text: "search: ", color: t.purple, bold: true });
    content.push({ text: p.search.query, color: t.text });
    content.push({ text: p.cursorOn ? g.cursor : " ", color: t.purple });
    if (p.search.match) content.push({ text: `  ${g.prompt} ${p.search.match}`, color: t.muted });
  } else if (p.value.length > 0) {
    // Multi-line drafts show the LAST line; earlier lines are summarized.
    const lines = p.value.split("\n");
    const lastLine = lines[lines.length - 1];
    const prefix = lines.length > 1 ? `[${lines.length - 1} more lines] ` : "";
    content.push({ text: `${g.prompt} `, color: t.primary, bold: true });
    if (prefix) content.push({ text: prefix, color: t.faint });
    const avail = room - 2 - textWidth(prefix);
    content.push({ text: tailCut(lastLine, avail), color: t.text });
    content.push({ text: p.cursorOn ? g.cursor : " ", color: t.primary });
  } else {
    content.push({ text: `${g.prompt} `, color: p.busy ? t.faint : t.primary, bold: true });
    content.push({ text: p.busy ? "type to steer the running turn" : (p.placeholder ?? "What are we building?"), color: t.faint });
    content.push({ text: p.cursorOn && !p.busy ? g.cursor : " ", color: t.primary });
  }
  const filled = truncateSpans(content, width - 1, g.ellipsis);
  const pad = Math.max(0, width - 1 - spanWidth(filled));
  return [top, [...filled, { text: " ".repeat(pad) }, { text: c.v, color: border }], bottom];
}

/** Keep the END of a line visible (the cursor side). */
function tailCut(text: string, max: number): string {
  if (max <= 0) return "";
  if (textWidth(text) <= max) return text;
  const chars = [...text];
  let out = "";
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = textWidth(chars[i]);
    if (w + cw > max - 1) break;
    out = chars[i] + out;
    w += cw;
  }
  return `…${out}`;
}

// ── toolbar ──────────────────────────────────────────────────────────────────
// Contract (tuiChrome.toolbarButtons): labels start at CHROME_START_COL (2),
// separated by CHROME_SEPARATOR, rendered verbatim — clicks are pure math.

export function toolbarRow(p: { theme: Theme; glyphs: GlyphSet; width: number; active?: string | null }): Row {
  const { theme: t, glyphs: g, width } = p;
  // Same cell width as CHROME_SEPARATOR in every glyph set, so the hit-test math holds.
  const sep = textWidth(g.sep) === textWidth(CHROME_SEPARATOR) ? g.sep : CHROME_SEPARATOR;
  const row: Span[] = [{ text: " " }];
  TOOLBAR_ITEMS.forEach((item, i) => {
    if (i > 0) row.push({ text: sep, color: t.line });
    const on = p.active === item.id;
    row.push({ text: item.label, color: on ? t.primary : item.id === "ultra" ? t.purple : t.muted, bold: on || item.id === "ultra" });
  });
  // Keyboard hints hang off the right edge, dim — out of the way, always there.
  return justify(row, [{ text: "ctrl+p", color: t.muted }, { text: " commands  ", color: t.faint }, { text: "ctrl+o", color: t.muted }, { text: " models ", color: t.faint }], width, g.ellipsis);
}

// ── todo strip ───────────────────────────────────────────────────────────────

export interface TodoVm {
  content: string;
  activeForm?: string;
  status: string;
}

export function todoRow(p: { theme: Theme; glyphs: GlyphSet; todos: TodoVm[]; width: number }): Row {
  const { theme: t, glyphs: g, todos, width } = p;
  const done = todos.filter((x) => x.status === "completed").length;
  const cur = todos.find((x) => x.status === "in_progress") ?? todos.find((x) => x.status === "pending");
  const label = cur ? (cur.status === "in_progress" ? cur.activeForm || cur.content : cur.content) : "all done";
  const all = done === todos.length;
  const track = Math.max(4, Math.min(12, Math.floor(width / 8)));
  const fill = Math.round((done / Math.max(1, todos.length)) * track);
  return truncateSpans(
    [
      { text: " " },
      { text: g.block.repeat(fill), color: all ? t.success : t.primary },
      { text: g.shade.repeat(track - fill), color: t.line },
      { text: ` ${done}/${todos.length}`, color: all ? t.success : t.text, bold: true },
      { text: `  ${g.prompt} `, color: t.line },
      { text: label, color: all ? t.success : t.active },
    ],
    width,
    g.ellipsis,
  );
}

// ── permission card ──────────────────────────────────────────────────────────
// Contract (tuiChrome.permHitTest): 4 rows directly above the status row —
// border · title · buttons · border — so buttons sit on row H-6, and content
// begins at col 3 (border col 1 + one pad).

export interface PermProps {
  theme: Theme;
  glyphs: GlyphSet;
  toolName: string;
  reason: string;
  suggestion?: string;
  tick: number;
  width: number;
}

export function permissionRows(p: PermProps): Row[] {
  const { theme: t, glyphs: g, width } = p;
  const c = CORNERS[g.border];
  const border = Math.floor(p.tick / 5) % 2 === 0 ? t.active : t.warn;
  const inner = Math.max(1, width - 2);
  const line = (spans: Span[]): Row => {
    const body = truncateSpans([{ text: `${c.v} `, color: border }, ...spans], width - 1, g.ellipsis);
    const pad = Math.max(0, width - 1 - spanWidth(body));
    return [...body, { text: " ".repeat(pad) }, { text: c.v, color: border }];
  };
  const colors: Record<string, string> = { allow_once: t.success, allow_always: t.primary, deny: t.danger };
  const buttons: Span[] = [];
  PERM_BUTTONS.forEach((b, i) => {
    if (i > 0) buttons.push({ text: PERM_BUTTON_GAP });
    const suggested = b.id === p.suggestion || (!p.suggestion && b.id === "allow_once");
    buttons.push({ text: b.label, color: colors[b.id] ?? t.text, bold: suggested, underline: suggested });
  });
  return [
    [{ text: `${c.tl}${c.h.repeat(inner)}${c.tr}`, color: border }],
    line([{ text: `${g.warn} `, color: t.warn, bold: true }, { text: p.toolName, color: t.text, bold: true }, { text: `  ${g.vbar}  `, color: t.line }, { text: cut(p.reason, Math.max(0, width - 12 - textWidth(p.toolName)), g.ellipsis), color: t.muted }]),
    line(buttons),
    [{ text: `${c.bl}${c.h.repeat(inner)}${c.br}`, color: border }],
  ];
}
