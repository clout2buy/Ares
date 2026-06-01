// @crix/effects — the conscience layer (Crix v5 / O2).
//
// Every side effect that touches the world flows through one choke point:
// runEffect() applies the kill switch, idempotency, dry-run simulation, the
// irreversibility gate, and the budget, and appends every transition to an
// append-only ledger. Connectors (O6+) implement EffectSpec; the Operator's
// dispatcher routes worker-proposed effects through here. Ships before any
// real connector so the safety story is proven first.

export { runEffect, undoEffect, ownerLeash, LEASH_REQUIRED, type RailsContext, type OwnerLeashOptions } from "./rails.js";
export { Ledger } from "./ledger.js";
export { Budget, type BudgetLimits, type SpendSnapshot, type BudgetCheck } from "./budget.js";
export { KillSwitch, HaltedError } from "./killSwitch.js";
export { effectsPaths, type EffectsPaths } from "./paths.js";
export type {
  EffectSpec,
  EffectCost,
  Irreversibility,
  LedgerEntry,
  LedgerPhase,
  GateDecision,
  RailsResult,
  RailsStatus,
} from "./types.js";
