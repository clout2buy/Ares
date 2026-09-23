// Bank — read-only balances and transactions through SimpleFIN Bridge.
//
// Protocol: https://www.simplefin.org/protocol.html
//   Setup Token  base64 of a one-time claim URL the owner copies from SimpleFIN Bridge
//   claim        POST <claim URL> (empty body) → the Access URL as plain text,
//                https://<user>:<pass>@<host>/simplefin; 403 = already claimed
//                (the protocol asks apps to warn the owner the token may be
//                compromised)
//   data         GET <access URL>/accounts?version=2&balances-only=1 | start-date=<epoch>&pending=1&account=<id>
//                with HTTP Basic from the URL's userinfo; 403 = revoked, 402 = unpaid
// Why SimpleFIN and not Plaid: Plaid's consumer (Transactions) product needs a
// Plaid developer account approved for production; SimpleFIN Bridge is the
// route built for one person reading their own banks.
//
// fetch refuses URLs with credentials in them, so the userinfo is split off
// into an Authorization header. Redirects are NOT followed on the claim: a
// retired claim host answers 302 to a web page, and following it as a GET
// would read an HTML page as an Access URL. The protocol requires https
// only, with certificate checks on — both hold here.

import { z } from "zod";
import { getCredential } from "@ares/core";
import { buildTool, type ToolResult } from "./_shared.js";
import { failResult, okResult } from "./_lifeHttp.js";

/** Decode a Setup Token to its https claim URL, or throw a sentence. */
export function simplefinClaimUrl(setupToken: string): string {
  let decoded = "";
  try {
    decoded = Buffer.from(setupToken.trim(), "base64").toString("utf8").trim();
  } catch {
    decoded = "";
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    throw new Error("that isn't a SimpleFIN Setup Token (it should be a long base64 string from SimpleFIN Bridge)");
  }
  if (url.protocol !== "https:") throw new Error("a SimpleFIN claim URL must be https");
  return url.toString();
}

/** Trade a Setup Token for the long-lived Access URL. One-shot. */
export async function claimSimplefinToken(setupToken: string, signal?: AbortSignal): Promise<string> {
  const claim = simplefinClaimUrl(setupToken);
  const res = await fetch(claim, { method: "POST", headers: { "content-length": "0" }, redirect: "manual", ...(signal ? { signal } : {}) });
  if (res.status === 403) throw new Error("SimpleFIN says this Setup Token was already claimed. If Ares didn't claim it, disable it in SimpleFIN Bridge — someone else may have it — and make a new one");
  if (res.status !== 200) throw new Error(`the claim failed (HTTP ${res.status}) — make a fresh Setup Token in SimpleFIN Bridge`);
  const access = (await res.text()).trim();
  let url: URL;
  try {
    url = new URL(access);
  } catch {
    throw new Error("SimpleFIN answered the claim with something that isn't an Access URL");
  }
  if (url.protocol !== "https:" || !url.username) throw new Error("SimpleFIN's Access URL wasn't an https URL with credentials");
  return access;
}

export interface BankAccount {
  id: string;
  name: string;
  institution?: string;
  currency: string;
  balance: string;
  available?: string;
  balanceDate?: string;
}

export interface BankTransaction {
  account: string;
  date: string;
  amount: string;
  description: string;
  pending?: boolean;
}

/** Strip markup/control characters — the protocol says bank error strings
 *  must be sanitized before they're shown. */
function sanitize(text: unknown): string {
  return String(text ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
}

/** GET <access>/accounts. Exported for the connect hub's verifier and tests. */
export async function simplefinAccounts(
  accessUrl: string,
  params: Record<string, string | string[]>,
  signal?: AbortSignal,
): Promise<{ accounts: Array<Record<string, any>>; errors: string[] }> {
  const url = new URL(accessUrl);
  if (url.protocol !== "https:") throw new Error("the SimpleFIN Access URL must be https");
  const auth = Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64");
  url.username = "";
  url.password = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/accounts`;
  const query = new URLSearchParams({ version: "2" });
  for (const [k, v] of Object.entries(params)) for (const one of Array.isArray(v) ? v : [v]) query.append(k, one);
  url.search = query.toString();
  const res = await fetch(url, { headers: { authorization: `Basic ${auth}`, accept: "application/json" }, redirect: "error", ...(signal ? { signal } : {}) });
  if (res.status === 403) throw new Error("SimpleFIN refused Ares's access (it was revoked, or the credentials changed) — call Connect service \"simplefin\" with a new Setup Token");
  if (res.status === 402) throw new Error("SimpleFIN Bridge says payment is required — the owner's SimpleFIN subscription needs attention");
  if (!res.ok) throw new Error(`SimpleFIN answered HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, any>;
  // v2 reports errlist [{code,msg}]; v1 servers still answer errors ["…"].
  const errors = [
    ...(Array.isArray(json.errlist) ? json.errlist.map((e: Record<string, unknown>) => sanitize(e.msg ?? e.code)) : []),
    ...(Array.isArray(json.errors) ? json.errors.map(sanitize) : []),
  ].filter(Boolean);
  const connections = new Map<string, string>(
    (Array.isArray(json.connections) ? json.connections : []).map((c: Record<string, unknown>) => [String(c.conn_id), String(c.org_name ?? c.name ?? "")]),
  );
  const accounts = (Array.isArray(json.accounts) ? json.accounts : []).map((a: Record<string, any>) => ({
    ...a,
    _institution: a.org?.name ?? connections.get(String(a.conn_id)) ?? a.conn_name,
  }));
  return { accounts, errors };
}

function epochIso(seconds: unknown): string | undefined {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : undefined;
}

export function toBankAccount(a: Record<string, any>): BankAccount {
  return {
    id: String(a.id),
    name: sanitize(a.name),
    ...(a._institution ? { institution: sanitize(a._institution) } : {}),
    currency: String(a.currency ?? "USD"),
    balance: String(a.balance),
    ...(a["available-balance"] !== undefined ? { available: String(a["available-balance"]) } : {}),
    ...(epochIso(a["balance-date"]) ? { balanceDate: epochIso(a["balance-date"]) } : {}),
  };
}

const inputSchema = z
  .object({
    action: z.enum(["accounts", "transactions"]).describe("accounts: every account with its balance. transactions: recent transactions (all accounts, or one)."),
    account: z.string().optional().describe("transactions: an account id or name to narrow to."),
    days: z.number().int().positive().max(90).default(14).describe("transactions: how many days back."),
    limit: z.number().int().positive().max(200).default(40),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export interface BankOutput {
  accounts?: BankAccount[];
  transactions?: BankTransaction[];
  warnings?: string[];
  message: string;
}

const NOT_CONNECTED =
  "No bank is connected. Call Connect with service \"simplefin\" — the owner links their banks in SimpleFIN Bridge and pastes the Setup Token in a secure form — then retry. (Plaid needs a Plaid developer account; SimpleFIN is the personal route.)";

export const BankTool = buildTool<typeof inputSchema, BankOutput>({
  name: "Bank",
  description:
    "The owner's bank accounts, read-only, through SimpleFIN Bridge: accounts (balances, available balance) and recent transactions. It cannot move money. " +
    "If no bank is connected, call Connect service \"simplefin\" first.",
  safety: "read-only",
  concurrency: "parallel-safe",
  inputZod: inputSchema,
  // SimpleFIN Bridge fetches from the banks live; a slow bank takes a while.
  watchdogTimeoutMs: 90_000,
  activityDescription: (input) => (input.action === "accounts" ? "Checking bank balances" : "Reading bank transactions"),
  async call(input: Input, ctx): Promise<ToolResult<BankOutput>> {
    const access = (await getCredential("SIMPLEFIN_ACCESS_URL"))?.trim();
    if (!access) return failResult<BankOutput>(NOT_CONNECTED);
    try {
      if (input.action === "accounts") {
        const { accounts, errors } = await simplefinAccounts(access, { "balances-only": "1" }, ctx.signal);
        const list = accounts.map(toBankAccount);
        const message = list.length
          ? list.map((a) => `${a.institution ? `${a.institution} ` : ""}${a.name}: ${a.balance} ${a.currency}${a.available && a.available !== a.balance ? ` (available ${a.available})` : ""}`).join("\n")
          : "SimpleFIN returned no accounts — link a bank in SimpleFIN Bridge first.";
        return okResult({ accounts: list, ...(errors.length ? { warnings: errors } : {}), message: errors.length ? `${message}\nWarnings: ${errors.join("; ")}` : message }, `${list.length} accounts`);
      }
      const start = Math.floor(Date.now() / 1000) - input.days * 86_400;
      const all = await simplefinAccounts(access, { "start-date": String(start), pending: "1" }, ctx.signal);
      let pool = all.accounts;
      if (input.account) {
        const w = input.account.trim().toLowerCase();
        pool = pool.filter((a) => String(a.id).toLowerCase() === w || String(a.name ?? "").toLowerCase().includes(w));
        if (!pool.length) return failResult<BankOutput>(`No account matches "${input.account}" — call Bank accounts to see them.`);
      }
      const transactions: BankTransaction[] = pool
        .flatMap((a) =>
          (Array.isArray(a.transactions) ? a.transactions : []).map((t: Record<string, any>) => ({
            account: sanitize(a.name),
            date: epochIso(t.transacted_at ?? t.posted) ?? "pending",
            amount: `${t.amount} ${a.currency ?? ""}`.trim(),
            description: sanitize(t.description ?? t.payee),
            ...(t.pending ? { pending: true } : {}),
          })),
        )
        .sort((x: BankTransaction, y: BankTransaction) => y.date.localeCompare(x.date))
        .slice(0, input.limit);
      const message = transactions.length
        ? transactions.map((t) => `${t.date} ${t.amount} ${t.description}${t.pending ? " (pending)" : ""} — ${t.account}`).join("\n")
        : `No transactions in the last ${input.days} days.`;
      return okResult({ transactions, ...(all.errors.length ? { warnings: all.errors } : {}), message }, `${transactions.length} transactions`);
    } catch (err) {
      return failResult<BankOutput>(err instanceof Error ? err.message : String(err));
    }
  },
});
