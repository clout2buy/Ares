// Rows, not boxes.
//
// The old transcript handed Ink a tree of wrapping <Text> nodes and counted
// MESSAGES to decide what fit. One long markdown reply was one "line" that
// rendered forty rows; the frame overflowed, Yoga clipped at random, and the
// header/input/toolbar vanished. That was the break on every OS.
//
// This module turns transcript entries into a flat list of pre-wrapped,
// exact-width rows (styled spans, no nesting). The viewport is then a slice of
// exactly N rows; height is arithmetic, not layout. Everything here is pure and
// width-aware, so the harness can pin it at any terminal size.

import { textWidth } from "../tuiChrome.js";
import { renderMarkdown, type MdTheme } from "../mdRender.js";
import type { Theme } from "./theme.js";
import type { GlyphSet } from "./term.js";

export interface Span {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  inverse?: boolean;
  underline?: boolean;
}
export type Row = Span[];

export function spanWidth(spans: readonly Span[]): number {
  let w = 0;
  for (const s of spans) w += textWidth(s.text);
  return w;
}

/** Cut a string to at most `max` cells, ellipsized. */
export function cut(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (textWidth(text) <= max) return text;
  const ew = textWidth(ellipsis);
  if (max <= ew) return ellipsis.slice(0, max);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = textWidth(ch);
    if (w + cw > max - ew) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** Truncate a span run to `width` cells (ellipsis on the last kept span). */
export function truncateSpans(spans: readonly Span[], width: number, ellipsis = "…"): Row {
  if (spanWidth(spans) <= width) return [...spans];
  const out: Span[] = [];
  let used = 0;
  for (const s of spans) {
    const w = textWidth(s.text);
    if (used + w <= width - textWidth(ellipsis)) {
      out.push(s);
      used += w;
      continue;
    }
    out.push({ ...s, text: cut(s.text, Math.max(0, width - used), ellipsis) });
    return out;
  }
  return out;
}

/** A right-cluster item: drawn in array order, shed by ascending `prio`
 *  (lowest first) until the cluster fits beside `left` at `width`. */
export interface ShedItem {
  spans: Span[];
  prio: number;
}
export function shed(left: readonly Span[], items: readonly ShedItem[], width: number, sep: Span): Span[] {
  const alive = new Set(items);
  const total = () => {
    let w = 0;
    let n = 0;
    for (const it of items) if (alive.has(it)) { w += spanWidth(it.spans); n++; }
    return w + Math.max(0, n - 1) * textWidth(sep.text);
  };
  while (alive.size > 0 && spanWidth(left) + 2 + total() > width) {
    let victim: ShedItem | null = null;
    for (const it of items) if (alive.has(it) && (!victim || it.prio < victim.prio)) victim = it;
    if (!victim) break;
    alive.delete(victim);
  }
  const out: Span[] = [];
  for (const it of items) {
    if (!alive.has(it)) continue;
    if (out.length > 0) out.push(sep);
    out.push(...it.spans);
  }
  return out;
}

/** Left + right clusters on one row, gap-filled to `width`. Right wins the
 *  truncation fight (stats stay visible; the left label gets ellipsized). */
export function justify(left: readonly Span[], right: readonly Span[], width: number, ellipsis = "…"): Row {
  const rw = spanWidth(right);
  const r = rw > width ? truncateSpans(right, width, ellipsis) : [...right];
  const room = Math.max(0, width - spanWidth(r));
  const l = truncateSpans(left, room, ellipsis);
  const gap = Math.max(0, width - spanWidth(l) - spanWidth(r));
  return [...l, { text: " ".repeat(gap) }, ...r];
}

/** Pad a row with spaces to exactly `width` cells (trailing). */
export function padRow(row: Row, width: number): Row {
  const w = spanWidth(row);
  if (w >= width) return row;
  return [...row, { text: " ".repeat(width - w) }];
}

/**
 * Word-wrap a span run into rows no wider than `width`. Continuation rows are
 * prefixed with `indent` (a plain-span string). Long words hard-break. Colors
 * and styles survive across the break. Never returns zero rows.
 */
export function wrapSpans(spans: readonly Span[], width: number, indent = ""): Row[] {
  const indentW = textWidth(indent);
  const firstW = Math.max(1, width);
  const restW = Math.max(1, width - indentW);
  const rows: Row[] = [];
  let cur: Span[] = [];
  let curW = 0;
  let limit = firstW;

  let indentSpan: Span | null = null;
  const flush = () => {
    rows.push(cur);
    indentSpan = indentW > 0 ? { text: indent } : null;
    cur = indentSpan ? [indentSpan] : [];
    curW = 0;
    limit = restW;
  };
  const push = (text: string, style: Span) => {
    if (!text) return;
    const last = cur[cur.length - 1];
    if (last && last !== indentSpan && sameStyle(last, style)) last.text += text;
    else cur.push({ ...style, text });
    curW += textWidth(text);
  };

  for (const s of spans) {
    // Tokenize into words and whitespace runs so breaks land on spaces.
    const tokens = s.text.match(/\s+|\S+/g) ?? [];
    for (const tok of tokens) {
      const tw = textWidth(tok);
      const isSpace = /^\s+$/.test(tok);
      if (curW + tw <= limit) {
        push(tok, s);
        continue;
      }
      if (isSpace) {
        // Whitespace at the edge: break here, drop the run.
        flush();
        continue;
      }
      if (curW > 0) flush();
      if (tw <= limit) {
        push(tok, s);
        continue;
      }
      // Hard-break an oversized word.
      let piece = "";
      let pw = 0;
      for (const ch of tok) {
        const cw = textWidth(ch);
        if (pw + cw > limit) {
          push(piece, s);
          flush();
          piece = "";
          pw = 0;
        }
        piece += ch;
        pw += cw;
      }
      push(piece, s);
    }
  }
  rows.push(cur);
  // Trim trailing whitespace so padding math stays honest (a break landed on
  // a space run; the row must not carry it).
  return rows.map((r) => {
    const floor = indentW > 0 && r[0] === indentSpanOf(r, indent) ? 1 : 0;
    while (r.length > floor && r[r.length - 1].text.trim() === "") r.pop();
    if (r.length > floor) {
      const last = r[r.length - 1];
      last.text = last.text.replace(/\s+$/, "");
    }
    return r;
  });
}

function indentSpanOf(row: Row, indent: string): Span | undefined {
  const first = row[0];
  return first && first.text === indent && first.color === undefined && !first.bold ? first : undefined;
}

function sameStyle(a: Span, b: Span): boolean {
  return a.color === b.color && !!a.bold === !!b.bold && !!a.dim === !!b.dim && !!a.italic === !!b.italic && !!a.inverse === !!b.inverse && !!a.underline === !!b.underline;
}

// ── Transcript model ─────────────────────────────────────────────────────────

export type LogTone = "user" | "assistant" | "tool" | "notice" | "error" | "muted";

export interface LogLine {
  tone: LogTone;
  text: string;
  /** tool rows: the tool name. */
  name?: string;
  /** tool rows: what it was asked to do (path, command, query). */
  desc?: string;
  ok?: boolean;
  elapsed?: string;
  running?: boolean;
  /** tool rows: dim output-preview lines under the settled card. */
  preview?: string[];
  /** assistant rows: the live streaming draft (renders a cursor). */
  stream?: boolean;
  /** assistant rows: render the text as markdown. */
  md?: boolean;
  /** tool rows: +adds/−dels for edit-shaped tools. */
  adds?: number;
  dels?: number;
}

export interface FlattenOpts {
  theme: Theme;
  glyphs: GlyphSet;
  tick: number;
  width: number;
  /** Show the stream cursor (blink phase). */
  cursorOn?: boolean;
}

export function mdThemeFrom(theme: Theme): MdTheme {
  return {
    text: theme.text,
    dim: theme.muted,
    accent: theme.primary,
    accent2: theme.teal,
    accent3: theme.active,
    success: theme.success,
    warn: theme.warn,
    error: theme.danger,
  };
}

const IND = "  ";

/** A whole transcript → flat rows. Pure. */
export function flattenTranscript(lines: readonly LogLine[], opts: FlattenOpts): Row[] {
  const rows: Row[] = [];
  // Collapse consecutive IDENTICAL error rows into one with a ×N count.
  const folded: Array<{ line: LogLine; count: number }> = [];
  for (const line of lines) {
    const prev = folded[folded.length - 1];
    if (prev && line.tone === "error" && prev.line.tone === "error" && prev.line.text === line.text) {
      prev.count++;
      continue;
    }
    folded.push({ line, count: 1 });
  }
  let prevTone: LogTone | null = null;
  for (const { line, count } of folded) {
    // Rhythm: a breath before each user turn, and before the first assistant
    // row after a tool run.
    if (rows.length > 0 && (line.tone === "user" || (line.tone === "assistant" && prevTone === "tool"))) rows.push([]);
    rows.push(...flattenLine(line, count, opts));
    prevTone = line.tone;
  }
  return rows;
}

export function flattenLine(line: LogLine, count: number, opts: FlattenOpts): Row[] {
  const { theme: t, glyphs: g, width, tick } = opts;
  switch (line.tone) {
    case "user": {
      const lead: Span = { text: `${g.prompt} `, color: t.primary, bold: true };
      return wrapSpans([lead, { text: line.text, color: t.text, bold: true }], width, IND);
    }
    case "tool":
      return toolRows(line, opts);
    case "notice":
      return wrapSpans([{ text: IND }, { text: `${g.dot} `, color: t.teal }, { text: line.text, color: t.teal }], width, IND + IND);
    case "error": {
      const spans: Span[] = [{ text: IND }, { text: `${g.cross} `, color: t.danger, bold: true }, { text: line.text, color: t.danger }];
      if (count > 1) spans.push({ text: `  ${g.times}${count}`, color: t.muted, bold: true });
      return wrapSpans(spans, width, IND + IND);
    }
    case "muted":
      return wrapSpans([{ text: IND }, { text: line.text, color: t.faint }], width, IND);
    case "assistant":
    default:
      return assistantRows(line, opts);
  }
}

function assistantRows(line: LogLine, opts: FlattenOpts): Row[] {
  const { theme: t, glyphs: g, width } = opts;
  const cursor: Span | null = line.stream && opts.cursorOn !== false ? { text: g.cursor, color: t.primary } : null;
  const gutter: Span = { text: `${g.dot} `, color: t.secondary };
  if (!line.md) {
    const rows = wrapSpans([gutter, { text: line.text, color: t.text }], width, IND);
    if (cursor) rows[rows.length - 1].push(cursor);
    return rows;
  }
  const md = renderMarkdown(line.text, mdThemeFrom(t));
  const out: Row[] = [];
  let first = true;
  for (const ml of md) {
    if (ml.spans.length === 0) {
      out.push(first ? [gutter] : []);
      first = false;
      continue;
    }
    const spans: Span[] = ml.spans.map((s) => ({ text: s.text, color: s.color ?? t.text, bold: s.bold, italic: s.italic, dim: s.dim }));
    if (ml.kind === "code" || ml.kind === "code-fence") {
      // Code never wraps mid-token: one row, truncated, on a vbar rail.
      const rail: Span = { text: `${first ? g.dot : " "} ${g.vbar} `, color: first ? t.secondary : t.line };
      out.push(truncateSpans([rail, ...spans.map((s) => ({ ...s, color: s.color ?? t.text }))], width, g.ellipsis));
      first = false;
      continue;
    }
    const lead: Span = first ? gutter : { text: IND };
    out.push(...wrapSpans([lead, ...spans], width, IND));
    first = false;
  }
  if (out.length === 0) out.push([gutter]);
  if (cursor) {
    const last = out[out.length - 1];
    if (last.length === 0) last.push({ text: IND });
    last.push(cursor);
  }
  return out;
}

function toolRows(line: LogLine, opts: FlattenOpts): Row[] {
  const { theme: t, glyphs: g, width, tick } = opts;
  const name = line.name ?? "tool";
  void tick;
  const rows: Row[] = [];
  if (line.running) {
    const spin = g.spinner[Math.floor(tick / 2) % g.spinner.length];
    const head: Span[] = [
      { text: IND },
      { text: `${spin} `, color: t.active, bold: true },
      { text: name, color: t.text, bold: true },
      { text: "  " },
      { text: line.desc ?? line.text, color: t.muted },
    ];
    if (line.elapsed) head.push({ text: `  ${line.elapsed}`, color: t.active });
    rows.push(truncateSpans(head, width, g.ellipsis));
    return rows;
  }
  const failed = line.ok === false;
  const head: Span[] = [
    { text: IND },
    { text: `${g.dot} `, color: failed ? t.danger : t.success },
    { text: name, color: t.text, bold: true },
  ];
  if (line.desc) head.push({ text: "  " }, { text: line.desc, color: t.muted });
  if (line.adds != null || line.dels != null) {
    head.push({ text: "  " });
    if (line.adds) head.push({ text: `+${line.adds}`, color: t.success });
    if (line.adds && line.dels) head.push({ text: " " });
    if (line.dels) head.push({ text: `−${line.dels}`, color: t.danger });
  }
  if (line.elapsed) head.push({ text: `  ${line.elapsed}`, color: t.faint });
  rows.push(truncateSpans(head, width, g.ellipsis));
  // The result hangs off the card on an elbow — first line is the headline.
  const body: string[] = [];
  if (line.text && line.text.trim()) body.push(line.text.trim());
  if (line.preview) body.push(...line.preview);
  body.slice(0, 6).forEach((p, i) => {
    rows.push(
      truncateSpans(
        [
          { text: `${IND}  ${i === 0 ? g.elbow : " "} `, color: t.line },
          { text: p, color: failed && i === 0 ? t.danger : i === 0 ? t.muted : t.faint },
        ],
        width,
        g.ellipsis,
      ),
    );
  });
  return rows;
}
