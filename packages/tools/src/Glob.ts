// Glob — find files by pattern, sorted by mtime descending.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, repositoryInstructionsText, resolveWorkspacePath } from "./_shared.js";

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
  /** The walk hit its wall-clock or visit cap; the list is partial. */
  capped?: boolean;
  /** Repository rules newly applicable to the searched root. */
  repositoryInstructions?: string;
}

/** Wall-clock cap for one walk (ARES_GLOB_TIMEOUT_MS, default 15s). */
function globTimeoutMs(): number {
  const n = Number(process.env.ARES_GLOB_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 200 ? n : 15_000;
}
/** Directory entries visited before giving up (a node_modules-sized tree under an odd name). */
const MAX_VISITED_ENTRIES = 300_000;

interface WalkState {
  capped: boolean;
}

export const GlobTool = buildTool({
  name: "Glob",
  description:
    "Find files matching a glob pattern. Results sorted by modification time (newest first). Respects .gitignore is NOT implemented yet (M3).",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Globbing ${i.pattern}`,

  // A blank pattern is the only one bounced. Backslash separators and absolute
  // patterns used to be refused here (26 field errors, each a wasted round
  // trip for a path style); call() now normalizes them instead.
  async validateInput(i) {
    if (i.pattern.trim() === "") {
      return { ok: false, message: "pattern is blank — pass a glob like `src/**/*.ts`." };
    }
    return { ok: true };
  },

  async call(i, ctx): Promise<{ output: GlobOutput; display: string }> {
    const request = normalizeGlobRequest(i.pattern, i.cwd);
    const root = await resolveWorkspacePath(ctx, request.cwd, "cwd", "read");
    const walkState: WalkState = { capped: false };
    const matches = await glob(root, request.pattern, i.max_results + 1, walkState);
    const rules = await repositoryInstructionsText(ctx, [root]);
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
        pattern: request.pattern,
        matches: valid,
        truncated: matches.length > i.max_results || walkState.capped,
        ...(walkState.capped ? { capped: true } : {}),
        ...(rules ? { repositoryInstructions: rules } : {}),
      },
      display: `${valid.length} file${valid.length === 1 ? "" : "s"} matched ${i.pattern}`,
    };
  },
});

/**
 * Never bounce the model for a path style. Backslashes become forward slashes
 * (a Windows path pasted as a pattern), and an absolute pattern is split at the
 * last separator before its first wildcard into a root (`cwd`) and a relative
 * pattern, since matching runs on root-relative paths. A literal absolute file
 * path becomes its directory + its name.
 */
export function normalizeGlobRequest(pattern: string, cwd?: string): { pattern: string; cwd?: string } {
  let normalized = pattern.trim().replace(/\\/g, "/");
  if (!/^([A-Za-z]:\/|\/)/.test(normalized)) {
    while (normalized.startsWith("./")) normalized = normalized.slice(2);
    return { pattern: normalized || "**/*", ...(cwd !== undefined ? { cwd } : {}) };
  }
  const firstMeta = normalized.search(/[*?[{]/);
  const cut = normalized.lastIndexOf("/", (firstMeta < 0 ? normalized.length : firstMeta) - 1);
  // Keep the separator when the root IS the drive or filesystem root.
  const root = normalized.slice(0, cut);
  return {
    pattern: normalized.slice(cut + 1) || "**/*",
    cwd: root === "" || /^[A-Za-z]:$/.test(root) ? `${root}/` : root,
  };
}

// Minimal recursive glob implementation. Supports **, *, ?, character classes.
// Production version (M3) will use a real glob library + .gitignore.
async function glob(root: string, pattern: string, limit: number, state: WalkState = { capped: false }): Promise<string[]> {
  const regex = globToRegExp(pattern);
  const out: string[] = [];
  const deadline = Date.now() + globTimeoutMs();
  let visited = 0;
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
      if (out.length >= limit || state.capped) return;
      if (++visited > MAX_VISITED_ENTRIES || ((visited & 255) === 0 && Date.now() > deadline)) {
        state.capped = true;
        return;
      }
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
