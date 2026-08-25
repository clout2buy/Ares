// The daemon's maintenance timers, as the plugin kernel's first tenant.
//
// Field origin: the 2026-08-25 OOM night. The heap climbed 3015→4006MB over
// five idle minutes and the crash artifacts could not say what was running,
// because every maintenance job — heap watch, idle sweep, WAL fold, deep
// dream — was an anonymous setInterval buried in daemon.ts. Attribution was
// structurally impossible.
//
// Mounted on the PluginHost, each job gains three things the raw timers never
// had:
//
//   1. A LEDGER. Every noteworthy run (it did something, errored, or took
//      real time) is recorded with its duration. The heap-critical crash
//      artifact embeds the recent ledger, so "what ran during the climb" is
//      now a field in the report instead of a forensic reconstruction.
//   2. A LIFECYCLE. Teardown is ctx.effect-owned: daemon shutdown disposes
//      the host and every timer dies with it, in reverse mount order.
//   3. A RE-ENTRY GUARD. A slow tick skips its next firing instead of
//      stacking a second run on top of itself — the overlap that turned a
//      5-second usage poll into 630MB of concurrent string churn once before.
//
// This tenant was chosen FIRST deliberately: maintenance jobs have no
// user-facing contract, so any rough edge in the kernel surfaces on a timer
// nobody is watching, not on the tool belt mid-turn.

import { definePlugin, type AresPlugin } from "@ares/plugins";

export const MAINTENANCE_LEDGER_SERVICE = "maintenance/ledger";

export interface MaintenanceRun {
  /** Job name, e.g. "heap-watch". */
  job: string;
  /** Epoch ms at run start. */
  at: number;
  durationMs: number;
  /** What the run actually did (or the error that stopped it). */
  note?: string;
}

/** Bounded ring of recent maintenance activity, newest kept, oldest dropped. */
export class MaintenanceLedger {
  private readonly ring: MaintenanceRun[] = [];

  constructor(private readonly capacity = 200) {}

  record(run: MaintenanceRun): void {
    this.ring.push(run);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
  }

  /** Most recent first. */
  snapshot(limit = 30): MaintenanceRun[] {
    return this.ring.slice(-Math.max(1, limit)).reverse();
  }
}

export function maintenanceLedgerPlugin(capacity?: number): AresPlugin<void> {
  return definePlugin({
    name: "maintenance-ledger",
    setup(ctx) {
      ctx.provide(MAINTENANCE_LEDGER_SERVICE, new MaintenanceLedger(capacity));
    },
  });
}

export interface MaintenanceTimerOptions {
  /** Short job name; the plugin mounts as `maintenance:<name>`. */
  name: string;
  everyMs: number;
  /** One extra early run this long after mount (the deep-dream boot check:
   *  a machine only on during the day must not wait for a 3am cadence). */
  initialDelayMs?: number;
  /** A run with no note faster than this stays off the ledger — the 15s
   *  heartbeat of a healthy watch is not information. Default 50ms. */
  noteworthyMs?: number;
  /** The tick. Return a short note when the run DID something; return
   *  nothing for a quiet pass. A throw is contained and recorded. */
  task: () => string | undefined | void | Promise<string | undefined | void>;
}

export function maintenanceTimerPlugin(opts: MaintenanceTimerOptions): AresPlugin<void> {
  return definePlugin({
    name: `maintenance:${opts.name}`,
    inject: [MAINTENANCE_LEDGER_SERVICE],
    setup(ctx) {
      const ledger = ctx.service<MaintenanceLedger>(MAINTENANCE_LEDGER_SERVICE)!;
      const noteworthyMs = opts.noteworthyMs ?? 50;
      let running = false;
      const tick = async (): Promise<void> => {
        if (running) return;
        running = true;
        const at = Date.now();
        try {
          const note = (await opts.task()) || undefined;
          const durationMs = Date.now() - at;
          if (note !== undefined || durationMs >= noteworthyMs) {
            ledger.record({ job: opts.name, at, durationMs, ...(note !== undefined ? { note } : {}) });
          }
        } catch (error) {
          ledger.record({
            job: opts.name,
            at,
            durationMs: Date.now() - at,
            note: `error: ${error instanceof Error ? error.message : String(error)}`,
          });
        } finally {
          running = false;
        }
      };
      // unref'd like the raw timers were: maintenance must never hold the
      // daemon's event loop open past stdin close. A non-finite interval falls
      // back to a quiet hour instead of a 1ms hot loop.
      const everyMs = Number.isFinite(opts.everyMs) ? Math.max(25, opts.everyMs) : 60 * 60 * 1000;
      const interval = setInterval(() => void tick(), everyMs);
      interval.unref?.();
      ctx.effect(() => clearInterval(interval));
      if (opts.initialDelayMs !== undefined) {
        const boot = setTimeout(() => void tick(), opts.initialDelayMs);
        boot.unref?.();
        ctx.effect(() => clearTimeout(boot));
      }
    },
  });
}
