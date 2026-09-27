// Bank analytics — computed locally on the normalized records, whichever
// provider produced them (SimpleFIN or Plaid). One path for everything:
// spending by category/merchant, recurring charges, and "what's new since I
// last looked". Nothing here calls an API, so it is the same answer for both
// providers and is cheap to test on realistic series.
//
// Sign convention (normalized): amount < 0 is money OUT, amount > 0 is money IN.

export interface NormAccount {
  id: string;
  provider: "plaid" | "simplefin";
  institution?: string;
  name: string;
  type?: string;
  balance: number;
  available?: number;
  currency: string;
  /** Plaid only: which linked bank (opaque id, never a token). */
  itemId?: string;
}

export interface NormTransaction {
  id: string;
  accountId: string;
  date: string; // YYYY-MM-DD
  amount: number; // negative = money out
  description: string;
  merchant?: string;
  category?: string;
  pending?: boolean;
}

// ─── Merchant + category ─────────────────────────────────────────────────────

const NOISE_PREFIX = /^(pos|debit|credit|purchase|recurring|card|visa|mc|ach|checkcard|dbt|pmt|payment to|preauthorized|pre-auth|sq \*|sq\*|tst\*|tst \*|paypal \*|pp\*|py \*)\s*/i;

/** A stable key for "the same merchant": the provider's merchant name, or the
 *  description with card-processor noise, store numbers and dates stripped. */
export function merchantKey(tx: Pick<NormTransaction, "merchant" | "description">): string {
  const base = (tx.merchant?.trim() || tx.description || "").toLowerCase();
  let s = base;
  for (let i = 0; i < 3; i++) s = s.replace(NOISE_PREFIX, "");
  s = s
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/[#*]\s*\d+/g, " ")
    .replace(/\b[a-z]*\d[\w-]*\b/g, " ")
    .replace(/\.(com|net|org)\b/g, "")
    .replace(/[^a-z& ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.split(" ").slice(0, 3).join(" ") || base.slice(0, 30) || "unknown";
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** What to call a merchant in output. */
export function merchantLabel(tx: Pick<NormTransaction, "merchant" | "description">): string {
  return tx.merchant?.trim() || titleCase(merchantKey(tx));
}

/** Plaid's personal_finance_category.primary, e.g. FOOD_AND_DRINK → "Food and drink". */
export function prettyCategory(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase().trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/payroll|salary|direct dep|paycheck/, "Income"],
  [/transfer|zelle|venmo|cash app|xfer|wire/, "Transfer"],
  [/netflix|spotify|hulu|disney|hbo|max\.com|youtube|apple\.com|icloud|prime video|audible|patreon|substack|openai|chatgpt|adobe/, "Subscriptions"],
  [/rent|mortgage|hoa/, "Rent and utilities"],
  [/electric|energy|water|gas co|pg&e|con ed|comcast|xfinity|verizon|at&t|att\b|t-mobile|tmobile|internet|utility/, "Rent and utilities"],
  [/grocer|whole foods|trader joe|safeway|kroger|aldi|costco|publix|wegmans|h-e-b|heb\b|sprouts|food lion|market/, "Groceries"],
  [/doordash|uber eats|ubereats|grubhub|restaurant|cafe|coffee|starbucks|mcdonald|chipotle|pizza|burger|taco|sushi|bar\b|grill|diner|bakery/, "Food and drink"],
  [/uber|lyft|shell|chevron|exxon|bp\b|mobil|fuel|parking|transit|metro|toll|airline|delta|united|american air|southwest/, "Transportation"],
  [/gym|fitness|planet fitness|equinox|peloton|pharmacy|cvs|walgreens|doctor|dental|clinic|hospital/, "Health and fitness"],
  [/amazon|target|walmart|best buy|ebay|etsy|ikea|home depot|lowe/, "Shopping"],
  [/fee|interest charge|overdraft/, "Fees"],
];

/** The provider's category when it has one, else a simple keyword guess. */
export function deriveCategory(tx: Pick<NormTransaction, "category" | "merchant" | "description" | "amount">): string {
  if (tx.category?.trim()) return tx.category.trim();
  const text = `${tx.merchant ?? ""} ${tx.description}`.toLowerCase();
  for (const [re, name] of CATEGORY_RULES) if (re.test(text)) return name;
  return tx.amount > 0 ? "Income" : "Other";
}

// ─── Spending summary ────────────────────────────────────────────────────────

export interface SpendingSummary {
  days: number;
  from: string;
  to: string;
  spent: number;
  income: number;
  net: number;
  byCategory: Array<{ category: string; total: number; count: number; share: number }>;
  topMerchants: Array<{ merchant: string; total: number; count: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isoDaysAgo(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

/** Posted money out/in over the last `days`, grouped. Pending is left out
 *  (it re-appears posted, and would be counted twice). Transfers between the
 *  owner's own accounts are not spending. */
export function spendingSummary(txs: NormTransaction[], days: number, now = Date.now()): SpendingSummary {
  const from = isoDaysAgo(days, now);
  const to = new Date(now).toISOString().slice(0, 10);
  const posted = txs.filter((t) => !t.pending && t.date >= from && t.date <= to);
  const cats = new Map<string, { total: number; count: number }>();
  const merchants = new Map<string, { label: string; total: number; count: number }>();
  let spent = 0;
  let income = 0;
  for (const tx of posted) {
    const category = deriveCategory(tx);
    const transfer = /^transfer/i.test(category);
    if (tx.amount > 0) {
      if (!transfer) income += tx.amount;
      continue;
    }
    if (transfer) continue;
    const out = -tx.amount;
    spent += out;
    const c = cats.get(category) ?? { total: 0, count: 0 };
    c.total += out;
    c.count += 1;
    cats.set(category, c);
    const key = merchantKey(tx);
    const m = merchants.get(key) ?? { label: merchantLabel(tx), total: 0, count: 0 };
    m.total += out;
    m.count += 1;
    merchants.set(key, m);
  }
  return {
    days,
    from,
    to,
    spent: round2(spent),
    income: round2(income),
    net: round2(income - spent),
    byCategory: [...cats.entries()]
      .map(([category, v]) => ({ category, total: round2(v.total), count: v.count, share: spent ? Math.round((v.total / spent) * 1000) / 10 : 0 }))
      .sort((a, b) => b.total - a.total),
    topMerchants: [...merchants.values()]
      .map((m) => ({ merchant: m.label, total: round2(m.total), count: m.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10),
  };
}

// ─── Recurring charges ───────────────────────────────────────────────────────

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

const CADENCES: Array<{ cadence: Cadence; min: number; max: number; days: number; minCount: number }> = [
  { cadence: "weekly", min: 6, max: 8, days: 7, minCount: 3 },
  { cadence: "biweekly", min: 13, max: 16, days: 14, minCount: 3 },
  { cadence: "monthly", min: 27, max: 33, days: 30, minCount: 2 },
  { cadence: "quarterly", min: 85, max: 95, days: 91, minCount: 2 },
  { cadence: "yearly", min: 355, max: 375, days: 365, minCount: 2 },
];

export interface RecurringCharge {
  merchant: string;
  amount: number; // typical charge, positive
  cadence: Cadence;
  count: number;
  lastDate: string;
  nextExpected: string;
  category: string;
  active: boolean;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const dayNum = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const dayIso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

function addCadence(last: string, cadence: Cadence, days: number): string {
  if (cadence === "monthly" || cadence === "quarterly" || cadence === "yearly") {
    const d = new Date(`${last}T00:00:00Z`);
    const months = cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12;
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const lastOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastOfMonth));
    return d.toISOString().slice(0, 10);
  }
  return dayIso(dayNum(last) + days);
}

/**
 * Subscriptions and bills: money out to the same merchant, at a similar amount
 * (every charge within ±10% of the median), on a steady cadence. Weekly and
 * biweekly need 3 charges; monthly and longer need 2 (a 60-day window only
 * ever holds two Netflix charges). Groceries fail on amount, cadence or both.
 */
export function detectRecurring(txs: NormTransaction[], now = Date.now()): RecurringCharge[] {
  const groups = new Map<string, NormTransaction[]>();
  for (const tx of txs) {
    if (tx.pending || tx.amount >= 0) continue;
    if (/^transfer/i.test(deriveCategory(tx))) continue;
    const key = merchantKey(tx);
    const list = groups.get(key) ?? [];
    list.push(tx);
    groups.set(key, list);
  }
  const today = dayNum(new Date(now).toISOString().slice(0, 10));
  const found: RecurringCharge[] = [];
  for (const list of groups.values()) {
    // One charge per day: a same-day split (or a pending→posted pair) is one event.
    const byDay = new Map<string, NormTransaction>();
    for (const tx of list.sort((a, b) => a.date.localeCompare(b.date))) if (!byDay.has(tx.date)) byDay.set(tx.date, tx);
    const events = [...byDay.values()];
    if (events.length < 2) continue;
    const amounts = events.map((t) => -t.amount);
    const typical = median(amounts);
    if (!(typical > 0) || amounts.some((a) => Math.abs(a - typical) > typical * 0.1)) continue;
    const gaps = events.slice(1).map((t, i) => dayNum(t.date) - dayNum(events[i]!.date));
    const gap = median(gaps);
    const fit = CADENCES.find((c) => gap >= c.min && gap <= c.max);
    if (!fit || events.length < fit.minCount) continue;
    // Steady: at most one gap outside the band (a skipped week), and never most.
    const off = gaps.filter((g) => g < fit.min || g > fit.max).length;
    if (off > Math.max(0, Math.floor((gaps.length - 1) / 3))) continue;
    const last = events[events.length - 1]!;
    found.push({
      merchant: merchantLabel(last),
      amount: round2(typical),
      cadence: fit.cadence,
      count: events.length,
      lastDate: last.date,
      nextExpected: addCadence(last.date, fit.cadence, fit.days),
      category: deriveCategory(last),
      active: today - dayNum(last.date) <= Math.ceil(fit.max * 1.5),
    });
  }
  return found.sort((a, b) => Number(b.active) - Number(a.active) || b.amount - a.amount);
}

// ─── New charges (cursor) ────────────────────────────────────────────────────

export interface ChargesCursor {
  /** transaction id → its date, for every charge already reported/baselined. */
  seen: Record<string, string>;
  updatedAt?: string;
}

export const NEW_CHARGES_LOOKBACK_DAYS = 30;

/**
 * Money out that hasn't been reported before. Banks post late (a charge dated
 * three days ago can appear today), so the cursor is a set of seen ids over a
 * 30-day lookback, not a timestamp. The first call only sets the baseline:
 * it reports charges from the last `firstRunDays` (or since `since`) and marks
 * everything older as seen, so the owner isn't flooded with a month of history.
 * Pending charges wait until they post (their id changes when they do).
 */
export function newCharges(
  txs: NormTransaction[],
  cursor: ChargesCursor | null,
  opts: { since?: string; now?: number; firstRunDays?: number } = {},
): { charges: NormTransaction[]; cursor: ChargesCursor } {
  const now = opts.now ?? Date.now();
  const floor = isoDaysAgo(NEW_CHARGES_LOOKBACK_DAYS, now);
  const outflows = txs.filter((t) => !t.pending && t.amount < 0 && t.date >= floor);
  const seen = { ...(cursor?.seen ?? {}) };
  const windowStart = opts.since ?? (cursor ? floor : isoDaysAgo(opts.firstRunDays ?? 2, now));
  const charges = outflows.filter((t) => t.date >= windowStart && !seen[t.id]).sort((a, b) => b.date.localeCompare(a.date));
  for (const t of outflows) seen[t.id] = t.date;
  for (const [id, date] of Object.entries(seen)) if (date < floor) delete seen[id];
  return { charges, cursor: { seen, updatedAt: new Date(now).toISOString() } };
}
