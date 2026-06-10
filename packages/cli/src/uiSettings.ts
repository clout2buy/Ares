import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { aresHome } from "@ares/core";
import type { ReasoningLevel } from "@ares/protocol";
import type { RouteAssignments } from "@ares/core";
import type { ThemeName } from "./terminalUi.js";

export interface UiSettings {
  theme?: ThemeName;
  lastProvider?: "openai" | "ollama" | "mock";
  lastOpenAIModel?: string;
  lastOllamaModel?: string;
  favoriteOllamaModels?: string[];
  favoriteOpenAIModels?: string[];
  dangerousBypass?: boolean;
  /** Owner-selected reasoning dial (low→max). Applies across providers. */
  reasoningLevel?: ReasoningLevel;
  /** Owner-assigned per-lane model routing (chat/coding/research/tool-use). */
  routing?: RouteAssignments;
  /** OpenRouter API key (owner-pasted in-app). Bearer auth for openrouter.ai. */
  openRouterKey?: string;
  /** Last OpenRouter model id the owner selected. */
  lastOpenRouterModel?: string;
}

export function uiSettingsPath(): string {
  return path.join(aresHome(), "ui.json");
}

export async function loadUiSettings(): Promise<UiSettings> {
  try {
    const parsed = JSON.parse(await readFile(uiSettingsPath(), "utf8")) as UiSettings;
    return {
      ...parsed,
      favoriteOllamaModels: parsed.favoriteOllamaModels ?? [],
      favoriteOpenAIModels: parsed.favoriteOpenAIModels ?? [],
    };
  } catch {
    return { favoriteOllamaModels: [], favoriteOpenAIModels: [] };
  }
}

export async function saveUiSettings(settings: UiSettings): Promise<void> {
  const filePath = uiSettingsPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export async function updateUiSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
  const next = { ...(await loadUiSettings()), ...patch };
  await saveUiSettings(next);
  return next;
}
