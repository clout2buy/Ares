// Shared helpers for the self-improvement pipeline (ares-verify, ares-deploy, the Maintainer).
//
// Plain Node, no dependencies, so it runs on a box that has nothing but node + git.
// Nothing in here prints or returns a secret: the signing key is read from a 0600 file
// (or the ARES_VERIFY_KEY env var the vault injects) and only ever used inside hmac().

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fsp, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SIG_PREFIX = "hmac-sha256:";

// ---------------------------------------------------------------- paths

export function aresHome(env = process.env) {
  return env.ARES_HOME && env.ARES_HOME.trim() ? path.resolve(env.ARES_HOME) : path.join(os.homedir(), ".ares");
}
export const eliteDir = (home) => path.join(home, "elite");
export const resultsDir = (home) => path.join(eliteDir(home), "results");
export const deploysDir = (home) => path.join(eliteDir(home), "deploys");
export const outboxDir = (home) => path.join(eliteDir(home), "outbox");
export const keyFile = (home) => path.join(eliteDir(home), "verify.key");
export const lockFile = (home) => path.join(eliteDir(home), "deploy.lock");
export const approvedBranchesFile = (home) => path.join(eliteDir(home), "approved-branches.json");

export function forgeDir(env = process.env) {
  return env.ARES_FORGE_DIR && env.ARES_FORGE_DIR.trim() ? path.resolve(env.ARES_FORGE_DIR) : path.join(os.homedir(), "forge");
}

// ---------------------------------------------------------------- args

/** Tiny argv parser: --flag, --key value, --key=value. Repeated keys collect into arrays. */
export function parseArgs(argv, { booleans = [], strings = [] } = {}) {
  const out = { _: [] };
  const bool = new Set(booleans);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (bool.has(k)) { out[k] = v === undefined ? true : v !== "false"; continue; }
    if (v === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && !strings.includes(k))) throw new Error(`--${k} needs a value`);
      v = next;
      i++;
    }
    if (out[k] === undefined) out[k] = v;
    else out[k] = [].concat(out[k], v);
  }
  return out;
}

// ---------------------------------------------------------------- processes

/**
 * Run a command, capture bounded output. Never throws: resolves {code, stdout, stderr, timedOut}.
 * `shell` runs a string through sh -c (used for operator-overridable step commands).
 */
export function run(cmd, args = [], { cwd, env, timeoutMs = 0, shell = false, input, maxBytes = 4_000_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = shell
        ? spawn(process.platform === "win32" ? cmd : "/bin/sh", process.platform === "win32" ? [] : ["-c", cmd], { cwd, env: env ?? process.env, shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] })
        : spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd) });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: String(err?.message ?? err), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s, chunk) => (s.length >= maxBytes ? s : s + chunk.toString("utf8"));
    child.stdout.on("data", (c) => { stdout = cap(stdout, c); });
    child.stderr.on("data", (c) => { stderr = cap(stderr, c); });
    child.on("error", (err) => { stderr += String(err?.message ?? err); });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function killTree(child) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch { /* already gone */ }
}

export async function git(repo, args, opts = {}) {
  return run("git", ["-C", repo, ...args], opts);
}

// ---------------------------------------------------------------- redaction + clipping

const SECRET_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "[redacted]"],
  [/(https?:\/\/)[^\s/@]+@/gi, "$1"],
  [/\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|credential)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]"],
  [/\b[A-Fa-f0-9]{48,}\b/g, "[redacted]"],
];

export function redact(text) {
  let out = String(text ?? "");
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  return out;
}

export function clip(text, n = 400) {
  const t = redact(String(text ?? "")).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------------------------------------------------------------- canonical JSON + HMAC

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The signing key: ARES_VERIFY_KEY (hex, injected from the vault) or <home>/elite/verify.key (0600). */
export function loadKey({ home, create = false, env = process.env } = {}) {
  const fromEnv = (env.ARES_VERIFY_KEY ?? "").trim();
  if (/^[0-9a-f]{32,}$/i.test(fromEnv)) return fromEnv.toLowerCase();
  const file = keyFile(home);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) return existing.toLowerCase();
  } catch { /* fall through */ }
  if (!create) return null;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("hex");
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* advisory on some filesystems */ }
  return key;
}

export function hmac(payload, key) {
  return SIG_PREFIX + createHmac("sha256", key).update(canonical(payload)).digest("hex");
}

export function sign(payload, key) {
  return { version: 1, payload, sig: hmac(payload, key) };
}

/** True only when `doc.sig` is the HMAC of `doc.payload` under `key`. Constant-time compare. */
export function verifySignature(doc, key) {
  if (!doc || typeof doc !== "object" || typeof doc.sig !== "string" || !doc.payload || !key) return false;
  if (!doc.sig.startsWith(SIG_PREFIX)) return false;
  const want = Buffer.from(hmac(doc.payload, key));
  const got = Buffer.from(doc.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- files

export async function writeJsonAtomic(file, value, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await fsp.rename(tmp, file);
}

export async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------- approved branches

export const DEFAULT_APPROVED_BRANCHES = ["main", "release/*", "auto/*", "feat*/*"];

export function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export async function approvedBranchPatterns(home, env = process.env) {
  if (env.ARES_DEPLOY_APPROVED_BRANCHES) return env.ARES_DEPLOY_APPROVED_BRANCHES.split(",").map((s) => s.trim()).filter(Boolean);
  const file = await readJson(approvedBranchesFile(home));
  if (Array.isArray(file) && file.every((s) => typeof s === "string") && file.length) return file;
  if (file && Array.isArray(file.branches) && file.branches.length) return file.branches.filter((s) => typeof s === "string");
  return DEFAULT_APPROVED_BRANCHES;
}

export function branchApproved(branch, patterns) {
  return patterns.some((p) => globToRegExp(p).test(branch));
}

// ---------------------------------------------------------------- misc

/** `~/x` -> absolute; leaves everything else alone (a quoted ~ never reaches the shell's expansion). */
export const expandHome = (p) => (typeof p === "string" && (p === "~" || p.startsWith("~/")) ? path.join(os.homedir(), p.slice(1)) : p);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowIso = () => new Date().toISOString();
export const shortSha = (sha) => String(sha ?? "").slice(0, 8);
export const slugify = (text, max = 32) =>
  String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "") || "change";
export const fileAgeMs = (file) => { try { return Date.now() - statSync(file).mtimeMs; } catch { return Infinity; } };
export { existsSync };
