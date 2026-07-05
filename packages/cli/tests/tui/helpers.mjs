// Render harness for the slate TUI — renders an Ink element to its terminal
// frame so components are verifiable as text. `strip()` drops ANSI for layout
// assertions; `fg()`/`bg()` build the 24-bit escape a hex color emits, so a
// snapshot can prove a specific color was actually applied.
//
// Colors only appear when chalk thinks the sink supports them — run these tests
// with FORCE_COLOR=3 (see the package test script) so ink emits truecolor.
import "./force-color.mjs"; // MUST be first — sets FORCE_COLOR before ink/chalk load
import { render } from "ink-testing-library";
import React from "react";
import { Text, Box } from "ink";

export const h = React.createElement;
export { Text, Box };

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + "\\[[0-9;]*m", "g");

export function strip(s) {
  return String(s ?? "").replace(ANSI, "");
}

function esc(kind, hex) {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return ESC + "[" + kind + ";2;" + r + ";" + g + ";" + b + "m";
}
export const fg = (hex) => esc("38", hex);
export const bg = (hex) => esc("48", hex);

export function frame(el) {
  const { lastFrame } = render(el);
  return lastFrame() ?? "";
}
export function lines(el) {
  return strip(frame(el)).split("\n");
}
