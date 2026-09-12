import React, { useEffect, useMemo, useRef, useState } from "react";
import { render, useApp, useInput, useWindowSize } from "ink";
import { OLLAMA_CLOUD_MODELS, type OllamaCloudModel } from "@ares/core";
import { currentThemeName, type ThemeName } from "./terminalUi.js";
import type { UiSettings } from "./uiSettings.js";
import { motionEnabled } from "./tuiElite.js";
import { RowsView } from "./ui/RowText.js";
import { LIST_FIRST_ROW, launcherRows, listCapacity, type ListItem } from "./ui/launcher.js";
import { DEFAULT_TUI_THEME, TUI_THEMES, resolveTheme, tuiTheme } from "./ui/themes.js";
import { glyphsFor, termCaps } from "./ui/term.js";
import { frameDims } from "./ui/layout.js";

type ProviderId = "ares" | "ollama" | "openai" | "anthropic" | "deepseek" | "openrouter" | "mock";
type LauncherPhase = "provider" | "ollama" | "openai" | "theme" | "workspace";

const PROVIDER_OPTIONS: Array<{ id: ProviderId; title: string; body: string; footer: string }> = [
  { id: "ares", title: "In-House", body: "The Ares account — frontier models on us, one balance, no keys.", footer: "account" },
  { id: "ollama", title: "Ollama Cloud", body: "Cloud and local Ollama models with tool support.", footer: "cloud/local" },
  { id: "openai", title: "OpenAI", body: "Responses backend using your ChatGPT OAuth login.", footer: "OAuth" },
  { id: "anthropic", title: "Anthropic", body: "Claude API models using your saved Anthropic key.", footer: "API key" },
  { id: "deepseek", title: "DeepSeek", body: "Official DeepSeek long-context coding models.", footer: "API key" },
  { id: "openrouter", title: "OpenRouter", body: "Use any OpenRouter model id saved in settings.", footer: "API key" },
];
// `mock` stays a valid ProviderId (tests + installer smoke via `--provider mock`)
// but is intentionally OFF the interactive grid — a new user should never pick it.

export type LauncherAction =
  | {
      kind: "chat";
      provider: ProviderId;
      model: string;
      theme: ThemeName;
      /** The TUI face picked in the launcher — persisted with the model choice. */
      tuiTheme?: string;
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

const h = React.createElement;

const GLYPHS = glyphsFor();

type ProviderReadiness = "ready" | "needs-key" | "oauth";

/** Can this provider actually run a turn right now? Surfaced on the picker so a
 *  new user never selects a keyless provider and fails on their first message. */
function providerReadiness(id: ProviderId, settings: UiSettings): ProviderReadiness {
  switch (id) {
    case "mock":
      return "ready";
    case "ares":
      // The house account: ready once connected (a gateway token is saved),
      // otherwise it's a sign-in (the click-to-connect account flow).
      return settings.aresGatewayToken ? "ready" : "oauth";
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
  // Plain-output theme rides along unchanged; the TUI face is `tuiThemeId`.
  const selectedTheme: ThemeName = currentThemeName();
  const [tuiThemeId, setTuiThemeId] = useState<string>(options.settings.tuiTheme ?? DEFAULT_TUI_THEME);
  const [favoriteOllama, setFavoriteOllama] = useState<string[]>(options.settings.favoriteOllamaModels ?? []);
  const [favoriteOpenAI, setFavoriteOpenAI] = useState<string[]>(options.settings.favoriteOpenAIModels ?? []);
  const [workspace, setWorkspace] = useState(options.workspace);
  const [workspaceDraft, setWorkspaceDraft] = useState(options.workspace);
  const previousPhase = useRef<LauncherPhase>("provider");
  const theme = resolveTheme(tuiThemeId, termCaps().colorLevel);
  const currentProvider = PROVIDER_OPTIONS[Math.min(selectedProvider, PROVIDER_OPTIONS.length - 1)]?.id ?? "ollama";

  // One slow clock for the cursor blink (workspace input). Static without motion.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!motionEnabled()) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);
  const [ollamaLiveTick, setOllamaLiveTick] = useState(0);
  useEffect(() => {
    void refreshLiveOllamaModels(options.settings).then((live) => {
      if (live) setOllamaLiveTick((tick) => tick + 1); // force ollamaModels() re-derivation once live data lands
    });
  }, [options.settings]);
  useEffect(() => {
    // Every other provider: the daemon's live catalog, merged when it lands.
    void refreshLiveProviderModels(currentProvider).then((live) => {
      if (live) setOllamaLiveTick((tick) => tick + 1);
    });
  }, [currentProvider]);
  const providerModels = useMemo(() => providerModelList(currentProvider, options.settings), [currentProvider, options.settings, ollamaLiveTick]);
  const models = useMemo(() => reorderWithFavorites(ollamaModels(), favoriteOllama), [favoriteOllama, ollamaLiveTick]);
  const selectedModel = models[Math.min(selectedOllama, Math.max(0, models.length - 1))] ?? models[0];
  const selectedOpenAIModel = providerModels[Math.min(selectedOpenAI, Math.max(0, providerModels.length - 1))] ?? defaultModelForProvider(currentProvider, options.settings);
  const maxVisibleModels = listCapacity(frameDims(columns, rows, !termCaps().legacyConsole).height);
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
  function handleMouseEvent(raw: TerminalMouseEvent) {
    const event: TerminalMouseEvent = raw;
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
      const hit = event.y - LIST_FIRST_ROW;
      if (hit >= 0 && hit < PROVIDER_OPTIONS.length) {
        if (hit === selectedProvider) {
          // Second click on the selected row = confirm (the footer's contract).
          setPhase(PROVIDER_OPTIONS[hit].id === "ollama" ? "ollama" : "openai");
          setSelectedOpenAI(0);
        } else {
          setSelectedProvider(hit);
        }
      }
      return;
    }
    if (phase === "ollama") {
      const absolute = modelWindow.start + event.y - LIST_FIRST_ROW;
      if (absolute >= 0 && absolute < models.length) {
        if (absolute === selectedOllama && models[absolute]) {
          finish({
            kind: "chat",
            provider: "ollama",
            model: models[absolute].id,
            theme: selectedTheme,
            tuiTheme: tuiThemeId,
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
      const absolute = openAIWindow.start + event.y - LIST_FIRST_ROW;
      if (absolute >= 0 && absolute < providerModels.length) {
        if (absolute === selectedOpenAI) {
          finish({
            kind: "chat",
            provider: currentProvider,
            model: providerModels[absolute] ?? defaultModelForProvider(currentProvider, options.settings),
            theme: selectedTheme,
            tuiTheme: tuiThemeId,
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
      const pick = TUI_THEMES[event.y - LIST_FIRST_ROW];
      if (pick) {
        setTuiThemeId(pick.id);
        void options.onSettingsChange?.({ tuiTheme: pick.id });
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
      // Themes preview LIVE as you move; enter / number keys commit + persist.
      const idx = Math.max(0, TUI_THEMES.findIndex((t) => t.id === tuiThemeId));
      const commit = (id: string) => {
        setTuiThemeId(id);
        void options.onSettingsChange?.({ tuiTheme: id });
        setPhase(previousPhase.current);
      };
      if (/^[1-9]$/.test(value)) {
        const pick = TUI_THEMES[Number(value) - 1];
        if (pick) commit(pick.id);
        return;
      }
      if (previousKey) setTuiThemeId(TUI_THEMES[(idx - 1 + TUI_THEMES.length) % TUI_THEMES.length].id);
      if (nextKey) setTuiThemeId(TUI_THEMES[(idx + 1) % TUI_THEMES.length].id);
      if (key.return) commit(tuiThemeId);
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
          tuiTheme: tuiThemeId,
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
          tuiTheme: tuiThemeId,
          workspace,
          favoriteOllamaModels: favoriteOllama,
          favoriteOpenAIModels: favoriteOpenAI,
        });
      }
    }
  });

  const { width: frameW, height: frameH } = frameDims(columns, rows, !termCaps().legacyConsole);
  const g = GLYPHS;
  const status = (r: ProviderReadiness): { text: string; color: string } =>
    r === "ready" ? { text: `${g.dot} ready`, color: theme.success } : r === "oauth" ? { text: `${g.half} sign in`, color: theme.secondary } : { text: `${g.ring} no key`, color: theme.danger };
  const themeLabel = tuiTheme(tuiThemeId).label.toLowerCase();
  const sep = g.sep;
  const base = { theme, glyphs: g, width: frameW, height: frameH, workspace, themeLabel };

  let screen;
  if (phase === "provider") {
    const ready = providerReadiness(currentProvider, options.settings);
    screen = launcherRows({
      ...base,
      title: "Choose a provider",
      section: "Providers",
      subtitle:
        ready === "needs-key"
          ? `${currentProvider} needs an API key — start it and run  /key ${currentProvider} <paste>  — or pick a ready provider.`
          : ready === "oauth"
            ? "OpenAI uses your ChatGPT sign-in — press l to log in first."
            : "Ready to chat. Enter opens the model list.",
      items: PROVIDER_OPTIONS.map<ListItem>((p) => ({ key: p.id, label: p.title, detail: p.body, status: status(providerReadiness(p.id, options.settings)), current: p.id === options.settings.lastProvider })),
      selected: selectedProvider,
      footer: `enter open${sep}1-6 jump${sep}a/d move${sep}l login${sep}d doctor${sep}h help${sep}t theme${sep}w workspace${sep}q quit`,
    });
  } else if (phase === "ollama" || phase === "openai") {
    const isOllama = phase === "ollama";
    const win = isOllama ? modelWindow : openAIWindow;
    const all = isOllama ? models.map((m) => ({ id: m.id, label: cleanModelName(m.id), hint: m.hint })) : providerModels.map((m) => ({ id: m, label: m, hint: "" }));
    const favs = isOllama ? favoriteOllama : currentProvider === "openai" ? favoriteOpenAI : [];
    const last = isOllama ? options.settings.lastOllamaModel : defaultModelForProvider(currentProvider, options.settings);
    screen = launcherRows({
      ...base,
      title: isOllama ? "Ollama Cloud" : providerLabel(currentProvider),
      section: "Models",
      subtitle: isOllama ? "Cloud tags launch under the hood; clean names stay on the list." : providerHint(currentProvider),
      items: all.slice(win.start, win.end).map<ListItem>((m) => ({ key: m.id, label: m.label, hint: m.hint, favorite: favs.includes(m.id), current: m.id === last })),
      selected: (isOllama ? selectedOllama : selectedOpenAI) - win.start,
      scroll: win.start,
      total: all.length,
      footer: `enter launch${sep}1-9 pick (again launches)${sep}a/d move${sep}pgup/pgdn jump${sep}f favorite${sep}p providers${sep}t theme${sep}q back`,
    });
  } else if (phase === "theme") {
    screen = launcherRows({
      ...base,
      title: "Theme",
      section: "Appearance",
      subtitle: "Move to preview live. Enter keeps it — every screen wears it.",
      items: TUI_THEMES.map<ListItem>((t) => ({
        key: t.id,
        label: t.label,
        detail: t.tagline,
        swatch: [t.truecolor.primary, t.truecolor.secondary, t.truecolor.active, t.truecolor.success, t.truecolor.danger].map((c, i) => (termCaps().colorLevel >= 2 ? c : [t.ansi.primary, t.ansi.secondary, t.ansi.active, t.ansi.success, t.ansi.danger][i])),
        current: t.id === (options.settings.tuiTheme ?? DEFAULT_TUI_THEME),
      })),
      selected: Math.max(0, TUI_THEMES.findIndex((t) => t.id === tuiThemeId)),
      footer: `enter keep${sep}1-6 pick${sep}a/d preview${sep}esc back`,
    });
  } else {
    screen = launcherRows({
      ...base,
      title: "Workspace",
      section: "Workspace",
      subtitle: "Type a folder path. Enter accepts, Esc cancels.",
      items: [],
      selected: 0,
      input: { value: workspaceDraft, cursorOn: !motionEnabled() || tick % 2 === 0 },
      footer: `enter accept${sep}esc cancel`,
    });
  }
  return h(RowsView, { rows: screen, width: frameW });
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
  // ollama.com/api/tags is public: the cloud catalog shows even before a key is
  // pasted, so the picker never lags the cloud by a hand-edit.
  const apiKey = settings.ollamaApiKey || process.env.OLLAMA_API_KEY;
  return fetch("https://ollama.com/api/tags", {
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
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

// Live provider catalogs for the TUI picker. The daemon's catalog is live for
// every provider (Anthropic via key or Claude sign-in, OpenAI, DeepSeek, Kimi,
// OpenRouter, the gateway); the hardcoded rows below are only what shows in
// the first second and when offline. Without this, the TUI's Anthropic list
// was a stale hand-edit that never learned about a new release.
const liveProviderModels = new Map<string, string[]>();
const liveProviderFetchStarted = new Set<string>();

export function refreshLiveProviderModels(provider: string): Promise<string[] | null> {
  if (provider === "ollama" || provider === "mock" || provider === "custom") return Promise.resolve(null);
  if (liveProviderFetchStarted.has(provider)) return Promise.resolve(liveProviderModels.get(provider) ?? null);
  liveProviderFetchStarted.add(provider);
  return import("./entry/providers.js")
    .then(({ daemonModelCatalog }) => daemonModelCatalog(provider))
    .then((rows) => {
      const ids = rows.map((r) => r.id).filter((id) => typeof id === "string" && id.length > 0);
      if (!ids.length) return null;
      liveProviderModels.set(provider, ids);
      return ids;
    })
    .catch(() => null);
}

function providerModelList(provider: ProviderId, settings: UiSettings): string[] {
  if (provider === "ares") return unique([settings.lastAresModel, "ares-internal"]);
  if (provider === "ollama") return ollamaModels().map((model) => model.id);
  if (provider === "openai") return openAIModelList(settings);
  const live = liveProviderModels.get(provider);
  if (provider === "anthropic") {
    return unique([
      settings.lastAnthropicModel,
      ...(live ?? ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]),
    ]);
  }
  if (provider === "deepseek") {
    return unique([settings.lastDeepSeekModel, ...(live ?? ["deepseek-flash", "deepseek-v4-pro"])]);
  }
  if (live && live.length) return unique([...live]);
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
  if (provider === "ares") return "The Ares account — frontier models billed to your balance, no keys to manage. Connect your account to sign in.";
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
