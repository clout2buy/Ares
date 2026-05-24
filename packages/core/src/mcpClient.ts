import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { JsonRecord, JsonValue } from "@crix/protocol";
import { tail } from "./util.js";

export interface McpServerDeclaration {
  pluginId: string;
  id: string;
  name: string;
  root: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  raw?: JsonRecord;
}

export interface McpClientOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface McpRpcResponse {
  ok: boolean;
  result?: JsonValue;
  error?: string;
  stderrTail?: string;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: JsonRecord;
  result?: JsonValue;
  error?: { code?: number; message?: string; data?: unknown };
}

export class McpStdioClient {
  constructor(
    private readonly server: McpServerDeclaration,
    private readonly options: McpClientOptions = {},
  ) {}

  async listTools(): Promise<McpRpcResponse> {
    return await this.request("tools/list", {});
  }

  async listResources(): Promise<McpRpcResponse> {
    return await this.request("resources/list", {});
  }

  async listPrompts(): Promise<McpRpcResponse> {
    return await this.request("prompts/list", {});
  }

  async readResource(uri: string): Promise<McpRpcResponse> {
    return await this.request("resources/read", { uri });
  }

  async callTool(name: string, input: JsonRecord): Promise<McpRpcResponse> {
    return await this.request("tools/call", { name, arguments: input });
  }

  async request(method: string, params: JsonRecord): Promise<McpRpcResponse> {
    const command = this.server.command?.trim();
    if (!command) {
      return {
        ok: false,
        error: this.server.url
          ? `MCP server ${this.server.name} uses URL transport; Crix currently supports stdio execution first.`
          : `MCP server ${this.server.name} is missing a command.`,
      };
    }
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const maxOutputChars = this.options.maxOutputChars ?? 1_000_000;
    const cwd = resolveServerCwd(this.server);
    const child = spawn(command, this.server.args ?? [], {
      cwd,
      shell: false,
      stdio: "pipe",
      env: { ...process.env, ...(this.server.env ?? {}) },
    });

    const session = new McpJsonRpcSession(child, timeoutMs, maxOutputChars);
    try {
      await session.writeRequest(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "crix", version: "0.2.0" },
      });
      const initialized = await session.waitFor(1);
      if (!initialized.ok) return initialized;
      await session.writeNotification("notifications/initialized", {});
      await session.writeRequest(2, method, params);
      return await session.waitFor(2);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), stderrTail: session.stderrTail() };
    } finally {
      session.close();
    }
  }
}

class McpJsonRpcSession {
  private readonly responses = new Map<number, McpRpcResponse>();
  private readonly waiters = new Map<number, (response: McpRpcResponse) => void>();
  private stdout = "";
  private stderr = "";
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
    private readonly maxOutputChars: number,
  ) {
    child.stdout.on("data", (chunk) => this.onStdout(chunk.toString()));
    child.stderr.on("data", (chunk) => {
      this.stderr = trimOutput(`${this.stderr}${chunk.toString()}`, this.maxOutputChars);
    });
    child.on("error", (error) => this.rejectAll(error.message));
    child.on("close", (code) => {
      this.closed = true;
      this.rejectAll(`MCP process exited before response${code === null ? "" : `, code ${code}`}`);
    });
  }

  async writeRequest(id: number, method: string, params: JsonRecord): Promise<void> {
    await this.write({ jsonrpc: "2.0", id, method, params });
  }

  async writeNotification(method: string, params: JsonRecord): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  async waitFor(id: number): Promise<McpRpcResponse> {
    const existing = this.responses.get(id);
    if (existing) return existing;
    return await new Promise<McpRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ ok: false, error: `MCP request ${id} timed out after ${this.timeoutMs}ms`, stderrTail: this.stderrTail() });
      }, this.timeoutMs);
      this.waiters.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  stderrTail(): string {
    return tail(this.stderr, 4000);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill();
  }

  private async write(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("MCP process is closed");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  private onStdout(chunk: string): void {
    this.stdout = trimOutput(`${this.stdout}${chunk}`, this.maxOutputChars);
    let newlineIndex = this.stdout.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdout.slice(0, newlineIndex).trim();
      this.stdout = this.stdout.slice(newlineIndex + 1);
      if (line) this.onLine(line);
      newlineIndex = this.stdout.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.stderr = trimOutput(`${this.stderr}\n${line}`, this.maxOutputChars);
      return;
    }
    if (typeof message.id !== "number") return;
    const response: McpRpcResponse = message.error
      ? { ok: false, error: message.error.message || JSON.stringify(message.error), stderrTail: this.stderrTail() }
      : { ok: true, result: message.result ?? null, stderrTail: this.stderrTail() };
    this.responses.set(message.id, response);
    const waiter = this.waiters.get(message.id);
    if (waiter) {
      this.waiters.delete(message.id);
      waiter(response);
    }
  }

  private rejectAll(message: string): void {
    if (this.waiters.size === 0) return;
    for (const [id, waiter] of this.waiters) {
      waiter({ ok: false, error: message, stderrTail: this.stderrTail() });
      this.waiters.delete(id);
    }
  }
}

function resolveServerCwd(server: McpServerDeclaration): string {
  if (server.cwd) return path.isAbsolute(server.cwd) ? server.cwd : path.resolve(server.root, server.cwd);
  return server.root;
}

function trimOutput(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}
