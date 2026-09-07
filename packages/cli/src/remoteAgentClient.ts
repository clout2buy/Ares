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
import { DEFAULT_REMOTE_AGENT_PORT, type LinkScope, type RemotePcInfo, type ExecResult } from "./remoteAgentServer.js";

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

  exec(pcId: string, command: string, timeoutMs = 30_000): Promise<ExecResult> {
    return this.call("POST", "/api/exec", { pcId, command, timeoutMs }, timeoutMs + 10_000);
  }

  notify(pcId: string, message: string): void {
    void this.call("POST", "/api/notify", { pcId, message }).catch(() => {});
  }

  disconnect(pcId: string): void {
    void this.call("POST", "/api/disconnect", { pcId }).catch(() => {});
  }
}
