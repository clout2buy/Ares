// ApplyIntent — cheap whole-file edit materialization through APPLY slot.
//
// The model describes the intended change and supplies a sketch. When a
// sub-model is available, the APPLY slot converts that into final file
// content. Without a sub-model, Ares still supports full-file sketches so
// tests and offline use remain deterministic.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, resolveWorkspacePath, zPath } from "./_shared.js";
import { safeOverwrite } from "./safeWrite.js";

const inputSchema = z
  .object({
    file_path: zPath,
    instructions: z
      .string()
      .min(1)
      .describe("Plain-English edit intent. State behavior, constraints, and any invariants to preserve."),
    sketch: z
      .string()
      .min(1)
      .describe(
        "Either full final file content, or a concise sketch using `... existing code ...` markers. Marker sketches require an APPLY sub-model.",
      ),
    allow_full_replace: z
      .boolean()
      .optional()
      .describe(
        "Set true only when you intend to replace the ENTIRE file with much smaller content. Without it, a full-file sketch that collapses a substantial file is refused (it's almost always a fragment mistaken for the whole file).",
      ),
  })
  .strict();

export interface ApplyIntentOutput {
  path: string;
  bytesWritten: number;
  engine: "apply-slot" | "full-file-sketch";
  /** Where the prior contents were saved before this overwrite, if any. */
  backupPath?: string;
}

export const ApplyIntentTool = buildTool({
  name: "ApplyIntent",
  description:
    "Materialize a large or multi-line edit from intent + sketch. Requires prior Read. Prefer this over huge Edit payloads: pass concise instructions plus a sketch. If the sketch uses `... existing code ...`, Ares routes through the APPLY slot; full-file sketches work offline.",
  safety: "workspace-write",
  concurrency: "exclusive",
  providerHint: "apply",
  inputZod: inputSchema,
  activityDescription: (i) => `ApplyIntent ${path.basename(i.file_path)}`,

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    if (!ctx.fileReadStamps.has(filePath)) {
      return { kind: "deny", reason: `Read ${filePath} before applying an intent edit.` };
    }
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: ApplyIntentOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const stamp = ctx.fileReadStamps.get(filePath);
    if (!stamp) throw new Error(`${filePath}: missing read stamp`);

    const stat = await fs.stat(filePath);
    if (stat.mtimeMs > stamp.mtimeMs + 5) {
      throw new Error(`${filePath} was modified on disk since the last Read. Re-Read and retry.`);
    }

    const original = await fs.readFile(filePath, "utf8");
    const sketch = stripCodeFence(i.sketch);
    let finalContent: string;
    let engine: ApplyIntentOutput["engine"];

    if (hasExistingCodeMarker(sketch)) {
      if (!ctx.subModel?.apply) {
        throw new Error(
          "ApplyIntent marker sketches require an APPLY sub-model. Provide full final file content in `sketch`, or run with Ollama Cloud APPLY configured.",
        );
      }
      finalContent = stripCodeFence(
        await ctx.subModel.apply({
          file: filePath,
          original,
          instructions: i.instructions,
          sketch,
        }),
      );
      engine = "apply-slot";
    } else {
      finalContent = sketch;
      engine = "full-file-sketch";
    }

    if (!finalContent.length) throw new Error("ApplyIntent produced empty output; refusing to overwrite file.");

    const written = await safeOverwrite({
      workspace: ctx.workspace,
      absPath: filePath,
      content: finalContent,
      label: "ApplyIntent",
      allowFullReplace: i.allow_full_replace,
    });
    const newStat = await fs.stat(filePath);
    ctx.fileReadStamps.set(filePath, { mtimeMs: newStat.mtimeMs, size: newStat.size });

    return {
      output: { path: filePath, bytesWritten: written.bytesWritten, engine, backupPath: written.backupPath },
      touchedFiles: [filePath],
      display: `Applied intent to ${filePath} via ${engine}`,
    };
  },
});

function stripCodeFence(input: string): string {
  const s = input.replace(/\r\n/g, "\n").trim();
  const match = s.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : s;
}

function hasExistingCodeMarker(input: string): boolean {
  return /(^|\n)\s*(\/\/|#|<!--|\/\*)?\s*\.{3}\s*existing code\s*\.{3}\s*(-->| \*\/|\*\/)?\s*(\n|$)/i.test(input);
}
