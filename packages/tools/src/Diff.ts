// Diff - one bounded view of "what did I change": numstat, untracked files, and
// the patch itself, capped per file and in total. Replaces the Bash dance of
// `git status; git diff --stat; git diff` (3 calls, unbounded output) and adds
// a scope check so "never touch unrelated files" is a number, not a hope.

import { z } from "zod";
import { buildTool, resolveWorkspacePath, toolError } from "./_shared.js";
import { changedSince, runGit, snapshotRepo, type DiffNumstat } from "./gitUtil.js";

const inputSchema = z
  .object({
    path: z.string().min(1).optional().describe("Limit to one file or directory (workspace-relative)."),
    base: z.string().min(1).optional().describe("Compare the working tree against this ref (default HEAD)."),
    stat_only: z.boolean().default(false).describe("Only the per-file +/- table, no patch."),
    scope: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe("Path prefixes the change is ALLOWED to touch; anything else is reported as out_of_scope."),
    max_chars: z.number().int().min(500).max(60_000).default(14_000),
    context: z.number().int().min(0).max(20).default(3),
  })
  .strict();

export interface DiffOutput {
  branch?: string;
  head?: string;
  base: string;
  filesChanged: number;
  added: number;
  removed: number;
  files: DiffNumstat["files"];
  untracked: string[];
  outOfScope: string[];
  patch: string;
  truncated: boolean;
}

function inScope(file: string, scope: string[]): boolean {
  const f = file.replace(/\\/g, "/");
  return scope.some((s) => {
    const p = s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    return f === p || f.startsWith(`${p}/`);
  });
}

export const DiffTool = buildTool({
  name: "Diff",
  description:
    "Summarize your uncommitted changes in one bounded call: per-file +/- numstat, untracked files, and the patch (capped). Use before claiming done and before committing; pass `scope` (path prefixes you meant to touch) to surface unrelated edits as out_of_scope.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: () => "Reviewing the diff",

  async call(i, ctx): Promise<{ output: DiffOutput; display: string }> {
    const cwd = await resolveWorkspacePath(ctx, undefined, "path", "read");
    const snap = await snapshotRepo(cwd);
    if (!snap.isRepo) throw toolError("Diff: the workspace is not inside a git work tree, so there is nothing to diff against.");
    const base = i.base ?? "HEAD";
    if (!/^[\w./~^@{}:-]+$/.test(base) || base.startsWith("-")) throw toolError(`Diff: unsafe ref "${base}".`);
    let pathspec: string[] = [];
    if (i.path) {
      const abs = await resolveWorkspacePath(ctx, i.path, "path", "read");
      pathspec = ["--", abs];
    }
    const changed = await changedSince(cwd, base);
    if (!changed.ok) throw toolError(`Diff: git could not diff against "${base}" (unknown ref?).`);
    const files = i.path ? changed.numstat.files.filter((f) => inScope(f.path, [i.path!])) : changed.numstat.files;
    const untracked = i.path ? changed.untracked.filter((f) => inScope(f, [i.path!])) : changed.untracked;
    let patch = "";
    let truncated = false;
    if (!i.stat_only) {
      const res = await runGit(cwd, ["diff", `-U${i.context}`, "--no-ext-diff", base, ...(pathspec.length ? pathspec : ["--"])], { timeoutMs: 30_000 });
      patch = res.stdout;
      if (patch.length > i.max_chars) {
        // Keep whole file sections where possible: cut at a "diff --git" boundary.
        const cut = patch.lastIndexOf("\ndiff --git", i.max_chars);
        patch = `${patch.slice(0, cut > i.max_chars / 3 ? cut : i.max_chars)}\n... [patch truncated at ${i.max_chars} chars; pass path to see one file]`;
        truncated = true;
      }
    }
    const everything = [...files.map((f) => f.path), ...untracked];
    const outOfScope = i.scope && i.scope.length > 0 ? everything.filter((f) => !inScope(f, i.scope!)) : [];
    const added = files.reduce((a, f) => a + (f.added ?? 0), 0);
    const removed = files.reduce((a, f) => a + (f.removed ?? 0), 0);
    const output: DiffOutput = {
      branch: snap.branch,
      head: snap.head?.slice(0, 12),
      base,
      filesChanged: files.length + untracked.length,
      added,
      removed,
      files,
      untracked,
      outOfScope,
      patch,
      truncated,
    };
    return {
      output,
      display: `${output.filesChanged} file(s) changed (+${added} -${removed})${outOfScope.length ? `, ${outOfScope.length} OUT OF SCOPE` : ""}`,
    };
  },
});
