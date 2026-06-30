// PowerShell — execute a PowerShell command with timeout.
//
// Windows-first tool. Uses pwsh.exe if available (PowerShell 7+),
// otherwise falls back to powershell.exe (Windows PowerShell 5.1).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTool,
  describeShellActivity,
  destructiveShellDecision,
  resolveWorkspacePath,
} from "./_shared.js";
import { runShell } from "./Bash.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const inputSchema = z
  .object({
    command: z.string().min(1).describe("PowerShell command line."),
    description: z.string().describe("5-10 word active-voice summary."),
    timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    cwd: z.string().optional(),
    run_in_background: z
      .boolean()
      .default(false)
      .describe(
        "When true, the shell runs in the background and the tool returns a shell_id. Poll output with BashOutput, terminate with KillShell.",
      ),
  })
  .strict();

export const PowerShellTool = buildTool({
  name: "PowerShell",
  description:
    "Run a PowerShell command. Foreground by default; pass run_in_background=true for dev servers/watchers/builds — returns a shell_id, then use BashOutput to poll. Use this on Windows for native PowerShell syntax; use Bash for POSIX scripts. Commands ALREADY run from the workspace root — do NOT prefix `cd <workspace>`; set the `cwd` field only to run in a different directory. ALWAYS quote paths that contain spaces (the workspace path can contain spaces, e.g. \"Ares Workspace\") — an unquoted spaced path makes `cd`/`Set-Location` fail with 'positional parameter' errors; this matters most when launching a detached/new-window process where you must include the path yourself.",
  safety: "workspace-write",
  concurrency: "exclusive",
  // Self-capping (own per-command timeout + run_in_background) — uncapped here.
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => describeShellActivity(i.command, i.run_in_background === true),
  commandFor: (i) => i.command,
  async checkPermissions(i, ctx) {
    const configured = ctx.commandPermissions?.decide("PowerShell", i.command);
    if (configured && configured.kind !== "allow") return configured;
    return destructiveShellDecision(i.command) ?? configured ?? { kind: "allow" };
  },

  async call(i, ctx) {
    const cwd = await resolveWorkspacePath(ctx, i.cwd, "cwd", "execute");
    const pwsh = (await which("pwsh")) ?? (await which("powershell"));
    if (!pwsh) throw new Error("Neither pwsh nor powershell found on PATH");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", i.command];

    if (i.run_in_background) {
      if (!ctx.shellRegistry) {
        throw new Error("run_in_background requires a shell registry on the session context");
      }
      // Await the real launch — spawn() now resolves only after the child
      // actually started (or throws toolError if it failed to), so we never
      // return a false {status:'running'} for a process that never ran.
      const snap = await ctx.shellRegistry.spawn({
        program: pwsh,
        args,
        cwd,
        description: i.description,
      });
      const output: unknown = {
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

    const result = await runShell(pwsh, args, cwd, i.timeout, ctx.signal, (stream, text) => {
      ctx.emitProgress?.({ kind: "shell_output", stream, text });
    });
    const output: unknown = result;
    return {
      output,
      display: result.timedOut
        ? `PowerShell timed out after ${i.timeout}ms`
        : result.exitCode === 0
        ? `PowerShell exited 0 in ${result.durationMs}ms`
        : `PowerShell failed with exit ${result.exitCode} in ${result.durationMs}ms`,
    };
  },
});

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
