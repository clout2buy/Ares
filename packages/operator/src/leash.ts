// The leash dividend (ARES V8) — learning and safety become one system.
//
// The effects rails gate every side effect by irreversibility tier, and
// `leashOf(domain)` decides how much runs unsupervised (see
// @ares/effects rails.ts LEASH_REQUIRED: reversible 1, recoverable 2,
// irreversible 5). Before this file, the leash was a static default. Now it
// is EARNED: a domain's leash derives from the Crucible — confirmed
// procedures with positive win/loss records lengthen it; debited records
// shorten it, automatically. Every change is recorded through an injected
// ledger appender with the evidence that justified it, so trust is as
// auditable as the effects it unlocks.
//
// Dependency note: effects must stay leaf-light, so this lives in operator
// (which owns mind access) and PLUGS INTO RailsContext.leashOf — the
// composition root passes governor.leashOf.bind(governor).

import type { MemoryNode } from "@ares/mind";
import { recordOf } from "./crucible.js";

export interface LeashChange {
  at: string;
  domain: string;
  level: number;
  prevLevel: number;
  /** Node ids + records that justified the level — the audit trail. */
  evidence: string[];
}

export type LeashAppender = (change: LeashChange) => void | Promise<void>;

/** A node only counts toward a domain's leash when it carries this tag. */
export function domainOf(node: MemoryNode): string | undefined {
  const tag = node.tags?.find((t) => t.startsWith("domain:"));
  return tag ? tag.slice("domain:".length) : undefined;
}

/** Net-positive margin a confirmed procedure needs to count as PROVEN. */
const PROVEN_MARGIN = 2;
const BASE_LEASH = 1;
const MAX_LEASH = 5;

export interface LeashBasis {
  level: number;
  /** The proven procedures behind the level, with their records. */
  proven: Array<{ id: string; wins: number; losses: number }>;
}

/**
 * Derive a domain's earned leash from the Crucible state:
 *   level = 1 + (number of confirmed procedural nodes in the domain whose
 *           record is net-positive by ≥2), capped at 5.
 * Hypotheses (candidates) contribute nothing — domains running on guesses
 * stay on the shortest leash no matter how many guesses they hold.
 */
export function deriveLeash(nodes: readonly MemoryNode[], domain: string): LeashBasis {
  const proven: LeashBasis["proven"] = [];
  for (const node of nodes) {
    if (node.status !== "confirmed") continue;
    if (node.kind !== "procedural") continue;
    if (domainOf(node) !== domain) continue;
    const { wins, losses } = recordOf(node);
    if (wins - losses >= PROVEN_MARGIN) proven.push({ id: node.id, wins, losses });
  }
  return { level: Math.min(MAX_LEASH, BASE_LEASH + proven.length), proven };
}

export interface TrustGovernorOptions {
  /** Fresh node snapshot per query — usually MemoryStore.all.bind(store). */
  nodes: () => readonly MemoryNode[];
  /** Receives every level CHANGE with its evidence (wire to the effects ledger). */
  append?: LeashAppender;
  now?: () => Date;
}

/**
 * The O7 TrustGovernor, finally fed by evidence. Stateless against the store
 * (re-derives per call) but remembers the last level it reported per domain so
 * changes — and only changes — hit the ledger.
 */
export class TrustGovernor {
  private readonly last = new Map<string, number>();

  constructor(private readonly opts: TrustGovernorOptions) {}

  /** RailsContext.leashOf-compatible. Synchronous; ledger writes are fire-safe. */
  leashOf(domain: string): number {
    const basis = deriveLeash(this.opts.nodes(), domain);
    const prev = this.last.get(domain) ?? BASE_LEASH;
    if (basis.level !== prev && this.opts.append) {
      const change: LeashChange = {
        at: (this.opts.now?.() ?? new Date()).toISOString(),
        domain,
        level: basis.level,
        prevLevel: prev,
        evidence: basis.proven.map((p) => `${p.id} (${p.wins}W/${p.losses}L)`),
      };
      void Promise.resolve(this.opts.append(change)).catch(() => {
        // The leash itself must never fail on a ledger hiccup.
      });
    }
    this.last.set(domain, basis.level);
    return basis.level;
  }

  /** Explain a domain's current level (for the desktop Crucible panel). */
  explain(domain: string): LeashBasis {
    return deriveLeash(this.opts.nodes(), domain);
  }
}
