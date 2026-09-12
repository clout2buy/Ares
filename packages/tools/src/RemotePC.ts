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
import type { PermissionDecision } from "@ares/protocol";
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

/** A live local→remote HTTP forward, as the tool reports it. */
export interface ForwardRow {
  id: string;
  pcId: string;
  target: string;
  localUrl: string;
  port: number;
  createdAt: number;
  requests: number;
}

export interface RemoteAgentServerLike {
  generateToken(label: string): Promise<{ token: string; url: string; scope: "public" | "lan" }>;
  // Optional so an older daemon still satisfies the interface — the tool reports
  // "update the daemon" rather than throwing a TypeError at the owner.
  generatePairingLink?(name: string): Promise<{ token: string; url: string; scope: "public" | "lan"; warning?: string }>;
  listDevices?(): Array<{
    id: string; name: string; hostname: string; os: string;
    addedAt: number; lastSeenAt?: number; elevated: boolean; online: boolean;
  }>;
  /** Out-of-process implementations can fetch a fresh list; preferred when
   *  present, because the sync one is a cache that reads empty before its first
   *  refresh lands — indistinguishable from "nothing is paired". */
  listDevicesAsync?(): Promise<Array<{
    id: string; name: string; hostname: string; os: string;
    addedAt: number; lastSeenAt?: number; elevated: boolean; online: boolean;
  }>>;
  unpairDevice?(deviceId: string): Promise<{ name: string } | null>;
  renameDevice?(deviceId: string, name: string): Promise<{ name: string } | null>;
  listPcs(): Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number; connectorVersion?: number }>;
  /** Out-of-process implementations can fetch a fresh list; preferred when present. */
  listPcsAsync?(): Promise<Array<{ id: string; label: string; hostname: string; os: string; username: string; ip: string; connectedAt: number; connectorVersion?: number }>>;
  /** HTTP from the remote machine's own network position — its localhost, its
   *  LAN, its VPN. Optional so an older garrison still satisfies the interface. */
  fetchVia?(
    pcId: string,
    req: { url: string; method?: string; headers?: Record<string, string>; bodyBase64?: string; timeoutMs?: number },
  ): Promise<{ status: number; headers: Record<string, string>; dataBase64: string; size: number }>;
  /** Push this build's connector script to a paired device. */
  updateAgent?(pcId: string, scriptPath?: string): Promise<{ ok: boolean; from: number; to: number; reconnected: boolean; newPcId?: string; deviceId?: string; detail: string }>;
  /** The connector version this build ships, for "is that device current?". */
  availableConnectorVersion?(): Promise<number> | number;
  /** Serve a remote HTTP service on a local loopback port. */
  startForward?(pcId: string, target: string, localPort?: number): Promise<ForwardRow>;
  listForwards?(): Promise<ForwardRow[]> | ForwardRow[];
  stopForward?(id: string): Promise<boolean>;
  exec(pcId: string, command: string, timeoutMs?: number, shell?: "cmd" | "powershell"): Promise<{ output: string; exitCode?: number }>;
  screenshot(pcId: string): Promise<{ dataBase64: string }>;
  /** Drive the remote desktop (click/type/key/move/scroll/drag). Optional so an
   *  older daemon still satisfies the interface — the tool reports "update the
   *  daemon" instead of throwing. */
  input?(pcId: string, ev: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
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
    "generate_link", "list_pcs", "exec_on_pc", "control_pc", "screenshot_pc", "get_file", "put_file", "notify_pc",
    "pair_device", "list_devices", "unpair_device", "rename_device",
    "fetch_on_pc", "forward_http", "list_forwards", "stop_forward", "agent_status", "update_agent",
  ]).describe(
    "generate_link: mint a one-time connect link for someone else's PC (REQUIRES label). " +
    "list_pcs: what's connected right now. " +
    "exec_on_pc: run a shell command on a connected PC (REQUIRES pc_id + command; optional shell: 'cmd' [default] or 'powershell' for cmdlets). " +
    "control_pc: DRIVE the remote desktop — move/click/type/key/scroll/drag (REQUIRES pc_id + control). Use it with screenshot_pc to operate a GUI: read the screen, then click/type. This is how you get through installers, dialogs, anything not scriptable. " +
    "screenshot_pc: capture and SEE their screen (REQUIRES pc_id) — use it to verify a fix, read a dialog, or find where to click. " +
    "get_file: copy a file FROM their PC to yours (REQUIRES pc_id + remote_path). " +
    "put_file: copy a file FROM your machine TO theirs (REQUIRES pc_id + local_path + remote_path). " +
    "notify_pc: show a popup on their screen (REQUIRES pc_id + message). " +
    "pair_device: PERMANENTLY pair one of the OWNER'S OWN machines (REQUIRES label) — it reconnects at every boot and can run ADMIN commands. " +
    "list_devices: the owner's permanently paired machines and whether each is online right now. " +
    "unpair_device: revoke a paired machine (REQUIRES device_id) — its connector is told to stop. " +
    "rename_device: relabel a paired machine (REQUIRES device_id + label). " +
    "fetch_on_pc: make an HTTP request FROM that machine (REQUIRES pc_id + url) — this is how you reach a service bound to ITS localhost (a dashboard on 127.0.0.1:8090, an API behind its VPN). Use it to pull real data, real JSON, real HTML from a server you cannot route to. " +
    "forward_http: serve a remote HTTP service on a loopback port of THIS machine (REQUIRES pc_id + target, e.g. \"http://localhost:8090\") — returns a local URL you can open in the browser preview, so a UI can be edited here and rendered against the real backend there. " +
    "list_forwards / stop_forward: manage those (stop_forward REQUIRES forward_id). " +
    "agent_status: what connector version each paired machine runs and whether a newer one is available. " +
    "update_agent: push THIS build's connector to a paired machine (REQUIRES pc_id) so it gains the newest capabilities — the owner approves it, the device verifies the hash, keeps the old script, and rolls itself back if the new one fails to reconnect.",
  ),
  label: z.string().optional().describe("generate_link: short name for the PC, e.g. \"Sarah\" or \"Dave's laptop\" — shown when it connects."),
  pc_id: z.string().optional().describe(
    "the PC id from list_pcs (or from the connected notice). A pc_id belongs to one CONNECTION and changes " +
    "every time the machine reconnects — for a permanently paired device, pass its device id from list_devices " +
    "instead: that one never changes and is resolved to the live connection for you.",
  ),
  command: z.string().optional().describe("exec_on_pc: shell command to run on the remote PC."),
  shell: z.enum(["cmd", "powershell"]).optional().describe("exec_on_pc: which shell. 'cmd' (default) or 'powershell' to run cmdlets."),
  control: z.object({
    kind: z.enum(["move", "click", "drag", "scroll", "type", "key"]).describe("move/click/drag/scroll aim the mouse; type sends literal text; key sends SendKeys notation like {ENTER}, ^c, %{F4}."),
    x: z.number().int().optional().describe("click/move/drag: X pixel on the remote screen (from a screenshot_pc)."),
    y: z.number().int().optional().describe("click/move/drag: Y pixel."),
    x2: z.number().int().optional().describe("drag: destination X."),
    y2: z.number().int().optional().describe("drag: destination Y."),
    button: z.enum(["left", "right", "middle"]).optional().describe("click: mouse button, default left."),
    double: z.boolean().optional().describe("click: true for a double-click."),
    amount: z.number().int().optional().describe("scroll: wheel delta, +up / -down (120 = one notch)."),
    text: z.string().optional().describe("type: the literal text to type."),
    keys: z.string().optional().describe("key: SendKeys notation, e.g. {ENTER}, {TAB}, ^c (Ctrl+C), %{F4} (Alt+F4)."),
  }).optional().describe("control_pc: one input event to send to the remote desktop."),
  device_id: z.string().optional().describe("unpair_device / rename_device: the device id from list_devices."),
  timeout_ms: z.number().int().min(1000).max(120_000).optional().describe("exec_on_pc: max wait in ms. Default 30000."),
  remote_path: z.string().optional().describe("get_file / put_file: the absolute path ON THE REMOTE PC to read from or write to."),
  local_path: z.string().optional().describe("put_file: the file on YOUR machine to send (absolute or workspace-relative). get_file: optional destination on your machine; defaults to a downloads folder in the workspace."),
  message: z.string().optional().describe("notify_pc: short text for the popup, e.g. \"Fixed — restart when you can\"."),
  url: z.string().optional().describe("fetch_on_pc: the URL to request FROM the remote machine, e.g. http://localhost:8090/api/overview."),
  method: z.string().optional().describe("fetch_on_pc: HTTP method. Default GET."),
  headers: z.record(z.string()).optional().describe("fetch_on_pc: request headers, e.g. { \"Cookie\": \"mkey=…\" }."),
  body: z.string().optional().describe("fetch_on_pc: request body as text (JSON, form data). Sent as UTF-8."),
  target: z.string().optional().describe("forward_http: the origin ON THE REMOTE MACHINE to serve locally, e.g. http://localhost:8090."),
  local_port: z.number().int().min(1024).max(65535).optional().describe("forward_http: loopback port to listen on here. Default: any free port."),
  forward_id: z.string().optional().describe("stop_forward: the forward id from forward_http or list_forwards."),
  script_path: z.string().optional().describe("update_agent: push a connector script YOU rendered (an absolute .ps1 path) instead of the one this build ships — how you give a paired machine a new capability without waiting for a release. Omit to push the built-in one."),
}).superRefine((v, ctx) => {
  const need = (field: "label" | "pc_id" | "command" | "message" | "remote_path" | "local_path" | "device_id" | "url" | "target" | "forward_id") => {
    if (!v[field]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${v.action} requires ${field}` });
  };
  if (v.action === "generate_link") need("label");
  if (v.action === "exec_on_pc") { need("pc_id"); need("command"); }
  if (v.action === "control_pc") {
    need("pc_id");
    if (!v.control) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["control"], message: "control_pc requires control" });
  }
  if (v.action === "screenshot_pc") need("pc_id");
  if (v.action === "get_file") { need("pc_id"); need("remote_path"); }
  if (v.action === "put_file") { need("pc_id"); need("local_path"); need("remote_path"); }
  if (v.action === "notify_pc") { need("pc_id"); need("message"); }
  if (v.action === "pair_device") need("label");
  if (v.action === "unpair_device") need("device_id");
  if (v.action === "rename_device") { need("device_id"); need("label"); }
  if (v.action === "fetch_on_pc") { need("pc_id"); need("url"); }
  if (v.action === "forward_http") { need("pc_id"); need("target"); }
  if (v.action === "stop_forward") need("forward_id");
  if (v.action === "update_agent") need("pc_id");
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
  /** fetch_on_pc */
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  /** forward_http / list_forwards */
  forward?: ForwardRow;
  forwards?: ForwardRow[];
  localUrl?: string;
  /** agent_status / update_agent */
  connectorVersion?: number;
  availableVersion?: number;
  agents?: Array<{ pcId: string; label: string; version: number; updateAvailable: boolean }>;
  updated?: { from: number; to: number; reconnected: boolean; newPcId?: string };
  error?: string;
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
    "Use exec_on_pc to run shell commands — match syntax to that PC's OS (list_pcs reports it): Windows defaults to cmd.exe (dir, type, findstr, %VAR%, backslashes) — pass shell:'powershell' to run cmdlets instead; macOS/Linux go through sh (ls, cat, grep, $VAR). Prefer scripting a task over clicking it. " +
    "Use control_pc when there is NO scriptable way — a GUI installer, a dialog, an app with no CLI. The loop is: screenshot_pc to see the screen and find the target, then control_pc to move/click/type there, then screenshot_pc again to confirm. Coordinates are pixels from the screenshot. This is how you finish things exec can't touch. " +
    "Use screenshot_pc to SEE their screen — read an error dialog, verify a fix, or find where to click. " +
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
  // Self-capping, so no outer watchdog. Every path here already carries its
  // own deadline — the server's request() timer, the client's
  // AbortSignal.timeout, exec's timeout_ms — and the external-state DEFAULT is
  // 20s, which is shorter than the things this tool legitimately does: a 30s
  // exec (the documented default!), a 120s fetch, a file transfer, and an
  // update that waits for a machine to restart and reattach. Every one of
  // those was being severed at 20s with the work still running on the remote
  // machine, which reads as "the remote is flaky" and is really us hanging up.
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => {
    switch (i.action) {
      case "generate_link": return `generating remote connect link for ${i.label}`;
      case "list_pcs": return "listing connected remote PCs";
      case "exec_on_pc": return `executing on remote PC ${i.pc_id}${i.shell === "powershell" ? " (powershell)" : ""}: ${(i.command ?? "").slice(0, 60)}`;
      case "control_pc": return `${i.control?.kind ?? "input"} on remote PC ${i.pc_id}${i.control?.kind === "type" ? `: ${(i.control?.text ?? "").slice(0, 40)}` : i.control?.x != null ? ` @${i.control.x},${i.control.y}` : ""}`;
      case "pair_device": return `creating a permanent pairing link for ${i.label}`;
      case "list_devices": return "listing permanently paired devices";
      case "unpair_device": return `unpairing device ${i.device_id}`;
      case "rename_device": return `renaming device ${i.device_id} to ${i.label}`;
      case "screenshot_pc": return `capturing screen of remote PC ${i.pc_id}`;
      case "get_file": return `pulling ${i.remote_path} from remote PC ${i.pc_id}`;
      case "put_file": return `sending ${i.local_path} to remote PC ${i.pc_id}`;
      case "notify_pc": return `notifying remote PC ${i.pc_id}: ${(i.message ?? "").slice(0, 60)}`;
      case "fetch_on_pc": return `${(i.method ?? "GET").toUpperCase()} ${(i.url ?? "").slice(0, 80)} from remote PC ${i.pc_id}`;
      case "forward_http": return `forwarding ${i.target} on remote PC ${i.pc_id} to a local port`;
      case "list_forwards": return "listing remote HTTP forwards";
      case "stop_forward": return `closing remote forward ${i.forward_id}`;
      case "agent_status": return "checking remote connector versions";
      case "update_agent": return `pushing ${i.script_path ? "a freshly written" : "the current"} Ares connector to remote PC ${i.pc_id}`;
    }
  },
  // update_agent REPLACES the script that gives Ares access to that machine.
  // Everything else here acts through the connector; this one acts ON it, so
  // it asks in every mode — including bypass, where the owner has otherwise
  // said "stop asking". The owner wanted exactly this shape: Ares proposes the
  // update, they approve the push.
  async checkPermissions(i, ctx): Promise<PermissionDecision> {
    if (i.action !== "update_agent") {
      // Mirror the default external-state gate for every other action, so this
      // override changes nothing but the one case it exists for.
      if (ctx.permissionMode === "plan") return { kind: "deny", reason: "RemotePC is disabled in plan mode." };
      if (ctx.permissionMode === "bypass") return { kind: "allow" };
      return { kind: "ask", prompt: "RemotePC wants to perform a external-state action.", suggestion: "allow_once" };
    }
    if (ctx.permissionMode === "plan") return { kind: "deny", reason: "RemotePC is disabled in plan mode." };
    return {
      kind: "ask",
      prompt: `Ares wants to replace the Ares Remote connector on ${i.pc_id} with ${i.script_path ? `a connector it wrote itself (${i.script_path})` : "the version this build ships"}. The device verifies the download, keeps the old script, and rolls itself back if the new one fails to reconnect.`,
      suggestion: "allow_once",
    };
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
        let devices;
        // Async when the implementation offers it: the sync path is a cache
        // that is empty until its first refresh returns, and reporting that as
        // ok/[] told a chat its paired laptop had never existed.
        try { devices = _server.listDevicesAsync ? await _server.listDevicesAsync() : _server.listDevices(); }
        catch (err) { return fail("list_devices", err); }
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
          const result = await _server.exec(i.pc_id!, i.command!, i.timeout_ms, i.shell);
          return {
            output: { action: "exec_on_pc", ok: true, output: result.output, exitCode: result.exitCode },
            display: result.output || `(exit ${result.exitCode ?? 0})`,
          };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "exec_on_pc", ok: false, note }, display: `Error: ${note}` };
        }
      }

      case "control_pc": {
        if (!_server.input) {
          return fail("control_pc", new Error("this Ares build can't drive the remote desktop — update the daemon"));
        }
        try {
          const r = await _server.input(i.pc_id!, i.control as Record<string, unknown>);
          if (!r.ok) return { output: { action: "control_pc", ok: false, note: r.error }, display: `Input failed: ${r.error ?? "unknown"}` };
          const k = i.control!.kind;
          return {
            output: { action: "control_pc", ok: true },
            display: `✓ ${k}${k === "type" ? ` "${(i.control!.text ?? "").slice(0, 40)}"` : i.control!.x != null ? ` at ${i.control!.x},${i.control!.y}` : ""} sent`,
          };
        } catch (err) {
          const note = err instanceof Error ? err.message : String(err);
          return { output: { action: "control_pc", ok: false, note }, display: `Error: ${note}` };
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

      case "fetch_on_pc": {
        if (!_server.fetchVia) return fail("fetch_on_pc", new Error("This garrison is too old for fetch_on_pc — restart Ares to pick up the new build."));
        try {
          const r = await _server.fetchVia(i.pc_id!, {
            url: i.url!,
            method: i.method ?? "GET",
            ...(i.headers ? { headers: i.headers } : {}),
            ...(i.body ? { bodyBase64: Buffer.from(i.body, "utf8").toString("base64") } : {}),
            ...(i.timeout_ms ? { timeoutMs: i.timeout_ms } : {}),
          });
          const raw = Buffer.from(r.dataBase64, "base64");
          const type = r.headers["Content-Type"] ?? r.headers["content-type"] ?? "";
          const textual = !type || /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.*\+json)/i.test(type);
          // A response body is for reading, not for carrying a disk image
          // through the context window.
          const LIMIT = 200_000;
          const truncated = raw.length > LIMIT;
          const body = textual ? raw.subarray(0, LIMIT).toString("utf8") : `<${raw.length} bytes of ${type || "binary"}>`;
          const head = `${r.status} ${type || "no content-type"} · ${raw.length} bytes from ${i.pc_id}`;
          return {
            output: {
              action: "fetch_on_pc", ok: r.status > 0 && r.status < 400,
              status: r.status, headers: r.headers, body, bytes: raw.length,
              ...(truncated ? { truncated: true } : {}),
            },
            display: `${head}\n\n${body}${truncated ? `\n\n… truncated at ${LIMIT} bytes.` : ""}`,
          };
        } catch (err) { return fail("fetch_on_pc", err); }
      }

      case "forward_http": {
        if (!_server.startForward) return fail("forward_http", new Error("This garrison is too old for forward_http — restart Ares to pick up the new build."));
        try {
          const f = await _server.startForward(i.pc_id!, i.target!, i.local_port);
          return {
            output: { action: "forward_http", ok: true, forward: f, localUrl: f.localUrl },
            display:
              `${f.localUrl} now serves ${f.target} from ${i.pc_id}.\n` +
              `Open it in the browser preview — it is the real remote service, with real data. ` +
              `Loopback only, and it lasts until stop_forward (id ${f.id}) or Ares restarts.`,
          };
        } catch (err) { return fail("forward_http", err); }
      }

      case "list_forwards": {
        if (!_server.listForwards) return fail("list_forwards", new Error("This garrison is too old for forwards — restart Ares."));
        try {
          const forwards = await Promise.resolve(_server.listForwards());
          return {
            output: { action: "list_forwards", ok: true, forwards },
            display: forwards.length
              ? forwards.map((f) => `${f.localUrl} → ${f.target} (${f.pcId}) · ${f.requests} requests · id ${f.id}`).join("\n")
              : "No remote HTTP forwards are open.",
          };
        } catch (err) { return fail("list_forwards", err); }
      }

      case "stop_forward": {
        if (!_server.stopForward) return fail("stop_forward", new Error("This garrison is too old for forwards — restart Ares."));
        try {
          const ok = await _server.stopForward(i.forward_id!);
          return {
            output: { action: "stop_forward", ok },
            display: ok ? `Forward ${i.forward_id} closed.` : `No forward with id ${i.forward_id}.`,
          };
        } catch (err) { return fail("stop_forward", err); }
      }

      case "agent_status": {
        try {
          const pcs = _server.listPcsAsync ? await _server.listPcsAsync() : _server.listPcs();
          const available = _server.availableConnectorVersion ? await Promise.resolve(_server.availableConnectorVersion()) : 1;
          const agents = pcs.map((p) => ({
            pcId: p.id,
            label: p.label,
            version: p.connectorVersion ?? 1,
            updateAvailable: (p.connectorVersion ?? 1) < available,
          }));
          const stale = agents.filter((a) => a.updateAvailable);
          return {
            output: { action: "agent_status", ok: true, agents, availableVersion: available },
            display: agents.length
              ? agents.map((a) => `${a.label} (${a.pcId}) — connector v${a.version}${a.updateAvailable ? ` → v${available} available` : " (current)"}`).join("\n") +
                (stale.length ? `\n\n${stale.length} machine${stale.length > 1 ? "s" : ""} can be updated with update_agent (the owner approves the push).` : "")
              : "No machines connected right now.",
          };
        } catch (err) { return fail("agent_status", err); }
      }

      case "update_agent": {
        if (!_server.updateAgent) return fail("update_agent", new Error("This garrison is too old to push connector updates — restart Ares to pick up the new build."));
        try {
          const r = await _server.updateAgent(i.pc_id!, i.script_path);
          return {
            output: {
              action: "update_agent", ok: r.ok,
              connectorVersion: r.to, availableVersion: r.to,
              updated: {
                from: r.from, to: r.to, reconnected: r.reconnected,
                ...(r.newPcId ? { newPcId: r.newPcId } : {}),
                ...(r.deviceId ? { deviceId: r.deviceId } : {}),
              },
              note: r.detail,
            },
            display: r.ok
              ? `✅ ${r.detail}.${r.deviceId ? ` Use device id ${r.deviceId} from here on — it survives every reconnect.` : r.newPcId ? ` Its pc_id is now ${r.newPcId}.` : ""}`
              : `⚠️ ${r.detail}`,
          };
        } catch (err) { return fail("update_agent", err); }
      }
    }
  },
});
