// Terminal capability probe + glyph sets.
//
// The TUI used to assume every terminal was Windows Terminal with a Nerd Font:
// 24-bit painted backgrounds, emoji in the chrome, braille spinners. macOS
// Terminal.app has no truecolor, legacy conhost mangles anything past cp437,
// and emoji are double-wide on some terminals and single-wide on others —
// which is exactly what pushed rows past the frame width and broke layout.
//
// This module decides ONCE what the sink can do. Everything visual reads from
// it: the palette picks a color tier, the chrome picks a glyph set. Pure
// function of env + platform, so tests can pin any combination.

export type ColorLevel = 0 | 1 | 2 | 3; // none · 16 · 256 · truecolor

export interface TermCaps {
  colorLevel: ColorLevel;
  /** Box drawing + geometric glyphs render reliably. */
  unicode: boolean;
  /** Windows legacy console (not Windows Terminal / ConEmu / VS Code). */
  legacyConsole: boolean;
}

export interface ProbeEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
}

export function probeTerminal(opts: ProbeEnv = {}): TermCaps {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);

  const term = (env.TERM ?? "").toLowerCase();
  const program = (env.TERM_PROGRAM ?? "").toLowerCase();
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const isWindowsTerminal = Boolean(env.WT_SESSION);
  const isConEmu = Boolean(env.ConEmuANSI);
  const inVsCode = program === "vscode" || Boolean(env.TERM_PROGRAM_VERSION && program.includes("code"));
  const legacyConsole = platform === "win32" && !isWindowsTerminal && !isConEmu && !inVsCode && !program && !env.TERM;

  // ── color ────────────────────────────────────────────────────────────────
  let colorLevel: ColorLevel;
  const forced = env.ARES_TUI_COLOR ?? env.FORCE_COLOR;
  if (env.NO_COLOR) colorLevel = 0;
  else if (forced === "0" || forced === "false") colorLevel = 0;
  else if (forced === "1" || forced === "16") colorLevel = 1;
  else if (forced === "2" || forced === "256") colorLevel = 2;
  else if (forced === "3" || forced === "true" || forced === "truecolor") colorLevel = 3;
  else if (!isTTY) colorLevel = 0;
  else if (colorterm === "truecolor" || colorterm === "24bit") colorLevel = 3;
  else if (isWindowsTerminal || isConEmu || inVsCode) colorLevel = 3;
  else if (program === "iterm.app" || program === "wezterm" || program === "ghostty" || program === "hyper" || program === "alacritty" || program === "kitty")
    colorLevel = 3;
  else if (term.includes("kitty") || term.includes("alacritty") || term.includes("wezterm") || term.includes("ghostty")) colorLevel = 3;
  else if (program === "apple_terminal") colorLevel = 2; // Terminal.app: 256 only, no truecolor
  else if (platform === "win32") colorLevel = 3; // Win10+ conhost speaks VT truecolor
  else if (term.includes("256")) colorLevel = 2;
  else if (term === "linux" || term === "dumb") colorLevel = term === "dumb" ? 0 : 1;
  else if (term) colorLevel = 2;
  else colorLevel = 1;

  // ── glyphs ───────────────────────────────────────────────────────────────
  let unicode: boolean;
  const ascii = env.ARES_TUI_ASCII;
  if (ascii === "1" || ascii === "true") unicode = false;
  else if (ascii === "0" || ascii === "false") unicode = true;
  else if (legacyConsole) unicode = false;
  else if (term === "linux" || term === "dumb") unicode = false;
  else if (platform !== "win32") {
    const lang = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`.toLowerCase();
    unicode = lang === "" ? true : /utf-?8/.test(lang);
  } else unicode = true;

  return { colorLevel, unicode, legacyConsole };
}

let cached: TermCaps | null = null;
/** Process-wide caps, probed once. */
export function termCaps(): TermCaps {
  if (!cached) cached = probeTerminal();
  return cached;
}
/** Test seam. */
export function setTermCapsForTests(caps: TermCaps | null): void {
  cached = caps;
}

// ── Glyph sets ───────────────────────────────────────────────────────────────
// Every glyph the chrome draws, in a unicode flavor and an ASCII twin. Nothing
// here is wider than one cell on any terminal (no emoji, no CJK, no ambiguous
// East-Asian-width symbols) — the whole layout depends on that.

export interface GlyphSet {
  /** Spinner frames (all single-cell). */
  spinner: readonly string[];
  /** Static markers. */
  dot: string; // ● settled / ready
  ring: string; // ○ pending
  half: string; // ◐ in progress (static fallback)
  check: string;
  cross: string;
  warn: string;
  prompt: string; // › the composer prompt / user turn
  caret: string; // ⌄ dropdown affordance
  elbow: string; // ⎿ result hangs off a tool
  branch: string; // ├
  last: string; // └
  vbar: string; // │
  hbar: string; // ─
  bullet: string; // • list bullet
  ellipsis: string;
  cursor: string; // ▏ text cursor
  block: string; // █ progress fill
  shade: string; // ░ progress track
  upArrow: string;
  downArrow: string;
  /** Toolbar / tab separator — MUST be 3 cells wide in every set (hit-tests). */
  sep: string;
  /** Repeat-count marker (×3). */
  times: string;
  border: "round" | "single" | "classic";
}

export const UNICODE_GLYPHS: GlyphSet = {
  spinner: ["◐", "◓", "◑", "◒"],
  dot: "●",
  ring: "○",
  half: "◐",
  check: "✓",
  cross: "✕",
  warn: "!",
  prompt: "›",
  caret: "⌄",
  elbow: "⎿",
  branch: "├",
  last: "└",
  vbar: "│",
  hbar: "─",
  bullet: "•",
  ellipsis: "…",
  cursor: "▏",
  block: "█",
  shade: "░",
  upArrow: "↑",
  downArrow: "↓",
  sep: " · ",
  times: "×",
  border: "round",
};

export const ASCII_GLYPHS: GlyphSet = {
  spinner: ["|", "/", "-", "\\"],
  dot: "*",
  ring: "o",
  half: "*",
  check: "+",
  cross: "x",
  warn: "!",
  prompt: ">",
  caret: "v",
  elbow: "\\",
  branch: "|",
  last: "`",
  vbar: "|",
  hbar: "-",
  bullet: "-",
  ellipsis: "...",
  cursor: "_",
  block: "#",
  shade: ".",
  upArrow: "^",
  downArrow: "v",
  sep: " | ",
  times: "x",
  border: "classic",
};

export function glyphsFor(caps: TermCaps = termCaps()): GlyphSet {
  return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}
