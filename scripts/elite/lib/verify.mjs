// verifyChange: build + typecheck + the full suite + a security check for ONE sha, in a throwaway
// worktree, then a signed result file that ares-deploy refuses to deploy without.
//
// The result is an HMAC (key from ARES_VERIFY_KEY or <home>/elite/verify.key, 0600) over the
// canonical JSON of the payload. Anyone who can read the key can forge a result - this is a guard
// against accidents and against an agent that never saw the key, not against root on the box.

import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import {
  aresHome, clip, forgeDir, git, loadKey, nowIso, resultsDir, run, shortSha, sign, writeJsonAtomic,
} from "./common.mjs";
import { analyzeChange } from "./risk.mjs";

export const DEFAULT_STEP_COMMANDS = {
  install: "pnpm install --frozen-lockfile --prefer-offline",
  build: "pnpm build",
  lint: "pnpm lint",
  test: "node --import ./tests/_isolate-home.mjs --test --test-concurrency=4 tests/*.test.mjs",
};

/** Pull counts and failing test names out of node:test output (tap or spec reporter). PURE. */
export function parseTestSummary(output) {
  const text = String(output ?? "");
  const count = (name) => {
    const m = [...text.matchAll(new RegExp(`^(?:#|ℹ)\\s+${name}\\s+(\\d+)\\s*$`, "gm"))].pop();
    return m ? Number(m[1]) : undefined;
  };
  const tests = count("tests");
  const pass = count("pass");
  const fail = count("fail");
  const skipped = count("skipped");
  const failedNames = [];
  for (const m of text.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm)) failedNames.push(m[1].trim());
  for (const m of text.matchAll(/^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) failedNames.push(m[1].trim());
  return {
    total: tests ?? 0,
    pass: pass ?? 0,
    fail: fail ?? 0,
    skipped: skipped ?? 0,
    parsed: tests !== undefined && pass !== undefined && fail !== undefined,
    failedNames: [...new Set(failedNames)].slice(0, 25).map((n) => clip(n, 160)),
  };
}

async function resolveBase(repo, sha, { base, liveDir }) {
  if (base) {
    const r = await git(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
    if (r.code === 0) return { sha: r.stdout.trim(), known: true };
    throw new Error(`base "${base}" is not a commit in ${repo}`);
  }
  if (liveDir) {
    const live = await git(liveDir, ["rev-parse", "HEAD"]);
    if (live.code === 0) {
      const have = await git(repo, ["cat-file", "-e", `${live.stdout.trim()}^{commit}`]);
      if (have.code === 0) return { sha: live.stdout.trim(), known: true };
    }
  }
  const parent = await git(repo, ["rev-parse", "--verify", `${sha}^`]);
  if (parent.code === 0) return { sha: parent.stdout.trim(), known: false };
  return { sha: null, known: false };
}

/**
 * @param {object} o
 * @param {string} o.sha            commit (or ref) to verify
 * @param {string} [o.repo]         git repo holding it (default ~/forge/ares)
 * @param {string} [o.base]         what the change is measured against (default: the live checkout's HEAD)
 * @param {string} [o.liveDir]      live checkout, read-only rev-parse (default $ARES_LIVE_DIR, ~/Ares)
 * @param {string} [o.branch]       branch name to record
 * @param {string} [o.home]         ARES_HOME
 * @param {object} [o.commands]     override install/build/lint/test commands (tests do)
 * @param {boolean} [o.keep]        keep the worktree + tmp for inspection
 * @param {(line:string)=>void} [o.log]
 */
export async function verifyChange(o) {
  const log = o.log ?? (() => {});
  const home = o.home ?? aresHome();
  const repo = path.resolve(o.repo ?? path.join(forgeDir(), "ares"));
  const liveDir = o.liveDir ?? process.env.ARES_LIVE_DIR ?? path.join(os.homedir(), "Ares");
  const commands = { ...DEFAULT_STEP_COMMANDS, ...(o.commands ?? {}) };
  const stepTimeoutMs = (o.stepTimeoutMin ?? 45) * 60_000;

  const full = await git(repo, ["rev-parse", "--verify", `${o.sha}^{commit}`]);
  if (full.code !== 0) throw new Error(`cannot resolve "${o.sha}" in ${repo}`);
  const sha = full.stdout.trim();
  const tree = (await git(repo, ["rev-parse", `${sha}^{tree}`])).stdout.trim();
  const key = loadKey({ home, create: true });
  const base = await resolveBase(repo, sha, { base: o.base, liveDir });
  const steps = [];
  const record = (name, ok, ms, detail = "") => { steps.push({ name, ok, ms, detail: clip(detail, 500) }); log(`${ok ? "ok  " : "FAIL"} ${name} (${Math.round(ms / 1000)}s)${ok || !detail ? "" : `: ${clip(detail, 160)}`}`); };

  // 1. What changed, how risky, any secrets. Cheap, so first: a leaked secret needs no 20-minute suite.
  let change = { files: [], stats: { files: 0, added: 0, deleted: 0 }, risk: { class: "low", reasons: [], protectedFiles: [], dependencyFiles: [], deletedTests: [], weakenedTests: [], hotspots: [] }, secrets: [] };
  let t0 = Date.now();
  if (base.sha) {
    try { change = await analyzeChange(repo, base.sha, sha); record("diff-analysis", true, Date.now() - t0, `${change.stats.files} files, risk ${change.risk.class}`); }
    catch (err) { record("diff-analysis", false, Date.now() - t0, String(err?.message ?? err)); }
  } else record("diff-analysis", false, 0, "no base to compare against");
  record("secret-scan", change.secrets.length === 0, 0, change.secrets.length ? `${change.secrets.length} possible secret(s) added: ${change.secrets.slice(0, 5).map((s) => `${s.file}:${s.line} (${s.rule})`).join(", ")}` : "no secrets in added lines");

  // 2. Throwaway worktree + a clean TMPDIR under ~ (a stray /tmp/package.json fails workspace-freedom).
  const work = path.join(o.workRoot ?? path.join(forgeDir(), "work"), `verify-${shortSha(sha)}-${process.pid}`);
  const tmp = path.join(o.tmpRoot ?? path.join(forgeDir(), "tmp"), `verify-${shortSha(sha)}-${process.pid}`);
  let tests = { total: 0, pass: 0, fail: 0, skipped: 0, parsed: false, failedNames: [] };
  let created = false;
  try {
    await fsp.mkdir(path.dirname(work), { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });
    t0 = Date.now();
    const add = await git(repo, ["worktree", "add", "--detach", work, sha]);
    if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr.trim()}`);
    created = true;
    record("worktree", true, Date.now() - t0, work);

    const env = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, CI: "1", NODE_ENV: "test" };
    delete env.ARES_HOME; // the suite isolates its own home; never let it near the live one
    delete env.ARES_TEST_SHARED_HOME;
    delete env.ARES_VERIFY_KEY; // the suite and the code under test never see the signing key
    for (const step of ["install", "build", "lint", "test"]) {
      if (steps.some((s) => !s.ok && ["install", "build", "lint"].includes(s.name)) && step !== "install") {
        record(step, false, 0, "skipped: an earlier step failed");
        continue;
      }
      t0 = Date.now();
      const r = await run(commands[step], [], { cwd: work, env, shell: true, timeoutMs: stepTimeoutMs, maxBytes: 12_000_000 });
      if (step === "test") {
        tests = parseTestSummary(`${r.stdout}\n${r.stderr}`);
        // A run that crashed before reporting is red, whatever its exit code claims.
        const ok = r.code === 0 && tests.fail === 0 && tests.parsed;
        record("test", ok, Date.now() - t0, ok ? `${tests.pass}/${tests.total} pass, ${tests.skipped} skipped` : r.timedOut ? "timed out" : tests.failedNames.length ? `failing: ${tests.failedNames.slice(0, 3).join("; ")}` : `exit ${r.code}${tests.parsed ? "" : ", no summary"}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
      } else {
        record(step, r.code === 0, Date.now() - t0, r.code === 0 ? "" : r.timedOut ? "timed out" : `exit ${r.code}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
      }
    }
  } catch (err) {
    record("setup", false, 0, String(err?.message ?? err));
  } finally {
    if (!o.keep) {
      if (created) await git(repo, ["worktree", "remove", "--force", work]).catch(() => {});
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      await git(repo, ["worktree", "prune"]).catch(() => {});
    }
  }

  const green = steps.every((s) => s.ok);
  const payload = {
    schema: 1,
    sha,
    tree,
    branch: o.branch ?? null,
    base: base.sha,
    baseKnown: base.known,
    host: os.hostname(),
    verifiedAt: nowIso(),
    green,
    steps,
    tests: { total: tests.total, pass: tests.pass, fail: tests.fail, skipped: tests.skipped, failedNames: tests.failedNames },
    risk: { ...change.risk, requiresOwnerApproval: change.risk.class === "high" },
    diff: { ...change.stats, files: change.files.slice(0, 200).map((f) => `${f.status} ${f.path}`) },
    secrets: change.secrets.slice(0, 20),
  };
  const doc = sign(payload, key);
  const file = path.join(resultsDir(home), `${sha}.json`);
  await writeJsonAtomic(file, doc);
  return { green, file, payload, doc };
}
