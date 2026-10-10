// Composition of the System surfaces for `garrison serve`: one place that turns
// the garrison's live objects (sessions, scheduler, push, tunnel, connectors,
// instances) into the dependency shapes the snapshot, housekeeping, alerts and
// backup modules want, so garrisonCmd.ts only gains a handful of lines.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnEvent } from "@ares/protocol";
import { AlertEngine, type Signals } from "./systemAlerts.js";
import { backupDue, backupRoot, readBackupStatus, runBackup, type BackupResult } from "./systemBackup.js";
import { countStrayProcesses, Housekeeping, housekeepingEnabled, type HousekeepingReport } from "./systemHousekeeping.js";
import { healthFromFile, readHealthFile } from "./connectorHealth.js";
import { createSystemApi } from "./phoneSystem.js";
import { ErrorRing, LoopMonitor, ProviderHealth, scrubErrorText } from "./systemSignals.js";
import { createSystemService, type SystemService } from "./systemSnapshot.js";

// ─── Signals fed by the session event tap ───────────────────────────────

/** Error codes that say nothing about the provider's health. */
const NOT_PROVIDER_FAULT = new Set(["loop_detected", "max_turns_exceeded", "no_message_done"]);

export interface SystemSignals {
  errors: ErrorRing;
  providers: ProviderHealth;
  loop: LoopMonitor;
  /** Pass as SessionManagerOptions.onEvent. */
  onEvent: (info: { sessionId: string; provider: string; event: TurnEvent }) => void;
}

export function createSystemSignals(): SystemSignals {
  const errors = new ErrorRing();
  const providers = new ProviderHealth();
  const loop = new LoopMonitor();
  loop.start();
  return {
    errors,
    providers,
    loop,
    onEvent({ provider, event }) {
      if (event.type === "error") {
        errors.record(provider || "session", event.error.message);
        if (!NOT_PROVIDER_FAULT.has(event.error.code)) providers.fail(provider, event.error.message);
      } else if (event.type === "tool_error") {
        // Tool failures are routine; keep them out of the ring unless they are the interesting kind (a crash, not a refusal).
        if (/ECONN|EPIPE|ENOSPC|EACCES|out of memory|timed out/i.test(event.error)) errors.record("tool", event.error);
      } else if (event.type === "turn_end" && (event.status === "completed" || event.status === "needs_verification")) {
        providers.ok(provider);
      }
    },
  };
}

// ─── Version ────────────────────────────────────────────────────────────

let versionCache: { version?: string; sha?: string } | undefined;

export async function readVersion(): Promise<{ version?: string; sha?: string }> {
  if (versionCache) return versionCache;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  let version: string | undefined;
  let root: string | undefined;
  for (let i = 0; i < 8; i++) {
    try {
      await fs.access(path.join(dir, "pnpm-workspace.yaml"));
      root = dir;
      version = (JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as { version?: string }).version;
      break;
    } catch {
      dir = path.dirname(dir);
    }
  }
  const sha = root
    ? await new Promise<string | undefined>((resolve) => {
        execFile("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, timeout: 3_000 }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined));
      })
    : undefined;
  versionCache = { ...(version ? { version } : {}), ...(sha ? { sha } : {}) };
  return versionCache;
}

// ─── Boots + one-shot signals ───────────────────────────────────────────

export async function recordBoot(home: string, now = Date.now()): Promise<number> {
  const file = path.join(home, "system", "boots.json");
  let boots: number[] = [];
  try {
    boots = (JSON.parse(await fs.readFile(file, "utf8")) as number[]).filter((n) => Number.isFinite(n));
  } catch {
    // first boot
  }
  boots = [...boots, now].slice(-20);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(boots) + "\n", "utf8");
  } catch {
    // best effort
  }
  return boots.filter((t) => now - t <= 30 * 60_000).length;
}

export async function readSignals(home: string, now = Date.now()): Promise<Signals> {
  const out: Signals = {};
  try {
    const boots = JSON.parse(await fs.readFile(path.join(home, "system", "boots.json"), "utf8")) as number[];
    out.recentBoots = boots.filter((t) => now - t <= 30 * 60_000).length;
  } catch {
    // none recorded
  }
  try {
    const dir = path.join(home, "crashes");
    let n = 0;
    for (const name of await fs.readdir(dir)) {
      const st = await fs.stat(path.join(dir, name)).catch(() => null);
      if (st && now - st.mtimeMs <= 3_600_000) n += 1;
    }
    out.recentCrashes = n;
  } catch {
    // no crashes dir
  }
  try {
    // Dropped by the deploy gate (see docs/OPS-HEALTH.md): {"at": ISO, "reason": "..."}.
    const marker = JSON.parse(await fs.readFile(path.join(home, "system", "signals", "deploy-rolled-back.json"), "utf8")) as { at?: string; reason?: string };
    const at = marker.at ? Date.parse(marker.at) : NaN;
    if (Number.isFinite(at) && now - at <= 24 * 3_600_000) out.deployRolledBack = { id: String(at), ...(marker.reason ? { reason: marker.reason } : {}) };
  } catch {
    // no rollback recorded
  }
  return out;
}

// ─── The surfaces ───────────────────────────────────────────────────────

export interface SystemSurfacesOptions {
  home: string;
  workspace: string;
  signals: SystemSignals;
  sessions: {
    list(): Array<{ id: string; busy: boolean }>;
    runningTurns(): Array<{ sessionId: string; title: string; startedAt: string; currentTool?: string; waitingForResume?: boolean }>;
    pendingPermissionList(): unknown[];
    interrupt(sessionId: string): boolean;
  };
  scheduler: () => { jobStatus(): Array<{ name: string; schedule: string; enabled: boolean; paused: boolean; running: boolean; nextRunAt?: string; lastRunAt?: string; lastResult?: string }> } | undefined;
  approvalsPending: () => number;
  push: () => { configured: boolean; send(m: { title: string; body: string; collapseId?: string; data?: Record<string, unknown> }): Promise<unknown>; list(): Promise<Array<{ lastError?: string }>> } | undefined;
  tunnel: () => { linkScope(): "public" | "lan"; linkBaseUrl(): string } | null | undefined;
  connectors: () => Promise<Record<string, { state: string; detail: string; stale: boolean }>>;
  instances?: () => Promise<{ supported: boolean; items: Array<{ name: string; state: string; healthy: boolean }> }>;
  /** Core's checkpoint GC. */
  gcCheckpoints?: (workspace: string) => Promise<void>;
  /** The live session kernel for `workspace`: WAL folds and consistent backups. */
  kernel?: { maintainWal(mode: "PASSIVE" | "TRUNCATE"): { busy: number; log: number; checkpointed: number } | null; backupTo(dest: string): void };
  activeTurns: () => number;
  /** The antihang slice's /gateway/health/deep, when present. */
  deep?: () => unknown | Promise<unknown>;
  maintainer?: () => unknown | Promise<unknown>;
  log: (line: string) => void;
}

export interface SystemSurfaces {
  api: ReturnType<typeof createSystemApi>;
  service: SystemService;
  housekeeping: Housekeeping;
  alerts: AlertEngine;
  /** The scheduler's `housekeeping` hook: housekeeping, then tonight's backup if due. Returns a one-line result. */
  tick: () => Promise<string>;
  start(): void;
  stop(): void;
}

export function startSystemSurfaces(o: SystemSurfacesOptions): SystemSurfaces {
  const workspaces = new Set<string>([path.resolve(o.workspace)]);
  // Ares home is <something>/.ares: that something is a workspace too (Rook keeps ~/.ares/checkpoints there).
  if (path.basename(o.home) === ".ares") workspaces.add(path.dirname(path.resolve(o.home)));
  for (const w of (process.env.ARES_HOUSEKEEPING_WORKSPACES ?? "").split(path.delimiter).filter(Boolean)) workspaces.add(path.resolve(w));
  const workspaceList = [...workspaces];

  const housekeeping = new Housekeeping({
    home: o.home,
    workspaces: workspaceList,
    activeTurns: o.activeTurns,
    ...(o.gcCheckpoints ? { gcCheckpoints: o.gcCheckpoints } : {}),
    ...(o.kernel ? { maintainWal: (mode: "PASSIVE" | "TRUNCATE") => o.kernel!.maintainWal(mode) } : {}),
    log: o.log,
  });

  const alerts = new AlertEngine({
    home: o.home,
    push: (m) => (o.push()?.configured ? o.push()!.send(m) : Promise.reject(new Error("push is not configured"))),
    pushReady: () => o.push()?.configured === true,
    log: o.log,
  });

  const root = backupRoot();
  let backupRunning = false;
  const doBackup = async (): Promise<BackupResult> => {
    if (backupRunning) return { ok: false, pruned: [], error: "a backup is already running" };
    backupRunning = true;
    try {
      const result = await runBackup({
        home: o.home,
        workspaces: workspaceList,
        root,
        log: o.log,
        // The live kernel (the one holding the garrison's workspace) is copied through SQLite itself.
        snapshotKernel: async (ws, dest) => {
          if (!o.kernel || path.resolve(ws) !== path.resolve(o.workspace)) return false;
          o.kernel.backupTo(dest);
          return true;
        },
      });
      await alerts.record({
        kind: result.ok ? "backup_ok" : "backup_failed",
        title: result.ok ? `Backup complete (${result.entries} files, ${((result.size ?? 0) / 1_048_576).toFixed(1)} MB)` : "Backup failed",
        ...(result.error ? { body: scrubErrorText(result.error, 160) } : {}),
      });
      // A failure should reach the phone now, not at the next 60 s evaluation.
      if (!result.ok) await alerts.evaluate(await service.snapshot({ fresh: true }), await readSignals(o.home)).catch(() => []);
      return result;
    } finally {
      backupRunning = false;
    }
  };

  const service = createSystemService({
    home: o.home,
    workspaces: workspaceList,
    version: () => {
      // Sync shape for the collector: the cache is warmed in start().
      return versionCache ?? {};
    },
    sessions: o.sessions,
    approvalsPending: o.approvalsPending,
    providers: () => o.signals.providers.states(),
    loop: () => o.signals.loop.read(),
    connectors: o.connectors,
    scheduler: () => o.scheduler()?.jobStatus() ?? [],
    push: async () => {
      const p = o.push();
      if (!p) return { configured: false, devices: 0 };
      const devices = await p.list().catch(() => []);
      const lastError = devices.find((d) => d.lastError)?.lastError;
      return { configured: p.configured, devices: devices.length, ...(lastError ? { lastError: scrubErrorText(lastError, 120) } : {}) };
    },
    tunnel: () => {
      const t = o.tunnel();
      return t ? { scope: t.linkScope(), url: t.linkBaseUrl() } : { scope: "unknown" as const };
    },
    ...(o.instances ? { instances: o.instances } : {}),
    processes: () => countStrayProcesses(o.home),
    errors: () => o.signals.errors.recent(10),
    housekeeping: () => housekeeping.summary(),
    backup: () => readBackupStatus(root),
    ...(o.maintainer ? { maintainer: o.maintainer } : {}),
    ...(o.deep ? { deep: o.deep } : {}),
  });

  const api = createSystemApi({
    service,
    alerts,
    housekeeping,
    runBackup: doBackup,
    backupStatus: () => readBackupStatus(root),
    stopTurn: (id) => {
      try {
        return o.sessions.interrupt(id);
      } catch {
        return false;
      }
    },
    log: o.log,
  });

  const tick = async (): Promise<string> => {
    if (!housekeepingEnabled()) return "idle: ARES_HOUSEKEEPING=0";
    const parts: string[] = [];
    let report: HousekeepingReport | undefined;
    try {
      report = await housekeeping.run();
      parts.push(report.totals.acted > 0 ? `cleaned ${report.totals.acted} items, ${(report.totals.bytes / 1_048_576).toFixed(0)} MB` : "idle");
      if (report.totals.acted > 0) {
        await alerts.record({ kind: "housekeeping", title: `Housekeeping freed ${(report.totals.bytes / 1_048_576).toFixed(0)} MB`, body: `${report.totals.acted} items cleaned` });
      }
    } catch (err) {
      parts.push(`housekeeping skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      // Opt-in (ARES_BACKUP=1): up to 1 GB a night, 11 kept, in the user's home - right for an
      // always-on box, a surprise on a desktop install.
      if (process.env.ARES_BACKUP === "1" && (await backupDue(root, Date.now(), Number(process.env.ARES_BACKUP_HOUR ?? 3)))) {
        const r = await doBackup();
        parts.push(r.ok ? "backup ok" : `backup FAILED: ${r.error}`);
      }
    } catch (err) {
      parts.push(`backup error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parts.join("; ");
  };

  let alertTimer: NodeJS.Timeout | undefined;
  let bootTimer: NodeJS.Timeout | undefined;
  return {
    api,
    service,
    housekeeping,
    alerts,
    tick,
    start() {
      void readVersion();
      service.warm();
      void recordBoot(o.home);
      void housekeeping.last();
      // Boot pass, once the box has settled: a machine that is only on for a day must not wait for the next hourly tick.
      bootTimer = setTimeout(() => void tick().catch(() => undefined), Number(process.env.ARES_HOUSEKEEPING_BOOT_DELAY_MS) || 90_000);
      bootTimer.unref?.();
      alertTimer = setInterval(() => {
        void (async () => {
          try {
            await alerts.evaluate(await service.snapshot(), await readSignals(o.home));
          } catch (err) {
            o.log(`system: alert evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }, 60_000);
      alertTimer.unref?.();
    },
    stop() {
      if (bootTimer) clearTimeout(bootTimer);
      if (alertTimer) clearInterval(alertTimer);
      o.signals.loop.stop();
    },
  };
}

// ─── Sources the garrison composes ──────────────────────────────────────

/** Connected MCP servers only (not the whole catalog): what the owner would have to fix. */
export function connectorsSource(home: string): () => Promise<Record<string, { state: string; detail: string; stale: boolean }>> {
  return async () => {
    const file = await readHealthFile(home);
    const out: Record<string, { state: string; detail: string; stale: boolean }> = {};
    for (const id of Object.keys(file.servers)) {
      const h = healthFromFile(file, id);
      out[id] = { state: h.state, detail: h.detail, stale: h.stale };
    }
    return out;
  };
}

interface InstancesLike {
  preflight(): Promise<unknown>;
  list(): Promise<Array<{ name: string }>>;
  status(name: string): Promise<{ name: string; active: string; healthy: boolean }>;
}

/** Instance states, cached 30 s: each status() shells out to docker/systemctl. */
export function instancesSource(box: InstancesLike, ttlMs = 30_000): () => Promise<{ supported: boolean; items: Array<{ name: string; state: string; healthy: boolean }> }> {
  let cache: { at: number; value: { supported: boolean; items: Array<{ name: string; state: string; healthy: boolean }> } } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    let value: { supported: boolean; items: Array<{ name: string; state: string; healthy: boolean }> };
    try {
      await box.preflight();
      const items: Array<{ name: string; state: string; healthy: boolean }> = [];
      for (const meta of await box.list()) {
        try {
          const s = await box.status(meta.name);
          items.push({ name: s.name, state: s.active === "active" ? (s.healthy ? "running" : "starting") : s.active === "failed" ? "failed" : "stopped", healthy: s.healthy });
        } catch {
          items.push({ name: meta.name, state: "failed", healthy: false });
        }
      }
      value = { supported: true, items };
    } catch {
      value = { supported: false, items: [] };
    }
    cache = { at: Date.now(), value };
    return value;
  };
}
