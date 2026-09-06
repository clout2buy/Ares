// The ONE adapter from pure rows to Ink. Each row is exactly one terminal
// line: truncated to `width`, padded to `width`, never wrapped. Nothing else in
// the chat screen touches Ink layout, so Yoga can't surprise us.

import React from "react";
import { Box, Text } from "ink";
import { padRow, truncateSpans, type Row } from "./rows.js";

const h = React.createElement;

export function RowText(props: { row: Row; width: number }): React.ReactElement {
  const row = padRow(truncateSpans(props.row, props.width), props.width);
  return h(
    Text,
    { wrap: "truncate-end" },
    ...row.map((s, i) =>
      h(
        Text,
        { key: i, color: s.color, bold: s.bold, dimColor: s.dim, italic: s.italic, inverse: s.inverse, underline: s.underline },
        s.text,
      ),
    ),
  );
}

/** A fixed stack of rows — exactly rows.length lines tall. */
export function RowsView(props: { rows: readonly Row[]; width: number }): React.ReactElement {
  return h(
    Box,
    { flexDirection: "column", width: props.width, height: props.rows.length },
    ...props.rows.map((row, i) => h(RowText, { key: i, row, width: props.width })),
  );
}
