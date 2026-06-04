import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { crixHome } from "@crix/core";
import type { ReasoningLevel } from "@crix/protocol";
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
}

export function uiSettingsPath(): string {
  return path.join(crixHome(), "ui.json");
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
