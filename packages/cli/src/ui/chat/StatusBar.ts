// Main-UI status bar — 1 row, space-between. Left: a mode pill (working spinner
// or ready dot) + contextual hints. Right: latency, message count, agents,
// theme, version.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "../theme.js";
import { spinnerFrame } from "../useTick.js";

const h = React.createElement;

export function StatusBar(props: {
  theme: SlateTheme;
  working: boolean;
  tick: number;
  ttft?: number;
  total?: number;
  msgs: number;
  agents?: number;
  themeName: string;
  version: string;
  width: number;
}): React.ReactElement {
  const { theme, working, tick, ttft, total, msgs, agents, themeName, version, width } = props;
  const sep = h(Text, { color: theme.line }, " │ ");
  return h(
    Box,
    { width, backgroundColor: theme.surface, justifyContent: "space-between" },
    // left — mode pill + hints
    h(
      Box,
      null,
      working
        ? h(Text, { color: theme.active, bold: true }, ` ${spinnerFrame(tick)} working `)
        : h(Text, { color: theme.success }, " ● ready "),
      sep,
      working
        ? h(Text, null, h(Text, { color: theme.text }, "esc "), h(Text, { color: theme.faint }, "cancel"))
        : h(
            Text,
            null,
            h(Text, { color: theme.text }, "ctrl+p "),
            h(Text, { color: theme.faint }, "palette · "),
            h(Text, { color: theme.text }, "click "),
            h(Text, { color: theme.faint }, "toolbar"),
          ),
    ),
    // right — stats
    h(
      Box,
      null,
      ttft !== undefined ? h(Text, { color: theme.muted }, `TTFT:${ttft.toFixed(1)}s`) : null,
      total !== undefined ? h(Text, { color: theme.muted }, ` Total:${total.toFixed(1)}s`) : null,
      sep,
      h(Text, { color: theme.muted }, `${msgs} msgs`),
      agents && agents > 0 ? h(Text, null, sep, h(Text, { color: theme.secondary }, `🤖 ${agents}`)) : null,
      sep,
      h(Text, { color: theme.secondary }, themeName),
      sep,
      h(Text, { color: theme.faint }, `v${version} `),
    ),
  );
}
