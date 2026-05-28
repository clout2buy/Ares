// LSP — symbol navigation with real TypeScript language-server support
// and deterministic static fallback.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTool, resolveWorkspacePath, zPath } from "./_shared.js";

const inputSchema = z
  .object({
    action: z.enum(["go_to_definition", "go_to_references", "hover"]),
    file_path: zPath,
    line: z.number().int().positive().describe("1-based line number."),
    character: z.number().int().nonnegative().describe("0-based character offset."),
    symbol: z
      .string()
      .optional()
      .describe("Optional explicit symbol. If omitted, Crix reads the word at file_path:line:character."),
    max_results: z.number().int().positive().max(100).default(25),
  })
  .strict();

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  preview: string;
}

export interface LspOutput {
  action: "go_to_definition" | "go_to_references" | "hover";
  symbol: string;
  locations: LspLocation[];
  hover?: string;
  engine: "typescript-language-server" | "static-fallback";
  fallbackReason?: string;
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
]);

const IGNORED_DIRS = new Set(["node_modules", ".git", ".crix", "dist", "build", "target", ".next", "coverage"]);
const lspClients = new Map<string, Promise<TsLanguageServerClient | null>>();

export const LspTool = buildTool({
  name: "LSP",
  description:
    "Code navigation: go_to_definition, go_to_references, and hover for a symbol at file_path:line:character. Uses typescript-language-server for JS/TS when available, with a static fallback for other languages or missing servers.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `LSP ${i.action} ${path.basename(i.file_path)}:${i.line}`,

  async call(i, ctx): Promise<{ output: LspOutput; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "read");
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const symbol = i.symbol?.trim() || wordAt(lines[i.line - 1] ?? "", i.character);
    if (!symbol) throw new Error(`No symbol found at ${filePath}:${i.line}:${i.character}`);

    if (TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      const client = await clientForWorkspace(ctx.workspace, (data) => ctx.emitProgress?.(data));
      if (client) {
        try {
          await client.didOpen(filePath, content);
          const output = await queryTypescriptServer(client, i, filePath, symbol);
          if (output) {
            return {
              output,
              display:
                i.action === "hover"
                  ? `hover ${symbol} via TypeScript LSP`
                  : `${output.locations.length} ${i.action === "go_to_definition" ? "definition" : "reference"} hit${output.locations.length === 1 ? "" : "s"} for ${symbol} via TypeScript LSP`,
            };
          }
        } catch (err) {
          return await staticFallback(ctx.workspace, i, filePath, lines, symbol, err instanceof Error ? err.message : String(err));
        }
      }
    }

    return await staticFallback(ctx.workspace, i, filePath, lines, symbol);
  },
});

async function queryTypescriptServer(
  client: TsLanguageServerClient,
  i: z.infer<typeof inputSchema>,
  filePath: string,
  symbol: string,
): Promise<LspOutput | null> {
  const position = { line: i.line - 1, character: i.character };
  const textDocument = { uri: pathToFileURL(filePath).href };
  if (i.action === "go_to_definition") {
    const response = await client.request("textDocument/definition", { textDocument, position });
    const locations = await locationsFromLsp(response, i.max_results);
    return { action: i.action, symbol, locations, engine: "typescript-language-server" };
  }
  if (i.action === "go_to_references") {
    const response = await client.request("textDocument/references", {
      textDocument,
      position,
      context: { includeDeclaration: true },
    });
    const locations = await locationsFromLsp(response, i.max_results);
    return { action: i.action, symbol, locations, engine: "typescript-language-server" };
  }
  const response = await client.request("textDocument/hover", { textDocument, position });
  const hover = hoverText(response);
  return { action: i.action, symbol, locations: [], hover, engine: "typescript-language-server" };
}

async function staticFallback(
  workspace: string,
  i: z.infer<typeof inputSchema>,
  filePath: string,
  lines: readonly string[],
  symbol: string,
  fallbackReason?: string,
): Promise<{ output: LspOutput; display: string }> {
  const files = await listSourceFiles(workspace);
  const locations =
    i.action === "go_to_definition"
      ? await findDefinitions(files, symbol, i.max_results)
      : i.action === "go_to_references"
      ? await findReferences(files, symbol, i.max_results)
      : [];

  const hover =
    i.action === "hover"
      ? buildHover(symbol, filePath, lines, i.line, await findDefinitions(files, symbol, 5))
      : undefined;

  const output: LspOutput = {
    action: i.action,
    symbol,
    locations,
    hover,
    engine: "static-fallback",
    fallbackReason,
  };
  return {
    output,
    display:
      i.action === "hover"
        ? `hover ${symbol}`
        : `${locations.length} ${i.action === "go_to_definition" ? "definition" : "reference"} hit${locations.length === 1 ? "" : "s"} for ${symbol}`,
  };
}

async function clientForWorkspace(
  workspace: string,
  emitProgress: (data: unknown) => void,
): Promise<TsLanguageServerClient | null> {
  const root = path.resolve(workspace);
  let client = lspClients.get(root);
  if (!client) {
    client = TsLanguageServerClient.start(root, emitProgress);
    lspClients.set(root, client);
  }
  return client;
}

class TsLanguageServerClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly openFiles = new Set<string>();

  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly root: string) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("exit", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("typescript-language-server exited"));
      this.pending.clear();
    });
  }

  static async start(root: string, emitProgress: (data: unknown) => void): Promise<TsLanguageServerClient | null> {
    const command = await which("typescript-language-server");
    if (!command) return null;
    emitProgress({ kind: "lsp_init", server: "typescript-language-server", workspace: root });
    const child = spawn(command, ["--stdio"], { cwd: root, windowsHide: true });
    const client = new TsLanguageServerClient(child, root);
    try {
      await client.request("initialize", {
        processId: null,
        rootUri: pathToFileURL(root).href,
        capabilities: {
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          },
        },
      });
      client.notify("initialized", {});
      emitProgress({ kind: "lsp_ready", server: "typescript-language-server" });
      return client;
    } catch {
      child.kill();
      return null;
    }
  }

  async didOpen(filePath: string, text: string): Promise<void> {
    if (this.openFiles.has(filePath)) return;
    this.openFiles.add(filePath);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(filePath).href,
        languageId: languageId(filePath),
        version: 1,
        text,
      },
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    this.write(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(payload: unknown): void {
    const json = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const raw = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);
      this.onMessage(raw);
    }
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "LSP error"));
    else pending.resolve(msg.result);
  }
}

async function locationsFromLsp(response: unknown, maxResults: number): Promise<LspLocation[]> {
  const raw = Array.isArray(response) ? response : response ? [response] : [];
  const out: LspLocation[] = [];
  for (const item of raw.slice(0, maxResults)) {
    const loc = normalizeLocation(item);
    if (!loc) continue;
    out.push(await locationWithPreview(loc));
  }
  return out;
}

function normalizeLocation(item: unknown): { uri: string; line: number; character: number } | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as { uri?: string; targetUri?: string; range?: { start?: { line?: number; character?: number } }; targetRange?: { start?: { line?: number; character?: number } } };
  const uri = obj.uri ?? obj.targetUri;
  const start = obj.range?.start ?? obj.targetRange?.start;
  if (!uri || !start || typeof start.line !== "number" || typeof start.character !== "number") return null;
  return { uri, line: start.line + 1, character: start.character };
}

async function locationWithPreview(loc: { uri: string; line: number; character: number }): Promise<LspLocation> {
  const filePath = fileURLToPath(loc.uri);
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const preview = text.split(/\r?\n/)[loc.line - 1]?.trim() ?? "";
  return { path: filePath, line: loc.line, character: loc.character, preview };
}

function hoverText(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const contents = (response as { contents?: unknown }).contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markedStringText).filter(Boolean).join("\n");
  return markedStringText(contents);
}

function markedStringText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as { value?: string; language?: string };
    return obj.value ?? "";
  }
  return "";
}

function languageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".tsx") return "typescriptreact";
  if (ext === ".jsx") return "javascriptreact";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return "typescript";
}

async function which(bin: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function wordAt(line: string, character: number): string {
  const idx = Math.min(Math.max(0, character), line.length);
  let start = idx;
  let end = idx;
  while (start > 0 && /[A-Za-z0-9_$]/.test(line[start - 1])) start--;
  while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end++;
  return line.slice(start, end);
}

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await walk(root);
  return out;
}

async function findDefinitions(files: readonly string[], symbol: string, maxResults: number): Promise<LspLocation[]> {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*[:=]\\s*`),
    new RegExp(`\\bdef\\s+${escaped}\\b`),
    new RegExp(`\\bstruct\\s+${escaped}\\b`),
  ];
  return await scan(files, patterns, maxResults);
}

async function findReferences(files: readonly string[], symbol: string, maxResults: number): Promise<LspLocation[]> {
  return await scan(files, [new RegExp(`\\b${escapeRegExp(symbol)}\\b`)], maxResults);
}

async function scan(files: readonly string[], patterns: readonly RegExp[], maxResults: number): Promise<LspLocation[]> {
  const hits: LspLocation[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const match = patterns.map((p) => line.match(p)).find(Boolean);
      if (!match || match.index === undefined) continue;
      hits.push({
        path: file,
        line: idx + 1,
        character: match.index,
        preview: line.trim(),
      });
      if (hits.length >= maxResults) return hits;
    }
  }
  return hits;
}

function buildHover(
  symbol: string,
  filePath: string,
  lines: readonly string[],
  line: number,
  definitions: readonly LspLocation[],
): string {
  const context = lines.slice(Math.max(0, line - 3), Math.min(lines.length, line + 2)).join("\n");
  const definitionText =
    definitions.length > 0
      ? `\n\nLikely definition: ${definitions[0].path}:${definitions[0].line}\n${definitions[0].preview}`
      : "";
  return `${symbol} at ${filePath}:${line}\n\n${context}${definitionText}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
