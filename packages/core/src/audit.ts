// The audit trail — what Ares did, append-only, readable on the phone.
//
// Overnight runs, scheduled jobs and remote turns act while the owner sleeps.
// "What did it do?" must have an answer that doesn't depend on the model's
// own summary: one JSON line per action, written by the runtime, never
// rewritten. Parameters are redacted before they are written — a secret that
// reaches this file is a leak, so redaction is by key name AND by value shape.
//
// Files rotate daily: <ARES_HOME>/audit/YYYY-MM-DD.jsonl.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  /** "owner" | "ares" | "scheduler" | "subagent:<id>" … */
  actor: string;
  sessionId?: string;
  /** Tool or control action, e.g. "Browser.click", "control.stop", "takeover". */
  action: string;
  /** What it acted on: a URL, recipient, file, service. */
  target?: string;
  params?: unknown;
  /** "ok" | "error" | "denied" | "approved" | free text, short. */
  result?: string;
}

function aresHome(home?: string): string {
  return home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
}

export function auditDir(home?: string): string {
  return path.join(aresHome(home), "audit");
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|api[_-]?key|authorization|cookie|otp|code|pin|cvv|cvc|card[_-]?number|private/i;
const SECRET_VALUE = [
  /\bsk_(live|test)_[A-Za-z0-9]{8,}/g,
  /\b(ghp|gho|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:\d[ -]?){13,19}\b/g,
];

/** Deep-copy `value` with secrets removed. Bounded depth and size. */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (typeof value === "string") {
    let out = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
    for (const re of SECRET_VALUE) out = out.replace(re, "[redacted]");
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForAudit(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      // A handle is a reference, not a value — safe to keep.
      if (SECRET_KEY.test(key) && !(typeof v === "string" && v.startsWith("sec_"))) out[key] = "[redacted]";
      else out[key] = redactForAudit(v, depth + 1);
    }
    return out;
  }
  return value;
}

let chain: Promise<unknown> = Promise.resolve();

/** Append one entry. Never throws; serialized so lines never interleave. */
export function appendAudit(entry: Omit<AuditEntry, "ts"> & { ts?: string }, home?: string): Promise<void> {
  const ts = entry.ts ?? new Date().toISOString();
  const line =
    JSON.stringify({ ...entry, ts, ...(entry.params !== undefined ? { params: redactForAudit(entry.params) } : {}) }) + "\n";
  const file = path.join(auditDir(home), `${ts.slice(0, 10)}.jsonl`);
  const next = chain.then(async () => {
    await fs.mkdir(auditDir(home), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, line, { mode: 0o600 });
  });
  chain = next.catch(() => undefined);
  return next.catch(() => undefined);
}

/** Newest-first entries from the last `days` files, capped at `limit`. */
export async function readAudit(opts: { home?: string; days?: number; limit?: number; sessionId?: string } = {}): Promise<AuditEntry[]> {
  const days = Math.min(Math.max(opts.days ?? 2, 1), 30);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const out: AuditEntry[] = [];
  for (let i = 0; i < days && out.length < limit; i++) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    let text = "";
    try {
      text = await fs.readFile(path.join(auditDir(opts.home), `${day}.jsonl`), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n").filter(Boolean).reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (opts.sessionId && entry.sessionId !== opts.sessionId) continue;
        out.push(entry);
        if (out.length >= limit) break;
      } catch {
        // torn line — skip
      }
    }
  }
  return out;
}
