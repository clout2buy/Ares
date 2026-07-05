// Slate primitives — the small, composable pieces every screen is built from.
// Pure presentation: props in, Ink elements out. No state, no side effects, so
// each renders deterministically in the harness.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "./theme.js";
import { spinnerFrame, pulse } from "./useTick.js";

const h = React.createElement;
type El = React.ReactElement;

/** A rounded panel. Border tints `primary` when focused, else `line`. */
export function Panel(props: {
  theme: SlateTheme;
  focused?: boolean;
  flexDirection?: "row" | "column";
  children?: React.ReactNode;
  width?: number;
  paddingX?: number;
}): El {
  const { theme, focused, children, flexDirection = "column", width, paddingX = 1 } = props;
  return h(
    Box,
    { borderStyle: "round", borderColor: focused ? theme.primary : theme.line, flexDirection, paddingX, width },
    children as React.ReactNode,
  );
}

/** A horizontal rule in the `line` color. */
export function Rule(props: { theme: SlateTheme; width: number; color?: string }): El {
  const { theme, width, color } = props;
  return h(Text, { color: color ?? theme.line }, "─".repeat(Math.max(0, width)));
}

/** The single accent spine (▌) — marks an active surface. */
export function Spine(props: { theme: SlateTheme; color?: string }): El {
  return h(Text, { color: props.color ?? props.theme.primary }, "▌");
}

/** Braille spinner, phase driven by the caller's tick. */
export function Spinner(props: { theme: SlateTheme; tick: number; color?: string }): El {
  return h(Text, { color: props.color ?? props.theme.active }, spinnerFrame(props.tick));
}

/** A section title tab: ╴ title ╶ */
export function TitleTab(props: { title: string; color: string; theme: SlateTheme }): El {
  return h(
    Text,
    null,
    h(Text, { color: props.theme.line }, "╴ "),
    h(Text, { color: props.color, bold: true }, props.title),
    h(Text, { color: props.theme.line }, " ╶"),
  );
}

/** A dim hint framed in brackets: ─╴ text ╶─ */
export function HintBar(props: { text: string; theme: SlateTheme }): El {
  return h(
    Text,
    null,
    h(Text, { color: props.theme.line }, "─╴ "),
    h(Text, { color: props.theme.faint }, props.text),
    h(Text, { color: props.theme.line }, " ╶─"),
  );
}

/** A full-width list row with a selection band + ▸ indicator. */
export function SelectRow(props: {
  theme: SlateTheme;
  label: string;
  hint?: string;
  selected?: boolean;
  width: number;
}): El {
  const { theme, label, hint, selected, width } = props;
  return h(
    Box,
    { width, backgroundColor: selected ? theme.surfaceAlt : undefined },
    h(Text, { color: selected ? theme.primary : theme.faint }, selected ? "▸ " : "  "),
    h(Text, { color: selected ? theme.text : theme.muted, bold: selected }, label),
    hint ? h(Box, { flexGrow: 1 }) : null,
    hint ? h(Text, { color: theme.faint }, hint) : null,
  );
}

/** A provider card for the selection grid. Border pulses primary⇄secondary when
 *  selected; idle cards show a quiet `line` border. */
export function GridCard(props: {
  theme: SlateTheme;
  icon: string;
  title: string;
  body: string;
  status: { text: string; color: string };
  selected?: boolean;
  tick: number;
  width: number;
}): El {
  const { theme, icon, title, body, status, selected, tick, width } = props;
  const border = selected ? (pulse(tick) ? theme.primary : theme.secondary) : theme.line;
  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: border,
      backgroundColor: selected ? theme.surface : undefined,
      flexDirection: "column",
      width,
      paddingX: 1,
    },
    h(
      Text,
      null,
      h(Text, { color: selected ? theme.primary : theme.muted }, `${icon} `),
      h(Text, { color: selected ? theme.text : theme.muted, bold: selected }, title),
    ),
    h(Text, { color: theme.faint, wrap: "truncate" }, body),
    h(Text, { color: status.color }, status.text),
  );
}
