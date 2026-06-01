// The Ledger — append-only audit of every effect, at every lifecycle phase.
//
// This is the source of truth for "did this already happen?" on resume, and
// the artifact that makes autonomy auditable (the precondition for ever
// extending a leash). Append-only: entries are never mutated or rewritten. An
// in-memory mirror is kept so idempotency and spend checks are fast and the
// rails never have to re-read the whole file mid-commit.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { LedgerEntry } from "./types.js";

export class Ledger {
  private constructor(
    private readonly file: string,
    private readonly entries: LedgerEntry[],
  ) {}

  /** Open a ledger, loading any prior entries (tolerant of a partial tail). */
  static async open(file: string): Promise<Ledger> {
    const entries: LedgerEntry[] = [];
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as LedgerEntry);
        } catch {
          // skip a corrupt/partial line — append-only logs can have a torn tail
        }
      }
    } catch {
      // no ledger yet
    }
    return new Ledger(file, entries);
  }

  /** In-memory ledger (no file) — for tests and ephemeral runs. */
  static memory(): Ledger {
    return new Ledger("", []);
  }

  async append(entry: LedgerEntry): Promise<void> {
    this.entries.push(entry);
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
  }

  /** Idempotency check: has this key already reached a committed phase? */
  committed(idempotencyKey: string): boolean {
    return this.entries.some((e) => e.phase === "committed" && e.idempotencyKey === idempotencyKey);
  }

  /** Sum of committed dollar cost, optionally scoped to a domain and/or since a time. */
  spend(opts: { domain?: string; sinceMs?: number } = {}): number {
    let total = 0;
    for (const e of this.entries) {
      if (e.phase !== "committed") continue;
      if (opts.domain !== undefined && e.domain !== opts.domain) continue;
      if (opts.sinceMs !== undefined && Date.parse(e.at) < opts.sinceMs) continue;
      total += e.cost?.dollars ?? 0;
    }
    return total;
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }
}
