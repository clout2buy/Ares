// Edit — exact string replacement in a file.
//
// Rules (matching Claude Code's Edit semantics):
//   - File must have been Read in this session.
//   - old_string must appear exactly once unless replace_all is true.
//   - File mtime must match the last Read stamp (no race with disk edits).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath, zPath } from "./_shared.js";

const inputSchema = z
  .object({
    file_path: zPath,
    old_string: z.string().describe("Exact text to replace. Must be unique unless replace_all."),
    new_string: z.string().describe("Replacement text. Must differ from old_string."),
    replace_all: z
      .boolean()
      .default(false)
      .describe("If true, replace every occurrence; otherwise old_string must be unique."),
  })
  .strict();

export interface EditOutput {
  path: string;
  replacements: number;
}

export const EditTool = buildTool({
  name: "Edit",
  description:
    "Replace exact text in a file. Requires prior Read. Fails if old_string is non-unique (set replace_all to true to replace every occurrence).",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Editing ${path.basename(i.file_path)}`,

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    if (i.old_string === i.new_string) {
      return { kind: "deny", reason: "old_string and new_string are identical" };
    }
    if (!ctx.fileReadStamps.has(filePath)) {
      return { kind: "deny", reason: `Read ${filePath} before editing it.` };
    }
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: EditOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const stamp = ctx.fileReadStamps.get(filePath);
    if (!stamp) throw new Error(`${filePath}: missing read stamp`);

    const stat = await fs.stat(filePath);
    if (stat.mtimeMs > stamp.mtimeMs + 5) {
      throw new Error(
        `${filePath} was modified on disk since the last Read. Re-Read and retry.`,
      );
    }

    const content = await fs.readFile(filePath, "utf8");
    const occurrences = countOccurrences(content, i.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${filePath}`);
    }
    if (occurrences > 1 && !i.replace_all) {
      throw new Error(
        `old_string is not unique in ${filePath} (${occurrences} matches). Provide more context or set replace_all to true.`,
      );
    }

    const updated = i.replace_all
      ? content.split(i.old_string).join(i.new_string)
      : content.replace(i.old_string, i.new_string);

    await fs.writeFile(filePath, updated, "utf8");
    const newStat = await fs.stat(filePath);
    ctx.fileReadStamps.set(filePath, { mtimeMs: newStat.mtimeMs, size: newStat.size });

    const replacements = i.replace_all ? occurrences : 1;
    return {
      output: { path: filePath, replacements },
      touchedFiles: [filePath],
      display: `Edited ${filePath} (${replacements} replacement${replacements === 1 ? "" : "s"})`,
    };
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
