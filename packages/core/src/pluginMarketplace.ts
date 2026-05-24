import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { JsonRecord, JsonValue } from "@crix/protocol";
import type { McpServerDeclaration } from "./mcpClient.js";
import { crixHome } from "./openaiAuth.js";

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  source: "workspace" | "user";
  root: string;
  skills: string[];
  mcpServers: string[];
  tools: string[];
  raw: JsonRecord;
}

export interface PluginMarketplaceOptions {
  workspace: string;
  home?: string;
}

export class PluginMarketplace {
  constructor(private readonly options: PluginMarketplaceOptions) {}

  async list(): Promise<PluginManifest[]> {
    const roots = pluginRoots(this.options.workspace, this.options.home ?? crixHome());
    const manifests: PluginManifest[] = [];
    for (const root of roots) {
      manifests.push(...await manifestsFromRoot(root.path, root.source));
    }
    return dedupeManifests(manifests);
  }

  async mcpServers(): Promise<Array<{ pluginId: string; server: string; root: string }>> {
    return (await this.list()).flatMap((plugin) => plugin.mcpServers.map((server) => ({ pluginId: plugin.id, server, root: plugin.root })));
  }

  async mcpServerConfigs(): Promise<McpServerDeclaration[]> {
    return (await this.list()).flatMap((plugin) => mcpServerConfigs(plugin));
  }
}

async function manifestsFromRoot(root: string, source: "workspace" | "user"): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  const marketplace = path.join(root, "marketplace.json");
  if (existsSync(marketplace)) out.push(...await manifestsFromMarketplace(marketplace, root, source));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(root, entry.name, ".crix-plugin", "plugin.json");
    if (!existsSync(manifestPath)) continue;
    out.push(normalizeManifest(JSON.parse(await readFile(manifestPath, "utf8")) as JsonRecord, path.dirname(path.dirname(manifestPath)), source));
  }
  return out;
}

async function manifestsFromMarketplace(file: string, root: string, source: "workspace" | "user"): Promise<PluginManifest[]> {
  const raw = JSON.parse(await readFile(file, "utf8")) as JsonValue;
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.plugins) ? raw.plugins : [];
  const out: PluginManifest[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const pluginRoot = typeof row.path === "string" ? path.resolve(path.dirname(file), row.path) : path.join(root, String(row.id ?? row.name ?? ""));
    out.push(normalizeManifest(row as JsonRecord, pluginRoot, source));
  }
  return out;
}

function normalizeManifest(raw: JsonRecord, root: string, source: "workspace" | "user"): PluginManifest {
  const id = stringField(raw, "id") ?? stringField(raw, "name");
  if (!id) throw new Error(`plugin manifest at ${root} is missing id/name`);
  return {
    id,
    name: stringField(raw, "name") ?? id,
    version: stringField(raw, "version"),
    description: stringField(raw, "description"),
    enabled: raw.enabled !== false,
    source,
    root,
    skills: stringArray(raw.skills),
    mcpServers: mcpServerNames(raw.mcpServers ?? raw.mcp ?? raw.servers),
    tools: stringArray(raw.tools),
    raw,
  };
}

function pluginRoots(workspace: string, home: string): Array<{ path: string; source: "workspace" | "user" }> {
  return [
    { path: path.join(workspace, ".crix", "plugins"), source: "workspace" },
    { path: path.join(workspace, ".agents", "plugins"), source: "workspace" },
    { path: path.join(home, "plugins"), source: "user" },
  ];
}

function dedupeManifests(manifests: PluginManifest[]): PluginManifest[] {
  const byId = new Map<string, PluginManifest>();
  for (const manifest of manifests) {
    const existing = byId.get(manifest.id);
    if (!existing || (existing.source === "user" && manifest.source === "workspace")) byId.set(manifest.id, manifest);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function mcpServerNames(value: JsonValue | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item)) return [String(item.id ?? item.name ?? item.command ?? "")].filter(Boolean);
      return [];
    });
  }
  if (!isRecord(value)) return [];
  return Object.keys(value);
}

function mcpServerConfigs(plugin: PluginManifest): McpServerDeclaration[] {
  const raw = plugin.raw.mcpServers ?? plugin.raw.mcp ?? plugin.raw.servers;
  const rows: McpServerDeclaration[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const config = normalizeMcpServer(plugin, item);
      if (config) rows.push(config);
    }
    return rows;
  }
  if (isRecord(raw)) {
    for (const [name, value] of Object.entries(raw)) {
      const config = normalizeMcpServer(plugin, isRecord(value) ? { ...value, name } : { name, command: String(value ?? "") });
      if (config) rows.push(config);
    }
  }
  return rows;
}

function normalizeMcpServer(plugin: PluginManifest, raw: JsonValue): McpServerDeclaration | undefined {
  if (typeof raw === "string") {
    return { pluginId: plugin.id, id: raw, name: raw, root: plugin.root, raw: { name: raw } };
  }
  if (!isRecord(raw)) return undefined;
  const name = stringField(raw, "id") ?? stringField(raw, "name") ?? stringField(raw, "server") ?? stringField(raw, "command");
  if (!name) return undefined;
  const command = stringField(raw, "command");
  const args = stringArray(raw.args);
  const env = envRecord(raw.env);
  return {
    pluginId: plugin.id,
    id: name,
    name,
    root: plugin.root,
    command,
    args,
    cwd: stringField(raw, "cwd"),
    env,
    url: stringField(raw, "url"),
    raw,
  };
}

function envRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return Object.keys(out).length ? out : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
