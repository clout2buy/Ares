// Continuous verifier — the killer signature feature.
//
// After every Edit/Write/Apply, the verifier:
//   1. Adds the touched files to a pending set.
//   2. Cancels any in-flight verify run (we'll redo it with the new set).
//   3. Debounces 800ms, then derives the NARROWEST verify command from
//      the touched files (typecheck on .ts, ruff on .py, run the
//      specific test file if it changed, etc.).
//   4. Runs commands in the background. Failures are stashed.
//   5. On the NEXT turn_start, the engine drains the stash and prepends
//      a <system-reminder> to the user's message so the model literally
//      cannot claim "done" while CI is red.
//
// No other harness does this automatically. Claude Code requires hooks;
// Codex requires you to ask. Ares makes it the default.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface VerifyCommand {
  program: string;
  args: string[];
  cwd: string;
  /** What this command checks ("typescript", "tests:foo.test.ts", ...). */
  label: string;
}

export interface VerifyResult {
  ok: boolean;
  command: VerifyCommand;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  /** The tool wasn't found on PATH (ENOENT) — verifier unavailable, not a real
   *  failure. Callers must NOT turn this into a "fix this" reminder. */
  skipped?: boolean;
}

export type VerifyEvent =
  | { type: "scheduled"; files: string[]; commands: VerifyCommand[] }
  | { type: "running"; command: VerifyCommand }
  | { type: "finished"; result: VerifyResult }
  | { type: "all_finished"; ok: boolean; results: VerifyResult[] };

export interface VerifierOptions {
  workspace: string;
  /** Debounce window for batching successive edits. Default 800ms. */
  debounceMs?: number;
  /** Cap on output tail captured per command. Default 4000 chars. */
  outputTailChars?: number;
  /** Hook for the CLI/TUI to render verify events live. */
  onEvent?: (event: VerifyEvent) => void;
}

interface PendingReminder {
  text: string;
  source: "verifier";
}

export class ContinuousVerifier {
  private readonly workspace: string;
  private readonly debounceMs: number;
  private readonly outputTailChars: number;
  private readonly onEvent?: (event: VerifyEvent) => void;

  private pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: { abort: AbortController; done: Promise<void> } | null = null;
  private pendingReminders: PendingReminder[] = [];
  /** Detected once per workspace and cached. */
  private detectedSetupPromise: Promise<WorkspaceSetup> | null = null;

  constructor(opts: VerifierOptions) {
    this.workspace = opts.workspace;
    // Hot-path coalescing (C1): during a burst of edits we cancel + reschedule,
    // so a longer window means fewer wasted project typechecks mid-edit. The
    // end-of-turn gate flushes immediately via settle(), so this only affects
    // mid-turn thrash. Tunable with ARES_VERIFY_DEBOUNCE_MS.
    const envDebounce = Number(process.env.ARES_VERIFY_DEBOUNCE_MS);
    this.debounceMs = opts.debounceMs ?? (Number.isFinite(envDebounce) && envDebounce >= 0 ? Math.floor(envDebounce) : 1500);
    this.outputTailChars = opts.outputTailChars ?? 4000;
    this.onEvent = opts.onEvent;
  }

  /** Called by QueryEngine after every tool_end with touchedFiles. */
  scheduleFor(files: readonly string[]): void {
    if (files.length === 0) return;
    for (const f of files) this.pendingFiles.add(path.resolve(f));
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.fireRun();
    }, this.debounceMs);
  }

  /** Called by QueryEngine via drainSystemReminders before turn_start. */
  drainReminders(): PendingReminder[] {
    const drained = this.pendingReminders;
    this.pendingReminders = [];
    return drained;
  }

  /**
   * C1 — settle: flush the debounce immediately and wait for every scheduled
   * verify run to finish (bounded). Lets the engine's end-of-turn gate ask
   * "is anything still red?" instead of letting a turn finish before the
   * verdict lands. Never throws; on timeout it simply returns (the reminder,
   * if any, surfaces next drain).
   */
  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const untilDeadline = (): Promise<void> =>
      new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())));
    // Flush a pending debounce window right now. AWAIT the fired run (raced
    // against the deadline): fire-and-forget here let settle() observe
    // inFlight===null and pendingFiles empty (fireRun clears pendingFiles before
    // its first await, then assigns inFlight only AFTER detectSetup) and return
    // BEFORE the verdict landed — so the end-gate never saw the failure. The
    // run's promise resolves only after the reminder is pushed.
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      await Promise.race([this.fireRun().catch(() => undefined), untilDeadline()]);
    }
    // Runs can chain (a fireRun may have been queued while one was active),
    // so loop until quiet or out of time.
    while (Date.now() < deadline) {
      const inFlight = this.inFlight;
      if (!inFlight && this.pendingFiles.size === 0) return;
      if (inFlight) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await Promise.race([inFlight.done, new Promise((r) => setTimeout(r, remaining))]);
      } else if (this.pendingFiles.size > 0) {
        await Promise.race([this.fireRun().catch(() => undefined), untilDeadline()]);
      }
    }
  }

  /** True when reminders are waiting to be drained. */
  hasPendingReminders(): boolean {
    return this.pendingReminders.length > 0;
  }

  /** Cancel any in-flight run; used on session shutdown. */
  async cancel(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.inFlight) {
      this.inFlight.abort.abort();
      try {
        await this.inFlight.done;
      } catch {
        // ignore
      }
      this.inFlight = null;
    }
  }

  private async fireRun(): Promise<void> {
    // If another run is already going, cancel it — we have newer files.
    if (this.inFlight) {
      this.inFlight.abort.abort();
      try {
        await this.inFlight.done;
      } catch {
        /* ignore */
      }
      this.inFlight = null;
    }

    const files = [...this.pendingFiles];
    this.pendingFiles.clear();

    const setup = await this.detectSetup();
    // Editing a source file should exercise its tests, not just its types —
    // pull in existing sibling/related test files for everything touched.
    const related = await findRelatedTestFiles(files, this.workspace);
    const commands = deriveNarrowVerify([...files, ...related], this.workspace, setup);
    if (commands.length === 0) return;

    this.onEvent?.({ type: "scheduled", files, commands });

    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.inFlight = { abort, done };

    const results: VerifyResult[] = [];
    let allOk = true;

    try {
      for (const cmd of commands) {
        if (abort.signal.aborted) break;
        this.onEvent?.({ type: "running", command: cmd });
        const result = await this.runOne(cmd, abort.signal);
        results.push(result);
        if (!result.ok) allOk = false;
        this.onEvent?.({ type: "finished", result });
      }
      this.onEvent?.({ type: "all_finished", ok: allOk, results });
      if (!allOk) {
        this.pendingReminders.push({
          text: this.formatReminder(results.filter((r) => !r.ok)),
          source: "verifier",
        });
      }
    } finally {
      resolveDone();
      if (this.inFlight && this.inFlight.done === done) this.inFlight = null;
    }
  }

  private formatReminder(failed: VerifyResult[]): string {
    const sections = failed.map((r) => {
      const tail = (r.stderrTail || r.stdoutTail).trim();
      const trimmed = tail.length > 1500 ? "…" + tail.slice(-1500) : tail;
      return `[${r.command.label}] ${r.command.program} ${r.command.args.join(" ")}
exit: ${r.exitCode ?? "killed"}  (${r.durationMs}ms)
${trimmed}`;
    });
    return `Continuous verifier detected failures after your recent edits. Address these before reporting "done":

${sections.join("\n\n")}

If a failure is unrelated to your change, say so explicitly. If you can't fix it, mark the relevant TodoWrite items in_progress (not completed) and call it out.`;
  }

  private async runOne(cmd: VerifyCommand, signal: AbortSignal): Promise<VerifyResult> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(cmd.program, cmd.args, {
        cwd: cmd.cwd,
        signal,
        windowsHide: true,
        shell: process.platform === "win32",
      });
      let stdout = "";
      let stderr = "";
      const onChunk = (buf: Buffer, target: "out" | "err") => {
        const s = buf.toString("utf8");
        if (target === "out") {
          stdout += s;
          if (stdout.length > this.outputTailChars * 2) {
            stdout = stdout.slice(-this.outputTailChars * 2);
          }
        } else {
          stderr += s;
          if (stderr.length > this.outputTailChars * 2) {
            stderr = stderr.slice(-this.outputTailChars * 2);
          }
        }
      };
      child.stdout?.on("data", (b: Buffer) => onChunk(b, "out"));
      child.stderr?.on("data", (b: Buffer) => onChunk(b, "err"));
      child.on("error", (err: NodeJS.ErrnoException) => {
        // ENOENT = the tool isn't installed (e.g. ruff/pytest/tsc missing).
        // That's "verifier unavailable", NOT a code failure — never nag for it.
        const missing = err?.code === "ENOENT";
        resolve({
          ok: missing ? true : false,
          skipped: missing,
          command: cmd,
          exitCode: null,
          stdoutTail: stdout.slice(-this.outputTailChars),
          stderrTail: (stderr + (missing ? `\n(${cmd.program} not found — skipped)` : "\n(child errored)")).slice(
            -this.outputTailChars,
          ),
          durationMs: Date.now() - t0,
        });
      });
      child.on("close", (code) => {
        resolve({
          ok: code === 0,
          command: cmd,
          exitCode: code,
          stdoutTail: stdout.slice(-this.outputTailChars),
          stderrTail: stderr.slice(-this.outputTailChars),
          durationMs: Date.now() - t0,
        });
      });
    });
  }

  private detectSetup(): Promise<WorkspaceSetup> {
    if (!this.detectedSetupPromise) this.detectedSetupPromise = detectWorkspaceSetup(this.workspace);
    return this.detectedSetupPromise;
  }
}

// ─── Narrow verify command derivation ──────────────────────────────────

export interface WorkspaceSetup {
  hasTsconfig: boolean;
  /** tsconfig declares composite/references — `tsc -b` is valid. Otherwise
   *  `tsc -b` errors, so we must use `tsc --noEmit -p .`. */
  tsconfigComposite: boolean;
  hasPackageJson: boolean;
  hasPnpm: boolean;
  hasNpm: boolean;
  /** Project's actual JS/TS test runner, read from package.json. */
  testRunner: "vitest" | "jest" | "node" | null;
  hasPyproject: boolean;
  hasRuff: boolean;
  hasPytest: boolean;
  hasCargo: boolean;
  hasGoMod: boolean;
}

/** Is a binary resolvable on PATH? Used so we never emit a verify command for a
 *  tool that isn't installed (which would surface as a phantom failure). */
async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const ok = await fs
        .stat(path.join(dir, bin + ext))
        .then((s) => s.isFile())
        .catch(() => false);
      if (ok) return true;
    }
  }
  return false;
}

async function detectWorkspaceSetup(workspace: string): Promise<WorkspaceSetup> {
  const exists = async (rel: string) =>
    fs
      .stat(path.join(workspace, rel))
      .then(() => true)
      .catch(() => false);
  const readJson = async (rel: string): Promise<Record<string, unknown> | null> =>
    fs
      .readFile(path.join(workspace, rel), "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);

  const [tsc, pkg, pnpmLock, pyproject, cargo, goMod] = await Promise.all([
    exists("tsconfig.json"),
    exists("package.json"),
    exists("pnpm-lock.yaml"),
    exists("pyproject.toml"),
    exists("Cargo.toml"),
    exists("go.mod"),
  ]);

  // Composite/references → `tsc -b` is the right invocation; otherwise it errors.
  let tsconfigComposite = false;
  if (tsc) {
    const cfg = await readJson("tsconfig.json");
    const opts = (cfg?.compilerOptions ?? {}) as Record<string, unknown>;
    tsconfigComposite = opts.composite === true || Array.isArray(cfg?.references);
  }

  // Real test runner from package.json (devDeps + the `test` script), not a guess.
  let testRunner: WorkspaceSetup["testRunner"] = null;
  if (pkg) {
    const p = await readJson("package.json");
    const deps = { ...((p?.devDependencies as object) ?? {}), ...((p?.dependencies as object) ?? {}) } as Record<string, unknown>;
    const testScript = ((p?.scripts as Record<string, unknown>)?.test as string) ?? "";
    if ("vitest" in deps || /\bvitest\b/.test(testScript)) testRunner = "vitest";
    else if ("jest" in deps || /\bjest\b/.test(testScript)) testRunner = "jest";
    else if (/node\s+--test/.test(testScript)) testRunner = "node";
  }

  // Verify Python tooling is actually installed before emitting commands for it.
  const [hasRuff, hasPytest] = pyproject
    ? await Promise.all([onPath("ruff"), onPath("pytest")])
    : [false, false];

  return {
    hasTsconfig: tsc,
    tsconfigComposite,
    hasPackageJson: pkg,
    hasPnpm: pnpmLock,
    hasNpm: pkg && !pnpmLock,
    testRunner,
    hasPyproject: pyproject,
    hasRuff,
    hasPytest,
    hasCargo: cargo,
    hasGoMod: goMod,
  };
}

/**
 * Map touched SOURCE files to their existing test files so editing code runs
 * its tests, not just its types. Deterministic lookups only — sibling
 * `x.test.*` / `x.spec.*`, `__tests__/x.test.*`, and `tests/x*.test.*` beside
 * or near the source. Only returns files that actually exist; never guesses.
 */
export async function findRelatedTestFiles(files: readonly string[], workspace: string): Promise<string[]> {
  const found = new Set<string>();
  const exists = async (p: string) =>
    fs
      .stat(p)
      .then((s) => s.isFile())
      .catch(() => false);

  for (const file of files) {
    const base = path.basename(file);
    const m = base.match(/^(.+?)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/);
    if (!m) continue;
    if (/\.(test|spec)\.[^.]+$/.test(base) || /^test_|_test\.py$/.test(base)) continue; // already a test
    const stem = m[1];
    const ext = m[2];
    const dir = path.dirname(file);

    const candidates =
      ext === "py"
        ? [
            path.join(dir, `test_${stem}.py`),
            path.join(dir, `${stem}_test.py`),
            path.join(dir, "tests", `test_${stem}.py`),
            path.join(workspace, "tests", `test_${stem}.py`),
          ]
        : [
            path.join(dir, `${stem}.test.${ext}`),
            path.join(dir, `${stem}.spec.${ext}`),
            path.join(dir, "__tests__", `${stem}.test.${ext}`),
            path.join(dir, "..", "tests", `${stem}.test.${ext}`),
            path.join(workspace, "tests", `${stem}.test.${ext}`),
            path.join(workspace, "tests", `${stem}.test.mjs`),
            path.join(workspace, "test", `${stem}.test.${ext}`),
          ];
    for (const candidate of candidates) {
      if (found.size >= 12) return [...found]; // narrow means narrow
      if (await exists(candidate)) found.add(path.resolve(candidate));
    }
  }
  return [...found];
}

export function deriveNarrowVerify(
  files: readonly string[],
  workspace: string,
  setup: WorkspaceSetup,
): VerifyCommand[] {
  const cmds: VerifyCommand[] = [];

  const tsFiles = files.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
  const jsFiles = files.filter((f) => /\.(js|jsx|mjs|cjs)$/.test(f));
  const tsTestFiles = files.filter((f) => /\.test\.(ts|tsx|mts|cts)$/.test(f));
  const jsTestFiles = files.filter((f) => /\.test\.(js|jsx|mjs|cjs)$/.test(f));
  const pyFiles = files.filter((f) => f.endsWith(".py"));
  const pyTestFiles = files.filter((f) => /test_.*\.py$|.*_test\.py$/.test(path.basename(f)));
  const rsFiles = files.filter((f) => f.endsWith(".rs"));
  const goFiles = files.filter((f) => f.endsWith(".go"));

  // TypeScript: `tsc -b` ONLY when the project is composite/has references —
  // otherwise tsc -b errors. For non-composite projects use a project-wide
  // `tsc --noEmit -p .` (catches cross-file regressions without emitting), and
  // fall back to per-file --noEmit when there's no tsconfig at all.
  if (tsFiles.length > 0 && setup.hasTsconfig && setup.hasPackageJson && setup.tsconfigComposite) {
    cmds.push({
      program: setup.hasPnpm ? "pnpm" : "npx",
      args: setup.hasPnpm ? ["exec", "tsc", "-b", "--pretty", "false"] : ["tsc", "-b", "--pretty", "false"],
      cwd: workspace,
      label: "typescript",
    });
  } else if (tsFiles.length > 0 && setup.hasTsconfig) {
    cmds.push({
      program: setup.hasPnpm ? "pnpm" : "npx",
      args: setup.hasPnpm
        ? ["exec", "tsc", "--noEmit", "-p", ".", "--pretty", "false"]
        : ["-y", "tsc", "--noEmit", "-p", ".", "--pretty", "false"],
      cwd: workspace,
      label: "typescript",
    });
  } else if (tsFiles.length > 0) {
    cmds.push({
      program: "npx",
      args: ["-y", "tsc", "--noEmit", "--pretty", "false", ...tsFiles],
      cwd: workspace,
      label: `tsc(${tsFiles.length})`,
    });
  }

  // Tests: use the project's REAL runner. node --test only natively runs plain
  // JS — pointing it at .ts/.tsx is a guaranteed phantom failure on a Node
  // without type stripping. So: vitest/jest run any touched test file; bare
  // node --test runs only JS test files.
  const allTestFiles = [...tsTestFiles, ...jsTestFiles];
  const rel = (f: string) => path.relative(workspace, f);
  if (allTestFiles.length > 0 && (setup.testRunner === "vitest" || setup.testRunner === "jest")) {
    const runner = setup.testRunner;
    cmds.push({
      program: setup.hasPnpm ? "pnpm" : "npx",
      args: [
        ...(setup.hasPnpm ? ["exec", runner] : ["-y", runner]),
        ...(runner === "vitest" ? ["run"] : []),
        ...allTestFiles.map(rel),
      ],
      cwd: workspace,
      label: `${runner}(${allTestFiles.length})`,
    });
  } else if (jsTestFiles.length > 0) {
    cmds.push({
      program: "node",
      args: ["--test", ...jsTestFiles.map(rel)],
      cwd: workspace,
      label: `tests(${jsTestFiles.length})`,
    });
  }

  // Python: ruff first (cheap), then pytest if test files touched.
  if (pyFiles.length > 0 && setup.hasRuff) {
    cmds.push({
      program: "ruff",
      args: ["check", ...pyFiles],
      cwd: workspace,
      label: `ruff(${pyFiles.length})`,
    });
  }
  if (pyTestFiles.length > 0 && setup.hasPytest) {
    cmds.push({
      program: "pytest",
      args: ["-x", "--tb=short", ...pyTestFiles],
      cwd: workspace,
      label: `pytest(${pyTestFiles.length})`,
    });
  }

  // Rust + Go: project-level cheap checks.
  if (rsFiles.length > 0 && setup.hasCargo) {
    cmds.push({
      program: "cargo",
      args: ["check", "--message-format=short"],
      cwd: workspace,
      label: "cargo-check",
    });
  }
  if (goFiles.length > 0 && setup.hasGoMod) {
    cmds.push({
      program: "go",
      args: ["build", "./..."],
      cwd: workspace,
      label: "go-build",
    });
  }

  // Last resort: if we touched JS but no test files, at least make sure
  // there are no syntax errors via node --check (per-file).
  if (jsFiles.length > 0 && jsTestFiles.length === 0 && tsFiles.length === 0) {
    for (const f of jsFiles) {
      cmds.push({
        program: "node",
        args: ["--check", path.relative(workspace, f)],
        cwd: workspace,
        label: `node-check ${path.basename(f)}`,
      });
    }
  }

  return cmds;
}
