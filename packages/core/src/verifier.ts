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
import { createHash } from "node:crypto";
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
  /** This result was served from the fingerprint pass-cache — the command was
   *  NOT re-run because the same command already passed against unchanged
   *  files. Always implies ok:true. */
  cached?: boolean;
}

export type VerifyEvent =
  | { type: "scheduled"; files: string[]; commands: VerifyCommand[] }
  | { type: "running"; command: VerifyCommand }
  | { type: "finished"; result: VerifyResult }
  | { type: "all_finished"; ok: boolean; results: VerifyResult[] };

/**
 * Runs a single verify command to completion. Injectable so tests can supply a
 * fake that counts invocations and returns canned results without spawning a
 * real process. The default (see {@link ContinuousVerifier.spawnRunOne}) spawns
 * the command. A runner MUST honour the abort signal and never throw — it
 * resolves a VerifyResult even on error.
 */
export type CommandRunner = (cmd: VerifyCommand, signal: AbortSignal) => Promise<VerifyResult>;

/** Cache-hit/miss counters exposed for observability + testing. */
export interface VerifyCacheStats {
  /** Verify commands served from the pass-cache without re-running. */
  hits: number;
  /** Verify commands that had to actually run (no cached pass). */
  misses: number;
  /** Passes stored into the cache. */
  stores: number;
  /** Entries evicted because the cache hit its size bound. */
  evictions: number;
  /** Current number of cached (command,files) → pass fingerprints. */
  size: number;
}

export interface VerifierOptions {
  workspace: string;
  /** Debounce window for batching successive edits. Default 800ms. */
  debounceMs?: number;
  /** Cap on output tail captured per command. Default 4000 chars. */
  outputTailChars?: number;
  /** Hook for the CLI/TUI to render verify events live. */
  onEvent?: (event: VerifyEvent) => void;
  /**
   * Override the process spawner (tests inject a counting fake). Defaults to the
   * real spawn-based runner. Purely a testing/instrumentation seam — production
   * never sets this.
   */
  runCommand?: CommandRunner;
  /**
   * Upper bound on the pass-fingerprint cache before oldest entries are evicted.
   * Default 256. Tunable with ARES_VERIFY_CACHE_MAX.
   */
  cacheMax?: number;
}

interface PendingReminder {
  text: string;
  source: "verifier";
}

/** Marks the "verify still running" reminder so settle() never stacks dupes
 *  and the end-gate can recognize the unsettled-verdict case. */
const UNSETTLED_REMINDER_PREFIX = "Verification still running:";

export class ContinuousVerifier {
  private readonly workspace: string;
  private readonly debounceMs: number;
  private readonly outputTailChars: number;
  private readonly onEvent?: (event: VerifyEvent) => void;
  private readonly runCommand: CommandRunner;
  private readonly cacheMax: number;

  private pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight: { abort: AbortController; done: Promise<void> } | null = null;
  private pendingReminders: PendingReminder[] = [];
  /** Detected once per workspace and cached. */
  private detectedSetupPromise: Promise<WorkspaceSetup> | null = null;

  /**
   * Pass-cache: fingerprint → true. A fingerprint identifies (this exact
   * command) + (the exact content of the files that run covered). If it's
   * present, that command already PASSED against unchanged inputs, so we can
   * skip re-running. Insertion-ordered so the oldest key is `keys().next()`.
   * Only PASSES are ever stored (see fireRun) — failures always re-run.
   */
  private passCache = new Map<string, true>();
  private stats: VerifyCacheStats = { hits: 0, misses: 0, stores: 0, evictions: 0, size: 0 };

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
    // Injectable runner: tests count invocations here; prod uses the spawner.
    this.runCommand = opts.runCommand ?? ((cmd, signal) => this.spawnRunOne(cmd, signal));
    const envCacheMax = Number(process.env.ARES_VERIFY_CACHE_MAX);
    this.cacheMax = opts.cacheMax ?? (Number.isFinite(envCacheMax) && envCacheMax > 0 ? Math.floor(envCacheMax) : 256);
  }

  /** Snapshot of pass-cache hit/miss counters for observability + tests. */
  cacheStats(): VerifyCacheStats {
    return { ...this.stats, size: this.passCache.size };
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
   * verdict lands. Never throws; on timeout it does NOT return empty-handed —
   * it pushes an UNRESOLVED-style reminder so the end-gate stays honest (the
   * turn can't be reported "done" while a verify run is still in flight).
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
    // so loop until quiet or out of time. Returning at the deadline while work
    // is still pending would let drainReminders() come back empty and the turn
    // end "completed" with checks unfinished — so every timeout exit funnels
    // through pushUnsettledReminder() instead of a bare return.
    while (Date.now() < deadline) {
      const inFlight = this.inFlight;
      if (!inFlight && this.pendingFiles.size === 0) return; // fully settled — clean exit
      if (inFlight) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return this.pushUnsettledReminder();
        await Promise.race([inFlight.done, new Promise((r) => setTimeout(r, remaining))]);
      } else if (this.pendingFiles.size > 0) {
        await Promise.race([this.fireRun().catch(() => undefined), untilDeadline()]);
      }
    }
    // Fell out of the loop because the deadline passed. If anything is still
    // running or queued, the verdict hasn't landed — surface that, don't
    // silently let the turn finish.
    if (this.inFlight || this.pendingFiles.size > 0) this.pushUnsettledReminder();
  }

  /**
   * Push a reminder noting verification is still running so the end-of-turn
   * gate refuses to report "done" before the verdict lands. Only one such
   * reminder is queued at a time (a settle() timeout shouldn't stack dupes).
   */
  private pushUnsettledReminder(): void {
    if (this.pendingReminders.some((r) => r.text.startsWith(UNSETTLED_REMINDER_PREFIX))) return;
    this.pendingReminders.push({
      text: `${UNSETTLED_REMINDER_PREFIX} the continuous verifier is still running checks for your recent edits and has not returned a verdict yet. Do NOT claim the task is done or complete — wait for the verify results (they'll surface on the next turn) and address any failures first.`,
      source: "verifier",
    });
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
    const coveredFiles = [...files, ...related];
    const commands = deriveNarrowVerify(coveredFiles, this.workspace, setup);
    if (commands.length === 0) return;

    this.onEvent?.({ type: "scheduled", files, commands });

    // FINGERPRINT CACHING — hash the content of the files this run covers ONCE
    // (all commands in a run share the same input set), then combine that with
    // each command's own identity. If a command with the SAME fingerprint
    // already PASSED, we skip the process entirely and reuse the pass. Any edit
    // to a covered file changes its content hash → new fingerprint → re-run.
    const filesDigest = await this.hashFiles(coveredFiles);

    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.inFlight = { abort, done };

    const results: VerifyResult[] = [];
    let allOk = true;

    try {
      for (const cmd of commands) {
        if (abort.signal.aborted) break;
        const fp = fingerprintCommand(cmd, filesDigest);
        // Cache hit: this exact command already passed against these exact file
        // contents. Serve a synthetic pass instantly — no spawn.
        if (this.passCache.has(fp)) {
          this.stats.hits++;
          this.touchCacheEntry(fp);
          const cached: VerifyResult = {
            ok: true,
            cached: true,
            command: cmd,
            exitCode: 0,
            stdoutTail: "",
            stderrTail: "",
            durationMs: 0,
          };
          results.push(cached);
          this.onEvent?.({ type: "finished", result: cached });
          continue;
        }
        this.stats.misses++;
        this.onEvent?.({ type: "running", command: cmd });
        const result = await this.runCommand(cmd, abort.signal);
        results.push(result);
        if (!result.ok) allOk = false;
        // Only cache PASSES, and never cache a skipped/ENOENT "pass" (the tool
        // was absent, not verified) or an aborted run. A real failure is left
        // uncached so it re-runs next time — the user is presumably fixing it.
        if (result.ok && !result.skipped && !abort.signal.aborted) this.storePass(fp);
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
      const triage = triageVerifyOutput(tail);
      // Triage first: a wall of 50 failures is usually 3 root causes — say
      // that, then show a shorter tail. No triage signal → the old full tail.
      const tailBudget = triage ? 800 : 1500;
      const trimmed = tail.length > tailBudget ? "…" + tail.slice(-tailBudget) : tail;
      const head = triage ? `${triage}\n` : "";
      return `[${r.command.label}] ${r.command.program} ${r.command.args.join(" ")}
exit: ${r.exitCode ?? "killed"}  (${r.durationMs}ms)
${head}${trimmed}`;
    });
    return `Continuous verifier detected failures after your recent edits. Address these before reporting "done":

${sections.join("\n\n")}

Fix the ROOT CAUSE first — one bad symbol or import usually explains a whole page of red. If a failure is unrelated to your change, say so explicitly. If you can't fix it, mark the relevant TodoWrite items in_progress (not completed) and call it out.`;
  }

  private async spawnRunOne(cmd: VerifyCommand, signal: AbortSignal): Promise<VerifyResult> {
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

  /**
   * Content-hash the files a run covers into one stable digest. Sorted so order
   * of touched files never changes the fingerprint. A file that can't be read
   * (deleted, permission) contributes a "missing" marker rather than throwing —
   * a change in readability still busts the cache. This is the only file I/O the
   * cache adds per run, and it's cheap relative to a tsc/test spawn.
   */
  private async hashFiles(files: readonly string[]): Promise<string> {
    const h = createHash("sha1");
    for (const f of [...files].sort()) {
      const abs = path.resolve(f);
      const content = await fs.readFile(abs).catch(() => null);
      h.update(abs);
      h.update("\0");
      if (content === null) h.update("\x01missing");
      else {
        h.update("\x02");
        h.update(content);
      }
      h.update("\n");
    }
    return h.digest("hex");
  }

  /** Insert a passing fingerprint, evicting the oldest entry past the bound. */
  private storePass(fp: string): void {
    if (this.passCache.has(fp)) {
      this.touchCacheEntry(fp);
      return;
    }
    this.passCache.set(fp, true);
    this.stats.stores++;
    while (this.passCache.size > this.cacheMax) {
      // Map preserves insertion order → the first key is the oldest (LRU-ish;
      // touchCacheEntry re-inserts on hit so recently-used keys move to the end).
      const oldest = this.passCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.passCache.delete(oldest);
      this.stats.evictions++;
    }
  }

  /** Move a key to the most-recently-used end so eviction skips hot entries. */
  private touchCacheEntry(fp: string): void {
    if (!this.passCache.has(fp)) return;
    this.passCache.delete(fp);
    this.passCache.set(fp, true);
  }
}

/**
 * Fingerprint = sha1( command identity ⊕ covered-files content digest ). The
 * command identity is program + args + cwd + label so two different checks over
 * the same files (e.g. tsc vs. tests) never collide. `filesDigest` already folds
 * in every covered file's content, so any edit changes it.
 */
function fingerprintCommand(cmd: VerifyCommand, filesDigest: string): string {
  const h = createHash("sha1");
  h.update(cmd.program);
  h.update("\0");
  h.update(cmd.args.join(""));
  h.update("\0");
  h.update(cmd.cwd);
  h.update("\0");
  h.update(cmd.label);
  h.update("\0");
  h.update(filesDigest);
  return h.digest("hex");
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

// ─── Failure triage — a wall of red becomes N root causes ───────────────
/**
 * Group a failing command's output into root-cause buckets (PURE, exported for
 * tests). Recognizes TypeScript diagnostics, node:test failures, and generic
 * Error lines; normalizes away paths/line-numbers/identifiers so "the same
 * mistake in 12 places" collapses into one bucket. Returns a compact summary
 * ("12 failures, 3 root causes: …") or null when there's no triage signal —
 * callers fall back to the raw tail.
 */
export function triageVerifyOutput(output: string): string | null {
  interface Bucket {
    count: number;
    sample: string;
    files: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  const add = (key: string, sample: string, file?: string) => {
    const b = buckets.get(key) ?? { count: 0, sample, files: new Set<string>() };
    b.count++;
    if (file) b.files.add(file.replace(/\\/g, "/").split("/").pop() ?? file);
    buckets.set(key, b);
  };
  // The FIRST quoted token is the subject of the diagnostic ("Cannot find name
  // 'lastShot'") and distinguishes root causes; later quoted tokens are context
  // ("on type 'Bar'") and collapse. Digits always collapse (foo1/foo2 → fooN).
  const normalize = (msg: string): string => {
    let seenQuote = false;
    return msg
      .replace(/'[^']*'|"[^"]*"/g, (m) => {
        if (seenQuote) return "'…'";
        seenQuote = true;
        return m;
      })
      .replace(/\d+/g, "N")
      .trim()
      .slice(0, 90);
  };

  let matched = 0;
  // TypeScript: path(line,col): error TS1234: message
  for (const m of output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/gm)) {
    add(`${m[4]} ${normalize(m[5])}`, `${m[4]}: ${m[5].trim()}`, m[1]);
    matched++;
  }
  // node:test TAP failures: "not ok N - name" / summary "✖ name"
  for (const m of output.matchAll(/^\s*(?:not ok \d+ -|✖) (.+)$/gm)) {
    add("failing test(s)", `failing test: ${m[1].trim().slice(0, 80)}`);
    matched++;
  }
  // Generic thrown errors: "TypeError: x is not a function" etc.
  for (const m of output.matchAll(/^\s*((?:Assertion|Type|Range|Syntax|Reference)?Error): (.+)$/gm)) {
    add(`${m[1]} ${normalize(m[2])}`, `${m[1]}: ${m[2].trim()}`, undefined);
    matched++;
  }
  if (matched < 2 || buckets.size === 0) return null;

  const top = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  const lines = top.map(([, b], i) => {
    const where = b.files.size ? ` (${[...b.files].slice(0, 3).join(", ")}${b.files.size > 3 ? `, +${b.files.size - 3} more` : ""})` : "";
    return `  ${i + 1}. ×${b.count} ${b.sample}${where}`;
  });
  const extra = buckets.size > top.length ? ` (+${buckets.size - top.length} more cause(s))` : "";
  return `TRIAGE: ${matched} failure line(s), ${buckets.size} distinct root cause(s)${extra}:\n${lines.join("\n")}`;
}
