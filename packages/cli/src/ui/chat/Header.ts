// Main-UI header — 3 rows. Consumes fields off InkChatSnapshot + RuntimeStats
// (passed in as props; the cutover maps them).

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "../theme.js";

const h = React.createElement;

export function Header(props: {
  theme: SlateTheme;
  model: string;
  tokens?: number;
  workspace: string;
  branch?: string;
  dirty?: boolean;
  mode?: "plan" | "bypass" | null;
  width: number;
}): React.ReactElement {
  const { theme, model, tokens, workspace, branch, dirty, mode, width } = props;
  return h(
    Box,
    { flexDirection: "column", backgroundColor: theme.surface, width },
    // Row 1 — wordmark · model · tokens
    h(
      Box,
      { width },
      h(Text, { color: theme.primary, bold: true }, " ARES "),
      h(Text, { color: theme.active }, ` ${model} `),
      h(Box, { flexGrow: 1 }),
      tokens && tokens > 0 ? h(Text, { color: theme.muted }, `${tokens.toLocaleString()} tokens `) : null,
    ),
    // Row 2 — workspace · git branch · mode pill
    h(
      Box,
      { width },
      h(Text, { color: theme.muted, wrap: "truncate-start" }, ` ${workspace} `),
      h(Box, { flexGrow: 1 }),
      mode ? h(Text, { color: mode === "bypass" ? theme.danger : theme.warn, bold: true }, ` [${mode.toUpperCase()}] `) : null,
      branch ? h(Text, { color: dirty ? theme.active : theme.success }, `  ${branch}${dirty ? " ●" : ""} `) : null,
    ),
    // Row 3 — rule
    h(Text, { color: theme.line }, "─".repeat(Math.max(0, width))),
  );
}
