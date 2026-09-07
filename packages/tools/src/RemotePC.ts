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
  generateToken(label: string): Promise<{ token: string; url: string; scope: "public" | "lan" }>;
  listPcs(): Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number }>;
  /** Out-of-process implementations can fetch a fresh list; preferred when present. */
  listPcsAsync?(): Promise<Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number }>>;
  exec(pcId: string, command: string, timeoutMs?: number): Promise<{ output: string; exitCode?: number }>;
  notify(pcId: string, message: string): void;
  disconnect?(pcId: string): void;
}

let _server: RemoteAgentServerLike | null = null;

/** Injected at startup — the in-process server in the garrison, a loopback
 *  client in the daemon. Absent in offline/test contexts. */
export function setRemoteAgentServer(server: RemoteAgentServerLike | null): void {
  _server = server;
}

export function getRemoteAgentServer(): RemoteAgentServerLike | null {
  return _server;
}

// ─── Schema ────────────────────────────────────────────────────────────────

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate_link").describe(
      "Generate a one-time connection link to send to someone so their PC can connect to Ares. " +
      "Use this whenever the user mentions someone needing help, being at a coworker's or friend's machine, " +
      "IT shadowing, or wanting to connect to another PC — even if they don't use exact words. " +
      "Returns a URL to share with the person on the other machine.",
    ),
    label: z.string().describe("Short name for this PC, e.g. 'Sarah' or 'John laptop'. Used to identify it when it connects."),
  }),
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
  url?: string;
  pcs?: Array<{ id: string; label: string; hostname: string; os: string; ip: string; connectedAt: number }>;
  output?: string;
  exitCode?: number;
  note?: string;
}

// ─── Tool ─────────────────────────────────────────────────────────────────

export const RemotePCTool = buildTool({
  name: "RemotePC",
  description:
    "Connect to and control other people's PCs via Ares Remote Agent. " +
    "Use generate_link when the user wants to help someone with THEIR computer — a friend, coworker, or client whose machine has a problem, IT shadowing, 'can you look at John's laptop'. " +
    "The phrasing may be casual ('my friend is having trouble', 'helping sarah'); if the subject is another person's device, generate the link and tell the user to send it. " +
    "Do NOT use it for problems on the user's own machine, code, or servers — use the normal tools for those. " +
    "Use list_pcs to see which machines are currently connected. " +
    "Use exec_on_pc to run shell commands (diagnostics, process lists, file ops, network checks). " +
    "Use notify_pc to push a popup to their screen.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    switch (i.action) {
      case "generate_link": return `generating remote connect link for ${i.label}`;
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

    const fail = (action: string, err: unknown): { output: RemotePCOutput; display: string } => {
      const note = err instanceof Error ? err.message : String(err);
      return { output: { action, ok: false, note }, display: `Error: ${note}` };
    };

    switch (i.action) {
      case "generate_link": {
        let url: string, scope: "public" | "lan";
        try { ({ url, scope } = await _server.generateToken(i.label)); }
        catch (err) { return fail("generate_link", err); }
        const lanNote = scope === "lan"
          ? "\n\n⚠️ LAN-only link: no internet tunnel is available, so this only works if they're on the same network as you. Tell the user plainly."
          : "";
        return {
          output: { action: "generate_link", ok: true, url, note: scope === "lan" ? "lan-only link (no tunnel)" : undefined },
          display: `🔗 Connect link for ${i.label}:\n${url}\n\nSend it to them. They tap it, run the download, and their PC connects — no install, no account. The owner is notified the moment it's in.${lanNote}`,
        };
      }

      case "list_pcs": {
        let raw;
        try { raw = _server.listPcsAsync ? await _server.listPcsAsync() : _server.listPcs(); }
        catch (err) { return fail("list_pcs", err); }
        const pcs = raw.map(({ username: _u, ...rest }) => rest);
        const note = pcs.length === 0 ? "No remote PCs connected. If someone needs help, generate_link and have the user send it to them." : undefined;
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
