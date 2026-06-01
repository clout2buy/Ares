// The Scheduler — what wakes the control loop.
//
// Event-driven first, interval-second (the O1 OP UPGRADE): an enqueued event
// (inbound email, webhook, deploy-finished) fires a tick immediately; the
// interval is just the fallback heartbeat. This is the difference between a
// cron job and something that *reacts*.
//
// The interval timer is unref()'d so it never keeps the process (or a test)
// alive on its own.

export interface SchedulerOptions {
  /** Fallback heartbeat interval in ms. */
  everyMs: number;
  /** Fired on every interval tick and on every enqueued event. */
  onTick: (reason: "interval" | "event") => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly events: unknown[] = [];
  private running = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.fire("interval"), this.opts.everyMs);
    // Never let the heartbeat alone hold the process open.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  get started(): boolean {
    return this.timer !== undefined;
  }

  /** Wake the loop now; the event is queued for the loop to drain. */
  enqueueEvent(event: unknown): void {
    this.events.push(event);
    void this.fire("event");
  }

  pendingEvents(): number {
    return this.events.length;
  }

  drainEvents(): unknown[] {
    return this.events.splice(0, this.events.length);
  }

  private async fire(reason: "interval" | "event"): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      await this.opts.onTick(reason);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
  }
}
