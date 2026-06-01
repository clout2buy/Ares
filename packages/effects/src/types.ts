// Effects + rails domain types (Crix v5 / O2 / concept C8).
//
// An Effect is the unit of touching the world. Workers never call the world
// directly — they propose Effects, which flow through one choke point
// (runEffect) where the ledger, budget, kill switch, idempotency, and the
// irreversibility gate all apply uniformly. This is the conscience layer, and
// it ships BEFORE any real connector so the safety story is battle-tested
// before anything can send an email or charge a card.

/**
 * The master risk axis (C8): the world has no undo. Irreversibility outranks
 * cost in the gate — a cheap irreversible action (one bad public post) can
 * cost more than an expensive reversible one.
 */
export type Irreversibility = "reversible" | "recoverable" | "irreversible";

export interface EffectCost {
  tokens?: number;
  dollars?: number;
}

/**
 * A proposed side effect. simulate() MUST be free of side effects — it is the
 * dry-run the whole safety story rests on. commit() does the real thing. undo()
 * is optional and makes a "recoverable" effect actionable on mission abandon.
 */
export interface EffectSpec<R = unknown> {
  kind: string; // "fs.write", "email.send", "http.post"
  domain: string; // "fs", "email", "spend:ads" — the leash/budget bucket
  cost?: EffectCost;
  irreversibility: Irreversibility;
  /** A committed key is never committed twice (survives crash + resume). */
  idempotencyKey: string;
  /** The Worker's pre-commit prediction — fuels O7 calibration. */
  predict?: { outcome: string; p: number };
  simulate(): Promise<unknown>;
  commit(): Promise<R>;
  undo?(): Promise<void>;
}

export type LedgerPhase =
  | "proposed"
  | "simulated"
  | "staged" // gated: needs approval (leash too short for this irreversibility)
  | "denied" // gated: budget/policy refusal
  | "committed"
  | "already" // idempotent no-op: this key was already committed
  | "undone"
  | "halted"; // kill switch engaged

export interface LedgerEntry {
  at: string;
  phase: LedgerPhase;
  kind: string;
  domain: string;
  idempotencyKey: string;
  irreversibility: Irreversibility;
  cost?: EffectCost;
  detail?: string;
}

export type GateDecision =
  | { kind: "allow" }
  | { kind: "stage"; reason: string }
  | { kind: "deny"; reason: string };

export type RailsStatus = "committed" | "already" | "staged" | "denied";

export interface RailsResult<R = unknown> {
  status: RailsStatus;
  result?: R;
  reason?: string;
}
