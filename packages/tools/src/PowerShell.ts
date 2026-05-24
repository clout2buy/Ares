// PowerShell — execute a PowerShell command with timeout.
//
// Windows-first tool. Uses pwsh.exe if available (PowerShell 7+),
// otherwise falls back to powershell.exe (Windows PowerShell 5.1).

import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildTool } from "./_shared.js";
import { runShell } from "./Bash.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const inputSchema = z
  .object({
    command: z.string().min(1).describe("PowerShell command line."),
    description: z.string().describe("5-10 word active-voice summary."),
    timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    cwd: z.string().optional(),
  })
  .strict();

export const PowerShellTool = buildTool({
  name: "PowerShell",
  description:
    "Run a PowerShell command (foreground). Use this on Windows for native PowerShell syntax; use Bash for POSIX scripts. Default timeout 120s.",
  safety: "workspace-write",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => `Running ${i.command.slice(0, 60)}`,

  async call(i, ctx) {
    const cwd = i.cwd ?? ctx.workspace;
    const pwsh = (await which("pwsh")) ?? (await which("powershell"));
    if (!pwsh) throw new Error("Neither pwsh nor powershell found on PATH");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", i.command];
    const result = await runShell(pwsh, args, cwd, i.timeout, ctx.signal);
    return {
      output: result,
      display: result.timedOut
        ? `PowerShell timed out after ${i.timeout}ms`
        : `PowerShell exited ${result.exitCode} in ${result.durationMs}ms`,
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
