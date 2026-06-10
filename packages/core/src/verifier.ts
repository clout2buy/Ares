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
    this.debounceMs = opts.debounceMs ?? 800;
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
    const commands = deriveNarrowVerify(files, this.workspace, setup);
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
      child.on("error", () => {
        resolve({
          ok: false,
          command: cmd,
          exitCode: null,
          stdoutTail: stdout.slice(-this.outputTailChars),
          stderrTail: (stderr + "\n(child errored)").slice(-this.outputTailChars),
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
  hasPackageJson: boolean;
  hasPnpm: boolean;
  hasNpm: boolean;
  hasPyproject: boolean;
  hasRuff: boolean;
  hasPytest: boolean;
  hasCargo: boolean;
  hasGoMod: boolean;
}

async function detectWorkspaceSetup(workspace: string): Promise<WorkspaceSetup> {
  const exists = async (rel: string) =>
    fs
      .stat(path.join(workspace, rel))
      .then(() => true)
      .catch(() => false);
  const [tsc, pkg, pnpmLock, pyproject, cargo, goMod] = await Promise.all([
    exists("tsconfig.json"),
    exists("package.json"),
    exists("pnpm-lock.yaml"),
    exists("pyproject.toml"),
    exists("Cargo.toml"),
    exists("go.mod"),
  ]);
  return {
    hasTsconfig: tsc,
    hasPackageJson: pkg,
    hasPnpm: pnpmLock,
    hasNpm: pkg && !pnpmLock,
    hasPyproject: pyproject,
    hasRuff: pyproject, // optimistic; ruff failure is graceful
    hasPytest: pyproject,
    hasCargo: cargo,
    hasGoMod: goMod,
  };
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

  // TypeScript: prefer project-wide tsc -b if tsconfig exists; otherwise
  // per-file --noEmit. The project-wide path catches cross-file regressions.
  if (tsFiles.length > 0 && setup.hasTsconfig && setup.hasPackageJson) {
    cmds.push({
      program: setup.hasPnpm ? "pnpm" : "npx",
      args: setup.hasPnpm ? ["exec", "tsc", "-b", "--pretty", "false"] : ["tsc", "-b", "--pretty", "false"],
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

  // Node tests: run JUST the touched test files (narrow is the whole point).
  const nodeTestFiles = [...tsTestFiles, ...jsTestFiles];
  if (nodeTestFiles.length > 0) {
    cmds.push({
      program: "node",
      args: ["--test", ...nodeTestFiles.map((f) => path.relative(workspace, f))],
      cwd: workspace,
      label: `tests(${nodeTestFiles.length})`,
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
