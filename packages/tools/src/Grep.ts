// Grep — regex search over workspace files.
//
// Prefers ripgrep (`rg`) when on PATH for speed; falls back to a native JS
// implementation otherwise so tests work without external deps.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildTool, resolveWorkspacePath, type RichToolContext } from "./_shared.js";

const DEFAULT_IGNORE_GLOBS = [
  "**/.git/**",
  "**/.crix/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.next/**",
  "**/.pnpm-store/**",
];

const inputSchema = z
  .object({
    pattern: z.string().min(1).describe("Regular expression to search for."),
    path: z
      .union([z.string(), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe("File or directory to search; defaults to workspace. May also be an array of paths."),
    glob: z
      .union([z.string(), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe("Filter files by glob, e.g. `*.ts`. May also be an array of globs."),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .default("files_with_matches"),
    case_insensitive: z.boolean().default(false),
    max_results: z.number().int().positive().default(200),
    context_before: z.number().int().nonnegative().default(0),
    context_after: z.number().int().nonnegative().default(0),
  })
  .strict();

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  pattern: string;
  mode: "content" | "files_with_matches" | "count";
  matches: GrepMatch[];
  files?: string[];
  countsByFile?: Record<string, number>;
  totalMatches: number;
  truncated: boolean;
  engine: "ripgrep" | "native";
}

export const GrepTool = buildTool({
  name: "Grep",
  description:
    "Regex search across the workspace (ripgrep-backed when available). Choose output_mode: `content` (matching lines), `files_with_matches` (just paths), or `count`.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Searching for ${i.pattern}`,

  async call(i, ctx): Promise<{ output: GrepOutput; display: string }> {
    const roots = await resolveSearchPaths(ctx, i.path);
    const ripgrep = await tryRipgrep(i, roots, ctx.signal, (data) => ctx.emitProgress?.(data));
    const output: GrepOutput = ripgrep ?? (await nativeGrep(i, roots, (data) => ctx.emitProgress?.(data)));
    const summary =
      output.mode === "files_with_matches"
        ? `${output.files?.length ?? 0} file(s) matched /${i.pattern}/`
        : output.mode === "count"
        ? `${output.totalMatches} match(es) for /${i.pattern}/`
        : `${output.totalMatches} line(s) matched /${i.pattern}/`;
    return { output, display: summary };
  },
});

// ─── ripgrep path ──────────────────────────────────────────────────────

async function tryRipgrep(
  i: z.infer<typeof inputSchema>,
  roots: string[],
  signal: AbortSignal,
  emitProgress?: (data: unknown) => void,
): Promise<GrepOutput | null> {
  const rgPath = await which("rg");
  if (!rgPath) return null;

  const args: string[] = ["--no-config", "--json", "--hidden"];
  for (const ignore of DEFAULT_IGNORE_GLOBS) {
    args.push("--glob", `!${ignore}`);
  }
  if (i.case_insensitive) args.push("-i");
  for (const glob of toArray(i.glob)) args.push("--glob", glob);
  if (i.output_mode === "content") {
    if (i.context_before > 0) args.push("-B", String(i.context_before));
    if (i.context_after > 0) args.push("-A", String(i.context_after));
  }
  args.push("-e", i.pattern, ...roots);

  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { signal });
    let buf = "";
    const matches: GrepMatch[] = [];
    const files = new Set<string>();
    const counts: Record<string, number> = {};
    let total = 0;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let event: { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "match") {
          const p = event.data?.path?.text;
          const text = event.data?.lines?.text ?? "";
          const lineNum = event.data?.line_number ?? 0;
          if (!p) continue;
          files.add(p);
          counts[p] = (counts[p] ?? 0) + 1;
          total++;
          if (total === 1 || total % 25 === 0) {
            emitProgress?.({ kind: "grep_match", file: p, line: lineNum, total });
          }
          if (i.output_mode === "content" && matches.length < i.max_results) {
            matches.push({ path: p, line: lineNum, text: text.replace(/\n$/, "") });
          }
        }
      }
    });

    child.on("error", () => resolve(null));
    child.on("close", () => {
      resolve(buildOutput(i, matches, files, counts, total, "ripgrep"));
    });
  });
}

async function which(bin: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const p of paths) {
    for (const ext of exts) {
      const candidate = path.join(p, bin + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

// ─── native fallback ───────────────────────────────────────────────────

async function nativeGrep(
  i: z.infer<typeof inputSchema>,
  roots: string[],
  emitProgress?: (data: unknown) => void,
): Promise<GrepOutput> {
  const flags = i.case_insensitive ? "i" : "";
  const regex = new RegExp(i.pattern, flags);
  const matches: GrepMatch[] = [];
  const files = new Set<string>();
  const counts: Record<string, number> = {};
  let total = 0;
  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".next",
    ".pnpm-store",
  ]);

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name) || e.name.startsWith(".")) continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (!matchesAnyGlob(abs, roots, i.glob)) continue;
        let text: string;
        try {
          text = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (regex.test(lines[lineIdx])) {
            files.add(abs);
            counts[abs] = (counts[abs] ?? 0) + 1;
            total++;
            if (total === 1 || total % 25 === 0) {
              emitProgress?.({ kind: "grep_match", file: abs, line: lineIdx + 1, total });
            }
            if (i.output_mode === "content" && matches.length < i.max_results) {
              matches.push({ path: abs, line: lineIdx + 1, text: lines[lineIdx] });
            }
          }
        }
      }
    }
  }

  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isFile()) {
      if (!matchesAnyGlob(root, roots, i.glob)) continue;
      const text = await fs.readFile(root, "utf8");
      const lines = text.split("\n");
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (regex.test(lines[lineIdx])) {
          files.add(root);
          counts[root] = (counts[root] ?? 0) + 1;
          total++;
          if (total === 1 || total % 25 === 0) {
            emitProgress?.({ kind: "grep_match", file: root, line: lineIdx + 1, total });
          }
          if (i.output_mode === "content" && matches.length < i.max_results) {
            matches.push({ path: root, line: lineIdx + 1, text: lines[lineIdx] });
          }
        }
      }
    } else {
      await walk(root);
    }
  }

  return buildOutput(i, matches, files, counts, total, "native");
}

async function resolveSearchPaths(
  ctx: Pick<RichToolContext, "workspace" | "pathPermissions" | "requestPermission" | "permissionMode">,
  inputPath: z.infer<typeof inputSchema>["path"],
): Promise<string[]> {
  const requested = toArray(inputPath);
  if (requested.length === 0) {
    return [await resolveWorkspacePath(ctx, undefined, "path", "read")];
  }

  const expanded: string[] = [];
  for (const raw of requested) {
    const candidate = path.resolve(ctx.workspace, raw);
    const exists = await fs.stat(candidate).then(() => true).catch(() => false);
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (!exists && !path.isAbsolute(raw) && parts.length > 1) {
      expanded.push(...parts);
    } else {
      expanded.push(raw);
    }
  }

  return Promise.all(expanded.map((p) => resolveWorkspacePath(ctx, p, "path", "read")));
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesAnyGlob(absPath: string, roots: string[], glob: z.infer<typeof inputSchema>["glob"]): boolean {
  const globs = toArray(glob);
  if (globs.length === 0) return true;
  const root = roots.find((r) => {
    const relative = path.relative(r, absPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }) ?? roots[0];
  const rel = normalizeSlashes(path.relative(root, absPath));
  const base = path.basename(absPath);
  return globs.some((pattern) => matchesGlob(rel, pattern) || matchesGlob(base, pattern));
}

function matchesGlob(filename: string, pattern: string): boolean {
  return globToRegExp(normalizeSlashes(pattern)).test(normalizeSlashes(filename));
}

function globToRegExp(glob: string): RegExp {
  let r = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      r += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      r += "[^/]*";
      i++;
    } else if (c === "?") {
      r += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      r += "\\" + c;
      i++;
    } else {
      r += c;
      i++;
    }
  }
  r += "$";
  return new RegExp(r);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function buildOutput(
  i: z.infer<typeof inputSchema>,
  matches: GrepMatch[],
  files: Set<string>,
  counts: Record<string, number>,
  total: number,
  engine: "ripgrep" | "native",
): GrepOutput {
  const filesArr = [...files].slice(0, i.max_results);
  return {
    pattern: i.pattern,
    mode: i.output_mode,
    matches,
    files: i.output_mode === "files_with_matches" ? filesArr : undefined,
    countsByFile: i.output_mode === "count" ? counts : undefined,
    totalMatches: total,
    truncated: total > i.max_results,
    engine,
  };
}
