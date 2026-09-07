// RemotePC — Ares agent tool for controlling PCs connected via Ares Remote Agent.
//
// The RemoteAgentServer singleton is injected at garrison startup via
// setRemoteAgentServer(). In standalone/test contexts this gracefully degrades
// with a clear "not connected" message rather than crashing.
//
// Three actions:
//   list_pcs    — enumerate all connected remote PCs
//   exec_on_pc  — run a shell command on a specific PC and return the output
//   notify_pc   — push a popup notification to a PC (fire-and-forget)

import { z } from "zod";
import { buildTool } from "./_shared.js";

// ─── Server interface (mirrors RemoteAgentServer public API) ───────────────
// Defined here as a minimal interface so @ares/tools doesn't import @ares/cli.

export interface RemoteAgentServerLike {
  listPcs(): Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number }>;
  exec(pcId: string, command: string, timeoutMs?: number): Promise<{ output: string; exitCode?: number }>;
  notify(pcId: string, message: string): void;
}

let _server: RemoteAgentServerLike | null = null;

/** Injected at daemon startup. Absent in offline/test contexts. */
export function setRemoteAgentServer(server: RemoteAgentServerLike | null): void {
  _server = server;
}

// ─── Schema ────────────────────────────────────────────────────────────────

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list_pcs").describe("List all remote PCs currently connected to Ares."),
  }),
  z.object({
    action: z.literal("exec_on_pc").describe("Run a shell command on a connected remote PC and return the output."),
    pc_id: z.string().describe("The PC id from list_pcs."),
    command: z.string().describe("Shell command to execute on the remote PC."),
    timeout_ms: z.number().int().min(1000).max(120_000).optional().describe("Max wait time in ms. Default 30000."),
  }),
  z.object({
    action: z.literal("notify_pc").describe("Push a popup notification to a connected remote PC screen."),
    pc_id: z.string().describe("The PC id from list_pcs."),
    message: z.string().describe("Short message to display (e.g. 'Ares finished — restart now')."),
  }),
]);

export type RemotePCInput = z.infer<typeof inputSchema>;

export interface RemotePCOutput {
  action: string;
  ok: boolean;
  pcs?: Array<{ id: string; label: string; hostname: string; os: string; ip: string; connectedAt: number }>;
  output?: string;
  exitCode?: number;
  note?: string;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

export const RemotePCTool = buildTool({
  name: "RemotePC",
  description:
    "Control remote PCs connected via Ares Remote Agent. " +
    "Use list_pcs to see connected machines. " +
    "Use exec_on_pc to run shell commands on a remote PC (e.g. network diagnostics, process list, file operations). " +
    "Use notify_pc to push a popup notification to a PC's screen. " +
    "Only available when a remote PC has connected via the Ares download link.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    switch (i.action) {
      case "list_pcs": return "listing connected remote PCs";
      case "exec_on_pc": return `executing on remote PC ${i.pc_id}: ${i.command.slice(0, 60)}`;
      case "notify_pc": return `notifying remote PC ${i.pc_id}: ${i.message.slice(0, 60)}`;
    }
  },
  async call(i: RemotePCInput): Promise<{ output: RemotePCOutput; display: string }> {
    if (!_server) {
      const out: RemotePCOutput = { action: i.action, ok: false, note: "Remote agent server not running. Start Ares garrison to enable remote PC connections." };
      return { output: out, display: out.note! };
    }

    switch (i.action) {
      case "list_pcs": {
        const pcs = _server.listPcs().map(({ username: _u, ...rest }) => rest);
        const note = pcs.length === 0 ? "No remote PCs connected. Ask the user to run the Ares connect script on their PC." : undefined;
        const display = pcs.length === 0
          ? "No remote PCs connected."
          : pcs.map((p) => `• ${p.hostname} (${p.os}) — ${p.ip} [${p.id}]`).join("\n");
        return { output: { action: "list_pcs", ok: true, pcs, note }, display };
      }

      case "exec_on_pc": {
        try {
          const result = await _server.exec(i.pc_id, i.command, i.timeout_ms);
          return {
            output: { action: "exec_on_pc", ok: true, output: result.output, exitCode: result.exitCode },
            display: result.output || `(exit ${result.exitCode ?? 0})`,
          };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "exec_on_pc", ok: false, note }, display: `Error: ${note}` };
        }
      }

      case "notify_pc": {
        try {
          _server.notify(i.pc_id, i.message);
          return { output: { action: "notify_pc", ok: true }, display: `Notification sent to ${i.pc_id}.` };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "notify_pc", ok: false, note }, display: `Error: ${note}` };
        }
      }
    }
  },
});
