// Bash — execute a shell command with timeout.
//
// Foreground only in M1; background + BashOutput/KillShell ship in M3.

import { z } from "zod";
import { spawn } from "node:child_process";
import { buildTool } from "./_shared.js";

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
      .describe(`Timeout in milliseconds (max ${MAX_TIMEOUT_MS}).`),
    cwd: z.string().optional().describe("Working directory. Defaults to workspace."),
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

export const BashTool = buildTool({
  name: "Bash",
  description:
    "Run a bash command (foreground). For Windows-native commands use PowerShell. Default timeout 120s, max 600s.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Running ${i.command.slice(0, 60)}`,

  async call(i, ctx): Promise<{ output: BashOutput; display: string }> {
    const cwd = i.cwd ?? ctx.workspace;
    const result = await runShell("bash", ["-lc", i.command], cwd, i.timeout, ctx.signal);
    return {
      output: result,
      display: result.timedOut
        ? `Bash timed out after ${i.timeout}ms`
        : `Bash exited ${result.exitCode} in ${result.durationMs}ms`,
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS * 2);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_CHARS * 2) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS * 2);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
