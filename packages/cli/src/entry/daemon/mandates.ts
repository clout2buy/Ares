// The desktop daemon's side of the mandate control plane (@ares/operator
// mandates.ts): scheduled jobs and the operator loop ask it before every
// unasked run, and the desktop's "Ares wanted to" list reads and answers it.
//
// A job the owner created carries a mandate from birth (created by the owner
// at T). A job an agent scheduled for itself does not: when it comes due it is
// recorded ("would have run X because Y"), not run, until the owner approves
// it once or always. Owner acts in the jobs panel are authorizations too:
// "run now" is a one-time go-ahead and "resume" re-grants a revoked job.

import {
  MandateStore,
  operatorGoalGate,
  type GateResult,
  type Goal,
  type ProactiveMode,
  type ProactiveSource,
} from "@ares/operator";
import { describeSchedule, type AgentJob } from "./jobs.js";

/** The sources this daemon actually gates. The reading sources (dreaming,
 *  reflection, briefings, the Consciousness watcher) stay auto and are not
 *  offered as switches here, because nothing would honour them. */
export const GATED_SOURCES: readonly ProactiveSource[] = ["jobs", "operator"];

const MODES: ReadonlySet<string> = new Set(["off", "observe", "auto"]);
const WANTED_MAX = 50;

export interface DaemonMandatesDeps {
  home: string;
  emit(payload: Record<string, unknown>): void;
  /** Make a job due now (DesktopJobs.change(id, "run")). */
  runJobNow(jobId: string): Promise<unknown>;
  /** Nudge the operator loop so an approved goal runs without waiting out
   *  the heartbeat. Absent when the loop is not running. */
  wakeOperator?(): void;
  /** Injected for tests. */
  store?: MandateStore;
}

export function jobScope(jobId: string): string {
  return `job:${jobId}`;
}

export function createDaemonMandates(deps: DaemonMandatesDeps) {
  const store = deps.store ?? new MandateStore({ home: deps.home });

  const view = async () => {
    const s = await store.snapshot();
    return {
      modes: Object.fromEntries(GATED_SOURCES.map((src) => [src, s.effectiveModes[src]])),
      wanted: s.observations.filter((o) => o.status === "pending").reverse().slice(0, WANTED_MAX),
      mandates: s.mandates.filter((m) => !m.revokedAt).reverse(),
    };
  };
  const publish = async (): Promise<void> => {
    try {
      deps.emit({ type: "mandates_list", ...(await view()) });
    } catch {
      // the list is a view; a failed read never breaks a gate
    }
  };

  const jobGate = async (job: AgentJob): Promise<{ run: boolean; stop?: boolean; note?: string; release?: () => Promise<unknown> }> => {
    const scope = jobScope(job.id);
    const wouldDo = `run the scheduled job "${job.title}"`;
    if (job.createdBy === "owner") {
      await store.ensure({
        source: "jobs",
        scope,
        grantedBy: { kind: "owner_created", what: `job "${job.title}"`, at: job.createdAt },
        may: `${wouldDo}, ${describeSchedule(job.schedule)}`,
        grantedAt: job.createdAt,
      });
    }
    const result: GateResult = await store.gate({
      source: "jobs",
      scope,
      wouldDo,
      because: job.createdBy === "agent" ? "the agent scheduled it for itself and it came due" : "it came due",
      takesActions: true,
    });
    if (!result.allowed) await publish();
    return {
      run: result.allowed,
      ...(result.revoked ? { stop: true } : {}),
      ...(result.allowed ? {} : { note: result.revoked ? "stopped: its mandate was revoked" : "observed — waiting for the owner's go-ahead" }),
      ...(result.via === "once" ? { release: () => store.approveOnce("jobs", scope, wouldDo) } : {}),
    };
  };

  const goalGate: (goal: Goal) => Promise<boolean> = operatorGoalGate(store, { onObserved: () => void publish() });

  /** The owner acted on a job in the desktop panel. */
  const ownerJobAct = async (jobId: string, action: string, title?: string): Promise<void> => {
    const scope = jobScope(jobId);
    if (action === "delete") {
      await store.revoke({ source: "jobs", scope });
      return;
    }
    const s = await store.snapshot();
    const live = s.mandates.some((m) => m.source === "jobs" && m.scope === scope && !m.revokedAt);
    if (live) return;
    if (action === "run") await store.approveOnce("jobs", scope, `run the scheduled job${title ? ` "${title}"` : ""}`);
    if (action === "resume") {
      const at = new Date().toISOString();
      await store.grant({ source: "jobs", scope, grantedBy: { kind: "owner_created", what: "job resumed", at }, may: `run the scheduled job${title ? ` "${title}"` : ""}` });
    }
  };

  /** Desktop commands. Returns true when the command was one of ours. */
  const handle = async (command: Record<string, unknown>): Promise<boolean> => {
    const type = command.type;
    if (type !== "mandates_list" && type !== "mandate_decide" && type !== "mandate_revoke" && type !== "proactive_mode_set") return false;
    try {
      if (type === "mandate_decide") {
        const id = typeof command.id === "string" ? command.id : "";
        const decision = command.decision;
        if (!id || (decision !== "once" && decision !== "always" && decision !== "dismiss")) throw new Error("mandate_decide requires id and decision once|always|dismiss");
        const out = await store.decide(id, decision);
        if (!out) throw new Error("that entry is gone");
        if (decision !== "dismiss") {
          const { source, scope } = out.observation;
          if (source === "jobs" && scope.startsWith("job:")) await deps.runJobNow(scope.slice("job:".length)).catch(() => undefined);
          if (source === "operator") deps.wakeOperator?.();
        }
      } else if (type === "mandate_revoke") {
        const id = typeof command.id === "string" ? command.id : "";
        if (!id) throw new Error("mandate_revoke requires id");
        await store.revoke({ id });
      } else if (type === "proactive_mode_set") {
        const source = command.source as ProactiveSource;
        const mode = command.mode as ProactiveMode;
        if (!GATED_SOURCES.includes(source) || typeof mode !== "string" || !MODES.has(mode)) throw new Error("proactive_mode_set requires source jobs|operator and mode off|observe|auto");
        await store.setMode(source, mode);
      }
    } catch (error) {
      deps.emit({ type: "mandate_error", command: type, error: error instanceof Error ? error.message : String(error) });
    }
    await publish();
    return true;
  };

  return { store, jobGate, goalGate, ownerJobAct, handle, publish };
}

export type DaemonMandates = ReturnType<typeof createDaemonMandates>;
