// Daily reliability triage on the DESKTOP daemon.
//
// Triage used to run in only two places: `ares triage` by hand, and the
// garrison's heartbeat. The per-turn hook in turnPipeline does run on the
// desktop, but only when a turn starts — a desktop that sat open without
// chatting never refreshed the queue the morning briefing and the Maintainer
// now read ("What keeps breaking"). This is a maintenance-timer task: checked
// hourly, it runs a scan at most once per ARES_TRIAGE_DAILY_HOURS (default 20)
// and only while no turn is active. ARES_TRIAGE_DAILY=0 turns it off;
// ARES_SELF_TRIAGE=0 still disables triage everywhere.

import { runReliabilityTriage, type ReliabilityTriageRun } from "@ares/core";

export interface DailyTriageOptions {
  home: string;
  workspace: () => string;
  busy: () => boolean;
  /** Test seam; default runReliabilityTriage. */
  run?: (opts: { home: string; workspace: string; minimumIntervalMs: number }) => Promise<Pick<ReliabilityTriageRun, "skipped" | "newCandidates" | "coverage">>;
}

export function dailyTriageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARES_TRIAGE_DAILY !== "0";
}

export function dailyTriageIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.ARES_TRIAGE_DAILY_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : 20) * 3_600_000;
}

/** The maintenance task: a one-line note when a scan ran, undefined when it had nothing to do. */
export function dailyTriageTask(opts: DailyTriageOptions): () => Promise<string | undefined> {
  return async () => {
    if (opts.busy()) return undefined;
    // The triage state's own lastRunAt is the latch: a scan from the per-turn hook or the CLI counts.
    const run = await (opts.run ?? runReliabilityTriage)({ home: opts.home, workspace: opts.workspace(), minimumIntervalMs: dailyTriageIntervalMs() });
    if (run.skipped) return undefined;
    return `triage: ${run.coverage?.files ?? 0} files, ${run.newCandidates?.length ?? 0} new candidates`;
  };
}
