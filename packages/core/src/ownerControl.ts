// The owner's control plane — pause and stop as signals, not chat messages.
//
// "Please stop" typed into a conversation is a suggestion: the model reads it
// at its next boundary and may or may not comply, and it never reaches a
// subagent fleet, a scheduled job or a browser that is mid-click. The owner
// asked for a kill switch that PREEMPTS, so this module holds the two pieces
// every execution layer can consult without knowing about the others:
//
//   • the pause gate — one process-wide flag. The engine awaits it before it
//     executes ANY tool (parent turns, Task children, Conductor leaves and
//     operator workers all run through QueryEngine), so pausing freezes work
//     at the next tool boundary with its state intact for inspection. The wait
//     is bounded by the caller (the tool's own watchdog), so a pause the owner
//     forgets can never wedge a turn forever — it fails the tool with
//     "paused by owner" instead.
//
//   • the stop registry — anything long-running that is not a garrison turn
//     (a subagent, a fleet, an operator job step, a browser Ares opened)
//     registers a stop() while it runs. stopAll() is the owner's big red
//     button; the host adds the turns and pending prompts it owns.
//
// Pause and stop are different on purpose: pause freezes (resume continues
// exactly where it was), stop terminates (nothing resumes on its own).

export type OwnerPauseWait = "clear" | "timeout" | "aborted";

class OwnerPauseGate {
  private pausedAtMs: number | undefined;
  private readonly waiters = new Set<() => void>();

  get paused(): boolean {
    return this.pausedAtMs !== undefined;
  }

  /** ISO time the current pause began; undefined when running. */
  get pausedAt(): string | undefined {
    return this.pausedAtMs === undefined ? undefined : new Date(this.pausedAtMs).toISOString();
  }

  /** Freeze. Returns false when already paused (idempotent). */
  pause(now = Date.now()): boolean {
    if (this.pausedAtMs !== undefined) return false;
    this.pausedAtMs = now;
    return true;
  }

  /** Release every waiter. Returns false when nothing was paused. */
  resume(): boolean {
    if (this.pausedAtMs === undefined) return false;
    this.pausedAtMs = undefined;
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
    return true;
  }

  /**
   * Wait while paused. Resolves "clear" immediately when not paused (the hot
   * path costs one boolean check), "timeout" when the pause outlasted
   * `timeoutMs`, and "aborted" when `signal` fired first — a stop during a
   * pause must terminate, not wait for a resume that may never come.
   */
  wait(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OwnerPauseWait> {
    if (this.pausedAtMs === undefined) return Promise.resolve("clear");
    if (opts.signal?.aborted) return Promise.resolve("aborted");
    return new Promise<OwnerPauseWait>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: OwnerPauseWait) => {
        this.waiters.delete(wake);
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const wake = () => finish("clear");
      const onAbort = () => finish("aborted");
      this.waiters.add(wake);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        // Not unref'd: a paused tool is live work the process must stay up for.
        timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
      }
    });
  }

  /** How many callers are frozen at a boundary right now. */
  get waiting(): number {
    return this.waiters.size;
  }
}

/** The one pause gate for this process. */
export const ownerPause = new OwnerPauseGate();

// ─── Stop registry ──────────────────────────────────────────────────────

export type StoppableKind = "subagent" | "job" | "browser";

export interface StoppableEntry {
  kind: StoppableKind;
  id: string;
  /** Human label for the phone ("researcher: find the bug", "heartbeat"). */
  label?: string;
  /** Owning garrison session, when there is one. */
  sessionId?: string;
  /** Stays registered after a stop (a tool that owns a browser for its whole
   *  lifetime and may open another one later). Default: one-shot. */
  persistent?: boolean;
  /** Terminate it. Return false when there was nothing live to stop (a
   *  browser tool with no open browser) so the owner's count stays honest. */
  stop(reason: string): boolean | void | Promise<boolean | void>;
}

interface Registered extends StoppableEntry {
  token: number;
  startedAt: string;
}

const registry = new Map<number, Registered>();
let nextToken = 1;

/** Register a live stoppable. Call the returned function when it finishes. */
export function registerStoppable(entry: StoppableEntry): () => void {
  const token = nextToken++;
  registry.set(token, { ...entry, token, startedAt: new Date().toISOString() });
  return () => void registry.delete(token);
}

/** What is registered right now, oldest first. */
export function listStoppables(kind?: StoppableKind): Array<Omit<StoppableEntry, "stop"> & { startedAt: string }> {
  return [...registry.values()]
    .filter((entry) => kind === undefined || entry.kind === kind)
    .map(({ kind: k, id, label, sessionId, startedAt }) => ({
      kind: k,
      id,
      startedAt,
      ...(label ? { label } : {}),
      ...(sessionId ? { sessionId } : {}),
    }));
}

/**
 * Stop everything registered (optionally only some kinds). Each stop is
 * isolated — one throwing entry never shields the rest — and bounded, so a
 * browser that hangs on close cannot hold the kill switch hostage.
 */
export async function stopAllStoppables(
  reason: string,
  kinds?: readonly StoppableKind[],
  perEntryTimeoutMs = 5_000,
): Promise<Record<StoppableKind, number>> {
  const counts: Record<StoppableKind, number> = { subagent: 0, job: 0, browser: 0 };
  const targets = [...registry.values()].filter((entry) => !kinds || kinds.includes(entry.kind));
  await Promise.all(
    targets.map(async (entry) => {
      let stopped: boolean | void = false;
      try {
        stopped = await Promise.race([
          Promise.resolve(entry.stop(reason)),
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), perEntryTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } catch {
        // A stop that throws still counts as attempted: the entry was live.
        stopped = true;
      }
      if (stopped !== false) counts[entry.kind] += 1;
      if (!entry.persistent) registry.delete(entry.token);
    }),
  );
  return counts;
}
