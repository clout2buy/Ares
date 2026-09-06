// TUI themes — the faces the chat screen and launcher can wear.
//
// Each theme ships a truecolor palette AND a 16-color twin, so switching
// themes works on every terminal tier (the tier is chosen once by term.ts).
// Themes re-tint the whole TUI live and persist in ~/.ares settings under
// `tuiTheme`. They are separate from `/theme`, which only colors the plain
// (non-TUI) terminal printing.

import { AQUA, AQUA_ANSI, type Theme } from "./theme.js";
import { type ColorLevel } from "./term.js";

export interface TuiTheme {
  id: string;
  label: string;
  tagline: string;
  truecolor: Theme;
  ansi: Theme;
}

const base = (over: Partial<Theme>): Theme => ({ ...AQUA, ...over });
const baseAnsi = (over: Partial<Theme>): Theme => ({ ...AQUA_ANSI, ...over });

export const TUI_THEMES: readonly TuiTheme[] = [
  {
    id: "midnight",
    label: "Midnight",
    tagline: "macOS dark — system blue on graphite",
    truecolor: AQUA,
    ansi: AQUA_ANSI,
  },
  {
    id: "graphite",
    label: "Graphite",
    tagline: "monochrome with one amber accent",
    truecolor: base({ primary: "#f5f5f7", primaryDim: "#c7c7cc", secondary: "#aeaeb2", teal: "#aeaeb2", purple: "#c7c7cc", active: "#ff9f0a", success: "#e5e5ea", pink: "#e5e5ea" }),
    ansi: baseAnsi({ primary: "whiteBright", primaryDim: "white", secondary: "white", teal: "white", purple: "white", active: "yellowBright", success: "whiteBright", pink: "white" }),
  },
  {
    id: "daylight",
    label: "Daylight",
    tagline: "for light terminals — ink on paper",
    truecolor: base({
      bg: "#ffffff", surface: "#f5f5f7", surfaceAlt: "#e5e5ea", line: "#d2d2d7", faint: "#aeaeb2", muted: "#6e6e73", text: "#1d1d1f",
      primary: "#007aff", primaryDim: "#0060df", secondary: "#5856d6", active: "#ff9500", success: "#34c759", danger: "#ff3b30", warn: "#d9a100",
      accentText: "#ffffff", purple: "#af52de", teal: "#32ade6", pink: "#ff2d55",
    }),
    ansi: baseAnsi({ bg: "white", surface: "white", surfaceAlt: "gray", line: "gray", faint: "gray", muted: "black", text: "black", primary: "blue", primaryDim: "blue", secondary: "magenta", active: "yellow", success: "green", danger: "red", warn: "yellow", accentText: "white", purple: "magenta", teal: "cyan", pink: "red" }),
  },
  {
    id: "ocean",
    label: "Ocean",
    tagline: "cyan and indigo",
    truecolor: base({ primary: "#64d2ff", primaryDim: "#32ade6", secondary: "#5e5ce6", teal: "#40c8e0", purple: "#7d7aff", active: "#ffd60a" }),
    ansi: baseAnsi({ primary: "cyanBright", primaryDim: "cyan", secondary: "blueBright", teal: "cyan", purple: "blueBright", active: "yellowBright" }),
  },
  {
    id: "rose",
    label: "Rose",
    tagline: "pink and violet",
    truecolor: base({ primary: "#ff375f", primaryDim: "#d70040", secondary: "#bf5af2", teal: "#ff6482", purple: "#da8fff", active: "#ff9f0a", success: "#30d158" }),
    ansi: baseAnsi({ primary: "redBright", primaryDim: "red", secondary: "magentaBright", teal: "redBright", purple: "magentaBright", active: "yellowBright" }),
  },
  {
    id: "forest",
    label: "Forest",
    tagline: "green and gold",
    truecolor: base({ primary: "#30d158", primaryDim: "#248a3d", secondary: "#66d4cf", teal: "#66d4cf", purple: "#ac8e68", active: "#ffd60a", success: "#30d158" }),
    ansi: baseAnsi({ primary: "greenBright", primaryDim: "green", secondary: "cyan", teal: "cyan", purple: "yellow", active: "yellowBright" }),
  },
];

export const DEFAULT_TUI_THEME = "midnight";

export function tuiTheme(id: string | undefined): TuiTheme {
  return TUI_THEMES.find((t) => t.id === id) ?? TUI_THEMES[0];
}

/** The palette for a theme id at a color tier. */
export function resolveTheme(id: string | undefined, level: ColorLevel): Theme {
  const t = tuiTheme(id);
  return level >= 2 ? t.truecolor : t.ansi;
}

export function isTuiTheme(id: string): boolean {
  return TUI_THEMES.some((t) => t.id === id);
}
