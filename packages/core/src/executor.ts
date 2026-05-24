import { spawn } from "node:child_process";
import type { ExecutionReport, VerificationCommand } from "@crix/protocol";
import { classifyVerificationCommand } from "./policy.js";
import { resolveInside } from "./paths.js";
import { tail } from "./util.js";

export class ShellExecutor {
  constructor(private readonly workspace: string) {}

  async verify(command: VerificationCommand): Promise<ExecutionReport> {
    const decision = classifyVerificationCommand(command);
    const display = [command.program, ...command.args].join(" ");
    if (!decision.allowed) {
      return { command: display, ok: false, code: null, durationMs: 0, stdoutTail: "", stderrTail: "", blockedReason: decision.reason };
    }
    return await this.run(command);
  }

  private async run(command: VerificationCommand): Promise<ExecutionReport> {
    const start = Date.now();
    const cwd = command.cwd ? resolveInside(this.workspace, command.cwd) : this.workspace;
    const display = [command.program, ...command.args].join(" ");
    const timeoutMs = command.timeoutMs ?? 120_000;
    return await new Promise<ExecutionReport>((resolve) => {
      const spawnTarget = resolveSpawnTarget(command.program, command.args);
      const child = spawn(spawnTarget.program, spawnTarget.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ command: display, ok: false, code: null, durationMs: Date.now() - start, stdoutTail: tail(stdout), stderrTail: tail(`timed out after ${timeoutMs}ms\n${stderr}`) });
      }, timeoutMs);
      child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ command: display, ok: false, code: null, durationMs: Date.now() - start, stdoutTail: tail(stdout), stderrTail: tail(error.message) });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ command: display, ok: code === 0, code, durationMs: Date.now() - start, stdoutTail: tail(stdout), stderrTail: tail(stderr) });
      });
    });
  }
}

function resolveSpawnTarget(program: string, args: string[]): { program: string; args: string[] } {
  if (process.platform === "win32" && ["npm", "pnpm", "npx", "yarn"].includes(program.toLowerCase())) {
    return { program: "cmd.exe", args: ["/d", "/s", "/c", program, ...args] };
  }
  return { program, args };
}
