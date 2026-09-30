// The stdio connector catalog: free, maintained MCP servers that run ON the
// garrison (npx / uvx / docker) instead of being reached over the network.
//
// Every entry here was launched and answered `tools/list` under the connector
// doctor (`ares connectors doctor`) before it was added — that is the entry
// bar, and the doctor re-proves it on demand and daily. `cost` is honest:
//   free           no account, no key
//   free-tier      a free account / key is needed (and its free quota applies)
//   needs-account  works against an account or service the owner already runs
//
// The schema mirrors mcpCatalog.ts (id, name, category, blurb, keywords, docs)
// plus what a LOCAL process needs: the command, the values the connect form
// must collect (`fields`) and where each lands (`env` var or an `arg`).
// Secrets never touch mcp.json: the hub stores them in the encrypted vault and
// the entry records only `envVault` names (see installStdioConnector).

import { promises as fs } from "node:fs";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpCategory } from "./mcpCatalog.js";
import type { ConnectService } from "./connectServices.js";

export type StdioRuntime = "npx" | "uvx" | "docker";
export type StdioCost = "free" | "free-tier" | "needs-account";

export interface StdioField {
  /** Short key, unique within the entry. */
  name: string;
  label: string;
  /** Where the collected value lands. */
  target: { env: string } | { arg: string };
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  /** What the doctor substitutes (a scratch dir, a dummy token). */
  probe: string;
}

export interface McpStdioEntry {
  id: string;
  name: string;
  category: McpCategory;
  blurb: string;
  keywords: string[];
  runtime: StdioRuntime;
  command: string;
  /** Static args; `{arg-name}` tokens are replaced by the matching `arg` field. */
  args: string[];
  fields?: StdioField[];
  cost: StdioCost;
  /** Where the owner gets the key / account when `cost` is not "free". */
  keyUrl?: string;
  docs?: string;
  /** Extra time the doctor allows on a cold cache (browsers, big packages). */
  coldStartMs?: number;
}

const NPX = "npx";

export const MCP_STDIO_CATALOG: McpStdioEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem (scoped)",
    category: "productivity",
    blurb: "Read, search and edit files inside ONE folder you choose. Nothing outside it is reachable.",
    keywords: ["filesystem mcp", "scoped filesystem", "give access to a folder", "notes folder"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{dir}"],
    fields: [{ name: "dir", label: "Folder to expose", target: { arg: "dir" }, placeholder: "/home/you/notes", help: "Absolute path. Only this folder (and below) is reachable.", probe: "{scratch}/files" }],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  {
    id: "memory",
    name: "Knowledge-graph memory",
    category: "ai",
    blurb: "A small persistent knowledge graph (entities, relations, observations) the agent can write to.",
    keywords: ["knowledge graph", "graph memory", "remember entities"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-memory"],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "sequential-thinking",
    name: "Sequential thinking",
    category: "ai",
    blurb: "Structured step-by-step reasoning scratchpad with revision and branching.",
    keywords: ["sequential thinking", "step by step", "reasoning scratchpad"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "sqlite",
    name: "SQLite",
    category: "data",
    blurb: "Query and modify a SQLite database file.",
    keywords: ["sqlite", "sql lite", "sqlite database", "local database"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "mcp-server-sqlite-npx", "{db}"],
    fields: [{ name: "db", label: "Database file", target: { arg: "db" }, placeholder: "/home/you/data.db", help: "Created if it does not exist.", probe: "{scratch}/probe.db" }],
    cost: "free",
    docs: "https://www.npmjs.com/package/mcp-server-sqlite-npx",
  },
  {
    id: "postgres",
    name: "PostgreSQL (read-only)",
    category: "data",
    blurb: "Inspect schemas and run read-only SQL against a Postgres database.",
    keywords: ["postgres", "postgresql", "psql", "sql database"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-postgres", "{url}"],
    fields: [{ name: "url", label: "Connection string", target: { arg: "url" }, secret: true, placeholder: "postgresql://user:pass@host:5432/db", help: "Stored encrypted. Use a read-only role.", probe: "postgresql://doctor:doctor@127.0.0.1:1/doctor" }],
    cost: "needs-account",
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-postgres",
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo search",
    category: "search",
    blurb: "Web search and page fetch with no API key.",
    keywords: ["duckduckgo", "ddg", "free web search"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "duckduckgo-mcp-server"],
    cost: "free",
    docs: "https://www.npmjs.com/package/duckduckgo-mcp-server",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    category: "search",
    blurb: "Web, news, image and local search (free tier: about 2,000 queries a month).",
    keywords: ["brave search", "brave", "web search api"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@brave/brave-search-mcp-server"],
    fields: [{ name: "key", label: "Brave Search API key", target: { env: "BRAVE_API_KEY" }, secret: true, placeholder: "BSA…", help: "Free tier at brave.com/search/api.", probe: "doctor-placeholder-brave-key" }],
    cost: "free-tier",
    keyUrl: "https://brave.com/search/api/",
    docs: "https://github.com/brave/brave-search-mcp-server",
  },
  {
    id: "playwright",
    name: "Playwright browser",
    category: "dev",
    blurb: "Drive a real headless browser: navigate, click, fill forms, snapshot pages.",
    keywords: ["playwright", "browser automation", "headless browser"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@playwright/mcp@latest", "--headless"],
    cost: "free",
    coldStartMs: 90_000,
    docs: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "youtube-transcript",
    name: "YouTube transcripts",
    category: "docs",
    blurb: "Fetch the transcript of any YouTube video by URL.",
    keywords: ["youtube transcript", "youtube captions", "video transcript", "summarize a youtube video"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@kimtaeyoon83/mcp-server-youtube-transcript"],
    cost: "free",
    docs: "https://github.com/kimtaeyoon83/mcp-server-youtube-transcript",
  },
  {
    id: "obsidian",
    name: "Obsidian / Markdown vault",
    category: "docs",
    blurb: "Read, search and write notes in an Obsidian vault or any folder of Markdown.",
    keywords: ["obsidian", "markdown vault", "notes vault"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@mauricio.wolff/mcp-obsidian", "{vault}"],
    fields: [{ name: "vault", label: "Vault folder", target: { arg: "vault" }, placeholder: "/home/you/Obsidian/Vault", probe: "{scratch}/vault" }],
    cost: "free",
    docs: "https://github.com/bitbonsai/mcp-obsidian",
  },
  {
    id: "open-meteo",
    name: "Open-Meteo weather",
    category: "search",
    blurb: "Forecasts, history and air quality worldwide. No key.",
    keywords: ["open-meteo", "weather forecast", "weather api", "air quality"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "open-meteo-mcp-server"],
    cost: "free",
    docs: "https://www.npmjs.com/package/open-meteo-mcp-server",
  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    category: "deploy",
    blurb: "Inspect and manage clusters through your existing kubeconfig.",
    keywords: ["kubernetes", "k8s", "kubectl"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "mcp-server-kubernetes"],
    cost: "needs-account",
    docs: "https://github.com/Flux159/mcp-server-kubernetes",
  },
  {
    id: "slack-bot",
    name: "Slack (bot token)",
    category: "comms",
    blurb: "Read channels, post and reply using a Slack bot token. The token route needs no OAuth app review.",
    keywords: ["slack bot", "slack token", "slack workspace"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-slack"],
    fields: [
      { name: "token", label: "Bot token", target: { env: "SLACK_BOT_TOKEN" }, secret: true, placeholder: "xoxb-…", help: "api.slack.com/apps → your app → OAuth & Permissions.", probe: "xoxb-doctor-placeholder-token" },
      { name: "team", label: "Team ID", target: { env: "SLACK_TEAM_ID" }, placeholder: "T0123456789", probe: "T00000000" },
    ],
    cost: "needs-account",
    keyUrl: "https://api.slack.com/apps",
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-slack",
  },
  {
    id: "discord-bot",
    name: "Discord (bot token)",
    category: "comms",
    blurb: "Read and send messages in servers your Discord bot is in.",
    keywords: ["discord", "discord bot", "discord server"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "mcp-discord"],
    fields: [{ name: "token", label: "Bot token", target: { env: "DISCORD_TOKEN" }, secret: true, help: "discord.com/developers/applications → Bot → Reset Token.", probe: "doctor-placeholder-discord-token" }],
    cost: "needs-account",
    keyUrl: "https://discord.com/developers/applications",
    docs: "https://github.com/barryyip0625/mcp-discord",
  },
  {
    id: "notion-token",
    name: "Notion (integration token)",
    category: "docs",
    blurb: "Notion through an internal integration token (works headless; no phone sign-in needed).",
    keywords: ["notion token", "notion integration"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@notionhq/notion-mcp-server"],
    fields: [{ name: "token", label: "Integration token", target: { env: "NOTION_TOKEN" }, secret: true, placeholder: "ntn_… or secret_…", help: "notion.so/profile/integrations → New integration; share pages with it.", probe: "ntn_doctor_placeholder_token_0000000000" }],
    cost: "needs-account",
    keyUrl: "https://www.notion.so/profile/integrations",
    docs: "https://github.com/makenotion/notion-mcp-server",
  },
  {
    id: "gitlab-token",
    name: "GitLab (access token)",
    category: "dev",
    blurb: "Projects, issues and merge requests on GitLab.com or your own GitLab.",
    keywords: ["gitlab token", "self hosted gitlab"],
    runtime: "npx",
    command: NPX,
    args: ["-y", "@modelcontextprotocol/server-gitlab"],
    fields: [
      { name: "token", label: "Personal access token", target: { env: "GITLAB_PERSONAL_ACCESS_TOKEN" }, secret: true, placeholder: "glpat-…", probe: "glpat-doctor-placeholder-0000" },
    ],
    cost: "needs-account",
    keyUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    docs: "https://www.npmjs.com/package/@modelcontextprotocol/server-gitlab",
  },
  // ── Python servers (uvx) ────────────────────────────────────────────────
  {
    id: "git",
    name: "Git",
    category: "dev",
    blurb: "Read and operate on a local git repository: status, diff, log, commit, branch.",
    keywords: ["git mcp", "local git repo", "git log", "git diff"],
    runtime: "uvx",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "{repo}"],
    fields: [{ name: "repo", label: "Repository path", target: { arg: "repo" }, placeholder: "/home/you/project", probe: "{scratch}/repo" }],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "fetch",
    name: "Fetch (web pages to markdown)",
    category: "search",
    blurb: "Fetch any URL and return it as clean markdown.",
    keywords: ["fetch mcp", "web fetch", "read a url as markdown"],
    runtime: "uvx",
    command: "uvx",
    args: ["mcp-server-fetch"],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "time",
    name: "Time & timezones",
    category: "productivity",
    blurb: "Current time anywhere and timezone conversion.",
    keywords: ["timezone mcp", "what time is it in", "convert time zones"],
    runtime: "uvx",
    command: "uvx",
    args: ["mcp-server-time"],
    cost: "free",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
  },
  {
    id: "docker",
    name: "Docker",
    category: "deploy",
    blurb: "List, inspect, run and manage containers, images, networks and volumes on this host.",
    keywords: ["docker", "docker containers", "docker compose"],
    runtime: "uvx",
    command: "uvx",
    args: ["mcp-server-docker"],
    cost: "needs-account",
    docs: "https://github.com/ckreiling/mcp-server-docker",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function stdioEntryById(id: string): McpStdioEntry | undefined {
  return MCP_STDIO_CATALOG.find((e) => e.id === id);
}

/** Vault credential a field's value is stored under. */
export function stdioFieldCredential(entry: McpStdioEntry, field: StdioField): string {
  return `mcp.stdio.${entry.id}.${field.name}`;
}

/** The marker credential that records "this stdio server is installed". */
export function stdioMarkerCredential(id: string): string {
  return `mcp.stdio.${id}`;
}

let runtimeCache = new Map<string, boolean>();

/** Is `bin` on PATH? Sync + cached: CONNECT_SERVICES is built at import time. */
export function binaryOnPath(bin: string, pathEnv: string | undefined = process.env.PATH): boolean {
  const key = `${bin}@${pathEnv ?? ""}`;
  const hit = runtimeCache.get(key);
  if (hit !== undefined) return hit;
  let found = false;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(path.join(dir, bin + ext), fsConstants.X_OK);
        found = true;
        break;
      } catch {
        // keep looking
      }
    }
    if (found) break;
  }
  runtimeCache.set(key, found);
  return found;
}

/** Test seam: forget cached PATH lookups. */
export function resetBinaryCache(): void {
  runtimeCache = new Map();
}

export function stdioRuntimeAvailable(entry: McpStdioEntry): boolean {
  return binaryOnPath(entry.command);
}

/** Replace `{name}` (arg values) and `{scratch}` tokens in an args template. */
export function renderStdioArgs(entry: McpStdioEntry, values: Record<string, string>, scratch = ""): string[] {
  return entry.args.map((a) => a.replace(/\{([a-z0-9-]+)\}/gi, (_m, k: string) => (k === "scratch" ? scratch : (values[k] ?? ""))));
}

/** Split collected values into literal env and vault-backed env. Args are
 *  rendered by installStdioConnector (secret args become ${VAULT:name}). */
export function resolveStdioValues(entry: McpStdioEntry, values: Record<string, string>): { env: Record<string, string>; envVault: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const envVault: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of entry.fields ?? []) {
    const v = (values[f.name] ?? "").trim();
    if (!v) {
      if (!f.optional) missing.push(f.label);
      continue;
    }
    if ("env" in f.target) {
      if (f.secret) envVault[f.target.env] = stdioFieldCredential(entry, f);
      else env[f.target.env] = v;
    }
  }
  return { env, envVault, missing };
}

function homeDir(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

function mcpConfigPath(home?: string): string {
  return path.join(homeDir(home), "mcp.json");
}

/** Register (or refresh) a catalog server in ~/.ares/mcp.json. Secret env
 *  values are NOT written — `envVault` names the vault credentials the MCP
 *  client resolves at spawn. Atomic, and preserves every other entry. */
export async function installStdioConnector(entry: McpStdioEntry, values: Record<string, string>, home?: string): Promise<{ file: string }> {
  const file = mcpConfigPath(home);
  let doc: { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> } = {};
  try {
    doc = JSON.parse(await fs.readFile(file, "utf8")) as typeof doc;
  } catch {
    doc = {};
  }
  const key: "servers" | "mcpServers" = doc.mcpServers && !doc.servers ? "mcpServers" : "servers";
  const servers = (doc[key] ??= {}) as Record<string, unknown>;
  const resolved = resolveStdioValues(entry, values);
  // Secret ARG values (connection strings) never sit in mcp.json: the arg
  // carries a `${VAULT:NAME}` marker the MCP client expands at spawn.
  const args = entry.args.map((a) =>
    a.replace(/\{([a-z0-9-]+)\}/gi, (_m, k: string) => {
      const field = (entry.fields ?? []).find((f) => "arg" in f.target && f.target.arg === k);
      if (!field) return "";
      return field.secret ? `\${VAULT:${stdioFieldCredential(entry, field)}}` : (values[field.name] ?? "").trim();
    }),
  );
  servers[entry.id] = {
    command: entry.command,
    args,
    ...(Object.keys(resolved.env).length ? { env: resolved.env } : {}),
    ...(Object.keys(resolved.envVault).length ? { envVault: resolved.envVault } : {}),
    stdioCatalog: entry.id,
    connectedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  return { file };
}

/** Remove a catalog server from mcp.json. Returns whether an entry existed. */
export async function uninstallStdioConnector(id: string, home?: string): Promise<boolean> {
  const file = mcpConfigPath(home);
  try {
    const doc = JSON.parse(await fs.readFile(file, "utf8")) as { servers?: Record<string, unknown>; mcpServers?: Record<string, unknown> };
    let removed = false;
    for (const key of ["servers", "mcpServers"] as const) {
      const bucket = doc[key];
      if (bucket && id in bucket && (bucket[id] as { stdioCatalog?: string })?.stdioCatalog === id) {
        delete bucket[id];
        removed = true;
      }
    }
    if (removed) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await fs.rename(tmp, file);
    }
    return removed;
  } catch {
    return false;
  }
}

/** A catalog entry as a connect-hub service: a secure form (or a one-tap
 *  connect when the server needs nothing) that installs the local server. */
export function stdioConnectService(entry: McpStdioEntry): ConnectService {
  const fields = (entry.fields ?? []).map((f) => ({
    credential: stdioFieldCredential(entry, f),
    label: f.label + (f.optional ? " (optional)" : ""),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.secret ? { secret: true } : {}),
    ...(f.help ? { help: f.help } : {}),
  }));
  const free = entry.cost === "free" ? "Free, no account." : entry.cost === "free-tier" ? "Free tier; needs a key." : "Free; needs an existing account or service.";
  return {
    id: entry.id,
    label: entry.name,
    kind: "api-key",
    blurb: `${entry.blurb} ${free}`,
    keywords: entry.keywords,
    ...(entry.keyUrl ? { keyUrl: entry.keyUrl } : {}),
    ...(fields.length ? { fields } : {}),
    stores: [stdioMarkerCredential(entry.id)],
    ...(fields.length === 0 ? { formHint: `Runs locally on this Ares (${entry.runtime}). Tap Connect — Ares starts it once to make sure it answers.` } : {}),
    howToUse: `Its tools are live now: call McpListTools with server "${entry.id}" to see them, then McpCallTool (or the mcp_${entry.id}_* tools after a Connectors refresh).`,
  };
}

/** Stdio services the connect hub should offer on THIS machine (runtime present). */
export function stdioConnectServices(): ConnectService[] {
  return MCP_STDIO_CATALOG.filter(stdioRuntimeAvailable).map(stdioConnectService);
}
