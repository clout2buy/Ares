// deployChange: move the LIVE checkout (default ~/Ares) to a verified sha, restart the service,
// prove it works, and put everything back by itself if it does not.
//
// Order of play (every refusal happens BEFORE anything on disk changes):
//   lock -> fetch -> resolve sha -> approved branch -> signed GREEN result -> recompute risk/secrets
//   -> fast-forward possible -> owner approval -> (dry-run stops here) -> idle gate / drain
//   -> baseline smoke -> ff -> install -> build -> restart -> READY -> smoke -> record + phone push.
// Any failure after the fast-forward rolls back: reset to the recorded sha, rebuild, restart, READY.
//
// Nothing here prints or stores a secret: the gateway token is read from <home>/garrison/token
// and only ever sent as a Bearer header to 127.0.0.1; records pass through redact().

import path from "node:path";
import { promises as fsp } from "node:fs";
import { createInterface } from "node:readline";
import {
  aresHome, approvedBranchPatterns, branchApproved, clip, deploysDir, git, lockFile, loadKey, nowIso, outboxDir,
  readJson, redact, resultsDir, run, shortSha, sleep, verifySignature, writeJsonAtomic,
} from "./common.mjs";
import { analyzeChange } from "./risk.mjs";

export const EXIT = { ok: 0, refused: 1, busy: 3, rolledBack: 4, rollbackFailed: 5, locked: 6 };
const RESULT_MAX_AGE_MS = 72 * 3_600_000;
const RECEIPT_MAX_AGE_MS = 24 * 3_600_000;
const LOCK_STALE_MS = 2 * 3_600_000;

/** Redact every string VALUE (never the JSON structure) so a secret cannot reach a record. */
function redactDeep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

// ---------------------------------------------------------------- lock

export async function acquireLock(home, info) {
  const file = lockFile(home);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ ...info, pid: process.pid, at: nowIso() });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // link() is atomic and fails with EEXIST: whoever creates the name first wins, and the
        // file is never visible half-written (a plain open("wx") + write races a reader).
        await fsp.link(tmp, file);
        return { ok: true, release: async () => { await fsp.rm(file, { force: true }); } };
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
        const held = await readJson(file);
        const mtimeAge = await fsp.stat(file).then((s) => Date.now() - s.mtimeMs).catch(() => Infinity);
        const age = Date.now() - (Date.parse(held?.at ?? "") || 0);
        const stale = held?.pid ? !pidAlive(held.pid) || age > LOCK_STALE_MS : mtimeAge > 60_000;
        if (stale) { await fsp.rm(file, { force: true }); continue; }
        return { ok: false, holder: held ? { pid: held.pid, sha: held.sha, at: held.at } : null };
      }
    }
    return { ok: false, holder: null };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- http (smoke, idle, notify)

async function call(baseUrl, method, p, { token, body, timeoutMs = 8_000 } = {}) {
  try {
    const res = await fetch(baseUrl + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: String(err?.cause?.code ?? err?.message ?? err) };
  }
}

export async function runSmoke(baseUrl, token, { ask = "on", timeoutMs = 8_000 } = {}) {
  const checks = [];
  const add = (name, ok, detail = "", extra = {}) => checks.push({ name, ok, detail, ...extra });
  let r = await call(baseUrl, "GET", "/health", { timeoutMs });
  add("health", r.status === 200 && r.json?.ok !== false, r.status ? `HTTP ${r.status}` : `unreachable (${r.error})`);
  r = await call(baseUrl, "GET", "/gateway/health", { token, timeoutMs });
  add("gateway-health", r.status === 200 && r.json?.ok !== false, r.status ? `HTTP ${r.status}` : `unreachable (${r.error})`);
  r = await call(baseUrl, "GET", "/gateway/health/deep", { token, timeoutMs: Math.max(timeoutMs, 20_000) });
  if (r.status === 404) add("health-deep", true, "not present on this build", { skipped: true });
  else add("health-deep", r.status === 200 && r.json?.ok !== false, r.status ? `HTTP ${r.status}${r.json?.ok === false ? " ok:false" : ""}` : `unreachable (${r.error})`);
  for (const [name, p] of [["goals", "/gateway/goals"], ["memory", "/gateway/memory"]]) {
    r = await call(baseUrl, "GET", p, { token, timeoutMs });
    add(name, r.status === 200, r.status ? `HTTP ${r.status}` : `unreachable (${r.error})`);
  }
  if (ask !== "off") {
    r = await call(baseUrl, "POST", "/gateway/ask", { token, body: { text: "Deploy smoke test. Reply with exactly: ARES-SMOKE-OK" }, timeoutMs: 40_000 });
    const ok = r.status === 200 && typeof r.json?.reply === "string" && r.json.reply.length > 0;
    add("ask", ok, r.status ? `HTTP ${r.status}${r.json?.status ? ` ${r.json.status}` : ""}` : `unreachable (${r.error})`, ask === "warn" ? { soft: true } : {});
  }
  return checks;
}

async function activeTurns(baseUrl, token) {
  let r = await call(baseUrl, "GET", "/gateway/maintainer", { token, timeoutMs: 5_000 });
  if (r.status === 200 && Number.isFinite(r.json?.activeTurns)) return { known: true, n: r.json.activeTurns };
  r = await call(baseUrl, "GET", "/gateway/control", { token, timeoutMs: 5_000 });
  if (r.status === 200 && Number.isFinite(r.json?.running)) return { known: true, n: r.json.running };
  if (r.status === 200 && r.json?.running && typeof r.json.running === "object") {
    return { known: true, n: Object.values(r.json.running).filter((v) => Number.isFinite(v)).reduce((a, b) => a + b, 0) };
  }
  return { known: false, n: 0 };
}

async function waitReady(baseUrl, timeoutMs, pollMs) {
  const end = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < end) {
    const r = await call(baseUrl, "GET", "/health", { timeoutMs: 3_000 });
    streak = r.status === 200 && r.json?.ok !== false ? streak + 1 : 0;
    if (streak >= 2) return true; // two in a row: not a dying process answering its last request
    await sleep(pollMs);
  }
  return false;
}

// ---------------------------------------------------------------- owner approval

async function confirmOnTty(prompt, expected) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise((resolve) => rl.question(`${prompt}\nType "${expected}" to continue: `, resolve));
    return String(answer).trim() === expected;
  } finally { rl.close(); }
}

/** Verify a signed approval receipt written by the Maintainer when the OWNER approved. */
export function checkReceipt(doc, { key, sha, now = Date.now() }) {
  if (!verifySignature(doc, key)) return { ok: false, why: "approval receipt signature is invalid" };
  const p = doc.payload;
  if (p.kind !== "deploy-approval" || p.sha !== sha) return { ok: false, why: "approval receipt is for a different commit" };
  if (p.approvedBy !== "owner") return { ok: false, why: "approval receipt was not issued for the owner's decision" };
  const age = now - (Date.parse(p.approvedAt) || 0);
  if (!(age >= -60_000 && age <= RECEIPT_MAX_AGE_MS)) return { ok: false, why: "approval receipt is stale" };
  return { ok: true, receipt: p };
}

// ---------------------------------------------------------------- the deploy

/**
 * @param {object} o  see scripts/elite/ares-deploy.mjs for the CLI mapping.
 */
export async function deployChange(o) {
  const home = o.home ?? aresHome();
  const live = path.resolve(o.live);
  const service = o.service ?? "ares-garrison";
  const baseUrl = (o.baseUrl ?? `http://127.0.0.1:${process.env.ARES_REMOTE_AGENT_PORT || 7422}`).replace(/\/+$/, "");
  const pollMs = o.pollMs ?? 2_000;
  const readyTimeoutMs = o.readyTimeoutMs ?? 120_000;
  const log = o.log ?? (() => {});
  const sudo = o.sudo ?? process.env.ARES_DEPLOY_SUDO ?? (typeof process.getuid === "function" && process.getuid() === 0 ? "" : "sudo -n");
  const cmds = {
    install: o.commands?.install ?? "pnpm install --frozen-lockfile",
    build: o.commands?.build ?? "pnpm build",
    restart: o.commands?.restart ?? `${sudo} systemctl restart ${service}`.trim(),
  };
  if (!/^[\w@.-]+$/.test(service)) throw new Error(`bad service name: ${service}`);
  const token = await fsp.readFile(path.join(home, "garrison", "token"), "utf8").then((t) => t.trim()).catch(() => "");

  const rec = {
    id: `dep_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    dryRun: o.dryRun === true,
    requestedBy: o.requestedBy ?? "cli",
    proposalId: o.proposalId ?? null,
    sha: null, branch: null, previousSha: null, title: o.title ?? null,
    approval: null, risk: null, verified: null, steps: [], smoke: {}, drained: null, rollback: null, reason: null,
  };
  const step = (name, ok, detail = "", ms = 0) => { rec.steps.push({ name, ok, ms, detail: clip(detail, 400) }); log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${clip(detail, 200)}` : ""}`); };
  const file = () => path.join(deploysDir(home), `${rec.startedAt.replace(/[-:]/g, "").replace(/\..*/, "")}-${shortSha(rec.sha ?? "none")}-${rec.id.slice(-4)}.json`);
  const save = async () => { if (!rec.dryRun) await writeJsonAtomic(file(), redactDeep(rec)); };

  const notify = async (title, body, extra = {}) => {
    if (rec.dryRun || o.notify === false) return;
    const msg = { id: `${rec.id}-${Math.random().toString(36).slice(2, 6)}`, title: clip(title, 120), body: clip(body, 300), at: nowIso(), data: { kind: "deploy", deployId: rec.id, status: rec.status, sha: shortSha(rec.sha), ...extra } };
    const f = path.join(outboxDir(home), `${msg.id}.json`);
    await writeJsonAtomic(f, msg).catch(() => {});
    const r = await call(baseUrl, "POST", "/gateway/maintainer/notify", { token, body: msg, timeoutMs: 6_000 });
    if (r.status === 200) await fsp.rm(f, { force: true }).catch(() => {});
  };

  const finish = async (status, exitCode, reason) => {
    rec.status = status; rec.reason = reason ? clip(reason, 300) : rec.reason; rec.finishedAt = nowIso();
    await save();
    return { status, exitCode, record: rec, recordFile: rec.dryRun ? null : file() };
  };
  const refuse = async (why, code = EXIT.refused, status = "refused") => { step("precheck", false, why); return finish(status, code, why); };

  // ---- lock (read-only peek for a dry run)
  let lock = null;
  if (o.dryRun) {
    const held = await readJson(lockFile(home));
    if (held?.pid && pidAlive(held.pid)) step("lock", true, `note: a deploy by pid ${held.pid} is running now`);
  } else {
    lock = await acquireLock(home, { id: rec.id, sha: o.sha ?? o.branch ?? null });
    if (!lock.ok) return refuse(`another deploy is in progress (pid ${lock.holder?.pid ?? "?"}, since ${lock.holder?.at ?? "?"})`, EXIT.locked, "refused-locked");
  }

  let moved = false;
  let doRollback = null;
  try {
    // ---- live checkout sanity
    const head = await git(live, ["rev-parse", "HEAD"]);
    if (head.code !== 0) return refuse(`${live} is not a git checkout`);
    rec.previousSha = head.stdout.trim();
    const dirty = await git(live, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.stdout.trim()) return refuse(`live checkout has uncommitted changes (${dirty.stdout.trim().split("\n").length} file(s)); refusing to deploy over them`);
    const onBranch = (await git(live, ["symbolic-ref", "-q", "--short", "HEAD"])).stdout.trim();

    // ---- fetch + resolve
    const from = o.fetchFrom ?? process.env.ARES_DEPLOY_FETCH_FROM ?? "rook";
    const remoteName = /[\\/:]/.test(from) ? "forge" : from;
    const fetched = await git(live, ["fetch", "-q", "--no-tags", from, `+refs/heads/*:refs/remotes/${remoteName}/*`], { timeoutMs: 300_000 });
    step("fetch", fetched.code === 0, fetched.code === 0 ? from : clip(fetched.stderr, 200));
    let sha = o.sha;
    if (!sha && o.branch) sha = `${remoteName}/${o.branch}`;
    if (!sha) return refuse("nothing to deploy: pass --sha or --branch");
    const resolved = await git(live, ["rev-parse", "--verify", `${sha}^{commit}`]);
    if (resolved.code !== 0) return refuse(`cannot resolve "${sha}" in ${live}${fetched.code ? " (and the fetch failed)" : ""}`);
    sha = resolved.stdout.trim();
    rec.sha = sha;

    // ---- approved branch
    const patterns = await approvedBranchPatterns(home);
    const containing = (await git(live, ["branch", "-r", "--contains", sha, "--format=%(refname:short)"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean)
      .map((b) => b.replace(new RegExp(`^${remoteName}/`), "")).filter((b) => b !== "HEAD" && !b.endsWith("/HEAD"));
    rec.branch = o.branch ?? containing.find((b) => branchApproved(b, patterns)) ?? containing[0] ?? null;
    if (!containing.some((b) => branchApproved(b, patterns))) {
      return refuse(`${shortSha(sha)} is not on an approved branch (patterns: ${patterns.join(", ")}; found on: ${containing.join(", ") || "no remote branch"})`);
    }
    step("approved-branch", true, rec.branch ?? "");

    // ---- signed GREEN result
    const doc = await readJson(path.join(resultsDir(home), `${sha}.json`));
    if (!doc) return refuse(`no verification result for ${shortSha(sha)}; run ares-verify first`);
    const key = loadKey({ home, create: false });
    if (!key) return refuse("no verification signing key on this box; cannot check the result");
    if (!verifySignature(doc, key)) return refuse("verification result signature is invalid (tampered, or signed with another key)");
    const pl = doc.payload;
    if (pl.sha !== sha) return refuse("verification result is for a different commit");
    const tree = (await git(live, ["rev-parse", `${sha}^{tree}`])).stdout.trim();
    if (pl.tree !== tree) return refuse("verification result does not match this commit's tree");
    if (pl.green !== true) return refuse(`verification result is RED (${(pl.steps ?? []).filter((s) => !s.ok).map((s) => s.name).join(", ") || "failed"})`);
    if (Date.now() - (Date.parse(pl.verifiedAt) || 0) > (o.maxResultAgeMs ?? RESULT_MAX_AGE_MS)) return refuse("verification result is too old; run ares-verify again");
    rec.verified = { at: pl.verifiedAt, tests: pl.tests ?? null };
    step("verified", true, `green, ${pl.tests?.pass ?? "?"}/${pl.tests?.total ?? "?"} tests, verified ${pl.verifiedAt}`);

    // ---- recompute risk/secrets against what is actually live (never trust a stale "low")
    const change = await analyzeChange(live, rec.previousSha, sha).catch((e) => ({ error: String(e?.message ?? e) }));
    if (change.error) return refuse(`could not analyse the change: ${change.error}`);
    if (change.secrets.length) return refuse(`the change adds ${change.secrets.length} possible secret(s): ${change.secrets.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(", ")}`);
    const high = pl.risk?.class === "high" || change.risk.class === "high";
    rec.risk = { class: high ? "high" : change.risk.class, reasons: [...new Set([...(pl.risk?.reasons ?? []), ...change.risk.reasons])].slice(0, 20), files: change.stats.files };
    step("risk", true, `${rec.risk.class}${high ? ` - ${rec.risk.reasons.slice(0, 2).join("; ")}` : ""}`);

    // ---- can we fast-forward?
    if (rec.previousSha === sha) { step("ff", true, "already live"); return finish("already-live", EXIT.ok, "that commit is already live"); }
    const ff = await git(live, ["merge-base", "--is-ancestor", rec.previousSha, sha]);
    if (ff.code !== 0) return refuse(`${shortSha(sha)} is not a fast-forward of the live commit ${shortSha(rec.previousSha)} (live has moved; re-verify on top of it)`);

    // ---- owner approval
    const ack = o.ackHighRisk === true;
    if (o.receiptFile) {
      const rdoc = await readJson(o.receiptFile);
      const chk = checkReceipt(rdoc, { key, sha });
      if (!chk.ok) return refuse(chk.why);
      if (high && chk.receipt.ackHighRisk !== true) return refuse("this is a HIGH-RISK change and the approval receipt does not acknowledge it");
      rec.approval = { by: "owner", via: "receipt", proposalId: chk.receipt.proposalId ?? null, at: chk.receipt.approvedAt };
    } else if (o.yes === true) {
      if (high && !ack) return refuse(`HIGH-RISK change (${rec.risk.reasons.slice(0, 2).join("; ")}): pass --ack-high-risk as well as --yes to deploy it`);
      rec.approval = { by: "operator", via: "cli-flag", at: nowIso() };
    } else if (!o.dryRun) {
      const word = high ? `deploy-high-risk ${shortSha(sha)}` : `deploy ${shortSha(sha)}`;
      if (!(await confirmOnTty(`Deploy ${shortSha(sha)} over ${shortSha(rec.previousSha)} (${rec.risk.class} risk${high ? `: ${rec.risk.reasons.slice(0, 2).join("; ")}` : ""})?`, word))) {
        return refuse("owner approval required: pass --approval-receipt <file> (from the Maintainer), or --yes as an operator, or run interactively");
      }
      rec.approval = { by: "operator", via: "tty", at: nowIso() };
    }
    step("approval", true, rec.approval ? `${rec.approval.via}` : "(dry run: not asked)");

    if (o.dryRun) {
      const idle = await activeTurns(baseUrl, token);
      step("idle", true, idle.known ? `${idle.n} turn(s) running now` : "service not answering");
      step("plan", true, `would: ff ${shortSha(rec.previousSha)} -> ${shortSha(sha)}; ${cmds.install}; ${cmds.build}; ${cmds.restart}; wait READY; smoke; rollback on failure`);
      return finish("dry-run", EXIT.ok, null);
    }
    await save();

    // ---- idle gate
    let idle = await activeTurns(baseUrl, token);
    if (idle.n > 0) {
      if (!o.drainMin) {
        await notify("Deploy waiting", `Not deploying ${rec.title ?? shortSha(sha)}: ${idle.n} conversation(s) mid-turn. Retry with a drain window.`, { reason: "busy" });
        return refuse(`${idle.n} session(s) are mid-turn; wait, or pass --drain <minutes>`, EXIT.busy, "refused-busy");
      }
      await notify("Deploy waiting for idle", `${rec.title ?? shortSha(sha)} will deploy once ${idle.n} running turn(s) finish (waiting up to ${o.drainMin} min).`, { reason: "draining" });
      const end = Date.now() + o.drainMin * 60_000;
      while (idle.n > 0 && Date.now() < end) { await sleep(o.drainPollMs ?? 5_000); idle = await activeTurns(baseUrl, token); }
      rec.drained = { waitedMs: Date.now() - Date.parse(rec.startedAt), stillBusy: idle.n };
      if (idle.n > 0) {
        await notify("Deploy cancelled", `Gave up waiting for idle after ${o.drainMin} min; nothing was changed.`, { reason: "drain-timeout" });
        return refuse(`still ${idle.n} turn(s) running after ${o.drainMin} min`, EXIT.busy, "refused-busy");
      }
      step("drain", true, "idle");
    } else step("idle", true, idle.known ? "no turns running" : "service not answering, nothing to drain");

    // ---- baseline smoke: what already fails now is not the new code's fault
    const askMode = o.smokeAsk ?? "on";
    const before = idle.known ? await runSmoke(baseUrl, token, { ask: askMode }) : [];
    rec.smoke.before = before;
    const baselineBad = new Set(before.filter((c) => !c.ok).map((c) => c.name));
    if (before.length) step("smoke-before", before.every((c) => c.ok), before.filter((c) => !c.ok).map((c) => `${c.name} ${c.detail}`).join("; ") || "all passed");

    // ---- the change itself
    const t0 = Date.now();
    const move = onBranch ? await git(live, ["merge", "--ff-only", "-q", sha]) : await git(live, ["checkout", "-q", "--detach", sha]);
    if (move.code !== 0) return refuse(`could not fast-forward: ${clip(move.stderr, 200)}`);
    moved = true;
    doRollback = rollback;
    step("fast-forward", true, `${shortSha(rec.previousSha)} -> ${shortSha(sha)}`, Date.now() - t0);
    await save();

    const failAndRollback = async (why, restartNeeded) => {
      step("failure", false, why);
      const rb = await rollback(restartNeeded);
      rec.rollback = rb;
      if (rb.ok) {
        await notify("Deploy rolled back", `${rec.title ?? shortSha(sha)} failed (${clip(why, 140)}). Ares is back on ${shortSha(rec.previousSha)}.`, { reason: "rolled-back" });
        return finish("rolled-back", EXIT.rolledBack, why);
      }
      await notify("DEPLOY AND ROLLBACK FAILED", `${rec.title ?? shortSha(sha)}: ${clip(why, 100)}; rollback to ${shortSha(rec.previousSha)} also failed (${clip(rb.why ?? "", 100)}). Needs you.`, { reason: "rollback-failed" });
      return finish("rollback-failed", EXIT.rollbackFailed, `${why}; rollback failed: ${rb.why}`);
    };

    async function rollback(restartNeeded) {
      const out = { ok: false, to: rec.previousSha, steps: [], why: null };
      const rs = (name, ok, detail = "") => { out.steps.push({ name, ok, detail: clip(detail, 300) }); log(`rollback ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${clip(detail, 160)}` : ""}`); return ok; };
      const back = onBranch ? await git(live, ["reset", "--hard", "-q", rec.previousSha]) : await git(live, ["checkout", "-q", "-f", "--detach", rec.previousSha]);
      if (!rs("checkout", back.code === 0, back.stderr)) { out.why = "could not restore the previous commit"; return out; }
      const inst = await run(cmds.install, [], { cwd: live, shell: true, timeoutMs: 900_000 });
      if (!rs("install", inst.code === 0, inst.stderr.split("\n").slice(-2).join(" "))) { out.why = "install failed"; return out; }
      const bld = await run(cmds.build, [], { cwd: live, shell: true, timeoutMs: 900_000 });
      if (!rs("build", bld.code === 0, bld.stderr.split("\n").slice(-2).join(" ") || bld.stdout.split("\n").slice(-2).join(" "))) { out.why = "build failed"; return out; }
      if (restartNeeded) {
        const rst = await run(cmds.restart, [], { shell: true, timeoutMs: 120_000 });
        if (!rs("restart", rst.code === 0, rst.stderr)) { out.why = "restart failed"; return out; }
        if (!rs("ready", await waitReady(baseUrl, readyTimeoutMs, pollMs), "")) { out.why = "service did not come back READY on the previous commit"; return out; }
        const sm = await runSmoke(baseUrl, token, { ask: "off" });
        const bad = sm.filter((c) => !c.ok && !baselineBad.has(c.name));
        if (!rs("smoke", bad.length === 0, bad.map((c) => c.name).join(", "))) { out.why = `smoke failed after rollback: ${bad.map((c) => c.name).join(", ")}`; return out; }
      }
      out.ok = true;
      return out;
    }

    const inst = await (async () => { const t = Date.now(); const r = await run(cmds.install, [], { cwd: live, shell: true, timeoutMs: 900_000 }); step("install", r.code === 0, r.code === 0 ? "" : (r.stderr || r.stdout).split("\n").slice(-3).join(" | "), Date.now() - t); return r; })();
    if (inst.code !== 0) return failAndRollback("pnpm install failed", false);
    const bld = await (async () => { const t = Date.now(); const r = await run(cmds.build, [], { cwd: live, shell: true, timeoutMs: 900_000 }); step("build", r.code === 0, r.code === 0 ? "" : (r.stderr || r.stdout).split("\n").slice(-3).join(" | "), Date.now() - t); return r; })();
    if (bld.code !== 0) return failAndRollback("build failed", false);

    const rst = await run(cmds.restart, [], { shell: true, timeoutMs: 120_000 });
    step("restart", rst.code === 0, rst.code === 0 ? service : (rst.stderr || rst.stdout));
    await save();
    if (rst.code !== 0) return failAndRollback("service restart failed", true);
    const ready = await waitReady(baseUrl, readyTimeoutMs, pollMs);
    step("ready", ready, ready ? "" : `no healthy answer within ${Math.round(readyTimeoutMs / 1000)}s`);
    if (!ready) return failAndRollback("service did not become READY", true);

    const after = await runSmoke(baseUrl, token, { ask: askMode });
    rec.smoke.after = after;
    const regressions = after.filter((c) => !c.ok && !c.soft && (c.name === "health" || !baselineBad.has(c.name)));
    step("smoke-after", regressions.length === 0, regressions.length ? regressions.map((c) => `${c.name} ${c.detail}`).join("; ") : after.filter((c) => !c.ok).length ? `passed (pre-existing: ${after.filter((c) => !c.ok).map((c) => c.name).join(", ")})` : "all passed");
    if (regressions.length) return failAndRollback(`smoke failed: ${regressions.map((c) => c.name).join(", ")}`, true);

    await notify("Ares updated", `${rec.title ?? shortSha(sha)} is live (${shortSha(rec.previousSha)} -> ${shortSha(sha)}). Rollback point recorded.`, { reason: "deployed" });
    return finish("success", EXIT.ok, null);
  } catch (err) {
    step("error", false, String(err?.message ?? err));
    if (moved && doRollback) {
      // An unexpected throw after the live tree moved: put it back rather than leave it half-way.
      const rb = await doRollback(true).catch((e) => ({ ok: false, why: String(e?.message ?? e) }));
      rec.rollback = rb;
      await notify(rb.ok ? "Deploy rolled back" : "DEPLOY AND ROLLBACK FAILED", `${rec.title ?? shortSha(rec.sha)}: unexpected error (${clip(String(err?.message ?? err), 100)}).`, { reason: rb.ok ? "rolled-back" : "rollback-failed" }).catch(() => {});
      return finish(rb.ok ? "rolled-back" : "rollback-failed", rb.ok ? EXIT.rolledBack : EXIT.rollbackFailed, String(err?.message ?? err));
    }
    return finish("error", EXIT.refused, String(err?.message ?? err));
  } finally {
    await lock?.release?.().catch(() => {});
  }
}
