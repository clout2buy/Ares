// ApprovalQueue — the concrete bridge between the effects rails (the conscience
// layer) and the Garrison gateway (the owner).
//
// Before this, runEffect() could STAGE an irreversible effect for approval, but
// nothing carried that decision to a human: browserRailsContext supplied no
// requestApproval, so a staged effect was "held, never committed" and silently
// stalled. The conscience layer was yelling into a pillow.
//
// This closes the loop. One object plays both roles:
//   • RailsContext.requestApproval — a staged effect calls this and PAUSES on the
//     returned promise until the owner answers.
//   • ApprovalBridge — the GarrisonServer subscribes (→ broadcasts
//     approval.pending) and routes the owner's approval.respond back here.
//
// A staged effect therefore surfaces as a live, actionable approval on every
// attached client and resumes (commit) or refuses (rejected) the moment the
// owner decides — instead of moral theater that only a unit test ever saw.

import type { ApprovalDecision, StagedApproval } from "@ares/effects";
import type { ApprovalBridge, ApprovalResponse } from "./server.js";

interface PendingEntry {
  staged: StagedApproval;
  /** Every awaiter of this effect id (a re-stage of the same key joins here). */
  resolvers: Array<(decision: ApprovalDecision) => void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ApprovalQueueOptions {
  /** Auto-deny a staged effect if unanswered after this many ms. Default: wait for the owner. */
  timeoutMs?: number;
  /** Recorded as the approver on every decision (the owner). */
  approver?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class ApprovalQueue implements ApprovalBridge {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly subscribers = new Set<(staged: StagedApproval) => void>();
  private readonly opts: ApprovalQueueOptions;

  constructor(opts: ApprovalQueueOptions = {}) {
    this.opts = opts;
  }

  /**
   * RailsContext.requestApproval. A staged effect pauses on this promise until
   * the owner answers (or the optional timeout auto-denies). Re-staging the same
   * idempotency key joins the in-flight prompt rather than racing a second one.
   */
  requestApproval = (staged: StagedApproval): Promise<ApprovalDecision> => {
    return new Promise<ApprovalDecision>((resolve) => {
      const existing = this.entries.get(staged.id);
      if (existing) {
        existing.resolvers.push(resolve);
        return;
      }
      const entry: PendingEntry = { staged, resolvers: [resolve] };
      if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
        // NOT unref'd on purpose: a pending approval is real outstanding work,
        // and unref let headless runs exit mid-wait (the same lesson as the
        // provider retry backoff). respond()/dispose() clear it.
        entry.timer = setTimeout(() => {
          this.entries.delete(staged.id);
          this.settle(entry, { id: staged.id, verb: "deny", at: this.nowIso(), note: "auto-denied: approval timed out" });
        }, this.opts.timeoutMs);
      }
      this.entries.set(staged.id, entry);
      this.notify(staged);
    });
  };

  // ─── ApprovalBridge (the GarrisonServer side) ──────────────────────────────

  subscribe(cb: (staged: StagedApproval) => void): () => void {
    this.subscribers.add(cb);
    // Replay outstanding approvals so a client that attaches AFTER an effect
    // staged still sees the waiting decision (open the app → the prompt is there).
    for (const entry of this.entries.values()) {
      try {
        cb(entry.staged);
      } catch {
        // a bad subscriber must never break the queue
      }
    }
    return () => this.subscribers.delete(cb);
  }

  respond(decision: ApprovalResponse): void {
    const entry = this.entries.get(decision.approvalId);
    if (!entry) throw new Error(`no pending approval: ${decision.approvalId}`);
    this.entries.delete(decision.approvalId);
    if (entry.timer) clearTimeout(entry.timer);
    this.settle(entry, {
      id: decision.approvalId,
      verb: decision.verb,
      at: this.nowIso(),
      approver: this.opts.approver,
      note: decision.note,
    });
  }

  /** Outstanding staged effects awaiting a decision (replayed to late joiners). */
  pending(): StagedApproval[] {
    return [...this.entries.values()].map((e) => e.staged);
  }

  /** Shutdown: clear timers and deny everything still outstanding so no awaiter
   *  hangs and no timer blocks process exit. */
  dispose(): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      this.settle(entry, { id, verb: "deny", at: this.nowIso(), note: "denied: garrison shutting down" });
    }
    this.entries.clear();
    this.subscribers.clear();
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private settle(entry: PendingEntry, decision: ApprovalDecision): void {
    for (const resolve of entry.resolvers) {
      try {
        resolve(decision);
      } catch {
        // one awaiter throwing must not strand the others
      }
    }
  }

  private notify(staged: StagedApproval): void {
    for (const cb of this.subscribers) {
      try {
        cb(staged);
      } catch {
        // a bad subscriber must never break staging
      }
    }
  }

  private nowIso(): string {
    return (this.opts.now ?? (() => new Date()))().toISOString();
  }
}
