// Connector health — the standing answer to "is it still not broken?".
//
// A light background check (daily, jittered, killable) that launches +
// handshakes ONLY the MCP servers the owner has connected and left enabled —
// never the whole catalog — and stores the outcome at
// <ARES_HOME>/telemetry/connectors-health.json. The phone's Connections screen
// reads it through the pure-read functions below (no spawning on read):
//
//   connectorHealth(id)      -> { state: green|amber|red|grey, verdict, reason, checkedAt, stale, detail }
//   connectorHealthAll()     -> every stored record
//   runConnectorHealthCheck  -> on demand (`ares connectors health --run`, or a
//                               "Check now" button): same code path as the timer
//
// A full `ares connectors doctor --record` also stores the catalog-level
// verdicts (under `services`) so an unconnected card can show "reachable".
//
// Kill switch: ARES_CONNECTOR_HEALTH=0. Cadence: ARES_CONNECTOR_HEALTH_HOURS
// (default 24). The timer is unref'd and never holds the process open.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { aresHome } from "@ares/core";
import type { McpServerConfig } from "@ares/tools";
import { probeConfiguredServer, type DoctorReport, type Verdict } from "./connectorsDoctor.js";

export type HealthState = "green" | "amber" | "red" | "grey";

export interface HealthRecord {
  id: string;
  kind: "mcp-connected" | "service";
  verdict: Verdict;
  reason: string;
  checkedAt: string;
  latencyMs?: number;
  toolCount?: number;
  /** Consecutive non-green checks (0 when the last one passed). */
  consecutiveFailures: number;
  lastOkAt?: string;
}

export interface HealthFile {
  schema: 1;
  updatedAt: string;
  lastRun?: { startedAt: string; finishedAt: string; checked: number; skipped: number; ms: number };
  servers: Record<string, HealthRecord>;
  services: Record<string, HealthRecord>;
}

export interface ConnectorHealth {
  id: string;
  state: HealthState;
  verdict?: Verdict;
  reason?: string;
  checkedAt?: string;
  stale: boolean;
  /** One short line for the phone: "Live: 14 tools, 420ms" / "Rejected the stored token — reconnect". */
  detail: string;
}

const DEFAULT_STALE_MS = 36 * 60 * 60_000;

export function healthFilePath(home?: string): string {
  return path.join(home ?? aresHome(), "telemetry", "connectors-health.json");
}

export function stateForVerdict(verdict: Verdict): HealthState {
  switch (verdict) {
    case "working":
    case "works-needs-credentials":
      return "green";
    case "degraded":
      return "amber";
    case "broken":
      return "red";
    default:
      return "grey";
  }
}

const EMPTY = (): HealthFile => ({ schema: 1, updatedAt: new Date(0).toISOString(), servers: {}, services: {} });

export async function readHealthFile(home?: string): Promise<HealthFile> {
  try {
    const raw = JSON.parse(await fs.readFile(healthFilePath(home), "utf8")) as Partial<HealthFile>;
    if (raw && raw.schema === 1) return { ...EMPTY(), ...raw, servers: raw.servers ?? {}, services: raw.services ?? {} } as HealthFile;
  } catch {
    // absent or unreadable: nothing recorded yet
  }
  return EMPTY();
}

async function writeHealthFile(file: HealthFile, home?: string): Promise<void> {
  const target = healthFilePath(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  await fs.rename(tmp, target);
}

function describe(rec: HealthRecord): string {
  const lat = rec.latencyMs !== undefined ? `${rec.latencyMs}ms` : "";
  switch (rec.verdict) {
    case "working":
      return rec.toolCount !== undefined ? `Live: ${rec.toolCount} tools${lat ? `, ${lat}` : ""}` : `Live${lat ? `, ${lat}` : ""}`;
    case "works-needs-credentials":
      return "Reachable; needs sign-in";
    case "degraded":
      return `Degraded: ${rec.reason.slice(0, 120)}`;
    case "broken":
      return `Broken: ${rec.reason.slice(0, 120)}`;
    default:
      return "Not verified";
  }
}

/** Pure read. Never spawns or touches the network. */
export async function connectorHealth(id: string, opts: { home?: string; now?: () => number; staleAfterMs?: number } = {}): Promise<ConnectorHealth> {
  const file = await readHealthFile(opts.home);
  return healthFromFile(file, id, opts);
}

export function healthFromFile(file: HealthFile, id: string, opts: { now?: () => number; staleAfterMs?: number } = {}): ConnectorHealth {
  const rec = file.servers[id] ?? file.services[id];
  if (!rec) return { id, state: "grey", stale: true, detail: "Not checked yet" };
  const age = (opts.now?.() ?? Date.now()) - Date.parse(rec.checkedAt);
  const stale = !Number.isFinite(age) || age > (opts.staleAfterMs ?? DEFAULT_STALE_MS);
  return { id, state: stateForVerdict(rec.verdict), verdict: rec.verdict, reason: rec.reason, checkedAt: rec.checkedAt, stale, detail: describe(rec) };
}

export async function connectorHealthAll(opts: { home?: string; now?: () => number } = {}): Promise<Record<string, ConnectorHealth>> {
  const file = await readHealthFile(opts.home);
  const out: Record<string, ConnectorHealth> = {};
  for (const id of new Set([...Object.keys(file.services), ...Object.keys(file.servers)])) out[id] = healthFromFile(file, id, opts);
  return out;
}

/** Store a full doctor run's catalog-level verdicts (`ares connectors doctor --record`). */
export async function recordDoctorReport(report: DoctorReport, home?: string): Promise<void> {
  const file = await readHealthFile(home);
  for (const r of report.results) {
    if (r.kind === "tool" || r.kind === "mcp-configured") continue;
    const id = r.id.replace(/^stdio:/, "");
    file.services[id] = toRecord(id, "service", r, file.services[id], report.generatedAt);
  }
  file.updatedAt = new Date().toISOString();
  await writeHealthFile(file, home);
}

function toRecord(id: string, kind: HealthRecord["kind"], r: { verdict: Verdict; reason: string; evidence?: { latencyMs?: number; toolCount?: number } }, prev: HealthRecord | undefined, at: string): HealthRecord {
  const ok = stateForVerdict(r.verdict) === "green";
  return {
    id,
    kind,
    verdict: r.verdict,
    reason: r.reason.slice(0, 300),
    checkedAt: at,
    ...(r.evidence?.latencyMs !== undefined ? { latencyMs: r.evidence.latencyMs } : {}),
    ...(r.evidence?.toolCount !== undefined ? { toolCount: r.evidence.toolCount } : {}),
    consecutiveFailures: ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    ...(ok ? { lastOkAt: at } : prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}),
  };
}

/** Enabled, connected MCP servers as configured on disk (mcp.json + mcp-remote.json). */
export async function loadConnectedServers(home?: string): Promise<Record<string, McpServerConfig>> {
  const dir = home ?? aresHome();
  const out: Record<string, McpServerConfig> = {};
  for (const name of ["mcp.json", "mcp-remote.json"]) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as { servers?: Record<string, McpServerConfig>; mcpServers?: Record<string, McpServerConfig> };
      for (const [id, cfg] of Object.entries(json.servers ?? json.mcpServers ?? {})) {
        if ((cfg as { enabled?: boolean }).enabled === false) continue;
        out[id] = cfg;
      }
    } catch {
      // absent or invalid
    }
  }
  return out;
}

export interface HealthRunOptions {
  home?: string;
  /** Only these server ids. */
  only?: string[];
  /** Ignore the min-age gate (on-demand / first run). */
  force?: boolean;
  /** Skip servers checked more recently than this (ms). Default 20h. */
  minAgeMs?: number;
  concurrency?: number;
  remoteTimeoutMs?: number;
  stdioTimeoutMs?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Called when a server's state flips (green -> red etc.). */
  onChange?: (id: string, from: HealthState, to: HealthState, rec: HealthRecord) => void;
}

/** Launch + handshake the connected, enabled servers that are due. */
export async function runConnectorHealthCheck(opts: HealthRunOptions = {}): Promise<HealthFile> {
  const now = opts.now ?? Date.now;
  const started = now();
  const file = await readHealthFile(opts.home);
  const servers = await loadConnectedServers(opts.home);
  const minAge = opts.minAgeMs ?? 20 * 60 * 60_000;
  const ids = Object.keys(servers).filter((id) => !opts.only || opts.only.includes(id));
  const due = ids.filter((id) => {
    if (opts.force || opts.only) return true;
    const prev = file.servers[id];
    return !prev || now() - Date.parse(prev.checkedAt) >= minAge;
  });
  // A server that is no longer connected must not keep a green dot forever.
  for (const id of Object.keys(file.servers)) if (!(id in servers)) delete file.servers[id];

  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ares-health-"));
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < due.length) {
        const id = due[next++]!;
        const cfg = servers[id]!;
        const scratch = await fs.mkdtemp(path.join(scratchRoot, "s-"));
        let res: Awaited<ReturnType<typeof probeConfiguredServer>>;
        try {
          const isRemote = typeof (cfg as { url?: unknown }).url === "string";
          res = await probeConfiguredServer(id, cfg, {
            home: opts.home,
            scratchDir: scratch,
            timeoutMs: isRemote ? (opts.remoteTimeoutMs ?? 30_000) : (opts.stdioTimeoutMs ?? 60_000),
            fetchImpl: opts.fetchImpl,
          });
        } catch (err) {
          res = { verdict: "broken", reason: `health check crashed: ${err instanceof Error ? err.message : String(err)}`, evidence: {}, latencyMs: 0 };
        } finally {
          await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        }
        const prev = file.servers[id];
        const rec = toRecord(id, "mcp-connected", { verdict: res.verdict, reason: res.reason, evidence: { latencyMs: res.latencyMs, toolCount: res.toolCount } }, prev, new Date(now()).toISOString());
        file.servers[id] = rec;
        const from = prev ? stateForVerdict(prev.verdict) : "grey";
        const to = stateForVerdict(rec.verdict);
        if (from !== to) {
          try { opts.onChange?.(id, from, to, rec); } catch { /* observers never break the check */ }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, due.length || 1)) }, worker));
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  const finished = now();
  file.updatedAt = new Date(finished).toISOString();
  file.lastRun = { startedAt: new Date(started).toISOString(), finishedAt: file.updatedAt, checked: due.length, skipped: ids.length - due.length, ms: finished - started };
  await writeHealthFile(file, opts.home);
  return file;
}

export interface HealthMonitorOptions extends HealthRunOptions {
  /** Cadence; default ARES_CONNECTOR_HEALTH_HOURS or 24h. */
  intervalMs?: number;
  /** +/- fraction of the interval; default 0.1. */
  jitter?: number;
  /** Delay before the first run; default 3-12 minutes (random). */
  initialDelayMs?: number;
  /** Return true to defer this tick (owner is mid-turn, paused...). */
  skipWhen?: () => boolean;
  log?: (line: string) => void;
  /** Test seams. */
  random?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

export function healthMonitorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ARES_CONNECTOR_HEALTH ?? "").trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false" || v === "no");
}

export interface HealthMonitor {
  stop(): void;
  /** Run now, regardless of the schedule (on-demand). */
  runNow(force?: boolean): Promise<HealthFile>;
  readonly running: boolean;
}

/** Start the daily check. Returns a no-op handle when the kill switch is on. */
export function startConnectorHealthMonitor(opts: HealthMonitorOptions = {}): HealthMonitor {
  let running = false;
  let stopped = false;
  let handle: unknown;
  const random = opts.random ?? Math.random;
  const setT = opts.setTimeoutFn ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const hours = Number(process.env.ARES_CONNECTOR_HEALTH_HOURS);
  const interval = opts.intervalMs ?? (Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 24 * 3_600_000);
  const jitter = opts.jitter ?? 0.1;

  const run = async (force: boolean): Promise<HealthFile> => {
    if (running) return readHealthFile(opts.home);
    running = true;
    try {
      return await runConnectorHealthCheck({ ...opts, force });
    } finally {
      running = false;
    }
  };
  const schedule = (ms: number): void => {
    if (stopped) return;
    handle = setT(() => {
      if (stopped) return;
      if (opts.skipWhen?.()) {
        schedule(10 * 60_000); // owner busy: look again shortly, don't pile on
        return;
      }
      void run(false)
        .catch((err) => opts.log?.(`connector health check failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => schedule(Math.round(interval * (1 + (random() * 2 - 1) * jitter))));
    }, ms);
  };

  if (!healthMonitorEnabled()) return { stop() {}, runNow: async () => readHealthFile(opts.home), running: false };
  schedule(opts.initialDelayMs ?? Math.round((3 + random() * 9) * 60_000));
  return {
    stop() {
      stopped = true;
      if (handle !== undefined) clearT(handle);
    },
    runNow: (force = true) => run(force),
    get running() {
      return running;
    },
  };
}
