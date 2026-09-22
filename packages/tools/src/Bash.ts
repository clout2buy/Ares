// Bash — execute a shell command with timeout or as a background process.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import {
  buildTool,
  describeShellActivity,
  destructiveShellDecision,
  irrecoverableShellRefusal,
  resolveWorkspacePath,
  shellInputSchema,
  shellPolicyDecision,
  shellRepositoryInstructionDecision,
  shellWatchdogFor,
} from "./_shared.js";
import { classifyShellFailure, shellFlavorOf, type ShellFlavor } from "./shellHints.js";

const MAX_OUTPUT_CHARS = 30_000;
// After the shell process exits, how long its stdio pipes may stay open
// (draining a grandchild's inherited handles) before we force-close them.
const EXIT_STREAM_GRACE_MS = 1_500;

const inputSchema = shellInputSchema("Bash command line. Quote paths with spaces.");

export interface BashOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Complete interleaved stdout/stderr when the inline tails were capped. */
  fullOutputPath?: string;
  /** Present only when the full-output spool itself failed. Inline tails remain. */
  captureError?: string;
  /** Which interpreter ran the command (bash / powershell 5.1 / pwsh 7+ / cmd). */
  shell: ShellFlavor;
  /** One-line actionable diagnosis from classifyShellFailure when the run
   *  failed and a known signature appeared in the output tail. */
  hint?: string;
}

export interface BashBackgroundOutput {
  shell_id: string;
  command: string;
  status: "running" | "exited" | "killed" | "errored" | "orphaned";
  description: string;
  cwd: string;
  exitCode?: number | null;
  outputPath?: string;
}

export const BashTool = buildTool({
  name: "Bash",
  description:
    "Run a bash/POSIX command. By default runs foreground until completion. Set run_in_background=true to launch it in the background — the tool returns a shell_id immediately; use BashOutput to poll new output and KillShell to terminate. On Windows, prefer PowerShell unless POSIX shell syntax is specifically required. Commands ALREADY run from the workspace root — do NOT prefix `cd <workspace>`; set the `cwd` field only to run in a different directory. ALWAYS quote paths that contain spaces (the workspace path can contain spaces, e.g. \"Ares Workspace\") — unquoted spaced paths break the shell; this matters most when launching a detached/new-window process where you must include the path yourself.",
  safety: "workspace-write",
  concurrency: "exclusive",
  // Self-capping, but the ENGINE keeps its own deadline derived from the
  // command's declared timeout: a self-cap that fires and still fails to
  // settle is how turns wedged. Uncapped here would mean the 13-min ceiling.
  watchdogTimeoutMs: 0,
  watchdogFor: shellWatchdogFor,
  inputZod: inputSchema,
  activityDescription: (i) => describeShellActivity(i.command, i.run_in_background === true),
  commandFor: (i) => i.command,
  async checkPermissions(i, ctx) {
    const instructionDecision = await shellRepositoryInstructionDecision(ctx, i.cwd, i.target_paths);
    if (instructionDecision) return instructionDecision;
    const configured = ctx.commandPermissions?.decide("Bash", i.command);
    // A configured/stored deny|ask wins as before.
    if (configured && configured.kind !== "allow") return configured;
    // An EXPLICIT prior allow (configured or `allow_always`-persisted) must win
    // over the destructive heuristic — otherwise destructiveShellDecision's
    // {kind:'ask'} short-circuited the `??` below and silently re-prompted on a
    // command the user already granted. Only re-ask for destructive commands
    // that were NEVER approved.
    if (configured?.kind === "allow") return configured;
    return destructiveShellDecision(i.command) ?? shellPolicyDecision(i.command) ?? { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: unknown; display: string }> {
    // Enforced HERE, not in checkPermissions: a permission decision is only a
    // prompt, and bypass/YOLO auto-allows every prompt. An unrecoverable
    // deletion has to be refused at the point of execution or the mode that
    // exists to remove friction also removes the last guard.
    const refusal = irrecoverableShellRefusal(i.command);
    if (refusal) throw new Error(refusal);
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");
    const bash = await resolveBashProgram();

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      // Await the real launch — spawn() now resolves only after the child
      // actually started (or throws toolError if it failed to), so we never
      // return a false {status:'running'} for a process that never ran.
      const snap = await ctx.shellRegistry.spawn({
        program: bash,
        args: ["-lc", i.command],
        cwd,
        description: i.description,
        sessionId: ctx.sessionId,
        invocationKey: ctx.toolUseId ?? `legacy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
      });
      const output: BashOutput | BashBackgroundOutput = {
        shell_id: snap.id,
        command: snap.command,
        status: snap.status,
        description: snap.description,
        cwd: snap.cwd,
        exitCode: snap.exitCode,
        ...(snap.outputPath ? { outputPath: snap.outputPath } : {}),
      };
      return {
        output,
        display: `[background] ${snap.id}: ${i.command.slice(0, 50)}`,
      };
    }

    const captureDir = path.join(ctx.workspace, ".ares", "shell-output", ctx.sessionId);
    await fs.mkdir(captureDir, { recursive: true });
    const capturePath = path.join(captureDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.log`);
    const result = await runShell(bash, ["-lc", i.command], cwd, i.timeout, ctx.signal, (stream, text) => {
      ctx.emitProgress?.({ kind: "shell_output", stream, text });
    }, capturePath);
    const output: BashOutput | BashBackgroundOutput = result;
    const hintLine = result.hint ? `\nhint: ${result.hint}` : "";
    const failure = result.timedOut
      ? `Bash timed out after ${i.timeout}ms${hintLine}`
      : result.exitCode === 0
        ? undefined
        : `Bash exited with code ${result.exitCode ?? "unknown"}${hintLine}`;
    return {
      output,
      ...(failure ? { failure } : {}),
      display: result.timedOut
        ? `Bash timed out after ${i.timeout}ms${hintLine}`
        : result.exitCode === 0
        ? `Bash exited 0 in ${result.durationMs}ms`
        : `Bash failed with exit ${result.exitCode} in ${result.durationMs}ms${hintLine}`,
    };
  },
});

export async function runShell(
  program: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
  capturePath?: string,
): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    // Own abort handling instead of passing `signal` to spawn. On Windows the
    // built-in path kills only PowerShell/cmd, leaving grandchildren alive with
    // inherited stdout handles so the Promise never reaches `close`.
    const child = spawn(program, args, {
      cwd,
      windowsHide: true,
      // Lead a new process group (POSIX) so killTree can signal the whole
      // pipeline at once. Without this, child.kill() reaches only the shell:
      // `docker exec -i … <<'PY'` leaves the exec orphaned to PID 1 still
      // holding our stdout pipe, `close` never fires, and the turn wedges
      // until the 15-minute watchdog. The background supervisor was fixed for
      // this in ShellSupervisor; the foreground path was not, and froze the
      // same way.
      detached: process.platform !== "win32",
    });
    // Nothing ever writes to this command's stdin, so leaving it open means a
    // command that reads stdin (an unexpected prompt, `cat` with no file)
    // blocks forever instead of seeing EOF. Close it immediately.
    try { child.stdin?.end(); } catch { /* already gone */ }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutDropped = false;
    let stderrDropped = false;
    let timedOut = false;
    let captureFailed = false;
    let captureFailureMessage: string | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const pausedForCapture = new Set<{ pause(): unknown; resume(): unknown }>();
    let settleCapture: (() => void) | undefined;
    const captureDone = new Promise<void>((resolve) => { settleCapture = resolve; });
    const capture = capturePath ? createWriteStream(capturePath, { flags: "w" }) : null;
    capture?.once("finish", () => settleCapture?.());
    capture?.once("error", (error) => {
      captureFailed = true;
      captureFailureMessage = error instanceof Error ? error.message : String(error);
      for (const stream of pausedForCapture) stream.resume();
      pausedForCapture.clear();
      settleCapture?.();
    });

    const writeCapture = (
      stream: "stdout" | "stderr",
      text: string,
      source: { pause(): unknown; resume(): unknown },
    ) => {
      if (!capture || captureFailed || text.length === 0) return;
      if (!capture.write(`[${stream}]\n${text}`)) {
        source.pause();
        pausedForCapture.add(source);
        capture.once("drain", () => {
          if (pausedForCapture.delete(source)) source.resume();
        });
      }
    };

    /** Signal the child's whole process GROUP, falling back to the bare child
     *  (already gone, or Windows, where the group has no meaning). */
    const signalGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* already gone */ }
      }
    };

    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        });
      } else {
        signalGroup("SIGTERM");
        const force = setTimeout(() => signalGroup("SIGKILL"), KILL_ESCALATE_MS);
        force.unref();
      }
      // Last resort. A survivor in another PID namespace — a container process
      // reached through `docker exec` — can keep our stdout pipe open even
      // after SIGKILL lands on everything we can see, and `close` would never
      // arrive. Settle with the output we have rather than hang the turn.
      const giveUp = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        void finish(null, "a surviving child held the output pipe open");
      }, FORCE_SETTLE_MS);
      giveUp.unref();
    };
    const onAbort = () => killTree();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) queueMicrotask(onAbort);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      const text = stdoutDecoder.write(chunk);
      if (text) onOutput?.("stdout", text);
      writeCapture("stdout", text, child.stdout);
      while (stdoutBytes > MAX_OUTPUT_CHARS * 4 && stdoutChunks.length > 1) {
        stdoutBytes -= stdoutChunks.shift()?.length ?? 0;
        stdoutDropped = true;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      const text = stderrDecoder.write(chunk);
      if (text) onOutput?.("stderr", text);
      writeCapture("stderr", text, child.stderr);
      while (stderrBytes > MAX_OUTPUT_CHARS * 4 && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift()?.length ?? 0;
        stderrDropped = true;
      }
    });
    child.stdout.on("end", () => {
      const text = stdoutDecoder.end();
      if (text) onOutput?.("stdout", text);
      writeCapture("stdout", text, child.stdout);
    });
    child.stderr.on("end", () => {
      const text = stderrDecoder.end();
      if (text) onOutput?.("stderr", text);
      writeCapture("stderr", text, child.stderr);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      capture?.destroy();
      reject(err);
    });
    child.on("exit", () => {
      // Natural exit only: the shell finished on its own, but a grandchild it
      // launched (Start-Process dev server, nohup daemon) inherited its pipe
      // handles on Windows and can hold them open FOREVER — `close` would
      // never fire and this promise would hang past every timeout, because
      // the timeout's taskkill targets the already-dead shell pid and reaps
      // nothing (the 656-second "checking the port" session). Give the pipes
      // a short grace to flush buffered output, then force-close our read
      // ends; `close` fires and the tool settles with the output it has.
      //
      // On the timeout/abort path we DID kill the tree — `close` arrives when
      // the tree actually dies, and settling early would race the reap (the
      // caller must be able to trust that a timed-out tree is gone). That path
      // has its own backstop in killTree, so a survivor cannot hang us either.
      if (timedOut || signal.aborted) return;
      const grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, EXIT_STREAM_GRACE_MS);
      grace.unref();
      child.once("close", () => clearTimeout(grace));
    });
    // One exit for both the normal `close` and the force-settle backstop, so a
    // wedged grandchild can never leave this promise unresolved.
    let settled = false;
    const finish = async (code: number | null, forcedReason?: string) => {
      if (settled) return;
      settled = true;
      {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (capture) {
          capture.end();
          await captureDone;
        }
        const stdout = decodeOutput(Buffer.concat(stdoutChunks));
        const stderr = decodeOutput(Buffer.concat(stderrChunks));
        const truncatedOut = stdoutDropped || stdout.length > MAX_OUTPUT_CHARS;
        const truncatedErr = stderrDropped || stderr.length > MAX_OUTPUT_CHARS;
        const truncated = truncatedOut || truncatedErr;
        if (capturePath && (!truncated || captureFailed)) {
          await fs.rm(capturePath, { force: true }).catch(() => undefined);
        }
        const shell = shellFlavorOf(program);
        // A timeout has no signature in the output — name the fix directly.
        // Otherwise classify the tail so a bare "exited with code N" carries
        // the trap that caused it (see shellHints.ts for the field numbers).
        const hint = forcedReason
          ? `the command was killed but ${forcedReason}; treat the output as partial. Prefer run_in_background=true for anything that can hang.`
          : timedOut
            ? "raise `timeout` or run with run_in_background=true and poll with BashOutput."
            : classifyShellFailure(code, stdout, stderr, shell);
        resolve({
          command: `${program} ${args.join(" ")}`,
          exitCode: code,
          stdout: truncatedOut ? stdout.slice(-MAX_OUTPUT_CHARS) : stdout,
          stderr: truncatedErr ? stderr.slice(-MAX_OUTPUT_CHARS) : stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          truncated,
          shell,
          ...(hint ? { hint } : {}),
          ...(truncated && capturePath && !captureFailed ? { fullOutputPath: capturePath } : {}),
          ...(captureFailureMessage ? { captureError: captureFailureMessage } : {}),
        });
      }
    };

    child.on("close", (code) => {
      void finish(code);
    });
  });
}

/** SIGTERM → SIGKILL grace for a killed process group. */
const KILL_ESCALATE_MS = 2_000;
/** How long after a kill we wait for `close` before settling with partial
 *  output. A survivor in another PID namespace can hold the pipe forever; the
 *  turn must not wait for it. */
const FORCE_SETTLE_MS = 5_000;

let cachedBashProgram: Promise<string> | null = null;

export function resolveBashProgram(): Promise<string> {
  cachedBashProgram ??= resolveBashProgramUncached();
  return cachedBashProgram;
}

async function resolveBashProgramUncached(): Promise<string> {
  if (process.env.ARES_BASH) return process.env.ARES_BASH;
  if (process.platform !== "win32") return "bash";

  const candidates = unique([
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ...pathCandidates("bash.exe"),
    ...pathCandidates("bash"),
  ]);

  for (const candidate of candidates) {
    if (isWindowsWslLauncher(candidate)) continue;
    if (!(await exists(candidate))) continue;
    if (await bashWorks(candidate)) return candidate;
  }

  // Last resort: let spawn surface the real failure. This keeps non-Git
  // Windows hosts honest instead of silently pretending PowerShell is Bash.
  return "bash";
}

function pathCandidates(bin: string): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, bin));
}

function isWindowsWslLauncher(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  return normalized.includes("\\windows\\system32\\bash.exe") || normalized.includes("\\windowsapps\\bash.exe");
}

async function exists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function bashWorks(candidate: string): Promise<boolean> {
  const probe = await runShell(candidate, ["-lc", "printf __ares_bash_probe__"], process.cwd(), 5000, new AbortController().signal).catch(() => null);
  return probe?.exitCode === 0 && probe.stdout.includes("__ares_bash_probe__");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  let oddNulls = 0;
  for (let i = 1; i < buf.length; i += 2) {
    if (buf[i] === 0) oddNulls++;
  }
  if (oddNulls > buf.length / 8) {
    return buf.toString("utf16le");
  }
  return buf.toString("utf8");
}
