import path from "node:path";
import type { ToolPermissionRequest } from "@ares/core";
import type { TurnEvent } from "@ares/protocol";
import type { PermissionMode } from "@ares/protocol";

type Tone = "info" | "success" | "warn" | "error" | "muted";
type Layout = "bar" | "panel" | "matrix" | "pro";

export type ThemeName =
  // God-of-war themes (match the desktop). `rage` is the default face.
  | "rage"
  | "bronze"
  | "crimson"
  | "steel"
  | "nightfall"
  | "verdant"
  // Legacy terminal themes (kept for back-compat; the desktop never had them).
  | "cyberpunk"
  | "minimal"
  | "matrix"
  | "neon"
  | "split"
  | "professional"
  | "amber"
  | "dashboard"
  | "light"
  | "midnight"
  | "mono-pro"
  | "solarized"
  | "synthwave"
  | "graphite"
  | "oxide";

interface Theme {
  name: ThemeName;
  title: string;
  layout: Layout;
  primary: string;
  accent: string;
  model: string;
  border: string;
  muted: string;
  success: string;
  warn: string;
  error: string;
  prompt: string;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
};

/** 24-bit truecolor foreground escape from a #hex (modern terminals). Falls back
 *  to the raw text if parsing fails. This is how the terminal hits the EXACT
 *  desktop god-of-war palette instead of approximating with named ANSI colors. */
function ansiHex(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return "";
  return `\x1b[38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}m`;
}

const THEMES: Record<ThemeName, Theme> = {
  rage: {
    name: "rage", title: "Rage", layout: "pro",
    primary: ansiHex("#ff6a44"), accent: ansiHex("#ff6a30"), model: ansiHex("#ffb24d"),
    border: ansiHex("#d6402e"), muted: ansiHex("#8b756d"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffb24d"), error: ansiHex("#ff5740"), prompt: "❯",
  },
  bronze: {
    name: "bronze", title: "Bronze", layout: "pro",
    primary: ansiHex("#e6bd72"), accent: ansiHex("#e0a93c"), model: ansiHex("#ffd877"),
    border: ansiHex("#c79a4e"), muted: ansiHex("#8b7a5d"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffd877"), error: ansiHex("#e36258"), prompt: "❯",
  },
  crimson: {
    name: "crimson", title: "Crimson", layout: "pro",
    primary: ansiHex("#e87a72"), accent: ansiHex("#e36258"), model: ansiHex("#ff9a8f"),
    border: ansiHex("#c0504a"), muted: ansiHex("#9b756d"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffb24d"), error: ansiHex("#ff5740"), prompt: "❯",
  },
  steel: {
    name: "steel", title: "Steel", layout: "pro",
    primary: ansiHex("#a6e0da"), accent: ansiHex("#5fb8b0"), model: ansiHex("#95e6dd"),
    border: ansiHex("#6fb3ae"), muted: ansiHex("#6d8b87"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffb24d"), error: ansiHex("#ff5740"), prompt: "❯",
  },
  nightfall: {
    name: "nightfall", title: "Nightfall", layout: "pro",
    primary: ansiHex("#b6b6f5"), accent: ansiHex("#9a8bef"), model: ansiHex("#c4b6ff"),
    border: ansiHex("#8b8bd9"), muted: ansiHex("#6d6d8b"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffb24d"), error: ansiHex("#ff5740"), prompt: "❯",
  },
  verdant: {
    name: "verdant", title: "Verdant", layout: "pro",
    primary: ansiHex("#9fe7bd"), accent: ansiHex("#59c08c"), model: ansiHex("#93eab8"),
    border: ansiHex("#6dc398"), muted: ansiHex("#6d8b7a"),
    success: ansiHex("#6dc398"), warn: ansiHex("#ffd877"), error: ansiHex("#ff5740"), prompt: "❯",
  },
  cyberpunk: {
    name: "cyberpunk",
    title: "Cyberpunk",
    layout: "panel",
    primary: ANSI.brightMagenta,
    accent: ANSI.brightCyan,
    model: ANSI.brightMagenta,
    border: ANSI.magenta,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "❯",
  },
  minimal: {
    name: "minimal",
    title: "Minimal",
    layout: "bar",
    primary: ANSI.cyan,
    accent: ANSI.white,
    model: ANSI.magenta,
    border: ANSI.gray,
    muted: ANSI.gray,
    success: ANSI.green,
    warn: ANSI.yellow,
    error: ANSI.red,
    prompt: "›",
  },
  matrix: {
    name: "matrix",
    title: "Matrix",
    layout: "matrix",
    primary: ANSI.brightGreen,
    accent: ANSI.green,
    model: ANSI.brightGreen,
    border: ANSI.green,
    muted: ANSI.green,
    success: ANSI.brightGreen,
    warn: ANSI.yellow,
    error: ANSI.brightRed,
    prompt: ">",
  },
  neon: {
    name: "neon",
    title: "Neon Blue",
    layout: "panel",
    primary: ANSI.brightBlue,
    accent: ANSI.brightCyan,
    model: ANSI.brightCyan,
    border: ANSI.blue,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "▸",
  },
  split: {
    name: "split",
    title: "Split Panel",
    layout: "panel",
    primary: ANSI.brightMagenta,
    accent: ANSI.brightBlue,
    model: ANSI.brightMagenta,
    border: ANSI.blue,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "◇",
  },
  professional: {
    name: "professional",
    title: "Professional",
    layout: "pro",
    primary: ANSI.brightWhite,
    accent: ANSI.white,
    model: ANSI.white,
    border: ANSI.gray,
    muted: ANSI.gray,
    success: ANSI.green,
    warn: ANSI.yellow,
    error: ANSI.red,
    prompt: "›",
  },
  amber: {
    name: "amber",
    title: "Modern Dark",
    layout: "panel",
    primary: ANSI.brightYellow,
    accent: ANSI.yellow,
    model: ANSI.brightYellow,
    border: ANSI.yellow,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "▷",
  },
  light: {
    name: "light",
    title: "Clean Light",
    layout: "pro",
    primary: ANSI.blue,
    accent: ANSI.cyan,
    model: ANSI.blue,
    border: ANSI.gray,
    muted: ANSI.gray,
    success: ANSI.green,
    warn: ANSI.yellow,
    error: ANSI.red,
    prompt: ">",
  },
  dashboard: {
    name: "dashboard",
    title: "Dashboard",
    layout: "pro",
    primary: ANSI.brightCyan,
    accent: ANSI.cyan,
    model: ANSI.brightCyan,
    border: ANSI.cyan,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "➜",
  },
  midnight: {
    name: "midnight",
    title: "Midnight",
    layout: "panel",
    primary: ANSI.brightBlue,
    accent: ANSI.brightMagenta,
    model: ANSI.brightCyan,
    border: ANSI.blue,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "❯",
  },
  "mono-pro": {
    name: "mono-pro",
    title: "Mono Pro",
    layout: "pro",
    primary: ANSI.brightWhite,
    accent: ANSI.white,
    model: ANSI.brightWhite,
    border: ANSI.gray,
    muted: ANSI.gray,
    success: ANSI.white,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "›",
  },
  solarized: {
    name: "solarized",
    title: "Solarized",
    layout: "panel",
    primary: ANSI.brightYellow,
    accent: ANSI.brightCyan,
    model: ANSI.brightBlue,
    border: ANSI.yellow,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.yellow,
    error: ANSI.brightRed,
    prompt: "◆",
  },
  synthwave: {
    name: "synthwave",
    title: "Synthwave",
    layout: "panel",
    primary: ANSI.brightMagenta,
    accent: ANSI.brightCyan,
    model: ANSI.brightMagenta,
    border: ANSI.magenta,
    muted: ANSI.brightBlue,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: "▶",
  },
  graphite: {
    name: "graphite",
    title: "Graphite",
    layout: "pro",
    primary: ANSI.brightWhite,
    accent: ANSI.brightCyan,
    model: ANSI.brightGreen,
    border: ANSI.gray,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: ">",
  },
  oxide: {
    name: "oxide",
    title: "Oxide",
    layout: "panel",
    primary: ANSI.brightRed,
    accent: ANSI.brightYellow,
    model: ANSI.brightCyan,
    border: ANSI.red,
    muted: ANSI.gray,
    success: ANSI.brightGreen,
    warn: ANSI.brightYellow,
    error: ANSI.brightRed,
    prompt: ">",
  },
};

let activeThemeName: ThemeName | undefined;

export function availableThemes(): ThemeName[] {
  return Object.keys(THEMES) as ThemeName[];
}

export function currentThemeName(): ThemeName {
  return theme().name;
}

export function setTheme(name: string): ThemeName | null {
  const normalized = normalizeThemeName(name);
  if (!normalized) return null;
  activeThemeName = normalized;
  process.env.ARES_THEME = normalized;
  return normalized;
}

function normalizeThemeName(name: string | undefined): ThemeName | null {
  const raw = (name ?? "").trim().toLowerCase();
  if (!raw) return null;
  const aliases: Record<string, ThemeName> = {
    // god-of-war aliases
    war: "rage",
    kratos: "rage",
    fire: "rage",
    gold: "bronze",
    bronze2: "bronze",
    blood: "crimson",
    teal: "steel",
    steelblue: "steel",
    purple2: "nightfall",
    night2: "nightfall",
    green2: "verdant",
    cyber: "cyberpunk",
    pink: "cyberpunk",
    minimalist: "minimal",
    mini: "minimal",
    green: "matrix",
    retro: "matrix",
    hacker: "matrix",
    blue: "neon",
    "neon-blue": "neon",
    purple: "split",
    boxed: "professional",
    pro: "professional",
    mono: "professional",
    modern: "amber",
    "modern-dark": "amber",
    yellow: "amber",
    dark: "amber",
    dash: "dashboard",
    clean: "light",
    white: "light",
    night: "midnight",
    dark2: "midnight",
    bw: "mono-pro",
    monochrome: "mono-pro",
    "mono-dark": "mono-pro",
    sol: "solarized",
    solarised: "solarized",
    synth: "synthwave",
    "synth-wave": "synthwave",
    retrowave: "synthwave",
    gray: "graphite",
    grey: "graphite",
    clean2: "graphite",
    rust: "oxide",
    red: "oxide",
  };
  const candidate = aliases[raw] ?? raw;
  return candidate in THEMES ? (candidate as ThemeName) : null;
}

function theme(): Theme {
  const selected = activeThemeName ?? normalizeThemeName(process.env.ARES_THEME) ?? "rage";
  return THEMES[selected];
}

function useColor(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

function useUnicode(): boolean {
  return process.env.ARES_ASCII_UI !== "1" && process.env.TERM !== "dumb";
}

function paint(text: string, code: string): string {
  return useColor() ? `${code}${text}${ANSI.reset}` : text;
}

export function dim(text: string): string {
  return paint(text, theme().muted);
}

export function bold(text: string): string {
  return paint(text, ANSI.bold);
}

function toneColor(tone: Tone): string {
  const t = theme();
  if (tone === "success") return t.success;
  if (tone === "warn") return t.warn;
  if (tone === "error") return t.error;
  if (tone === "muted") return t.muted;
  return t.accent;
}

function toneWord(tone: Tone): string {
  if (tone === "success") return "ok";
  if (tone === "warn") return "warn";
  if (tone === "error") return "error";
  return "info";
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function terminalWidth(): number {
  return Math.max(64, Math.min(process.stdout.columns || 96, 112));
}

function panelWidth(): number {
  return Math.max(58, Math.min(terminalWidth(), 96));
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function truncate(text: string, width: number): string {
  const clean = stripAnsi(text);
  if (clean.length <= width) return text;
  return clean.slice(0, Math.max(0, width - 1)) + (useUnicode() ? "…" : ".");
}

function wrap(text: string, width: number): string[] {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of clean.split(" ")) {
    if (!line) {
      line = word;
      continue;
    }
    if ((line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else {
      line += " " + word;
    }
  }
  if (line) out.push(line);
  return out;
}

function s() {
  return useUnicode()
    ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", dot: "•", arrow: "›", chipL: "〔", chipR: "〕" }
    : { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", dot: "-", arrow: ">", chipL: "[", chipR: "]" };
}

function label(key: string, value: string): string {
  return `${paint(key.padEnd(8), theme().muted)} ${value}`;
}

function chip(text: string, color = theme().accent): string {
  const sym = s();
  return paint(`${sym.chipL}${text}${sym.chipR}`, color);
}

function rule(width = Math.min(terminalWidth(), 96)): string {
  return paint(s().h.repeat(width), theme().border);
}

export function card(title: string, lines: string[], tone: Tone = "info"): string {
  const sym = s();
  const t = theme();
  const width = panelWidth();
  const inner = width - 4;
  const titleText = ` ${title} `;
  const top =
    paint(sym.tl, t.border) +
    paint(titleText, toneColor(tone)) +
    paint(sym.h.repeat(Math.max(0, width - visibleLength(titleText) - 2)), t.border) +
    paint(sym.tr, t.border);
  const body = lines
    .flatMap((line) => wrap(line, inner))
    .map((line) => `${paint(sym.v, t.border)} ${padRight(truncate(line, inner), inner)} ${paint(sym.v, t.border)}`);
  const bottom = paint(sym.bl + sym.h.repeat(width - 2) + sym.br, t.border);
  return [top, ...body, bottom].join("\n") + "\n";
}

export function chatHeader(input: { provider: string; model: string; workspace: string }): string {
  const t = theme();
  const folder = path.basename(input.workspace) || input.workspace;
  const provider = `${input.provider}:${input.model}`;
  if (t.layout === "bar") return barHeader(input, folder, provider);
  if (t.layout === "matrix") return matrixHeader(input, folder, provider);
  if (t.layout === "pro") return proHeader(input, folder, provider);
  return panelHeader(input, folder, provider);
}

function barHeader(input: { workspace: string }, folder: string, provider: string): string {
  const t = theme();
  return [
    `${paint("ARES", t.primary)} ${paint(provider, t.model)} ${dim(folder)} ${chip(t.title, t.border)}`,
    `${dim("workspace")} ${input.workspace}`,
    `${dim("commands")} /help  /settings  /model  /key  /routing  /plan  /code  /danger  /sessions  /exit`,
    rule(88),
  ].join("\n") + "\n";
}

function panelHeader(input: { workspace: string }, folder: string, provider: string): string {
  const sym = s();
  const t = theme();
  const width = panelWidth();
  const inner = width - 4;
  const title = ` ARES ${provider} `;
  const top =
    paint(sym.tl + sym.h, t.border) +
    paint(title, t.primary) +
    paint(sym.h.repeat(Math.max(0, width - visibleLength(title) - 3)) + sym.tr, t.border);
  const commands = "/help  /settings  /model  /key  /routing  /plan  /code  /danger  /sessions  /exit";
  const bodyLine = (text: string) =>
    `${paint(sym.v, t.border)} ${padRight(truncate(text, inner), inner)} ${paint(sym.v, t.border)}`;
  const footerText = ` ${truncate(commands, width - 6)} `;
  return [
    top,
    bodyLine(`${chip(t.title, t.primary)} ${dim("workspace")} ${input.workspace}`),
    bodyLine(`${dim("context  ")} ${folder}`),
    paint(sym.bl + sym.h, t.border) +
      paint(footerText, t.accent) +
      paint(sym.h.repeat(Math.max(0, width - visibleLength(footerText) - 3)) + sym.br, t.border),
  ].join("\n") + "\n";
}

function matrixHeader(input: { workspace: string }, _folder: string, provider: string): string {
  const t = theme();
  const title = `--- ARES TERMINAL :: ${provider} ---`;
  return [
    paint(title, t.primary),
    paint(`workspace ${input.workspace}`, t.accent),
    paint("[ /help ] [ /settings ] [ /model ] [ /key ] [ /routing ] [ /plan ] [ /code ] [ /danger ] [ /exit ]", t.accent),
    rule(92),
  ].join("\n") + "\n";
}

function proHeader(input: { workspace: string }, folder: string, provider: string): string {
  const t = theme();
  return [
    `${paint("ARES", t.primary)} ${chip(provider, t.border)} ${chip(folder, t.accent)} ${chip(t.title, t.primary)}`,
    `${dim("workspace")} ${input.workspace}`,
    `${dim("menu     ")} /help  /settings  /model  /key  /routing  /plan  /code  /danger  /doctor  /exit`,
    rule(90),
  ].join("\n") + "\n";
}

export function promptLabel(model: string, workspace: string, mode: PermissionMode = "workspace-write"): string {
  const t = theme();
  const folder = path.basename(workspace) || workspace;
  const modeTag = mode === "plan" ? " [PLAN]" : mode === "bypass" ? " [BYPASS]" : "";
  const modeColor = mode === "plan" || mode === "bypass" ? t.warn : t.model;
  if (t.layout === "matrix") {
    return `${paint("[ares]", t.primary)} ${paint(model + modeTag, modeColor)} ${paint(folder, t.accent)} ${paint(t.prompt, t.primary)} `;
  }
  if (t.layout === "pro") {
    return `${paint("ares", t.primary)} ${chip(model + modeTag, modeColor)} ${dim(folder)} ${paint(t.prompt, t.primary)} `;
  }
  return `${paint("ares", t.primary)} ${paint(model + modeTag, modeColor)} ${dim(folder)} ${paint(t.prompt, t.accent)} `;
}

export function interactiveHelp(): string {
  return card(
    "Commands",
    [
      "/help                  Show this help.",
      "/settings              Show model, key, routing, Telegram, and runtime state.",
      "/doctor                Provider and runtime status.",
      "/models [provider]     List terminal model catalog for a provider.",
      "/model <provider> [id] Switch the live model (id omitted = saved/default).",
      "/keys                  Show saved API key status.",
      "/key <provider> <key>  Save or clear a provider key (use 'clear').",
      "/reasoning [level]     Show/set reasoning: low|medium|high|max.",
      "/routing ...           Show/set per-lane model routing.",
      "/themes                Show installed UI themes.",
      "/theme <name>          Switch theme without restarting.",
      "/sessions              List saved .ares sessions for this workspace.",
      "/plan                  Enter read-only planning mode.",
      "/code                  Exit planning mode and allow workspace writes.",
      "/danger                Toggle bypass mode for tool prompts.",
      "/checkpoints           List local workspace checkpoints.",
      "/checkpoint-diff <id>  Compare current workspace to a checkpoint.",
      "/undo [N]              Restore the latest pre-write checkpoint.",
      "/rollback <id>         Restore a checkpoint snapshot.",
      "/resume [id|last]      Replay a saved session into model context.",
      "/workspace <path>      Switch the active workspace for tool calls.",
      "/exit                  Close Ares.",
      "Normal text goes to the agent. Tools run only when the model calls them.",
    ],
    "info",
  );
}

export function themesList(): string {
  return card(
    "Themes",
    availableThemes().map((name) => {
      const t = THEMES[name];
      const current = name === currentThemeName() ? "active" : "available";
      return `${paint(name.padEnd(13), t.primary)} ${t.title.padEnd(14)} ${current}`;
    }),
    "info",
  );
}

export function themeChanged(name: ThemeName): string {
  return notice("Theme", [`active ${name}`, "Use /themes to see the full loadout."], "success");
}

export function permissionPrompt(request: ToolPermissionRequest): string {
  const body = [
    label("tool", request.toolName),
    label("reason", request.reason),
    label("input", truncate(JSON.stringify(request.input), 120)),
    "",
    `${paint("1", theme().success)} allow once    ${paint("2", theme().warn)} allow always    ${paint("3", theme().error)} decline`,
    dim("press a number; Enter is not required"),
  ];
  return card("Permission Required", body, "warn");
}

export function toolStart(event: Extract<TurnEvent, { type: "tool_start" }>): string {
  const sym = s();
  const t = theme();
  const title = `${paint(sym.tl + sym.h, t.border)} ${paint(event.name, t.accent)} ${dim("running")}`;
  const action = truncate(event.activityDescription, panelWidth() - 12);
  const input = truncate(summarizeInput(event.input), panelWidth() - 12);
  return [
    title,
    `${paint(sym.v, t.border)} ${dim("action")} ${action}`,
    `${paint(sym.v, t.border)} ${dim("input ")} ${input}`,
  ].join("\n") + "\n";
}

export function toolEnd(event: Extract<TurnEvent, { type: "tool_end" }>): string {
  const outcome = classifyOutput(event.output);
  const status = paint(toneWord(outcome.tone), toneColor(outcome.tone));
  const result = event.display ?? outcome.detail;
  const suffix = result ? ` ${dim("·")} ${truncate(result, panelWidth() - 24)}` : "";
  const sym = s();
  return `${paint(sym.bl + sym.h, theme().border)} ${status} ${dim(`${event.durationMs}ms`)}${suffix}\n`;
}

export function toolError(event: Extract<TurnEvent, { type: "tool_error" }>): string {
  const sym = s();
  return `${paint(sym.bl + sym.h, theme().border)} ${paint("error", theme().error)} ${dim(`${event.durationMs}ms`)} ${truncate(event.error, panelWidth() - 20)}\n`;
}

export function providerError(message: string): string {
  return card("Provider Error", [message], "error");
}

export function notice(title: string, lines: string[], tone: Tone = "info"): string {
  return card(title, lines, tone);
}

export function thinkingPrefix(): string {
  const sym = s();
  return `${paint(sym.dot, theme().accent)} ${dim("thinking")} `;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return JSON.stringify(input);
  const obj = input as Record<string, unknown>;
  const interesting = ["file_path", "path", "cwd", "pattern", "command", "description"];
  const parts = interesting
    .filter((key) => obj[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(obj[key])}`);
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(input);
}

function classifyOutput(output: unknown): { detail: string; tone: Tone } {
  if (!output || typeof output !== "object") {
    return { detail: "", tone: "success" };
  }
  const obj = output as Record<string, unknown>;
  if (typeof obj.exitCode === "number" || obj.exitCode === null) {
    const exitCode = obj.exitCode;
    const timedOut = obj.timedOut === true;
    if (timedOut) return { detail: `exit=${exitCode}`, tone: "error" };
    if (exitCode === 0) return { detail: "exit=0", tone: "success" };
    return { detail: `exit=${exitCode}`, tone: "error" };
  }
  return { detail: "", tone: "success" };
}
