// Write — overwrite or create a workspace file.
//
// For existing files the model should have Read first; when it hasn't, Write
// auto-reads (ARES_EDIT_AUTO_READ=0 restores the refusal) and echoes the head
// of the OLD content in the result so the model sees what it replaced. The
// shrink guard (assertSafeReplacement) and hash staleness check still apply.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type PostMutationFeedback,
  WorkspaceMutationError,
  WorkspaceMutationService,
  workspaceContentHash,
} from "@ares/core";
import {
  autoReadForMutation,
  buildTool,
  contentHash,
  editAutoReadEnabled,
  mutationInstructionBlock,
  mutationWorkspaceForPaths,
  pathInputProblem,
  resolveWorkspacePath,
  toolError,
  zPath,
} from "./_shared.js";
import { assertSafeReplacement, createOverwriteBackup } from "./safeWrite.js";
import { appendMutationFeedback, collectMutationFeedback } from "./postMutationFeedback.js";

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
  /** Immediate formatter/type diagnostics, attributed to the committed SHA-256. */
  feedback?: PostMutationFeedback;
  /** True when Write read the existing file itself because it had not been
   *  Read this session (see ARES_EDIT_AUTO_READ). */
  autoRead?: boolean;
  /** First ~20 lines of the content that was REPLACED, present only on an
   *  auto-read overwrite of a non-empty file — the model never saw those bytes. */
  previousContentPreview?: string;
}

/** How much of the clobbered file to echo back on an auto-read overwrite. */
const PREVIOUS_PREVIEW_LINES = 20;

function previousContentPreview(previous: string): string {
  const lines = previous.split(/\r?\n/);
  // A trailing newline is not an extra line (matches how Read counts).
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, PREVIOUS_PREVIEW_LINES);
  const body = shown.map((line, idx) => `${(idx + 1).toString().padStart(5, " ")}\t${line}`).join("\n");
  return lines.length > PREVIOUS_PREVIEW_LINES ? `${body}\n     …\t[${lines.length - PREVIOUS_PREVIEW_LINES} more lines]` : body;
}

export const WriteTool = buildTool({
  name: "Write",
  description:
    "Write (overwrite or create) a file. For existing files you should Read them first; if you have not, Write auto-reads the file and returns the head of the replaced content so you can confirm nothing was lost.",
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
    // Read-first is enforced by auto-reading in call(); the deny survives only
    // behind ARES_EDIT_AUTO_READ=0 (see editAutoReadEnabled for why).
    if (existed && !ctx.fileReadStamps.has(filePath) && !editAutoReadEnabled()) {
      return {
        kind: "deny",
        reason: `${filePath} exists; Read it before overwriting so you've seen the current contents.`,
      };
    }
    const instructionBlock = await mutationInstructionBlock(ctx, [filePath]);
    if (instructionBlock) return { kind: "deny", reason: instructionBlock };
    return { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: WriteOutput; touchedFiles: string[]; display: string }> {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    const existed = await fs.stat(filePath).then(() => true).catch(() => false);
    let autoRead = false;
    if (existed && !ctx.fileReadStamps.has(filePath)) {
      if (!editAutoReadEnabled()) {
        throw toolError(`${filePath} exists; Read it before overwriting so you've seen the current contents.`);
      }
      await autoReadForMutation(ctx, filePath, "overwriting");
      autoRead = true;
    }
    // Staleness guard (matches Edit's discipline): a blind overwrite must not
    // clobber changes made on disk since the last Read. New files (no stamp) are
    // untouched; only an existing file whose content drifted from the read hash
    // is refused — self-correctingly.
    let current: string | null = null;
    if (existed) {
      current = await fs.readFile(filePath, "utf8");
      const stamp = ctx.fileReadStamps.get(filePath);
      if (stamp?.hash !== undefined) {
        if (contentHash(current) !== stamp.hash) {
          throw toolError(`${filePath} was modified on disk since the last Read. Re-Read it and retry so you don't clobber newer changes.`);
        }
      }
      assertSafeReplacement({
        original: current,
        next: i.content,
        label: "Write",
        absPath: filePath,
        allowFullReplace: i.allow_full_replace,
      });
    }

    let backupPath: string | undefined;
    let feedback: PostMutationFeedback | undefined;
    const mutationWorkspace = await mutationWorkspaceForPaths(ctx.workspace, [filePath]);
    // Keep the established user-visible backup/index in addition to the
    // transaction's private rollback blob. This applies equally to an approved
    // external project; bytes are committed in that project, not copied later.
    if (existed && current !== null) {
      backupPath = await createOverwriteBackup(ctx.workspace, filePath, current, "Write");
    }
    if (!(existed && current === i.content)) {
      try {
        const receipt = await new WorkspaceMutationService(mutationWorkspace).apply(
          existed
            ? [{ kind: "update", path: filePath, expectedHash: workspaceContentHash(current ?? ""), content: i.content }]
            : [{ kind: "add", path: filePath, content: i.content }],
          { label: "Write", transactionId: ctx.mutationTransactionId },
        );
        feedback = await collectMutationFeedback(mutationWorkspace, receipt);
      } catch (error) {
        if (error instanceof WorkspaceMutationError) {
          throw toolError(`${error.message} ${error.actionable}`);
        }
        throw error;
      }
    }
    const stat = await fs.stat(filePath);
    ctx.fileReadStamps.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash: contentHash(i.content) });
    // An auto-read overwrite of a non-empty file replaced bytes the model never
    // saw: echo the head of the old content so it can spot a mistaken clobber.
    const preview = autoRead && current !== null && current.length > 0 ? previousContentPreview(current) : undefined;
    const autoReadNote = autoRead
      ? `\n(auto-read ${filePath} before overwriting)${preview ? `\nReplaced content began with:\n${preview}` : ""}`
      : "";
    return {
      output: {
        path: filePath,
        created: !existed,
        bytesWritten: stat.size,
        backupPath,
        feedback,
        ...(autoRead ? { autoRead: true } : {}),
        ...(preview !== undefined ? { previousContentPreview: preview } : {}),
      },
      touchedFiles: [filePath],
      display: appendMutationFeedback(`${existed ? `Updated ${filePath}` : `Created ${filePath}`}${autoReadNote}`, feedback),
    };
  },
});
