// Read — read a workspace file.
//
// Tracks fileReadStamps so Edit/Write can enforce read-before-write.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath, zPath } from "./_shared.js";

const inputSchema = z
  .object({
    file_path: zPath,
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Line number to start reading from (0-indexed). Omit for whole file."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum lines to read. Omit for whole file."),
  })
  .strict();

export interface ReadOutput {
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  /** cat -n style: "    1\tcontent". */
  content: string;
  truncated: boolean;
}

export const ReadTool = buildTool({
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns lines formatted as `<line_number>\\t<content>`. Use offset/limit for large files.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Reading ${path.basename(i.file_path)}`,

  async call(i, ctx): Promise<{ output: ReadOutput; touchedFiles?: string[]; display?: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "read");
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${filePath} is not a regular file`);
    }
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n");
    const total = lines.length;
    const start = i.offset ?? 0;
    const end = i.limit !== undefined ? Math.min(total, start + i.limit) : total;
    const slice = lines.slice(start, end);

    const formatted = slice
      .map((line, idx) => {
        const n = (start + idx + 1).toString().padStart(5, " ");
        return `${n}\t${line}`;
      })
      .join("\n");

    ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });

    return {
      output: {
        path: filePath,
        totalLines: total,
        startLine: start + 1,
        endLine: end,
        content: formatted,
        truncated: end < total,
      },
      display: `Read ${filePath} (${slice.length}/${total} lines)`,
    };
  },
});
