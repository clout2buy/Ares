// ProcessOwner — every process an agent starts is owned by its session.
//
// Field origin (2026-10-26, a coworker's machine): Rust services had been
// running for DAYS. The process tree showed them as children of Git-bash
// wrapper commands run from the workspace during past Ares sessions — one
// was literally a child of a `taskkill` wrapper. Agent shell commands had
// spun them up to test the app; nothing ever stopped them, because closing a
// session does not clean up its child processes, and only `run_in_background`
// jobs were ever registered. A FOREGROUND command that detaches a child
// (`Start-Process`, `cmd /c start`, `nohup … &`, `npx electron . &`) left an
// orphan nothing knew about.
//
// The contract now: after a foreground command that could have detached
// something (or that had to be killed), the processes it left behind are
// found and ADOPTED into the session's ShellRegistry as running jobs. They
// show in the Background panel with the command that launched them, can be
// stopped like any job, and go down with the session (Stop all, chat closed,
// Ares closing). Agents may run Rust/Go/Java/Node/Python backends and dev
// servers to try things — they are just not allowed to leave them behind.
//
// Finding survivors is a snapshot AFTER the command: every process created
// since the command started whose parent is the command's shell, another
// such new process, or a parent that has already died (the `start`/wrapper
// case). Nothing is snapshotted before the command, so the common path pays
// nothing; the listing (one CIM query on Windows, one `ps` elsewhere) runs
// only when the command text looks like it could detach, when it timed out,
// or when a survivor was proven to hold the output pipe. Everything that
// touches the OS is injectable, so the selection is unit-tested with fake
// process tables.

import { spawn } from "node:child_process";
import type { ShellRegistry, ShellSnapshot } from "./ShellRegistry.js";

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  /** Epoch ms, or null when the platform could not say. */
  createdAtMs: number | null;
}

export interface SurvivorTree {
  pid: number;
  name: string;
  commandLine: string;
  createdAtMs: number | null;
  /** How many live descendants hang under this root (they die with it). */
  descendants: number;
}

/** Processes that appear on their own during any command window and are
 *  never an agent's service: console hosts, crash reporters, Windows
 *  background machinery, and the helper daemons git/gpg/ssh spawn for
 *  themselves. Matched on the bare executable name, case-insensitive. */
const SYSTEM_NOISE = new Set([
  "conhost", "werfault", "werfaultsecure", "svchost", "runtimebroker", "dllhost", "backgroundtaskhost",
  "searchprotocolhost", "searchfilterhost", "wmiprvse", "taskhostw", "sihost", "ctfmon", "compattelrunner",
  "mousocoreworker", "smartscreen", "securityhealthhost", "securityhealthservice", "microsoftedgeupdate",
  "googleupdate", "onedrive", "textinputhost", "shellexperiencehost", "startmenuexperiencehost",
  "applicationframehost", "systemsettings", "lockapp", "wudfhost", "audiodg", "csrss", "wininit", "winlogon",
  "lsass", "services", "spoolsv", "fontdrvhost", "msmpeng", "mpdefendercoreservice", "nissrv", "dwm",
  "gpg-agent", "ssh-agent", "dirmngr", "scdaemon", "keyboxd", "git-credential-manager",
  "git-credential-manager-core", "ps", "tasklist", "wmic", "defunct",
]);
const NOISE_COMMANDLINE = /fsmonitor--daemon|credential-manager|--type=(?:gpu-process|utility|renderer|zygote|crashpad)/i;

export function bareName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/** Does this command text look like it could leave a process behind?
 *  Deliberately broad — the listing it gates is cheap, a missed orphan is
 *  not. */
export function mayDetachProcesses(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  return /(?:^|[\s;&|(])(?:start-process|start-job|start|nohup|setsid|disown|screen|tmux|pm2|forever|daemonize|systemd-run|open)\b/i.test(text)
    || /-WindowStyle\b|-NoExit\b|\bcmd(?:\.exe)?\s+\/[ck]\s+start\b|\bexplorer(?:\.exe)?\s/i.test(text)
    || /&\s*(?:$|\)|;|&&|\|\||#)/m.test(text) // job control: `cmd &`, `(cmd &)`
    || /\bnpx\s+electron\b|\belectron\b|\bcargo\s+run\b|\bgo\s+run\b|\bjava\s+-jar\b|\bdotnet\s+(?:run|watch)\b|\bgradlew?\b.*\bbootrun\b|\bmvn\b.*\bspring-boot:run\b/i.test(text)
    || /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|\bvite\b|\bnext\s+dev\b|\bnodemon\b|\bserve\b|\bhttp-server\b|\blive-server\b/i.test(text)
    || /\buvicorn\b|\bgunicorn\b|\bflask\s+run\b|\bmanage\.py\s+runserver\b|\bpython3?\s+-m\s+http\.server\b|\brails\s+s(?:erver)?\b|\bphp\s+-S\b|\bdocker\s+compose\s+up\b/i.test(text)
    || /\b--daemon\b|\b-d\s*$|\b--detach(?:ed)?\b|\b--background\b|\b-WindowStyle\s+Hidden\b/i.test(text);
}

export interface PickSurvivorsOptions {
  /** The pid of the shell that ran the command (dead by now, or being killed). */
  rootPid: number | undefined;
  /** When the command started; anything created earlier is not ours. */
  startedAtMs: number;
  /** This host process — never a survivor. */
  selfPid: number;
  /** Liveness oracle (process.kill(pid, 0) in production). */
  alive: (pid: number) => boolean;
  /** Clock skew between the snapshot's timestamps and ours. */
  slackMs?: number;
}

/** Pure selection: which of these rows did the command leave behind?
 *  Returns one entry per TREE ROOT — descendants die with their root when it
 *  is killed with /T or by process group. */
export function pickSurvivors(rows: readonly ProcessRow[], opts: PickSurvivorsOptions): SurvivorTree[] {
  const slack = opts.slackMs ?? 1_500;
  const since = opts.startedAtMs - slack;
  const candidates = rows.filter((row) =>
    Number.isSafeInteger(row.pid) && row.pid > 0
    && row.pid !== opts.selfPid
    && row.pid !== opts.rootPid
    && (row.createdAtMs === null || row.createdAtMs >= since)
    && opts.alive(row.pid),
  );
  const fresh = new Map(candidates.map((row) => [row.pid, row]));
  const ours = (row: ProcessRow, seen = new Set<number>()): boolean => {
    if (row.ppid === opts.rootPid) return true;
    if (seen.has(row.pid)) return false;
    seen.add(row.pid);
    const parent = fresh.get(row.ppid);
    if (parent) return ours(parent, seen);
    // The parent is gone: a wrapper (`cmd /c start`, the shell itself) that
    // launched this and exited. Not reachable from anything that was alive
    // before the command, so it is ours.
    return !opts.alive(row.ppid);
  };
  const survivors = candidates.filter((row) => ours(row));
  const survivorPids = new Set(survivors.map((row) => row.pid));
  const roots = survivors.filter((row) => !survivorPids.has(row.ppid));
  const countDescendants = (pid: number): number =>
    survivors.filter((row) => row.ppid === pid).reduce((sum, child) => sum + 1 + countDescendants(child.pid), 0);
  return roots
    .filter((row) => !SYSTEM_NOISE.has(bareName(row.name)) && !NOISE_COMMANDLINE.test(row.commandLine))
    .map((row) => ({
      pid: row.pid,
      name: row.name,
      commandLine: row.commandLine,
      createdAtMs: row.createdAtMs,
      descendants: countDescendants(row.pid),
    }));
}

export interface ListDeps {
  platform?: NodeJS.Platform;
  /** Run a program and return its stdout (injectable for tests). */
  exec?: (program: string, args: string[], timeoutMs: number) => Promise<string>;
}

function execCapture(program: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`${program} listing timed out`)); }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}

/** Every process created at or after `sinceMs`, with its parent. */
export async function listProcessesSince(sinceMs: number, deps: ListDeps = {}): Promise<ProcessRow[]> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? execCapture;
  if (platform === "win32") {
    const since = new Date(sinceMs).toISOString();
    const script = [
      `$s=[datetime]::Parse('${since}').ToUniversalTime()`,
      "$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -and $_.CreationDate.ToUniversalTime() -ge $s } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={[int64](($_.CreationDate.ToUniversalTime()-[datetime]'1970-01-01').TotalMilliseconds)}})",
      "ConvertTo-Json -InputObject $rows -Compress -Depth 2",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const out = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], 15_000);
    return parseWindowsRows(out);
  }
  const out = await exec("ps", ["-eo", "pid=,ppid=,etime=,comm=,args="], 10_000);
  return parsePsRows(out, Date.now()).filter((row) => row.createdAtMs === null || row.createdAtMs >= sinceMs - 2_000);
}

export function parseWindowsRows(json: string): ProcessRow[] {
  const text = json.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  return list.flatMap((item) => {
    const row = item as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown; Created?: unknown };
    const pid = Number(row.ProcessId);
    const ppid = Number(row.ParentProcessId);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return [];
    const created = Number(row.Created);
    return [{
      pid,
      ppid,
      name: typeof row.Name === "string" ? row.Name : "",
      commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "",
      createdAtMs: Number.isFinite(created) && created > 0 ? created : null,
    }];
  });
}

/** `ps -eo pid=,ppid=,etime=,comm=,args=` → rows. etime is [[dd-]hh:]mm:ss. */
export function parsePsRows(text: string, nowMs: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const etime = m[3]!;
    let seconds: number | null = null;
    const parts = etime.split("-");
    const days = parts.length === 2 ? Number(parts[0]) : 0;
    const clock = (parts.length === 2 ? parts[1] : parts[0])!.split(":").map(Number);
    if (clock.every((n) => Number.isFinite(n))) {
      const [a, b, c] = clock.length === 3 ? clock : clock.length === 2 ? [0, clock[0], clock[1]] : [0, 0, clock[0]];
      seconds = days * 86_400 + (a ?? 0) * 3_600 + (b ?? 0) * 60 + (c ?? 0);
    }
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: m[4]!,
      commandLine: m[5] ?? "",
      createdAtMs: seconds === null ? null : nowMs - seconds * 1_000,
    });
  }
  return rows;
}

export interface FindSurvivorsOptions extends ListDeps {
  rootPid: number | undefined;
  startedAtMs: number;
  selfPid?: number;
  alive?: (pid: number) => boolean;
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = exists but not ours to signal — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The trees a finished command left running. Never throws: a listing that
 *  fails means "none found", never a broken turn. */
export async function findSurvivors(opts: FindSurvivorsOptions): Promise<SurvivorTree[]> {
  try {
    const rows = await listProcessesSince(opts.startedAtMs - 2_000, opts);
    return pickSurvivors(rows, {
      rootPid: opts.rootPid,
      startedAtMs: opts.startedAtMs,
      selfPid: opts.selfPid ?? process.pid,
      alive: opts.alive ?? processAlive,
    });
  } catch {
    return [];
  }
}

export interface AdoptLeftoversOptions extends FindSurvivorsOptions {
  registry: ShellRegistry;
  /** The command that launched them, for the record and the panel. */
  command: string;
  cwd: string;
  sessionId?: string;
  invocationKey?: string;
}

/** Find what a foreground command left behind and register each tree as a
 *  running job the session owns. Returns the new snapshots (empty when
 *  nothing survived). */
export async function adoptLeftovers(opts: AdoptLeftoversOptions): Promise<ShellSnapshot[]> {
  const trees = await findSurvivors(opts);
  const adopted: ShellSnapshot[] = [];
  for (const tree of trees) {
    try {
      adopted.push(await opts.registry.adopt({
        pid: tree.pid,
        name: tree.name,
        commandLine: tree.commandLine,
        cwd: opts.cwd,
        launchedBy: opts.command,
        sessionId: opts.sessionId,
        invocationKey: opts.invocationKey,
      }));
    } catch {
      // One unregisterable tree must not fail the command that already ran.
    }
  }
  return adopted;
}

/** One line for the tool result, so the model knows what it left running
 *  and how to stop it. */
export function describeAdopted(adopted: readonly ShellSnapshot[]): string | undefined {
  if (adopted.length === 0) return undefined;
  const names = adopted.map((job) => `${job.description} (shell_id ${job.id})`).join(", ");
  return `this command left ${adopted.length === 1 ? "a process" : `${adopted.length} processes`} running — ${names}. Ares now tracks ${adopted.length === 1 ? "it" : "them"} as background job${adopted.length === 1 ? "" : "s"}: poll with BashOutput, stop with KillShell when you are done. Anything still running is stopped when this chat closes or Ares exits.`;
}
