// Write — overwrite or create a workspace file.
//
// For existing files, requires a prior Read in this session (the model
// must have seen what's there before clobbering it).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, zAbsPath } from "./_shared.js";

const inputSchema = z
  .object({
    file_path: zAbsPath,
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
    const existed = await fs.stat(i.file_path).then(() => true).catch(() => false);
    if (existed && !ctx.fileReadStamps.has(i.file_path)) {
      return {
        kind: "deny",
        reason: `${i.file_path} exists; Read it before overwriting so you've seen the current contents.`,
      };
    }
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: WriteOutput; touchedFiles: string[]; display: string }> {
    const existed = await fs.stat(i.file_path).then(() => true).catch(() => false);
    await fs.mkdir(path.dirname(i.file_path), { recursive: true });
    await fs.writeFile(i.file_path, i.content, "utf8");
    const stat = await fs.stat(i.file_path);
    ctx.fileReadStamps.set(i.file_path, { mtimeMs: stat.mtimeMs, size: stat.size });
    return {
      output: { path: i.file_path, created: !existed, bytesWritten: stat.size },
      touchedFiles: [i.file_path],
      display: existed ? `Updated ${i.file_path}` : `Created ${i.file_path}`,
    };
  },
});
