// syntaxGate - a zero-config, pre-write syntax check for Edit/Write.
//
// PostMutationFeedback (core) only reports AFTER the bytes are on disk and only
// when a linter/tsc config exists. The cheapest, highest-value check is older
// and simpler: if a file parsed before the edit and does NOT parse after it,
// the edit broke the file - say so BEFORE writing, so the broken state never
// lands (no rollback needed) and the model fixes its old_string/new_string in
// the same round trip instead of finding out three turns later from a red test.
//
// Rules that keep this safe:
//   * Only a TRANSITION valid -> invalid blocks. A file that was already
//     broken (JSX in .js, jsonc comments in .json, py2) is never blocked.
//   * Checks that cannot run (no python, no typescript) answer "skipped".
//   * Module-vs-script ambiguity in .js answers "ok" (see JS_INCONCLUSIVE).
//   * Every external check has a short timeout; none can wedge a turn.
//
// ARES_EDIT_SYNTAX_GATE = block (default) | warn | off.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type SyntaxVerdict = { status: "ok" } | { status: "error"; message: string } | { status: "skipped"; reason: string };

export type SyntaxGateMode = "block" | "warn" | "off";

export function syntaxGateMode(): SyntaxGateMode {
  const v = (process.env.ARES_EDIT_SYNTAX_GATE ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return "off";
  if (v === "warn") return "warn";
  return "block";
}

const CHECK_TIMEOUT_MS = 8_000;
const MAX_CHECK_BYTES = 2_000_000;

/** node --check says these when a perfectly valid ES module is parsed as CJS. */
const JS_INCONCLUSIVE = /Cannot use import statement|Unexpected token 'export'|import\.meta|await is only valid|Unexpected reserved word/;

function run(cmd: string, args: string[], stdin: string | undefined, timeoutMs: number): Promise<{ code: number | null; out: string; spawnError: boolean }> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (code: number | null, spawnError: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.slice(-4000), spawnError });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ code: null, out: "", spawnError: true });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done(null, true);
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    child.on("error", () => done(null, true));
    child.on("close", (code) => done(code, false));
    child.stdin?.on("error", () => undefined);
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

let pythonCmd: Promise<string | null> | undefined;
function findPython(): Promise<string | null> {
  pythonCmd ??= (async () => {
    for (const cmd of ["python3", "python"]) {
      const r = await run(cmd, ["-c", "import sys;print(sys.version_info[0])"], undefined, 4000);
      if (!r.spawnError && r.code === 0 && r.out.trim().startsWith("3")) return cmd;
    }
    return null;
  })();
  return pythonCmd;
}

const tsCache = new Map<string, unknown>();
function loadTypescript(cwd: string): { transpileModule: (src: string, opts: unknown) => { diagnostics?: Array<{ messageText: unknown; start?: number; file?: { getLineAndCharacterOfPosition(pos: number): { line: number; character: number } } }> } } | null {
  const key = path.resolve(cwd);
  if (tsCache.has(key)) return tsCache.get(key) as ReturnType<typeof loadTypescript>;
  let mod: ReturnType<typeof loadTypescript> = null;
  try {
    const req = createRequire(path.join(key, "noop.js"));
    mod = req("typescript") as ReturnType<typeof loadTypescript>;
  } catch {
    mod = null;
  }
  tsCache.set(key, mod);
  return mod;
}

function flattenMessage(text: unknown): string {
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && "messageText" in text) return flattenMessage((text as { messageText: unknown }).messageText);
  return String(text);
}

/** Parse-check `content` as if it were the file `filePath`. */
export async function checkSyntax(filePath: string, content: string, cwd: string): Promise<SyntaxVerdict> {
  if (Buffer.byteLength(content, "utf8") > MAX_CHECK_BYTES) return { status: "skipped", reason: "file too large to check" };
  const ext = path.extname(filePath).toLowerCase();
  const text = content.replace(/^﻿/, "");

  if (ext === ".json") {
    try {
      JSON.parse(text);
      return { status: "ok" };
    } catch (error) {
      return { status: "error", message: `JSON: ${(error as Error).message}` };
    }
  }

  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const tmp = path.join(os.tmpdir(), `ares-syntax-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext === ".js" ? (/^\s*(?:import|export)\s/m.test(text) ? ".mjs" : ".cjs") : ext}`);
    try {
      await fs.writeFile(tmp, text, "utf8");
      const r = await run(process.execPath, ["--check", tmp], undefined, CHECK_TIMEOUT_MS);
      if (r.spawnError) return { status: "skipped", reason: "node --check unavailable" };
      if (r.code === 0) return { status: "ok" };
      if (ext === ".js" && JS_INCONCLUSIVE.test(r.out)) return { status: "ok" };
      const detail = r.out.split(/\r?\n/).filter((l) => l.trim() && !l.includes(tmp) && !/^Node\.js v/.test(l)).slice(0, 4).join(" | ") || r.out.trim().slice(0, 300);
      return { status: "error", message: `node --check: ${detail}`.slice(0, 500) };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  if (ext === ".py") {
    const py = await findPython();
    if (!py) return { status: "skipped", reason: "python3 not found" };
    const r = await run(py, ["-c", "import sys,ast\nsrc=sys.stdin.buffer.read().decode('utf-8')\nast.parse(src)"], text, CHECK_TIMEOUT_MS);
    if (r.spawnError) return { status: "skipped", reason: "python check timed out" };
    if (r.code === 0) return { status: "ok" };
    const line = r.out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
    return { status: "error", message: `python ast.parse: ${line}`.slice(0, 500) };
  }

  if (ext === ".sh" || ext === ".bash") {
    const r = await run("bash", ["-n"], text, CHECK_TIMEOUT_MS);
    if (r.spawnError) return { status: "skipped", reason: "bash not found" };
    if (r.code === 0) return { status: "ok" };
    return { status: "error", message: `bash -n: ${r.out.trim().split(/\r?\n/).slice(0, 3).join(" | ")}`.slice(0, 500) };
  }

  if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    const ts = loadTypescript(cwd);
    if (!ts) return { status: "skipped", reason: "typescript not installed in the workspace" };
    try {
      const out = ts.transpileModule(text, {
        reportDiagnostics: true,
        fileName: filePath,
        compilerOptions: { jsx: 4 /* react-jsx */, target: 99, module: 99, isolatedModules: true },
      });
      const diags = out.diagnostics ?? [];
      if (diags.length === 0) return { status: "ok" };
      const first = diags[0];
      let where = "";
      if (first.file && first.start !== undefined) {
        const lc = first.file.getLineAndCharacterOfPosition(first.start);
        where = `line ${lc.line + 1}:${lc.character + 1} `;
      }
      return { status: "error", message: `TypeScript syntax: ${where}${flattenMessage(first.messageText)}`.slice(0, 500) };
    } catch {
      return { status: "skipped", reason: "typescript check failed to run" };
    }
  }

  return { status: "skipped", reason: `no syntax checker for ${ext || "this file type"}` };
}

export function isSyntaxCheckable(filePath: string): boolean {
  return /\.(?:json|js|mjs|cjs|py|sh|bash|ts|tsx|mts|cts)$/i.test(filePath);
}

export interface GateResult {
  /** True when the edit must NOT be written. */
  block: boolean;
  /** Non-empty when the model should be told something (block or warn). */
  message?: string;
}

/**
 * Decide whether an edit that turns `before` into `after` breaks the file's
 * syntax. `before === null` means the file is new (never blocks; warns only).
 */
export async function gateEdit(filePath: string, before: string | null, after: string, cwd: string): Promise<GateResult> {
  const mode = syntaxGateMode();
  if (mode === "off" || !isSyntaxCheckable(filePath)) return { block: false };
  const next = await checkSyntax(filePath, after, cwd);
  if (next.status !== "error") return { block: false };
  if (before !== null) {
    const prior = await checkSyntax(filePath, before, cwd);
    // Already broken (or unknowable) before the edit: not this edit's fault.
    if (prior.status !== "ok") return { block: false };
  }
  const base = `Syntax check failed after this edit: ${next.message}`;
  if (before === null) return { block: false, message: `${base} (new file written as-is; fix it before relying on it).` };
  if (mode === "warn") return { block: false, message: `${base} (written anyway: ARES_EDIT_SYNTAX_GATE=warn).` };
  return {
    block: true,
    message:
      `${base}\nThe file parsed cleanly before this edit, so the edit was NOT written and the file is unchanged. ` +
      `Fix new_string (check brackets, quotes, indentation, trailing commas) and retry. If you are deliberately making a multi-step change that is invalid in between, put all steps in one atomic \`edits\` batch.`,
  };
}
