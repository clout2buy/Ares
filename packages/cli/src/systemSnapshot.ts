// The System health snapshot: one read-only, cheap, cached answer to "is this
// box healthy?". Every collector is optional and isolated -- a failing or slow
// source becomes `sources[name] = "error"` and a hole in the JSON, never a
// failed request -- so the route works standalone on any garrison and fills in
// as more is wired. Nothing here mutates state.
//
// Cost model: the snapshot is memoised for CACHE_MS (5 s). The only expensive
// part, the directory-size walk, runs in the background at most once per
// DISK_SCAN_MS and the snapshot serves the last result.

import { promises as fs, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { scrubErrorText, type ErrorEntry, type LoopLag, type ProviderBreaker } from "./systemSignals.js";

export const CACHE_MS = 5_000;
export const DISK_SCAN_MS = 10 * 60_000;
const SOURCE_TIMEOUT_MS = 2_500;

export type Level = "ok" | "warn" | "critical";

export interface SystemProblem {
  id: string;
  level: "warn" | "critical";
  text: string;
}

export interface DiskDir {
  key: string;
  label: string;
  bytes: number;
  files?: number;
}

export interface TurnView {
  sessionId: string;
  title: string;
  startedAt: string;
  ageSec: number;
  currentTool?: string;
  waitingForResume?: boolean;
  /** Running longer than STUCK_TURN_MS: a candidate for the Stop button. */
  stuck: boolean;
}

export interface ConnectorProblem {
  id: string;
  state: "amber" | "red";
  detail: string;
  stale: boolean;
}

export interface SystemSnapshot {
  schema: 1;
  at: string;
  /** How long collecting took; 0 on a cache hit. */
  collectMs: number;
  status: Level;
  headline: string;
  problems: SystemProblem[];
  garrison: { pid: number; startedAt: string; uptimeSec: number; version?: string; sha?: string; node: string; platform: string; hostname: string };
  memory: { heapUsedMb: number; heapLimitMb: number; heapRatio: number; rssMb: number; systemTotalMb: number; systemFreeMb: number; systemRatio: number };
  loop: LoopLag;
  cpu: { load1: number; load5: number; cores: number; loadRatio: number };
  disk: { totalBytes: number; usedBytes: number; usedPct: number; dirs: DiskDir[]; scannedAt?: string; scanning?: boolean };
  sessions: { total: number; running: number; oldestRunningAgeSec?: number; queueDepth: number; pendingPermissions: number; pendingApprovals: number; turns: TurnView[] };
  providers: ProviderBreaker[];
  connectors: { total: number; green: number; amber: number; red: number; grey: number; problems: ConnectorProblem[] };
  scheduler: { jobs: Array<{ name: string; schedule: string; enabled: boolean; paused: boolean; running: boolean; nextRunAt?: string; lastRunAt?: string; lastResult?: string }> };
  push: { configured: boolean; devices: number; lastError?: string };
  tunnel: { scope: "public" | "lan" | "unknown"; url?: string };
  instances: { supported: boolean; total: number; running: number; failed: number; items: Array<{ name: string; state: string; healthy: boolean }> };
  processes: { zombies: number; orphans: number };
  errors: ErrorEntry[];
  housekeeping?: unknown;
  backup?: unknown;
  maintainer?: unknown;
  /** The antihang slice's /gateway/health/deep, when it is wired. Folded in verbatim. */
  deep?: unknown;
  /** Per collector: ok, error, or absent (not wired on this box). */
  sources: Record<string, "ok" | "error" | "absent">;
}

export interface SystemDeps {
  home: string;
  /** Directories that hold per-workspace state (<workspace>/.ares/...). */
  workspaces?: string[];
  version?: () => { version?: string; sha?: string };
  startedAt?: () => number;
  sessions?: {
    list(): Array<{ id: string; busy: boolean }>;
    runningTurns(): Array<{ sessionId: string; title: string; startedAt: string; currentTool?: string; waitingForResume?: boolean }>;
    pendingPermissionList(): unknown[];
  };
  queueDepth?: () => number;
  approvalsPending?: () => number;
  providers?: () => ProviderBreaker[];
  loop?: () => LoopLag;
  connectors?: () => Promise<Record<string, { state: string; detail: string; stale: boolean }>>;
  scheduler?: () => SystemSnapshot["scheduler"]["jobs"];
  push?: () => Promise<{ configured: boolean; devices: number; lastError?: string }> | { configured: boolean; devices: number; lastError?: string };
  tunnel?: () => { scope: "public" | "lan" | "unknown"; url?: string };
  instances?: () => Promise<{ supported: boolean; items: Array<{ name: string; state: string; healthy: boolean }> }>;
  processes?: () => Promise<{ zombies: number; orphans: number }> | { zombies: number; orphans: number };
  errors?: () => ErrorEntry[];
  housekeeping?: () => unknown;
  backup?: () => unknown;
  maintainer?: () => unknown | Promise<unknown>;
  deep?: () => unknown | Promise<unknown>;
  now?: () => number;
  /** Test seams. */
  statfs?: (p: string) => { total: number; free: number } | null;
  loadavg?: () => number[];
  stuckTurnMs?: number;
}

export const STUCK_TURN_MS = 10 * 60_000;

// ─── Disk walk ──────────────────────────────────────────────────────────

/** Size of everything under `root`, without following symlinks. Bounded so a
 *  pathological tree cannot pin the box: stops after `maxEntries`. */
export async function dirSize(root: string, maxEntries = 400_000): Promise<{ bytes: number; files: number; truncated: boolean }> {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    const stats: Array<Promise<void>> = [];
    for (const entry of entries) {
      if (++seen > maxEntries) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) subdirs.push(full);
      else if (entry.isFile()) {
        stats.push(
          fs.lstat(full).then(
            (s) => {
              bytes += s.size;
              files += 1;
            },
            () => undefined,
          ),
        );
        if (stats.length >= 64) await Promise.all(stats.splice(0));
      }
    }
    await Promise.all(stats);
    for (const sub of subdirs) {
      if (truncated) return;
      await walk(sub);
    }
  };
  await walk(root);
  return { bytes, files, truncated };
}

/** The named places the owner wants broken out. Pure path math. */
export function diskTargets(home: string, workspaces: string[]): Array<{ key: string; label: string; paths: string[] }> {
  const ws = (sub: string) => workspaces.map((w) => path.join(w, ".ares", sub));
  const wsFile = (name: string) => workspaces.map((w) => path.join(w, ".ares", name));
  return [
    { key: "home", label: "Ares home", paths: [home] },
    { key: "logs", label: "Logs and telemetry", paths: [path.join(home, "logs"), path.join(home, "telemetry"), path.join(home, "crashes"), ...ws("wire-log")] },
    { key: "sessions", label: "Sessions", paths: [path.join(home, "sessions"), path.join(home, "garrison", "sessions"), ...ws("sessions")] },
    { key: "blobs", label: "Checkpoint blobs", paths: [path.join(home, "checkpoints"), ...ws("checkpoints")] },
    { key: "wal", label: "Database WAL", paths: [...wsFile("session-kernel.sqlite-wal"), ...wsFile("session-kernel.sqlite-shm")] },
    { key: "worktrees", label: "Worktrees", paths: [path.join(home, "worktrees"), ...workspaces.map((w) => path.join(w, ".claude", "worktrees")), ...ws("worktrees")] },
  ];
}

async function pathSize(p: string): Promise<{ bytes: number; files: number }> {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) return { bytes: 0, files: 0 };
    if (st.isFile()) return { bytes: st.size, files: 1 };
    const { bytes, files } = await dirSize(p);
    return { bytes, files };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

// ─── Status derivation (pure) ───────────────────────────────────────────

export interface Thresholds {
  diskWarnPct: number;
  diskCriticalPct: number;
  heapWarn: number;
  heapCritical: number;
  loopWarnMs: number;
  loopCriticalMs: number;
  systemMemWarn: number;
}

export const THRESHOLDS: Thresholds = {
  diskWarnPct: 80,
  diskCriticalPct: 85,
  heapWarn: 0.72,
  heapCritical: 0.86,
  loopWarnMs: 250,
  loopCriticalMs: 1_000,
  systemMemWarn: 0.92,
};

export function deriveProblems(s: Omit<SystemSnapshot, "status" | "headline" | "problems">, t: Thresholds = THRESHOLDS): SystemProblem[] {
  const out: SystemProblem[] = [];
  const add = (id: string, level: "warn" | "critical", text: string) => out.push({ id, level, text });
  if (s.disk.totalBytes > 0) {
    if (s.disk.usedPct >= t.diskCriticalPct) add("disk", "critical", `Disk is ${s.disk.usedPct}% full`);
    else if (s.disk.usedPct >= t.diskWarnPct) add("disk", "warn", `Disk is ${s.disk.usedPct}% full`);
  }
  if (s.memory.heapRatio >= t.heapCritical) add("heap", "critical", `Heap at ${Math.round(s.memory.heapRatio * 100)}% of its limit`);
  else if (s.memory.heapRatio >= t.heapWarn) add("heap", "warn", `Heap at ${Math.round(s.memory.heapRatio * 100)}% of its limit`);
  if (s.memory.systemRatio >= t.systemMemWarn) add("memory", "warn", `System memory ${Math.round(s.memory.systemRatio * 100)}% used`);
  if (s.loop.p99Ms >= t.loopCriticalMs) add("loop", "critical", `Event loop lag p99 ${Math.round(s.loop.p99Ms)} ms`);
  else if (s.loop.p99Ms >= t.loopWarnMs) add("loop", "warn", `Event loop lag p99 ${Math.round(s.loop.p99Ms)} ms`);
  for (const turn of s.sessions.turns) {
    if (turn.stuck) add(`turn:${turn.sessionId}`, "warn", `A turn has run ${Math.round(turn.ageSec / 60)} min${turn.currentTool ? ` (in ${turn.currentTool})` : ""}`);
  }
  for (const b of s.providers) {
    if (b.state === "open") add(`provider:${b.provider}`, b.failingForMs >= 5 * 60_000 ? "critical" : "warn", `${b.provider} is failing (${b.consecutiveFailures} in a row)`);
  }
  for (const c of s.connectors.problems) {
    if (c.state === "red") add(`connector:${c.id}`, "warn", `${c.id}: ${c.detail}`);
  }
  if (s.push.configured && s.push.devices === 0) add("push", "warn", "Push is set up but no phone is registered");
  if (s.instances.failed > 0) add("instances", "warn", `${s.instances.failed} instance${s.instances.failed === 1 ? "" : "s"} failed`);
  if (s.processes.zombies + s.processes.orphans > 0) add("processes", "warn", `${s.processes.zombies} zombie and ${s.processes.orphans} orphan processes`);
  const hk = s.housekeeping as { lastError?: string } | undefined;
  if (hk?.lastError) add("housekeeping", "warn", `Housekeeping error: ${hk.lastError}`);
  const bk = s.backup as { ok?: boolean; stale?: boolean; error?: string } | undefined;
  if (bk && bk.ok === false) add("backup", "critical", `Backup failed${bk.error ? `: ${bk.error}` : ""}`);
  else if (bk?.stale) add("backup", "warn", "No backup in over 36 hours");
  return out;
}

export function worstLevel(problems: SystemProblem[]): Level {
  if (problems.some((p) => p.level === "critical")) return "critical";
  return problems.length > 0 ? "warn" : "ok";
}

export function formatUptime(sec: number): string {
  if (sec >= 86_400) return `${Math.floor(sec / 86_400)}d`;
  if (sec >= 3_600) return `${Math.floor(sec / 3_600)}h`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m`;
  return `${Math.max(0, Math.floor(sec))}s`;
}

/** "Healthy - up 2d - disk 17%": the Hub tile's live subtitle, built server-side so every client agrees. */
export function headlineFor(status: Level, uptimeSec: number, diskPct: number, problems: SystemProblem[]): string {
  const word = status === "ok" ? "Healthy" : status === "warn" ? (problems.length === 1 ? "1 warning" : `${problems.length} warnings`) : "Needs attention";
  return `${word} - up ${formatUptime(uptimeSec)} - disk ${diskPct}%`;
}

// ─── The service ────────────────────────────────────────────────────────

async function guarded<T>(name: string, sources: SystemSnapshot["sources"], fn: (() => T | Promise<T>) | undefined): Promise<T | undefined> {
  if (!fn) {
    sources[name] = "absent";
    return undefined;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), SOURCE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    sources[name] = "ok";
    return value;
  } catch {
    sources[name] = "error";
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SystemService {
  snapshot(opts?: { fresh?: boolean }): Promise<SystemSnapshot>;
  /** Kick the background disk walk now (call at boot). */
  warm(): void;
}

export function createSystemService(deps: SystemDeps): SystemService {
  const now = deps.now ?? Date.now;
  const bootMs = now() - process.uptime() * 1000;
  let cached: { at: number; value: SystemSnapshot } | null = null;
  let inflight: Promise<SystemSnapshot> | null = null;
  let diskDirs: { at: number; dirs: DiskDir[] } | null = null;
  let scanning: Promise<void> | null = null;

  const scanDisk = (): Promise<void> => {
    if (scanning) return scanning;
    scanning = (async () => {
      const dirs: DiskDir[] = [];
      for (const target of diskTargets(deps.home, deps.workspaces ?? [])) {
        let bytes = 0;
        let files = 0;
        const seen = new Set<string>();
        for (const p of target.paths) {
          const resolved = path.resolve(p);
          if (seen.has(resolved)) continue;
          seen.add(resolved);
          const r = await pathSize(resolved);
          bytes += r.bytes;
          files += r.files;
        }
        dirs.push({ key: target.key, label: target.label, bytes, files });
      }
      diskDirs = { at: now(), dirs };
    })()
      .catch(() => undefined)
      .finally(() => {
        scanning = null;
      });
    return scanning;
  };

  const fsUsage = (): { total: number; free: number } | null => {
    if (deps.statfs) return deps.statfs(deps.home);
    try {
      const s = statfsSync(deps.home);
      return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
    } catch {
      return null;
    }
  };

  const collect = async (): Promise<SystemSnapshot> => {
    const t0 = Date.now();
    const sources: SystemSnapshot["sources"] = {};
    const t = now();

    if (!diskDirs || t - diskDirs.at > DISK_SCAN_MS) {
      const walk = scanDisk();
      // First ever snapshot: wait briefly so the dirs are not empty; later ones serve the last scan.
      if (!diskDirs) await Promise.race([walk, new Promise((r) => setTimeout(r, 2_000).unref?.())]);
    }

    const [ver, listed, running, pendingPerms, queue, approvals, providers, loop, connectorMap, jobs, push, tunnel, instances, processes, errors, housekeeping, backup, maintainer, deep] =
      await Promise.all([
        guarded("version", sources, deps.version),
        guarded("sessions", sources, deps.sessions ? () => deps.sessions!.list() : undefined),
        guarded("runningTurns", sources, deps.sessions ? () => deps.sessions!.runningTurns() : undefined),
        guarded("permissions", sources, deps.sessions ? () => deps.sessions!.pendingPermissionList().length : undefined),
        guarded("queue", sources, deps.queueDepth),
        guarded("approvals", sources, deps.approvalsPending),
        guarded("providers", sources, deps.providers),
        guarded("loop", sources, deps.loop),
        guarded("connectors", sources, deps.connectors),
        guarded("scheduler", sources, deps.scheduler),
        guarded("push", sources, deps.push),
        guarded("tunnel", sources, deps.tunnel),
        guarded("instances", sources, deps.instances),
        guarded("processes", sources, deps.processes),
        guarded("errors", sources, deps.errors),
        guarded("housekeeping", sources, deps.housekeeping),
        guarded("backup", sources, deps.backup),
        guarded("maintainer", sources, deps.maintainer),
        guarded("deep", sources, deps.deep),
      ]);

    const mem = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const mb = (n: number) => Math.round(n / 1_048_576);
    const load = (deps.loadavg ?? os.loadavg)();
    const cores = Math.max(1, os.cpus().length);
    const usage = fsUsage();
    const totalBytes = usage?.total ?? 0;
    const usedBytes = usage ? usage.total - usage.free : 0;
    const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    const stuckMs = deps.stuckTurnMs ?? STUCK_TURN_MS;

    const turns: TurnView[] = (running ?? [])
      .map((r) => {
        const ageSec = Math.max(0, Math.round((t - Date.parse(r.startedAt)) / 1000));
        return {
          sessionId: r.sessionId,
          title: r.title,
          startedAt: r.startedAt,
          ageSec,
          ...(r.currentTool ? { currentTool: r.currentTool } : {}),
          ...(r.waitingForResume ? { waitingForResume: true } : {}),
          stuck: !r.waitingForResume && ageSec * 1000 >= stuckMs,
        };
      })
      .sort((a, b) => b.ageSec - a.ageSec);

    const connectorEntries = Object.entries(connectorMap ?? {});
    const count = (state: string) => connectorEntries.filter(([, c]) => c.state === state).length;
    const connectorProblems: ConnectorProblem[] = connectorEntries
      .filter(([, c]) => c.state === "red" || c.state === "amber")
      .map(([id, c]) => ({ id, state: c.state as "amber" | "red", detail: scrub(c.detail), stale: c.stale }))
      .sort((a, b) => (a.state === b.state ? a.id.localeCompare(b.id) : a.state === "red" ? -1 : 1))
      .slice(0, 20);

    const instItems = instances?.items ?? [];
    const base: Omit<SystemSnapshot, "status" | "headline" | "problems"> = {
      schema: 1,
      at: new Date(t).toISOString(),
      collectMs: 0,
      garrison: {
        pid: process.pid,
        startedAt: new Date(deps.startedAt?.() ?? bootMs).toISOString(),
        uptimeSec: Math.max(0, Math.round((t - (deps.startedAt?.() ?? bootMs)) / 1000)),
        ...(ver?.version ? { version: ver.version } : {}),
        ...(ver?.sha ? { sha: ver.sha } : {}),
        node: process.version,
        platform: process.platform,
        hostname: os.hostname(),
      },
      memory: {
        heapUsedMb: mb(mem.heapUsed),
        heapLimitMb: mb(heapLimit),
        heapRatio: heapLimit > 0 ? Math.round((mem.heapUsed / heapLimit) * 1000) / 1000 : 0,
        rssMb: mb(mem.rss),
        systemTotalMb: mb(totalMem),
        systemFreeMb: mb(freeMem),
        systemRatio: totalMem > 0 ? Math.round((1 - freeMem / totalMem) * 1000) / 1000 : 0,
      },
      loop: loop ?? { meanMs: 0, p99Ms: 0, maxMs: 0 },
      cpu: { load1: round1(load[0] ?? 0), load5: round1(load[1] ?? 0), cores, loadRatio: round2((load[0] ?? 0) / cores) },
      disk: {
        totalBytes,
        usedBytes,
        usedPct,
        dirs: diskDirs?.dirs ?? [],
        ...(diskDirs ? { scannedAt: new Date(diskDirs.at).toISOString() } : {}),
        ...(scanning ? { scanning: true } : {}),
      },
      sessions: {
        total: listed?.length ?? 0,
        running: turns.length,
        ...(turns.length > 0 ? { oldestRunningAgeSec: turns[0]!.ageSec } : {}),
        queueDepth: queue ?? 0,
        pendingPermissions: pendingPerms ?? 0,
        pendingApprovals: approvals ?? 0,
        turns: turns.slice(0, 25),
      },
      providers: providers ?? [],
      connectors: { total: connectorEntries.length, green: count("green"), amber: count("amber"), red: count("red"), grey: count("grey"), problems: connectorProblems },
      scheduler: { jobs: jobs ?? [] },
      push: push ?? { configured: false, devices: 0 },
      tunnel: tunnel ?? { scope: "unknown" },
      instances: {
        supported: instances?.supported ?? false,
        total: instItems.length,
        running: instItems.filter((i) => i.state === "running").length,
        failed: instItems.filter((i) => i.state === "failed").length,
        items: instItems.slice(0, 20),
      },
      processes: processes ?? { zombies: 0, orphans: 0 },
      errors: errors ?? [],
      ...(housekeeping !== undefined ? { housekeeping } : {}),
      ...(backup !== undefined ? { backup } : {}),
      ...(maintainer !== undefined ? { maintainer: boundedMaintainer(maintainer) } : {}),
      ...(deep !== undefined ? { deep: boundedDeep(deep) } : {}),
      sources,
    };
    adoptDeep(base, deep);
    const problems = deriveProblems(base);
    const status = worstLevel(problems);
    const value: SystemSnapshot = { ...base, status, headline: headlineFor(status, base.garrison.uptimeSec, usedPct, problems), problems };
    value.collectMs = Date.now() - t0;
    return value;
  };

  return {
    warm() {
      void scanDisk();
    },
    async snapshot(opts = {}) {
      if (!opts.fresh && cached && now() - cached.at < CACHE_MS) return { ...cached.value, collectMs: 0 };
      if (inflight) return inflight;
      inflight = collect()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  };
}

/**
 * Fold the antihang slice's /gateway/health/deep payload into what this snapshot
 * measured itself, so the two never disagree on the phone: breaker rows this
 * snapshot's own tracker has not seen, the larger orphan/zombie count, and the
 * deep error ring when ours is empty. Read defensively: any field may be absent.
 */
export function adoptDeep(base: Omit<SystemSnapshot, "status" | "headline" | "problems">, deep: unknown): void {
  if (!deep || typeof deep !== "object") return;
  const d = deep as Record<string, unknown>;
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const rows = Array.isArray(rec(d.providers).breakers) ? (rec(d.providers).breakers as unknown[]) : [];
  for (const raw of rows) {
    const r = rec(raw);
    const key = typeof r.key === "string" ? r.key : "";
    if (!key) continue;
    const state = r.state === "open" ? "open" : r.state === "half-open" ? "degraded" : "closed";
    const existing = base.providers.find((p) => p.provider === key);
    const failures = typeof r.consecutiveFailures === "number" ? r.consecutiveFailures : 0;
    const failingForMs = typeof r.openForMs === "number" ? r.openForMs : 0;
    const lastError = typeof r.lastError === "string" ? scrubErrorText(r.lastError, 160) : undefined;
    if (!existing) base.providers.push({ provider: key, state, consecutiveFailures: failures, failingForMs, ...(lastError ? { lastError } : {}) });
    else if (state === "open" && existing.state !== "open") Object.assign(existing, { state, consecutiveFailures: Math.max(existing.consecutiveFailures, failures), failingForMs: Math.max(existing.failingForMs, failingForMs), ...(lastError ? { lastError } : {}) });
  }
  const proc = rec(d.processes);
  if (typeof proc.orphans === "number") base.processes.orphans = Math.max(base.processes.orphans, proc.orphans);
  if (typeof proc.zombies === "number") base.processes.zombies = Math.max(base.processes.zombies, proc.zombies);
  if (base.errors.length === 0 && Array.isArray(d.errors)) {
    base.errors = (d.errors as unknown[]).slice(0, 10).flatMap((e) => {
      const r = rec(e);
      return typeof r.message === "string" ? [{ at: typeof r.at === "string" ? r.at : new Date().toISOString(), source: typeof r.kind === "string" ? scrubErrorText(r.kind, 40) : "ares", message: scrubErrorText(r.message) }] : [];
    });
  }
}

/** A maintainer status can carry whole proposals; the System screen needs their count and state, not their diffs. */
export function boundedMaintainer(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 5).map((item) => {
        if (!item || typeof item !== "object") return item;
        const r = item as Record<string, unknown>;
        const keep: Record<string, unknown> = {};
        for (const f of ["id", "status", "at", "finishedAt", "title"]) if (typeof r[f] === "string") keep[f] = scrubErrorText(r[f], 80);
        return keep;
      });
    } else if (v === null || typeof v !== "object") {
      out[k] = typeof v === "string" ? scrubErrorText(v, 120) : v;
    }
  }
  return out;
}

/** The deep health payload passes through, unless it grew past what a phone poll should carry. */
export function boundedDeep(value: unknown): unknown {
  try {
    if (JSON.stringify(value).length <= 32_768) return value;
  } catch {
    // not serialisable
  }
  const d = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return { truncated: true, ...(typeof d.status === "string" ? { status: d.status } : {}), ...(typeof d.ok === "boolean" ? { ok: d.ok } : {}) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const scrub = (s: string) => String(s ?? "").replace(/\s+/g, " ").slice(0, 160);
