// Write — overwrite or create a workspace file.
//
// For existing files, requires a prior Read in this session (the model
// must have seen what's there before clobbering it).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, contentHash, pathInputProblem, resolveWorkspacePath, toolError, zPath } from "./_shared.js";
import { safeOverwrite } from "./safeWrite.js";

const inputSchema = z
  .object({
    file_path: zPath,
    content: z.string().describe("Full file contents to write. Replaces any existing file."),
    allow_full_replace: z
      .boolean()
      .optional()
      .describe(
        "Set true only when you intend to collapse a substantial existing file to much smaller content. Without it, such a shrink is refused as a likely fragment.",
      ),
  })
  .strict();

export interface WriteOutput {
  path: string;
  created: boolean;
  bytesWritten: number;
  /** Where the prior contents were saved before this overwrite, if any. */
  backupPath?: string;
}

export const WriteTool = buildTool({
  name: "Write",
  description:
    "Write (overwrite or create) a file. For existing files, you must Read them first in this session.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Writing ${path.basename(i.file_path)}`,

  // Cheap semantic pre-checks: a pattern-looking / workspace-escaping path and
  // an empty body are the Write calls that always burn a turn downstream.
  async validateInput(i, ctx) {
    const pathProblem = pathInputProblem(i.file_path, ctx?.workspace);
    if (pathProblem) return { ok: false, message: `file_path: ${pathProblem}` };
    if (i.content === "" && i.allow_full_replace !== true) {
      return {
        ok: false,
        message:
          "content is empty — Write replaces the WHOLE file, so this would blank it. Pass the full intended contents, or set allow_full_replace to true if you really mean to create/blank an empty file.",
      };
    }
    return { ok: true };
  },

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const existed = await fs.stat(filePath).then(() => true).catch(() => false);
    if (existed && !ctx.fileReadStamps.has(filePath)) {
      return {
        kind: "deny",
        reason: `${filePath} exists; Read it before overwriting so you've seen the current contents.`,
      };
    }
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: WriteOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const existed = await fs.stat(filePath).then(() => true).catch(() => false);
    if (existed && !ctx.fileReadStamps.has(filePath)) {
      throw toolError(`${filePath} exists; Read it before overwriting so you've seen the current contents.`);
    }
    // Staleness guard (matches Edit's discipline): a blind overwrite must not
    // clobber changes made on disk since the last Read. New files (no stamp) are
    // untouched; only an existing file whose content drifted from the read hash
    // is refused — self-correctingly.
    if (existed) {
      const stamp = ctx.fileReadStamps.get(filePath);
      if (stamp?.hash !== undefined) {
        const current = await fs.readFile(filePath, "utf8").catch(() => null);
        if (current !== null && contentHash(current) !== stamp.hash) {
          throw toolError(`${filePath} was modified on disk since the last Read. Re-Read it and retry so you don't clobber newer changes.`);
        }
      }
    }
    const written = await safeOverwrite({
      workspace: ctx.workspace,
      absPath: filePath,
      content: i.content,
      label: "Write",
      allowFullReplace: i.allow_full_replace,
    });
    const stat = await fs.stat(filePath);
    ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash: contentHash(i.content) });
    return {
      output: { path: filePath, created: written.created, bytesWritten: written.bytesWritten, backupPath: written.backupPath },
      touchedFiles: [filePath],
      display: existed ? `Updated ${filePath}` : `Created ${filePath}`,
    };
  },
});
