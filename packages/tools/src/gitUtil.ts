// gitUtil - tiny bounded git runner shared by Diff, Bisect and CodingBackend.
// Never throws; every call has a timeout and an output cap so a huge repo or a
// hung credential helper cannot wedge a turn.

import { spawn } from "node:child_process";

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** git itself was not runnable (ENOENT). */
  missing: boolean;
}

const MAX_BYTES = 8 * 1024 * 1024;

export function runGit(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string; signal?: AbortSignal } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["-c", "core.quotepath=off", "-c", "color.ui=never", ...args], {
        cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        signal: opts.signal,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, missing: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, missing: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, missing });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs ?? 20_000);
    child.stdout?.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BYTES) stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 20_000) stderr += c.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => finish(null, err.code === "ENOENT"));
    child.on("close", (code) => finish(code, false));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.input ?? "");
  });
}

export interface RepoSnapshot {
  isRepo: boolean;
  root?: string;
  branch?: string;
  head?: string;
  /** Porcelain entries: "XY path". */
  dirty: string[];
}

/** HEAD, branch and dirty set. `isRepo:false` when cwd is not in a work tree. */
export async function snapshotRepo(cwd: string): Promise<RepoSnapshot> {
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 8000 });
  if (top.code !== 0) return { isRepo: false, dirty: [] };
  const [head, branch, status] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 8000 }),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 8000 }),
    runGit(cwd, ["status", "--porcelain", "--untracked-files=all"], { timeoutMs: 20_000 }),
  ]);
  return {
    isRepo: true,
    root: top.stdout.trim(),
    head: head.code === 0 ? head.stdout.trim() : undefined,
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    dirty: status.stdout.split(/\r?\n/).filter((l) => l.trim() !== ""),
  };
}

export interface DiffNumstat {
  files: Array<{ path: string; added: number | null; removed: number | null }>;
  added: number;
  removed: number;
}

export function parseNumstat(text: string): DiffNumstat {
  const files: DiffNumstat["files"] = [];
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const a = m[1] === "-" ? null : Number(m[1]);
    const r = m[2] === "-" ? null : Number(m[2]);
    files.push({ path: m[3], added: a, removed: r });
    added += a ?? 0;
    removed += r ?? 0;
  }
  return { files, added, removed };
}

/** Everything changed relative to `base` (default HEAD): tracked numstat + untracked files. */
export async function changedSince(cwd: string, base = "HEAD"): Promise<{ numstat: DiffNumstat; untracked: string[]; ok: boolean }> {
  const [tracked, untracked] = await Promise.all([
    runGit(cwd, ["diff", "--numstat", base, "--"], { timeoutMs: 30_000 }),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard"], { timeoutMs: 20_000 }),
  ]);
  return {
    numstat: parseNumstat(tracked.stdout),
    untracked: untracked.stdout.split(/\r?\n/).filter(Boolean),
    ok: tracked.code === 0,
  };
}
