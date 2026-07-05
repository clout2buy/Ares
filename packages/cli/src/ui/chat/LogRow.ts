// A single transcript row, tone-styled. The rebuild keeps the render shape
// minimal + pure; the cutover feeds it from the engine's LogLine model (and
// wires renderMarkdown for assistant prose).

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "../theme.js";

const h = React.createElement;

export type LogTone = "user" | "assistant" | "tool" | "notice" | "error" | "muted";
export interface LogLine {
  tone: LogTone;
  text: string;
  /** tool rows: the tool name + outcome. */
  name?: string;
  ok?: boolean;
  elapsed?: string;
}

export function LogRow(props: { theme: SlateTheme; line: LogLine; width: number }): React.ReactElement {
  const { theme, line, width } = props;
  switch (line.tone) {
    case "user":
      return h(
        Box,
        { width, backgroundColor: theme.surfaceAlt },
        h(Text, { color: theme.primary }, "▌ "),
        h(Text, { color: theme.text, wrap: "wrap" }, line.text),
      );
    case "tool": {
      const mark = line.ok === false ? "✗" : "✓";
      const color = line.ok === false ? theme.danger : theme.success;
      return h(
        Text,
        { wrap: "truncate-end" },
        h(Text, { color }, `${mark} `),
        h(Text, { color: theme.text }, line.name ?? "tool"),
        h(Text, { color: theme.line }, " │ "),
        h(Text, { color: theme.muted }, line.text),
        line.elapsed ? h(Text, { color: theme.faint }, `  ${line.elapsed}`) : null,
      );
    }
    case "notice":
      return h(Text, { color: theme.secondary, wrap: "wrap" }, line.text);
    case "error":
      return h(Text, { color: theme.danger, wrap: "wrap" }, line.text);
    case "muted":
      return h(Text, { color: theme.muted, wrap: "wrap" }, line.text);
    case "assistant":
    default:
      return h(Text, { color: theme.text, wrap: "wrap" }, line.text);
  }
}

export function Transcript(props: { theme: SlateTheme; lines: LogLine[]; width: number }): React.ReactElement {
  const { theme, lines, width } = props;
  if (lines.length === 0) {
    return h(
      Box,
      { width, flexDirection: "column", paddingX: 1 },
      h(Text, { color: theme.faint }, "Ready. What are we building?"),
    );
  }
  return h(
    Box,
    { width, flexDirection: "column", paddingX: 1 },
    ...lines.map((line, i) => h(LogRow, { key: `l-${i}`, theme, line, width: width - 2 })),
  );
}
