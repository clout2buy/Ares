// Write — overwrite or create a workspace file.
//
// For existing files, requires a prior Read in this session (the model
// must have seen what's there before clobbering it).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath, zPath } from "./_shared.js";

const inputSchema = z
  .object({
    file_path: zPath,
    content: z.string().describe("Full file contents to write. Replaces any existing file."),
  })
  .strict();

export interface WriteOutput {
  path: string;
  created: boolean;
  bytesWritten: number;
}

export const WriteTool = buildTool({
  name: "Write",
  description:
    "Write (overwrite or create) a file. For existing files, you must Read them first in this session.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Writing ${path.basename(i.file_path)}`,

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
      throw new Error(`${filePath} exists; Read it before overwriting so you've seen the current contents.`);
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, i.content, "utf8");
    const stat = await fs.stat(filePath);
    ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
    return {
      output: { path: filePath, created: !existed, bytesWritten: stat.size },
      touchedFiles: [filePath],
      display: existed ? `Updated ${filePath}` : `Created ${filePath}`,
    };
  },
});
