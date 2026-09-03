// The friction gate + weekly self-audit — closing the measure-the-batch loop.
//
// summarizeFriction (@ares/core) aggregates raw telemetry; this module turns
// that aggregate into the THREE headline metrics the September 2026 batch was
// launched to move, judges them against hardcoded August 2026 baselines, and
// (opt-in) seeds a weekly plan-only standing order so the operator loop itself
// surfaces "here is what hurt this week" as a ranked goal with evidence.
//
// Everything here is deterministic arithmetic over counts — no LLM calls, no
// clock reads inside the pure functions. Baselines are hardcoded ON PURPOSE:
// they are provenance ("measured 2026-08 over N turns"), not tunables, so a
// future reader can always tell what "better" is relative to.

import { summarizeFriction, telemetryDir } from "@ares/core";
import { createGoal } from "./goal.js";
import { newGoalId, saveGoal } from "./store.js";
import { operatorPaths } from "./paths.js";
import {
  loadStandingOrders,
  normalizeStandingOrder,
  saveStandingOrder,
  type StandingOrder,
} from "./standingOrders.js";
import type { Goal } from "./types.js";

// ─── Input shape ────────────────────────────────────────────────────────────
//
// Structural on purpose: the FrictionSummary in @ares/core is being extended
// concurrently (workStatus counts, aggregated diagnostics, durations). This
// report reads whatever fields the dist it was built against carries and
// omits gracefully what is absent — never a hard dependency on the newest
// summary shape, so old telemetry and old dists still produce a report.

export interface FrictionSummaryLike {
  turns: number;
  completed: number;
  failed: number;
  needsVerification?: number;
  tools: Record<string, { calls: number; errors: number }>;
  editTiers?: { exact: number; whitespace: number; anchor: number; normalized?: number; miss: number };
  /** Aggregated proof-truth counts (verified/unverified/blocked/not_applicable), when the summary carries them. */
  workStatus?: Partial<Record<string, number>>;
  /** Aggregated diagnostics (signature → merged count), when the summary carries them. */
  diagnostics?: Array<{ signature: string; sample: string; count: number; kind?: string; tool?: string; code?: string }>;
  images?: { blocks: number; approxBytes: number };
  /** Median-ish duration, under whichever name the summary grew it. */
  medianDurationMs?: number | null;
  p50DurationMs?: number | null;
  avgDurationMs?: number | null;
}

// ─── Metrics + baselines ────────────────────────────────────────────────────

export interface FrictionMetric {
  name: "unverifiedRate" | "editErrorRate" | "providerFailRate";
  /** Current value in [0,1], or null when the sample is too thin to trust. */
  value: number | null;
  baseline: number;
  target: number;
  /** Where the baseline number came from — provenance, printed verbatim. */
  provenance: string;
  /** Why value is null, when it is. */
  note?: string;
}

export interface FrictionReport {
  metrics: FrictionMetric[];
  topDiagnostics: Array<{ sample: string; count: number; kind?: string; tool?: string }>;
  /** Decoded screenshot bytes per turn, or null when the summary has no images field / no turns. */
  imageBytesPerTurn: number | null;
  /** Median-ish turn duration when the summary carries one; else null. */
  durationMs: number | null;
  turns: number;
}

/** August 2026 baselines — measured before the v0.46 batch, kept as provenance. */
export const FRICTION_BASELINES = {
  unverifiedRate: { baseline: 0.79, target: 0.3, provenance: "baseline 0.79 — 49 of 62 coding turns unverified (Aug 2026)" },
  editErrorRate: { baseline: 0.23, target: 0.05, provenance: "baseline 0.23 — 68 of 301 Edit calls errored (Aug 2026)" },
  providerFailRate: { baseline: 0.22, target: 0.05, provenance: "baseline 0.22 — 42 of 188 turns failed (Aug 2026)" },
} as const;

/** Minimum samples before a rate means anything. */
export const MIN_CODING_TURNS = 10;
export const MIN_EDIT_CALLS = 20;
export const MIN_TURNS = 20;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Derive the three headline metrics (with null guards) plus the supporting
 *  color (diagnostics, image tax, duration) from one friction summary. Pure. */
export function buildFrictionReport(summary: FrictionSummaryLike): FrictionReport {
  const metrics: FrictionMetric[] = [];

  // unverifiedRate — coding turns only: verified + unverified are the turns
  // where proof-truth applies at all; blocked/not_applicable dilute the signal.
  {
    const b = FRICTION_BASELINES.unverifiedRate;
    const verified = summary.workStatus?.verified ?? 0;
    const unverified = summary.workStatus?.unverified ?? 0;
    const codingTurns = verified + unverified;
    const thin = !summary.workStatus || codingTurns < MIN_CODING_TURNS;
    metrics.push({
      name: "unverifiedRate",
      value: thin ? null : round3(unverified / codingTurns),
      baseline: b.baseline,
      target: b.target,
      provenance: b.provenance,
      note: thin
        ? summary.workStatus
          ? `only ${codingTurns} coding turn(s) — need ${MIN_CODING_TURNS}`
          : "summary carries no workStatus counts"
        : undefined,
    });
  }

  // editErrorRate — Edit tool errors over calls.
  {
    const b = FRICTION_BASELINES.editErrorRate;
    const edit = summary.tools?.Edit;
    const calls = edit?.calls ?? 0;
    const thin = calls < MIN_EDIT_CALLS;
    metrics.push({
      name: "editErrorRate",
      value: thin ? null : round3((edit?.errors ?? 0) / calls),
      baseline: b.baseline,
      target: b.target,
      provenance: b.provenance,
      note: thin ? `only ${calls} Edit call(s) — need ${MIN_EDIT_CALLS}` : undefined,
    });
  }

  // providerFailRate — failed turns over all turns.
  {
    const b = FRICTION_BASELINES.providerFailRate;
    const turns = summary.turns ?? 0;
    const thin = turns < MIN_TURNS;
    metrics.push({
      name: "providerFailRate",
      value: thin ? null : round3((summary.failed ?? 0) / turns),
      baseline: b.baseline,
      target: b.target,
      provenance: b.provenance,
      note: thin ? `only ${turns} turn(s) — need ${MIN_TURNS}` : undefined,
    });
  }

  const topDiagnostics = [...(summary.diagnostics ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((d) => ({ sample: d.sample, count: d.count, kind: d.kind, tool: d.tool }));

  const imageBytesPerTurn =
    summary.images && (summary.turns ?? 0) > 0 ? Math.round(summary.images.approxBytes / summary.turns) : null;

  const durationMs = summary.medianDurationMs ?? summary.p50DurationMs ?? summary.avgDurationMs ?? null;

  return { metrics, topDiagnostics, imageBytesPerTurn, durationMs, turns: summary.turns ?? 0 };
}

// ─── The gate ───────────────────────────────────────────────────────────────

export type FrictionVerdict = "pass" | "regress" | "insufficient";

export interface FrictionGateResult {
  verdict: FrictionVerdict;
  lines: string[];
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Judge the batch against its baselines:
 *   pass       — every computable metric is ≤ its target OR ≥30% better than baseline
 *   regress    — any computable metric is worse than its baseline by >10% relative
 *   insufficient — nothing computable, OR computable-but-inconclusive (no
 *                  regression, targets not all met yet) — exit-0-with-warning
 *                  either way, so "improving but not there" never fails a gate.
 * Pure and order-stable: regression outranks pass, so a batch that fixes one
 * metric while breaking another still shows red.
 */
export function judgeFrictionGate(report: FrictionReport): FrictionGateResult {
  const lines: string[] = [];
  const computable = report.metrics.filter((m) => m.value !== null);
  let anyRegress = false;
  let allPass = computable.length > 0;

  for (const m of report.metrics) {
    if (m.value === null) {
      lines.push(`~ ${m.name}: insufficient data (${m.note ?? "no sample"})`);
      continue;
    }
    const passed = m.value <= m.target || m.value <= m.baseline * 0.7;
    const regressed = m.value > m.baseline * 1.1;
    if (regressed) anyRegress = true;
    if (!passed) allPass = false;
    const glyph = regressed ? "✗" : passed ? "✓" : "·";
    const label = regressed ? "REGRESSED vs baseline" : passed ? "pass" : "improving, target not met";
    lines.push(`${glyph} ${m.name}: ${pct(m.value)} (target ${pct(m.target)}, ${m.provenance}) — ${label}`);
  }

  if (computable.length === 0) {
    lines.push("verdict: insufficient — no metric had enough data to compute");
    return { verdict: "insufficient", lines };
  }
  if (anyRegress) {
    lines.push("verdict: regress — at least one metric is >10% worse than its Aug 2026 baseline");
    return { verdict: "regress", lines };
  }
  if (allPass) {
    lines.push("verdict: pass — every computable metric meets its target or beats baseline by ≥30%");
    return { verdict: "pass", lines };
  }
  lines.push("verdict: insufficient — no regression, but not every metric meets its target yet");
  return { verdict: "insufficient", lines };
}

/** Human-readable report body (report-only surface; the gate has its own lines). */
export function renderFrictionReport(report: FrictionReport): string[] {
  const lines: string[] = [`${report.turns} turn(s) in window`];
  for (const m of report.metrics) {
    lines.push(
      m.value === null
        ? `${m.name}: n/a (${m.note ?? "no sample"}) — ${m.provenance}, target ${pct(m.target)}`
        : `${m.name}: ${pct(m.value)} — ${m.provenance}, target ${pct(m.target)}`,
    );
  }
  if (report.imageBytesPerTurn !== null) lines.push(`image payload: ~${Math.round(report.imageBytesPerTurn / 1024)} KB/turn`);
  if (report.durationMs !== null && report.durationMs !== undefined) lines.push(`duration (median-ish): ${Math.round(report.durationMs / 1000)}s`);
  if (report.topDiagnostics.length) {
    lines.push("top diagnostics:");
    for (const d of report.topDiagnostics) {
      lines.push(`  ${String(d.count).padStart(3)}× ${d.tool ? `[${d.tool}] ` : ""}${d.sample}`);
    }
  }
  return lines;
}

// ─── Weekly self-audit standing order ───────────────────────────────────────
//
// Opt-in (`ares friction audit --install`). Rides the EXISTING standing-orders
// machinery: the order carries payloadKind "friction-audit", and the generic
// materializer calls back into buildWeeklyAuditGoal below so the goal the
// operator loop ranks and surfaces carries this week's report + gate verdict +
// top diagnostics as its evidence. Plan-only by construction (mode:"plan") —
// the owner READS it; nothing auto-executes.

export const WEEKLY_SELF_AUDIT_ID = "weekly-self-audit";
export const WEEKLY_SELF_AUDIT_CADENCE_MS = 7 * 86_400_000;
export const FRICTION_AUDIT_PAYLOAD_KIND = "friction-audit";

export async function installWeeklySelfAudit(home?: string, now = new Date()): Promise<StandingOrder> {
  const existing = (await loadStandingOrders(home).catch(() => [])).find((o) => o.id === WEEKLY_SELF_AUDIT_ID);
  const order = normalizeStandingOrder(
    {
      id: WEEKLY_SELF_AUDIT_ID,
      statement:
        "Weekly self-audit (plan ONLY — do not execute): review this week's friction report, name what hurt most, and propose the next improvement batch for the owner's approval.",
      cadenceMs: WEEKLY_SELF_AUDIT_CADENCE_MS,
      payloadKind: FRICTION_AUDIT_PAYLOAD_KIND,
      // Preserve run history across re-installs — install is idempotent.
      createdAt: existing?.createdAt,
      lastRunAt: existing?.lastRunAt,
      runCount: existing?.runCount,
    },
    now,
  );
  await saveStandingOrder(home, order);
  return order;
}

/** Build the plan-only audit goal statement: the order's ask plus this week's
 *  evidence (report + gate verdict + top diagnostics), so the goal the owner
 *  sees in the operator queue IS the briefing. Best-effort: a telemetry read
 *  failure degrades to the bare statement, never a throw. */
export async function buildWeeklyAuditGoalStatement(order: StandingOrder, home?: string, days = 7): Promise<string> {
  try {
    const summary = (await summarizeFriction(telemetryDir(operatorPaths(home).home), days)) as FrictionSummaryLike;
    const report = buildFrictionReport(summary);
    const gate = judgeFrictionGate(report);
    return [
      order.statement,
      "",
      `── Friction report (last ${days} days) ──`,
      ...renderFrictionReport(report),
      "",
      "── Gate ──",
      ...gate.lines,
    ].join("\n");
  } catch {
    return order.statement;
  }
}

/** Materialize the weekly audit order into a plan-only goal carrying the
 *  evidence payload. Called by materializeDueStandingOrders for orders whose
 *  payloadKind is "friction-audit"; also callable directly (tests, CLI). */
export async function materializeWeeklyAuditGoal(order: StandingOrder, home: string | undefined, now = new Date()): Promise<Goal> {
  const statement = await buildWeeklyAuditGoalStatement(order, home);
  const goal = createGoal({ id: newGoalId(now), statement, mode: "plan", now });
  await saveGoal(operatorPaths(home).home, goal);
  return goal;
}
