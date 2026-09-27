// SimpleFIN Bridge — the protocol half of the Bank tool's SimpleFIN provider.
//
// Protocol: https://www.simplefin.org/protocol.html
//   Setup Token  base64 of a one-time claim URL the owner copies from SimpleFIN Bridge
//   claim        POST <claim URL> (empty body) → the Access URL as plain text,
//                https://<user>:<pass>@<host>/simplefin; 403 = already claimed
//                (the protocol asks apps to warn the owner the token may be
//                compromised)
//   data         GET <access URL>/accounts?version=2&balances-only=1 | start-date=<epoch>&pending=1&account=<id>
//                with HTTP Basic from the URL's userinfo; 403 = revoked, 402 = unpaid
// Rate guidance (beta-bridge.simplefin.org/info/developers): "you are expected
// to make 24 requests or fewer per day", data updates daily, and one request
// spans at most 90 days — bankData.ts caches for an hour and counts requests.
//
// fetch refuses URLs with credentials in them, so the userinfo is split off
// into an Authorization header. Redirects are NOT followed on the claim: a
// retired claim host answers 302 to a web page, and following it as a GET
// would read an HTML page as an Access URL. The protocol requires https
// only, with certificate checks on — both hold here.

import type { NormAccount, NormTransaction } from "./bankAnalytics.js";

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

/** Strip markup/control characters — the protocol says bank error strings
 *  must be sanitized before they're shown. */
export function sanitize(text: unknown): string {
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

export function epochIso(seconds: unknown): string | undefined {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : undefined;
}

/** SimpleFIN account → the normalized record (balance < 0 = owed). */
export function normalizeSimplefinAccount(a: Record<string, any>): NormAccount {
  const available = a["available-balance"] !== undefined ? Number(a["available-balance"]) : undefined;
  return {
    id: String(a.id),
    provider: "simplefin",
    ...(a._institution ? { institution: sanitize(a._institution) } : {}),
    name: sanitize(a.name),
    balance: Number(a.balance),
    ...(available !== undefined && Number.isFinite(available) ? { available } : {}),
    currency: String(a.currency ?? "USD"),
  };
}

/** SimpleFIN transaction → normalized (SimpleFIN already signs money out negative). */
export function normalizeSimplefinTransaction(a: Record<string, any>, t: Record<string, any>): NormTransaction {
  const merchant = t.payee ? sanitize(t.payee) : "";
  return {
    id: String(t.id ?? `${a.id}:${t.posted}:${t.amount}`),
    accountId: String(a.id),
    date: epochIso(t.transacted_at) ?? epochIso(t.posted) ?? new Date().toISOString().slice(0, 10),
    amount: Number(t.amount),
    description: sanitize(t.description ?? t.payee),
    ...(merchant ? { merchant } : {}),
    ...(t.pending ? { pending: true } : {}),
  };
}
