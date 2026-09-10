// Live MCP tools: every connected server's tools become first-class engine
// tools with their real names and schemas — "Vercel · deploy_to_preview",
// not "McpCallTool wants to perform an external-state action".
//
// The engine reads its tool array on every turn, so the arrays handed to
// sessions are kept by reference and refilled in place when a connector is
// added, paused or removed: the next turn sees the new tools, no restart.
// A per-server tool cache (~/.ares/mcp-tools-cache.json) makes session start
// instant; a background refresh keeps it honest.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { emitLifecycle } from "@ares/agent";
import type { EngineTool, EngineToolResult, ToolCallContext } from "@ares/core";
import { MCP_CATALOG, catalogByUrl, catalogMentions, loadRemoteMcpServers, type McpCatalogEntry } from "@ares/core";
import { McpAuthError, buildTool, callMcpTool, listMcpServerToolsFull, listMcpServers, type McpToolDescriptor } from "@ares/tools";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MCP_TOOL_PREFIX = "mcp_";

interface CachedServer {
  url?: string;
  at: number;
  tools: McpToolDescriptor[];
  error?: string;
}

function cachePath(): string {
  return path.join(process.env.ARES_HOME || path.join(os.homedir(), ".ares"), "mcp-tools-cache.json");
}

async function readCache(): Promise<Record<string, CachedServer>> {
  try {
    return JSON.parse(await fs.readFile(cachePath(), "utf8")) as Record<string, CachedServer>;
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, CachedServer>): Promise<void> {
  await fs.mkdir(path.dirname(cachePath()), { recursive: true }).catch(() => undefined);
  await fs.writeFile(cachePath(), JSON.stringify(cache, null, 2) + "\n", "utf8").catch(() => undefined);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
}

/** JSON Schema that every provider accepts: an object schema, no `$schema`,
 *  no draft-07 tuple `items` arrays, and `additionalProperties` left alone. */
function sanitizeSchema(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const base: Record<string, unknown> = raw && typeof raw === "object" ? { ...raw } : {};
  delete base.$schema;
  delete base.$id;
  if (base.type !== "object") base.type = "object";
  if (!base.properties || typeof base.properties !== "object") base.properties = {};
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const o = { ...(node as Record<string, unknown>) };
    delete o.$schema;
    if (Array.isArray(o.items)) {
      // tuple form → a plain array of the first item type
      o.items = walk(o.items[0] ?? {});
    }
    for (const [k, v] of Object.entries(o)) o[k] = walk(v);
    return o;
  };
  return walk(base) as Record<string, unknown>;
}

export interface LiveMcpServerStatus {
  name: string;
  displayName: string;
  url?: string;
  toolCount: number;
  error?: string;
  fromCache: boolean;
}

class LiveMcpTools {
  private readonly arrays = new Set<EngineTool[]>();
  private current: EngineTool[] = [];
  private status: LiveMcpServerStatus[] = [];
  private refreshing: Promise<LiveMcpServerStatus[]> | null = null;
  private displayNames = new Map<string, string>();
  private urls = new Map<string, string>();
  /** Suggestions already raised this process, so a chat is nudged once. */
  readonly suggested = new Set<string>();

  /** Hand a session's tool array over; it is refilled in place on refresh. */
  attach(tools: EngineTool[]): void {
    this.arrays.add(tools);
    this.fill(tools);
  }

  detach(tools: EngineTool[]): void {
    this.arrays.delete(tools);
  }

  snapshot(): LiveMcpServerStatus[] {
    return this.status;
  }

  private fill(tools: EngineTool[]): void {
    for (let i = tools.length - 1; i >= 0; i--) {
      if ((tools[i] as EngineTool & { __mcp?: true }).__mcp) tools.splice(i, 1);
    }
    tools.push(...this.current);
  }

  /** Rebuild from the cache (fast) and, unless `cacheOnly`, from the servers. */
  refresh(workspace: string, opts: { cacheOnly?: boolean; force?: boolean } = {}): Promise<LiveMcpServerStatus[]> {
    if (this.refreshing && !opts.force) return this.refreshing;
    this.refreshing = this.doRefresh(workspace, opts).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(workspace: string, opts: { cacheOnly?: boolean; force?: boolean }): Promise<LiveMcpServerStatus[]> {
    const servers = await listMcpServers(workspace).catch(() => ({} as Record<string, { url?: string }>));
    const remote = await loadRemoteMcpServers().catch(() => ({} as Record<string, { displayName?: string; url?: string }>));
    const cache = await readCache();
    const now = Date.now();
    const next: EngineTool[] = [];
    const status: LiveMcpServerStatus[] = [];
    const names = new Set<string>();
    for (const [name, cfg] of Object.entries(servers)) {
      const url = typeof (cfg as { url?: string }).url === "string" ? (cfg as { url: string }).url : undefined;
      const display = remote[name]?.displayName ?? (url ? catalogByUrl(url)?.name : undefined) ?? name;
      this.displayNames.set(name, display);
      if (url) this.urls.set(name, url);
      const cached = cache[name];
      const fresh = cached && cached.url === url && now - cached.at < CACHE_TTL_MS && !opts.force;
      let tools: McpToolDescriptor[] | null = fresh ? cached.tools : null;
      let error: string | undefined;
      let fromCache = fresh;
      if (!tools && !opts.cacheOnly) {
        try {
          tools = await listMcpServerToolsFull(workspace, name, 20_000);
          cache[name] = { url, at: now, tools };
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          tools = cached?.tools ?? [];
          fromCache = Boolean(cached);
          cache[name] = { ...(cached ?? { at: 0, tools: [] }), url, error };
        }
      } else if (!tools) {
        tools = cached?.tools ?? [];
        fromCache = Boolean(cached);
      }
      for (const t of tools) {
        let toolName = `${MCP_TOOL_PREFIX}${slug(name)}_${slug(t.name)}`.slice(0, 64);
        let n = 2;
        while (names.has(toolName)) toolName = `${toolName.slice(0, 60)}_${n++}`;
        names.add(toolName);
        next.push(this.engineTool(toolName, name, display, url, t));
      }
      status.push({ name, displayName: display, ...(url ? { url } : {}), toolCount: tools.length, ...(error ? { error } : {}), fromCache });
    }
    if (!opts.cacheOnly) await writeCache(cache);
    this.current = next;
    this.status = status;
    for (const arr of this.arrays) this.fill(arr);
    return status;
  }

  private engineTool(toolName: string, server: string, display: string, url: string | undefined, t: McpToolDescriptor): EngineTool {
    const description = `${display} · ${t.name}${t.description ? ` — ${t.description}` : ""}`.slice(0, 1024);
    const tool: EngineTool & { __mcp: true } = {
      __mcp: true,
      schema: {
        name: toolName,
        description,
        inputJsonSchema: sanitizeSchema(t.inputSchema),
        safety: "external-state",
        concurrency: "exclusive",
        watchdogTimeoutMs: 120_000,
      },
      mayHaveEffects: true,
      async call(input: unknown, ctx: ToolCallContext): Promise<EngineToolResult> {
        const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
        try {
          const result = await callMcpTool(ctx.workspace, server, t.name, args, 90_000);
          return { output: result, display: `${display} · ${t.name}` };
        } catch (err) {
          if (err instanceof McpAuthError) {
            emitLifecycle({ type: "mcp_auth_required", server, displayName: display, ...(url ? { url } : {}) });
            throw new Error(`${display} needs to be connected again (its authorization expired or was revoked). Tell the owner to press Connect on the card that just appeared, then retry.`);
          }
          throw err;
        }
      },
    };
    return tool;
  }
}

export const liveMcpTools = new LiveMcpTools();

/** The Connectors tool: what Ares reaches for when a task needs a service.
 *  It can list what is connected and what is one click away, and it can put
 *  a "Connect <service>" card in front of the owner — it never connects on
 *  its own, because connecting opens the owner's browser to sign in. */
const connectorsInput = z
  .object({
    action: z.enum(["list", "suggest", "refresh"]).describe("list connected + available services; suggest asks the owner to connect one (a card with a Connect button); refresh re-reads every connected server's tools"),
    id: z.string().optional().describe("suggest: the catalog id (from list), e.g. 'vercel', 'github', 'notion'"),
    reason: z.string().max(200).optional().describe("suggest: one line on why — shown on the card"),
  })
  .strict();

export function makeConnectorsTool(getWorkspace: () => string) {
  return buildTool({
    name: "Connectors",
    description:
      "Services Ares can work through (MCP connectors): GitHub, Vercel, Linear, Notion, Stripe, Supabase, Figma and dozens more. " +
      "Use `list` to see what is connected (their tools are already in your tool list as mcp_<service>_<tool>) and what can be connected in one click. " +
      "When a task needs a service that is NOT connected, use `suggest` with its id and a reason: the owner gets a Connect button in the chat and signs in with OAuth — never ask them for API keys or tokens in the conversation. " +
      "After they connect, its tools appear on your next turn.",
    safety: "read-only",
    concurrency: "parallel-safe",
    inputZod: connectorsInput,
    activityDescription: (i) => `Connectors ${i.action}${i.id ? " " + i.id : ""}`,

    async call(i): Promise<{ output: unknown; display: string }> {
      const remote = await loadRemoteMcpServers().catch(() => ({} as Record<string, { url?: string; displayName?: string; enabled?: boolean }>));
      const connected = Object.entries(remote).map(([name, r]) => ({ name, displayName: r.displayName ?? catalogByUrl(r.url ?? "")?.name ?? name, url: r.url, enabled: r.enabled !== false, catalogId: catalogByUrl(r.url ?? "")?.id }));
      if (i.action === "refresh") {
        const status = await liveMcpTools.refresh(getWorkspace(), { force: true });
        return { output: status, display: status.map((s) => `${s.displayName}: ${s.toolCount} tools${s.error ? ` (${s.error})` : ""}`).join("\n") || "no connectors" };
      }
      if (i.action === "list") {
        const connectedIds = new Set(connected.map((c) => c.catalogId).filter(Boolean));
        const available = MCP_CATALOG.filter((e) => !connectedIds.has(e.id)).map((e) => ({ id: e.id, name: e.name, auth: e.auth, category: e.category, blurb: e.blurb }));
        const live = liveMcpTools.snapshot();
        return {
          output: { connected: connected.map((c) => ({ ...c, toolCount: live.find((l) => l.name === c.name)?.toolCount ?? null })), available },
          display: `${connected.length} connected: ${connected.map((c) => c.displayName).join(", ") || "none"} · ${available.length} one click away`,
        };
      }
      const entry = i.id ? MCP_CATALOG.find((e) => e.id === i.id) : undefined;
      if (!entry) throw new Error(`suggest needs a catalog id (one of: ${MCP_CATALOG.map((e) => e.id).join(", ")})`);
      if (connected.some((c) => c.catalogId === entry.id)) return { output: { alreadyConnected: true }, display: `${entry.name} is already connected` };
      emitLifecycle({ type: "mcp_suggest", id: entry.id, name: entry.name, url: entry.url, auth: entry.auth, reason: i.reason ?? "", by: "ares" });
      return { output: { suggested: entry.id }, display: `Asked the owner to connect ${entry.name} (a Connect card is in the chat). Continue with what you can do meanwhile; its tools arrive on your next turn once they connect.` };
    },
  });
}

/** For the turn pipeline: services the owner just mentioned that are not
 *  connected. Raised once per process per service, as a chat card. */
export async function suggestConnectorsFor(text: string): Promise<McpCatalogEntry[]> {
  const mentions = catalogMentions(text);
  if (!mentions.length) return [];
  const remote = await loadRemoteMcpServers().catch(() => ({} as Record<string, { url?: string }>));
  const connectedIds = new Set(Object.values(remote).map((r) => catalogByUrl(r.url ?? "")?.id).filter(Boolean));
  const out: McpCatalogEntry[] = [];
  for (const entry of mentions) {
    if (connectedIds.has(entry.id) || liveMcpTools.suggested.has(entry.id)) continue;
    liveMcpTools.suggested.add(entry.id);
    emitLifecycle({ type: "mcp_suggest", id: entry.id, name: entry.name, url: entry.url, auth: entry.auth, reason: "", by: "ares" });
    out.push(entry);
  }
  return out;
}
