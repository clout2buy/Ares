// Bank data — ONE normalized pipeline over two providers.
//
// Each provider adapter turns its API into the same records (bankAnalytics.ts
// NormAccount / NormTransaction); every analytic the Bank tool offers runs on
// those, so SimpleFIN and Plaid answer "what are my subscriptions?" the same
// way. Snapshots are cached per provider so a conversation that asks four
// questions makes one round of API calls:
//   simplefin  one request = 90 days of transactions + balances (the most one
//              request may span). Cached for an hour, and a persisted counter
//              holds Ares to SimpleFIN's "24 requests or fewer per day" — past
//              it, the last snapshot is served with a warning.
//   plaid      /accounts/get (cached balances, not billed per call) + the
//              /transactions/sync delta per linked bank, applied to a local
//              per-Item store (<ARES_HOME>/plaid/<item_id>.json). Cached 15 min.
//              `live` uses /accounts/balance/get instead — real-time, and
//              billed per request by Plaid, so only when the owner asks.
// ARES_BANK_CACHE_MS overrides both TTLs (0 disables the cache).

import path from "node:path";
import { aresHome } from "@ares/core";
import type { NormAccount, NormTransaction } from "./bankAnalytics.js";
import { isoDaysAgo, prettyCategory } from "./bankAnalytics.js";
import { normalizeSimplefinAccount, normalizeSimplefinTransaction, simplefinAccounts } from "./simplefin.js";
import {
  PlaidError,
  plaidCall,
  plaidErrorSentence,
  plaidItemFile,
  readJsonFile,
  writeJsonFile,
  type PlaidConfig,
  type PlaidItem,
} from "./plaidApi.js";

export type BankProvider = "plaid" | "simplefin";

export interface BankSnapshot {
  provider: BankProvider;
  accounts: NormAccount[];
  transactions: NormTransaction[];
  warnings: string[];
  fetchedAt: number;
  /** Transactions reach back this many days (0 = balances only). */
  days: number;
}

const SIMPLEFIN_TTL_MS = 60 * 60_000;
const PLAID_TTL_MS = 15 * 60_000;
const SIMPLEFIN_DAILY_REQUESTS = 24;
const SIMPLEFIN_WINDOW_DAYS = 90;
const PLAID_KEEP_DAYS = 730;

const cache = new Map<string, BankSnapshot>();

/** Drop cached snapshots (tests; after a bank is added or removed). */
export function clearBankCache(): void {
  cache.clear();
}

function ttl(provider: BankProvider): number {
  const raw = process.env.ARES_BANK_CACHE_MS;
  if (raw !== undefined && raw.trim() !== "" && Number.isFinite(Number(raw))) return Math.max(0, Number(raw));
  return provider === "simplefin" ? SIMPLEFIN_TTL_MS : PLAID_TTL_MS;
}

function fresh(snap: BankSnapshot | undefined, days: number): snap is BankSnapshot {
  return Boolean(snap && Date.now() - snap.fetchedAt < ttl(snap.provider) && snap.days >= days);
}

// ─── SimpleFIN ───────────────────────────────────────────────────────────────

function simplefinCounterFile(home?: string): string {
  return path.join(home ?? aresHome(), "bank", "simplefin-requests.json");
}

async function simplefinBudget(home?: string): Promise<{ used: number; record: () => Promise<void> }> {
  const file = simplefinCounterFile(home);
  const cutoff = Date.now() - 86_400_000;
  const stamps = ((await readJsonFile<{ at?: number[] }>(file))?.at ?? []).filter((n) => typeof n === "number" && n > cutoff);
  return { used: stamps.length, record: () => writeJsonFile(file, { at: [...stamps, Date.now()] }) };
}

export async function simplefinSnapshot(access: string, opts: { signal?: AbortSignal; home?: string; refresh?: boolean } = {}): Promise<BankSnapshot> {
  const cached = cache.get("simplefin");
  if (!opts.refresh && fresh(cached, SIMPLEFIN_WINDOW_DAYS)) return cached;
  const budget = await simplefinBudget(opts.home);
  if (budget.used >= SIMPLEFIN_DAILY_REQUESTS) {
    const note = `SimpleFIN asks apps to make at most ${SIMPLEFIN_DAILY_REQUESTS} requests a day and Ares has used them; its data only updates daily anyway.`;
    if (cached) return { ...cached, warnings: [...cached.warnings, `${note} Showing data from ${new Date(cached.fetchedAt).toISOString().slice(0, 16)}Z.`] };
    throw new Error(`${note} Try again later.`);
  }
  const start = Math.floor(Date.now() / 1000) - SIMPLEFIN_WINDOW_DAYS * 86_400;
  await budget.record();
  const { accounts, errors } = await simplefinAccounts(access, { "start-date": String(start), pending: "1" }, opts.signal);
  const snap: BankSnapshot = {
    provider: "simplefin",
    accounts: accounts.map(normalizeSimplefinAccount),
    transactions: accounts.flatMap((a) => (Array.isArray(a.transactions) ? a.transactions : []).map((t: Record<string, any>) => normalizeSimplefinTransaction(a, t))),
    warnings: errors,
    fetchedAt: Date.now(),
    days: SIMPLEFIN_WINDOW_DAYS,
  };
  cache.set("simplefin", snap);
  return snap;
}

// ─── Plaid ───────────────────────────────────────────────────────────────────

const DEBT_TYPES = new Set(["credit", "loan"]);

/** Plaid account → normalized. Plaid reports what's OWED on credit/loan
 *  accounts as a positive current balance; normalized, owed is negative. */
export function normalizePlaidAccount(a: Record<string, any>, item: Pick<PlaidItem, "item_id" | "institution_name">): NormAccount {
  const b = (a.balances ?? {}) as Record<string, any>;
  const debt = DEBT_TYPES.has(String(a.type));
  const current = Number(b.current ?? b.available ?? 0);
  const available = b.available === null || b.available === undefined ? undefined : Number(b.available);
  return {
    id: String(a.account_id),
    provider: "plaid",
    institution: item.institution_name,
    name: `${String(a.name ?? a.official_name ?? "Account")}${a.mask ? ` …${a.mask}` : ""}`,
    type: [a.type, a.subtype].filter(Boolean).join("/"),
    balance: debt ? -current : current,
    ...(available !== undefined && Number.isFinite(available) ? { available } : {}),
    currency: String(b.iso_currency_code ?? b.unofficial_currency_code ?? "USD"),
    itemId: item.item_id,
  };
}

/** Plaid transaction → normalized. Plaid: positive = money out; flipped. */
export function normalizePlaidTransaction(t: Record<string, any>): NormTransaction {
  const pfc = t.personal_finance_category?.primary;
  return {
    id: String(t.transaction_id),
    accountId: String(t.account_id),
    date: String(t.date ?? t.authorized_date ?? ""),
    amount: -Number(t.amount),
    description: String(t.name ?? t.original_description ?? t.merchant_name ?? "").slice(0, 200),
    ...(t.merchant_name ? { merchant: String(t.merchant_name) } : {}),
    ...(pfc ? { category: prettyCategory(String(pfc)) } : {}),
    ...(t.pending ? { pending: true } : {}),
  };
}

interface PlaidItemStore {
  cursor: string;
  transactions: Record<string, NormTransaction>;
  syncedAt?: string;
}

/**
 * Bring one Item's local store up to date with /transactions/sync and return
 * it. Pages until has_more is false; a mutation mid-pagination restarts from
 * the cursor the loop began with, as Plaid's docs require. Only a complete
 * loop moves the stored cursor.
 */
export async function syncPlaidItem(cfg: PlaidConfig, item: PlaidItem, opts: { home?: string; signal?: AbortSignal } = {}): Promise<{ store: PlaidItemStore; notReady: boolean }> {
  const file = plaidItemFile(item.item_id, opts.home);
  const store: PlaidItemStore = (await readJsonFile<PlaidItemStore>(file)) ?? { cursor: "", transactions: {} };
  store.transactions ??= {};
  const startCursor = store.cursor ?? "";
  let restarts = 0;
  for (;;) {
    const added: Record<string, any>[] = [];
    const modified: Record<string, any>[] = [];
    const removed: string[] = [];
    let cursor = startCursor;
    let status = "";
    let pages = 0;
    try {
      for (;;) {
        const page = await plaidCall(cfg, "/transactions/sync", { access_token: item.access_token, ...(cursor ? { cursor } : {}), count: 500 }, opts.signal);
        added.push(...(page.added ?? []));
        modified.push(...(page.modified ?? []));
        removed.push(...((page.removed ?? []) as Array<{ transaction_id?: string }>).map((r) => String(r.transaction_id)));
        cursor = String(page.next_cursor ?? cursor);
        status = String(page.transactions_update_status ?? status);
        pages += 1;
        if (!page.has_more || pages >= 40) break;
      }
    } catch (err) {
      if (err instanceof PlaidError && err.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && restarts < 2) {
        restarts += 1;
        continue;
      }
      throw err;
    }
    for (const t of [...added, ...modified]) {
      const n = normalizePlaidTransaction(t);
      store.transactions[n.id] = n;
    }
    for (const id of removed) delete store.transactions[id];
    const floor = isoDaysAgo(PLAID_KEEP_DAYS);
    for (const [id, t] of Object.entries(store.transactions)) if (t.date < floor) delete store.transactions[id];
    store.cursor = cursor;
    store.syncedAt = new Date().toISOString();
    await writeJsonFile(file, store);
    const notReady = !Object.keys(store.transactions).length && /NOT_READY/.test(status);
    return { store, notReady };
  }
}

/**
 * Every linked bank's accounts (and, unless balancesOnly, transactions).
 * A rate limit stops the whole call; any other per-bank failure (a bank that
 * needs a fresh login) becomes a warning and the other banks still answer.
 */
export async function plaidSnapshot(
  cfg: PlaidConfig,
  items: PlaidItem[],
  opts: { balancesOnly?: boolean; live?: boolean; refresh?: boolean; home?: string; signal?: AbortSignal } = {},
): Promise<BankSnapshot> {
  const want = opts.balancesOnly ? 0 : PLAID_KEEP_DAYS;
  const cached = cache.get("plaid");
  if (!opts.refresh && !opts.live && fresh(cached, want)) return cached;
  const snap: BankSnapshot = { provider: "plaid", accounts: [], transactions: [], warnings: [], fetchedAt: Date.now(), days: want };
  let failures = 0;
  let firstError: unknown;
  for (const item of items) {
    try {
      const accounts = await plaidCall(cfg, opts.live ? "/accounts/balance/get" : "/accounts/get", { access_token: item.access_token }, opts.signal);
      snap.accounts.push(...((accounts.accounts ?? []) as Record<string, any>[]).map((a) => normalizePlaidAccount(a, item)));
      if (!opts.balancesOnly) {
        const { store, notReady } = await syncPlaidItem(cfg, item, opts);
        snap.transactions.push(...Object.values(store.transactions));
        if (notReady) snap.warnings.push(`Plaid is still pulling ${item.institution_name}'s transaction history — ask again in a minute or two.`);
      }
    } catch (err) {
      if (err instanceof PlaidError && err.rateLimited) throw new Error(plaidErrorSentence(err, item));
      failures += 1;
      firstError ??= err;
      snap.warnings.push(plaidErrorSentence(err, item));
    }
  }
  if (items.length && failures === items.length) throw new Error(plaidErrorSentence(firstError, items.length === 1 ? items[0] : undefined) + (items.length > 1 ? ` (${snap.warnings.join(" ")})` : ""));
  if (!failures) cache.set("plaid", snap);
  return snap;
}
