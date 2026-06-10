// Ares v2 apply-patch parser.
//
// Ported from codex-main/codex-rs/apply-patch/src/parser.rs (Apache-2.0).
// Original copyright: OpenAI, 2025. See NOTICE for attribution.
// Adapted to TypeScript and Ares's tool interface.
//
// Grammar:
//   start         : begin_patch environment_id? hunk+ end_patch
//   begin_patch   : "*** Begin Patch" LF
//   environment_id: "*** Environment ID: " filename LF
//   end_patch     : "*** End Patch" LF?
//   hunk          : add_hunk | delete_hunk | update_hunk
//   add_hunk      : "*** Add File: " filename LF add_line+
//   delete_hunk   : "*** Delete File: " filename LF
//   update_hunk   : "*** Update File: " filename LF change_move? change?
//   change_move   : "*** Move to: " filename LF
//   change        : (change_context | change_line)+ eof_line?
//   change_context: ("@@" | "@@ " context_text) LF
//   change_line   : ("+" | "-" | " ") text LF
//   eof_line      : "*** End of File" LF
//
// Lenient mode handles GPT-4.1's heredoc-quoting bug where the model
// passes the whole patch wrapped in `<<'EOF' ... EOF`.

export const BEGIN_PATCH_MARKER = "*** Begin Patch";
export const END_PATCH_MARKER = "*** End Patch";
export const ENVIRONMENT_ID_MARKER = "*** Environment ID: ";
export const ADD_FILE_MARKER = "*** Add File: ";
export const DELETE_FILE_MARKER = "*** Delete File: ";
export const UPDATE_FILE_MARKER = "*** Update File: ";
export const MOVE_TO_MARKER = "*** Move to: ";
export const EOF_MARKER = "*** End of File";
export const CHANGE_CONTEXT_MARKER = "@@ ";
export const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

export type Hunk =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: UpdateFileChunk[] };

export interface UpdateFileChunk {
  /** Context hint (after `@@ `) used to anchor where the chunk applies. */
  changeContext?: string;
  /** Lines that must match in the source. */
  oldLines: string[];
  /** Lines that replace oldLines. */
  newLines: string[];
  /** True if `*** End of File` marker was present. */
  isEndOfFile: boolean;
}

export interface ApplyPatchArgs {
  patch: string;
  hunks: Hunk[];
  environmentId?: string;
}

export type ParseMode = "strict" | "lenient";

export class PatchParseError extends Error {
  readonly lineNumber?: number;
  constructor(message: string, lineNumber?: number) {
    super(message);
    this.name = "PatchParseError";
    this.lineNumber = lineNumber;
  }
}

/** Default parse — uses lenient mode for compat with GPT-4.1's heredoc bug. */
export function parsePatch(patch: string): ApplyPatchArgs {
  return parsePatchText(patch, "lenient");
}

export function parsePatchText(patch: string, mode: ParseMode): ApplyPatchArgs {
  const lines = patch.trim().split("\n");
  const [patchLines, hunkLines] =
    mode === "strict" ? checkBoundariesStrict(lines) : checkBoundariesLenient(lines);

  const [environmentId, afterPreamble, startLineNumber] = parseEnvironmentIdPreamble(hunkLines);
  let remaining = afterPreamble;
  let lineNumber = startLineNumber;
  const hunks: Hunk[] = [];
  while (remaining.length > 0) {
    const [hunk, consumed] = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }
  return { patch: patchLines.join("\n"), hunks, environmentId };
}

function parseEnvironmentIdPreamble(
  hunkLines: string[],
): [string | undefined, string[], number] {
  const first = hunkLines[0];
  if (first === undefined) return [undefined, hunkLines, 2];
  const stripped = first.replace(/^\s+/, "");
  if (!stripped.startsWith(ENVIRONMENT_ID_MARKER)) return [undefined, hunkLines, 2];
  const id = stripped.slice(ENVIRONMENT_ID_MARKER.length).trim();
  if (id.length === 0) throw new PatchParseError("apply_patch environment_id cannot be empty");
  return [id, hunkLines.slice(1), 3];
}

function checkBoundariesStrict(lines: string[]): [string[], string[]] {
  if (lines.length === 0) {
    throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
  }
  const first = lines[0].trim();
  const last = lines[lines.length - 1].trim();
  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchParseError("The first line of the patch must be '*** Begin Patch'");
  }
  if (last !== END_PATCH_MARKER) {
    throw new PatchParseError("The last line of the patch must be '*** End Patch'");
  }
  return [lines, lines.slice(1, lines.length - 1)];
}

function checkBoundariesLenient(lines: string[]): [string[], string[]] {
  try {
    return checkBoundariesStrict(lines);
  } catch (strictError) {
    // Try to strip a heredoc wrapper.
    if (lines.length >= 4) {
      const first = lines[0];
      const last = lines[lines.length - 1];
      const heredocStart = first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"';
      if (heredocStart && last.endsWith("EOF")) {
        return checkBoundariesStrict(lines.slice(1, lines.length - 1));
      }
    }
    throw strictError;
  }
}

function parseOneHunk(lines: string[], lineNumber: number): [Hunk, number] {
  const first = lines[0].trim();

  if (first.startsWith(ADD_FILE_MARKER)) {
    const path = first.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let parsed = 1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("+")) {
        contents += line.slice(1) + "\n";
        parsed++;
      } else {
        break;
      }
    }
    return [{ kind: "add", path, contents }, parsed];
  }

  if (first.startsWith(DELETE_FILE_MARKER)) {
    const path = first.slice(DELETE_FILE_MARKER.length);
    return [{ kind: "delete", path }, 1];
  }

  if (first.startsWith(UPDATE_FILE_MARKER)) {
    const path = first.slice(UPDATE_FILE_MARKER.length);
    let remaining = lines.slice(1);
    let parsed = 1;
    let movePath: string | undefined;
    if (remaining.length > 0 && remaining[0].startsWith(MOVE_TO_MARKER)) {
      movePath = remaining[0].slice(MOVE_TO_MARKER.length);
      remaining = remaining.slice(1);
      parsed++;
    }
    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      // Skip blank lines between chunks.
      if (remaining[0].trim() === "") {
        parsed++;
        remaining = remaining.slice(1);
        continue;
      }
      // A `***`-prefixed line is the start of the next hunk; stop.
      if (remaining[0].startsWith("*")) break;
      const [chunk, consumed] = parseUpdateFileChunk(
        remaining,
        lineNumber + parsed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      parsed += consumed;
      remaining = remaining.slice(consumed);
    }
    if (chunks.length === 0) {
      throw new PatchParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
    }
    return [{ kind: "update", path, movePath, chunks }, parsed];
  }

  throw new PatchParseError(
    `'${first}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
    lineNumber,
  );
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): [UpdateFileChunk, number] {
  if (lines.length === 0) {
    throw new PatchParseError("Update hunk does not contain any lines", lineNumber);
  }

  let changeContext: string | undefined;
  let startIndex: number;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    changeContext = undefined;
    startIndex = 1;
  } else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else {
    if (!allowMissingContext) {
      throw new PatchParseError(
        `Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
        lineNumber,
      );
    }
    changeContext = undefined;
    startIndex = 0;
  }

  if (startIndex >= lines.length) {
    throw new PatchParseError("Update hunk does not contain any lines", lineNumber + 1);
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };
  let parsed = 0;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === EOF_MARKER) {
      if (parsed === 0) {
        throw new PatchParseError("Update hunk does not contain any lines", lineNumber + 1);
      }
      chunk.isEndOfFile = true;
      parsed++;
      break;
    }
    if (line.length === 0) {
      // Empty line: treat as a blank context line on both sides.
      chunk.oldLines.push("");
      chunk.newLines.push("");
      parsed++;
      continue;
    }
    const head = line[0];
    if (head === " ") {
      const rest = line.slice(1);
      chunk.oldLines.push(rest);
      chunk.newLines.push(rest);
    } else if (head === "+") {
      chunk.newLines.push(line.slice(1));
    } else if (head === "-") {
      chunk.oldLines.push(line.slice(1));
    } else {
      if (parsed === 0) {
        throw new PatchParseError(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNumber + 1,
        );
      }
      // Assume this is the start of the next hunk.
      break;
    }
    parsed++;
  }

  return [chunk, parsed + startIndex];
}
