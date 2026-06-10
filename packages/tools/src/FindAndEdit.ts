// FindAndEdit — multi-file regex replacement with previews.
//
// This is the deterministic half of Devin-style "find then apply"
// refactors. It handles broad mechanical changes in one tool call while
// returning line-level proof of what changed.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, assertInsideWorkspace, workspaceRoot } from "./_shared.js";

const inputSchema = z
  .object({
    pattern: z.string().min(1).describe("JavaScript regex source to search for."),
    replacement: z.string().describe("Replacement string. Supports JS replacement syntax like $1."),
    flags: z.string().default("g").describe("Regex flags. `g` is added if omitted."),
    file_glob: z.string().default("**/*").describe("Workspace-relative glob, e.g. `src/**/*.ts`."),
    target_directories: z.array(z.string()).default([]).describe("Optional directory scopes."),
    max_files: z.number().int().positive().max(200).default(50),
    dry_run: z.boolean().default(false).describe("Preview changes without writing."),
  })
  .strict();

export interface FindAndEditChange {
  path: string;
  replacements: number;
  firstLine: number;
  preview: string;
}

export interface FindAndEditOutput {
  dryRun: boolean;
  filesScanned: number;
  filesChanged: number;
  replacements: number;
  changes: FindAndEditChange[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", ".ares", "dist", "build", "target", ".next", "coverage"]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".json",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".ps1",
  ".sh",
]);

export const FindAndEditTool = buildTool({
  name: "FindAndEdit",
  description:
    "Find regex matches across files and apply a mechanical replacement in one call. Use for 2+ file refactors where Grep+many Edits would waste context. Always start with dry_run=true unless the replacement is obvious.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `${i.dry_run ? "Previewing" : "Replacing"} /${i.pattern}/ in ${i.file_glob}`,

  async call(i, ctx): Promise<{ output: FindAndEditOutput; touchedFiles?: string[]; display: string }> {
    const root = workspaceRoot(ctx);
    const scopes =
      i.target_directories.length > 0
        ? i.target_directories.map((dir) => path.resolve(root, dir))
        : [root];
    for (const scope of scopes) assertInsideWorkspace(root, scope, "target_directories");

    const flags = i.flags.includes("g") ? i.flags : `${i.flags}g`;
    const regex = new RegExp(i.pattern, flags);
    const fileRe = globToRegExp(i.file_glob);
    const files: string[] = [];
    for (const scope of scopes) await walk(scope, root, fileRe, files);

    let filesScanned = 0;
    let replacements = 0;
    const changes: FindAndEditChange[] = [];
    const touched: string[] = [];

    for (const file of files) {
      if (changes.length >= i.max_files) break;
      filesScanned++;
      const original = await fs.readFile(file, "utf8").catch(() => "");
      if (!original) continue;
      regex.lastIndex = 0;
      const matches = [...original.matchAll(regex)];
      if (matches.length === 0) continue;

      const updated = original.replace(regex, i.replacement);
      const firstIndex = matches[0].index ?? 0;
      const firstLine = original.slice(0, firstIndex).split(/\r?\n/).length;
      const preview = previewLine(updated, firstLine);

      changes.push({ path: file, replacements: matches.length, firstLine, preview });
      replacements += matches.length;
      if (!i.dry_run) {
        await fs.writeFile(file, updated, "utf8");
        touched.push(file);
      }
    }

    const output: FindAndEditOutput = {
      dryRun: i.dry_run,
      filesScanned,
      filesChanged: changes.length,
      replacements,
      changes,
    };
    return {
      output,
      touchedFiles: touched.length > 0 ? touched : undefined,
      display: `${i.dry_run ? "previewed" : "changed"} ${changes.length} file${changes.length === 1 ? "" : "s"} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
    };
  },
});

async function walk(dir: string, root: string, fileRe: RegExp, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(full, root, fileRe, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (fileRe.test(rel)) out.push(full);
  }
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i++;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegExp(ch);
    }
  }
  return new RegExp(out + "$");
}

function previewLine(content: string, line: number): string {
  return (content.split(/\r?\n/)[Math.max(0, line - 1)] ?? "").trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
