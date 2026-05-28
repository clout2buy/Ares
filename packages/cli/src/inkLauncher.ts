import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import { OLLAMA_CLOUD_MODELS, type OllamaCloudModel } from "@crix/core";
import { availableThemes, currentThemeName, setTheme, type ThemeName } from "./terminalUi.js";
import type { UiSettings } from "./uiSettings.js";

type ProviderId = "openai" | "ollama";
type LauncherPhase = "provider" | "ollama" | "openai" | "theme" | "workspace";

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

export async function runInkLauncher(options: LauncherOptions): Promise<LauncherAction> {
  let action: LauncherAction = { kind: "quit" };
  process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
  const instance = render(
    h(CrixLauncherApp, {
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

function CrixLauncherApp({
  options,
  onDone,
}: {
  options: LauncherOptions;
  onDone: (action: LauncherAction) => void;
}) {
  const app = useApp();
  const { rows, columns } = useWindowSize();
  const [phase, setPhase] = useState<LauncherPhase>("provider");
  const [selectedProvider, setSelectedProvider] = useState(options.settings.lastProvider === "openai" ? 0 : 1);
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
  const theme = LAUNCHER_THEMES[selectedTheme] ?? LAUNCHER_THEMES.graphite;
  const openAIModels = useMemo(() => openAIModelList(options.settings), [options.settings]);
  const models = useMemo(() => reorderWithFavorites(ollamaModels(), favoriteOllama), [favoriteOllama]);
  const selectedModel = models[Math.min(selectedOllama, Math.max(0, models.length - 1))] ?? models[0];
  const selectedOpenAIModel = openAIModels[Math.min(selectedOpenAI, Math.max(0, openAIModels.length - 1))] ?? "gpt-5.5";
  const maxVisibleModels = Math.max(8, rows - 15);
  const modelWindow = windowAround(selectedOllama, models.length, maxVisibleModels);
  const openAIWindow = windowAround(selectedOpenAI, openAIModels.length, maxVisibleModels);

  const finish = (action: LauncherAction) => {
    onDone(action);
    app.exit(0);
  };

  const openTheme = () => {
    previousPhase.current = phase;
    setPhase("theme");
  };

  useTerminalMouseMode();
  function handleMouseEvent(event: TerminalMouseEvent) {
    if (event.release) return;
    if (event.button === 64) {
      if (phase === "ollama") setSelectedOllama((prev) => Math.max(0, prev - 3));
      if (phase === "openai") setSelectedOpenAI((prev) => Math.max(0, prev - 3));
      return;
    }
    if (event.button === 65) {
      if (phase === "ollama") setSelectedOllama((prev) => Math.min(models.length - 1, prev + 3));
      if (phase === "openai") setSelectedOpenAI((prev) => Math.min(openAIModels.length - 1, prev + 3));
      return;
    }
    if (event.button !== 0) return;
    if (phase === "provider") {
      if (event.y >= 8 && event.y <= 14 && event.x >= 2 && event.x <= 36) {
        setSelectedProvider(0);
        setPhase("openai");
        return;
      }
      if (event.y >= 8 && event.y <= 14 && event.x >= 38 && event.x <= 72) {
        setSelectedProvider(1);
        setPhase("ollama");
        return;
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
      if (absolute >= 0 && absolute < openAIModels.length) {
        if (absolute === selectedOpenAI) {
          finish({
            kind: "chat",
            provider: "openai",
            model: openAIModels[absolute] ?? "gpt-5.5",
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
      if (value === "1") setSelectedProvider(0);
      if (value === "2") setSelectedProvider(1);
      if (value === "3") finish({ kind: "login" });
      if (value === "4") finish({ kind: "doctor" });
      if (value === "5") finish({ kind: "help" });
      if (previousKey || nextKey) setSelectedProvider((prev) => (prev === 0 ? 1 : 0));
      if (key.return) setPhase(selectedProvider === 0 ? "openai" : "ollama");
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
      if (previousKey) setSelectedOpenAI((prev) => Math.max(0, prev - 1));
      if (nextKey) setSelectedOpenAI((prev) => Math.min(openAIModels.length - 1, prev + 1));
      if (pageUp) setSelectedOpenAI((prev) => Math.max(0, prev - 8));
      if (pageDown) setSelectedOpenAI((prev) => Math.min(openAIModels.length - 1, prev + 8));
      if (value.toLowerCase() === "f") {
        setFavoriteOpenAI((prev) => {
          const next = toggleFavorite(prev, selectedOpenAIModel);
          void options.onSettingsChange?.({ favoriteOpenAIModels: next });
          return next;
        });
      }
      if (key.return) {
        finish({
          kind: "chat",
          provider: "openai",
          model: selectedOpenAIModel,
          theme: selectedTheme,
          workspace,
          favoriteOllamaModels: favoriteOllama,
          favoriteOpenAIModels: favoriteOpenAI,
        });
      }
    }
  });

  return h(
    Box,
    { flexDirection: "column", width: columns, height: rows, paddingX: 1 },
    h(LauncherHeader, { theme, phase, selectedTheme, workspace }),
    phase === "provider"
      ? h(ProviderDeck, { theme, selectedProvider })
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
              models: openAIModels.slice(openAIWindow.start, openAIWindow.end),
              offset: openAIWindow.start,
              selected: selectedOpenAI,
              favorites: favoriteOpenAI,
            })
          : phase === "theme"
            ? h(ThemeDeck, { theme, selectedTheme })
            : h(WorkspaceDeck, { theme, workspaceDraft }),
    h(LauncherFooter, { theme, phase }),
  );
}

function LauncherHeader({
  theme,
  phase,
  selectedTheme,
  workspace,
}: {
  theme: LauncherTheme;
  phase: LauncherPhase;
  selectedTheme: ThemeName;
  workspace: string;
}) {
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
    h(
      Box,
      { justifyContent: "space-between" },
      h(Box, { gap: 1 }, h(Text, { color: theme.accent, bold: true }, "CRIX"), h(Text, { color: theme.dim }, "launch deck"), h(Text, { color: theme.accent2 }, phase)),
      h(Box, { gap: 1 }, h(Text, { color: theme.dim }, "theme"), h(Text, { color: theme.accent, bold: true }, selectedTheme)),
    ),
    h(Text, { color: theme.dim, wrap: "truncate" }, workspace),
  );
}

function ProviderDeck({ theme, selectedProvider }: { theme: LauncherTheme; selectedProvider: number }) {
  const cards = [
    ["GPT OAuth", "OpenAI Responses backend using your ChatGPT OAuth login.", "gpt-5.5"],
    ["Ollama Cloud", "Pick every cloud model from the bundled Ollama catalog.", "qwen/deepseek/kimi/glm"],
    ["Login GPT OAuth", "Refresh the device-code login.", "auth"],
    ["Doctor", "Check OpenAI auth and Ollama health.", "health"],
    ["Help", "Show CLI commands and flags.", "docs"],
  ];
  return h(
    Box,
    { flexDirection: "column", gap: 1 },
    h(Text, { color: theme.accent, bold: true }, "Choose a provider"),
    h(
      Box,
      { flexDirection: "row", gap: 1 },
      cards.slice(0, 2).map((card, index) =>
        h(LauncherCard, {
          key: card[0],
          theme,
          hotkey: String(index + 1),
          title: card[0],
          body: card[1],
          footer: card[2],
          active: selectedProvider === index,
        }),
      ),
    ),
    h(
      Box,
      { flexDirection: "row", gap: 1 },
      cards.slice(2).map((card, index) =>
        h(LauncherCard, {
          key: card[0],
          theme,
          hotkey: String(index + 3),
          title: card[0],
          body: card[1],
          footer: card[2],
          active: false,
        }),
      ),
    ),
  );
}

function LauncherCard({
  theme,
  hotkey,
  title,
  body,
  footer,
  active,
}: {
  theme: LauncherTheme;
  hotkey: string;
  title: string;
  body: string;
  footer: string;
  active: boolean;
}) {
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
    h(Text, { color: theme.dim }, footer),
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
      return h(
        Box,
        { key: model.id, justifyContent: "space-between" },
        h(
          Box,
          { gap: 1 },
          h(Text, { color: active ? theme.accent : theme.dim }, active ? ">" : " "),
          h(Text, { color: fav ? theme.warn : active ? theme.accent2 : theme.text, bold: active || fav }, `${fav ? "*" : " "} ${cleanModelName(model.id)}`),
        ),
        h(Text, { color: theme.dim, wrap: "truncate" }, model.hint),
      );
    }),
  );
}

function OpenAIModelDeck({
  theme,
  models,
  offset,
  selected,
  favorites,
}: {
  theme: LauncherTheme;
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
    h(Box, { justifyContent: "space-between" }, h(Text, { color: theme.accent, bold: true }, "GPT OAuth"), h(Text, { color: theme.dim }, "F favorite | click selected model to launch")),
    h(Text, { color: theme.dim }, "OpenAI Responses through ChatGPT OAuth."),
    h(Text, { color: theme.dim }, ""),
    ...models.map((model, index) => {
      const absolute = offset + index;
      const active = absolute === selected;
      const fav = favorites.includes(model);
      return h(
        Box,
        { key: model, gap: 1 },
        h(Text, { color: active ? theme.accent : theme.dim }, active ? ">" : " "),
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
      ? "A/D or arrows choose | Enter open | 1-5 quick launch | T theme | W workspace | Q quit"
      : phase === "workspace"
        ? "type path | Enter accept | Esc cancel"
        : "A/D or arrows move | PgUp/PgDn jump | F favorite | Enter launch | P providers | T theme | Q back";
  return h(Box, { marginTop: 1 }, h(Text, { color: theme.dim }, help));
}

interface LauncherModel {
  id: string;
  hint: string;
  group: string;
}

function ollamaModels(): LauncherModel[] {
  const models = [...OLLAMA_CLOUD_MODELS].map((model) => ({
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
  return models.sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9) || a.id.localeCompare(b.id));
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

function openAIModelList(settings: UiSettings): string[] {
  return unique([
    ...(settings.favoriteOpenAIModels ?? []),
    settings.lastOpenAIModel,
    process.env.CRIX_OPENAI_MODEL,
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
