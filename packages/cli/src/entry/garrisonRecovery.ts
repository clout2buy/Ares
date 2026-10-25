// Garrison boot-time crash recovery: what the gateway does to the durable
// kernel BEFORE it rebuilds any session, so a restart after a kill does not
// stall, loop, or run work nobody can see.
//
// Core Session replays an admitted-but-unfinished input the moment it is
// constructed (scheduleStartupOrphanDrain). Two things made that replay hurt
// in the field (issues #29/#30, `ares garrison serve --provider mock`,
// SIGKILL ~15ms after input_admitted, restart on the same home):
//
//   1. The dead process's runner lease survived in runner_leases and the new
//      session politely waited it out: input_admitted at +20ms, turn_start at
//      +21,018ms — the remaining lease TTL. The owner id embeds the pid
//      (`session_runner_<pid>_<uuid>`), so "is the holder alive" is one
//      process.kill(pid, 0) away.
//   2. A replay that kept dying (poison input, provider down) was replayed
//      again on every boot with no bound and no announcement.
//
// Both fixes live here, in the host, because @ares/core's lease and drain
// semantics are shared with the desktop daemon and must not change under it.

import {
  loadBetterSqlite3,
  type AdmittedInputRecord,
  type SessionKernelStore,
} from "@ares/core";

/** How many boots may replay one interrupted input before it is retired. */
export const MAX_DETACHED_REPLAYS = 2;

const KERNEL_EVENT_PAGE = 1_000;

/** The pid baked into a Core Session runner owner id, or undefined for any
 *  other owner (tests and foreign hosts choose their own ids). */
export function ownerPidOf(ownerId: string): number | undefined {
  const match = /^session_runner_(\d+)_/.exec(ownerId);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Signal 0 probes without killing. EPERM means the process exists but is
 *  not ours — alive, so the lease is honoured; only ESRCH (no such process)
 *  is a dead holder. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ExpireDeadOwnerLeasesOptions {
  /** The kernel's SQLite file (workspaceSessionKernelPath). */
  kernelPath: string;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Mark every runner lease whose owning pid is dead as already expired. The
 * store has no public "forfeit somebody else's lease" call on purpose (a live
 * holder must never lose its fence to a stranger); the next acquire sees an
 * expired row and runs the store's own recoverExpiredLeaseTx — tool runs,
 * claimed inputs, session_runs, the lease_expired event — exactly as it would
 * have 30 seconds later. Only the clock is moved. Returns the session ids
 * whose lease was expired.
 */
export async function expireDeadOwnerLeases(
  kernel: SessionKernelStore,
  options: ExpireDeadOwnerLeasesOptions,
): Promise<string[]> {
  const pidAlive = options.pidAlive ?? isPidAlive;
  const now = options.now ?? Date.now;
  const dead: Array<{ sessionId: string; ownerId: string; leaseToken: string; pid: number }> = [];
  for (const session of kernel.listSessions({ includeArchived: true })) {
    const lease = kernel.getRunnerLease(session.id);
    if (!lease || lease.expiresAtMs <= now()) continue;
    const pid = ownerPidOf(lease.ownerId);
    if (pid === undefined || pid === process.pid || pidAlive(pid)) continue;
    dead.push({ sessionId: session.id, ownerId: lease.ownerId, leaseToken: lease.leaseToken, pid });
  }
  if (dead.length === 0) return [];
  const Database = await loadBetterSqlite3();
  // A second handle on the same WAL file: the store's own connection stays
  // untouched, and the UPDATE is keyed on the exact token + owner so a lease
  // re-acquired between the read above and this write is left alone.
  const db = new Database(options.kernelPath, { timeout: 5_000 });
  const expired: string[] = [];
  try {
    const stamp = db.prepare(
      "UPDATE runner_leases SET expires_at_ms = ? WHERE session_id = ? AND lease_token = ? AND owner_id = ?",
    );
    for (const lease of dead) {
      const changed = stamp.run(now() - 1, lease.sessionId, lease.leaseToken, lease.ownerId).changes;
      if (changed === 0) continue;
      expired.push(lease.sessionId);
      options.log?.(`recovery: session ${lease.sessionId} was leased by dead pid ${lease.pid}; lease released for takeover`);
    }
  } finally {
    db.close();
  }
  return expired;
}

/** Mirrors Core Session's private predicate: plan hand-offs and background
 *  job completions are control inputs, never user turns to replay. */
function isAttachedControlInput(input: AdmittedInputRecord): boolean {
  const payload = input.payload;
  return input.delivery === "steer" &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    ((payload as { kind?: unknown }).kind === "approved-plan-build-handoff" ||
      (payload as { kind?: unknown }).kind === "background-job-completion");
}

export interface OrphanReplayPlan {
  /** Inputs Core Session is about to replay, with the attempt number this boot is. */
  replaying: Array<{ sessionId: string; inputId: string; attempt: number; maxAttempts: number }>;
  /** Inputs retired this boot because every earlier replay died. */
  retired: Array<{ sessionId: string; inputId: string; attempts: number }>;
}

export interface RetireExhaustedOrphansOptions {
  maxReplays?: number;
  log?: (line: string) => void;
}

/**
 * Bound and announce startup replays. Every replay the kernel ever started
 * for an input left an `input.detached_recovery_started` event; an input that
 * has already used its allowance is cancelled here (the same terminal state
 * Core Session gives a replay that fails), so the drain that follows skips it
 * and a poison input stops costing a provider call per boot. Everything still
 * eligible is logged with its attempt count, so the owner can see WHY the
 * agent is busy the moment the gateway comes up instead of watching a turn
 * nobody sent.
 */
export function retireExhaustedOrphans(
  kernel: SessionKernelStore,
  options: RetireExhaustedOrphansOptions = {},
): OrphanReplayPlan {
  const maxReplays = options.maxReplays ?? MAX_DETACHED_REPLAYS;
  const plan: OrphanReplayPlan = { replaying: [], retired: [] };
  for (const session of kernel.listSessions({ includeArchived: true })) {
    if (session.archived) continue;
    const orphans = kernel
      .listInputs(session.id)
      .filter((input) => (input.state === "admitted" || input.state === "claimed") && !isAttachedControlInput(input));
    if (orphans.length === 0) continue;
    const attemptsByInput = new Map<string, number>();
    let after = 0;
    for (;;) {
      const page = kernel.listEvents(session.id, { afterSequence: after, limit: KERNEL_EVENT_PAGE });
      for (const event of page) {
        if (event.type !== "input.detached_recovery_started") continue;
        const inputId = (event.payload as { inputId?: unknown } | null)?.inputId;
        if (typeof inputId !== "string") continue;
        attemptsByInput.set(inputId, (attemptsByInput.get(inputId) ?? 0) + 1);
      }
      if (page.length < KERNEL_EVENT_PAGE) break;
      after = page[page.length - 1]!.sequence;
    }
    for (const orphan of orphans) {
      const attempts = attemptsByInput.get(orphan.id) ?? 0;
      if (attempts < maxReplays) {
        plan.replaying.push({ sessionId: session.id, inputId: orphan.id, attempt: attempts + 1, maxAttempts: maxReplays });
        options.log?.(`recovery: replaying interrupted input ${orphan.id} on ${session.id} (attempt ${attempts + 1} of ${maxReplays})`);
        continue;
      }
      try {
        kernel.cancelInput(orphan.id, {
          sessionId: session.id,
          ...(orphan.state === "claimed" && orphan.claimedGeneration !== null
            ? { expectedGeneration: orphan.claimedGeneration }
            : {}),
          reason: {
            code: "DETACHED_RECOVERY_EXHAUSTED",
            message: `Startup recovery replayed this input ${attempts} time(s) after a crash and it never settled`,
          },
        });
        plan.retired.push({ sessionId: session.id, inputId: orphan.id, attempts });
        options.log?.(`recovery: input ${orphan.id} on ${session.id} failed ${attempts} replay(s); marked failed, not replaying again`);
      } catch (error) {
        // Leaving it to the drain is the pre-existing behaviour; never let a
        // bookkeeping failure stop the gateway from booting.
        options.log?.(`recovery: could not retire input ${orphan.id} on ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return plan;
}
