// KillShell — terminate a backgrounded shell.

import { z } from "zod";
import { buildTool } from "./_shared.js";
import type { ShellRegistry } from "./ShellRegistry.js";

const inputSchema = z
  .object({
    shell_id: z.string().describe("Shell id returned by Bash/PowerShell run_in_background=true."),
  })
  .strict();

export interface KillShellOutput {
  shell_id: string;
  killed: boolean;
  reason: string;
}

export function makeKillShellTool(registry: ShellRegistry) {
  return buildTool({
    name: "KillShell",
    description:
      "Terminate a background shell by id. Returns whether the kill landed. Useful for stopping dev servers, watchers, or runaway processes started with Bash/PowerShell run_in_background=true.",
    safety: "destructive",
    concurrency: "exclusive",
    inputZod: inputSchema,
    activityDescription: (i) => `KillShell ${i.shell_id}`,
    async call(i): Promise<{ output: KillShellOutput; display: string }> {
      if (!registry.has(i.shell_id)) {
        return {
          output: { shell_id: i.shell_id, killed: false, reason: "unknown shell id" },
          display: `unknown shell: ${i.shell_id}`,
        };
      }
      const killed = registry.kill(i.shell_id, "user");
      return {
        output: {
          shell_id: i.shell_id,
          killed,
          reason: killed ? "killed" : "already finished",
        },
        display: killed ? `killed ${i.shell_id}` : `${i.shell_id} already finished`,
      };
    },
  });
}
