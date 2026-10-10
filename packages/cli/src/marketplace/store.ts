// Marketplace state on disk: watches, what each watch has already seen, staged /
// approved drafts, the send ledger (for the per-hour and per-seller caps), the
// page-visit log (for the global pages-per-hour budget) and the wall cooldown.
//
// Nothing sensitive lives here: no cookies, no page content beyond the listing
// fields the owner already saw, and message text only for drafts the owner is
// asked to approve. One JSON file under <ARES_HOME>/marketplace, mode 0600,
// written atomically and serialised in-process.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SearchParams, WallKind } from "./core.js";

export interface WatchFilters extends Omit<SearchParams, "query"> {
  limit?: number;
}

export interface Watch {
  id: string;
  query: string;
  filters: WatchFilters;
  intervalMinutes: number;
  createdAt: number;
  /** Epoch ms of the next check; jittered when scheduled. */
  nextDueAt: number;
  lastCheckedAt?: number;
  lastResult?: string;
}

export type DraftStatus = "pending" | "approved" | "sending" | "sent" | "sent_unverified" | "failed";

export interface Draft {
  id: string;
  listingId: string;
  url: string;
  title: string;
  price: string;
  location: string;
  seller: string;
  sellerKey: string;
  text: string;
  /** sha256 of sessionId|listingId|text, the link between the permission prompt and call(). */
  link: string;
  status: DraftStatus;
  createdAt: number;
  approvedAt?: number;
  approvedSession?: string;
  sentAt?: number;
  note?: string;
}

export interface SendRecord {
  at: number;
  sellerKey: string;
  listingId: string;
  draftId: string;
  outcome: "sent" | "sent_unverified";
}

export interface WallRecord {
  kind: WallKind;
  reason: string;
  at: number;
  /** No Facebook page is touched before this time (login walls clear when the owner reconnects). */
  until: number;
}

export interface MarketplaceState {
  v: 1;
  watches: Watch[];
  seen: Record<string, string[]>;
  drafts: Draft[];
  sends: SendRecord[];
  pages: number[];
  wall?: WallRecord;
}

const EMPTY = (): MarketplaceState => ({ v: 1, watches: [], seen: {}, drafts: [], sends: [], pages: [] });

export function marketplaceDir(home?: string): string {
  return path.join(home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares"), "marketplace");
}

const DAY = 86_400_000;

export class MarketplaceStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;

  constructor(
    readonly home: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(marketplaceDir(home), "state.json");
  }

  async read(): Promise<MarketplaceState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<MarketplaceState>;
      return {
        v: 1,
        watches: Array.isArray(parsed.watches) ? parsed.watches : [],
        seen: parsed.seen && typeof parsed.seen === "object" ? parsed.seen : {},
        drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [],
        sends: Array.isArray(parsed.sends) ? parsed.sends : [],
        pages: Array.isArray(parsed.pages) ? parsed.pages.filter((n) => typeof n === "number") : [],
        ...(parsed.wall ? { wall: parsed.wall } : {}),
      };
    } catch {
      return EMPTY();
    }
  }

  /** Read, change and write back as one serialised step. Old ledger rows are pruned on the way. */
  mutate<T>(fn: (state: MarketplaceState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.read();
      const now = this.now();
      state.pages = state.pages.filter((t) => now - t < 3_600_000);
      state.sends = state.sends.filter((s) => now - s.at < 2 * DAY);
      // Keep drafts for a day, and at most 40 of them.
      state.drafts = state.drafts.filter((d) => now - d.createdAt < DAY).slice(-40);
      const result = await fn(state);
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tmp, this.file);
      return result;
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
