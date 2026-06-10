// MCP — minimal stdio client tools.
//
// Loads servers from .ares/mcp.json and ~/.ares/mcp.json. The config shape
// mirrors common MCP clients:
// { "servers": { "name": { "command": "node", "args": ["server.js"], "env": {} } } }

import { z } from "zod";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTool } from "./_shared.js";

const listInputSchema = z
  .object({
    server: z.string().optional().describe("Optional server name. Omit to list configured servers and tools."),
    timeout_ms: z.number().int().positive().max(60_000).default(20_000),
  })
  .strict();

const callInputSchema = z
  .object({
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
    timeout_ms: z.number().int().positive().max(120_000).default(60_000),
  })
  .strict();

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpConfig {
  servers?: Record<string, McpServerConfig>;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpListOutput {
  configFiles: string[];
  servers: Array<{ name: string; tools?: unknown[]; error?: string }>;
}

export interface McpCallOutput {
  server: string;
  tool: string;
  result: unknown;
}

export const McpListToolsTool = buildTool({
  name: "McpListTools",
  description:
    "List MCP servers and their exposed tools from .ares/mcp.json and ~/.ares/mcp.json. Use before McpCallTool when the user configured MCP servers.",
  safety: "external-state",
  concurrency: "parallel-safe",
  inputZod: listInputSchema,
  activityDescription: (i) => (i.server ? `Listing MCP tools from ${i.server}` : "Listing MCP servers"),

  async call(i, ctx): Promise<{ output: McpListOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const selected = Object.entries(loaded.servers).filter(([name]) => !i.server || name === i.server);
    const servers: McpListOutput["servers"] = [];
    for (const [name, cfg] of selected) {
      try {
        const result = await withMcpClient(cfg, i.timeout_ms, async (client) => await client.request("tools/list", {}));
        servers.push({ name, tools: (result as { tools?: unknown[] }).tools ?? [] });
      } catch (err) {
        servers.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      output: { configFiles: loaded.configFiles, servers },
      display: `${servers.length} MCP server${servers.length === 1 ? "" : "s"}`,
    };
  },
});

export const McpCallTool = buildTool({
  name: "McpCallTool",
  description:
    "Call a tool exposed by a configured MCP stdio server. Run McpListTools first to discover available tools and schemas.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: callInputSchema,
  activityDescription: (i) => `MCP ${i.server}/${i.tool}`,

  async call(i, ctx): Promise<{ output: McpCallOutput; display: string }> {
    const loaded = await loadMcpConfig(ctx.workspace);
    const cfg = loaded.servers[i.server];
    if (!cfg) throw new Error(`Unknown MCP server: ${i.server}`);
    const result = await withMcpClient(
      cfg,
      i.timeout_ms,
      async (client) =>
        await client.request("tools/call", {
          name: i.tool,
          arguments: i.arguments,
        }),
    );
    return {
      output: { server: i.server, tool: i.tool, result },
      display: `called ${i.server}/${i.tool}`,
    };
  },
});

async function loadMcpConfig(workspace: string): Promise<{ servers: Record<string, McpServerConfig>; configFiles: string[] }> {
  const home = process.env.ARES_HOME || path.join(os.homedir(), ".ares");
  const candidates = [path.join(home, "mcp.json"), path.join(workspace, ".ares", "mcp.json")];
  const servers: Record<string, McpServerConfig> = {};
  const configFiles: string[] = [];
  for (const file of candidates) {
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8")) as McpConfig;
      Object.assign(servers, json.servers ?? json.mcpServers ?? {});
      configFiles.push(file);
    } catch {
      // absent or invalid; ignore here so the tool still reports what is available
    }
  }
  return { servers, configFiles };
}

class StdioMcpClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      void chunk;
    });
    child.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("MCP server exited before replying"));
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ares", version: "0.3.0-alpha.1" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.writeMessage(msg);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private writeMessage(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lenMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lenMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(JSON.parse(body) as { id?: number; result?: unknown; error?: { message?: string } });
    }
  }

  private handleMessage(msg: { id?: number; result?: unknown; error?: { message?: string } }): void {
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
    else pending.resolve(msg.result);
  }
}

async function withMcpClient<T>(
  cfg: McpServerConfig,
  timeoutMs: number,
  fn: (client: StdioMcpClient) => Promise<T>,
): Promise<T> {
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env ?? {}) },
    windowsHide: true,
  });
  const client = new StdioMcpClient(child);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        await client.initialize();
        return await fn(client);
      })(),
      timeout,
    ]);
  } finally {
    child.kill();
  }
}
