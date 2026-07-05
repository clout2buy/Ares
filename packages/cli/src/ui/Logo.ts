// The ARES wordmark. Block-letter art, each row tinted along the cool
// blue→teal→mint gradient. `revealCols` clips it to the first N columns for the
// intro's left-to-right type-on wipe.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "./theme.js";
import { gradientAt } from "./theme.js";

const h = React.createElement;

// ANSI-Shadow "ARES".
const ARES_ART = [
  " █████╗ ██████╗ ███████╗███████╗",
  "██╔══██╗██╔══██╗██╔════╝██╔════╝",
  "███████║██████╔╝█████╗  ███████╗",
  "██╔══██║██╔══██╗██╔══╝  ╚════██║",
  "██║  ██║██║  ██║███████╗███████║",
  "╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝",
];

export const LOGO_WIDTH = Math.max(...ARES_ART.map((r) => r.length));
export const LOGO_ROWS = ARES_ART.length;

export function Logo(props: {
  theme: SlateTheme;
  /** Clip to the first N columns (intro reveal). Omit for the full wordmark. */
  revealCols?: number;
}): React.ReactElement {
  const { revealCols } = props;
  return h(
    Box,
    { flexDirection: "column" },
    ...ARES_ART.map((row, i) => {
      const shown = revealCols === undefined ? row : row.slice(0, Math.max(0, revealCols));
      return h(Text, { key: `logo-${i}`, color: gradientAt(i, LOGO_ROWS), bold: true }, shown);
    }),
  );
}

/** A compact one-line wordmark for headers/nav: ` ARES `. */
export function Wordmark(props: { theme: SlateTheme }): React.ReactElement {
  return h(Text, { color: props.theme.primary, bold: true }, " ARES ");
}
