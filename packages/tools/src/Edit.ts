// Edit — string replacement in a file, resilient to line-ending drift.
//
// Rules (matching Claude Code's Edit semantics):
//   - File must have been Read in this session.
//   - old_string must appear exactly once unless replace_all is true.
//   - File mtime must match the last Read stamp (no race with disk edits).
//
// Matching is layered because models reliably reproduce file text with LF line
// endings even when the file on disk is CRLF (the classic Windows edit-killer),
// and often drop trailing whitespace:
//   1. exact match in EOL-normalized space (covers both exact and CRLF-vs-LF)
//   2. trailing-whitespace-insensitive line-block match (single occurrence only)
// The file's dominant EOL style is preserved on write.

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, contentHash, resolveWorkspacePath, toolError, zPath } from "./_shared.js";
import type { FileReadStamp } from "./_shared.js";

// A post-write stamp carries `writtenNotRead` so Read's re-read guard does a
// real re-read (the model wrote these bytes but never saw the full file). The
// flag isn't on the shared FileReadStamp type — it rides as an optional runtime
// extension so this package needn't widen _shared.ts.
type WrittenStamp = FileReadStamp & { writtenNotRead?: boolean };

const editHunk = z
  .object({
    old_string: z.string().describe("Exact text to replace. Must be unique unless replace_all."),
    new_string: z.string().describe("Replacement text. Must differ from old_string."),
    replace_all: z.boolean().default(false).describe("If true, replace every occurrence of this hunk."),
  })
  .strict();

const inputSchema = z
  .object({
    file_path: zPath,
    // Single-edit mode (omit when using `edits`).
    old_string: z.string().optional().describe("Single-edit mode: exact text to replace. Omit when using `edits`."),
    new_string: z.string().optional().describe("Single-edit mode: replacement text."),
    replace_all: z.boolean().default(false).describe("Single-edit mode: replace every occurrence."),
    // Batch mode.
    edits: z
      .array(editHunk)
      .optional()
      .describe(
        "Batch mode: multiple edits applied ATOMICALLY and in order to this ONE file. When set, the top-level old_string/new_string are ignored. All-or-nothing — if ANY hunk fails to match, NOTHING is written. Prefer this over several separate Edit calls for multi-site changes in the same file.",
      ),
  })
  .strict();

type EditInput = z.infer<typeof inputSchema>;

/** Normalize either mode into an ordered list of hunks. */
function editHunks(i: EditInput): Array<{ old_string: string; new_string: string; replace_all: boolean }> {
  if (Array.isArray(i.edits) && i.edits.length > 0) {
    return i.edits.map((h) => ({ old_string: h.old_string, new_string: h.new_string, replace_all: h.replace_all }));
  }
  return [{ old_string: i.old_string ?? "", new_string: i.new_string ?? "", replace_all: i.replace_all }];
}

export interface EditOutput {
  path: string;
  replacements: number;
  /** Which matching layer landed the edit: "exact" | "whitespace". */
  matchedBy: string;
  /** cat -n style excerpt of each edited region WITH a few lines of surrounding
   *  context, so the model can verify the change landed without a follow-up Read
   *  (which would only re-read the file it just wrote). */
  diff: string;
}

export const EditTool = buildTool({
  name: "Edit",
  description:
    "Replace exact text in a file (requires prior Read; tolerates CRLF/LF + trailing-whitespace drift). Single edit: old_string/new_string. Multi-site: pass `edits` — an ATOMIC, all-or-nothing batch applied in order (use this instead of many separate Edit calls on one file). Fails if an old_string is non-unique (set replace_all).",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Editing ${path.basename(i.file_path)}`,

  // Cheap, pure pre-checks (run before permission/exec), per hunk for both modes:
  // a missing mode, an empty old_string, or a no-op identical edit are common
  // model mistakes that would otherwise fail deep in matching. Catch them early
  // with a clear, correctable message.
  async validateInput(i) {
    const usingBatch = Array.isArray(i.edits) && i.edits.length > 0;
    if (!usingBatch && (i.old_string === undefined || i.new_string === undefined)) {
      return {
        ok: false,
        message: "Provide both old_string and new_string for a single edit, or an `edits` array for an atomic batch.",
      };
    }
    const hunks = editHunks(i);
    for (let idx = 0; idx < hunks.length; idx++) {
      const where = hunks.length > 1 ? ` (edit ${idx + 1})` : "";
      if (hunks[idx].old_string === "") {
        return {
          ok: false,
          message: `old_string is empty${where}. Provide the exact existing text to replace, or use Write to create/replace the whole file.`,
        };
      }
      if (hunks[idx].old_string === hunks[idx].new_string) {
        return { ok: false, message: `old_string and new_string are identical${where} — the edit would be a no-op.` };
      }
    }
    return { ok: true };
  },

  async checkPermissions(i, ctx) {
    const filePath = await resolveWorkspacePath(ctx, i.file_path, "file_path", "write");
    // Guard the identical check on single mode (old_string defined) — in batch
    // mode both are undefined and this must not fire.
    if (i.old_string !== undefined && i.old_string === i.new_string) {
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

    const content = await fs.readFile(filePath, "utf8");
    // Staleness check (C2): the content hash is exact and immune to mtime
    // granularity races. Fall back to mtime only for stamps written before the
    // hash existed (resumed sessions / older rollouts).
    if (stamp.hash !== undefined) {
      if (contentHash(content) !== stamp.hash) {
        throw toolError(
          `${filePath} was modified on disk since the last Read. Re-Read and retry.`,
        );
      }
    } else {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs > stamp.mtimeMs + 5) {
        throw toolError(
          `${filePath} was modified on disk since the last Read. Re-Read and retry.`,
        );
      }
    }
    // Atomic batch: apply every hunk in order to an in-memory working copy.
    // Only write once ALL hunks resolve — if any fails the file is untouched, so
    // a multi-site edit can never half-apply (the classic "edit 2's text is gone
    // after edit 1" failure becomes a clean, recoverable error instead).
    const hunks = editHunks(i);
    let working = content;
    let totalReplacements = 0;
    const matchedBys = new Set<string>();
    for (let idx = 0; idx < hunks.length; idx++) {
      const h = hunks[idx];
      const result = replaceResilient(working, h.old_string, h.new_string, h.replace_all);
      if (!result.ok) {
        const where = hunks.length > 1 ? ` (edit ${idx + 1} of ${hunks.length})` : "";
        const batchNote = hunks.length > 1 ? " No edits were applied — the batch is all-or-nothing." : "";
        if (result.reason === "not-found") {
          throw toolError(
            `old_string not found in ${filePath}${where} (tried exact and whitespace-tolerant matching). ` +
              `Re-Read the file and copy the text exactly as it appears, without line-number prefixes.${batchNote}`,
          );
        }
        throw toolError(
          `old_string is not unique in ${filePath}${where} (${result.occurrences} matches). Provide more context or set replace_all to true.${batchNote}`,
        );
      }
      working = result.text;
      totalReplacements += result.replacements;
      matchedBys.add(result.matchedBy);
    }

    await fs.writeFile(filePath, working, "utf8");
    const newStat = await fs.stat(filePath);
    // Stamp the WRITE, not a read: keep the hash/size current so a follow-up Edit
    // in the same turn passes read-before-write + staleness, but mark it
    // writtenNotRead so a whole-file Read still does a REAL read — the model
    // wrote these bytes but never saw the full post-edit file.
    const writtenStamp: WrittenStamp = {
      mtimeMs: newStat.mtimeMs,
      size: newStat.size,
      hash: contentHash(working),
      lines: countLines(working),
      writtenNotRead: true,
    };
    ctx.fileReadStamps.set(filePath, writtenStamp);

    const matchedBy = [...matchedBys].join(",");
    const note = matchedBy === "exact" ? "" : ` [matched via ${matchedBy}]`;
    const across = hunks.length > 1 ? ` across ${hunks.length} edits` : "";
    // Return the edited region(s) with surrounding context so the model can
    // verify the change from the tool result alone (like Claude Code's Edit),
    // instead of issuing a follow-up Read that would only re-read what it wrote.
    const diff = editedExcerpt(content, working);
    return {
      output: { path: filePath, replacements: totalReplacements, matchedBy, diff },
      touchedFiles: [filePath],
      display: `Edited ${filePath} (${totalReplacements} replacement${totalReplacements === 1 ? "" : "s"}${across})${note}${diff ? `\n${diff}` : ""}`,
    };
  },
});

type ReplaceResult =
  | { ok: true; text: string; replacements: number; matchedBy: "exact" | "whitespace" }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-unique"; occurrences: number };

/**
 * Layered replacement. All matching happens in LF-normalized space so CRLF
 * files and LF-quoting models agree; the file's dominant EOL is re-applied to
 * the final text. Mixed-EOL files come out consistently in their dominant
 * style — an acceptable trade for edits that actually land.
 */
export function replaceResilient(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceResult {
  const eol = dominantEol(content);
  const haystack = toLf(content);
  const needle = toLf(oldString);
  const replacement = toLf(newString);

  // Layer 1: exact (in normalized space — equals raw exact for LF files,
  // and transparently fixes the CRLF-vs-LF mismatch).
  const occurrences = countOccurrences(haystack, needle);
  if (occurrences > 0) {
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, reason: "not-unique", occurrences };
    }
    const text = replaceAll
      ? haystack.split(needle).join(replacement)
      : haystack.replace(needle, replacement);
    return {
      ok: true,
      text: fromLf(text, eol),
      replacements: replaceAll ? occurrences : 1,
      matchedBy: "exact",
    };
  }

  // Layer 2: line-block match ignoring trailing whitespace on each line.
  // Only safe for a single unambiguous occurrence.
  const fuzzy = fuzzyLineReplace(haystack, needle, replacement);
  if (fuzzy.kind === "replaced") {
    return { ok: true, text: fromLf(fuzzy.text, eol), replacements: 1, matchedBy: "whitespace" };
  }
  if (fuzzy.kind === "ambiguous") {
    return { ok: false, reason: "not-unique", occurrences: fuzzy.matches };
  }
  return { ok: false, reason: "not-found" };
}

function fuzzyLineReplace(
  content: string,
  oldString: string,
  newString: string,
): { kind: "replaced"; text: string } | { kind: "ambiguous"; matches: number } | { kind: "none" } {
  const contentLines = content.split("\n");
  const oldLines = oldString.split("\n").map(stripTrailingWs);
  if (oldLines.length === 0 || (oldLines.length === 1 && oldLines[0] === "")) return { kind: "none" };

  let matchIndex = -1;
  let matches = 0;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let hit = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (stripTrailingWs(contentLines[i + j]) !== oldLines[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      matches++;
      matchIndex = i;
      if (matches > 1) return { kind: "ambiguous", matches };
    }
  }
  if (matches !== 1) return { kind: "none" };

  const updated = [
    ...contentLines.slice(0, matchIndex),
    ...newString.split("\n"),
    ...contentLines.slice(matchIndex + oldLines.length),
  ];
  return { kind: "replaced", text: updated.join("\n") };
}

function dominantEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function fromLf(text: string, eol: "\r\n" | "\n"): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

function stripTrailingWs(line: string): string {
  return line.replace(/[ \t\r]+$/, "");
}

/** Line count of a text blob (matches Read's `total = raw.split("\n").length`). */
function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * Build a bounded cat -n excerpt of the regions that changed between `before`
 * and `after`, with a few lines of surrounding context per hunk — so the model
 * can verify the edit landed straight from the tool result. Line numbers are
 * post-edit (what a subsequent Read would show). Whole-file rewrites are capped.
 */
function editedExcerpt(before: string, after: string): string {
  const CONTEXT = 3;
  const MAX_LINES = 60; // hard ceiling so a huge edit can't flood the result
  const a = toLf(before).split("\n");
  const b = toLf(after).split("\n");

  // Cheap common-prefix / common-suffix trim to localize the changed span(s).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  if (start === endB) return ""; // nothing visibly changed (e.g. pure EOL)

  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(b.length, endB + CONTEXT);
  const lines = b.slice(from, to);
  const clipped = lines.length > MAX_LINES;
  const shown = clipped ? lines.slice(0, MAX_LINES) : lines;

  const body = shown
    .map((line, idx) => `${(from + idx + 1).toString().padStart(5, " ")}\t${line}`)
    .join("\n");
  return clipped ? `${body}\n     …\t[${lines.length - MAX_LINES} more changed lines]` : body;
}

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
