// Diff analysis for self-improvement: what did this change touch, how risky is that, and did it
// add anything that looks like a secret? One source of truth, used by ares-verify (which signs the
// answer), by ares-deploy (which recomputes it - a stale or forged "low" never lowers the bar) and
// by the Maintainer (which labels the owner's approval card with it).

import { git } from "./common.mjs";

/** Files whose change can weaken what stops Ares from doing harm. A diff touching any is HIGH RISK. */
export const PROTECTED_PATHS = [
  { re: /^packages\/cli\/src\/policyGate[^/]*\.ts$/, why: "policy gate" },
  { re: /^packages\/cli\/src\/permissionPolicy\.ts$/, why: "permission policy" },
  { re: /^packages\/cli\/src\/entry\/permissions\.ts$/, why: "permission prompts" },
  { re: /^packages\/core\/src\/ownerPause[^/]*$/, why: "owner pause" },
  { re: /^packages\/core\/src\/ownerControl[^/]*$/, why: "owner control / kill switch" },
  { re: /^packages\/effects\/src\/(approval|killSwitch|policy|rails|budget|ledger)[^/]*$/, why: "effects rails / approvals / kill switch" },
  { re: /^packages\/garrison\/src\/token\.ts$/, why: "gateway token" },
  { re: /^packages\/garrison\/src\/approvals[^/]*$/, why: "approval queue" },
  { re: /^packages\/cli\/src\/phoneApprovals\.ts$/, why: "approvals from the phone" },
  { re: /^packages\/cli\/src\/phoneOwnerControl\.ts$/, why: "owner control routes" },
  { re: /^packages\/cli\/src\/keyVault\.ts$/, why: "key vault" },
  { re: /^packages\/cli\/src\/maintainer\//, why: "the Maintainer itself" },
  { re: /^packages\/cli\/src\/entry\/maintainer[^/]*\.ts$/, why: "the Maintainer itself" },
  { re: /^scripts\/elite\//, why: "the verify/deploy guardrails" },
  { re: /^\.github\/workflows\//, why: "CI / release workflows" },
  { re: /(^|\/)[^/]*\.service$/, why: "systemd unit" },
];

/** Looser, name-based: auth, secrets, credentials. Tests and docs that merely mention them do not count. */
const SENSITIVE_NAME = /(vault|oauth|secret|credential|passw(or)?d|auth(?!or)|token|remoteDevice|remoteEnrollment|remoteDeviceCrypto)/i;
const NOT_SENSITIVE = /^(tests\/|docs\/|[^/]+\.md$)/;

const DEPENDENCY_FILES = /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|(.*\/)?package\.json)$/;
const DEP_LINE = /^[+-]\s*"(?!version")(@?[\w./-]+)":\s*"(workspace:|npm:|github:|file:|latest|\*|[\^~<>=]?\d)/;

const TEST_FILE = /^tests\/|\.test\.[mc]?[jt]sx?$|\.spec\.[mc]?[jt]sx?$/;
const TEST_DECL = /^[+-]\s*(test|it|describe)(\.\w+)?\s*\(/;

/** Shared hotspots: not high risk, but worth a closer look (medium). */
const HOTSPOTS = [
  /^packages\/core\/src\/queryEngine\.ts$/,
  /^packages\/cli\/src\/entry\/garrisonCmd\.ts$/,
  /^packages\/cli\/src\/remoteAgentServer\.ts$/,
  /^packages\/garrison\/src\/(sessions|scheduler|server)\.ts$/,
  /^packages\/cli\/src\/entry\/prompt\//,
  /^packages\/tools\/src\/index\.ts$/,
];

const SECRET_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["API secret key", /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/],
  ["hard-coded credential", /\b(?:password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{16,}["']/i],
];
const SECRET_IGNORE_MARK = "ares-secret-scan: ignore";

/** Scan the ADDED lines of a unified diff (-U0). Returns [{file, line, rule}] - never the matched text. */
export function scanDiffForSecrets(diffText) {
  const found = [];
  let file = "";
  let line = 0;
  for (const raw of String(diffText).split("\n")) {
    if (raw.startsWith("+++ ")) { file = raw.slice(4).replace(/^b\//, ""); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const text = raw.slice(1);
    if (!text.includes(SECRET_IGNORE_MARK)) {
      for (const [rule, re] of SECRET_PATTERNS) {
        if (re.test(text)) { found.push({ file, line, rule }); break; }
      }
    }
    line++;
  }
  return found;
}

/** Split a unified diff into per-file bodies. */
function perFile(diffText) {
  const out = new Map();
  let cur = null;
  for (const raw of String(diffText).split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (m) { cur = m[2]; out.set(cur, []); continue; }
    if (cur) out.get(cur).push(raw);
  }
  return out;
}

/**
 * Classify a change set. `files` = [{path, status: A|M|D|R, added, deleted}], `diffText` = the -U0 diff.
 * PURE. Returns {class: "low"|"medium"|"high", reasons: string[], protectedFiles, dependencyFiles, deletedTests, weakenedTests, hotspots}.
 */
export function classifyChange(files, diffText = "") {
  const protectedFiles = [];
  const reasons = [];
  const dependencyFiles = [];
  const deletedTests = [];
  const weakenedTests = [];
  const hotspots = [];
  const bodies = perFile(diffText);

  for (const f of files) {
    const p = f.path;
    const prot = PROTECTED_PATHS.find((r) => r.re.test(p));
    if (prot) { protectedFiles.push(p); reasons.push(`touches ${prot.why}: ${p}`); }
    else if (!NOT_SENSITIVE.test(p) && SENSITIVE_NAME.test(p)) { protectedFiles.push(p); reasons.push(`touches an auth/secret/credential file: ${p}`); }
    if (DEPENDENCY_FILES.test(p)) {
      const lockfile = /pnpm-lock|pnpm-workspace|\.npmrc/.test(p);
      const depLines = (bodies.get(p) ?? []).some((l) => DEP_LINE.test(l));
      if (lockfile || depLines) { dependencyFiles.push(p); reasons.push(`changes dependencies: ${p}`); }
    }
    if (TEST_FILE.test(p)) {
      if (f.status === "D") { deletedTests.push(p); reasons.push(`deletes a test file: ${p}`); }
      else {
        const body = bodies.get(p) ?? [];
        const removed = body.filter((l) => l.startsWith("-") && TEST_DECL.test(l)).length;
        const added = body.filter((l) => l.startsWith("+") && TEST_DECL.test(l.replace(/^\+/, "+"))).length;
        if (removed > added) { weakenedTests.push(p); reasons.push(`removes more tests than it adds in ${p} (${removed} out, ${added} in)`); }
      }
    }
    if (HOTSPOTS.some((re) => re.test(p))) hotspots.push(p);
  }

  const high = protectedFiles.length > 0 || dependencyFiles.length > 0 || deletedTests.length > 0 || weakenedTests.length > 0;
  return {
    class: high ? "high" : hotspots.length ? "medium" : "low",
    reasons,
    protectedFiles,
    dependencyFiles,
    deletedTests,
    weakenedTests,
    hotspots,
  };
}

/** Run git for the base..sha change set and classify it. */
export async function analyzeChange(repo, base, sha) {
  const status = await git(repo, ["diff", "--name-status", "-M", "--no-renames", `${base}..${sha}`]);
  if (status.code !== 0) throw new Error(`git diff failed: ${status.stderr.trim().slice(0, 200)}`);
  const numstat = await git(repo, ["diff", "--numstat", "--no-renames", `${base}..${sha}`]);
  const stat = new Map();
  for (const l of numstat.stdout.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = l.split("\t");
    stat.set(rest.join("\t"), { added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d) });
  }
  const files = status.stdout.split("\n").filter(Boolean).map((l) => {
    const [st, ...rest] = l.split("\t");
    const p = rest.join("\t");
    return { path: p, status: st[0], ...(stat.get(p) ?? { added: 0, deleted: 0 }) };
  });
  const diff = await git(repo, ["diff", "-U0", "--no-color", "--no-renames", `${base}..${sha}`], { maxBytes: 40_000_000 });
  const risk = classifyChange(files, diff.stdout);
  const secrets = scanDiffForSecrets(diff.stdout);
  const stats = { files: files.length, added: files.reduce((n, f) => n + f.added, 0), deleted: files.reduce((n, f) => n + f.deleted, 0) };
  return { files, stats, risk, secrets };
}
