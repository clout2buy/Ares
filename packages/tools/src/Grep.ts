// Grep — regex search over workspace files.
//
// Prefers ripgrep (`rg`) when on PATH for speed; falls back to a native JS
// implementation otherwise so tests work without external deps.

import { z } from "zod";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildTool, repositoryInstructionsText, resolveWorkspacePath, toolError, type RichToolContext } from "./_shared.js";

const DEFAULT_IGNORE_GLOBS = [
  "**/.git/**",
  "**/.ares/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.next/**",
  "**/.pnpm-store/**",
];

const inputSchema = z
  .object({
    pattern: z.string().min(1).describe("Regular expression to search for."),
    path: z
      .union([z.string(), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe("File or directory to search; defaults to workspace. May also be an array of paths."),
    glob: z
      .union([z.string(), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe("Filter files by glob, e.g. `*.ts`. May also be an array of globs."),
    output_mode: z
      .enum(["content", "files_with_matches", "count"])
      .default("files_with_matches"),
    case_insensitive: z.boolean().default(false),
    max_results: z.number().int().positive().default(200),
    context_before: z.number().int().nonnegative().default(0).describe("Lines of context before each match (-B)."),
    context_after: z.number().int().nonnegative().default(0).describe("Lines of context after each match (-A)."),
    context: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Lines of context before AND after each match (-C, default 0). Overrides context_before/context_after when larger."),
    multiline: z
      .boolean()
      .optional()
      .describe("Default false. Let the pattern span lines (ripgrep -U --multiline-dotall; `.` matches newlines). Use for `struct \\w+ \\{[^}]*field`-style searches."),
    respect_gitignore: z
      .boolean()
      .optional()
      .describe("Default true. false → search files ignored by .gitignore too (ripgrep --no-ignore). The built-in node_modules/dist/.git exclusions still apply."),
  })
  .strict();

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  /** True for -B/-A context lines (not a match itself). */
  context?: boolean;
}

export interface GrepOutput {
  pattern: string;
  mode: "content" | "files_with_matches" | "count";
  matches: GrepMatch[];
  files?: string[];
  countsByFile?: Record<string, number>;
  totalMatches: number;
  truncated: boolean;
  engine: "ripgrep" | "native";
  /** The search hit its wall-clock cap; results are partial. */
  timedOut?: boolean;
  /** Repository rules newly applicable to the searched paths. */
  repositoryInstructions?: string;
}

/** Wall-clock cap for one search (ARES_GREP_TIMEOUT_MS, default 30s). */
export function grepTimeoutMs(): number {
  const n = Number(process.env.ARES_GREP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? n : 30_000;
}
/** Files larger than this are skipped (ripgrep --max-filesize, native stat). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Stop collecting once this many matches were seen; the count is then a floor. */
const MATCH_CAP = 20_000;

/**
 * Split ripgrep/PCRE-style inline flag groups off the front of a pattern:
 * `(?i)foo`, `(?is)foo`, `(?i)(?m)foo`. Models write these constantly and the
 * JS engine rejects them ("Invalid group"). ripgrep understands them natively,
 * so the ORIGINAL pattern still goes to rg; this gives the JS validator and the
 * native fallback the stripped pattern plus equivalent RegExp flags.
 */
export function splitInlineFlags(pattern: string): { pattern: string; flags: string; changed: boolean } {
  let rest = pattern;
  let flags = "";
  let extended = false;
  for (;;) {
    const m = /^\(\?([a-zA-Z-]+)\)/.exec(rest);
    if (!m || !/^[imsxuU-]+$/.test(m[1])) break;
    let on = true;
    for (const c of m[1]) {
      if (c === "-") on = false;
      else if (on && (c === "i" || c === "s" || c === "m") && !flags.includes(c)) flags += c;
      else if (on && c === "x") extended = true;
    }
    rest = rest.slice(m[0].length);
  }
  if (extended) rest = rest.replace(/\\.|\s+|#[^\n]*/g, (t) => (t.startsWith("\\") ? t : ""));
  // Scoped groups `(?i:...)` are not in older V8; degrade them to plain groups
  // (and fold the flag in globally) so the pattern still validates/searches.
  rest = rest.replace(/\(\?([imsx]+):/g, (_all, f: string) => {
    for (const c of f) if ((c === "i" || c === "s" || c === "m") && !flags.includes(c)) flags += c;
    return "(?:";
  });
  return { pattern: rest, flags, changed: rest !== pattern || flags !== "" };
}

/**
 * Semantic pattern check for validateInput: compile the regex up front and name
 * the bad construct in one FRIENDLY sentence, instead of letting ripgrep dump
 * stderr (or worse, silently return 0 matches on a construct its engine lacks).
 * Returns null when the pattern is fine.
 */
export function regexInputProblem(rawPattern: string): string | null {
  const split = splitInlineFlags(rawPattern);
  const pattern = split.pattern;
  try {
    new RegExp(pattern, split.flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^Invalid regular expression:\s*/i, "") : String(err);
    const corrected = split.changed ? ` (inline flags were handled; the remaining pattern /${pattern}/ is what failed)` : "";
    return `invalid regular expression — ${msg}${corrected}. Escape literal metacharacters with a backslash (e.g. \\( \\[ \\.) or fix the construct.`;
  }
  // Constructs JS accepts but ripgrep's default engine rejects or misparses.
  let inClass = false;
  for (let k = 0; k < pattern.length; k++) {
    const c = pattern[k];
    if (c === "\\") {
      const next = pattern[k + 1] ?? "";
      if (!inClass && /[1-9]/.test(next)) {
        return `the pattern uses a backreference (\\${next}), which ripgrep's engine does not support — repeat the text literally instead.`;
      }
      k++; // skip the escaped char
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && pattern.startsWith("(?", k)) {
      const look = pattern.slice(k, k + 4);
      if (look.startsWith("(?=") || look.startsWith("(?!") || look.startsWith("(?<=") || look.startsWith("(?<!")) {
        return `the pattern uses lookaround (${look.slice(0, 4)}…), which ripgrep's engine does not support — rewrite it to match the surrounding text directly.`;
      }
    }
    if (c === "{" && !/^\{\d+(,\d*)?\}/.test(pattern.slice(k))) {
      return `the pattern has a literal unescaped '{' — ripgrep parses braces as repetition. Escape literal braces: \\{ and \\} (e.g. interface\\{\\}).`;
    }
  }
  return null;
}

/** -C wins over -A/-B when larger; explicit call sites may omit the newer fields entirely. */
function contextOf(i: z.infer<typeof inputSchema>): { before: number; after: number } {
  const both = i.context ?? 0;
  return { before: Math.max(i.context_before ?? 0, both), after: Math.max(i.context_after ?? 0, both) };
}

export const GrepTool = buildTool({
  name: "Grep",
  description:
    "Regex search across the workspace (ripgrep-backed when available). Choose output_mode: `content` (matching lines), `files_with_matches` (just paths), or `count`. Options: -A/-B/-C style context (`context_after`/`context_before`/`context`), `multiline` for patterns spanning lines, `respect_gitignore: false` to include gitignored files.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  activityDescription: (i) => `Searching for ${i.pattern}`,

  async validateInput(i) {
    const problem = regexInputProblem(i.pattern);
    if (problem) return { ok: false, message: `Grep pattern: ${problem}` };
    return { ok: true };
  },

  async call(i, ctx): Promise<{ output: GrepOutput; display: string }> {
    const roots = await resolveSearchPaths(ctx, i.path);
    const ripgrep = await tryRipgrep(i, roots, ctx.signal, (data) => ctx.emitProgress?.(data));
    const output: GrepOutput = ripgrep ?? (await nativeGrep(i, roots, (data) => ctx.emitProgress?.(data)));
    const rules = await repositoryInstructionsText(ctx, roots);
    if (rules) output.repositoryInstructions = rules;
    const summary =
      output.mode === "files_with_matches"
        ? `${output.files?.length ?? 0} file(s) matched /${i.pattern}/`
        : output.mode === "count"
        ? `${output.totalMatches} match(es) for /${i.pattern}/`
        : `${output.totalMatches} line(s) matched /${i.pattern}/`;
    return { output, display: output.timedOut ? `${summary} (search timed out - partial results)` : summary };
  },
});

// ─── ripgrep path ──────────────────────────────────────────────────────

async function tryRipgrep(
  i: z.infer<typeof inputSchema>,
  roots: string[],
  signal: AbortSignal,
  emitProgress?: (data: unknown) => void,
): Promise<GrepOutput | null> {
  const rgPath = await which("rg");
  if (!rgPath) return null;

  const args: string[] = ["--no-config", "--json", "--hidden", "--max-filesize", String(MAX_FILE_BYTES), "--max-columns", "2000", "--max-columns-preview"];
  for (const ignore of DEFAULT_IGNORE_GLOBS) {
    args.push("--glob", `!${ignore}`);
  }
  if (i.case_insensitive) args.push("-i");
  if (i.multiline === true) args.push("-U", "--multiline-dotall");
  if (i.respect_gitignore === false) args.push("--no-ignore");
  for (const glob of toArray(i.glob)) args.push("--glob", glob);
  const context = contextOf(i);
  if (i.output_mode === "content") {
    if (context.before > 0) args.push("-B", String(context.before));
    if (context.after > 0) args.push("-A", String(context.after));
  }
  args.push("-e", i.pattern, ...roots);

  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { signal });
    let timedOut = false;
    let capped = false;
    // A search must never wedge a turn: on a pathological tree rg is killed at
    // the wall-clock cap and the partial results are returned, flagged.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, grepTimeoutMs());
    let buf = "";
    const matches: GrepMatch[] = [];
    const files = new Set<string>();
    const counts: Record<string, number> = {};
    let total = 0;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        let event: { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "match") {
          const p = event.data?.path?.text;
          const text = event.data?.lines?.text ?? "";
          const lineNum = event.data?.line_number ?? 0;
          if (!p) continue;
          files.add(p);
          counts[p] = (counts[p] ?? 0) + 1;
          total++;
          if (total === 1 || total % 25 === 0) {
            emitProgress?.({ kind: "grep_match", file: p, line: lineNum, total });
          }
          if (total >= MATCH_CAP && i.output_mode !== "count" && !capped) {
            capped = true;
            try { child.kill("SIGKILL"); } catch { /* ignore */ }
          }
          if (i.output_mode === "content" && matches.length < i.max_results) {
            matches.push({ path: p, line: lineNum, text: text.replace(/\n$/, "") });
          }
        } else if (
          event.type === "context" &&
          i.output_mode === "content" &&
          (context.before > 0 || context.after > 0) &&
          matches.length < i.max_results
        ) {
          // rg emits "context" events for -B/-A lines, in stream order around
          // their match. Interleave them so the model gets the surrounding code
          // it asked for, without counting them as matches.
          const p = event.data?.path?.text;
          const text = event.data?.lines?.text ?? "";
          const lineNum = event.data?.line_number ?? 0;
          if (p) matches.push({ path: p, line: lineNum, text: text.replace(/\n$/, ""), context: true });
        }
      }
    });

    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const out = buildOutput(i, matches, files, counts, total, "ripgrep");
      if (timedOut) out.timedOut = true;
      if (timedOut || capped) out.truncated = true;
      resolve(out);
    });
  });
}

async function which(bin: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const p of paths) {
    for (const ext of exts) {
      const candidate = path.join(p, bin + ext);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

// ─── native fallback ───────────────────────────────────────────────────

async function nativeGrep(
  i: z.infer<typeof inputSchema>,
  roots: string[],
  emitProgress?: (data: unknown) => void,
): Promise<GrepOutput> {
  const inline = splitInlineFlags(i.pattern);
  const flagSet = new Set<string>([...(i.case_insensitive ? ["i"] : []), ...(i.multiline === true ? ["g", "s"] : []), ...inline.flags]);
  const flags = [...flagSet].join("");
  const deadline = Date.now() + grepTimeoutMs();
  let nativeTimedOut = false;
  // An invalid model-supplied pattern throws a raw JS SyntaxError here, which
  // surfaces as an opaque crash rather than something the model can correct.
  // Re-throw as a recognizable tool error (ripgrep already returns its own
  // error text; keep the native fallback consistent).
  let regex: RegExp;
  try {
    regex = new RegExp(inline.pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw toolError(
      `Grep: invalid regular expression: ${msg}. Escape regex metacharacters or fix the pattern.`,
    );
  }
  const matches: GrepMatch[] = [];
  const files = new Set<string>();
  const counts: Record<string, number> = {};
  let total = 0;
  const context = contextOf(i);
  const multiline = i.multiline === true;
  // Mirror the rg path (which uses --hidden minus DEFAULT_IGNORE_GLOBS): walk
  // dot-dirs like .github/workflows, but skip the heavy/state ones explicitly
  // so the JS fallback and ripgrep return the SAME result set. (.gitignore is
  // never consulted here — respect_gitignore only changes ripgrep's behavior.)
  const ignoreDirs = new Set([
    "node_modules",
    ".git",
    ".ares",
    ".crix",
    "dist",
    "build",
    "target",
    ".next",
    ".pnpm-store",
    ".turbo",
    ".cache",
    ".venv",
    "venv",
    "coverage",
  ]);

  // One scanner for both the directory walk and explicit file roots. Multiline
  // runs the regex over the whole text (flags g+s, like rg -U --multiline-dotall)
  // and maps match offsets back to lines; the match text spans every line the
  // match touched, matching ripgrep's JSON `lines.text` for multiline hits.
  function scanText(abs: string, text: string): void {
    const lines = text.split("\n");
    const hits: { line: number; endLine: number }[] = [];
    if (multiline) {
      const offsets: number[] = [0];
      for (let k = 0; k < lines.length - 1; k++) offsets.push(offsets[k] + lines[k].length + 1);
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        if (m[0] === "") {
          regex.lastIndex++;
          continue;
        }
        hits.push({ line: lineAtOffset(offsets, m.index), endLine: lineAtOffset(offsets, m.index + m[0].length - 1) });
      }
    } else {
      for (let k = 0; k < lines.length; k++) if (regex.test(lines[k])) hits.push({ line: k, endLine: k });
    }
    const emitted = new Set<number>();
    if (hits.length > 0 && total >= MATCH_CAP) return;
    for (const hit of hits) {
      files.add(abs);
      counts[abs] = (counts[abs] ?? 0) + 1;
      total++;
      if (total === 1 || total % 25 === 0) {
        emitProgress?.({ kind: "grep_match", file: abs, line: hit.line + 1, total });
      }
      if (i.output_mode !== "content" || matches.length >= i.max_results) continue;
      for (let b = Math.max(0, hit.line - context.before); b < hit.line; b++) {
        if (emitted.has(b)) continue;
        emitted.add(b);
        matches.push({ path: abs, line: b + 1, text: lines[b], context: true });
      }
      for (let k = hit.line; k <= hit.endLine; k++) emitted.add(k);
      matches.push({ path: abs, line: hit.line + 1, text: lines.slice(hit.line, hit.endLine + 1).join("\n") });
      for (let a = hit.endLine + 1; a <= Math.min(lines.length - 1, hit.endLine + context.after); a++) {
        if (emitted.has(a)) continue;
        emitted.add(a);
        matches.push({ path: abs, line: a + 1, text: lines[a], context: true });
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (Date.now() > deadline) {
        nativeTimedOut = true;
        return;
      }
      if (total >= MATCH_CAP) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (!matchesAnyGlob(abs, roots, i.glob)) continue;
        const text = await readSearchable(abs);
        if (text === null) continue;
        scanText(abs, text);
      }
    }
  }

  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (stat?.isFile()) {
      if (!matchesAnyGlob(root, roots, i.glob)) continue;
      const text = await readSearchable(root);
      if (text !== null) scanText(root, text);
    } else {
      await walk(root);
    }
  }

  const out = buildOutput(i, matches, files, counts, total, "native");
  if (nativeTimedOut) {
    out.timedOut = true;
    out.truncated = true;
  }
  if (total >= MATCH_CAP) out.truncated = true;
  return out;
}

/** Read a file for the native scan, or null when it is too big or binary. A
 *  multi-GB log or a NUL-bearing blob used to be slurped whole into memory. */
async function readSearchable(abs: string): Promise<string | null> {
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) return null;
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

async function resolveSearchPaths(
  ctx: Pick<RichToolContext, "workspace" | "pathPermissions" | "requestPermission" | "permissionMode">,
  inputPath: z.infer<typeof inputSchema>["path"],
): Promise<string[]> {
  const requested = toArray(inputPath);
  if (requested.length === 0) {
    return [await resolveWorkspacePath(ctx, undefined, "path", "read")];
  }
  // Only treat whitespace as a path separator when the caller passed the
  // explicit ARRAY form. A single string with a space is one path (e.g.
  // "src/foo bar.ts") — splitting it fanned out into ["src/foo","bar.ts"] and
  // silently returned 0 matches. For the array form we still tolerate a stray
  // space-joined element, but only when EVERY split token actually exists;
  // otherwise the space is part of a real (spaced) filename.
  const isArrayForm = Array.isArray(inputPath);

  const expanded: string[] = [];
  for (const raw of requested) {
    const candidate = path.resolve(ctx.workspace, raw);
    const exists = await fs.stat(candidate).then(() => true).catch(() => false);
    if (exists) {
      expanded.push(raw);
      continue;
    }
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1 || path.isAbsolute(raw)) {
      // A single nonexistent path is an error the model can correct, not a
      // candidate to split — surface it instead of returning 0 matches.
      throw toolError(`path not found: ${raw}`);
    }
    // Multi-token, nonexistent, relative path. Split only if it's the array
    // form AND every token resolves to a real path; otherwise it's a spaced
    // filename that simply doesn't exist.
    const tokenExists = await Promise.all(
      parts.map((p) => fs.stat(path.resolve(ctx.workspace, p)).then(() => true).catch(() => false)),
    );
    if (isArrayForm && tokenExists.every(Boolean)) {
      expanded.push(...parts);
    } else {
      throw toolError(`path not found: ${raw}`);
    }
  }

  return Promise.all(expanded.map((p) => resolveWorkspacePath(ctx, p, "path", "read")));
}

/** Binary search: index of the line containing byte offset `pos`. */
function lineAtOffset(offsets: number[], pos: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesAnyGlob(absPath: string, roots: string[], glob: z.infer<typeof inputSchema>["glob"]): boolean {
  const globs = toArray(glob);
  if (globs.length === 0) return true;
  const root = roots.find((r) => {
    const relative = path.relative(r, absPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }) ?? roots[0];
  const rel = normalizeSlashes(path.relative(root, absPath));
  const base = path.basename(absPath);
  return globs.some((pattern) => matchesGlob(rel, pattern) || matchesGlob(base, pattern));
}

function matchesGlob(filename: string, pattern: string): boolean {
  return globToRegExp(normalizeSlashes(pattern)).test(normalizeSlashes(filename));
}

function globToRegExp(glob: string): RegExp {
  let r = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      r += ".*";
      i += 2;
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      r += "[^/]*";
      i++;
    } else if (c === "?") {
      r += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      r += "\\" + c;
      i++;
    } else {
      r += c;
      i++;
    }
  }
  r += "$";
  return new RegExp(r);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function buildOutput(
  i: z.infer<typeof inputSchema>,
  matches: GrepMatch[],
  files: Set<string>,
  counts: Record<string, number>,
  total: number,
  engine: "ripgrep" | "native",
): GrepOutput {
  const filesArr = [...files].slice(0, i.max_results);
  return {
    pattern: i.pattern,
    mode: i.output_mode,
    matches,
    files: i.output_mode === "files_with_matches" ? filesArr : undefined,
    countsByFile: i.output_mode === "count" ? counts : undefined,
    totalMatches: total,
    truncated: total > i.max_results,
    engine,
  };
}
