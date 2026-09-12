// RemoteAgentClient — the daemon-side handle on the garrison's RemoteAgentServer.
//
// Chats (desktop, TUI) run in the `daemon` process; the remote-PC server lives
// in `garrison serve`. The RemotePC tool takes a RemoteAgentServerLike, so this
// client satisfies it over the server's loopback control API, authenticated
// with the shared garrison token. Every call re-reads the token and probes
// lazily, so a garrison that comes up later is picked up without a restart.

import { readFile } from "node:fs/promises";
import { tokenPath } from "@ares/garrison";
import type { RemoteAgentServerLike } from "@ares/tools";
import {
  DEFAULT_REMOTE_AGENT_PORT,
  type ExecResult,
  type FileGetResult,
  type ForwardInfo,
  type LinkScope,
  type RemoteFetchResult,
  type RemotePcInfo,
} from "./remoteAgentServer.js";

/** A permanently paired device, as the control API reports it. */
export interface PairedDeviceRow {
  id: string;
  name: string;
  hostname: string;
  os: string;
  addedAt: number;
  lastSeenAt?: number;
  elevated: boolean;
  online: boolean;
}

export class RemoteAgentClient implements RemoteAgentServerLike {
  private readonly base: string;

  constructor(private readonly home: string, port = Number(process.env["ARES_REMOTE_AGENT_PORT"]) || DEFAULT_REMOTE_AGENT_PORT) {
    this.base = `http://127.0.0.1:${port}`;
  }

  private async call<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 45_000): Promise<T> {
    const token = await readFile(tokenPath(this.home), "utf8").then((t) => t.trim()).catch(() => "");
    if (!token) throw new Error("Remote PC server not running — start Ares Garrison (it starts with the app).");
    let res: Response;
    try {
      res = await fetch(`${this.base}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("Remote PC server not running — start Ares Garrison (it starts with the app).");
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof data["error"] === "string" ? data["error"] : `remote PC server error ${res.status}`);
    return data as T;
  }

  generateToken(label: string): Promise<{ token: string; url: string; scope: LinkScope }> {
    return this.call("POST", "/api/link", { label });
  }

  /** Permanent pairing link — distinct from the one-time help link. */
  generatePairingLink(label: string): Promise<{ token: string; url: string; scope: LinkScope; warning?: string }> {
    return this.call("POST", "/api/pair-link", { label });
  }

  /** Sync by interface (mirrors listPcs): cached snapshot, refreshed async. */
  listDevices(): PairedDeviceRow[] {
    void this.refreshDevices();
    return this.devicesCache;
  }

  private devicesCache: PairedDeviceRow[] = [];
  private async refreshDevices(): Promise<void> {
    try {
      const { devices } = await this.call<{ devices: PairedDeviceRow[] }>("GET", "/api/devices", undefined, 5_000);
      this.devicesCache = devices;
    } catch {
      this.devicesCache = [];
    }
  }

  /** Fresh list — the daemon prefers this when it can await. */
  async listDevicesAsync(): Promise<PairedDeviceRow[]> {
    await this.refreshDevices();
    return this.devicesCache;
  }

  async unpairDevice(deviceId: string): Promise<{ name: string } | null> {
    const res = await this.call<{ ok: boolean; name?: string }>("POST", "/api/unpair", { deviceId });
    return res.ok && res.name ? { name: res.name } : null;
  }

  /** Synchronous by interface; the tool reads it once per call, so this is a
   *  cached snapshot refreshed on every other call. */
  listPcs(): RemotePcInfo[] {
    void this.refreshPcs();
    return this.pcsCache;
  }

  private pcsCache: RemotePcInfo[] = [];
  private async refreshPcs(): Promise<void> {
    try {
      const { pcs } = await this.call<{ pcs: RemotePcInfo[] }>("GET", "/api/pcs", undefined, 5_000);
      this.pcsCache = pcs;
    } catch {
      this.pcsCache = [];
    }
  }

  /** Fresh list — the tool prefers this when it can await. */
  async listPcsAsync(): Promise<RemotePcInfo[]> {
    await this.refreshPcs();
    return this.pcsCache;
  }

  /** Fresh list plus the current link reachability (public tunnel vs LAN-only). */
  async listWithScope(): Promise<{ pcs: RemotePcInfo[]; scope: LinkScope }> {
    try {
      const { pcs, scope } = await this.call<{ pcs: RemotePcInfo[]; scope: LinkScope }>("GET", "/api/pcs", undefined, 5_000);
      this.pcsCache = pcs;
      return { pcs, scope: scope ?? "lan" };
    } catch {
      this.pcsCache = [];
      return { pcs: [], scope: "lan" };
    }
  }

  exec(pcId: string, command: string, timeoutMs = 30_000, shell?: "cmd" | "powershell"): Promise<ExecResult> {
    return this.call("POST", "/api/exec", { pcId, command, timeoutMs, ...(shell ? { shell } : {}) }, timeoutMs + 10_000);
  }

  /** Drive the remote desktop (click/type/key/move/scroll/drag). */
  input(pcId: string, ev: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    return this.call("POST", "/api/input", { pcId, ...ev }, 20_000);
  }

  screenshot(pcId: string): Promise<{ dataBase64: string }> {
    return this.call("POST", "/api/screenshot", { pcId }, 30_000);
  }

  readFile(pcId: string, path: string): Promise<FileGetResult> {
    return this.call("POST", "/api/readfile", { pcId, path }, 70_000);
  }

  writeFile(pcId: string, path: string, dataBase64: string): Promise<{ bytes: number }> {
    return this.call("POST", "/api/writefile", { pcId, path, dataBase64 }, 70_000);
  }

  /** HTTP performed from the remote machine's own network position. */
  fetchVia(
    pcId: string,
    req: { url: string; method?: string; headers?: Record<string, string>; bodyBase64?: string; timeoutMs?: number },
  ): Promise<RemoteFetchResult> {
    const timeoutMs = req.timeoutMs ?? 30_000;
    return this.call("POST", "/api/fetch", { pcId, ...req, timeoutMs }, timeoutMs + 15_000);
  }

  /** Push this build's connector to a paired device (owner-approved). Slow by
   *  nature: the device swaps its script, restarts and re-attaches. */
  updateAgent(pcId: string, scriptPath?: string): Promise<{ ok: boolean; from: number; to: number; reconnected: boolean; newPcId?: string; detail: string }> {
    return this.call("POST", "/api/update-agent", { pcId, ...(scriptPath ? { scriptPath } : {}) }, 200_000);
  }

  /** The connector version this build of Ares ships. */
  async availableConnectorVersion(): Promise<number> {
    const r = await this.call<{ available?: number }>("GET", "/api/agent-version", undefined, 5_000);
    return typeof r.available === "number" ? r.available : 1;
  }

  startForward(pcId: string, target: string, localPort?: number): Promise<ForwardInfo> {
    return this.call("POST", "/api/forward", { pcId, target, ...(localPort ? { localPort } : {}) }, 30_000);
  }

  async listForwards(): Promise<ForwardInfo[]> {
    const r = await this.call<{ forwards?: ForwardInfo[] }>("GET", "/api/forwards", undefined, 5_000);
    return r.forwards ?? [];
  }

  async stopForward(id: string): Promise<boolean> {
    const r = await this.call<{ ok?: boolean }>("POST", "/api/forward-stop", { id }, 15_000);
    return r.ok === true;
  }

  notify(pcId: string, message: string): void {
    void this.call("POST", "/api/notify", { pcId, message }).catch(() => {});
  }

  disconnect(pcId: string): void {
    void this.call("POST", "/api/disconnect", { pcId }).catch(() => {});
  }
}
