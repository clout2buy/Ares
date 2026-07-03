import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { OLLAMA_CLOUD_MODELS, type OllamaCloudModel } from "@ares/core";
import { availableThemes, currentThemeName, setTheme, type ThemeName } from "./terminalUi.js";
import type { UiSettings } from "./uiSettings.js";
import { motionEnabled } from "./tuiElite.js";
import {
  bladeSweep,
  emberRain,
  fireWordmark,
  flameLine,
  forgeStrike,
  introStageAt,
  INTRO_HARD_CAP_MS,
  INTRO_TICK_MS,
  INTRO_TOTAL_MS,
  STRIKE_FRAME_COUNT,
  WORDMARK_LETTERS,
  WORDMARK_ROWS,
  WORDMARK_WIDTH,
  type FxPalette,
  type FxSpan,
} from "./tuiFx.js";

type ProviderId = "ollama" | "openai" | "anthropic" | "deepseek" | "openrouter" | "mock";
type LauncherPhase = "provider" | "ollama" | "openai" | "theme" | "workspace";

const PROVIDER_OPTIONS: Array<{ id: ProviderId; title: string; body: string; footer: string }> = [
  { id: "ollama", title: "Ollama Cloud", body: "Cloud and local Ollama models with tool support.", footer: "cloud/local" },
  { id: "openai", title: "OpenAI", body: "Responses backend using your ChatGPT OAuth login.", footer: "OAuth" },
  { id: "anthropic", title: "Anthropic", body: "Claude API models using your saved Anthropic key.", footer: "API key" },
  { id: "deepseek", title: "DeepSeek", body: "Official DeepSeek long-context coding models.", footer: "API key" },
  { id: "openrouter", title: "OpenRouter", body: "Use any OpenRouter model id saved in settings.", footer: "API key" },
  { id: "mock", title: "Mock", body: "Offline echo provider for UI and installer testing.", footer: "offline" },
];

export type LauncherAction =
  | {
      kind: "chat";
      provider: ProviderId;
      model: string;
      theme: ThemeName;
      workspace?: string;
      favoriteOllamaModels: string[];
      favoriteOpenAIModels: string[];
    }
  | { kind: "login" }
  | { kind: "doctor" }
  | { kind: "help" }
  | { kind: "quit" };

export interface LauncherOptions {
  workspace: string;
  settings: UiSettings;
  onSettingsChange?: (patch: Partial<UiSettings>) => void | Promise<void>;
}

interface LauncherTheme {
  frame: string;
  accent: string;
  accent2: string;
  accent3: string;
  text: string;
  dim: string;
  success: string;
  warn: string;
  error: string;
}

const h = React.createElement;

const LAUNCHER_THEMES: Record<ThemeName, LauncherTheme> = {
  rage: { frame: "#d6402e", accent: "#ff6a44", accent2: "#ffb24d", accent3: "#ff6a30", text: "#ece3d9", dim: "#8b756d", success: "#6dc398", warn: "#ffb24d", error: "#ff5740" },
  bronze: { frame: "#c79a4e", accent: "#e6bd72", accent2: "#ffd877", accent3: "#e0a93c", text: "#ece0cf", dim: "#8b7a5d", success: "#6dc398", warn: "#ffd877", error: "#e36258" },
  crimson: { frame: "#c0504a", accent: "#e87a72", accent2: "#ff9a8f", accent3: "#e36258", text: "#ece0dd", dim: "#9b756d", success: "#6dc398", warn: "#ffb24d", error: "#ff5740" },
  steel: { frame: "#6fb3ae", accent: "#a6e0da", accent2: "#95e6dd", accent3: "#5fb8b0", text: "#dceae9", dim: "#6d8b87", success: "#6dc398", warn: "#ffb24d", error: "#ff5740" },
  nightfall: { frame: "#8b8bd9", accent: "#b6b6f5", accent2: "#c4b6ff", accent3: "#9a8bef", text: "#e3e3f0", dim: "#6d6d8b", success: "#6dc398", warn: "#ffb24d", error: "#ff5740" },
  verdant: { frame: "#6dc398", accent: "#9fe7bd", accent2: "#93eab8", accent3: "#59c08c", text: "#dceae3", dim: "#6d8b7a", success: "#6dc398", warn: "#ffd877", error: "#ff5740" },
  cyberpunk: { frame: "magenta", accent: "magenta", accent2: "cyan", accent3: "blue", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  minimal: { frame: "gray", accent: "cyan", accent2: "white", accent3: "blue", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  matrix: { frame: "green", accent: "green", accent2: "green", accent3: "yellow", text: "green", dim: "gray", success: "green", warn: "yellow", error: "red" },
  neon: { frame: "blue", accent: "blue", accent2: "cyan", accent3: "magenta", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  split: { frame: "magenta", accent: "magenta", accent2: "blue", accent3: "cyan", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  professional: { frame: "white", accent: "white", accent2: "gray", accent3: "green", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  amber: { frame: "yellow", accent: "yellow", accent2: "white", accent3: "cyan", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  dashboard: { frame: "cyan", accent: "cyan", accent2: "blue", accent3: "magenta", text: "white", dim: "gray", success: "green", warn: "yellow", error: "red" },
  light: { frame: "blue", accent: "blue", accent2: "cyan", accent3: "green", text: "black", dim: "gray", success: "green", warn: "yellow", error: "red" },
  midnight: { frame: "blue", accent: "blueBright", accent2: "magentaBright", accent3: "cyanBright", text: "white", dim: "gray", success: "greenBright", warn: "yellowBright", error: "redBright" },
  "mono-pro": { frame: "gray", accent: "whiteBright", accent2: "white", accent3: "whiteBright", text: "white", dim: "gray", success: "white", warn: "yellowBright", error: "redBright" },
  solarized: { frame: "yellow", accent: "yellowBright", accent2: "cyanBright", accent3: "blueBright", text: "white", dim: "gray", success: "greenBright", warn: "yellow", error: "redBright" },
  synthwave: { frame: "magentaBright", accent: "magentaBright", accent2: "cyanBright", accent3: "blueBright", text: "white", dim: "blueBright", success: "greenBright", warn: "yellowBright", error: "redBright" },
  graphite: { frame: "gray", accent: "whiteBright", accent2: "cyanBright", accent3: "greenBright", text: "white", dim: "gray", success: "greenBright", warn: "yellowBright", error: "redBright" },
  oxide: { frame: "red", accent: "redBright", accent2: "yellowBright", accent3: "cyanBright", text: "white", dim: "gray", success: "greenBright", warn: "yellowBright", error: "redBright" },
};

type ProviderReadiness = "ready" | "needs-key" | "oauth";

/** Can this provider actually run a turn right now? Surfaced on the picker so a
 *  new user never selects a keyless provider and fails on their first message. */
function providerReadiness(id: ProviderId, settings: UiSettings): ProviderReadiness {
  switch (id) {
    case "mock":
      return "ready";
    case "ollama":
      return "ready"; // local Ollama needs no key; cloud key is optional
    case "openai":
      return "oauth"; // ChatGPT OAuth — press L to sign in
    case "anthropic":
      return settings.anthropicKey ? "ready" : "needs-key";
    case "deepseek":
      return settings.deepSeekKey ? "ready" : "needs-key";
    case "openrouter":
      return settings.openRouterKey ? "ready" : "needs-key";
    default:
      return "needs-key";
  }
}

export async function runInkLauncher(options: LauncherOptions): Promise<LauncherAction> {
  let action: LauncherAction = { kind: "quit" };
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
  const instance = render(
    h(AresLauncherApp, {
      options,
      onDone: (next: LauncherAction) => {
        action = next;
      },
    }),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      alternateScreen: true,
      exitOnCtrlC: true,
    },
  );
  await instance.waitUntilExit();
  return action;
}

function AresLauncherApp({
  options,
  onDone,
}: {
  options: LauncherOptions;
  onDone: (action: LauncherAction) => void;
}) {
  const app = useApp();
  const { rows, columns } = useWindowSize();
  const [phase, setPhase] = useState<LauncherPhase>("provider");
  const [selectedProvider, setSelectedProvider] = useState(() =>
    Math.max(0, PROVIDER_OPTIONS.findIndex((provider) => provider.id === options.settings.lastProvider)),
  );
  const [selectedOllama, setSelectedOllama] = useState(() => {
    const model = options.settings.lastOllamaModel ?? "qwen3-coder:480b-cloud";
    return Math.max(0, ollamaModels().findIndex((m) => m.id === model));
  });
  const [selectedOpenAI, setSelectedOpenAI] = useState(0);
  const [selectedTheme, setSelectedTheme] = useState<ThemeName>(currentThemeName());
  const [favoriteOllama, setFavoriteOllama] = useState<string[]>(options.settings.favoriteOllamaModels ?? []);
  const [favoriteOpenAI, setFavoriteOpenAI] = useState<string[]>(options.settings.favoriteOpenAIModels ?? []);
  const [workspace, setWorkspace] = useState(options.workspace);
  const [workspaceDraft, setWorkspaceDraft] = useState(options.workspace);
  const previousPhase = useRef<LauncherPhase>("provider");
  const theme = LAUNCHER_THEMES[selectedTheme] ?? LAUNCHER_THEMES.rage;
  const currentProvider = PROVIDER_OPTIONS[Math.min(selectedProvider, PROVIDER_OPTIONS.length - 1)]?.id ?? "ollama";

  // ── Boot intro + idle fire ────────────────────────────────────────────────
  // One clock for both: while the intro plays the interval runs at 66ms; once
  // it ends (or is skipped) the SAME effect re-arms at 500ms for the header's
  // subtle idle flicker. Non-TTY / ARES_NO_MOTION → zero timers, static face.
  // ARES_NO_INTRO=1 skips the cinematic but keeps the idle flicker.
  const introEligible = motionEnabled() && process.env.ARES_NO_INTRO !== "1";
  const [introActive, setIntroActive] = useState(introEligible);
  const [fxTick, setFxTick] = useState(0);
  const introStart = useRef(Date.now());
  const skipIntro = () => {
    setIntroActive(false);
    setFxTick(0); // restart the idle clock so the header lands on a calm frame
  };
  useEffect(() => {
    if (!motionEnabled()) return undefined; // static rendering: no timers to leak
    const id = setInterval(() => {
      if (introActive && Date.now() - introStart.current >= INTRO_HARD_CAP_MS) {
        // Wall-clock kill switch: a stalled event loop can never hold the deck
        // hostage past the 2.2s budget, no matter how few ticks fired.
        skipIntro();
        return;
      }
      setFxTick((tick) => tick + 1);
    }, introActive ? INTRO_TICK_MS : 500);
    return () => clearInterval(id); // cleared on skip (re-arm) and on unmount
  }, [introActive]);
  useEffect(() => {
    // Storyboard complete → hand over to the deck (idle-flicker interval re-arms).
    if (introActive && fxTick * INTRO_TICK_MS >= INTRO_TOTAL_MS) skipIntro();
  }, [introActive, fxTick]);
  const [ollamaLiveTick, setOllamaLiveTick] = useState(0);
  useEffect(() => {
    void refreshLiveOllamaModels(options.settings).then((live) => {
      if (live) setOllamaLiveTick((tick) => tick + 1); // force ollamaModels() re-derivation once live data lands
    });
  }, [options.settings]);
  const providerModels = useMemo(() => providerModelList(currentProvider, options.settings), [currentProvider, options.settings, ollamaLiveTick]);
  const models = useMemo(() => reorderWithFavorites(ollamaModels(), favoriteOllama), [favoriteOllama, ollamaLiveTick]);
  const selectedModel = models[Math.min(selectedOllama, Math.max(0, models.length - 1))] ?? models[0];
  const selectedOpenAIModel = providerModels[Math.min(selectedOpenAI, Math.max(0, providerModels.length - 1))] ?? defaultModelForProvider(currentProvider, options.settings);
  // The fire wordmark header costs 6 extra rows (5 letters + flame divider) —
  // only spend them on tall terminals, and shrink the model window to match.
  const showWordmark = rows >= 28;
  const maxVisibleModels = Math.max(8, rows - (showWordmark ? 21 : 15));
  const modelWindow = windowAround(selectedOllama, models.length, maxVisibleModels);
  const openAIWindow = windowAround(selectedOpenAI, providerModels.length, maxVisibleModels);

  const finish = (action: LauncherAction) => {
    onDone(action);
    app.exit(0);
  };

  const openTheme = () => {
    previousPhase.current = phase;
    setPhase("theme");
  };

  useTerminalMouseMode();
  // TODO(mouse): these hardcoded hitboxes move to the dedicated mouse module
  // when it lands; until then we shift them by the fire header's extra rows.
  function handleMouseEvent(raw: TerminalMouseEvent) {
    const headerExtra = (showWordmark ? WORDMARK_ROWS : 0) + 1; // wordmark rows + flame divider
    const event: TerminalMouseEvent = { ...raw, y: raw.y - headerExtra };
    if (event.release) return;
    if (event.button === 64) {
      if (phase === "ollama") setSelectedOllama((prev) => Math.max(0, prev - 3));
      if (phase === "openai") setSelectedOpenAI((prev) => Math.max(0, prev - 3));
      return;
    }
    if (event.button === 65) {
      if (phase === "ollama") setSelectedOllama((prev) => Math.min(models.length - 1, prev + 3));
      if (phase === "openai") setSelectedOpenAI((prev) => Math.min(providerModels.length - 1, prev + 3));
      return;
    }
    if (event.button !== 0) return;
    if (phase === "provider") {
      if (event.y >= 8 && event.y <= 21 && event.x >= 2 && event.x <= 108) {
        const col = event.x >= 74 ? 2 : event.x >= 38 ? 1 : 0;
        const row = event.y >= 15 ? 1 : 0;
        const index = row * 3 + col;
        if (PROVIDER_OPTIONS[index]) {
          setSelectedProvider(index);
          setPhase(PROVIDER_OPTIONS[index].id === "ollama" ? "ollama" : "openai");
          setSelectedOpenAI(0);
          return;
        }
      }
      if (event.y >= 16 && event.y <= 22 && event.x >= 2 && event.x <= 36) finish({ kind: "login" });
      if (event.y >= 16 && event.y <= 22 && event.x >= 38 && event.x <= 72) finish({ kind: "doctor" });
      if (event.y >= 16 && event.y <= 22 && event.x >= 74 && event.x <= 108) finish({ kind: "help" });
      return;
    }
    if (phase === "ollama") {
      const absolute = modelWindow.start + event.y - 11;
      if (absolute >= 0 && absolute < models.length) {
        if (absolute === selectedOllama && models[absolute]) {
          finish({
            kind: "chat",
            provider: "ollama",
            model: models[absolute].id,
            theme: selectedTheme,
            workspace,
            favoriteOllamaModels: favoriteOllama,
            favoriteOpenAIModels: favoriteOpenAI,
          });
        } else {
          setSelectedOllama(absolute);
        }
      }
      return;
    }
    if (phase === "openai") {
      const absolute = openAIWindow.start + event.y - 11;
      if (absolute >= 0 && absolute < providerModels.length) {
        if (absolute === selectedOpenAI) {
          finish({
            kind: "chat",
            provider: currentProvider,
            model: providerModels[absolute] ?? defaultModelForProvider(currentProvider, options.settings),
            theme: selectedTheme,
            workspace,
            favoriteOllamaModels: favoriteOllama,
            favoriteOpenAIModels: favoriteOpenAI,
          });
        } else {
          setSelectedOpenAI(absolute);
        }
      }
      return;
    }
    if (phase === "theme") {
      const themes = availableThemes();
      const absolute = event.y - 11;
      const selected = themes[absolute];
      if (selected) {
        setSelectedTheme(selected);
        setTheme(selected);
        void options.onSettingsChange?.({ theme: selected });
        setPhase(previousPhase.current);
      }
    }
  }

  useInput((value, key) => {
    if (introActive) {
      // ANY key or mouse click (clicks arrive through useInput as SGR
      // sequences) skips straight to the deck. Ctrl+C still quits.
      if (key.ctrl && value === "c") {
        finish({ kind: "quit" });
        return;
      }
      skipIntro();
      return;
    }
    const mouseEvents = parseMouseEvents(value);
    if (mouseEvents.length > 0 || looksLikeMouseFragment(value)) {
      for (const event of mouseEvents) handleMouseEvent(event);
      return;
    }
    if (value.includes("\u001b[<")) return;
    if (key.ctrl && value === "c") {
      finish({ kind: "quit" });
      return;
    }
    if (phase === "workspace") {
      if (key.escape) {
        setWorkspaceDraft(workspace);
        setPhase(previousPhase.current);
        return;
      }
      if (key.return) {
        if (workspaceDraft.trim()) setWorkspace(workspaceDraft.trim());
        setPhase(previousPhase.current);
        return;
      }
      if (key.backspace || key.delete) {
        setWorkspaceDraft((prev) => prev.slice(0, -1));
        return;
      }
      if (value && !key.ctrl && !key.meta) {
        setWorkspaceDraft((prev) => prev + value.replace(/\r?\n/g, ""));
      }
      return;
    }

    const previousKey = key.upArrow || key.leftArrow || value.toLowerCase() === "a" || value.toLowerCase() === "w";
    const nextKey = key.downArrow || key.rightArrow || value.toLowerCase() === "d" || value.toLowerCase() === "s";
    const pageUp = key.pageUp;
    const pageDown = key.pageDown;

    if (value === "q" || key.escape) {
      if (phase === "provider") finish({ kind: "quit" });
      else setPhase("provider");
      return;
    }
    if (value.toLowerCase() === "t") {
      openTheme();
      return;
    }
    if (value.toLowerCase() === "p") {
      setPhase("provider");
      return;
    }
    if (value.toLowerCase() === "w") {
      previousPhase.current = phase;
      setWorkspaceDraft(workspace);
      setPhase("workspace");
      return;
    }

    if (phase === "provider") {
      const digit = Number(value);
      if (Number.isInteger(digit) && digit >= 1 && digit <= PROVIDER_OPTIONS.length) {
        setSelectedProvider(digit - 1);
        setSelectedOpenAI(0);
      }
      if (value.toLowerCase() === "l") finish({ kind: "login" });
      if (value.toLowerCase() === "d") finish({ kind: "doctor" });
      if (value.toLowerCase() === "h") finish({ kind: "help" });
      if (previousKey) {
        setSelectedProvider((prev) => (prev - 1 + PROVIDER_OPTIONS.length) % PROVIDER_OPTIONS.length);
        setSelectedOpenAI(0);
      }
      if (nextKey) {
        setSelectedProvider((prev) => (prev + 1) % PROVIDER_OPTIONS.length);
        setSelectedOpenAI(0);
      }
      if (key.return) setPhase(currentProvider === "ollama" ? "ollama" : "openai");
      return;
    }

    if (phase === "theme") {
      const themes = availableThemes();
      const current = themes.indexOf(selectedTheme);
      if (previousKey) setSelectedTheme(themes[(current - 1 + themes.length) % themes.length] ?? "amber");
      if (nextKey) setSelectedTheme(themes[(current + 1) % themes.length] ?? "amber");
      if (key.return) {
        setTheme(selectedTheme);
        void options.onSettingsChange?.({ theme: selectedTheme });
        setPhase(previousPhase.current);
      }
      return;
    }

    if (phase === "ollama") {
      // Number keys 1-9 pick the Nth VISIBLE row (owner has no arrow keys);
      // pressing the number of the already-selected row launches it — same
      // two-step contract as the mouse click path.
      if (/^[1-9]$/.test(value)) {
        const absolute = modelWindow.start + Number(value) - 1;
        if (absolute >= 0 && absolute < models.length && models[absolute]) {
          if (absolute === selectedOllama) {
            finish({
              kind: "chat",
              provider: "ollama",
              model: models[absolute].id,
              theme: selectedTheme,
              workspace,
              favoriteOllamaModels: favoriteOllama,
              favoriteOpenAIModels: favoriteOpenAI,
            });
          } else {
            setSelectedOllama(absolute);
          }
        }
        return;
      }
      if (previousKey) setSelectedOllama((prev) => Math.max(0, prev - 1));
      if (nextKey) setSelectedOllama((prev) => Math.min(models.length - 1, prev + 1));
      if (pageUp) setSelectedOllama((prev) => Math.max(0, prev - 10));
      if (pageDown) setSelectedOllama((prev) => Math.min(models.length - 1, prev + 10));
      if (value.toLowerCase() === "f" && selectedModel) {
        setFavoriteOllama((prev) => {
          const next = toggleFavorite(prev, selectedModel.id);
          void options.onSettingsChange?.({ favoriteOllamaModels: next });
          return next;
        });
      }
      if (key.return && selectedModel) {
        finish({
          kind: "chat",
          provider: "ollama",
          model: selectedModel.id,
          theme: selectedTheme,
          workspace,
          favoriteOllamaModels: favoriteOllama,
          favoriteOpenAIModels: favoriteOpenAI,
        });
      }
      return;
    }

    if (phase === "openai") {
      // Same 1-9 visible-row picker as the ollama deck (no-arrow-keys owner).
      if (/^[1-9]$/.test(value)) {
        const absolute = openAIWindow.start + Number(value) - 1;
        if (absolute >= 0 && absolute < providerModels.length) {
          if (absolute === selectedOpenAI) {
            finish({
              kind: "chat",
              provider: currentProvider,
              model: providerModels[absolute] ?? defaultModelForProvider(currentProvider, options.settings),
              theme: selectedTheme,
              workspace,
              favoriteOllamaModels: favoriteOllama,
              favoriteOpenAIModels: favoriteOpenAI,
            });
          } else {
            setSelectedOpenAI(absolute);
          }
        }
        return;
      }
      if (previousKey) setSelectedOpenAI((prev) => Math.max(0, prev - 1));
      if (nextKey) setSelectedOpenAI((prev) => Math.min(providerModels.length - 1, prev + 1));
      if (pageUp) setSelectedOpenAI((prev) => Math.max(0, prev - 8));
      if (pageDown) setSelectedOpenAI((prev) => Math.min(providerModels.length - 1, prev + 8));
      if (value.toLowerCase() === "f" && currentProvider === "openai") {
        setFavoriteOpenAI((prev) => {
          const next = toggleFavorite(prev, selectedOpenAIModel);
          void options.onSettingsChange?.({ favoriteOpenAIModels: next });
          return next;
        });
      }
      if (key.return) {
        finish({
          kind: "chat",
          provider: currentProvider,
          model: selectedOpenAIModel,
          theme: selectedTheme,
          workspace,
          favoriteOllamaModels: favoriteOllama,
          favoriteOpenAIModels: favoriteOpenAI,
        });
      }
    }
  });

  if (introActive) {
    return h(IntroCinematic, { theme, tick: fxTick, columns, rows });
  }

  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows, paddingX: 1 },
    h(LauncherHeader, { theme, phase, selectedTheme, workspace, fxTick, columns, showWordmark }),
    phase === "provider"
      ? h(ProviderDeck, { theme, selectedProvider, settings: options.settings })
      : phase === "ollama"
        ? h(ModelDeck, {
            theme,
            title: "Ollama Cloud",
            subtitle: "Cloud tags launch under the hood; clean names stay on the deck.",
            models: models.slice(modelWindow.start, modelWindow.end),
            offset: modelWindow.start,
            selected: selectedOllama,
            favorites: favoriteOllama,
          })
        : phase === "openai"
          ? h(OpenAIModelDeck, {
              theme,
              provider: currentProvider,
              models: providerModels.slice(openAIWindow.start, openAIWindow.end),
              offset: openAIWindow.start,
              selected: selectedOpenAI,
              favorites: currentProvider === "openai" ? favoriteOpenAI : [],
            })
          : phase === "theme"
            ? h(ThemeDeck, { theme, selectedTheme })
            : h(WorkspaceDeck, { theme, workspaceDraft }),
    h(LauncherFooter, { theme, phase }),
  );
}

// ─── Fire FX plumbing (theme → palette, spans → Ink) ──────────────────────────

/** The rage theme's frame/accent/accent2 ARE crimson/ember/gold — every other
 *  theme re-tints the fire through the same mapping instead of fighting it. */
function paletteFromTheme(theme: LauncherTheme): FxPalette {
  return { crimson: theme.frame, ember: theme.accent, gold: theme.accent2, steel: theme.accent3, dim: theme.dim };
}

/** Render one FX span row as nested Ink <Text> runs (dim → dimColor). */
function FxLine({ spans }: { spans: FxSpan[] }) {
  return h(
    Text,
    null,
    ...spans.map((span, index) => h(Text, { key: index, color: span.color, bold: span.bold, dimColor: span.dim }, span.text)),
  );
}

function LauncherHeader({
  theme,
  phase,
  selectedTheme,
  workspace,
  fxTick,
  columns,
  showWordmark,
}: {
  theme: LauncherTheme;
  phase: LauncherPhase;
  selectedTheme: ThemeName;
  workspace: string;
  fxTick: number;
  columns: number;
  showWordmark: boolean;
}) {
  const palette = paletteFromTheme(theme);
  // fxTick advances every ~500ms post-intro (0 forever when motion is off), so
  // the wordmark gradient creeps and the flame divider breathes — alive, cheap.
  const divider = flameLine(fxTick, Math.max(10, Math.min(columns - 6, 96)), palette);
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.frame,
      paddingX: 1,
      marginTop: 1,
      marginBottom: 1,
    },
    ...(showWordmark
      ? fireWordmark(fxTick, palette).map((row, index) => h(FxLine, { key: `wm${index}`, spans: row }))
      : []),
    h(
      Box,
      { justifyContent: "space-between" },
      h(Box, { gap: 1 }, h(Text, { color: theme.accent, bold: true }, "ARES"), h(Text, { color: theme.dim }, "launch deck"), h(Text, { color: theme.accent2 }, phase)),
      h(Box, { gap: 1 }, h(Text, { color: theme.dim }, "theme"), h(Text, { color: theme.accent, bold: true }, selectedTheme)),
    ),
    h(Text, { color: theme.dim, wrap: "truncate" }, workspace),
    h(FxLine, { spans: divider }),
  );
}

// ─── Boot intro cinematic ─────────────────────────────────────────────────────

const INTRO_TAGLINE = "GOD OF WAR // AUTONOMOUS AGENT";

/** The skippable ~1.8s cinematic. Pure render of (tick) — the parent owns the
 *  single 66ms interval, the storyboard math lives in tuiFx.introStageAt, so a
 *  stalled render can never desync stages from wall time. */
function IntroCinematic({
  theme,
  tick,
  columns,
  rows,
}: {
  theme: LauncherTheme;
  tick: number;
  columns: number;
  rows: number;
}) {
  const palette = paletteFromTheme(theme);
  const { stage, progress } = introStageAt(tick * INTRO_TICK_MS);
  const fieldW = Math.max(24, Math.min(columns - 4, 90));
  const fieldH = Math.max(4, Math.min(rows - 10, 10));
  const children: React.ReactNode[] = [];
  if (stage === "embers") {
    // Stage 1: sparks rise out of a dark screen — the forge is waking up.
    emberRain(tick, fieldW, fieldH, palette).forEach((row, index) => {
      children.push(h(FxLine, { key: `em${index}`, spans: row }));
    });
  } else {
    // A thin ember veil keeps drifting behind the metal for the whole show.
    emberRain(tick, fieldW, 2, palette).forEach((row, index) => {
      children.push(h(FxLine, { key: `veil${index}`, spans: row }));
    });
    const letterCount = WORDMARK_LETTERS.length;
    const lit = stage === "ignite" ? Math.min(letterCount, 1 + Math.floor(progress * letterCount)) : letterCount;
    fireWordmark(tick, palette, lit).forEach((row, index) => {
      children.push(h(FxLine, { key: `wm${index}`, spans: row }));
    });
    if (stage === "ignite") {
      // Stage 2: each letter lands with a hammer strike under it. The strike
      // clock restarts per letter: fraction-within-letter × frame count.
      const letterIndex = Math.max(0, lit - 1);
      const strikeTick = Math.floor(((progress * letterCount) % 1) * STRIKE_FRAME_COUNT);
      const strike = forgeStrike(strikeTick, palette);
      children.push(
        h(FxLine, {
          key: "strike",
          spans: strike.length > 0 ? [{ text: " ".repeat(letterIndex * 7) }, ...strike] : [{ text: " " }],
        }),
      );
    } else {
      // Stage 3: the blade slash under the wordmark reveals the tagline in its
      // wake; stage 4 keeps both fully settled while the fire calms down.
      const sweepTick = stage === "sweep" ? Math.floor((progress * 400) / INTRO_TICK_MS) : 99;
      children.push(h(FxLine, { key: "sweep", spans: bladeSweep(sweepTick, WORDMARK_WIDTH + 6, palette) }));
      const revealed = stage === "sweep" ? Math.min(INTRO_TAGLINE.length, sweepTick * 5) : INTRO_TAGLINE.length;
      children.push(h(Text, { key: "tag", color: theme.accent2, bold: true }, INTRO_TAGLINE.slice(0, revealed) || " "));
      if (stage === "settle") {
        // Stage 4: embers settle into the hearth line the deck header keeps.
        children.push(h(FxLine, { key: "hearth", spans: flameLine(tick >> 1, fieldW, palette) }));
      }
    }
  }
  children.push(h(Text, { key: "skip", color: theme.dim }, "any key to skip"));
  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows, alignItems: "center", justifyContent: "center" },
    ...children,
  );
}

function ProviderDeck({ theme, selectedProvider, settings }: { theme: LauncherTheme; selectedProvider: number; settings: UiSettings }) {
  const selectedId = PROVIDER_OPTIONS[Math.min(selectedProvider, PROVIDER_OPTIONS.length - 1)]?.id ?? "ollama";
  const selectedReady = providerReadiness(selectedId, settings);
  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(Text, { color: theme.accent, bold: true }, "Choose a provider"),
    h(
      Box,
      { flexDirection: "row", gap: 1 },
      PROVIDER_OPTIONS.slice(0, 3).map((card, index) =>
        h(LauncherCard, {
          key: card.id,
          theme,
          hotkey: String(index + 1),
          title: card.title,
          body: card.body,
          footer: card.footer,
          active: selectedProvider === index,
          readiness: providerReadiness(card.id, settings),
        }),
      ),
    ),
    h(
      Box,
      { flexDirection: "row", gap: 1 },
      PROVIDER_OPTIONS.slice(3).map((card, index) =>
        h(LauncherCard, {
          key: card.id,
          theme,
          hotkey: String(index + 4),
          title: card.title,
          body: card.body,
          footer: card.footer,
          active: selectedProvider === index + 3,
          readiness: providerReadiness(card.id, settings),
        }),
      ),
    ),
    // A live hint for the highlighted provider — tells a new user exactly what to
    // do BEFORE they commit and hit an "unauthorized" wall on message one.
    selectedReady === "needs-key"
      ? h(Text, { color: theme.warn }, `⚠ ${selectedId} needs an API key. Start it, then run  /key ${selectedId} <paste>  — or pick a ready provider.`)
      : selectedReady === "oauth"
        ? h(Text, { color: theme.accent2 }, "OpenAI uses ChatGPT OAuth — press L to sign in if you haven't.")
        : h(Text, { color: theme.success }, "✓ Ready to chat."),
    h(Text, { color: theme.dim }, "L login OpenAI OAuth | D doctor | H help | API keys: use /key inside chat"),
  );
}

function readinessBadge(readiness: ProviderReadiness, theme: LauncherTheme): { text: string; color: string } {
  if (readiness === "ready") return { text: "✓ ready", color: theme.success };
  if (readiness === "oauth") return { text: "⌁ OAuth", color: theme.accent2 };
  return { text: "○ needs key", color: theme.warn };
}

function LauncherCard({
  theme,
  hotkey,
  title,
  body,
  footer,
  active,
  readiness,
}: {
  theme: LauncherTheme;
  hotkey: string;
  title: string;
  body: string;
  footer: string;
  active: boolean;
  readiness: ProviderReadiness;
}) {
  const badge = readinessBadge(readiness, theme);
  return h(
    Box,
    {
      width: 32,
      height: 7,
      flexDirection: "column",
      borderStyle: "round",
      borderColor: active ? theme.accent : theme.frame,
      paddingX: 1,
    },
    h(Box, { gap: 1 }, h(Text, { color: active ? theme.accent : theme.dim }, `[${hotkey}]`), h(Text, { color: active ? theme.accent : theme.text, bold: true }, title)),
    h(Text, { color: theme.text, wrap: "wrap" }, body),
    h(Box, { justifyContent: "space-between" }, h(Text, { color: theme.dim }, footer), h(Text, { color: badge.color, bold: true }, badge.text)),
  );
}

function ModelDeck({
  theme,
  title,
  subtitle,
  models,
  offset,
  selected,
  favorites,
}: {
  theme: LauncherTheme;
  title: string;
  subtitle: string;
  models: LauncherModel[];
  offset: number;
  selected: number;
  favorites: string[];
}) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.frame,
      paddingX: 1,
      minHeight: 12,
    },
    h(Box, { justifyContent: "space-between" }, h(Text, { color: theme.accent, bold: true }, title), h(Text, { color: theme.dim }, "F favorite | click selected model to launch")),
    h(Text, { color: theme.dim }, subtitle),
    h(Text, { color: theme.dim }, ""),
    ...models.map((model, index) => {
      const absolute = offset + index;
      const active = absolute === selected;
      const fav = favorites.includes(model.id);
      // [n] badge mirrors the 1-9 hotkeys (visible-window relative) — the
      // owner picks models entirely by number, no arrow keys on his board.
      // TODO(mouse): richer per-row hitboxes land with the mouse module.
      return h(
        Box,
        { key: model.id, justifyContent: "space-between" },
        h(
          Box,
          { gap: 1 },
          h(Text, { color: active ? theme.accent : theme.dim }, active ? ">" : " "),
          h(Text, { color: active ? theme.accent : theme.dim }, index < 9 ? `[${index + 1}]` : "   "),
          h(Text, { color: fav ? theme.warn : active ? theme.accent2 : theme.text, bold: active || fav }, `${fav ? "*" : " "} ${cleanModelName(model.id)}`),
        ),
        h(Text, { color: theme.dim, wrap: "truncate" }, model.hint),
      );
    }),
  );
}

function OpenAIModelDeck({
  theme,
  provider,
  models,
  offset,
  selected,
  favorites,
}: {
  theme: LauncherTheme;
  provider: ProviderId;
  models: string[];
  offset: number;
  selected: number;
  favorites: string[];
}) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.frame,
      paddingX: 1,
      minHeight: 12,
    },
    h(Box, { justifyContent: "space-between" }, h(Text, { color: theme.accent, bold: true }, providerLabel(provider)), h(Text, { color: theme.dim }, provider === "openai" ? "F favorite | click selected model to launch" : "click selected model to launch")),
    h(Text, { color: theme.dim }, providerHint(provider)),
    h(Text, { color: theme.dim }, ""),
    ...models.map((model, index) => {
      const absolute = offset + index;
      const active = absolute === selected;
      const fav = favorites.includes(model);
      // Same [n] hotkey badge as the Ollama deck — number-first navigation.
      return h(
        Box,
        { key: model, gap: 1 },
        h(Text, { color: active ? theme.accent : theme.dim }, active ? ">" : " "),
        h(Text, { color: active ? theme.accent : theme.dim }, index < 9 ? `[${index + 1}]` : "   "),
        h(Text, { color: fav ? theme.warn : active ? theme.accent2 : theme.text, bold: active || fav }, `${fav ? "*" : " "} ${model}`),
      );
    }),
  );
}

function ThemeDeck({ theme, selectedTheme }: { theme: LauncherTheme; selectedTheme: ThemeName }) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.frame,
      paddingX: 1,
    },
    h(Text, { color: theme.accent, bold: true }, "Theme"),
    h(Text, { color: theme.dim }, "A/D or arrows cycle. Enter applies."),
    h(Text, { color: theme.dim }, ""),
    ...availableThemes().map((name) =>
      h(Text, { key: name, color: name === selectedTheme ? theme.accent : theme.text, bold: name === selectedTheme }, `${name === selectedTheme ? ">" : " "} ${name}`),
    ),
  );
}

function WorkspaceDeck({ theme, workspaceDraft }: { theme: LauncherTheme; workspaceDraft: string }) {
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.frame,
      paddingX: 1,
      height: 8,
    },
    h(Text, { color: theme.accent, bold: true }, "Workspace"),
    h(Text, { color: theme.dim }, "Type a folder path, Enter accepts, Esc cancels."),
    h(Text, { color: theme.dim }, ""),
    h(Box, { borderStyle: "single", borderColor: theme.accent, paddingX: 1 }, h(Text, { color: theme.text, wrap: "truncate" }, workspaceDraft || "D:\\Project")),
  );
}

function LauncherFooter({ theme, phase }: { theme: LauncherTheme; phase: LauncherPhase }) {
  const help =
    phase === "provider"
      ? "A/D or arrows choose | 1-6 jump | Enter open | L login | D doctor | H help | T theme | W workspace | Q quit"
      : phase === "workspace"
        ? "type path | Enter accept | Esc cancel"
        : "1-9 pick (same number launches) | A/D or arrows move | PgUp/PgDn jump | F favorite where supported | Enter launch | P providers | T theme | Q back";
  return h(Box, { marginTop: 1 }, h(Text, { color: theme.dim }, help));
}

interface LauncherModel {
  id: string;
  hint: string;
  group: string;
}

// Live Ollama Cloud catalog, merged over the static OLLAMA_CLOUD_MODELS list
// so renamed/retired aliases don't linger in the picker (mirrors entry.ts's
// daemonModelCatalog byId-Map merge for the daemon/webview catalog path).
// Best-effort: populated once in the background; ollamaModels() falls back to
// the static list unchanged until the fetch resolves (or forever, on failure).
let liveOllamaModels: LauncherModel[] | null = null;
let liveOllamaFetchStarted = false;

function refreshLiveOllamaModels(settings: UiSettings): Promise<LauncherModel[] | null> {
  if (liveOllamaFetchStarted) return Promise.resolve(liveOllamaModels);
  liveOllamaFetchStarted = true;
  const apiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY;
  if (!apiKey) return Promise.resolve(null);
  return fetch("https://ollama.com/api/tags", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload: { models?: Array<{ name?: string; model?: string; details?: { parameter_size?: string; family?: string } }> } | null) => {
      if (!payload) return null;
      const byId = new Map<string, LauncherModel>();
      for (const model of ollamaModels()) byId.set(model.id, model);
      for (const row of payload.models ?? []) {
        const id = row.name ?? row.model;
        if (!id) continue;
        byId.set(id, {
          id,
          hint: [row.details?.parameter_size, row.details?.family].filter(Boolean).join(" · ") || "Ollama Cloud · live",
          group: "live",
        });
      }
      liveOllamaModels = [...byId.values()];
      return liveOllamaModels;
    })
    .catch(() => null); // network failure — never block the picker, keep the static list
}

function ollamaModels(): LauncherModel[] {
  const base = liveOllamaModels ?? [...OLLAMA_CLOUD_MODELS].map((model) => ({
    id: model.id,
    hint: model.hint,
    group: groupForModel(model),
  }));
  const order = new Map([
    ["engineering", 0],
    ["multimodal", 1],
    ["fast", 2],
    ["general", 3],
  ]);
  return [...base].sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9) || a.id.localeCompare(b.id));
}

function groupForModel(model: OllamaCloudModel): string {
  if (/qwen3-coder|qwen3-next|qwen3\.5|devstral|glm-|deepseek|kimi-|minimax|gpt-oss:120b|nemotron-3-super|cogito/.test(model.id)) return "engineering";
  if (/gemma|gemini|qwen3-vl|mistral|ministral/.test(model.id)) return "multimodal";
  if (/20b|14b|12b|8b|4b|3b|nano|rnj/.test(model.id)) return "fast";
  return "general";
}

function cleanModelName(id: string): string {
  return id.replace(/-cloud$/u, "").replace(/:cloud$/u, "").replace(/:/gu, " ");
}

function providerModelList(provider: ProviderId, settings: UiSettings): string[] {
  if (provider === "ollama") return ollamaModels().map((model) => model.id);
  if (provider === "openai") return openAIModelList(settings);
  if (provider === "anthropic") {
    return unique([
      settings.lastAnthropicModel,
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ]);
  }
  if (provider === "deepseek") {
    return unique([settings.lastDeepSeekModel, "deepseek-v4-pro", "deepseek-v4-flash"]);
  }
  if (provider === "openrouter") {
    return unique([settings.lastOpenRouterModel, "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.5-pro"]);
  }
  return ["mock-echo"];
}

function defaultModelForProvider(provider: ProviderId, settings: UiSettings): string {
  return providerModelList(provider, settings)[0] ?? "mock-echo";
}

function providerLabel(provider: ProviderId): string {
  return PROVIDER_OPTIONS.find((item) => item.id === provider)?.title ?? provider;
}

function providerHint(provider: ProviderId): string {
  if (provider === "openai") return "OpenAI Responses through ChatGPT OAuth.";
  if (provider === "anthropic") return "Claude API models. Set a key with /key anthropic <value> inside chat.";
  if (provider === "deepseek") return "Official DeepSeek models. Set a key with /key deepseek <value> inside chat.";
  if (provider === "openrouter") return "OpenRouter model ids. Set a key with /key openrouter <value> inside chat.";
  if (provider === "mock") return "Offline echo provider for installer and UI testing.";
  return "Ollama Cloud and local Ollama models.";
}

function openAIModelList(settings: UiSettings): string[] {
  return unique([
    ...(settings.favoriteOpenAIModels ?? []),
    settings.lastOpenAIModel,
    process.env.ARES_OPENAI_MODEL,
    "gpt-5.5",
    "gpt-5.1-codex",
    "gpt-5.1",
  ]);
}

function reorderWithFavorites(models: LauncherModel[], favorites: string[]): LauncherModel[] {
  const fav = new Set(favorites);
  return [...models].sort((a, b) => {
    const af = fav.has(a.id) ? 0 : 1;
    const bf = fav.has(b.id) ? 0 : 1;
    return af - bf || a.group.localeCompare(b.group) || a.id.localeCompare(b.id);
  });
}

function toggleFavorite(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((item) => item !== id) : [id, ...current].slice(0, 12);
}

function unique(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item?.trim())))];
}

function windowAround(selected: number, total: number, size: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(Math.max(0, total - size), selected - Math.floor(size / 2)));
  return { start, end: Math.min(total, start + size) };
}

interface TerminalMouseEvent {
  button: number;
  x: number;
  y: number;
  release: boolean;
}

function useTerminalMouseMode(): void {
  useEffect(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    const stdinStream = process.stdin as typeof process.stdin & {
      setRawMode?: (mode: boolean) => void;
    };
    process.stdout.write("\u001b[?1000h\u001b[?1006h");
    stdinStream.setRawMode?.(true);
    return () => {
      process.stdout.write("\u001b[?1006l\u001b[?1000l");
    };
  }, []);
}

function parseMouseEvents(text: string): TerminalMouseEvent[] {
  const events: TerminalMouseEvent[] = [];
  const pattern = /(?:\u001b\[|\[)?<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    events.push({
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      release: match[4] === "m",
    });
  }
  return events;
}

function looksLikeMouseFragment(text: string): boolean {
  return /(?:\u001b\[|\[)?<\d*(?:;\d*){0,2}[mM]?/.test(text);
}
