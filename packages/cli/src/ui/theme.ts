// The "slate" TUI identity — the ground-up rebuild's face.
//
// Cool graphite + a single cyan-teal primary: architectural, calm, code-editor
// adjacent. Deliberately ZERO fire-theme DNA — no crimson, ember, molten purple,
// or forge gradients. These semantic role names are canonical for the whole
// rebuilt TUI; every ui/* component reads colors from here, never literals.

export interface SlateTheme {
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
  /** Text drawn ON a primary/selection background (dark-on-teal). */
  accentText: string;
}

export const SLATE: SlateTheme = {
  bg: "#0e1116",
  surface: "#161b22",
  surfaceAlt: "#1c2230",
  line: "#2b3240",
  faint: "#4a5568",
  muted: "#7d8899",
  text: "#d7dde5",
  primary: "#4ec9b0",
  primaryDim: "#3a9a88",
  secondary: "#6ea8fe",
  active: "#e0a458",
  success: "#54c98c",
  danger: "#e5484d",
  warn: "#d9a441",
  accentText: "#0e1116",
};

// The wordmark gradient, top→bottom: cool blue → teal → mint. (The old face's
// tell was purple→crimson→ember; this is deliberately the opposite temperature.)
export const LOGO_GRADIENT = ["#6ea8fe", "#4ec9b0", "#3a9a88", "#54c98c", "#7dd3c0"];

/** Pick a gradient stop for row `i` of `rows` total (nearest-stop mapping). */
export function gradientAt(i: number, rows: number): string {
  if (rows <= 1) return LOGO_GRADIENT[0];
  const idx = Math.round((i / (rows - 1)) * (LOGO_GRADIENT.length - 1));
  return LOGO_GRADIENT[Math.max(0, Math.min(LOGO_GRADIENT.length - 1, idx))];
}
