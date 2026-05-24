// Grep — regex search over workspace files.
//
// Prefers ripgrep (`rg`) when on PATH for speed; falls back to a native JS
// implementation otherwise so tests work without external deps.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildTool } from "./_shared.js";

const inputSchema = z
  .object({
    pattern: z.string().min(1).describe("Regular expression to search for."),
    path: z.string().optional().describe("File or directory to search; defaults to workspace."),
    glob: z.string().optional().describe("Filter files by glob, e.g. `*.ts`."),
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
    const root = i.path ?? ctx.workspace;
    const ripgrep = await tryRipgrep(i, root, ctx.signal);
    const output: GrepOutput = ripgrep ?? (await nativeGrep(i, root));
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
  root: string,
  signal: AbortSignal,
): Promise<GrepOutput | null> {
  const rgPath = await which("rg");
  if (!rgPath) return null;

  const args: string[] = ["--no-config", "--json", "--hidden", "--glob", "!.git"];
  if (i.case_insensitive) args.push("-i");
  if (i.glob) args.push("--glob", i.glob);
  if (i.output_mode === "content") {
    if (i.context_before > 0) args.push("-B", String(i.context_before));
    if (i.context_after > 0) args.push("-A", String(i.context_after));
  }
  args.push("-e", i.pattern, root);

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
  root: string,
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
        if (i.glob && !matchesGlob(e.name, i.glob)) continue;
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
            if (i.output_mode === "content" && matches.length < i.max_results) {
              matches.push({ path: abs, line: lineIdx + 1, text: lines[lineIdx] });
            }
          }
        }
      }
    }
  }

  const stat = await fs.stat(root).catch(() => null);
  if (stat?.isFile()) {
    const text = await fs.readFile(root, "utf8");
    const lines = text.split("\n");
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (regex.test(lines[lineIdx])) {
        files.add(root);
        counts[root] = (counts[root] ?? 0) + 1;
        total++;
        if (matches.length < i.max_results) {
          matches.push({ path: root, line: lineIdx + 1, text: lines[lineIdx] });
        }
      }
    }
  } else {
    await walk(root);
  }

  return buildOutput(i, matches, files, counts, total, "native");
}

function matchesGlob(filename: string, pattern: string): boolean {
  // Simple suffix glob support: "*.ts" → endsWith(".ts")
  if (pattern.startsWith("*")) return filename.endsWith(pattern.slice(1));
  return filename === pattern;
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
