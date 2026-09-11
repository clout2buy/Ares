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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildTool } from "./_shared.js";

/** Cap for file transfer in either direction — keeps a stray "get the whole disk" from OOMing. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** OS → the command style exec_on_pc expects, so Ares doesn't run `dir` on a Mac. */
function shellHintForOs(os: string): string {
  // "Darwin" contains "win" — match mac/linux before windows.
  if (/darwin|mac|os ?x/i.test(os)) return "macOS/sh — ls, cat, grep, $VAR, forward slashes";
  if (/linux|nix|bsd/i.test(os)) return "Linux/sh — ls, cat, grep, $VAR, forward slashes";
  if (/win/i.test(os)) return "Windows/cmd.exe — dir, type, findstr, where, %VAR%, backslashes";
  return "unknown OS — confirm before running shell commands";
}

// ─── Server interface (mirrors RemoteAgentServer public API) ───────────────
// Defined here as a minimal interface so @ares/tools doesn't import @ares/cli.

export interface RemoteAgentServerLike {
  generateToken(label: string): Promise<{ token: string; url: string; scope: "public" | "lan" }>;
  // Optional so an older daemon still satisfies the interface — the tool reports
  // "update the daemon" rather than throwing a TypeError at the owner.
  generatePairingLink?(name: string): Promise<{ token: string; url: string; scope: "public" | "lan"; warning?: string }>;
  listDevices?(): Array<{
    id: string; name: string; hostname: string; os: string;
    addedAt: number; lastSeenAt?: number; elevated: boolean; online: boolean;
  }>;
  unpairDevice?(deviceId: string): Promise<{ name: string } | null>;
  renameDevice?(deviceId: string, name: string): Promise<{ name: string } | null>;
  listPcs(): Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number }>;
  /** Out-of-process implementations can fetch a fresh list; preferred when present. */
  listPcsAsync?(): Promise<Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number }>>;
  exec(pcId: string, command: string, timeoutMs?: number): Promise<{ output: string; exitCode?: number }>;
  screenshot(pcId: string): Promise<{ dataBase64: string }>;
  /** Read a file FROM the remote PC. Owner-driven; the connector never initiates. */
  readFile(pcId: string, path: string): Promise<{ dataBase64: string; size: number }>;
  /** Write a file TO the remote PC. Data flows owner → remote only. */
  writeFile(pcId: string, path: string, dataBase64: string): Promise<{ bytes: number }>;
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

// A flat object with an `action` enum, not a discriminated union: the JSON
// Schema for a union has no top-level `type: "object"` and Anthropic/OpenAI
// reject it outright. Per-action requirements are enforced in superRefine.
const inputSchema = z.object({
  action: z.enum([
    "generate_link", "list_pcs", "exec_on_pc", "screenshot_pc", "get_file", "put_file", "notify_pc",
    "pair_device", "list_devices", "unpair_device", "rename_device",
  ]).describe(
    "generate_link: mint a one-time connect link for someone else's PC (REQUIRES label). " +
    "list_pcs: what's connected right now. " +
    "exec_on_pc: run a shell command on a connected PC (REQUIRES pc_id + command). " +
    "screenshot_pc: capture and SEE their screen (REQUIRES pc_id) — use it to verify a fix or read a dialog. " +
    "get_file: copy a file FROM their PC to yours (REQUIRES pc_id + remote_path). " +
    "put_file: copy a file FROM your machine TO theirs (REQUIRES pc_id + local_path + remote_path). " +
    "notify_pc: show a popup on their screen (REQUIRES pc_id + message). " +
    "pair_device: PERMANENTLY pair one of the OWNER'S OWN machines (REQUIRES label) — it reconnects at every boot and can run ADMIN commands. " +
    "list_devices: the owner's permanently paired machines and whether each is online right now. " +
    "unpair_device: revoke a paired machine (REQUIRES device_id) — its connector is told to stop. " +
    "rename_device: relabel a paired machine (REQUIRES device_id + label).",
  ),
  label: z.string().optional().describe("generate_link: short name for the PC, e.g. \"Sarah\" or \"Dave's laptop\" — shown when it connects."),
  pc_id: z.string().optional().describe("the PC id from list_pcs (or from the connected notice)."),
  command: z.string().optional().describe("exec_on_pc: shell command to run on the remote PC."),
  device_id: z.string().optional().describe("unpair_device / rename_device: the device id from list_devices."),
  timeout_ms: z.number().int().min(1000).max(120_000).optional().describe("exec_on_pc: max wait in ms. Default 30000."),
  remote_path: z.string().optional().describe("get_file / put_file: the absolute path ON THE REMOTE PC to read from or write to."),
  local_path: z.string().optional().describe("put_file: the file on YOUR machine to send (absolute or workspace-relative). get_file: optional destination on your machine; defaults to a downloads folder in the workspace."),
  message: z.string().optional().describe("notify_pc: short text for the popup, e.g. \"Fixed — restart when you can\"."),
}).superRefine((v, ctx) => {
  const need = (field: "label" | "pc_id" | "command" | "message" | "remote_path" | "local_path" | "device_id") => {
    if (!v[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${v.action} requires ${field}` });
  };
  if (v.action === "generate_link") need("label");
  if (v.action === "exec_on_pc") { need("pc_id"); need("command"); }
  if (v.action === "screenshot_pc") need("pc_id");
  if (v.action === "get_file") { need("pc_id"); need("remote_path"); }
  if (v.action === "put_file") { need("pc_id"); need("local_path"); need("remote_path"); }
  if (v.action === "notify_pc") { need("pc_id"); need("message"); }
  if (v.action === "pair_device") need("label");
  if (v.action === "unpair_device") need("device_id");
  if (v.action === "rename_device") { need("device_id"); need("label"); }
});

export type RemotePCInput = z.infer<typeof inputSchema>;

export interface RemotePCOutput {
  action: string;
  ok: boolean;
  url?: string;
  pcs?: Array<{ id: string; label: string; hostname: string; os: string; ip: string; connectedAt: number }>;
  /** list_devices: the owner's permanently paired machines. */
  devices?: Array<{
    id: string; name: string; hostname: string; os: string;
    addedAt: number; lastSeenAt?: number; elevated: boolean; online: boolean;
  }>;
  output?: string;
  exitCode?: number;
  /** get_file: where the pulled file landed on the owner's machine. */
  savedTo?: string;
  /** screenshot_pc: where the PNG was saved (desktop preview). */
  screenshotPath?: string;
  bytes?: number;
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
    "Use exec_on_pc to run shell commands — ALWAYS match the syntax to that PC's OS (list_pcs and the connect notice report it): Windows goes through cmd.exe (dir, type, findstr, %VAR%, backslashes), macOS/Linux go through sh (ls, cat, grep, $VAR, forward slashes). " +
    "Use screenshot_pc to SEE their screen — read an error dialog, or verify a fix worked. " +
    "Use get_file to pull a file from their PC to yours, and put_file to send one the other way (data only ever flows the direction you ask; their machine can never read yours). " +
    "Use notify_pc to push a popup to their screen. " +
    "PERMANENT PAIRING is a different thing from the one-time help link above, and is for the OWNER'S OWN machines: " +
    "pair_device installs a boot-time connector on that machine so it reconnects by itself whenever it is powered on, " +
    "running as the owner WITH ADMIN RIGHTS — so commands that need elevation just work instead of being handed back " +
    "to the owner to paste. Use it when the owner talks about one of THEIR machines always being available " +
    "(\"my laptop\", \"my database box\", \"connect my other PC\"), and generate_link when they are helping someone else. " +
    "A paired device shows up in list_pcs like any other once it connects, so exec_on_pc and the rest work on it unchanged. " +
    "unpair_device revokes it immediately and tells the connector to stop.",
  safety: "external-state",
  concurrency: "exclusive",
  inputZod: inputSchema,
  activityDescription: (i) => {
    switch (i.action) {
      case "generate_link": return `generating remote connect link for ${i.label}`;
      case "list_pcs": return "listing connected remote PCs";
      case "exec_on_pc": return `executing on remote PC ${i.pc_id}: ${(i.command ?? "").slice(0, 60)}`;
      case "pair_device": return `creating a permanent pairing link for ${i.label}`;
      case "list_devices": return "listing permanently paired devices";
      case "unpair_device": return `unpairing device ${i.device_id}`;
      case "rename_device": return `renaming device ${i.device_id} to ${i.label}`;
      case "screenshot_pc": return `capturing screen of remote PC ${i.pc_id}`;
      case "get_file": return `pulling ${i.remote_path} from remote PC ${i.pc_id}`;
      case "put_file": return `sending ${i.local_path} to remote PC ${i.pc_id}`;
      case "notify_pc": return `notifying remote PC ${i.pc_id}: ${(i.message ?? "").slice(0, 60)}`;
    }
  },
  async call(i: RemotePCInput, ctx): Promise<{ output: RemotePCOutput; display: string; images?: Array<{ mediaType: string; data: string }> }> {
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
        try { ({ url, scope } = await _server.generateToken(i.label!)); }
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
          : pcs.map((p) => `• ${p.hostname} — ${p.os} · ${shellHintForOs(p.os)} — ${p.ip} [${p.id}]`).join("\n");
        return { output: { action: "list_pcs", ok: true, pcs, note }, display };
      }

      case "pair_device": {
        if (!_server.generatePairingLink) {
          return fail("pair_device", new Error("this Ares build has no device pairing — update the daemon"));
        }
        let res: { token: string; url: string; scope: "public" | "lan"; warning?: string };
        try { res = await _server.generatePairingLink(i.label!); }
        catch (err) { return fail("pair_device", err); }
        const lan = res.scope === "lan"
          ? "\n\n⚠️ LAN-only: no internet tunnel is up, so this link only works from the same network."
          : "";
        const fw = res.warning ? `\n\n⚠️ ${res.warning}` : "";
        return {
          output: { action: "pair_device", ok: true, url: res.url, note: res.scope === "lan" ? "lan-only" : undefined },
          display:
            `🔗 Pairing link for "${i.label}":\n${res.url}\n\n` +
            "Open it ON THAT MACHINE and follow the one command it shows (needs an admin PowerShell).\n" +
            "It installs a boot-time connector: the machine reconnects by itself whenever it is on, and " +
            "Ares can run admin commands on it directly.\n" +
            "The link works once and expires in 10 minutes." + lan + fw,
        };
      }

      case "list_devices": {
        if (!_server.listDevices) {
          return fail("list_devices", new Error("this Ares build has no device pairing — update the daemon"));
        }
        const devices = _server.listDevices();
        if (devices.length === 0) {
          return {
            output: { action: "list_devices", ok: true, devices: [] },
            display: "No permanently paired devices. Use pair_device to add one of the owner's machines.",
          };
        }
        const lines = devices.map((d) => {
          const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toISOString().replace("T", " ").slice(0, 16) : "never";
          return `${d.online ? "🟢" : "⚪"} ${d.name} — ${d.hostname} (${d.os})${d.elevated ? " · admin" : ""}\n   id: ${d.id} · last seen: ${seen}`;
        });
        return {
          output: { action: "list_devices", ok: true, devices },
          display: lines.join("\n"),
        };
      }

      case "unpair_device": {
        if (!_server.unpairDevice) {
          return fail("unpair_device", new Error("this Ares build has no device pairing — update the daemon"));
        }
        let device: { name: string } | null;
        try { device = await _server.unpairDevice(i.device_id!); }
        catch (err) { return fail("unpair_device", err); }
        if (!device) {
          return { output: { action: "unpair_device", ok: false, note: "no such paired device" }, display: "No paired device with that id." };
        }
        return {
          output: { action: "unpair_device", ok: true },
          display: `Unpaired "${device.name}". Its credential is revoked and the connector has been told to stop. To remove the boot task on that machine:\n  Unregister-ScheduledTask -TaskName AresRemoteConnector -Confirm:$false`,
        };
      }

      case "rename_device": {
        if (!_server.renameDevice) {
          return fail("rename_device", new Error("this Ares build has no device pairing — update the daemon"));
        }
        let device: { name: string } | null;
        try { device = await _server.renameDevice(i.device_id!, i.label!); }
        catch (err) { return fail("rename_device", err); }
        if (!device) {
          return { output: { action: "rename_device", ok: false, note: "no such paired device" }, display: "No paired device with that id." };
        }
        return { output: { action: "rename_device", ok: true }, display: `Renamed to "${device.name}".` };
      }

      case "exec_on_pc": {
        try {
          const result = await _server.exec(i.pc_id!, i.command!, i.timeout_ms);
          return {
            output: { action: "exec_on_pc", ok: true, output: result.output, exitCode: result.exitCode },
            display: result.output || `(exit ${result.exitCode ?? 0})`,
          };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "exec_on_pc", ok: false, note }, display: `Error: ${note}` };
        }
      }

      case "screenshot_pc": {
        let dataBase64: string;
        try { ({ dataBase64 } = await _server.screenshot(i.pc_id!)); }
        catch (err) { return fail("screenshot_pc", err); }
        // Save a copy for the desktop preview; the model also sees it inline.
        let screenshotPath: string | undefined;
        try {
          const dir = path.join(os.tmpdir(), "ares-remote");
          await mkdir(dir, { recursive: true });
          screenshotPath = path.join(dir, `${i.pc_id}-${Date.now()}.png`);
          await writeFile(screenshotPath, Buffer.from(dataBase64, "base64"));
        } catch { screenshotPath = undefined; }
        return {
          output: { action: "screenshot_pc", ok: true, screenshotPath },
          display: `Captured their screen.`,
          images: [{ mediaType: "image/png", data: dataBase64 }],
        };
      }

      case "get_file": {
        try {
          const { dataBase64, size } = await _server.readFile(i.pc_id!, i.remote_path!);
          if (size > MAX_FILE_BYTES) return fail("get_file", new Error(`file is ${(size / 1e6).toFixed(1)}MB — over the ${MAX_FILE_BYTES / 1e6}MB transfer cap`));
          const dest = i.local_path
            ? (path.isAbsolute(i.local_path) ? i.local_path : path.resolve(ctx.workspace, i.local_path))
            : path.join(ctx.workspace, "ares-downloads", path.basename(i.remote_path!.replace(/[\\/]+$/, "")) || "download");
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, Buffer.from(dataBase64, "base64"));
          return {
            output: { action: "get_file", ok: true, savedTo: dest, bytes: size },
            display: `Pulled ${i.remote_path} → ${dest} (${size.toLocaleString()} bytes). It's on your machine now.`,
          };
        } catch (err) { return fail("get_file", err); }
      }

      case "put_file": {
        try {
          const src = path.isAbsolute(i.local_path!) ? i.local_path! : path.resolve(ctx.workspace, i.local_path!);
          const buf = await readFile(src);
          if (buf.byteLength > MAX_FILE_BYTES) return fail("put_file", new Error(`file is ${(buf.byteLength / 1e6).toFixed(1)}MB — over the ${MAX_FILE_BYTES / 1e6}MB transfer cap`));
          const { bytes } = await _server.writeFile(i.pc_id!, i.remote_path!, buf.toString("base64"));
          return {
            output: { action: "put_file", ok: true, bytes },
            display: `Sent ${src} → ${i.remote_path} on their PC (${bytes.toLocaleString()} bytes).`,
          };
        } catch (err) { return fail("put_file", err); }
      }

      case "notify_pc": {
        try {
          _server.notify(i.pc_id!, i.message!);
          return { output: { action: "notify_pc", ok: true }, display: `Notification sent to ${i.pc_id}.` };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "notify_pc", ok: false, note }, display: `Error: ${note}` };
        }
      }
    }
  },
});
