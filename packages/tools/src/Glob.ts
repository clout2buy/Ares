// Glob — find files by pattern, sorted by mtime descending.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath } from "./_shared.js";

const inputSchema = z
  .object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob pattern, e.g. `src/**/*.ts` or `**/package.json`."),
    cwd: z.string().optional().describe("Root to search from. Defaults to workspace."),
    max_results: z.number().int().positive().default(500),
  })
  .strict();

export interface GlobOutput {
  pattern: string;
  matches: Array<{ path: string; mtimeMs: number; size: number }>;
  truncated: boolean;
}

export const GlobTool = buildTool({
  name: "Glob",
  description:
    "Find files matching a glob pattern. Results sorted by modification time (newest first). Respects .gitignore is NOT implemented yet (M3).",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Globbing ${i.pattern}`,

  // Pattern sanity: the two shapes that silently match NOTHING today are
  // backslash separators (Windows paths pasted as patterns) and absolute
  // patterns (matching runs against workspace-relative paths).
  async validateInput(i) {
    if (i.pattern.trim() === "") {
      return { ok: false, message: "pattern is blank — pass a glob like `src/**/*.ts`." };
    }
    if (i.pattern.includes("\\")) {
      return {
        ok: false,
        message: `pattern "${i.pattern}" contains backslashes — glob patterns use forward slashes even on Windows (e.g. src/**/*.ts).`,
      };
    }
    if (/^([A-Za-z]:|\/)/.test(i.pattern)) {
      return {
        ok: false,
        message: `pattern "${i.pattern}" is an absolute path — pass the root via \`cwd\` and a relative pattern (e.g. cwd: "D:/proj", pattern: "src/**/*.ts").`,
      };
    }
    return { ok: true };
  },

  async call(i, ctx): Promise<{ output: GlobOutput; display: string }> {
    const root = await resolveWorkspacePath(ctx, i.cwd, "cwd", "read");
    const matches = await glob(root, i.pattern, i.max_results + 1);
    const stats = await Promise.all(
      matches.slice(0, i.max_results).map(async (rel) => {
        const abs = path.resolve(root, rel);
        try {
          const stat = await fs.stat(abs);
          return { path: abs, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          return null;
        }
      }),
    );
    const valid = stats.filter((s): s is { path: string; mtimeMs: number; size: number } => s !== null);
    valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      output: {
        pattern: i.pattern,
        matches: valid,
        truncated: matches.length > i.max_results,
      },
      display: `${valid.length} file${valid.length === 1 ? "" : "s"} matched ${i.pattern}`,
    };
  },
});

// Minimal recursive glob implementation. Supports **, *, ?, character classes.
// Production version (M3) will use a real glob library + .gitignore.
async function glob(root: string, pattern: string, limit: number): Promise<string[]> {
  const regex = globToRegExp(pattern);
  const out: string[] = [];
  // Walk dot-dirs (e.g. .github/workflows) but skip heavy/state ones, matching
  // the ripgrep --hidden behavior so Glob and Grep agree on visibility.
  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    ".ares",
    ".crix",
    "dist",
    "build",
    "target",
    ".next",
    ".pnpm-store",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "coverage",
  ]);

  async function walk(dir: string, rel: string): Promise<void> {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        if (regex.test(childRel)) out.push(childRel);
      }
    }
  }

  await walk(root, "");
  return out;
}

function globToRegExp(glob: string): RegExp {
  let r = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // ** — any number of path segments
      r += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      r += "[^/]*";
      i++;
    } else if (c === "?") {
      r += "[^/]";
      i++;
    } else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) {
        r += "\\{";
        i++;
        continue;
      }
      const opts = glob.slice(i + 1, close).split(",");
      r += "(?:" + opts.map(escapeRegex).join("|") + ")";
      i = close + 1;
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
