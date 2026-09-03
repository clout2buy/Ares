// The nightly gauntlet's bookkeeping — what happens AFTER the scheduler ran it.
//
// Roadmap C6 says the gauntlet runs on a schedule; it last ran by hand on
// Aug 15 and the eval trend's last entry was July 2. A benchmark nobody runs
// is a benchmark that cannot catch a regression. The Scheduler owns WHEN
// (ARES_GAUNTLET_HOUR, idle daemon); this module owns the durable record:
//
//   1. append tonight's passed/total/gateOk to ~/.ares/gauntlet/nightly.jsonl
//      (the operator's trend ledger — read by `ares eval trend`),
//   2. judge it against last night's entry for the same suite, and
//   3. on regression, write a finding under ~/.ares/triage/findings/ in the
//      same shape the reliability triage uses, so `ares triage` lists it next
//      to crash clusters and tool-error signatures. The finding id is stable
//      per suite (rel_<sha256(suite)[:16]>), so a second bad night bumps
//      occurrences instead of stacking a new file.
//
// The runner itself is host-injected (the CLI exports runScheduledGauntlet;
// the garrison never imports the CLI), so this file only sees its summary.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { reliabilityTriagePaths } from "@ares/core";
import { appendGauntletTrend, judgeGauntletTrend, readGauntletTrend, type GauntletTrendEntry } from "@ares/operator";

/** What the injected runner reports back. `suite`/`model`/`provider` are optional labels for the ledger. */
export interface GauntletRunSummary {
  passed: number;
  total: number;
  gateOk: boolean;
  suite?: string;
  provider?: string;
  model?: string;
}

export interface NightlyGauntletOutcome {
  entry: GauntletTrendEntry;
  previous: GauntletTrendEntry | null;
  regressed: boolean;
  reasons: string[];
  /** Path of the triage finding written (only on regression). */
  findingFile?: string;
  findingId?: string;
}

export interface RecordNightlyGauntletOptions {
  home: string;
  summary: GauntletRunSummary;
  now?: Date;
}

/** Deterministic per-suite finding id in the triage loader's accepted shape. */
export function gauntletFindingId(suite: string | undefined): string {
  return "rel_" + createHash("sha256").update(`gauntlet_regression:${suite ?? "default"}`).digest("hex").slice(0, 16);
}

export async function recordNightlyGauntlet(opts: RecordNightlyGauntletOptions): Promise<NightlyGauntletOutcome> {
  const now = opts.now ?? new Date();
  const at = now.toISOString();
  const { summary } = opts;
  const total = Math.max(0, Math.floor(Number(summary.total) || 0));
  const passed = Math.max(0, Math.min(total, Math.floor(Number(summary.passed) || 0)));
  const history = await readGauntletTrend(opts.home);
  const verdict = judgeGauntletTrend({ passed, total, gateOk: summary.gateOk !== false, suite: summary.suite }, history);
  const entry: GauntletTrendEntry = {
    at,
    passed,
    total,
    rate: total > 0 ? passed / total : 0,
    gateOk: summary.gateOk !== false,
    ...(summary.suite ? { suite: summary.suite } : {}),
    ...(summary.provider ? { provider: summary.provider } : {}),
    ...(summary.model ? { model: summary.model } : {}),
    regressed: verdict.regressed,
    reasons: verdict.reasons,
    source: "nightly",
  };
  await appendGauntletTrend(opts.home, entry);
  if (!verdict.regressed) return { entry, previous: verdict.previous, regressed: false, reasons: [] };

  const finding = await writeGauntletFinding(opts.home, entry, verdict.previous, verdict.reasons, now);
  return { entry, previous: verdict.previous, regressed: true, reasons: verdict.reasons, findingFile: finding.file, findingId: finding.id };
}

/** The triage-compatible record. Mirrors @ares/core's ReliabilityFinding
 *  field-for-field with a gauntlet-specific `kind`, so the `ares triage`
 *  reader (which checks only schemaVersion + id) lists it. */
interface GauntletFinding {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  kind: "gauntlet_regression";
  title: string;
  category: "product";
  severity: "high";
  confidence: "high";
  status: "candidate";
  occurrences: number;
  distinctSessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  observationKeys: string[];
  evidence: Array<{ source: "garrison"; at: string; summary: string; sourceRef: string }>;
  suggestedAction: string;
  openedAt?: string;
  recurrenceCount?: number;
}

async function writeGauntletFinding(
  home: string,
  entry: GauntletTrendEntry,
  previous: GauntletTrendEntry | null,
  reasons: string[],
  now: Date,
): Promise<{ id: string; file: string }> {
  const paths = reliabilityTriagePaths(home);
  const id = gauntletFindingId(entry.suite);
  const file = path.join(paths.findingsDir, id + ".json");
  const at = now.toISOString();
  const suiteLabel = entry.suite ?? "default suite";
  const summary = `${suiteLabel}: ${entry.passed}/${entry.total} (${Math.round(entry.rate * 100)}%)${previous ? ` vs ${previous.passed}/${previous.total} on ${previous.at.slice(0, 10)}` : ""} — ${reasons.join("; ")}`;
  const existing = await readJson<GauntletFinding>(file);
  const evidenceEntry = { source: "garrison" as const, at, summary, sourceRef: "gauntlet:nightly" };
  const next: GauntletFinding = existing && existing.schemaVersion === 1
    ? {
        ...existing,
        // A finding the owner resolved/dismissed that regresses AGAIN reopens
        // as a fresh candidate — a closed finding must not eat new evidence.
        status: "candidate",
        occurrences: (existing.occurrences ?? 0) + 1,
        lastSeenAt: at,
        updatedAt: at,
        observationKeys: [...new Set([...(existing.observationKeys ?? []), entry.at])].slice(-64),
        evidence: [...(existing.evidence ?? []), evidenceEntry].slice(-6),
        recurrenceCount: (existing.recurrenceCount ?? 0) + 1,
        title: gauntletFindingTitle(entry),
      }
    : {
        schemaVersion: 1,
        id,
        fingerprint: id.slice(4),
        kind: "gauntlet_regression",
        title: gauntletFindingTitle(entry),
        category: "product",
        severity: "high",
        confidence: "high",
        status: "candidate",
        occurrences: 1,
        distinctSessions: 0,
        firstSeenAt: at,
        lastSeenAt: at,
        createdAt: at,
        updatedAt: at,
        openedAt: at,
        sessionIds: [],
        observationKeys: [entry.at],
        evidence: [evidenceEntry],
        suggestedAction: `Run \`ares eval coding${entry.suite ? ` --suite ${entry.suite}` : ""} --gate\` by hand, then bisect the harness/prompt change since the last green night (ares eval trend).`,
      };
  await writeJsonAtomic(file, next);
  return { id, file };
}

function gauntletFindingTitle(entry: GauntletTrendEntry): string {
  return `Nightly gauntlet regressed: ${entry.suite ?? "default suite"} at ${entry.passed}/${entry.total}`;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}
