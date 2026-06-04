import { mkdir } from "node:fs/promises";
import path from "node:path";
import { agentPaths, crixAgentHome } from "./paths.js";
import { readTextIfExists, writeFileAtomic } from "./files.js";

export interface CrixAgentConfig {
  slots: {
    reasoner: SlotConfig;
    apply: SlotConfig;
    summarize: SlotConfig;
    embed: SlotConfig & { device?: string };
  };
  memory: {
    dbPath: string;
    jsonFallbackPath: string;
    dimensions: number;
    embedModel: string;
    fallbackToFlat: boolean;
    maxResults: number;
  };
  heartbeat: {
    every: string;
    activeHours: { start: string; end: string };
    skipWhenBusy: boolean;
    ackMaxChars: number;
  };
  dreaming: {
    enabled: boolean;
    light: "session-end";
    deep: string;
    rem: string;
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
    soulRewriteThreshold: number;
  };
}

export interface SlotConfig {
  provider: string;
  model: string;
  host?: string;
}

export function defaultAgentConfig(home = crixAgentHome()): CrixAgentConfig {
  const paths = agentPaths(home);
  return {
    slots: {
      reasoner: { provider: "openai-oauth", model: "gpt-5.5" },
      apply: { provider: "openai-oauth", model: "gpt-5.1-codex" },
      summarize: { provider: "ollama-local", model: "gemma4:26b", host: "http://localhost:11434" },
      embed: { provider: "ollama-local", model: "bge-m3", host: "http://localhost:11434", device: "cuda:1" },
    },
    memory: {
      dbPath: paths.vectorsDb,
      jsonFallbackPath: paths.vectorsJson,
      dimensions: 1024,
      embedModel: "bge-m3",
      fallbackToFlat: true,
      maxResults: 8,
    },
    heartbeat: {
      every: "30m",
      activeHours: { start: "08:00", end: "23:00" },
      skipWhenBusy: true,
      ackMaxChars: 300,
    },
    dreaming: {
      enabled: true,
      light: "session-end",
      deep: "0 3 * * *",
      rem: "0 5 * * 0",
      minScore: 0.55,
      minRecallCount: 2,
      minUniqueQueries: 2,
      soulRewriteThreshold: 3,
    },
  };
}

export async function loadAgentConfig(home = crixAgentHome()): Promise<CrixAgentConfig> {
  const defaults = defaultAgentConfig(home);
  const paths = agentPaths(home);
  const raw = await readTextIfExists(paths.config, 1_000_000);
  if (!raw) {
    await mkdir(home, { recursive: true });
    await writeFileAtomic(paths.config, JSON.stringify(defaults, null, 2) + "\n");
    return defaults;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CrixAgentConfig>;
    return mergeConfig(defaults, parsed);
  } catch {
    return defaults;
  }
}

function mergeConfig(defaults: CrixAgentConfig, parsed: Partial<CrixAgentConfig>): CrixAgentConfig {
  return {
    ...defaults,
    ...parsed,
    slots: {
      ...defaults.slots,
      ...parsed.slots,
      reasoner: { ...defaults.slots.reasoner, ...parsed.slots?.reasoner },
      apply: { ...defaults.slots.apply, ...parsed.slots?.apply },
      summarize: { ...defaults.slots.summarize, ...parsed.slots?.summarize },
      embed: { ...defaults.slots.embed, ...parsed.slots?.embed },
    },
    memory: { ...defaults.memory, ...parsed.memory },
    heartbeat: {
      ...defaults.heartbeat,
      ...parsed.heartbeat,
      activeHours: { ...defaults.heartbeat.activeHours, ...parsed.heartbeat?.activeHours },
    },
    dreaming: { ...defaults.dreaming, ...parsed.dreaming },
  };
}

export function expandHomePath(file: string, home = crixAgentHome()): string {
  if (file.startsWith("~/.crix")) return path.join(home, file.slice("~/.crix".length));
  return file.replace(/^~(?=$|[\\/])/, path.dirname(home));
}

