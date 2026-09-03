// LSP — symbol navigation with real TypeScript language-server support
// and deterministic static fallback.
//
// Two tiers, stated honestly in the tool description: TypeScript/JavaScript
// get a full language server (types, real references) when
// typescript-language-server is on PATH; every other language gets the regex
// symbol index from @ares/core (names, kinds, lines — no types) for
// workspace_symbol / document_symbol, and the static grep-style fallback for
// definition/references/hover.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSymbolIndex,
  querySymbols,
  workspaceSymbolsFor,
  symbolIndexLanguageFor,
  type IndexedSymbol,
  type SymbolKind,
} from "@ares/core";
import { buildTool, resolveWorkspacePath, toolError, zPath } from "./_shared.js";

const NAV_ACTIONS = new Set(["go_to_definition", "go_to_references", "hover"]);

const inputSchema = z
  .object({
    action: z.enum(["go_to_definition", "go_to_references", "hover", "workspace_symbol", "document_symbol"]),
    file_path: zPath.optional().describe("Required for every action except workspace_symbol."),
    line: z.number().int().positive().optional().describe("1-based line number (go_to_definition/go_to_references/hover)."),
    character: z.number().int().nonnegative().optional().describe("0-based character offset (go_to_definition/go_to_references/hover)."),
    symbol: z
      .string()
      .optional()
      .describe("Optional explicit symbol. If omitted, Ares reads the word at file_path:line:character."),
    query: z
      .string()
      .optional()
      .describe("workspace_symbol: name to look up (exact, prefix, camel/snake fuzzy like `gud` → getUserData, substring). Falls back to `symbol`."),
    kind: z
      .enum(["function", "method", "class", "interface", "type", "enum", "struct", "trait", "impl", "module", "variable", "constant", "macro"])
      .optional()
      .describe("workspace_symbol/document_symbol: restrict to one symbol kind."),
    max_results: z.number().int().positive().max(100).default(25),
  })
  .strict();

type LspInput = z.infer<typeof inputSchema>;
type NavInput = LspInput & { line: number; character: number };

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  preview: string;
}

export interface LspSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  endLine?: number;
  container?: string;
  exported?: boolean;
  signature: string;
}

export interface LspOutput {
  action: LspInput["action"];
  symbol: string;
  locations: LspLocation[];
  hover?: string;
  /** workspace_symbol / document_symbol results. */
  symbols?: LspSymbol[];
  engine: "typescript-language-server" | "static-fallback" | "symbol-index";
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

const IGNORED_DIRS = new Set(["node_modules", ".git", ".ares", "dist", "build", "target", ".next", "coverage"]);
const lspClients = new Map<string, Promise<TsLanguageServerClient | null>>();

export const LspTool = buildTool({
  name: "LSP",
  description:
    "Code navigation. Actions: go_to_definition / go_to_references / hover for the symbol at file_path:line:character; workspace_symbol (find declarations by name across the repo — exact, prefix, camel/snake fuzzy); document_symbol (outline of one file: every function/class/method with lines). Engines — TypeScript/JavaScript: full LSP via typescript-language-server when installed; other languages: regex symbol index (names/kinds/lines, no types) for the symbol actions and a static text fallback for the rest.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) =>
    i.action === "workspace_symbol"
      ? `LSP workspace_symbol ${i.query ?? i.symbol ?? ""}`
      : `LSP ${i.action} ${path.basename(i.file_path ?? "")}${i.line ? `:${i.line}` : ""}`,

  async validateInput(i) {
    if (i.action === "workspace_symbol") {
      if (!(i.query ?? i.symbol)?.trim()) return { ok: false, message: "LSP workspace_symbol needs `query` (a symbol name or fragment)." };
      return { ok: true };
    }
    if (!i.file_path) return { ok: false, message: `LSP ${i.action} needs file_path.` };
    if (NAV_ACTIONS.has(i.action) && (i.line === undefined || i.character === undefined)) {
      return { ok: false, message: `LSP ${i.action} needs line (1-based) and character (0-based).` };
    }
    return { ok: true };
  },

  async call(i, ctx): Promise<{ output: LspOutput; display: string }> {
    if (i.action === "workspace_symbol") return await workspaceSymbolAction(i, ctx);
    if (!i.file_path) throw toolError(`LSP ${i.action} needs file_path.`);
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "read");
    if (i.action === "document_symbol") return await documentSymbolAction(i, ctx, filePath);
    if (i.line === undefined || i.character === undefined) throw toolError(`LSP ${i.action} needs line and character.`);
    const nav = i as NavInput;
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const symbol = i.symbol?.trim() || wordAt(lines[nav.line - 1] ?? "", nav.character);
    if (!symbol) throw new Error(`No symbol found at ${filePath}:${nav.line}:${nav.character}`);

    if (TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      const client = await clientForWorkspace(ctx.workspace, (data) => ctx.emitProgress?.(data));
      if (client) {
        try {
          await client.didOpen(filePath, content);
          const output = await queryTypescriptServer(client, nav, filePath, symbol);
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
          return await staticFallback(ctx.workspace, nav, filePath, lines, symbol, err instanceof Error ? err.message : String(err));
        }
      }
    }

    return await staticFallback(ctx.workspace, nav, filePath, lines, symbol);
  },
});

// ─── workspace_symbol / document_symbol ────────────────────────────────

type SymbolCtx = Parameters<typeof resolveWorkspacePath>[0] & { emitProgress?: (data: unknown) => void };

function toLspSymbol(workspace: string, s: IndexedSymbol): LspSymbol {
  return {
    name: s.name,
    kind: s.kind,
    path: path.join(workspace, ...s.file.split("/")),
    line: s.line,
    endLine: s.endLine,
    container: s.container,
    exported: s.exported,
    signature: s.signature,
  };
}

async function workspaceSymbolAction(i: LspInput, ctx: SymbolCtx): Promise<{ output: LspOutput; display: string }> {
  const query = (i.query ?? i.symbol ?? "").trim();
  if (!query) throw toolError("LSP workspace_symbol needs `query`.");
  const max = i.max_results ?? 25;
  const kind = i.kind as SymbolKind | undefined;
  const symbols: LspSymbol[] = [];
  const seen = new Set<string>();
  let engine: LspOutput["engine"] = "symbol-index";
  let fallbackReason: string | undefined;

  // TypeScript server first for TS/JS files (real declarations, incl. types);
  // the index fills in every other language and stands in when no server.
  const client = await clientForWorkspace(ctx.workspace, (data) => ctx.emitProgress?.(data));
  if (client) {
    try {
      const response = await client.request("workspace/symbol", { query });
      for (const s of lspSymbolsFrom(response)) {
        if (kind && s.kind !== kind) continue;
        const key = `${s.path}:${s.line}:${s.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        symbols.push(s);
      }
      engine = "typescript-language-server";
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err);
    }
  }
  const index = await buildSymbolIndex(ctx.workspace, { maxAgeMs: 3_000 });
  for (const m of querySymbols(index, query, { kind, limit: max * 2 })) {
    if (engine === "typescript-language-server" && TS_EXTENSIONS.has(path.extname(m.file).toLowerCase())) continue;
    const s = toLspSymbol(index.workspace, m);
    const key = `${s.path}:${s.line}:${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push(s);
  }
  const out = symbols.slice(0, max);
  return {
    output: { action: i.action, symbol: query, locations: [], symbols: out, engine, fallbackReason },
    display: `${out.length} symbol${out.length === 1 ? "" : "s"} for ${query} via ${engine}`,
  };
}

async function documentSymbolAction(i: LspInput, ctx: SymbolCtx, filePath: string): Promise<{ output: LspOutput; display: string }> {
  const max = i.max_results ?? 25;
  const kind = i.kind as SymbolKind | undefined;
  let engine: LspOutput["engine"] = "symbol-index";
  let fallbackReason: string | undefined;
  let symbols: LspSymbol[] = [];

  if (TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    const client = await clientForWorkspace(ctx.workspace, (data) => ctx.emitProgress?.(data));
    if (client) {
      try {
        const content = await fs.readFile(filePath, "utf8");
        await client.didOpen(filePath, content);
        const response = await client.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(filePath).href } });
        symbols = documentSymbolsFrom(response, filePath);
        engine = "typescript-language-server";
      } catch (err) {
        fallbackReason = err instanceof Error ? err.message : String(err);
      }
    }
  }
  if (engine === "symbol-index") {
    if (!symbolIndexLanguageFor(filePath)) {
      throw toolError(`LSP document_symbol: no symbol extractor for ${path.extname(filePath) || "this file type"}.`);
    }
    const index = await buildSymbolIndex(ctx.workspace, { maxAgeMs: 3_000 });
    symbols = workspaceSymbolsFor(index, filePath).map((s) => toLspSymbol(index.workspace, s));
  }
  if (kind) symbols = symbols.filter((s) => s.kind === kind);
  const out = symbols.slice(0, max);
  return {
    output: { action: i.action, symbol: path.basename(filePath), locations: [], symbols: out, engine, fallbackReason },
    display: `${out.length} symbol${out.length === 1 ? "" : "s"} in ${path.basename(filePath)} via ${engine}`,
  };
}

/** LSP SymbolKind numbers → our kind vocabulary. */
const LSP_KIND: Record<number, string> = {
  2: "module",
  3: "module",
  5: "class",
  6: "method",
  7: "variable",
  9: "method",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  23: "struct",
  26: "type",
};

function lspSymbolsFrom(response: unknown): LspSymbol[] {
  if (!Array.isArray(response)) return [];
  const out: LspSymbol[] = [];
  for (const item of response) {
    const obj = item as { name?: string; kind?: number; containerName?: string; location?: { uri?: string; range?: { start?: { line?: number }; end?: { line?: number } } } };
    const uri = obj.location?.uri;
    const start = obj.location?.range?.start?.line;
    if (!obj.name || !uri || typeof start !== "number") continue;
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      continue;
    }
    out.push({
      name: obj.name,
      kind: LSP_KIND[obj.kind ?? 0] ?? "variable",
      path: file,
      line: start + 1,
      endLine: typeof obj.location?.range?.end?.line === "number" ? obj.location.range.end.line + 1 : undefined,
      container: obj.containerName || undefined,
      signature: obj.name,
    });
  }
  return out;
}

function documentSymbolsFrom(response: unknown, filePath: string): LspSymbol[] {
  if (!Array.isArray(response)) return [];
  const out: LspSymbol[] = [];
  const visit = (items: unknown[], container?: string): void => {
    for (const item of items) {
      const obj = item as {
        name?: string;
        kind?: number;
        detail?: string;
        range?: { start?: { line?: number }; end?: { line?: number } };
        selectionRange?: { start?: { line?: number } };
        children?: unknown[];
        location?: { range?: { start?: { line?: number }; end?: { line?: number } } };
        containerName?: string;
      };
      const range = obj.range ?? obj.location?.range;
      const start = obj.selectionRange?.start?.line ?? range?.start?.line;
      if (!obj.name || typeof start !== "number") continue;
      out.push({
        name: obj.name,
        kind: LSP_KIND[obj.kind ?? 0] ?? "variable",
        path: filePath,
        line: start + 1,
        endLine: typeof range?.end?.line === "number" ? range.end.line + 1 : undefined,
        container: container ?? obj.containerName ?? undefined,
        signature: obj.detail ? `${obj.name} ${obj.detail}` : obj.name,
      });
      if (Array.isArray(obj.children)) visit(obj.children, obj.name);
    }
  };
  visit(response);
  return out.sort((a, b) => a.line - b.line);
}

async function queryTypescriptServer(
  client: TsLanguageServerClient,
  i: NavInput,
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
  i: NavInput,
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
  // Per-file LSP document version + last-sent content hash. Without didChange
  // the server keeps the version-1 buffer forever, so every navigation after an
  // edit runs on stale text (wrong lines, missing symbols).
  private readonly openDocs = new Map<string, { version: number; hash: string }>();

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
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { symbol: { dynamicRegistration: false } },
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

  /** Open the document, or push a full-sync didChange if its content changed
   *  since we last sent it (so navigation never runs on a stale buffer). */
  async didOpen(filePath: string, text: string): Promise<void> {
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    const existing = this.openDocs.get(filePath);
    const uri = pathToFileURL(filePath).href;
    if (!existing) {
      this.openDocs.set(filePath, { version: 1, hash });
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(filePath), version: 1, text },
      });
      return;
    }
    if (existing.hash === hash) return; // unchanged — nothing to sync
    const version = existing.version + 1;
    this.openDocs.set(filePath, { version, hash });
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }], // full-document sync
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
