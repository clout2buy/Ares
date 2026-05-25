// LSP — symbol navigation with deterministic static fallback.
//
// Crix can later swap this facade onto a long-lived language-server
// process. The exposed contract is already the useful surface:
// go_to_definition, go_to_references, and hover.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
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
  engine: "static-fallback";
}

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

export const LspTool = buildTool({
  name: "LSP",
  description:
    "Code navigation facade: go_to_definition, go_to_references, and hover for a symbol at file_path:line:character. Uses a fast static fallback now and keeps the same schema for long-lived language-server backends.",
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

    const files = await listSourceFiles(ctx.workspace);
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
    };
    return {
      output,
      display:
        i.action === "hover"
          ? `hover ${symbol}`
          : `${locations.length} ${i.action === "go_to_definition" ? "definition" : "reference"} hit${locations.length === 1 ? "" : "s"} for ${symbol}`,
    };
  },
});

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
