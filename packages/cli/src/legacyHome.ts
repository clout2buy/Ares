// The dead legacy home: old Ares data the owner may remove, by his click only.
//
// Field origin: C:\Users\<owner>\AppData\Roaming\Ares\home is the home Ares
// used before "one vault" moved everything to ~/.ares. Nothing in it was
// newer than Aug 16 2026, it held 1.9 GB, and nothing ever said so while the
// disk sat at 84-86% full.
//
// Rules:
//   * Detection is read-only: a candidate qualifies only when it exists, is not
//     the active home, does not contain (and is not inside) the active home or
//     a workspace, and has NO file newer than the stale window (default 30
//     days, ARES_LEGACY_HOME_STALE_DAYS).
//   * ONE owner-facing card per legacy home: an approval in the garrison's
//     queue ("Old Ares data from before August, 1.9 GB, safe to remove?").
//     Approve = Remove, Deny = Keep. A Keep is remembered and never asked again.
//   * Nothing is ever removed without that explicit approval, and the home is
//     re-checked at the moment of the click (still stale, still not active).
//   * Removal goes to the Recycle Bin on Windows when that works; otherwise
//     (or elsewhere) the directory is deleted. ARES_LEGACY_HOME_CHECK=0 turns
//     the whole check off.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LegacyHome {
  dir: string;
  bytes: number;
  files: number;
  /** Epoch ms of the newest file inside. */
  newestMs: number;
}

export interface DetectLegacyOptions {
  /** Directories that may hold an old home. Default: legacyHomeCandidates(). */
  candidates?: string[];
  /** The live ARES home: never a legacy home, nor anything containing it. */
  activeHome: string;
  /** Other directories that must never be inside (or contain) a legacy home. */
  keep?: string[];
  now?: number;
  staleDays?: number;
  /** Stop walking after this many entries (a pathological tree is not "proven stale"). */
  maxEntries?: number;
}

/** %APPDATA%\Ares\home (the pre-"one vault" home) plus ARES_LEGACY_HOME_DIRS. */
export function legacyHomeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  // Where the desktop kept its vault before it converged on ~/.ares (tauri main.rs legacy_desktop_ares_home).
  if (env.APPDATA) out.push(path.join(env.APPDATA, "Ares", "home"));
  else if (env.XDG_CONFIG_HOME) out.push(path.join(env.XDG_CONFIG_HOME, "Ares", "home"));
  for (const d of (env.ARES_LEGACY_HOME_DIRS ?? "").split(path.delimiter).filter(Boolean)) out.push(d);
  return [...new Set(out.map((d) => path.resolve(d)))];
}

function staleDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ARES_LEGACY_HOME_STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

const norm = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Size and newest mtime of a tree; null when it is too big to prove, or unreadable. Symlinks are not followed. */
async function measure(dir: string, maxEntries: number, cutoffMs: number): Promise<{ bytes: number; files: number; newestMs: number } | null> {
  let bytes = 0;
  let files = 0;
  let newestMs = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (++seen > maxEntries) return null;
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      const st = await fs.lstat(full).catch(() => null);
      if (!st) continue;
      files += 1;
      bytes += st.size;
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
      // One fresh file settles it: this home is alive.
      if (st.mtimeMs > cutoffMs) return { bytes, files, newestMs };
    }
  }
  return { bytes, files, newestMs };
}

/** The legacy homes that are provably dead right now. Read-only. */
export async function detectLegacyHomes(opts: DetectLegacyOptions): Promise<LegacyHome[]> {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.staleDays ?? staleDays()) * 86_400_000;
  const keep = [opts.activeHome, ...(opts.keep ?? [])];
  const out: LegacyHome[] = [];
  for (const dir of opts.candidates ?? legacyHomeCandidates()) {
    if (keep.some((k) => inside(k, dir) || inside(dir, k))) continue;
    const st = await fs.lstat(dir).catch(() => null);
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    const m = await measure(dir, opts.maxEntries ?? 200_000, cutoff);
    if (!m || m.files === 0 || m.newestMs > cutoff) continue;
    out.push({ dir: path.resolve(dir), ...m });
  }
  return out;
}

/** "1.9 GB" / "640 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** The card's one line: "Old Ares data from before August, 1.9 GB, safe to remove?" */
export function legacyCardText(home: LegacyHome): string {
  const month = new Date(home.newestMs).toLocaleString("en-US", { month: "long" });
  return `Old Ares data from before ${month}, ${formatBytes(home.bytes)}, safe to remove?`;
}

/** Windows: send a directory to the Recycle Bin. Resolves true when the directory is gone. */
export function recycleOnWindows(dir: string, timeoutMs = 120_000): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  // The path travels in the environment, never through PowerShell quoting.
  const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:ARES_RECYCLE_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: timeoutMs, env: { ...process.env, ARES_RECYCLE_TARGET: dir } },
      () => {
        void fs.lstat(dir).then(() => resolve(false), () => resolve(true));
      },
    );
  });
}

export interface LegacyApprovals {
  requestApproval(staged: { id: string; kind: string; domain: string; irreversibility: "irreversible"; reason: string; preview?: unknown }): Promise<{ verb: string; note?: string }>;
}

export interface LegacyHomeOfferOptions {
  /** Where the Keep decisions are remembered: <home>/housekeeping/legacy-home.json. */
  home: string;
  activeHome: string;
  keep?: string[];
  candidates?: string[];
  approvals: LegacyApprovals;
  now?: () => number;
  /** Recycle-bin seam (tests); default recycleOnWindows. Resolves true when it removed the directory. */
  recycle?: (dir: string) => Promise<boolean>;
  audit?: (entry: { actor: string; action: string; target?: string; result?: string }) => void;
  log?: (line: string) => void;
}

interface LegacyState {
  decisions: Record<string, { decision: "keep" | "removed"; at: string; dir: string }>;
}

const idFor = (dir: string): string => `legacy-home:${createHash("sha256").update(norm(dir)).digest("hex").slice(0, 12)}`;

/**
 * The offer: check() stages at most one card per legacy home and acts only on
 * the owner's answer. Safe to call on every housekeeping tick: a card already
 * waiting is not staged twice, a Keep is final.
 */
export class LegacyHomeOffer {
  private readonly waiting = new Set<string>();
  private readonly stateFile: string;

  constructor(private readonly o: LegacyHomeOfferOptions) {
    this.stateFile = path.join(o.home, "housekeeping", "legacy-home.json");
  }

  private async load(): Promise<LegacyState> {
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as LegacyState;
      return raw && typeof raw.decisions === "object" && raw.decisions ? raw : { decisions: {} };
    } catch {
      return { decisions: {} };
    }
  }

  private async record(id: string, dir: string, decision: "keep" | "removed"): Promise<void> {
    const state = await this.load();
    state.decisions[id] = { decision, at: new Date(this.now()).toISOString(), dir };
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private detect(): Promise<LegacyHome[]> {
    return detectLegacyHomes({ activeHome: this.o.activeHome, keep: this.o.keep, now: this.now(), ...(this.o.candidates ? { candidates: this.o.candidates } : {}) });
  }

  /** Stage a card for each undecided legacy home. Returns the ids staged by THIS call. */
  async check(): Promise<string[]> {
    if (process.env.ARES_LEGACY_HOME_CHECK === "0") return [];
    const state = await this.load();
    const staged: string[] = [];
    for (const home of await this.detect()) {
      const id = idFor(home.dir);
      if (state.decisions[id] || this.waiting.has(id)) continue;
      this.waiting.add(id);
      staged.push(id);
      void this.ask(id, home).finally(() => this.waiting.delete(id));
    }
    return staged;
  }

  private async ask(id: string, home: LegacyHome): Promise<void> {
    const decision = await this.o.approvals.requestApproval({
      id,
      kind: "housekeeping.legacy_home",
      domain: "housekeeping",
      irreversibility: "irreversible",
      reason: `${legacyCardText(home)} Approve to remove it (Recycle Bin when possible); Deny to keep it. Nothing in it changed since ${new Date(home.newestMs).toISOString().slice(0, 10)}.`,
      preview: { dir: home.dir, bytes: home.bytes, files: home.files, newest: new Date(home.newestMs).toISOString() },
    });
    if (decision.verb === "deny") {
      // A timeout or a shutdown is not the owner saying Keep: ask again next time.
      if (/timed out|shutting down/i.test(decision.note ?? "")) return;
      await this.record(id, home.dir, "keep");
      this.o.audit?.({ actor: "owner", action: "housekeeping.legacy_home", target: home.dir, result: "kept" });
      return;
    }
    await this.remove(id, home.dir);
  }

  /** Remove after the owner's approval: re-checked first, recycled when possible, deleted otherwise. */
  private async remove(id: string, dir: string): Promise<void> {
    const still = (await this.detect()).find((h) => norm(h.dir) === norm(dir));
    if (!still) {
      this.o.log?.(`housekeeping: legacy home ${dir} changed since the card was shown; not removed`);
      this.o.audit?.({ actor: "owner", action: "housekeeping.legacy_home", target: dir, result: "error: no longer stale, not removed" });
      return;
    }
    let how = "recycled";
    const recycled = await (this.o.recycle ?? recycleOnWindows)(dir).catch(() => false);
    if (!recycled) {
      how = "deleted";
      await fs.rm(dir, { recursive: true, force: true });
    }
    await this.record(id, dir, "removed");
    this.o.log?.(`housekeeping: legacy home ${dir} ${how} (${formatBytes(still.bytes)})`);
    this.o.audit?.({ actor: "owner", action: "housekeeping.legacy_home", target: dir, result: `${how} ${formatBytes(still.bytes)}` });
  }
}
