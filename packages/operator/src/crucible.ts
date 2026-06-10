// The Crucible trial (ARES V7) — promotion gates on PROOF, not on thresholds
// set at write time.
//
// Deep dreams become the trial: every candidate hypothesis is examined against
// two sources of truth — its falsifiable check (run as a reality probe) and
// its win/loss evidence record (V6 consequence wiring). Survivors promote to
// confirmed knowledge. Losers archive WITH the failure reason written back as
// a new memory (the post-mortem is itself a learning). Confirmed knowledge
// whose check starts failing is demoted back to candidate — beliefs can lose
// tenure. No model opinion anywhere in this file: the trial is deterministic.
//
// Probes touch the real world, so the runner is injectable and the default
// only runs the two check kinds the Witness intake vets as read-only.

import type { CrucibleCheck, HypothesisStatus, MemoryNode } from "@ares/mind";
import { runProbe, type ProbeContext, type ProbeResult } from "./probe.js";
import type { VerificationSpec } from "./types.js";

export type TrialAction = "promoted" | "archived" | "demoted" | "held";

export interface TrialVerdict {
  id: string;
  claim: string;
  action: TrialAction;
  reason: string;
  probe?: { met: boolean; summary: string };
}

export interface TrialReport {
  reviewed: number;
  promoted: number;
  archived: number;
  demoted: number;
  held: number;
  verdicts: TrialVerdict[];
}

/** The slice of MemoryStore the trial needs (structural, test-friendly). */
export interface TrialStore {
  all(): MemoryNode[];
  candidates(): MemoryNode[];
  setStatus(id: string, status: HypothesisStatus, note: string, opts?: { now?: Date }): Promise<MemoryNode | undefined>;
  add(input: { kind: "semantic"; content: string; tags?: string[]; source?: string }): Promise<MemoryNode>;
}

export interface CrucibleTrialOptions {
  store: TrialStore;
  workspace?: string;
  /** Probe runner seam — tests inject; default is the real reality probe. */
  probe?: (spec: VerificationSpec, ctx: ProbeContext) => Promise<ProbeResult>;
  signal?: AbortSignal;
  now?: () => Date;
  /** Trial budget per dream — candidates beyond this wait for the next night. */
  maxTrials?: number;
}

/** Record thresholds: what an evidence trail must show without a check. */
const PROMOTE_WINS = 2;
const ARCHIVE_LOSSES = 3;
const DEFAULT_MAX_TRIALS = 20;

export function checkToSpec(check: CrucibleCheck): VerificationSpec | null {
  if (check.type === "file_exists" && check.path) {
    return { kind: "file", path: check.path };
  }
  if (check.type === "command" && check.cmd) {
    // Witness-vetted checks are simple read-only commands — naive whitespace
    // split is the contract (quoting-heavy commands are rejected at intake).
    const parts = check.cmd.trim().split(/\s+/);
    return {
      kind: "command",
      cmd: parts[0],
      args: parts.slice(1),
      timeoutMs: 15_000,
      ...(check.expect ? { contains: check.expect } : {}),
    };
  }
  return null;
}

export function recordOf(node: MemoryNode): { wins: number; losses: number } {
  let wins = 0;
  let losses = 0;
  for (const e of node.evidence ?? []) {
    if (e.won) wins++;
    else losses++;
  }
  return { wins, losses };
}

/**
 * Run one trial pass. Candidates face their checks and records; confirmed
 * nodes with checks are spot-audited for demotion. Returns every verdict so
 * the dream diary (and the desktop Crucible panel) can show its work.
 */
export async function runCrucibleTrials(opts: CrucibleTrialOptions): Promise<TrialReport> {
  const probe = opts.probe ?? runProbe;
  const now = opts.now ?? (() => new Date());
  const maxTrials = opts.maxTrials ?? DEFAULT_MAX_TRIALS;
  const ctx: ProbeContext = { workspace: opts.workspace, signal: opts.signal };
  const report: TrialReport = { reviewed: 0, promoted: 0, archived: 0, demoted: 0, held: 0, verdicts: [] };

  const record = async (
    node: MemoryNode,
    action: TrialAction,
    reason: string,
    probeResult?: ProbeResult,
  ): Promise<void> => {
    report.verdicts.push({
      id: node.id,
      claim: node.content.slice(0, 120),
      action,
      reason,
      ...(probeResult ? { probe: { met: probeResult.met, summary: probeResult.summary } } : {}),
    });
    report[action === "promoted" ? "promoted" : action === "archived" ? "archived" : action === "demoted" ? "demoted" : "held"]++;
    if (action === "promoted") await opts.store.setStatus(node.id, "confirmed", reason, { now: now() });
    if (action === "demoted") await opts.store.setStatus(node.id, "candidate", reason, { now: now() });
    if (action === "archived") {
      await opts.store.setStatus(node.id, "archived", reason, { now: now() });
      // The failure itself is a learning — write the post-mortem back.
      await opts.store.add({
        kind: "semantic",
        content: `Archived hypothesis: "${node.content.slice(0, 160)}" — ${reason}`,
        tags: ["crucible", "post-mortem"],
        source: node.id,
      });
    }
  };

  // ── Candidates face the trial ─────────────────────────────────────────
  for (const node of opts.store.candidates().slice(0, maxTrials)) {
    if (opts.signal?.aborted) break;
    report.reviewed++;
    const { wins, losses } = recordOf(node);
    const spec = node.check ? checkToSpec(node.check) : null;

    if (spec) {
      const result = await probe(spec, ctx);
      if (!result.met) {
        await record(node, "archived", `failed its check: ${result.summary}`, result);
      } else if (losses > wins) {
        await record(node, "held", `check passes but the record is negative (${wins}W/${losses}L) — needs wins`, result);
      } else {
        await record(node, "promoted", `trial passed: ${result.summary} (${wins}W/${losses}L)`, result);
      }
      continue;
    }

    // No check — the record alone must speak.
    if (wins >= PROMOTE_WINS && losses === 0) {
      await record(node, "promoted", `earned record: ${wins} wins, no losses`);
    } else if (losses >= ARCHIVE_LOSSES && wins === 0) {
      await record(node, "archived", `repeated losses (${losses}) with no wins`);
    } else {
      await record(node, "held", `insufficient record (${wins}W/${losses}L) — gathering evidence`);
    }
  }

  // ── Tenure audit: confirmed knowledge must keep passing its check ──────
  const confirmed = opts.store.all().filter((n) => n.status === "confirmed" && n.check);
  for (const node of confirmed.slice(0, maxTrials)) {
    if (opts.signal?.aborted) break;
    const spec = node.check ? checkToSpec(node.check) : null;
    if (!spec) continue;
    report.reviewed++;
    const result = await probe(spec, ctx);
    if (!result.met) {
      await record(node, "demoted", `check now failing — tenure revoked: ${result.summary}`, result);
    }
  }

  return report;
}
