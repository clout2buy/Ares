// Garrison wiring for the Maintainer: build the real seams (git worktrees in the forge, the
// ares-verify / ares-deploy scripts, the signed approval receipt, the coding runner) and hand the
// garrison three things: the scheduler's `maintainer` hook, the phone API handler, and the
// briefing's "Ares maintenance" facts. Kept out of garrisonCmd.ts so that file gains a few lines.
//
// The routine itself (maintainer/maintainer.ts) knows nothing about git, systemd or models.

import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApprovalQueue, type SessionManager } from "@ares/garrison";
import { appendAudit, registerStoppable } from "@ares/core";
import { createMaintainerApi } from "../maintainer/maintainerApi.js";
import { Maintainer, type DeployOutcome, type VerifyOutcome, type WorktreeOps, type CodingRunner } from "../maintainer/maintainer.js";
import { createTelemetryCollector } from "../maintainer/telemetry.js";
import { createMaintainerCodingRunner } from "./maintainerCoding.js";
import type { CliRuntimeContext } from "./runtime.js";

// ─── The elite scripts (plain .mjs next to the repo; loaded lazily so a desktop build without them still boots) ───

export function eliteDir(): string {
  if (process.env.ARES_ELITE_DIR) return path.resolve(process.env.ARES_ELITE_DIR);
  // dist/entry/maintainerWiring.js -> repo root is four levels up
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "elite");
}

async function loadLib<T = any>(name: string): Promise<T> {
  return (await import(pathToFileURL(path.join(eliteDir(), "lib", name)).href)) as T;
}

function git(repo: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ─── Worktrees in the forge ───────────────────────────────────────────────

export function forgeRoot(env: Record<string, string | undefined> = process.env): string {
  return env.ARES_FORGE_DIR?.trim() ? path.resolve(env.ARES_FORGE_DIR) : path.join(os.homedir(), "forge");
}

export function gitWorktrees(opts: { forgeRepo: string; workRoot: string; liveDir: string; log?: (l: string) => void }): WorktreeOps {
  const { forgeRepo, workRoot, liveDir } = opts;
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  return {
    async liveSha() {
      if (!(await exists(forgeRepo))) return null;
      const head = await git(liveDir, ["rev-parse", "HEAD"]);
      if (head.code !== 0) return null;
      const sha = head.stdout.trim();
      // Make sure the forge knows the live commit (read-only fetch from the live tree), and see what rook has.
      await git(forgeRepo, ["fetch", "-q", "--no-tags", liveDir, "+HEAD:refs/live/head"], 120_000);
      await git(forgeRepo, ["fetch", "-q", "--prune", "rook"], 120_000).catch(() => undefined);
      const have = await git(forgeRepo, ["cat-file", "-e", `${sha}^{commit}`]);
      return have.code === 0 ? sha : null;
    },
    async create(slug, day) {
      const base = (await git(liveDir, ["rev-parse", "HEAD"])).stdout.trim();
      let branch = `auto/${day}-${slug}`;
      for (let n = 2; (await git(forgeRepo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0; n++) branch = `auto/${day}-${slug}-${n}`;
      const dir = path.join(workRoot, branch.replaceAll("/", "-"));
      await fs.mkdir(workRoot, { recursive: true });
      const r = await git(forgeRepo, ["worktree", "add", "-q", "-b", branch, dir, base]);
      if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim().slice(0, 200)}`);
      return { dir, branch, baseSha: base };
    },
    async commit(dir, message) {
      await git(dir, ["add", "-A"]);
      const clean = await git(dir, ["diff", "--cached", "--quiet"]);
      if (clean.code === 0) return { changed: false, sha: (await git(dir, ["rev-parse", "HEAD"])).stdout.trim() };
      const c = await git(dir, ["-c", "user.name=Ares Maintainer", "-c", "user.email=maintainer@ares.invalid", "commit", "-q", "--no-verify", "-m", message]);
      if (c.code !== 0) throw new Error(`git commit failed: ${c.stderr.trim().slice(0, 200)}`);
      return { changed: true, sha: (await git(dir, ["rev-parse", "HEAD"])).stdout.trim() };
    },
    async remove(dir) {
      const real = path.resolve(dir);
      if (!real.startsWith(path.resolve(workRoot) + path.sep)) throw new Error(`refusing to remove ${dir}: not under ${workRoot}`);
      await git(forgeRepo, ["worktree", "remove", "--force", real]);
      await fs.rm(real, { recursive: true, force: true });
      await git(forgeRepo, ["worktree", "prune"]);
    },
  };
}

// ─── Launching ares-deploy so it SURVIVES the restart it causes ───────────

export type DeployLauncher = "system" | "user";

/**
 * ares-deploy restarts ares-garrison, and a service restart kills every process in the unit's cgroup -
 * including a deploy started from inside it, before it could smoke-test or roll back. So the deploy
 * is started as its OWN systemd unit (transient, outside the cgroup). PURE: returns the command.
 */
export function buildDeployLaunch(o: {
  launcher: DeployLauncher;
  unit: string;
  node: string;
  script: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  uid?: number;
  gid?: number;
}): { cmd: string; args: string[] } {
  const setenv = Object.entries(o.env).map(([k, v]) => `--setenv=${k}=${v}`);
  if (o.launcher === "system") {
    return {
      cmd: "sudo",
      args: ["-n", "systemd-run", "--collect", "--quiet", `--unit=${o.unit}`, ...(o.uid !== undefined ? [`--uid=${o.uid}`] : []), ...(o.gid !== undefined ? [`--gid=${o.gid}`] : []), `--working-directory=${o.cwd}`, ...setenv, o.node, o.script, ...o.args],
    };
  }
  return { cmd: "systemd-run", args: ["--user", "--collect", "--quiet", `--unit=${o.unit}`, `--working-directory=${o.cwd}`, ...setenv, o.node, o.script, ...o.args] };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => resolve({ code: err ? 1 : 0 }));
  });
}

/** system (sudo -n systemd-run) if the service user may; else user (systemd-run --user); else null = cannot deploy safely from here. */
export async function probeLauncher(env: Record<string, string | undefined> = process.env): Promise<DeployLauncher | null> {
  const forced = env.ARES_DEPLOY_LAUNCHER;
  if (forced === "system" || forced === "user") return forced;
  if (forced === "none" || process.platform !== "linux") return null;
  if ((await run("sudo", ["-n", "systemd-run", "--version"], 10_000)).code === 0) return "system";
  if ((await run("systemd-run", ["--user", "--version"], 10_000)).code === 0) return "user";
  return null;
}

// ─── Assembly ─────────────────────────────────────────────────────────────

export interface MaintainerWiringOptions {
  context: Pick<CliRuntimeContext, "aresHome" | "home">;
  sessions: Pick<SessionManager, "list">;
  approvals: ApprovalQueue;
  push?: (message: { title: string; body: string; data?: Record<string, unknown>; collapseId?: string }) => Promise<unknown>;
  isPaused: () => boolean;
  log: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** Tests inject a scripted runner; production uses the real coding machinery. */
  coding?: CodingRunner;
}

export interface MaintainerWiring {
  maintainer: Maintainer;
  api: ReturnType<typeof createMaintainerApi>;
  /** The scheduler's `maintainer` hook. */
  tick: () => Promise<string>;
}

export function startMaintainer(opts: MaintainerWiringOptions): MaintainerWiring {
  const env = opts.env ?? process.env;
  const home = opts.context.aresHome;
  const forge = forgeRoot(env);
  const forgeRepo = path.join(forge, "ares");
  const liveDir = env.ARES_LIVE_DIR?.trim() ? path.resolve(env.ARES_LIVE_DIR) : path.join(os.homedir(), "Ares");
  const audit = (entry: Parameters<typeof appendAudit>[0]) => void appendAudit(entry, home);
  const logLine = (line: string) => opts.log(line);
  const worktrees = gitWorktrees({ forgeRepo, workRoot: path.join(forge, "work"), liveDir, log: logLine });

  const maintainer = new Maintainer({
    home,
    env,
    collect: createTelemetryCollector({ home }),
    coding: opts.coding ?? createMaintainerCodingRunner({ liveDir, log: logLine }),
    worktrees,
    verify: async ({ sha, branch, base }): Promise<VerifyOutcome> => {
      const { verifyChange } = await loadLib("verify.mjs");
      const out = await verifyChange({ sha, branch, base, repo: forgeRepo, liveDir, home, workRoot: path.join(forge, "work"), tmpRoot: path.join(forge, "tmp"), log: logLine });
      const p = out.payload;
      return {
        green: out.green === true,
        resultFile: out.file,
        risk: { class: p.risk.class, reasons: p.risk.reasons ?? [], requiresOwnerApproval: p.risk.requiresOwnerApproval === true },
        tests: p.tests,
        diff: { files: p.diff.files?.length ?? 0, added: p.diff.added ?? 0, deleted: p.diff.deleted ?? 0, paths: (p.diff.files ?? []).slice(0, 30) },
        failedSteps: (p.steps ?? []).filter((s: { ok: boolean }) => !s.ok).map((s: { name: string }) => s.name),
      };
    },
    writeReceipt: async ({ proposalId, sha, ackHighRisk }) => {
      const lib = await loadLib("common.mjs");
      const key = lib.loadKey({ home, create: true });
      const doc = lib.sign({ kind: "deploy-approval", proposalId, sha, approvedBy: "owner", approvedAt: new Date().toISOString(), ackHighRisk }, key);
      const file = path.join(home, "maintainer", "receipts", `${proposalId}.json`);
      await lib.writeJsonAtomic(file, doc);
      return file;
    },
    deploy: async ({ sha, proposalId, title, receiptFile, drainMin }): Promise<DeployOutcome> => {
      const launcher = await probeLauncher(env);
      const script = path.join(eliteDir(), "ares-deploy.mjs");
      if (!launcher) {
        throw new Error(`cannot start a deploy that survives the service restart (no passwordless "sudo systemd-run", no user systemd). Approved and signed; deploy by hand: node ${script} --sha ${sha} --approval-receipt ${receiptFile}`);
      }
      const unit = `ares-deploy-${proposalId.replace(/[^a-z0-9]/gi, "").slice(0, 24)}`;
      const launch = buildDeployLaunch({
        launcher, unit, node: process.execPath, script, cwd: liveDir,
        args: ["--sha", sha, "--approval-receipt", receiptFile, "--drain", String(drainMin), "--live", liveDir, "--fetch-from", forgeRepo, "--proposal", proposalId, "--title", title.slice(0, 100), "--requested-by", "maintainer", "--home", home, "--json"],
        env: {
          HOME: os.homedir(), PATH: env.PATH ?? "", ARES_HOME: home, ARES_LIVE_DIR: liveDir, ARES_FORGE_DIR: forge,
          ...(env.ARES_REMOTE_AGENT_PORT ? { ARES_REMOTE_AGENT_PORT: env.ARES_REMOTE_AGENT_PORT } : {}),
        },
        ...(typeof process.getuid === "function" ? { uid: process.getuid(), gid: process.getgid?.() } : {}),
      });
      const started = await run(launch.cmd, launch.args, 30_000);
      if (started.code !== 0) throw new Error(`could not start the deploy unit (${launch.cmd} exited non-zero)`);
      logLine(`maintainer: deploy of ${sha.slice(0, 8)} started as ${unit}`);
      // The deploy restarts this very process; if we survive to see the end, report it. Otherwise housekeeping reconciles from the record.
      const deadline = Date.now() + (drainMin + 40) * 60_000;
      const dir = path.join(home, "elite", "deploys");
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort().reverse().slice(0, 15);
        for (const n of names) {
          const rec = JSON.parse(await fs.readFile(path.join(dir, n), "utf8").catch(() => "null") ?? "null") as { proposalId?: string; status?: string; reason?: string } | null;
          if (rec?.proposalId === proposalId && rec.status && rec.status !== "running") return { status: rec.status, exitCode: 0, ...(rec.reason ? { reason: rec.reason } : {}), recordFile: n };
        }
      }
      return { status: "unknown", exitCode: 1, reason: "no final deploy record within the time limit" };
    },
    approvals: {
      requestApproval: opts.approvals.requestApproval,
      pending: () => opts.approvals.pending(),
      respond: (d) => opts.approvals.respond(d),
    },
    ...(opts.push ? { push: opts.push } : {}),
    audit,
    isPaused: opts.isPaused,
    activeTurns: () => opts.sessions.list().filter((s) => s.busy).length,
    stoppable: (id, label, stop) => registerStoppable({ kind: "job", id, label, stop }),
    log: logLine,
  });

  const api = createMaintainerApi({
    maintainer,
    ...(opts.push ? { push: opts.push } : {}),
    audit,
    log: logLine,
  });
  return { maintainer, api, tick: () => maintainer.tick() };
}
