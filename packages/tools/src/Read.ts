// Read — read a workspace file.
//
// Tracks fileReadStamps so Edit/Write can enforce read-before-write.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, contentHash, resolveWorkspacePath, zPath } from "./_shared.js";
import type { FileReadStamp } from "./_shared.js";

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

  async call(i, ctx): Promise<{ output: ReadOutput; touchedFiles?: string[]; display?: string; images?: Array<{ mediaType: string; data: string }> }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "read");
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${filePath} is not a regular file`);
    }

    // Image files: reading the bytes as utf8 returns garbage that bloats and
    // corrupts the context (and the model can't judge a render from binary). Return
    // the image through the VISION channel so the model can actually SEE it — judge
    // a generated picture, read a screenshot, inspect a diagram. The engine forwards
    // tool-result images to the model as image blocks.
    const imageMedia = imageMediaType(filePath);
    if (imageMedia) {
      const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
      if (stat.size > MAX_IMAGE_BYTES) {
        return {
          output: {
            path: filePath,
            totalLines: 0,
            startLine: 0,
            endLine: 0,
            content: `<system>Image "${path.basename(filePath)}" is ${(stat.size / 1048576).toFixed(1)}MB — too large to inline (cap 12MB). Downscale it first, then Read again.</system>`,
            truncated: true,
          },
          display: `Read ${path.basename(filePath)} — image too large (${(stat.size / 1048576).toFixed(1)}MB)`,
        };
      }
      const data = (await fs.readFile(filePath)).toString("base64");
      const kb = Math.max(1, Math.round(stat.size / 1024));
      return {
        output: {
          path: filePath,
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          content: `<system>Image "${path.basename(filePath)}" (${imageMedia}, ${kb}KB) is shown above.</system>`,
          truncated: false,
        },
        images: [{ mediaType: imageMedia, data }],
        display: `Read ${path.basename(filePath)} (image · ${kb}KB)`,
      };
    }

    // Re-read guard: a whole-file Read of something already in context this
    // session, unchanged on disk, returns a pointer instead of a second full
    // dump — the single biggest source of context bloat / tool spam. Range reads
    // (offset/limit) always pass through, and any real edit changes mtime/size
    // so a legitimately-changed file is always re-read.
    const prior = ctx.fileReadStamps.get(filePath);
    const wholeFile = i.offset === undefined && i.limit === undefined;
    // A write-only stamp does NOT satisfy the re-read guard: the model wrote the
    // file but never saw the full post-edit result, so a whole-file Read must
    // actually re-read rather than claim "already in your context."
    if (prior && !prior.writtenNotRead && wholeFile && prior.mtimeMs === stat.mtimeMs && prior.size === stat.size) {
      // The model-visible content MUST NOT look like an empty file, or a model
      // that re-reads because it lost track will edit/rewrite blind. Put the
      // explanation in `content` itself, report the real line count, and cite the
      // tracked hash so the model can tell this is the SAME bytes it already has.
      const priorTotal = prior.lines ?? 0;
      const hashTag = prior.hash ? ` [sha256:${prior.hash.slice(0, 12)}]` : "";
      const note = `<system>File "${path.basename(filePath)}" (${priorTotal} lines${hashTag}) is unchanged on disk and already in your context this session — its full contents are above. Work from what you already have, or pass offset/limit to re-fetch a specific range.</system>`;
      return {
        output: {
          path: filePath,
          totalLines: priorTotal,
          startLine: 0,
          endLine: 0,
          content: note,
          truncated: false,
        },
        display: `Skipped re-read of ${path.basename(filePath)} — already in context this session, unchanged.`,
      };
    }

    const raw = await fs.readFile(filePath, "utf8");

    // A genuinely empty file: say so explicitly. Returning "" (or a lone blank
    // cat -n line) is indistinguishable from "content omitted" and invites a
    // blind rewrite. Still record the read stamp so Write's read-before-write is
    // satisfied for filling the file in.
    if (raw === "") {
      ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash: contentHash(raw), lines: 0 });
      return {
        output: {
          path: filePath,
          totalLines: 0,
          startLine: 0,
          endLine: 0,
          content: `<system>File "${path.basename(filePath)}" is empty (0 bytes). Use Write to add contents.</system>`,
          truncated: false,
        },
        display: `Read ${filePath} (empty file)`,
      };
    }
    // Strip \r so CRLF files present clean lines — the model can't see (or
    // reproduce) a trailing \r, and Edit matches in EOL-normalized space.
    const lines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
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

    // Self-correcting output: when the view is partial, the result text itself
    // tells the model exactly how to fetch the rest (Pi's "the error is the fix").
    const truncated = end < total;
    const content = truncated
      ? `${formatted}\n\n[Read stopped at line ${end} of ${total}. Use offset=${end}${i.limit !== undefined ? ` limit=${i.limit}` : ""} to continue.]`
      : formatted;

    ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash: contentHash(raw), lines: total });

    return {
      output: {
        path: filePath,
        totalLines: total,
        startLine: start + 1,
        endLine: end,
        content,
        truncated,
      },
      display: `Read ${filePath} (${slice.length}/${total} lines)`,
    };
  },
});

/** Media type for an image file by extension, or null if it isn't a (supported)
 *  image. Drives Read's vision-channel branch so a Read of a render/screenshot
 *  returns something the model can SEE, not a wall of binary. */
function imageMediaType(file: string): string | null {
  switch (path.extname(file).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return null;
  }
}
