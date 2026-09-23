// Plaid — the API client, the vault record of linked banks, and the error
// sentences the model sees. Shared by the Bank tool and the connect hub.
//
// Docs: https://plaid.com/docs/api/
//   every call   POST https://{production|sandbox}.plaid.com/<path>, JSON body
//                carrying client_id + secret
//   errors       HTTP 4xx/5xx with {error_type, error_code, error_message,
//                display_message}; 429 / RATE_LIMIT_EXCEEDED is a rate limit
//
// What lives where:
//   vault  PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV   the owner's Plaid app
//          PLAID_ITEMS  JSON [{item_id, access_token, institution_name,
//                       institution_id?, added_at}] — one entry per linked bank
//   disk   <ARES_HOME>/plaid/<item_id>.json   the /transactions/sync cursor and
//          the normalized transactions it has produced (never a token)
//          <ARES_HOME>/plaid/state.json      how many Items were ever created
//
// Access tokens never leave this module's callers: every tool output carries
// item_id + institution name only.
//
// The Trial plan (https://plaid.com/docs/account/billing/) allows 10 Production
// Items, and "Removing Items created on a Trial plan (using /item/remove) will
// not allow you to create more Items" — so a bank that needs a fresh login is
// repaired in update mode (same Item), never re-linked.

import { promises as fs } from "node:fs";
import path from "node:path";
import { aresHome, deleteCredential, getCredential, setCredential } from "@ares/core";

export type PlaidEnv = "production" | "sandbox";

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: PlaidEnv;
}

export interface PlaidItem {
  item_id: string;
  access_token: string;
  institution_name: string;
  institution_id?: string;
  added_at: string;
}

/** What a model or a phone may see about a linked bank. */
export interface PlaidItemView {
  item_id: string;
  institution: string;
  added_at: string;
}

export const PLAID_TRIAL_ITEMS = 10;

export function plaidBaseUrl(env: PlaidEnv): string {
  return env === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";
}

export function normalizePlaidEnv(value: string | undefined): PlaidEnv {
  return (value ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "production";
}

export async function loadPlaidConfig(home?: string): Promise<PlaidConfig | null> {
  const clientId = await getCredential("PLAID_CLIENT_ID", { home });
  const secret = await getCredential("PLAID_SECRET", { home });
  if (!clientId || !secret) return null;
  return { clientId, secret, env: normalizePlaidEnv(await getCredential("PLAID_ENV", { home })) };
}

export class PlaidError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly type: string,
    readonly display?: string,
  ) {
    super(message);
    this.name = "PlaidError";
  }
  get rateLimited(): boolean {
    return this.status === 429 || this.type === "RATE_LIMIT_EXCEEDED" || /RATE_LIMIT/.test(this.code);
  }
  get loginRequired(): boolean {
    return this.code === "ITEM_LOGIN_REQUIRED";
  }
}

/** POST one Plaid endpoint. Throws PlaidError with Plaid's own code. */
export async function plaidCall(cfg: PlaidConfig, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
  const res = await fetch(`${plaidBaseUrl(cfg.env)}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text().catch(() => "");
  let json: Record<string, any> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    json = {};
  }
  if (!res.ok || json.error_code) {
    const code = String(json.error_code ?? `HTTP_${res.status}`);
    const type = String(json.error_type ?? "");
    const said = String(json.error_message ?? json.display_message ?? `HTTP ${res.status}`).slice(0, 300);
    throw new PlaidError(`Plaid ${endpoint}: ${code} — ${said}`, res.status, code, type, json.display_message ? String(json.display_message) : undefined);
  }
  return json;
}

/** The sentence the model gets for a Plaid failure. Rate limits and a bank
 *  that needs a fresh login each get an explicit next step. */
export function plaidErrorSentence(err: unknown, item?: Pick<PlaidItem, "item_id" | "institution_name">): string {
  if (!(err instanceof PlaidError)) return err instanceof Error ? err.message : String(err);
  const bank = item ? item.institution_name : "The bank";
  if (err.rateLimited)
    return `Plaid rate limit hit (${err.code}). STOP: do not call Bank again for a few minutes and do not retry in a loop — tell the owner the bank data will be available shortly.`;
  if (err.loginRequired)
    return `${bank} needs the owner to sign in again (ITEM_LOGIN_REQUIRED). Call Connect with service "plaid:update:${item?.item_id ?? "<item_id>"}" — the owner re-authenticates in Plaid (update mode, same connection, no new Trial slot used) — then retry.`;
  switch (err.code) {
    case "INVALID_API_KEYS":
    case "INVALID_SECRET":
    case "INVALID_CLIENT_ID":
      return "Plaid rejected the stored client_id/secret (rotated, or the wrong environment). Call Connect with service \"plaid\" to enter them again.";
    case "INVALID_ACCESS_TOKEN":
    case "ITEM_NOT_FOUND":
      return `${bank}'s Plaid connection no longer exists (removed in Plaid's dashboard?). Remove it with Bank remove_item and link it again only if the owner wants to (a new link uses a Trial slot).`;
    case "PRODUCT_NOT_READY":
      return `Plaid is still pulling ${bank}'s data — try again in a minute or two.`;
    case "PRODUCTS_NOT_SUPPORTED":
    case "NO_LIABILITY_ACCOUNTS":
    case "NO_INVESTMENT_ACCOUNTS":
    case "NO_ACCOUNTS":
      return `${bank} doesn't offer that through Plaid (${err.code}).`;
    case "INVALID_PRODUCT":
    case "PRODUCTS_NOT_ENABLED":
      return `This Plaid account isn't enabled for that product (${err.code}). The owner can request access in the Plaid dashboard.`;
    default:
      return `${err.message}${err.display ? ` (${err.display})` : ""}`;
  }
}

// ─── The linked banks ────────────────────────────────────────────────────────

export async function loadPlaidItems(home?: string): Promise<PlaidItem[]> {
  const raw = await getCredential("PLAID_ITEMS", { home });
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((i): i is PlaidItem => Boolean(i && typeof i === "object" && (i as PlaidItem).item_id && (i as PlaidItem).access_token))
      : [];
  } catch {
    return [];
  }
}

/** Store the list; an empty list deletes the credential, so "connected"
 *  (PLAID_ITEMS present) stays true only while a bank is linked. */
export async function savePlaidItems(items: PlaidItem[], home?: string): Promise<void> {
  if (!items.length) {
    await deleteCredential("PLAID_ITEMS", { home });
    return;
  }
  await setCredential("PLAID_ITEMS", JSON.stringify(items), { home });
}

export function plaidItemView(item: PlaidItem): PlaidItemView {
  return { item_id: item.item_id, institution: item.institution_name, added_at: item.added_at };
}

export function plaidDir(home?: string): string {
  return path.join(home ?? aresHome(), "plaid");
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 120);
}

export function plaidItemFile(itemId: string, home?: string): string {
  return path.join(plaidDir(home), `${safeName(itemId)}.json`);
}

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Items ever created through Ares (the Trial budget counts creations). */
export async function plaidItemsCreated(home?: string): Promise<number> {
  const state = await readJsonFile<{ created?: number }>(path.join(plaidDir(home), "state.json"));
  return Math.max(0, Number(state?.created ?? 0) || 0);
}

async function bumpItemsCreated(by: number, home?: string): Promise<void> {
  const created = await plaidItemsCreated(home);
  await writeJsonFile(path.join(plaidDir(home), "state.json"), { created: created + by });
}

/** Trade Link's public tokens for access tokens and add the banks to the
 *  vault. Returns what may be shown: institution + account count per bank. */
export async function exchangePlaidPublicTokens(
  cfg: PlaidConfig,
  results: Array<{ public_token: string; institution?: { name?: string; institution_id?: string }; accounts?: unknown[] }>,
  opts: { home?: string; signal?: AbortSignal } = {},
): Promise<Array<{ item_id: string; institution: string; accounts: number }>> {
  const items = await loadPlaidItems(opts.home);
  const added: Array<{ item_id: string; institution: string; accounts: number }> = [];
  let created = 0;
  for (const result of results) {
    const exchanged = await plaidCall(cfg, "/item/public_token/exchange", { public_token: result.public_token }, opts.signal);
    const itemId = String(exchanged.item_id ?? "");
    const accessToken = String(exchanged.access_token ?? "");
    if (!itemId || !accessToken) throw new Error("Plaid's token exchange returned no item");
    let institution = result.institution?.name?.trim() ?? "";
    if (!institution) {
      const got = await plaidCall(cfg, "/item/get", { access_token: accessToken }, opts.signal).catch(() => ({}) as Record<string, any>);
      institution = String(got.item?.institution_name ?? got.item?.institution_id ?? "Bank");
    }
    const entry: PlaidItem = {
      item_id: itemId,
      access_token: accessToken,
      institution_name: institution,
      ...(result.institution?.institution_id ? { institution_id: result.institution.institution_id } : {}),
      added_at: new Date().toISOString(),
    };
    const existing = items.findIndex((i) => i.item_id === itemId);
    if (existing >= 0) items[existing] = entry;
    else {
      items.push(entry);
      created += 1;
    }
    added.push({ item_id: itemId, institution, accounts: Array.isArray(result.accounts) ? result.accounts.length : 0 });
  }
  await savePlaidItems(items, opts.home);
  if (created) await bumpItemsCreated(created, opts.home);
  return added;
}

/** /item/remove one bank, then forget it (vault entry and sync cache). */
export async function removePlaidItem(itemId: string, opts: { home?: string; signal?: AbortSignal } = {}): Promise<PlaidItemView | null> {
  const cfg = await loadPlaidConfig(opts.home);
  const items = await loadPlaidItems(opts.home);
  const item = items.find((i) => i.item_id === itemId);
  if (!item) return null;
  if (cfg) {
    try {
      await plaidCall(cfg, "/item/remove", { access_token: item.access_token }, opts.signal);
    } catch (err) {
      // Already gone at Plaid: forgetting it here is still right.
      if (!(err instanceof PlaidError && (err.code === "ITEM_NOT_FOUND" || err.code === "INVALID_ACCESS_TOKEN"))) throw err;
    }
  }
  await savePlaidItems(items.filter((i) => i.item_id !== itemId), opts.home);
  await fs.rm(plaidItemFile(itemId, opts.home), { force: true }).catch(() => undefined);
  return plaidItemView(item);
}

/** Disconnect every linked bank. The Plaid keys stay, so reconnecting is one tap. */
export async function disconnectPlaid(opts: { home?: string } = {}): Promise<boolean> {
  const items = await loadPlaidItems(opts.home);
  for (const item of items) {
    await removePlaidItem(item.item_id, opts).catch(() => undefined);
  }
  // Whatever Plaid said, Ares forgets them.
  await savePlaidItems([], opts.home);
  return items.length > 0;
}
