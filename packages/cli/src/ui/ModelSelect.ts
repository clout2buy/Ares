// Model picker — a centered list modal with a search filter and a windowed,
// selection-centered list. Pure presentation; the launcher/TUI owns filtering
// state + input and passes the already-filtered models + selected index.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "./theme.js";
import { Panel, SelectRow, TitleTab } from "./primitives.js";
import { cursorOn } from "./useTick.js";

const h = React.createElement;

export interface ModelRow {
  id: string;
  label?: string;
  hint?: string;
}

const MAX_VISIBLE = 12;
const MODAL_W = 54;

/** Selection-centered window: which slice of rows to show. */
export function modelWindow(count: number, selected: number, max = MAX_VISIBLE): { start: number; end: number } {
  if (count <= max) return { start: 0, end: count };
  let start = selected - Math.floor(max / 2);
  start = Math.max(0, Math.min(start, count - max));
  return { start, end: start + max };
}

function displayName(m: ModelRow): string {
  return m.label ?? (m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id);
}

export function ModelSelect(props: {
  theme: SlateTheme;
  title: string;
  models: ModelRow[];
  selectedIndex: number;
  query: string;
  tick: number;
  maxVisible?: number;
}): React.ReactElement {
  const { theme, title, models, selectedIndex, query, tick, maxVisible = MAX_VISIBLE } = props;
  const inner = MODAL_W - 4;
  const win = modelWindow(models.length, selectedIndex, maxVisible);
  const shown = models.slice(win.start, win.end);

  return h(
    Panel,
    { theme, focused: true, width: MODAL_W },
    h(TitleTab, { title, color: theme.primary, theme }),
    // search line
    h(
      Text,
      null,
      h(Text, { color: theme.faint }, "  › "),
      h(Text, { color: theme.text }, query),
      h(Text, { color: theme.primary }, cursorOn(tick) ? "▏" : " "),
    ),
    win.start > 0 ? h(Text, { color: theme.faint }, "  ▲ more above") : h(Box, { height: 1 }),
    ...shown.map((m, i) => {
      const idx = win.start + i;
      return h(SelectRow, {
        key: m.id,
        theme,
        label: displayName(m),
        hint: m.hint,
        selected: idx === selectedIndex,
        width: inner,
      });
    }),
    win.end < models.length ? h(Text, { color: theme.faint }, "  ▼ more below") : h(Box, { height: 1 }),
    models.length === 0 ? h(Text, { color: theme.faint }, "  no models match") : null,
  );
}
