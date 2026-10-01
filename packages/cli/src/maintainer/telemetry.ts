// What went wrong lately, as ranked-able issues. Read-only over the owner's own data:
//   - crash artifacts            <home>/crashes/*.jsonl
//   - errors in the audit log    <home>/audit/YYYY-MM-DD.jsonl
//   - failed turns & friends     the reliability triage findings (@ares/core), which already
//                                parse session rollouts for failed turns, engine and tool errors
//   - user-reported bug reports  <home>/bug-reports, <home>/bug_reports, ARES_MAINTAINER_BUGREPORT_DIRS
//   - red verifies               <home>/elite/results/*.json (a signed red result for a non-auto branch)
//
// Everything here is UNTRUSTED text (it came from logs and users): redacted, flattened to one line,
// bounded, and later fenced as data in the coding prompt. Nothing is executed or followed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { listReliabilityFindings, readAudit, type ReliabilityFinding } from "@ares/core";
import { redactSecrets } from "@ares/protocol";
import { fingerprintOf, type Issue } from "./maintainer.js";

const gunzipAsync = promisify(gunzip);

const clean = (text: unknown, max = 200): string =>
  redactSecrets(String(text ?? "")).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Digits, hex and quoted strings out: the same bug at a different time/pid/path is ONE issue. */
const normalize = (text: string): string => text.toLowerCase().replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b|\d+|"[^"]*"|'[^']*'/g, "#").replace(/\s+/g, " ").slice(0, 120);

export interface TelemetryOptions {
  home: string;
  now?: () => number;
  /** Extra bug-report directories (also ARES_MAINTAINER_BUGREPORT_DIRS, path-delimiter separated). */
  bugReportDirs?: string[];
  /** Triage findings; defaults to the real reliability store. */
  findings?: () => Promise<ReliabilityFinding[]>;
  /** Audit entries newest-first; defaults to the real audit log. */
  audit?: (days: number) => Promise<Array<{ ts: string; actor: string; action: string; target?: string; result?: string }>>;
}

async function crashIssues(home: string, sinceMs: number): Promise<Issue[]> {
  const dir = path.join(home, "crashes");
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const groups = new Map<string, Issue>();
  for (const n of names.filter((x) => x.endsWith(".jsonl")).slice(-200)) {
    const file = path.join(dir, n);
    const st = await fs.stat(file).catch(() => null);
    if (!st || st.mtimeMs < sinceMs) continue;
    const text = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").filter(Boolean).slice(-5)) {
      let rec: { at?: string; kind?: string; process?: string; message?: string; stack?: string };
      try { rec = JSON.parse(line); } catch { continue; }
      const top = clean((rec.stack ?? "").split("\n").find((l) => /\bat\b/.test(l)) ?? "", 160);
      const fp = fingerprintOf("crash", rec.process ?? "", rec.kind ?? "", normalize(String(rec.message ?? "")), normalize(top));
      const cur = groups.get(fp);
      const at = rec.at ?? new Date(st.mtimeMs).toISOString();
      if (cur) { cur.occurrences++; if (at > cur.lastSeenAt) cur.lastSeenAt = at; continue; }
      groups.set(fp, {
        fingerprint: fp, source: "crash", severity: rec.kind === "uncaughtException" ? 4 : 3, occurrences: 1, lastSeenAt: at,
        title: clean(`${rec.process ?? "process"} ${rec.kind ?? "crash"}: ${rec.message ?? ""}`, 140),
        evidence: [top, `process=${clean(rec.process, 30)} kind=${clean(rec.kind, 30)}`].filter(Boolean),
      });
    }
  }
  return [...groups.values()];
}

async function auditIssues(opts: TelemetryOptions, sinceMs: number): Promise<Issue[]> {
  const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / 86_400_000));
  const entries = opts.audit ? await opts.audit(days) : await readAudit({ home: opts.home, days, limit: 2000 });
  const groups = new Map<string, Issue>();
  for (const e of entries) {
    const res = String(e.result ?? "");
    // Denials are the safety system working, not a bug.
    if (!/\b(error|fail|exception|timeout|timed out)\b/i.test(res) || /denied|declined|paused|stopped by/i.test(res)) continue;
    if (Date.parse(e.ts) < sinceMs) continue;
    if (e.action.startsWith("maintainer.")) continue; // never chase its own tail
    const fp = fingerprintOf("audit", e.action, normalize(res));
    const cur = groups.get(fp);
    if (cur) { cur.occurrences++; if (e.ts > cur.lastSeenAt) cur.lastSeenAt = e.ts; continue; }
    groups.set(fp, { fingerprint: fp, source: "audit", severity: 2, occurrences: 1, lastSeenAt: e.ts, title: clean(`${e.action} keeps failing: ${res}`, 140), evidence: [clean(`actor=${e.actor} action=${e.action} result=${res}`, 200)] });
  }
  return [...groups.values()].filter((i) => i.occurrences >= 2);
}

const SEVERITY: Record<string, 1 | 2 | 3 | 4> = { critical: 4, high: 3, medium: 2, low: 1 };

async function triageIssues(opts: TelemetryOptions, sinceMs: number): Promise<Issue[]> {
  const findings = await (opts.findings ?? (() => listReliabilityFindings(opts.home)))().catch(() => [] as ReliabilityFinding[]);
  return findings
    .filter((f) => (f.status === "candidate" || f.status === "acknowledged") && f.category === "product" && Date.parse(f.lastSeenAt) >= sinceMs)
    .map((f): Issue => ({
      fingerprint: fingerprintOf("triage", f.fingerprint),
      source: f.kind === "failed_turn" || f.kind === "failed_subagent" ? "failed-turn" : f.kind === "crash" ? "crash" : "triage",
      severity: SEVERITY[f.severity] ?? 2,
      occurrences: f.occurrences,
      lastSeenAt: f.lastSeenAt,
      title: clean(f.title, 140),
      evidence: [...f.evidence.slice(0, 4).map((e) => clean(e.summary, 200)), clean(f.suggestedAction, 160)].filter(Boolean),
    }));
}

async function bugReportIssues(opts: TelemetryOptions, sinceMs: number): Promise<Issue[]> {
  const env = process.env.ARES_MAINTAINER_BUGREPORT_DIRS;
  const dirs = [path.join(opts.home, "bug-reports"), path.join(opts.home, "bug_reports"), ...(opts.bugReportDirs ?? []), ...(env ? env.split(path.delimiter).filter(Boolean) : [])];
  const out: Issue[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const n of names.filter((x) => /\.json(\.gz)?$/.test(x)).slice(-50)) {
      const file = path.join(dir, n);
      const st = await fs.stat(file).catch(() => null);
      if (!st || st.mtimeMs < sinceMs - 11 * 86_400_000 || st.size > 8_000_000) continue; // reports stay relevant for two weeks
      let doc: any;
      try {
        const raw = await fs.readFile(file);
        doc = JSON.parse((n.endsWith(".gz") ? await gunzipAsync(raw) : raw).toString("utf8"));
      } catch { continue; }
      const what = clean(doc?.description ?? doc?.message ?? doc?.summary ?? doc?.title ?? doc?.report ?? "", 200);
      if (!what) continue;
      out.push({
        fingerprint: fingerprintOf("bug-report", normalize(what)),
        source: "bug-report", severity: 3, occurrences: 1, lastSeenAt: new Date(st.mtimeMs).toISOString(),
        title: clean(`Owner-reported: ${what}`, 140),
        evidence: [what, doc?.version ? `version=${clean(doc.version, 30)}` : "", doc?.error ? clean(doc.error, 200) : ""].filter(Boolean),
      });
    }
  }
  return out;
}

async function verifyIssues(home: string, sinceMs: number): Promise<Issue[]> {
  const dir = path.join(home, "elite", "results");
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: Issue[] = [];
  for (const n of names.filter((x) => x.endsWith(".json")).slice(-100)) {
    let doc: any;
    try { doc = JSON.parse(await fs.readFile(path.join(dir, n), "utf8")); } catch { continue; }
    const p = doc?.payload;
    if (!p || p.green !== false || Date.parse(p.verifiedAt) < sinceMs) continue;
    if (typeof p.branch === "string" && p.branch.startsWith("auto/")) continue; // the Maintainer's own failed attempts are not new problems
    const failed = (p.steps ?? []).filter((s: any) => !s.ok).map((s: any) => String(s.name));
    const names2: string[] = p.tests?.failedNames ?? [];
    out.push({
      fingerprint: fingerprintOf("verify", failed.join(","), normalize(names2[0] ?? "")),
      source: "verify-failure", severity: 3, occurrences: 1, lastSeenAt: p.verifiedAt,
      title: clean(`Verification fails on ${p.branch ?? String(p.sha).slice(0, 8)}: ${failed.join(", ") || "failed"}${names2[0] ? ` (${names2[0]})` : ""}`, 140),
      evidence: [...(p.steps ?? []).filter((s: any) => !s.ok).slice(0, 3).map((s: any) => clean(`${s.name}: ${s.detail}`, 200)), ...names2.slice(0, 5).map((x) => clean(`failing test: ${x}`, 160))],
    });
  }
  return out;
}

/** Collect, merge same-fingerprint issues, and return them unranked. */
export function createTelemetryCollector(opts: TelemetryOptions): (sinceMs: number) => Promise<Issue[]> {
  return async (sinceMs) => {
    const parts = await Promise.all([
      crashIssues(opts.home, sinceMs).catch(() => []),
      auditIssues(opts, sinceMs).catch(() => []),
      triageIssues(opts, sinceMs).catch(() => []),
      bugReportIssues(opts, sinceMs).catch(() => []),
      verifyIssues(opts.home, sinceMs).catch(() => []),
    ]);
    const merged = new Map<string, Issue>();
    for (const i of parts.flat()) {
      const cur = merged.get(i.fingerprint);
      if (!cur) { merged.set(i.fingerprint, i); continue; }
      cur.occurrences += i.occurrences;
      if (i.lastSeenAt > cur.lastSeenAt) cur.lastSeenAt = i.lastSeenAt;
      cur.evidence = [...new Set([...cur.evidence, ...i.evidence])].slice(0, 6);
    }
    return [...merged.values()];
  };
}
