// The TUI's face: macOS system colors on the terminal's own background.
//
// Three rules that came out of the cross-platform breakage:
//   1. NO painted backgrounds. The old face filled every cell with near-black
//      hex — on 256-color terminals (macOS Terminal.app, most Linux defaults)
//      those collapsed into blotchy gray bands; on light terminals it was a
//      dark slab. The terminal owns its background; we only tint text.
//   2. Every role has a 16-color twin. When the sink can't do truecolor the
//      palette degrades to named ANSI colors on purpose instead of letting
//      chalk quantize hex into mud.
//   3. Vibrant accents, neutral text — Apple's system palette: blue for the
//      primary action, green/orange/red for state, purple + teal for agents
//      and secondary emphasis. Text steps are the macOS label hierarchy.

import { termCaps, type ColorLevel } from "./term.js";

export interface SlateTheme {
  /** Retained for the launcher's bordered panels; never painted full-screen. */
  bg: string;
  surface: string;
  surfaceAlt: string;
  line: string;
  faint: string;
  muted: string;
  text: string;
  primary: string;
  primaryDim: string;
  secondary: string;
  active: string;
  success: string;
  danger: string;
  warn: string;
  accentText: string;
  /** macOS extras: purple (agents), teal (secondary highlights), pink. */
  purple: string;
  teal: string;
  pink: string;
}
export type Theme = SlateTheme;

/** Truecolor tier — Apple system colors (dark appearance). */
export const AQUA: Theme = {
  bg: "#1c1c1e",
  surface: "#2c2c2e",
  surfaceAlt: "#3a3a3c",
  line: "#48484a",
  faint: "#636366",
  muted: "#98989d",
  text: "#e5e5ea",
  primary: "#0a84ff",
  primaryDim: "#0060df",
  secondary: "#5ac8fa",
  active: "#ff9f0a",
  success: "#30d158",
  danger: "#ff453a",
  warn: "#ffd60a",
  accentText: "#ffffff",
  purple: "#bf5af2",
  teal: "#64d2ff",
  pink: "#ff375f",
};

/** 16-color tier — named ANSI, so the theme survives any terminal. */
export const AQUA_ANSI: Theme = {
  bg: "black",
  surface: "black",
  surfaceAlt: "gray",
  line: "gray",
  faint: "gray",
  muted: "white",
  text: "whiteBright",
  primary: "blueBright",
  primaryDim: "blue",
  secondary: "cyanBright",
  active: "yellowBright",
  success: "greenBright",
  danger: "redBright",
  warn: "yellow",
  accentText: "whiteBright",
  purple: "magentaBright",
  teal: "cyan",
  pink: "magenta",
};

export function themeFor(level: ColorLevel = termCaps().colorLevel): Theme {
  return level >= 2 ? AQUA : AQUA_ANSI;
}

/** The live theme for this process (probed once). */
export const SLATE: Theme = themeFor();

// Wordmark gradient — blue → teal → mint, the macOS "vibrant" sweep.
export const LOGO_GRADIENT = ["#0a84ff", "#5ac8fa", "#64d2ff", "#30d158", "#5ac8fa"];

/** Pick a gradient stop for row `i` of `rows` total (nearest-stop mapping). */
export function gradientAt(i: number, rows: number): string {
  if (rows <= 1) return LOGO_GRADIENT[0];
  const idx = Math.round((i / (rows - 1)) * (LOGO_GRADIENT.length - 1));
  return LOGO_GRADIENT[Math.max(0, Math.min(LOGO_GRADIENT.length - 1, idx))];
}
