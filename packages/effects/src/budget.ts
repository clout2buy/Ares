// Budget — per-domain ceilings and a daily cap. A hard ceiling, not advisory:
// commit is refused past the limit. Spend is measured from the ledger (only
// committed effects count), so budgets survive restarts.

import type { EffectCost } from "./types.js";

export interface BudgetLimits {
  /** Max committed dollars per domain (e.g. { "spend:ads": 50 }). */
  perDomain?: Record<string, number>;
  /** Max committed dollars across all domains per day. */
  daily?: number;
}

export interface SpendSnapshot {
  /** Dollars already committed in this effect's domain. */
  domain: number;
  /** Dollars already committed across all domains today. */
  day: number;
}

export interface BudgetCheck {
  ok: boolean;
  reason?: string;
}

export class Budget {
  constructor(private readonly limits: BudgetLimits = {}) {}

  /** Would committing `cost` in `domain` stay within every limit? */
  check(domain: string, cost: EffectCost | undefined, spent: SpendSnapshot): BudgetCheck {
    const add = cost?.dollars ?? 0;
    if (add <= 0 && this.limits.daily === undefined) return { ok: true };

    const domainLimit = this.limits.perDomain?.[domain];
    if (domainLimit !== undefined && spent.domain + add > domainLimit) {
      return { ok: false, reason: `domain "${domain}" budget exceeded ($${domainLimit}; would reach $${(spent.domain + add).toFixed(2)})` };
    }
    if (this.limits.daily !== undefined && spent.day + add > this.limits.daily) {
      return { ok: false, reason: `daily cap exceeded ($${this.limits.daily}; would reach $${(spent.day + add).toFixed(2)})` };
    }
    return { ok: true };
  }
}
