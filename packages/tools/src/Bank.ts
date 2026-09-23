// Bank — the owner's money, read-only, through Plaid or SimpleFIN Bridge.
//
// Two providers, one pipeline (bankData.ts): each adapter produces the same
// normalized accounts and transactions, and everything analytic — spending by
// category, recurring charges, new charges since last time — is computed
// locally on those (bankAnalytics.ts), so both providers answer alike.
//   plaid      the owner picks their bank in Plaid's own UI (connect service
//              "plaid"); Ares holds per-bank access tokens in the vault and
//              only ever shows item_id + institution name. Plaid alone adds
//              liabilities (cards/loans: APR, minimum, due date) and
//              investments (holdings).
//   simplefin  the personal route (SimpleFIN Bridge, a small yearly fee).
// provider "auto" picks Plaid when a Plaid bank is linked, else SimpleFIN.
//
// Nothing here moves money. The one write is remove_item (disconnect a Plaid
// bank), which asks the owner first — on Plaid's Trial a removed connection
// does NOT come back as a free slot.

import path from "node:path";
import { z } from "zod";
import { aresHome, getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";
import {
  detectRecurring,
  newCharges,
  isoDaysAgo,
  spendingSummary,
  type ChargesCursor,
  type NormAccount,
  type NormTransaction,
  type RecurringCharge,
  type SpendingSummary,
} from "./bankAnalytics.js";
import { clearBankCache, plaidSnapshot, simplefinSnapshot, type BankProvider, type BankSnapshot } from "./bankData.js";
import {
  PLAID_TRIAL_ITEMS,
  PlaidError,
  loadPlaidConfig,
  loadPlaidItems,
  plaidCall,
  plaidErrorSentence,
  plaidItemView,
  plaidItemsCreated,
  readJsonFile,
  removePlaidItem,
  writeJsonFile,
  type PlaidConfig,
  type PlaidItem,
  type PlaidItemView,
} from "./plaidApi.js";

export { claimSimplefinToken, simplefinAccounts, simplefinClaimUrl } from "./simplefin.js";

const ACTIONS = ["accounts", "balances", "transactions", "spending_summary", "recurring", "new_charges", "liabilities", "investments", "items", "remove_item"] as const;
const PLAID_ONLY = new Set(["liabilities", "investments", "items", "remove_item"]);

const inputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .describe(
        "accounts/balances: every account and balance. transactions: recent transactions (filter by account, query). " +
          "spending_summary: spending by category and merchant over `days`. recurring: subscriptions and bills detected from history. " +
          "new_charges: money out not reported before (for 'tell me when I get charged'; moves a cursor unless peek). " +
          "liabilities (Plaid): cards and loans — owed, APR, minimum, due date. investments (Plaid): holdings. " +
          "items (Plaid): linked banks. remove_item (Plaid): disconnect one bank (asks).",
      ),
    provider: z.enum(["auto", "plaid", "simplefin"]).default("auto").describe("auto: Plaid if a Plaid bank is linked, else SimpleFIN."),
    account: z.string().optional().describe("An account id or part of its name, to narrow transactions/spending."),
    query: z.string().optional().describe("transactions: only those whose merchant/description contains this."),
    days: z.number().int().positive().max(730).optional().describe("How far back (transactions 14, spending_summary 30, recurring 180 by default). SimpleFIN reaches 90 days."),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("new_charges: report charges dated on/after this YYYY-MM-DD (else: since the last new_charges call)."),
    peek: z.boolean().optional().describe("new_charges: look without moving the cursor."),
    item_id: z.string().optional().describe("remove_item: the item_id from action items."),
    live: z.boolean().optional().describe("accounts (Plaid): real-time balances via /accounts/balance/get — Plaid bills each such call; only when the owner needs up-to-the-minute."),
    refresh: z.boolean().optional().describe("Skip the short cache (15 min Plaid, 1 h SimpleFIN)."),
    limit: z.number().int().positive().max(200).default(40),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface BankOutput {
  provider?: BankProvider;
  accounts?: NormAccount[];
  transactions?: NormTransaction[];
  summary?: SpendingSummary;
  recurring?: RecurringCharge[];
  charges?: NormTransaction[];
  liabilities?: Array<Record<string, unknown>>;
  holdings?: Array<Record<string, unknown>>;
  items?: PlaidItemView[];
  warnings?: string[];
  message: string;
}

const NOT_CONNECTED =
  "No bank is connected. Call Connect with service \"plaid\" — the owner picks their bank in Plaid on their phone and Ares gets read-only access — then retry. " +
  "(If the owner already uses SimpleFIN Bridge instead, Connect with service \"simplefin\".)";

const PLAID_NEEDED = (action: string) =>
  `${action} needs a bank linked through Plaid. Call Connect with service "plaid" (the owner picks their bank in Plaid's own screen), then retry.`;

const money = (n: number, currency = "USD") => `${n < 0 ? "-" : ""}${Math.abs(n).toFixed(2)} ${currency}`;

interface Sources {
  plaid?: { cfg: PlaidConfig; items: PlaidItem[] };
  simplefin?: string;
}

async function sources(): Promise<Sources> {
  const out: Sources = {};
  const items = await loadPlaidItems();
  if (items.length) {
    const cfg = await loadPlaidConfig();
    if (cfg) out.plaid = { cfg, items };
  }
  const access = (await getCredential("SIMPLEFIN_ACCESS_URL"))?.trim();
  if (access) out.simplefin = access;
  return out;
}

function chooseProvider(input: Input, src: Sources): BankProvider | null {
  if (input.provider === "plaid") return src.plaid ? "plaid" : null;
  if (input.provider === "simplefin") return src.simplefin ? "simplefin" : null;
  return src.plaid ? "plaid" : src.simplefin ? "simplefin" : null;
}

function accountFilter(accounts: NormAccount[], wanted?: string): { ids: Set<string> | null; error?: string } {
  if (!wanted?.trim()) return { ids: null };
  const w = wanted.trim().toLowerCase();
  const hit = accounts.filter((a) => a.id.toLowerCase() === w || a.name.toLowerCase().includes(w) || (a.institution ?? "").toLowerCase().includes(w));
  return hit.length ? { ids: new Set(hit.map((a) => a.id)) } : { ids: null, error: `No account matches "${wanted}" — call Bank accounts to see them.` };
}

function chargesCursorFile(provider: BankProvider): string {
  return path.join(aresHome(), "bank", `charges-cursor-${provider}.json`);
}

function accountLine(a: NormAccount): string {
  return `${a.institution ? `${a.institution} ` : ""}${a.name}${a.type ? ` (${a.type})` : ""}: ${money(a.balance, a.currency)}${a.available !== undefined && a.available !== a.balance ? ` (available ${money(a.available, a.currency)})` : ""}`;
}

function txLine(t: NormTransaction, names: Map<string, string>): string {
  return `${t.date} ${t.amount.toFixed(2)} ${t.merchant && !t.description.toLowerCase().includes(t.merchant.toLowerCase()) ? `${t.merchant} — ` : ""}${t.description}${t.category ? ` [${t.category}]` : ""}${t.pending ? " (pending)" : ""} — ${names.get(t.accountId) ?? t.accountId}`;
}

export const BankTool = buildTool<typeof inputSchema, BankOutput>({
  name: "Bank",
  description:
    "The owner's bank accounts, read-only, through Plaid or SimpleFIN: balances, transactions, spending by category, subscriptions/bills (recurring), new charges since last check, " +
    "and with Plaid also credit cards/loans (liabilities) and investment holdings. It cannot move money. " +
    "If no bank is connected, call Connect service \"plaid\" first (\"plaid:add\" links another bank).",
  safety: "external-state",
  dynamicSafety: (input) => (input.action === "remove_item" ? "external-state" : "read-only"),
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  // SimpleFIN Bridge and Plaid fetch from the banks live; a slow bank takes a while.
  watchdogTimeoutMs: 90_000,
  async checkPermissions(input) {
    if (input.action !== "remove_item") return { kind: "allow" };
    const item = input.item_id ? (await loadPlaidItems()).find((i) => i.item_id === input.item_id) : undefined;
    return {
      kind: "ask",
      prompt: `Disconnect ${item?.institution_name ?? input.item_id ?? "a bank"} from Ares? Plaid revokes Ares's access to it. On Plaid's free Trial, a removed connection does not free a slot.`,
      suggestion: "allow_once",
    };
  },
  activityDescription: (input) =>
    input.action === "accounts" || input.action === "balances" ? "Checking bank balances" : input.action === "remove_item" ? "Disconnecting a bank" : `Reading bank ${input.action.replace(/_/g, " ")}`,
  async call(input: Input, ctx): Promise<ToolResult<BankOutput>> {
    const src = await sources();
    const provider = chooseProvider(input, src);
    if (PLAID_ONLY.has(input.action) && provider !== "plaid") {
      if (input.action === "items" && !src.plaid) return okResult({ items: [], message: "No banks are linked through Plaid. Connect service \"plaid\" links one." });
      return failResult<BankOutput>(src.plaid || src.simplefin ? PLAID_NEEDED(input.action) : NOT_CONNECTED);
    }
    if (!provider) return failResult<BankOutput>(input.provider === "auto" ? NOT_CONNECTED : `${input.provider} isn't connected. ${NOT_CONNECTED}`);
    try {
      if (provider === "plaid") {
        const plaid = src.plaid!;
        if (input.action === "items") return await itemsResult(plaid);
        if (input.action === "remove_item") return await removeItem(input);
        if (input.action === "liabilities") return await liabilities(plaid, ctx.signal);
        if (input.action === "investments") return await investments(plaid, ctx.signal);
      }
      const balancesOnly = input.action === "accounts" || input.action === "balances";
      const snap: BankSnapshot =
        provider === "plaid"
          ? await plaidSnapshot(src.plaid!.cfg, src.plaid!.items, { balancesOnly, live: balancesOnly && input.live === true, refresh: input.refresh === true, signal: ctx.signal })
          : await simplefinSnapshot(src.simplefin!, { refresh: input.refresh === true, signal: ctx.signal });
      return await analyse(input, snap);
    } catch (err) {
      return failResult<BankOutput>(err instanceof PlaidError ? plaidErrorSentence(err) : err instanceof Error ? err.message : String(err));
    }
  },
});

async function analyse(input: Input, snap: BankSnapshot): Promise<ToolResult<BankOutput>> {
  const warnings = snap.warnings.length ? { warnings: snap.warnings } : {};
  const warnText = snap.warnings.length ? `\nWarnings: ${snap.warnings.join("; ")}` : "";
  const base = { provider: snap.provider, ...warnings };
  const names = new Map(snap.accounts.map((a) => [a.id, `${a.institution ? `${a.institution} ` : ""}${a.name}`]));
  const reach = snap.provider === "simplefin" ? 90 : 730;
  const clip = (days: number) => Math.min(days, reach);
  const clipNote = (days: number) => (days > reach ? ` (SimpleFIN reaches ${reach} days; showing ${reach})` : "");

  if (input.action === "accounts" || input.action === "balances") {
    const message = snap.accounts.length ? snap.accounts.map(accountLine).join("\n") : "No accounts came back — link a bank first.";
    return okResult({ ...base, accounts: snap.accounts, message: message + warnText }, `${snap.accounts.length} accounts`);
  }

  const filter = accountFilter(snap.accounts, input.account);
  if (filter.error) return failResult<BankOutput>(filter.error);
  const pool = filter.ids ? snap.transactions.filter((t) => filter.ids!.has(t.accountId)) : snap.transactions;

  if (input.action === "transactions") {
    const days = input.days ?? 14;
    const from = isoDaysAgo(clip(days));
    const q = input.query?.trim().toLowerCase();
    const transactions = pool
      .filter((t) => t.date >= from && (!q || `${t.merchant ?? ""} ${t.description}`.toLowerCase().includes(q)))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, input.limit);
    const message = transactions.length
      ? transactions.map((t) => txLine(t, names)).join("\n")
      : `No transactions${q ? ` matching "${input.query}"` : ""} in the last ${clip(days)} days.`;
    return okResult({ ...base, transactions, message: message + clipNote(days) + warnText }, `${transactions.length} transactions`);
  }

  if (input.action === "spending_summary") {
    const days = clip(input.days ?? 30);
    const summary = spendingSummary(pool, days);
    const lines = [
      `Last ${days} days (${summary.from} → ${summary.to}): spent ${summary.spent.toFixed(2)}, income ${summary.income.toFixed(2)}, net ${summary.net.toFixed(2)}.`,
      ...summary.byCategory.map((c) => `  ${c.category}: ${c.total.toFixed(2)} (${c.share}%, ${c.count} charges)`),
      summary.topMerchants.length ? `Top merchants: ${summary.topMerchants.slice(0, 5).map((m) => `${m.merchant} ${m.total.toFixed(2)}`).join(", ")}` : "",
    ].filter(Boolean);
    return okResult({ ...base, summary, message: lines.join("\n") + clipNote(input.days ?? 30) + warnText }, `spent ${summary.spent.toFixed(2)}`);
  }

  if (input.action === "recurring") {
    const days = clip(input.days ?? 180);
    const from = isoDaysAgo(days);
    const recurring = detectRecurring(pool.filter((t) => t.date >= from));
    const active = recurring.filter((r) => r.active);
    const monthly = active.reduce((sum, r) => sum + r.amount * ({ weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 } as const)[r.cadence], 0);
    const message = recurring.length
      ? [
          `${active.length} active recurring charges (about ${monthly.toFixed(2)}/month), from ${days} days of history:`,
          ...recurring.map((r) => `  ${r.merchant}: ${r.amount.toFixed(2)} ${r.cadence}, last ${r.lastDate}, next ~${r.nextExpected}${r.active ? "" : " (looks stopped)"}`),
        ].join("\n")
      : `No recurring charges found in the last ${days} days.`;
    return okResult({ ...base, recurring, message: message + warnText }, `${recurring.length} recurring`);
  }

  // new_charges
  const file = chargesCursorFile(snap.provider);
  const prior = await readJsonFile<ChargesCursor>(file);
  const { charges, cursor } = newCharges(pool, prior, input.since ? { since: input.since } : {});
  if (!input.peek) await writeJsonFile(file, cursor);
  const shown = charges.slice(0, input.limit);
  const message = shown.length
    ? `${charges.length} new charge(s)${prior ? " since the last check" : ""}:\n${shown.map((t) => txLine(t, names)).join("\n")}`
    : prior
      ? "No new charges since the last check."
      : "No charges in the last 2 days. Later checks report anything new from here on.";
  return okResult({ ...base, charges: shown, message: message + warnText }, `${charges.length} new charges`);
}

async function itemsResult(plaid: { cfg: PlaidConfig; items: PlaidItem[] }): Promise<ToolResult<BankOutput>> {
  const items = plaid.items.map(plaidItemView);
  const used = Math.max(await plaidItemsCreated(), items.length);
  const trial =
    plaid.cfg.env === "production"
      ? `Plaid Trial: ${used} of ${PLAID_TRIAL_ITEMS} connections used (if the owner is on the free Trial plan; removing a bank does NOT free a slot, so repair a broken bank with Connect "plaid:update:<item_id>" rather than linking it again).`
      : "Plaid sandbox (test banks only — no real data, no Trial slots).";
  const message = [items.map((i) => `${i.institution} — item_id ${i.item_id} (linked ${i.added_at.slice(0, 10)})`).join("\n"), trial].filter(Boolean).join("\n");
  return okResult({ provider: "plaid", items, message }, `${items.length} banks`);
}

async function removeItem(input: Input): Promise<ToolResult<BankOutput>> {
  if (!input.item_id) return failResult<BankOutput>("remove_item needs item_id — call Bank items to see them.");
  const removed = await removePlaidItem(input.item_id);
  if (!removed) return failResult<BankOutput>(`No linked bank has item_id "${input.item_id}" — call Bank items to see them.`);
  clearBankCache();
  return okResult({ provider: "plaid", items: [removed], message: `${removed.institution} is disconnected; Plaid revoked Ares's access.` });
}

async function eachItem<T>(plaid: { cfg: PlaidConfig; items: PlaidItem[] }, work: (item: PlaidItem) => Promise<T[]>): Promise<{ rows: T[]; warnings: string[] }> {
  const rows: T[] = [];
  const warnings: string[] = [];
  for (const item of plaid.items) {
    try {
      rows.push(...(await work(item)));
    } catch (err) {
      if (err instanceof PlaidError && err.rateLimited) throw err;
      warnings.push(plaidErrorSentence(err, item));
    }
  }
  return { rows, warnings };
}

async function liabilities(plaid: { cfg: PlaidConfig; items: PlaidItem[] }, signal: AbortSignal): Promise<ToolResult<BankOutput>> {
  const { rows, warnings } = await eachItem(plaid, async (item) => {
    const res = await plaidCall(plaid.cfg, "/liabilities/get", { access_token: item.access_token }, signal);
    const accounts = new Map(((res.accounts ?? []) as Record<string, any>[]).map((a) => [String(a.account_id), a]));
    const name = (id: string) => {
      const a = accounts.get(id);
      return `${item.institution_name} ${a?.name ?? "account"}${a?.mask ? ` …${a.mask}` : ""}`;
    };
    const owed = (id: string) => {
      const b = accounts.get(id)?.balances;
      return b?.current ?? null;
    };
    const lib = (res.liabilities ?? {}) as Record<string, Record<string, any>[] | null>;
    return [
      ...(lib.credit ?? []).map((c) => ({
        kind: "credit",
        account: name(String(c.account_id)),
        owed: owed(String(c.account_id)),
        last_statement_balance: c.last_statement_balance ?? null,
        minimum_payment: c.minimum_payment_amount ?? null,
        next_due: c.next_payment_due_date ?? null,
        apr: (c.aprs ?? []).find((a: Record<string, any>) => a.apr_type === "purchase_apr")?.apr_percentage ?? (c.aprs ?? [])[0]?.apr_percentage ?? null,
        overdue: c.is_overdue ?? null,
      })),
      ...(lib.student ?? []).map((s) => ({
        kind: "student",
        account: name(String(s.account_id)),
        owed: owed(String(s.account_id)),
        apr: s.interest_rate_percentage ?? null,
        minimum_payment: s.minimum_payment_amount ?? null,
        next_due: s.next_payment_due_date ?? null,
        overdue: s.is_overdue ?? null,
      })),
      ...(lib.mortgage ?? []).map((m) => ({
        kind: "mortgage",
        account: name(String(m.account_id)),
        owed: owed(String(m.account_id)),
        apr: m.interest_rate?.percentage ?? null,
        minimum_payment: m.next_monthly_payment ?? null,
        next_due: m.next_payment_due_date ?? null,
        overdue: m.past_due_amount ? true : null,
      })),
    ];
  });
  const message = rows.length
    ? rows
        .map((r) => `${r.account} (${r.kind}): owed ${r.owed ?? "?"}${r.apr !== null ? `, APR ${r.apr}%` : ""}${r.minimum_payment !== null ? `, minimum ${r.minimum_payment}` : ""}${r.next_due ? ` due ${r.next_due}` : ""}${r.overdue ? " — OVERDUE" : ""}`)
        .join("\n")
    : "No credit cards or loans came back from the linked banks.";
  return okResult({ provider: "plaid", liabilities: rows, ...(warnings.length ? { warnings } : {}), message: message + (warnings.length ? `\nWarnings: ${warnings.join("; ")}` : "") }, `${rows.length} liabilities`);
}

async function investments(plaid: { cfg: PlaidConfig; items: PlaidItem[] }, signal: AbortSignal): Promise<ToolResult<BankOutput>> {
  const { rows, warnings } = await eachItem(plaid, async (item) => {
    const res = await plaidCall(plaid.cfg, "/investments/holdings/get", { access_token: item.access_token }, signal);
    const securities = new Map(((res.securities ?? []) as Record<string, any>[]).map((s) => [String(s.security_id), s]));
    const accounts = new Map(((res.accounts ?? []) as Record<string, any>[]).map((a) => [String(a.account_id), a]));
    return ((res.holdings ?? []) as Record<string, any>[]).map((h) => {
      const sec = securities.get(String(h.security_id)) ?? {};
      const acct = accounts.get(String(h.account_id));
      return {
        account: `${item.institution_name} ${acct?.name ?? "account"}`,
        name: sec.name ?? sec.ticker_symbol ?? "security",
        ticker: sec.ticker_symbol ?? null,
        type: sec.type ?? null,
        quantity: h.quantity ?? null,
        value: h.institution_value ?? null,
        price: h.institution_price ?? null,
        cost_basis: h.cost_basis ?? null,
        currency: h.iso_currency_code ?? h.unofficial_currency_code ?? "USD",
      };
    });
  });
  rows.sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
  const total = rows.reduce((sum, r) => sum + Number(r.value ?? 0), 0);
  const message = rows.length
    ? [`${rows.length} holdings, ${total.toFixed(2)} total:`, ...rows.slice(0, 40).map((r) => `  ${r.ticker ?? r.name}: ${r.quantity ?? "?"} = ${r.value ?? "?"} ${r.currency}${r.cost_basis !== null ? ` (cost ${r.cost_basis})` : ""} — ${r.account}`)].join("\n")
    : "No investment holdings came back from the linked banks.";
  return okResult({ provider: "plaid", holdings: rows, ...(warnings.length ? { warnings } : {}), message: message + (warnings.length ? `\nWarnings: ${warnings.join("; ")}` : "") }, `${rows.length} holdings`);
}
