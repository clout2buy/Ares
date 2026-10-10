// Bisect - "it worked before": find the first bad commit automatically.
//
// Runs `git bisect run` in a THROWAWAY detached worktree (never touches the
// owner's checkout, index or branch), with a per-step timeout and a hard cap on
// steps. The command's exit code is the oracle: 0 = good, 1..124 = bad,
// 125 = skip. Returns the culprit sha + subject + files, or a clear reason it
// could not decide.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  buildTool,
  destructiveShellDecision,
  irrecoverableShellRefusal,
  resolveWorkspacePath,
  shellPolicyDecision,
  toolError,
  vaultShellDecision,
} from "./_shared.js";
import { resolveBashProgram } from "./Bash.js";
import { runGit, snapshotRepo } from "./gitUtil.js";

const REF = /^[\w./~^@{}-]+$/;

const inputSchema = z
  .object({
    good: z.string().min(1).describe("A commit/tag/branch where the behavior was still correct."),
    bad: z.string().min(1).default("HEAD").describe("A commit where it is broken (default HEAD)."),
    command: z
      .string()
      .min(1)
      .describe("Shell command run at each step in a clean checkout; exit 0 = good, non-zero = bad, 125 = skip. Include any setup (install/build) it needs."),
    step_timeout_s: z.number().int().min(5).max(900).default(120),
    max_steps: z.number().int().min(2).max(40).default(20),
  })
  .strict();

export interface BisectOutput {
  status: "found" | "inconclusive" | "failed";
  culprit?: { sha: string; subject: string; author?: string; files: string[] };
  steps: number;
  log: string;
  note?: string;
}

function runBisect(cwd: string, command: string, bash: string, perStepMs: number, maxMs: number, signal: AbortSignal): Promise<{ out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // The step script enforces the per-step timeout itself (coreutils timeout
    // when present) so one hung command cannot eat the whole budget. The user's
    // command rides in an env var - never interpolated into shell text.
    const wrapper =
      // `timeout --version` (not `command -v timeout`): on Windows, System32\timeout.exe is a
      // "wait N seconds" command that rejects these arguments and failed every step.
      'if timeout --version 2>/dev/null | grep -q coreutils; then timeout -k 5 "$ARES_BISECT_T" "$ARES_BISECT_BASH" -lc "$ARES_BISECT_CMD"; rc=$?; [ "$rc" -eq 124 ] && exit 1; exit "$rc"; ' +
      'else "$ARES_BISECT_BASH" -lc "$ARES_BISECT_CMD"; fi';
    const child = spawn("git", ["bisect", "run", "sh", "-c", wrapper], {
      cwd,
      windowsHide: true,
      signal,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ARES_BISECT_BASH: bash,
        ARES_BISECT_CMD: command,
        ARES_BISECT_T: String(Math.ceil(perStepMs / 1000)),
      },
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, maxMs);
    child.stdout?.on("data", (c: Buffer) => { out = (out + c.toString("utf8")).slice(-60_000); });
    child.stderr?.on("data", (c: Buffer) => { out = (out + c.toString("utf8")).slice(-60_000); });
    child.on("error", () => { clearTimeout(timer); resolve({ out, timedOut }); });
    child.on("close", () => { clearTimeout(timer); resolve({ out, timedOut }); });
  });
}

export const BisectTool = buildTool({
  name: "Bisect",
  description:
    "Find the commit that broke something: `git bisect run` in a throwaway worktree (your checkout is untouched). Give a known-good ref and a command whose exit code is the oracle (0 good, non-zero bad, 125 skip). Use for 'it worked before' regressions instead of reading history by hand.",
  safety: "workspace-write",
  concurrency: "exclusive",
  watchdogTimeoutMs: 0,
  inputZod: inputSchema,
  activityDescription: (i) => `Bisecting ${i.good}..${i.bad}`,
  commandFor: (i) => i.command,

  async validateInput(i) {
    for (const ref of [i.good, i.bad]) {
      if (!REF.test(ref) || ref.startsWith("-")) return { ok: false, message: `unsafe or malformed ref "${ref}"` };
    }
    return { ok: true };
  },

  async checkPermissions(i, ctx) {
    const vault = vaultShellDecision(i.command);
    if (vault) return vault;
    const configured = ctx.commandPermissions?.decide("Bash", i.command);
    if (configured && configured.kind !== "allow") return configured;
    if (configured?.kind === "allow") return configured;
    return destructiveShellDecision(i.command) ?? shellPolicyDecision(i.command) ?? { kind: "allow" };
  },

  async call(i, ctx): Promise<{ output: BisectOutput; display: string }> {
    const refusal = irrecoverableShellRefusal(i.command);
    if (refusal) throw new Error(refusal);
    const cwd = await resolveWorkspacePath(ctx, undefined, "cwd", "execute");
    const snap = await snapshotRepo(cwd);
    if (!snap.isRepo || !snap.root) throw toolError("Bisect: the workspace is not inside a git repository.");
    const bash = await resolveBashProgram();

    const [good, bad] = await Promise.all([
      runGit(snap.root, ["rev-parse", "--verify", `${i.good}^{commit}`]),
      runGit(snap.root, ["rev-parse", "--verify", `${i.bad}^{commit}`]),
    ]);
    if (good.code !== 0) throw toolError(`Bisect: unknown good ref "${i.good}".`);
    if (bad.code !== 0) throw toolError(`Bisect: unknown bad ref "${i.bad}".`);
    const count = await runGit(snap.root, ["rev-list", "--count", `${good.stdout.trim()}..${bad.stdout.trim()}`]);
    const span = Number(count.stdout.trim());
    if (!Number.isFinite(span) || span < 1) {
      return { output: { status: "inconclusive", steps: 0, log: "", note: `good is not an ancestor of bad (or they are the same commit); nothing to bisect.` }, display: "Bisect: nothing between good and bad" };
    }
    const needed = Math.ceil(Math.log2(span + 1)) + 1;
    if (needed > i.max_steps) {
      throw toolError(`Bisect: ${span} commits need about ${needed} steps; raise max_steps (now ${i.max_steps}) or narrow the range.`);
    }

    const wt = await fs.mkdtemp(path.join(os.tmpdir(), "ares-bisect-"));
    const added = await runGit(snap.root, ["worktree", "add", "--detach", wt, bad.stdout.trim()], { timeoutMs: 60_000 });
    if (added.code !== 0) {
      await fs.rm(wt, { recursive: true, force: true }).catch(() => undefined);
      throw toolError(`Bisect: could not create a scratch worktree: ${added.stderr.trim().slice(0, 300)}`);
    }
    try {
      const start = await runGit(wt, ["bisect", "start", bad.stdout.trim(), good.stdout.trim()], { timeoutMs: 30_000 });
      if (start.code !== 0) throw toolError(`Bisect: git bisect start failed: ${start.stderr.trim().slice(0, 300)}`);
      const budgetMs = (needed + 1) * i.step_timeout_s * 1000;
      const run = await runBisect(wt, i.command, bash, i.step_timeout_s * 1000, budgetMs, ctx.signal);
      // Newer git quotes the term ("is the first 'bad' commit"); older git does not.
      const found = /([0-9a-f]{40}) is the first '?bad'? commit/.exec(run.out);
      const steps = (run.out.match(/running\s/g) ?? []).length;
      const tail = run.out.split(/\r?\n/).slice(-40).join("\n");
      if (!found) {
        const why = run.timedOut
          ? "the bisect exceeded its time budget"
          : /bisect found only 'skip'ped commits|There are only 'skip'ped/.test(run.out)
            ? "every remaining candidate was skipped (exit 125)"
            : /bisect run failed|exited with code 128|unexpected/.test(run.out)
              ? "the command returned a code git cannot interpret, or the good ref is not actually good (the oracle failed at the good commit)"
              : "git did not name a culprit";
        return { output: { status: "inconclusive", steps, log: tail, note: why }, display: `Bisect inconclusive: ${why}` };
      }
      const sha = found[1];
      const show = await runGit(wt, ["show", "--no-patch", "--format=%an%n%s", sha]);
      const [author, subject] = show.stdout.split(/\r?\n/);
      const files = await runGit(wt, ["show", "--name-only", "--format=", sha]);
      return {
        output: {
          status: "found",
          culprit: { sha, subject: subject ?? "", author, files: files.stdout.split(/\r?\n/).filter(Boolean).slice(0, 60) },
          steps,
          log: tail,
        },
        display: `First bad commit ${sha.slice(0, 10)}: ${subject ?? ""}`,
      };
    } finally {
      await runGit(wt, ["bisect", "reset"], { timeoutMs: 15_000 }).catch(() => undefined);
      await runGit(snap.root, ["worktree", "remove", "--force", wt], { timeoutMs: 30_000 }).catch(() => undefined);
      await fs.rm(wt, { recursive: true, force: true }).catch(() => undefined);
      await runGit(snap.root, ["worktree", "prune"], { timeoutMs: 15_000 }).catch(() => undefined);
    }
  },
});
