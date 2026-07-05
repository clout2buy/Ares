// The input deck — a rounded box with the accent spine, the draft text (or a
// placeholder), and a blinking cursor when not thinking. Pure; the TUI owns the
// buffer + key handling.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "../theme.js";
import { cursorOn } from "../useTick.js";

const h = React.createElement;

export function InputDeck(props: {
  theme: SlateTheme;
  value: string;
  placeholder?: string;
  focused?: boolean;
  thinking?: boolean;
  tick: number;
  width: number;
}): React.ReactElement {
  const { theme, value, placeholder = "What are we building?", focused = true, thinking, tick, width } = props;
  const showCursor = !thinking && cursorOn(tick);
  return h(
    Box,
    {
      width,
      borderStyle: "round",
      borderColor: focused ? theme.primary : theme.line,
      backgroundColor: theme.surfaceAlt,
      paddingX: 1,
    },
    h(Text, { color: theme.primary }, "▌ "),
    value.length > 0
      ? h(
          Text,
          { color: theme.text, wrap: "truncate-start" },
          value,
          showCursor ? h(Text, { color: theme.primary }, "▏") : null,
        )
      : h(
          Text,
          null,
          h(Text, { color: theme.faint }, placeholder),
          showCursor ? h(Text, { color: theme.primary }, "▏") : null,
        ),
  );
}
