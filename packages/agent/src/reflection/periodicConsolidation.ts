// Periodic consolidation — "sleep" for a process that never ends.
//
// consolidate() used to run only at session end. The daemon's sessions never
// end, so a long-lived desktop install accumulated weeks of un-pruned,
// un-merged episodics (the append-only rot the session-end pass was meant to
// stop). This pass is registered on the ONE scheduler's "consolidate" trigger
// and fires every ARES_CONSOLIDATE_EVERY_MIN minutes of process uptime; it
// does real work only when the store has grown by ARES_CONSOLIDATE_MIN_NEW
// nodes since the last consolidation, and never while a turn is in flight.
//
// State is per memory file and PROCESS-WIDE, not per scheduler: every daemon
// session owns a scheduler, so N sessions fire N ticks — the shared record
// makes the first one in a window do the work and the rest skip on cadence.
// withConsolidationLock covers the cross-process case (daemon + garrison).

import { MemoryStore, withConsolidationLock, type ConsolidationReport, type ReflectionResult } from "@ares/mind";
import type { ReflectionPassFn } from "./scheduler.js";
import { isAnyTurnActive } from "./turnActivity.js";

/** Tick cadence. ARES_CONSOLIDATE_EVERY_MIN (default 90; 0 disables). */
export function consolidateEveryMs(): number {
  const raw = process.env.ARES_CONSOLIDATE_EVERY_MIN;
  if (raw === undefined || raw === "") return 90 * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return 90 * 60_000;
  return Math.floor(minutes * 60_000);
}

/** Growth gate: new nodes since the last consolidation. ARES_CONSOLIDATE_MIN_NEW (default 12). */
export function consolidateMinNewNodes(): number {
  const raw = Number(process.env.ARES_CONSOLIDATE_MIN_NEW);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 12;
}

interface ConsolidationRecord {
  /** Uptime anchor: when the record was created or the store last consolidated. */
  lastAt: number;
  /** Node count right after the last consolidation; undefined until the first run. */
  lastKept?: number;
  inFlight: boolean;
}

const records = new Map<string, ConsolidationRecord>();

/** Test seam: forget the per-file records. */
export function resetPeriodicConsolidation(): void {
  records.clear();
}

export interface PeriodicConsolidationOptions {
  memoryFile: string;
  everyMs?: number;
  minNewNodes?: number;
  isTurnActive?: () => boolean;
  /** Seams for tests. */
  openStore?: (file: string) => Promise<Pick<MemoryStore, "count" | "consolidate">>;
  lock?: <T>(file: string, fn: () => Promise<T>) => Promise<T | undefined>;
  /** Uptime anchor for the first eligible tick (default: pass creation). */
  startedAt?: number;
}

export type PeriodicConsolidationSkip = "disabled" | "turn-active" | "cadence" | "quiet" | "in-flight" | "locked";

/** Build the pass. Returns a ReflectionResult whose single directive names
 *  either the skip reason or the consolidation report — the cockpit reads it. */
export function periodicConsolidationPass(opts: PeriodicConsolidationOptions): ReflectionPassFn {
  const everyMs = opts.everyMs ?? consolidateEveryMs();
  const minNew = opts.minNewNodes ?? consolidateMinNewNodes();
  const isTurnActive = opts.isTurnActive ?? isAnyTurnActive;
  const openStore = opts.openStore ?? ((file: string) => MemoryStore.open(file));
  const lock = opts.lock ?? withConsolidationLock;
  let record = records.get(opts.memoryFile);
  if (!record) {
    record = { lastAt: opts.startedAt ?? Date.now(), inFlight: false };
    records.set(opts.memoryFile, record);
  }
  const rec = record;

  const skip = (reason: PeriodicConsolidationSkip): ReflectionResult => ({ directives: [`skipped: ${reason}`] });

  return async ({ now }): Promise<ReflectionResult> => {
    if (everyMs <= 0) return skip("disabled");
    if (isTurnActive()) return skip("turn-active");
    if (rec.inFlight) return skip("in-flight");
    if (now.getTime() - rec.lastAt < everyMs) return skip("cadence");
    rec.inFlight = true;
    try {
      const store = await openStore(opts.memoryFile);
      const count = store.count();
      // First eligible tick has no baseline: a store below the growth floor is
      // not worth a rewrite, anything larger consolidates (idempotent, cheap).
      const grown = rec.lastKept === undefined ? count : count - rec.lastKept;
      if (grown < minNew) {
        // Quiet stores still advance the cadence anchor — otherwise every
        // subsequent tick re-opens the file until something changes.
        rec.lastAt = now.getTime();
        rec.lastKept ??= count;
        return skip("quiet");
      }
      const report: ConsolidationReport | undefined = await lock(opts.memoryFile, () => store.consolidate({ now }));
      if (!report) return skip("locked");
      rec.lastAt = now.getTime();
      rec.lastKept = report.kept;
      const directives = [
        `consolidated: pruned ${report.pruned}, merged ${report.deduped}, kept ${report.kept}`,
      ];
      return { directives, persistedTo: "memory.jsonl" };
    } finally {
      rec.inFlight = false;
    }
  };
}
