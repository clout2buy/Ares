// Housekeeping: the box cleans up after itself, and says exactly what it did.
//
// Field origin: a 411MB session-kernel WAL, 1.2GB of checkpoint blobs nobody
// referenced, ~5GB of leftover scratch trees and 800 stale /tmp entries on the
// Rook box. Every one of them grew because nothing ever looked.
//
// Hard rules, enforced by Fence and not by each job's good intentions:
//   * Nothing outside Ares's own directories is ever touched. Every delete goes
//     through Fence.check(): the target must resolve strictly INSIDE an allowed
//     root (never the root itself), must not be a symlink, and must not be on
//     the protected list (vault, credentials, tokens, memory, personas, the
//     database itself).
//   * Every real action is appended to <home>/housekeeping/ledger.jsonl.
//   * dryRun does the whole scan and fills the same counters, changes nothing.
//   * ARES_HOUSEKEEPING=0 turns the whole thing off.
//   * A job that throws is recorded as that job's error; the others still run.
//   * A git worktree with ANY uncommitted or untracked change is never removed
//     (and `git worktree remove` itself would refuse: belt and braces).

import { execFile } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { dirSize } from "./systemSnapshot.js";

const DAY = 86_400_000;

export interface HousekeepingLimits {
  wireLogCompressDays: number;
  wireLogDeleteDays: number;
  wireLogCapMb: number;
  logRotateMb: number;
  logKeepRotations: number;
  logDeleteDays: number;
  crashDays: number;
  crashKeepNewest: number;
  spillDays: number;
  screenshotDays: number;
  tmpDays: number;
  worktreeStaleDays: number;
  imageContextDays: number;
  walMaxMb: number;
  orphanMinAgeMin: number;
  /** At or above this disk percentage the age limits halve. */
  diskPressurePct: number;
}

export const DEFAULT_LIMITS: HousekeepingLimits = {
  wireLogCompressDays: 2,
  wireLogDeleteDays: 14,
  wireLogCapMb: 300,
  logRotateMb: 20,
  logKeepRotations: 3,
  logDeleteDays: 30,
  crashDays: 45,
  crashKeepNewest: 20,
  spillDays: 30,
  screenshotDays: 7,
  tmpDays: 3,
  worktreeStaleDays: 7,
  imageContextDays: 7,
  walMaxMb: 64,
  orphanMinAgeMin: 10,
  diskPressurePct: 80,
};

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): HousekeepingLimits {
  const pick = (key: string, fallback: number): number => {
    const n = Number(env[key]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const d = DEFAULT_LIMITS;
  return {
    wireLogCompressDays: pick("ARES_HOUSEKEEPING_WIRELOG_COMPRESS_DAYS", d.wireLogCompressDays),
    wireLogDeleteDays: pick("ARES_HOUSEKEEPING_WIRELOG_DAYS", d.wireLogDeleteDays),
    wireLogCapMb: pick("ARES_HOUSEKEEPING_WIRELOG_CAP_MB", d.wireLogCapMb),
    logRotateMb: pick("ARES_HOUSEKEEPING_LOG_ROTATE_MB", d.logRotateMb),
    logKeepRotations: pick("ARES_HOUSEKEEPING_LOG_KEEP", d.logKeepRotations),
    logDeleteDays: pick("ARES_HOUSEKEEPING_LOG_DAYS", d.logDeleteDays),
    crashDays: pick("ARES_HOUSEKEEPING_CRASH_DAYS", d.crashDays),
    crashKeepNewest: pick("ARES_HOUSEKEEPING_CRASH_KEEP", d.crashKeepNewest),
    spillDays: pick("ARES_HOUSEKEEPING_SPILL_DAYS", d.spillDays),
    screenshotDays: pick("ARES_HOUSEKEEPING_SCREENSHOT_DAYS", d.screenshotDays),
    tmpDays: pick("ARES_HOUSEKEEPING_TMP_DAYS", d.tmpDays),
    worktreeStaleDays: pick("ARES_HOUSEKEEPING_WORKTREE_DAYS", d.worktreeStaleDays),
    imageContextDays: pick("ARES_HOUSEKEEPING_IMAGE_DAYS", d.imageContextDays),
    walMaxMb: pick("ARES_HOUSEKEEPING_WAL_MB", d.walMaxMb),
    orphanMinAgeMin: pick("ARES_HOUSEKEEPING_ORPHAN_MIN", d.orphanMinAgeMin),
    diskPressurePct: pick("ARES_HOUSEKEEPING_DISK_PCT", d.diskPressurePct),
  };
}

export function housekeepingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARES_HOUSEKEEPING !== "0";
}

// ─── The fence ──────────────────────────────────────────────────────────

/** Basenames (or path segments) that are never deleted, whatever a job decides. */
const PROTECTED = /(^|[\\/])(vault|secrets?|credentials(\.json)?|auth\.json|\.keysecret|keys?|tokens?|token-read|anthropic-oauth\.json|kimi-auth\.json|personas|memory|mnemosyne|goals|session-kernel\.sqlite(-wal|-shm)?|audit|IDENTITY\.md|SOUL\.md|USER\.md|LAWS\.md|MEMORY\.md|memory\.md|config\.json|ui\.json|devices\.json|phone-push\.json)([\\/]|$)/i;

export interface FenceRoot {
  /** Absolute directory. Anything strictly inside is eligible. */
  dir: string;
  /** When set, only DIRECT children whose name matches are eligible (shared dirs such as /tmp). */
  childPattern?: RegExp;
}

export class Fence {
  private readonly roots: FenceRoot[];
  constructor(roots: FenceRoot[]) {
    this.roots = roots.map((r) => ({ ...r, dir: path.resolve(r.dir) }));
  }

  /** Throws unless `target` may be deleted. Returns the resolved path. */
  check(target: string): string {
    const abs = path.resolve(target);
    for (const root of this.roots) {
      const rel = path.relative(root.dir, abs);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      const segments = rel.split(path.sep);
      if (root.childPattern) {
        if (!root.childPattern.test(segments[0]!)) continue;
      }
      if (PROTECTED.test(rel) && !root.childPattern) throw new Error(`refused: protected path ${rel}`);
      return abs;
    }
    throw new Error(`refused: ${abs} is outside Ares's own directories`);
  }

  allows(target: string): boolean {
    try {
      this.check(target);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Report + ledger ────────────────────────────────────────────────────

export interface JobCounters {
  /** Candidates seen. */
  found: number;
  /** Acted on (or, in a dry run, would have been). */
  acted: number;
  bytes: number;
  skipped: number;
  error?: string;
  notes: string[];
}

export interface HousekeepingReport {
  at: string;
  dryRun: boolean;
  durationMs: number;
  ok: boolean;
  lastError?: string;
  pressure: boolean;
  diskUsedPct?: number;
  totals: { acted: number; bytes: number };
  jobs: Record<string, JobCounters>;
}

export interface LedgerEntry {
  at: string;
  job: string;
  action: "delete" | "gzip" | "truncate" | "gc" | "worktree-remove" | "kill" | "image-remove" | "wal-checkpoint";
  target: string;
  bytes: number;
  detail?: string;
}

const LEDGER_MAX_BYTES = 2 * 1024 * 1024;

export interface ProcInfo {
  pid: number;
  ppid: number;
  state: string;
  comm: string;
  cmd: string;
  uid: number;
  ageSec: number;
}

export interface GitResult {
  code: number;
  stdout: string;
}

export interface HousekeepingDeps {
  /** The Ares home (~/.ares). */
  home: string;
  /** Workspaces whose <ws>/.ares state is tidied. */
  workspaces?: string[];
  tmpDir?: string;
  instancesRoot?: string;
  limits?: Partial<HousekeepingLimits>;
  now?: () => number;
  /** Reads the filesystem fill percentage; absent = statfs on home. */
  diskUsedPct?: () => number | null;
  activeTurns?: () => number;
  /** Core's checkpoint GC (blobs + metas). Absent = the job reports "not wired". */
  gcCheckpoints?: (workspace: string) => Promise<void>;
  /** WAL fold; the host passes its kernel. Returns pages still unfolded, or null. */
  maintainWal?: (mode: "PASSIVE" | "TRUNCATE") => { busy: number; log: number; checkpointed: number } | null;
  git?: (cwd: string, args: string[]) => Promise<GitResult>;
  processes?: () => Promise<ProcInfo[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  docker?: (args: string[]) => Promise<GitResult | null>;
  ownPid?: number;
  uid?: number;
  /** false = never write the report or ledger (read-only measurement against a live home). Default true. */
  persist?: boolean;
  log?: (line: string) => void;
}

// ─── Small helpers ──────────────────────────────────────────────────────

const exists = async (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);

async function listDir(dir: string): Promise<import("node:fs").Dirent[]> {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

export function defaultGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

function defaultDocker(args: string[]): Promise<GitResult | null> {
  const run = (cmd: string, argv: string[]) =>
    new Promise<GitResult | null>((resolve) => {
      execFile(cmd, argv, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
        resolve({ code: err ? 1 : 0, stdout: String(stdout ?? "") });
      });
    });
  return run("docker", args).then((r) => (r && r.code === 0 ? r : run("sudo", ["-n", "docker", ...args])));
}

/** Parse /proc into ProcInfo rows. Linux only; returns [] elsewhere. */
export async function readProcTable(): Promise<ProcInfo[]> {
  if (process.platform !== "linux") return [];
  const out: ProcInfo[] = [];
  let uptime = 0;
  try {
    uptime = Number((await fs.readFile("/proc/uptime", "utf8")).split(" ")[0]);
  } catch {
    return [];
  }
  const names = await fs.readdir("/proc").catch(() => [] as string[]);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, "utf8");
      // pid (comm) state ppid ... starttime is field 22; comm may contain spaces/parens.
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const rest = stat.slice(close + 2).split(" ");
      const state = rest[0] ?? "?";
      const ppid = Number(rest[1]);
      const startTicks = Number(rest[19]);
      const cmd = (await fs.readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")).split("\0").join(" ").trim();
      const st = await fs.stat(`/proc/${name}`);
      out.push({ pid: Number(name), ppid, state, comm, cmd, uid: st.uid, ageSec: Math.max(0, Math.round(uptime - startTicks / 100)) });
    } catch {
      // the process exited while we looked
    }
  }
  return out;
}

// ─── The engine ─────────────────────────────────────────────────────────

export class Housekeeping {
  private readonly d: HousekeepingDeps;
  private readonly now: () => number;
  private readonly limits: HousekeepingLimits;
  private readonly fence: Fence;
  private running = false;
  /** Paths a dry run has already counted, so two jobs never count one file twice. */
  private dryCounted = new Set<string>();
  private lastReport: HousekeepingReport | undefined;
  readonly ledgerFile: string;
  readonly reportFile: string;

  constructor(deps: HousekeepingDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.limits = { ...limitsFromEnv(), ...(deps.limits ?? {}) };
    const tmp = deps.tmpDir ?? os.tmpdir();
    const roots: FenceRoot[] = [
      { dir: deps.home },
      ...(deps.workspaces ?? []).flatMap((w) => [
        { dir: path.join(w, ".ares") },
        { dir: path.join(w, ".claude", "worktrees") },
      ]),
      // Shared scratch: only Ares's own prefixes, only direct children.
      { dir: tmp, childPattern: /^(ares-[A-Za-z0-9._-]+|ares-screenshots|shots-[A-Za-z0-9._-]+|playwright-artifacts-[A-Za-z0-9._-]+)$/ },
    ];
    const instances = deps.instancesRoot ?? process.env.ARES_INSTANCES_ROOT ?? path.join(os.homedir(), "ares-instances");
    roots.push({ dir: instances, childPattern: /^\.image$/ });
    this.fence = new Fence(roots);
    this.ledgerFile = path.join(deps.home, "housekeeping", "ledger.jsonl");
    this.reportFile = path.join(deps.home, "housekeeping", "last-report.json");
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The last report this process produced (or read from disk at boot). */
  async last(): Promise<HousekeepingReport | undefined> {
    if (this.lastReport) return this.lastReport;
    try {
      this.lastReport = JSON.parse(await fs.readFile(this.reportFile, "utf8")) as HousekeepingReport;
    } catch {
      // never ran
    }
    return this.lastReport;
  }

  /** Compact view for the snapshot: what the phone shows. */
  summary(): { lastRunAt?: string; dryRun?: boolean; acted: number; bytes: number; lastError?: string; jobs: Array<{ job: string; acted: number; bytes: number; error?: string }>; enabled: boolean } {
    const r = this.lastReport;
    return {
      enabled: housekeepingEnabled(),
      ...(r ? { lastRunAt: r.at, dryRun: r.dryRun } : {}),
      acted: r?.totals.acted ?? 0,
      bytes: r?.totals.bytes ?? 0,
      ...(r?.lastError ? { lastError: r.lastError } : {}),
      jobs: Object.entries(r?.jobs ?? {}).map(([job, c]) => ({ job, acted: c.acted, bytes: c.bytes, ...(c.error ? { error: c.error } : {}) })),
    };
  }

  /** Recent ledger lines, newest first. */
  async ledgerTail(limit = 50): Promise<LedgerEntry[]> {
    try {
      const text = await fs.readFile(this.ledgerFile, "utf8");
      const lines = text.split("\n").filter(Boolean).slice(-limit).reverse();
      return lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as LedgerEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  async run(opts: { dryRun?: boolean } = {}): Promise<HousekeepingReport> {
    const dryRun = opts.dryRun === true;
    if (this.running) throw new Error("housekeeping is already running");
    if (!housekeepingEnabled()) {
      return { at: new Date(this.now()).toISOString(), dryRun, durationMs: 0, ok: true, pressure: false, totals: { acted: 0, bytes: 0 }, jobs: {}, lastError: undefined };
    }
    this.running = true;
    this.dryCounted = new Set();
    const started = Date.now();
    const jobs: Record<string, JobCounters> = {};
    const usedPct = this.d.diskUsedPct ? this.d.diskUsedPct() : this.statfsPct();
    const pressure = usedPct !== null && usedPct >= this.limits.diskPressurePct;
    const factor = pressure ? 0.5 : 1;
    try {
      const ctx = { dryRun, factor, counters: undefined as unknown as JobCounters };
      const table: Array<[string, (c: typeof ctx) => Promise<void>]> = [
        ["wireLogs", (c) => this.jobWireLogs(c)],
        ["logs", (c) => this.jobLogs(c)],
        ["crashes", (c) => this.jobCrashes(c)],
        ["spill", (c) => this.jobSpill(c)],
        ["screenshots", (c) => this.jobScreenshots(c)],
        ["checkpoints", (c) => this.jobCheckpoints(c)],
        ["wal", (c) => this.jobWal(c)],
        ["tmp", (c) => this.jobTmp(c)],
        ["worktrees", (c) => this.jobWorktrees(c)],
        ["instances", (c) => this.jobInstances(c)],
        ["processes", (c) => this.jobProcesses(c)],
      ];
      for (const [name, fn] of table) {
        const counters: JobCounters = { found: 0, acted: 0, bytes: 0, skipped: 0, notes: [] };
        jobs[name] = counters;
        ctx.counters = counters;
        try {
          await fn(ctx);
        } catch (err) {
          counters.error = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200);
        }
      }
    } finally {
      this.running = false;
    }
    const errors = Object.entries(jobs).filter(([, c]) => c.error);
    const report: HousekeepingReport = {
      at: new Date(this.now()).toISOString(),
      dryRun,
      durationMs: Date.now() - started,
      ok: errors.length === 0,
      ...(errors.length > 0 ? { lastError: `${errors[0]![0]}: ${errors[0]![1].error}` } : {}),
      pressure,
      ...(usedPct !== null ? { diskUsedPct: usedPct } : {}),
      totals: {
        acted: Object.values(jobs).reduce((n, c) => n + c.acted, 0),
        bytes: Object.values(jobs).reduce((n, c) => n + c.bytes, 0),
      },
      jobs,
    };
    this.lastReport = report;
    await this.writeReport(report, dryRun);
    this.d.log?.(`housekeeping: ${dryRun ? "dry run: would act on" : "acted on"} ${report.totals.acted} items, ${(report.totals.bytes / 1_048_576).toFixed(1)} MB${report.lastError ? ` (error ${report.lastError})` : ""}`);
    return report;
  }

  // ── plumbing ──

  private statfsPct(): number | null {
    try {
      const s = statfsSync(this.d.home);
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      return total > 0 ? Math.round(((total - free) / total) * 100) : null;
    } catch {
      return null;
    }
  }

  private async writeReport(report: HousekeepingReport, dryRun: boolean): Promise<void> {
    if (this.d.persist === false) return;
    try {
      await fs.mkdir(path.dirname(this.reportFile), { recursive: true });
      // A dry run is a question, not a result: it must not replace the last real report.
      const target = dryRun ? this.reportFile.replace(/last-report\.json$/, "last-dry-run.json") : this.reportFile;
      await fs.writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch {
      // the report is a convenience; the ledger is the record
    }
  }

  private async ledger(entry: Omit<LedgerEntry, "at">): Promise<void> {
    if (this.d.persist === false) return;
    try {
      await fs.mkdir(path.dirname(this.ledgerFile), { recursive: true });
      const st = await fs.stat(this.ledgerFile).catch(() => null);
      if (st && st.size > LEDGER_MAX_BYTES) {
        const text = await fs.readFile(this.ledgerFile, "utf8");
        const keep = text.split("\n").filter(Boolean).slice(-2000).join("\n") + "\n";
        await fs.writeFile(this.ledgerFile, keep, "utf8");
      }
      await fs.appendFile(this.ledgerFile, JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry, target: entry.target.replace(os.homedir(), "~") }) + "\n", "utf8");
    } catch {
      // never let bookkeeping stop the cleanup
    }
  }

  private age(stat: { mtimeMs: number }): number {
    return this.now() - stat.mtimeMs;
  }

  /** Delete one file or directory through the fence, ledgering it. Returns bytes freed. */
  private async remove(c: { dryRun: boolean; counters: JobCounters }, job: string, target: string, detail?: string): Promise<number> {
    const abs = this.fence.check(target);
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) return 0;
    if (st.isSymbolicLink()) {
      c.counters.skipped += 1;
      return 0;
    }
    if (c.dryRun) {
      if (this.dryCounted.has(abs)) return 0;
      this.dryCounted.add(abs);
    }
    const bytes = st.isDirectory() ? (await dirSize(abs)).bytes : st.size;
    c.counters.acted += 1;
    c.counters.bytes += bytes;
    if (c.dryRun) return bytes;
    await fs.rm(abs, { recursive: true, force: true });
    await this.ledger({ job, action: "delete", target: abs, bytes, ...(detail ? { detail } : {}) });
    return bytes;
  }

  private days(n: number, factor: number): number {
    return n * DAY * factor;
  }

  private wsRoots(): string[] {
    return (this.d.workspaces ?? []).map((w) => path.join(w, ".ares"));
  }

  // ── jobs ──

  private async jobWireLogs(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const L = this.limits;
    const dirs = [...this.wsRoots().map((r) => path.join(r, "wire-log")), path.join(this.d.home, "wire-log")];
    const files: Array<{ file: string; size: number; mtimeMs: number; gz: boolean }> = [];
    for (const dir of dirs) {
      for (const e of await listDir(dir)) {
        if (!e.isFile() || !/\.jsonl(\.gz)?$/.test(e.name)) continue;
        const file = path.join(dir, e.name);
        const st = await fs.lstat(file).catch(() => null);
        if (st) files.push({ file, size: st.size, mtimeMs: st.mtimeMs, gz: e.name.endsWith(".gz") });
      }
    }
    c.counters.found = files.length;
    const now = this.now();
    const active = (f: { mtimeMs: number }) => now - f.mtimeMs < 10 * 60_000;
    let live = [...files];
    for (const f of files) {
      if (active(f)) continue;
      if (now - f.mtimeMs > this.days(L.wireLogDeleteDays, c.factor)) {
        await this.remove(c, "wireLogs", f.file, `older than ${L.wireLogDeleteDays}d`);
        live = live.filter((x) => x !== f);
      }
    }
    for (const f of live.filter((x) => !x.gz)) {
      if (active(f) || f.size < 64 * 1024) continue;
      if (now - f.mtimeMs < this.days(L.wireLogCompressDays, c.factor)) continue;
      await this.gzipInPlace(c, "wireLogs", f.file, f.size);
    }
    // Total cap: oldest first, compressed before plain, never the active file.
    const cap = L.wireLogCapMb * 1_048_576;
    const afterDirs: Array<{ file: string; size: number; mtimeMs: number }> = [];
    for (const dir of dirs) {
      for (const e of await listDir(dir)) {
        if (!e.isFile() || !/\.jsonl(\.gz)?$/.test(e.name)) continue;
        const st = await fs.lstat(path.join(dir, e.name)).catch(() => null);
        if (st) afterDirs.push({ file: path.join(dir, e.name), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
    let total = afterDirs.reduce((n, f) => n + f.size, 0);
    for (const f of afterDirs.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= cap) break;
      if (active(f)) continue;
      await this.remove(c, "wireLogs", f.file, "over the wire-log size cap");
      total -= f.size;
    }
  }

  private async gzipInPlace(c: { dryRun: boolean; counters: JobCounters }, job: string, file: string, size: number): Promise<void> {
    this.fence.check(file);
    c.counters.acted += 1;
    if (c.dryRun) {
      c.counters.bytes += Math.round(size * 0.85);
      return;
    }
    const gz = `${file}.gz`;
    const tmp = `${gz}.${process.pid}.tmp`;
    try {
      await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(tmp));
      const after = await fs.stat(tmp);
      const before = await fs.stat(file);
      if (before.size !== size) {
        // Written to while we compressed: leave it for the next pass.
        await fs.rm(tmp, { force: true });
        c.counters.acted -= 1;
        c.counters.skipped += 1;
        return;
      }
      await fs.rename(tmp, gz);
      await fs.rm(file, { force: true });
      c.counters.bytes += Math.max(0, size - after.size);
      await this.ledger({ job, action: "gzip", target: file, bytes: Math.max(0, size - after.size) });
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  private async jobLogs(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const L = this.limits;
    const now = this.now();
    const dirs = [path.join(this.d.home, "logs"), this.d.home];
    const seen = new Set<string>();
    for (const dir of dirs) {
      for (const e of await listDir(dir)) {
        if (!e.isFile() || !/\.log(\.[A-Za-z0-9-]+)*$/.test(e.name)) continue;
        const file = path.join(dir, e.name);
        if (seen.has(file)) continue;
        seen.add(file);
        const st = await fs.lstat(file).catch(() => null);
        if (!st) continue;
        c.counters.found += 1;
        if (e.name.endsWith(".gz")) {
          if (now - st.mtimeMs > this.days(L.logDeleteDays, c.factor)) await this.remove(c, "logs", file, `rotation older than ${L.logDeleteDays}d`);
          continue;
        }
        if (st.size < L.logRotateMb * 1_048_576) continue;
        // Copy-truncate: the writer keeps its descriptor. A line appended between the copy and the truncate is lost; for a debug log that is the right trade.
        c.counters.acted += 1;
        if (c.dryRun) {
          c.counters.bytes += st.size;
          continue;
        }
        const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        const gz = `${file}.${stamp}.gz`;
        await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(gz));
        const after = await fs.stat(file);
        if (after.size === st.size) await fs.truncate(file, 0);
        else await fs.rm(gz, { force: true }); // grew meanwhile: try again next hour
        c.counters.bytes += st.size;
        await this.ledger({ job: "logs", action: "truncate", target: file, bytes: st.size, detail: "rotated to a .gz" });
        // keep only N rotations
        const rotations = (await listDir(dir)).filter((x) => x.isFile() && x.name.startsWith(`${e.name}.`) && x.name.endsWith(".gz")).map((x) => x.name).sort();
        for (const old of rotations.slice(0, Math.max(0, rotations.length - L.logKeepRotations))) {
          await this.remove(c, "logs", path.join(dir, old), "beyond the kept rotations");
        }
      }
    }
  }

  private async jobCrashes(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const L = this.limits;
    const dir = path.join(this.d.home, "crashes");
    const rows: Array<{ file: string; mtimeMs: number }> = [];
    for (const e of await listDir(dir)) {
      if (!e.isFile()) continue;
      const st = await fs.lstat(path.join(dir, e.name)).catch(() => null);
      if (st) rows.push({ file: path.join(dir, e.name), mtimeMs: st.mtimeMs });
    }
    c.counters.found = rows.length;
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [i, r] of rows.entries()) {
      if (i < L.crashKeepNewest) continue;
      if (this.now() - r.mtimeMs > this.days(L.crashDays, c.factor)) await this.remove(c, "crashes", r.file, `older than ${L.crashDays}d`);
    }
  }

  private async jobSpill(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const dirs = [path.join(this.d.home, "tool-results"), ...this.wsRoots().flatMap((r) => [path.join(r, "tool-results"), path.join(r, "shell-output")])];
    await this.sweepOld(c, "spill", dirs, this.days(this.limits.spillDays, c.factor));
  }

  private async jobScreenshots(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const tmp = this.d.tmpDir ?? os.tmpdir();
    await this.sweepOld(c, "screenshots", [path.join(this.d.home, "screenshots"), path.join(tmp, "ares-screenshots")], this.days(this.limits.screenshotDays, c.factor));
  }

  /** Delete regular files older than `maxAgeMs` anywhere under `dirs` (depth-limited), keeping the dirs. */
  private async sweepOld(c: { dryRun: boolean; counters: JobCounters }, job: string, dirs: string[], maxAgeMs: number): Promise<void> {
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const e of await listDir(dir)) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (depth < 3) await walk(full, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        c.counters.found += 1;
        const st = await fs.lstat(full).catch(() => null);
        if (st && this.now() - st.mtimeMs > maxAgeMs) {
          if (!this.fence.allows(full)) {
            c.counters.skipped += 1;
            continue;
          }
          await this.remove(c, job, full, `older than ${Math.round(maxAgeMs / DAY)}d`);
        }
      }
    };
    for (const dir of dirs) await walk(dir, 0);
  }

  private async jobCheckpoints(c: { dryRun: boolean; counters: JobCounters }): Promise<void> {
    // <workspace>/.ares/checkpoints. When Ares's home IS <something>/.ares, that something is a workspace too:
    // that is where the 1.2GB of orphaned blobs on Rook sat, with no metas left to reference them.
    const spaces = new Set<string>((this.d.workspaces ?? []).map((w) => path.resolve(w)));
    if (path.basename(this.d.home) === ".ares") spaces.add(path.dirname(path.resolve(this.d.home)));
    if (!this.d.gcCheckpoints) {
      c.counters.notes.push("checkpoint GC is not wired on this host");
      return;
    }
    for (const ws of spaces) {
      const blobs = path.join(ws, ".ares", "checkpoints", "blobs");
      if (!(await exists(blobs))) continue;
      const orphans = await this.orphanBlobs(ws);
      if (orphans === null) {
        c.counters.notes.push(`${path.basename(ws)}: unreadable checkpoint metas, sweep skipped`);
        continue;
      }
      c.counters.found += orphans.total;
      if (orphans.count === 0) continue;
      if (c.dryRun) {
        c.counters.acted += orphans.count;
        c.counters.bytes += orphans.bytes;
        continue;
      }
      // Core's GC is safe against a live turn (it serialises per workspace and spares blobs younger than a minute).
      await this.d.gcCheckpoints(ws);
      const after = (await this.orphanBlobs(ws)) ?? orphans;
      const freedBlobs = Math.max(0, orphans.count - after.count);
      const freed = Math.max(0, orphans.bytes - after.bytes);
      c.counters.acted += freedBlobs;
      c.counters.bytes += freed;
      if (freedBlobs > 0) await this.ledger({ job: "checkpoints", action: "gc", target: blobs, bytes: freed, detail: `${freedBlobs} orphaned blobs` });
    }
  }

  /** Blobs that no surviving checkpoint meta references and that are older than a minute. null = cannot tell. */
  private async orphanBlobs(workspace: string): Promise<{ count: number; bytes: number; total: number } | null> {
    const metaDir = path.join(workspace, ".ares", "checkpoints", "meta");
    const live = new Set<string>();
    for (const e of await listDir(metaDir)) {
      if (!e.name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(metaDir, e.name), "utf8")) as { fileManifest?: Array<{ blobHash: string }> };
        for (const f of meta.fileManifest ?? []) live.add(f.blobHash);
      } catch {
        return null;
      }
    }
    let count = 0;
    let bytes = 0;
    let total = 0;
    const root = path.join(workspace, ".ares", "checkpoints", "blobs");
    for (const shard of await listDir(root)) {
      if (!shard.isDirectory()) continue;
      for (const b of await listDir(path.join(root, shard.name))) {
        total += 1;
        if (live.has(b.name)) continue;
        const st = await fs.lstat(path.join(root, shard.name, b.name)).catch(() => null);
        if (!st || this.now() - st.mtimeMs < 60_000) continue;
        count += 1;
        bytes += st.size;
      }
    }
    return { count, bytes, total };
  }

  private async jobWal(c: { dryRun: boolean; counters: JobCounters }): Promise<void> {
    for (const ws of this.d.workspaces ?? []) {
      const wal = path.join(ws, ".ares", "session-kernel.sqlite-wal");
      const st = await fs.stat(wal).catch(() => null);
      if (!st) continue;
      c.counters.found += 1;
      if (st.size < this.limits.walMaxMb * 1_048_576) continue;
      if (!this.d.maintainWal) {
        c.counters.notes.push("WAL is large but no kernel is wired to fold it");
        continue;
      }
      c.counters.acted += 1;
      c.counters.bytes += st.size;
      if (c.dryRun) continue;
      // TRUNCATE only when nothing is running; otherwise PASSIVE folds what it can without blocking a turn.
      const idle = (this.d.activeTurns?.() ?? 0) === 0;
      const r = this.d.maintainWal(idle ? "TRUNCATE" : "PASSIVE");
      const after = await fs.stat(wal).catch(() => null);
      const freed = Math.max(0, st.size - (after?.size ?? st.size));
      c.counters.bytes += freed - st.size;
      await this.ledger({ job: "wal", action: "wal-checkpoint", target: wal, bytes: freed, detail: r ? `busy=${r.busy} log=${r.log} folded=${r.checkpointed}` : "no result" });
    }
  }

  private async jobTmp(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const tmp = this.d.tmpDir ?? os.tmpdir();
    const uid = this.d.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const maxAge = this.days(this.limits.tmpDays, c.factor);
    for (const e of await listDir(tmp)) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const full = path.join(tmp, e.name);
      if (!this.fence.allows(full)) continue;
      const st = await fs.lstat(full).catch(() => null);
      if (!st) continue;
      c.counters.found += 1;
      if (uid !== undefined && st.uid !== uid) {
        c.counters.skipped += 1;
        continue;
      }
      // Newest activity anywhere directly inside counts: a scratch dir still being written is not stale.
      let newest = st.mtimeMs;
      for (const child of await listDir(full)) {
        const cs = await fs.lstat(path.join(full, child.name)).catch(() => null);
        if (cs && cs.mtimeMs > newest) newest = cs.mtimeMs;
      }
      if (this.now() - newest <= maxAge) continue;
      await this.remove(c, "tmp", full, `idle ${Math.round((this.now() - newest) / DAY)}d`);
    }
  }

  private async jobWorktrees(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const git = this.d.git ?? defaultGit;
    const maxAge = this.days(this.limits.worktreeStaleDays, c.factor);
    for (const repo of this.d.workspaces ?? []) {
      if (!(await exists(path.join(repo, ".git")))) continue;
      const listed = await git(repo, ["worktree", "list", "--porcelain"]);
      if (listed.code !== 0) continue;
      const mainHead = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
      const blocks = listed.stdout.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
      for (const block of blocks.slice(1)) {
        const lines = block.split("\n");
        const wt = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "";
        const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "";
        const detached = lines.includes("detached");
        const locked = lines.some((l) => l.startsWith("locked"));
        if (!wt) continue;
        const abs = path.resolve(wt);
        // Only worktrees living in Ares's own scratch locations are ever candidates.
        if (!this.fence.allows(abs)) continue;
        c.counters.found += 1;
        if (locked) {
          c.counters.skipped += 1;
          continue;
        }
        if (!(await exists(abs))) {
          // The directory is gone; only the registration lingers. Pruning it deletes nothing of value.
          c.counters.acted += 1;
          if (!c.dryRun) {
            await git(repo, ["worktree", "prune"]);
            await this.ledger({ job: "worktrees", action: "worktree-remove", target: abs, bytes: 0, detail: "registration without a directory" });
          }
          continue;
        }
        const status = await git(abs, ["status", "--porcelain", "--untracked-files=all"]);
        if (status.code !== 0 || status.stdout.trim() !== "") {
          c.counters.skipped += 1;
          c.counters.notes.push(`${path.basename(abs)}: has uncommitted changes, kept`);
          continue;
        }
        const merged = head && mainHead ? (await git(repo, ["merge-base", "--is-ancestor", head, mainHead])).code === 0 : false;
        const onRemote = head ? (await git(repo, ["branch", "-r", "--contains", head])).stdout.trim() !== "" : false;
        const dirStat = await fs.stat(abs).catch(() => null);
        const commitTime = Number((await git(abs, ["log", "-1", "--format=%ct"])).stdout.trim()) * 1000 || 0;
        const touched = Math.max(dirStat?.mtimeMs ?? 0, commitTime);
        const stale = this.now() - touched > maxAge;
        // Removing a worktree loses no commit when HEAD sits on a branch (the branch survives) or is already contained elsewhere.
        const safeToDrop = !detached || merged || onRemote;
        if (!(safeToDrop && (merged || onRemote || stale))) {
          c.counters.skipped += 1;
          continue;
        }
        const bytes = (await dirSize(abs)).bytes;
        c.counters.acted += 1;
        c.counters.bytes += bytes;
        if (c.dryRun) continue;
        // No --force: git itself refuses a worktree that turned dirty since the check above.
        const removed = await git(repo, ["worktree", "remove", abs]);
        if (removed.code === 0) {
          await this.ledger({ job: "worktrees", action: "worktree-remove", target: abs, bytes, detail: merged || onRemote ? "merged" : `idle ${Math.round((this.now() - touched) / DAY)}d` });
        } else {
          c.counters.acted -= 1;
          c.counters.bytes -= bytes;
          c.counters.skipped += 1;
        }
      }
      if (!c.dryRun) await git(repo, ["worktree", "prune"]);
    }
  }

  private async jobInstances(c: { dryRun: boolean; factor: number; counters: JobCounters }): Promise<void> {
    const root = this.d.instancesRoot ?? process.env.ARES_INSTANCES_ROOT ?? path.join(os.homedir(), "ares-instances");
    const ctxDir = path.join(root, ".image");
    const st = await fs.stat(ctxDir).catch(() => null);
    // The staged build context is rebuilt by the next deploy; it is only a cache.
    if (st) {
      c.counters.found += 1;
      if (this.now() - st.mtimeMs > this.days(this.limits.imageContextDays, c.factor)) await this.remove(c, "instances", ctxDir, "stale staged build context");
    }
    const docker = this.d.docker ?? defaultDocker;
    const images = await docker(["image", "ls", "ares-instance", "--format", "{{.Tag}}\t{{.CreatedAt}}"]);
    if (!images || images.code !== 0) return;
    const inUse = await docker(["ps", "-a", "--format", "{{.Image}}"]);
    const used = new Set((inUse?.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean));
    const tags = images.stdout
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p[0] && p[0] !== "latest" && p[0] !== "<none>")
      .map((p) => ({ tag: p[0]!, created: Date.parse(p[1] ?? "") || 0 }))
      .sort((a, b) => b.created - a.created);
    c.counters.found += tags.length;
    // Keep the newest old image as a rollback target, plus anything a container still uses.
    for (const t of tags.slice(1)) {
      if (used.has(`ares-instance:${t.tag}`) || used.has(t.tag)) continue;
      c.counters.acted += 1;
      if (c.dryRun) continue;
      const r = await docker(["rmi", `ares-instance:${t.tag}`]);
      if (r && r.code === 0) await this.ledger({ job: "instances", action: "image-remove", target: `ares-instance:${t.tag}`, bytes: 0 });
      else {
        c.counters.acted -= 1;
        c.counters.skipped += 1;
      }
    }
  }

  private async jobProcesses(c: { dryRun: boolean; counters: JobCounters }): Promise<void> {
    const table = await (this.d.processes ?? readProcTable)();
    if (table.length === 0) return;
    const own = this.d.ownPid ?? process.pid;
    const uid = this.d.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const byPid = new Map(table.map((p) => [p.pid, p]));
    const home = this.d.home;
    // Only Ares's own browser scratch is a marker: a profile dir under the home, or a throwaway ares-login-* dir.
    const marker = new RegExp(`--user-data-dir=(${escapeRe(home)}/browser-profile[^ ]*|[^ ]*/ares-login-[A-Za-z0-9]+[^ ]*|[^ ]*/playwright_chromiumdev_profile-[^ ]*)`);
    c.counters.notes.push(`zombies: ${table.filter((p) => p.state === "Z" && p.ppid === own).length}`);
    let killed = 0;
    for (const p of table) {
      if (killed >= 10) break;
      if (p.pid === own || p.state === "Z") continue;
      if (uid !== undefined && p.uid !== uid) continue;
      if (!marker.test(p.cmd) || p.ageSec < this.limits.orphanMinAgeMin * 60) continue;
      const parent = byPid.get(p.ppid);
      const orphaned = p.ppid === 1 || (parent !== undefined && (parent.comm === "systemd" || parent.comm === "init"));
      if (!orphaned) continue;
      c.counters.found += 1;
      c.counters.acted += 1;
      if (c.dryRun) continue;
      try {
        (this.d.kill ?? process.kill)(p.pid, "SIGTERM");
        await (this.d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3_000);
        if ((this.d.isAlive ?? defaultIsAlive)(p.pid)) (this.d.kill ?? process.kill)(p.pid, "SIGKILL");
        killed += 1;
        await this.ledger({ job: "processes", action: "kill", target: `pid ${p.pid} ${p.comm}`, bytes: 0, detail: `orphaned for ${Math.round(p.ageSec / 60)}m` });
      } catch {
        c.counters.skipped += 1;
      }
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** For the snapshot: counts of zombie/orphan Ares processes right now. Cheap (one /proc pass). */
export async function countStrayProcesses(home: string, table?: ProcInfo[], ownPid = process.pid): Promise<{ zombies: number; orphans: number }> {
  const rows = table ?? (await readProcTable());
  const byPid = new Map(rows.map((p) => [p.pid, p]));
  const marker = new RegExp(`--user-data-dir=(${escapeRe(home)}/browser-profile[^ ]*|[^ ]*/ares-login-[A-Za-z0-9]+[^ ]*|[^ ]*/playwright_chromiumdev_profile-[^ ]*)`);
  const zombies = rows.filter((p) => p.state === "Z" && p.ppid === ownPid).length;
  const orphans = rows.filter((p) => {
    if (p.state === "Z" || !marker.test(p.cmd)) return false;
    const parent = byPid.get(p.ppid);
    return p.ppid === 1 || (parent !== undefined && (parent.comm === "systemd" || parent.comm === "init"));
  }).length;
  return { zombies, orphans };
}
