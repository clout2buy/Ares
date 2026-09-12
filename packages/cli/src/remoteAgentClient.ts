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

/** Every errno buried in a fetch rejection — undici nests, and sometimes
 *  aggregates (one per address family), so the code is rarely at the top. */
function errnoCodes(err: unknown, depth = 0): string[] {
  if (!err || typeof err !== "object" || depth > 4) return [];
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  const out: string[] = [];
  if (typeof e.code === "string") out.push(e.code);
  if (Array.isArray(e.errors)) for (const sub of e.errors) out.push(...errnoCodes(sub, depth + 1));
  out.push(...errnoCodes(e.cause, depth + 1));
  return out;
}

/** Turn a fetch rejection into the sentence that actually describes it. */
function describeCallFailure(err: unknown, base: string, route: string, timeoutMs: number): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return (
      `The Ares Garrison did not answer ${route} within ${Math.round(timeoutMs / 1000)}s. ` +
      `It is listening but busy or wedged — this is NOT "no devices paired"; retry, or restart the garrison if it persists.`
    );
  }
  const codes = errnoCodes(err);
  // A mid-flight drop is the one worth distinguishing from absence: the
  // garrison was there a moment ago, so the answer is "retry", not "start it".
  const dropped = ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"];
  if (codes.some((c) => dropped.includes(c))) {
    return `Lost the connection to the Ares Garrison at ${base} (${codes[0]}) — it may have just restarted. Retry.`;
  }
  // Anything else that failed to connect over loopback means nobody accepted.
  const why = codes[0] ?? e?.message ?? String(err);
  return `Remote PC server not running — start Ares Garrison (it starts with the app). [${base} unreachable: ${why}]`;
}

export class RemoteAgentClient implements RemoteAgentServerLike {
  private readonly base: string;

  constructor(private readonly home: string, port = Number(process.env["ARES_REMOTE_AGENT_PORT"]) || DEFAULT_REMOTE_AGENT_PORT) {
    this.base = `http://127.0.0.1:${port}`;
  }

  private async call<T>(method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 45_000): Promise<T> {
    const token = await readFile(tokenPath(this.home), "utf8").then((t) => t.trim()).catch(() => "");
    if (!token) {
      throw new Error(
        `Remote PC server not running — start Ares Garrison (it starts with the app). ` +
        `[no garrison token at ${tokenPath(this.home)}]`,
      );
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Three very different faults used to print one sentence: a garrison that
      // is genuinely absent, one that is up but slow, and one that dropped the
      // connection mid-call. Reading "start Ares Garrison" while it is running
      // sends everyone — owner and agent — down the wrong path, so name the
      // one that actually happened.
      throw new Error(describeCallFailure(err, this.base, route, timeoutMs));
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) {
      // Two Ares homes, two tokens. The daemon reads one and the garrison holds
      // the other, and every call 401s forever with no hint of why.
      throw new Error(
        `The Ares Garrison rejected this process's token (401). That means two different Ares homes: ` +
        `this process reads ${tokenPath(this.home)} while the running garrison holds another. ` +
        `Restart both from the same home, or set ARES_HOME to match.`,
      );
    }
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

  /**
   * Sync by interface (mirrors listPcs): last-known snapshot, refreshed async.
   *
   * Callers that can await MUST use listDevicesAsync. This one cannot tell
   * "nothing is paired" from "I have not asked yet", and a false empty here
   * reads as "that machine was never paired" — which is how a live, paired
   * laptop got declared nonexistent in the field.
   */
  listDevices(): PairedDeviceRow[] {
    void this.listDevicesAsync().catch(() => { /* keep the last-known list */ });
    return this.devicesCache;
  }

  private devicesCache: PairedDeviceRow[] = [];

  /** Fresh list, or a throw. Never an empty array standing in for a failure. */
  async listDevicesAsync(): Promise<PairedDeviceRow[]> {
    const { devices } = await this.call<{ devices: PairedDeviceRow[] }>("GET", "/api/devices", undefined, 10_000);
    this.devicesCache = devices;
    return devices;
  }

  async unpairDevice(deviceId: string): Promise<{ name: string } | null> {
    const res = await this.call<{ ok: boolean; name?: string }>("POST", "/api/unpair", { deviceId });
    return res.ok && res.name ? { name: res.name } : null;
  }

  /** Synchronous by interface; the tool reads it once per call, so this is a
   *  cached snapshot refreshed on every other call. */
  listPcs(): RemotePcInfo[] {
    void this.listPcsAsync().catch(() => { /* keep the last-known list */ });
    return this.pcsCache;
  }

  private pcsCache: RemotePcInfo[] = [];

  /** Fresh list, or a throw — the tool prefers this when it can await. */
  async listPcsAsync(): Promise<RemotePcInfo[]> {
    const { pcs } = await this.call<{ pcs: RemotePcInfo[] }>("GET", "/api/pcs", undefined, 10_000);
    this.pcsCache = pcs;
    return pcs;
  }

  /** Fresh list plus the current link reachability (public tunnel vs LAN-only). */
  async listWithScope(): Promise<{ pcs: RemotePcInfo[]; scope: LinkScope }> {
    const { pcs, scope } = await this.call<{ pcs: RemotePcInfo[]; scope: LinkScope }>("GET", "/api/pcs", undefined, 10_000);
    this.pcsCache = pcs;
    return { pcs, scope: scope ?? "lan" };
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
  updateAgent(pcId: string, scriptPath?: string): Promise<{ ok: boolean; from: number; to: number; reconnected: boolean; newPcId?: string; deviceId?: string; detail: string }> {
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
