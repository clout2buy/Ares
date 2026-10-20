// Workspace — an agent's hands on the owner's VPS (daemon/workspaces.ts).
//
// Everything happens in ~/ares-work/<room or agent> on the box — never on the
// owner's own PC. Which box: the room's workspace for room seats and room work
// threads, else the agent's own, else the only one the owner added.
import { z } from "zod";
import { buildTool } from "@ares/tools";

export interface WorkspaceHost {
  /** The box this session works on, and the folder there; throws if none. */
  resolve(sessionId: string): { id: string; label: string; folder: string; host: string };
  run(sessionId: string, command: string, timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; label: string; folder: string }>;
  put(sessionId: string, localPath: string, remoteName: string): Promise<{ ok: boolean; error?: string; label: string; folder: string }>;
  get(sessionId: string, remoteName: string, localPath?: string): Promise<{ ok: boolean; path: string; error?: string }>;
  /** Open a server running on the box on the OWNER's screen, through a
   *  private tunnel (never exposed to the internet). */
  preview(sessionId: string, port: number, urlPath?: string): Promise<{ url: string; label: string }>;
}

let host: WorkspaceHost | undefined;
export function setWorkspaceHost(next: WorkspaceHost | undefined): void {
  host = next;
}

const input = z
  .object({
    action: z.enum(["run", "put", "get", "where", "preview"]).describe("run a shell command on the VPS, put a file from this machine onto it, get a file from it, say which box and folder you are on, or preview a server you started there on your owner's screen"),
    port: z.number().int().min(1).max(65535).optional().describe("preview: the port your server listens on, on the box (start it first, e.g. nohup python3 -m http.server 8080 &)"),
    command: z.string().min(1).max(8000).optional().describe("run: a bash command, run in your work folder on the box (e.g. 'npm i && node build.js', 'python3 sim.py'). Long-running servers: start them with nohup … & and say so."),
    path: z.string().min(1).max(600).optional().describe("put: the local file to upload; get: where to save it locally (default: your workspace folder)"),
    name: z.string().min(1).max(300).optional().describe("put/get: the file's path inside your work folder on the box"),
    timeout_s: z.number().int().min(5).max(900).optional().describe("run: seconds before giving up (default 120)"),
  })
  .strict();

export function makeWorkspaceTool() {
  return buildTool({
    name: "Workspace",
    description:
      "Your owner's VPS — a Linux box you can work on for real: run commands, install packages, build and run code, keep a game server up. " +
      "Everything runs in your own work folder on the box (per room, or per agent), never on your owner's PC. " +
      "Use it for heavy or long-running work, servers other people must reach, and anything you don't want on the owner's machine. " +
      "Files people should open still go into the room with Rooms share.",
    safety: "workspace-write",
    concurrency: "exclusive",
    inputZod: input,
    activityDescription: (i) => `Workspace ${i.action}${i.command ? ": " + i.command.slice(0, 50) : i.name ? " " + i.name : ""}`,
    async call(i, ctx): Promise<{ output: unknown; display: string }> {
      if (!host) throw new Error("workspaces are only available in the desktop app");
      const sid = ctx?.sessionId ?? "";
      if (i.action === "where") {
        const w = host.resolve(sid);
        return { output: w, display: `${w.label} (${w.host}) · ~/ares-work/${w.folder}` };
      }
      if (i.action === "run") {
        if (!i.command) throw new Error("run needs command");
        const out = await host.run(sid, i.command, i.timeout_s ? i.timeout_s * 1000 : undefined);
        const text = [out.stdout.trim(), out.stderr.trim() ? `stderr:\n${out.stderr.trim()}` : ""].filter(Boolean).join("\n").slice(-12_000);
        return {
          output: { code: out.code, timedOut: out.timedOut, stdout: out.stdout.slice(-12_000), stderr: out.stderr.slice(-6_000) },
          display: `${out.label}:~/ares-work/${out.folder} $ ${i.command.slice(0, 80)}\n${out.timedOut ? "(timed out)\n" : ""}exit ${out.code ?? "?"}${text ? `\n${text}` : ""}`,
        };
      }
      if (i.action === "preview") {
        if (!i.port) throw new Error("preview needs port");
        const out = await host.preview(sid, i.port, i.name);
        return { output: { ok: true, url: out.url }, display: `opened ${out.label}:${i.port} on your owner's screen (${out.url}) — private to this PC` };
      }
      if (i.action === "put") {
        if (!i.path || !i.name) throw new Error("put needs path (local) and name (on the box)");
        const out = await host.put(sid, i.path, i.name);
        if (!out.ok) throw new Error(out.error ?? "upload failed");
        return { output: { ok: true }, display: `uploaded ${i.path} → ${out.label}:~/ares-work/${out.folder}/${i.name}` };
      }
      if (!i.name) throw new Error("get needs name (the file on the box)");
      const out = await host.get(sid, i.name, i.path);
      if (!out.ok) throw new Error(out.error ?? "download failed");
      return { output: { ok: true, path: out.path }, display: `downloaded ${i.name} → ${out.path}` };
    },
  });
}
