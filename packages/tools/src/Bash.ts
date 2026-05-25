// Bash — execute a shell command with timeout.
//
// Foreground only in M1; background + BashOutput/KillShell ship in M3.

import { z } from "zod";
import { spawn } from "node:child_process";
import { buildTool, resolveWorkspacePath } from "./_shared.js";

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
  activityDescription: (i) =>
    `${i.run_in_background ? "Backgrounding" : "Running"} ${i.command.slice(0, 60)}`,

  async call(i, ctx): Promise<{ output: unknown; display: string }> {
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      const snap = ctx.shellRegistry.spawn({
        program: "bash",
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

    const result = await runShell("bash", ["-lc", i.command], cwd, i.timeout, ctx.signal);
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
      while (stdoutBytes > MAX_OUTPUT_CHARS * 4 && stdoutChunks.length > 1) {
        stdoutBytes -= stdoutChunks.shift()?.length ?? 0;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
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
