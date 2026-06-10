// The rails — the single choke point every effect flows through.
//
//   kill-switch → idempotency → proposed → simulate → GATE → commit → ledger
//
// The gate enforces concept C8: irreversibility is the master risk axis. A
// reversible effect under budget commits freely; a recoverable or irreversible
// one needs an earned leash (O7's TrustGovernor plugs into `leashOf`) or it is
// STAGED for human approval — never silently committed. Budget is a hard
// ceiling on top. Every transition is appended to the ledger.

import type { Budget } from "./budget.js";
import type { Ledger } from "./ledger.js";
import { HaltedError, type KillSwitch } from "./killSwitch.js";
import type { EffectSpec, GateDecision, Irreversibility, LedgerEntry, RailsResult } from "./types.js";
import type { ApprovalDecision, StagedApproval } from "./approval.js";

/** Minimum leash required to auto-commit each irreversibility tier. */
export const LEASH_REQUIRED: Record<Irreversibility, number> = {
  reversible: 1,
  recoverable: 2,
  irreversible: 5,
};

export interface RailsContext {
  ledger: Ledger;
  budget: Budget;
  killSwitch: KillSwitch;
  /** Earned autonomy per domain (O7 TrustGovernor). Defaults to 1 (ask). */
  leashOf?: (domain: string) => number;
  /**
   * Human-in-the-loop approver. When provided, a STAGED effect pauses here and
   * resumes (commit) on allow_* or refuses (rejected) on deny. When ABSENT, a
   * staged effect keeps the legacy behavior — held, never committed — so nothing
   * that doesn't opt in changes.
   */
  requestApproval?: (staged: StagedApproval) => Promise<ApprovalDecision>;
  now?: () => Date;
}

export async function runEffect<R>(effect: EffectSpec<R>, ctx: RailsContext): Promise<RailsResult<R>> {
  const now = ctx.now ?? (() => new Date());

  // Kill switch first — nothing happens while halted.
  if (await ctx.killSwitch.engaged()) {
    await ctx.ledger.append(entry(effect, "halted", now()));
    throw new HaltedError();
  }

  // Idempotency: a committed key is never committed twice (survives resume).
  if (ctx.ledger.committed(effect.idempotencyKey)) {
    return { status: "already" };
  }

  await ctx.ledger.append(entry(effect, "proposed", now()));

  // Dry-run. simulate() must have no side effect. Its output is captured as the
  // approval preview — the "what would happen" the owner reviews.
  const preview = await effect.simulate();
  await ctx.ledger.append(entry(effect, "simulated", now()));

  // GATE.
  const decision = gate(effect, ctx, now());
  if (decision.kind === "deny") {
    await ctx.ledger.append(entry(effect, "denied", now(), decision.reason));
    return { status: "denied", reason: decision.reason };
  }
  if (decision.kind === "stage") {
    await ctx.ledger.append(entry(effect, "staged", now(), decision.reason));
    // No approver wired → legacy behavior: hold the effect, never commit.
    if (!ctx.requestApproval) {
      return { status: "staged", reason: decision.reason };
    }
    // Approver wired → pause for a human decision, then resume or refuse.
    const verdict = await ctx.requestApproval({
      id: effect.idempotencyKey,
      kind: effect.kind,
      domain: effect.domain,
      irreversibility: effect.irreversibility,
      cost: effect.cost,
      reason: decision.reason,
      preview,
    });
    if (verdict.verb === "deny") {
      await ctx.ledger.append({ ...entry(effect, "rejected", now(), verdict.note), approvalId: verdict.id, approver: verdict.approver });
      return { status: "denied", reason: verdict.note ?? "approval denied" };
    }
    await ctx.ledger.append({ ...entry(effect, "approved", now()), approvalId: verdict.id, approver: verdict.approver });
    // approved → fall through to the commit path (with a fresh kill-switch recheck)
  }

  // Re-check the kill switch right before the irreversible moment (race window).
  if (await ctx.killSwitch.engaged()) {
    await ctx.ledger.append(entry(effect, "halted", now()));
    throw new HaltedError();
  }

  const result = await effect.commit();
  await ctx.ledger.append(entry(effect, "committed", now()));
  return { status: "committed", result };
}

/**
 * Undo a previously committed, recoverable effect (the O2 OP UPGRADE). Records
 * an "undone" ledger entry. Throws if the effect carries no undo().
 */
export async function undoEffect(effect: EffectSpec, ctx: RailsContext): Promise<void> {
  if (!effect.undo) throw new Error(`effect ${effect.kind} (${effect.idempotencyKey}) has no undo()`);
  await effect.undo();
  await ctx.ledger.append(entry(effect, "undone", (ctx.now ?? (() => new Date()))()));
}

function gate(effect: EffectSpec, ctx: RailsContext, now: Date): GateDecision {
  // Budget is a hard ceiling (only relevant when there's a dollar cost).
  if ((effect.cost?.dollars ?? 0) > 0) {
    const dayStart = startOfDayMs(now);
    const check = ctx.budget.check(effect.domain, effect.cost, {
      domain: ctx.ledger.spend({ domain: effect.domain }),
      day: ctx.ledger.spend({ sinceMs: dayStart }),
    });
    if (!check.ok) return { kind: "deny", reason: check.reason ?? "budget exceeded" };
  }

  // Irreversibility dominates: even a FREE irreversible effect faces scrutiny.
  const leash = (ctx.leashOf ?? (() => 1))(effect.domain);
  const required = LEASH_REQUIRED[effect.irreversibility];
  if (leash < required) {
    return {
      kind: "stage",
      reason: `${effect.irreversibility} effect in "${effect.domain}" needs leash >= ${required}, have ${leash}`,
    };
  }
  return { kind: "allow" };
}

function entry(effect: EffectSpec, phase: LedgerEntry["phase"], now: Date, detail?: string): LedgerEntry {
  return {
    at: now.toISOString(),
    phase,
    kind: effect.kind,
    domain: effect.domain,
    idempotencyKey: effect.idempotencyKey,
    irreversibility: effect.irreversibility,
    cost: effect.cost,
    detail,
  };
}

function startOfDayMs(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

export interface OwnerLeashOptions {
  /** Domains the owner pulls back to require approval, with their leash value. */
  restricted?: Record<string, number>;
  /** Leash for everything else. Defaults wide open — even irreversible commits. */
  trust?: number;
}

/**
 * The unleash posture (v6 / M0): the owner holds the dial, default wide open.
 * With no options, every domain gets a leash high enough to auto-commit even
 * irreversible effects — Ares acts freely. The owner can still pull specific
 * domains back (e.g. { "spend:ads": 1 }) so only those pause for approval.
 *
 * Note: this only governs OUTWARD effects. Thinking, learning, self-evolution,
 * memory, and local action never touch the rails at all — they're always free.
 */
export function ownerLeash(opts: OwnerLeashOptions = {}): (domain: string) => number {
  const trust = opts.trust ?? 99; // >> LEASH_REQUIRED.irreversible (5)
  return (domain: string) => opts.restricted?.[domain] ?? trust;
}

export { HaltedError };
