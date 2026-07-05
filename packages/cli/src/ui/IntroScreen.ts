// The boot cinematic. A pure function of `tick`: the ARES wordmark wipes on
// left-to-right, a rule and tagline fade in, and a blinking skip hint invites a
// click. Deterministic (tick in → frame out), so the harness can assert each
// phase. The launcher owns input and calls onSkip on any key/click.

import React from "react";
import { Box, Text } from "ink";
import type { SlateTheme } from "./theme.js";
import { Logo, LOGO_WIDTH } from "./Logo.js";
import { cursorOn } from "./useTick.js";

const h = React.createElement;

export const INTRO_TOTAL_TICKS = 40; // ≈3.2s at 80ms, then auto-advances
const TAGLINE = "the agent that ships";
const CHARS_PER_TICK = Math.max(Math.ceil(LOGO_WIDTH / 20), 2);

export function introRevealCols(tick: number): number {
  return Math.min(tick * CHARS_PER_TICK, LOGO_WIDTH);
}

export function IntroScreen(props: { theme: SlateTheme; tick: number; width: number; height: number }): React.ReactElement {
  const { theme, tick, width, height } = props;

  // Small-terminal fallback: just the wordmark, centered.
  if (height < 12 || width < 40) {
    return h(
      Box,
      { width, height, justifyContent: "center", alignItems: "center" },
      h(Text, { color: theme.primary, bold: true }, "ARES"),
    );
  }

  const revealCols = introRevealCols(tick);
  const rule = tick > 14 ? "─".repeat(40) : "";
  return h(
    Box,
    { width, height, flexDirection: "column", justifyContent: "center", alignItems: "center" },
    h(Logo, { theme, revealCols }),
    h(Box, { height: 1 }),
    h(Text, { color: theme.line }, rule),
    h(Text, { color: theme.muted }, tick > 18 ? TAGLINE : ""),
    h(Box, { height: 2 }),
    h(Text, { color: theme.faint }, tick > 12 && cursorOn(tick) ? "press any key · click anywhere" : ""),
  );
}
