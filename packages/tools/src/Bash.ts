// Bash — execute a shell command with timeout or as a background process.

import { z } from "zod";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool, describeShellActivity, resolveWorkspacePath } from "./_shared.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

const inputSchema = z
  .object({
    command: z.string().min(1).describe("Bash command line. Quote paths with spaces."),
    description: z.string().describe("5-10 word active-voice summary, e.g. 'List files in current directory'."),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe(`Timeout in milliseconds (max ${MAX_TIMEOUT_MS}, foreground only).`),
    cwd: z.string().optional().describe("Working directory. Defaults to workspace."),
    run_in_background: z
      .boolean()
      .default(false)
      .describe(
        "When true, the shell runs in the background and the tool returns a shell_id immediately. Poll output with BashOutput, terminate with KillShell. Use for dev servers, watchers, builds you want to monitor.",
      ),
  })
  .strict();

export interface BashOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface BashBackgroundOutput {
  shell_id: string;
  command: string;
  status: "running";
  description: string;
  cwd: string;
}

export const BashTool = buildTool({
  name: "Bash",
  description:
    "Run a bash/POSIX command. By default runs foreground until completion. Set run_in_background=true to launch it in the background — the tool returns a shell_id immediately; use BashOutput to poll new output and KillShell to terminate. On Windows, prefer PowerShell unless POSIX shell syntax is specifically required.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => describeShellActivity(i.command, i.run_in_background === true),
  async checkPermissions(i, ctx) {
    return ctx.commandPermissions?.decide("Bash", i.command) ?? { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: unknown; display: string }> {
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");
    const bash = await resolveBashProgram();

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      const snap = ctx.shellRegistry.spawn({
        program: bash,
        args: ["-lc", i.command],
        cwd,
        description: i.description,
      });
      const output: BashOutput | BashBackgroundOutput = {
        shell_id: snap.id,
        command: snap.command,
        status: "running",
        description: snap.description,
        cwd: snap.cwd,
      };
      return {
        output,
        display: `[background] ${snap.id}: ${i.command.slice(0, 50)}`,
      };
    }

    const result = await runShell(bash, ["-lc", i.command], cwd, i.timeout, ctx.signal, (stream, text) => {
      ctx.emitProgress?.({ kind: "shell_output", stream, text });
    });
    const output: BashOutput | BashBackgroundOutput = result;
    return {
      output,
      display: result.timedOut
        ? `Bash timed out after ${i.timeout}ms`
        : result.exitCode === 0
        ? `Bash exited 0 in ${result.durationMs}ms`
        : `Bash failed with exit ${result.exitCode} in ${result.durationMs}ms`,
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
): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(program, args, { cwd, signal, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
      onOutput?.("stdout", decodeOutput(chunk));
      while (stdoutBytes > MAX_OUTPUT_CHARS * 4 && stdoutChunks.length > 1) {
        stdoutBytes -= stdoutChunks.shift()?.length ?? 0;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
      onOutput?.("stderr", decodeOutput(chunk));
      while (stderrBytes > MAX_OUTPUT_CHARS * 4 && stderrChunks.length > 1) {
        stderrBytes -= stderrChunks.shift()?.length ?? 0;
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = decodeOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeOutput(Buffer.concat(stderrChunks));
      const truncatedOut = stdout.length > MAX_OUTPUT_CHARS;
      const truncatedErr = stderr.length > MAX_OUTPUT_CHARS;
      resolve({
        command: `${program} ${args.join(" ")}`,
        exitCode: code,
        stdout: truncatedOut ? stdout.slice(-MAX_OUTPUT_CHARS) : stdout,
        stderr: truncatedErr ? stderr.slice(-MAX_OUTPUT_CHARS) : stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: truncatedOut || truncatedErr,
      });
    });
  });
}

let cachedBashProgram: Promise<string> | null = null;

export function resolveBashProgram(): Promise<string> {
  cachedBashProgram ??= resolveBashProgramUncached();
  return cachedBashProgram;
}

async function resolveBashProgramUncached(): Promise<string> {
  if (process.env.CRIX_BASH) return process.env.CRIX_BASH;
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
  const probe = await runShell(candidate, ["-lc", "printf __crix_bash_probe__"], process.cwd(), 5000, new AbortController().signal).catch(() => null);
  return probe?.exitCode === 0 && probe.stdout.includes("__crix_bash_probe__");
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
