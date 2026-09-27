// The Browser tool's trusted fill layer — vault logins and secret handles.
//
// The model asks for `login` or `fill_secret {handle}`; THIS code (not the
// model) resolves the value, puts it into the page in one step, and drops it.
// The value never appears in a tool output, display, progress event, error
// or filmstrip note. What the Browser keeps afterwards is a salted
// FINGERPRINT per value (never the value): every later result from the same
// browser is scanned for it, so `eval("document.querySelector('[type=password]').value")`,
// a console line or an aria tree echoing the username come back as •••.
//
// Authorization is not here. Every fill needs a fresh owner approval naming
// the exact site and action (the Browser's checkPermissions asks, as an
// owner decision); this module only refuses what must fail closed: a non-https
// page, a handle bound to another site, a field that isn't there.

import { createHash, randomBytes } from "node:crypto";
import {
  appendAudit,
  describeSecretHandle,
  getCredential,
  handleSite,
  loginCredentialNames,
  loginDomainCandidates,
  redactSecretValues,
  redeemSecretHandle,
} from "@ares/core";
import type { BrowserConnector } from "@ares/connectors";

export const DEFAULT_USERNAME_SELECTOR =
  'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i], input[name*="login" i]';
export const DEFAULT_PASSWORD_SELECTOR = 'input[type="password"]';

const MASK = "•••";

// ─── Fingerprints ────────────────────────────────────────────────────────────

const RK_BASE = 257;
const RK_MOD = 2_147_483_647;

function rkHash(text: string, start: number, length: number): number {
  let hash = 0;
  for (let i = start; i < start + length; i += 1) hash = (hash * RK_BASE + text.charCodeAt(i)) % RK_MOD;
  return hash;
}

function rkPower(length: number): number {
  let power = 1;
  for (let i = 1; i < length; i += 1) power = (power * RK_BASE) % RK_MOD;
  return power;
}

interface Fingerprint {
  length: number;
  rolling: number;
  power: number;
  digest: string;
}

/**
 * Remembers secrets WITHOUT their values: a rolling hash finds candidate
 * windows in a text, a salted SHA-256 confirms them. Short values (< 4 chars)
 * are not tracked — masking every "abc" in a page would wreck the output.
 */
export class SecretFingerprints {
  private readonly salt = randomBytes(16);
  private readonly prints: Fingerprint[] = [];

  get size(): number {
    return this.prints.length;
  }

  private digest(text: string): string {
    return createHash("sha256").update(this.salt).update(text).digest("hex");
  }

  add(value: string): void {
    const variants = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    for (const variant of variants) {
      if (variant.length < 4) continue;
      const digest = this.digest(variant);
      if (this.prints.some((p) => p.digest === digest)) continue;
      this.prints.push({ length: variant.length, rolling: rkHash(variant, 0, variant.length), power: rkPower(variant.length), digest });
    }
  }

  clear(): void {
    this.prints.length = 0;
  }

  redact(text: string): string {
    if (!this.prints.length || !text) return text;
    let out = text;
    for (const print of this.prints) {
      if (out.length < print.length) continue;
      const hits: number[] = [];
      let hash = rkHash(out, 0, print.length);
      for (let i = 0; ; i += 1) {
        if (hash === print.rolling && this.digest(out.slice(i, i + print.length)) === print.digest) {
          hits.push(i);
        }
        if (i + print.length >= out.length) break;
        hash = (hash - ((out.charCodeAt(i) * print.power) % RK_MOD) + RK_MOD) % RK_MOD;
        hash = (hash * RK_BASE + out.charCodeAt(i + print.length)) % RK_MOD;
      }
      if (!hits.length) continue;
      let rebuilt = "";
      let cursor = 0;
      for (const at of hits) {
        if (at < cursor) continue;
        rebuilt += out.slice(cursor, at) + MASK;
        cursor = at + print.length;
      }
      out = rebuilt + out.slice(cursor);
    }
    return out;
  }
}

/** Apply a string redaction to every string inside a JSON-ish value. */
export function redactDeep<T>(value: T, redact: (text: string) => string, depth = 0): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact, depth + 1)) as unknown as T;
  if (Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(inner, redact, depth + 1);
  return out as T;
}

// ─── The page a fill targets ─────────────────────────────────────────────────

export interface FillSite {
  origin: string;
  host: string;
  /** origin + path, no query — what the approval names. */
  where: string;
}

/** The current page as a fill target; https only, fails closed otherwise. */
export function fillSiteOf(url: string): FillSite | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "no page is open — open the sign-in page first" };
  }
  if (parsed.protocol !== "https:") return { error: `refusing to fill a secret into a non-https page (${parsed.protocol}//${parsed.host})` };
  return { origin: parsed.origin, host: parsed.hostname.toLowerCase(), where: `${parsed.origin}${parsed.pathname}` };
}

/** The saved login domain for this host (it or a parent), or null. Never reads a value out. */
export async function savedLoginDomain(host: string, opts: { domain?: string; home?: string } = {}): Promise<string | null> {
  const candidates = opts.domain ? [handleSite(opts.domain)] : loginDomainCandidates(host);
  for (const domain of candidates) {
    // A login saved for another site must never be filled here.
    const bound = host === domain || host.endsWith(`.${domain}`) || handleSite(host) === domain;
    if (!bound) continue;
    if (await getCredential(loginCredentialNames(domain).password, { home: opts.home })) return domain;
  }
  return null;
}

export function describeHandleForApproval(handle: string): { site: string; purpose: string } | null {
  const info = describeSecretHandle(handle);
  return info ? { site: info.site, purpose: info.purpose } : null;
}

// ─── The fills ───────────────────────────────────────────────────────────────

function cleanError(err: unknown, values: readonly string[], prints: SecretFingerprints): Error {
  const message = err instanceof Error ? err.message : String(err);
  // Playwright errors carry a call log; keep the first line, masked.
  return new Error(prints.redact(redactSecretValues(message.split("\n")[0] ?? "", values)).slice(0, 300));
}

export interface LoginFillResult {
  domain: string;
  filled: Array<"username" | "password">;
  submitted: boolean;
}

/**
 * Fill the vault login for `domain` into the page. The values exist only in
 * this function's scope; they are fingerprinted for later redaction and
 * dropped. Returns what was filled — never a value.
 */
export async function performLogin(
  br: BrowserConnector,
  opts: { domain: string; home?: string; usernameSelector?: string; passwordSelector?: string; submit?: boolean; prints: SecretFingerprints },
): Promise<LoginFillResult> {
  if (!br.fillSecret) throw new Error("this browser connection can't fill secrets safely — use the Ares browser (Browser open) instead of an attached tab");
  const names = loginCredentialNames(opts.domain);
  const username = await getCredential(names.username, { home: opts.home });
  const password = await getCredential(names.password, { home: opts.home });
  const values = [username, password].filter((v): v is string => Boolean(v));
  for (const value of values) opts.prints.add(value);
  const filled: LoginFillResult["filled"] = [];
  const userSel = opts.usernameSelector ?? DEFAULT_USERNAME_SELECTOR;
  const passSel = opts.passwordSelector ?? DEFAULT_PASSWORD_SELECTOR;
  try {
    if (username) {
      try {
        await br.fillSecret({ selector: userSel }, username);
        filled.push("username");
      } catch (err) {
        // Password-only step of a two-step sign-in: no username field is fine.
        if (!/no field matches/.test(err instanceof Error ? err.message : "")) throw err;
      }
    }
    if (password) {
      try {
        await br.fillSecret({ selector: passSel }, password);
        filled.push("password");
      } catch (err) {
        // Username-first step (Google, Microsoft): the password page comes next.
        if (!/no field matches/.test(err instanceof Error ? err.message : "")) throw err;
      }
    }
  } catch (err) {
    throw cleanError(err, values, opts.prints);
  }
  if (!filled.length) throw new Error("no sign-in fields found on this page — open the site's sign-in form first (or pass username_selector / password_selector)");
  let submitted = false;
  if (opts.submit && br.submitForm) {
    submitted = await br.submitForm(filled.includes("password") ? passSel : userSel).catch(() => false);
  }
  return { domain: opts.domain, filled, submitted };
}

/** Fill a secret handle (an emailed sign-in code…) into one field on `host`. */
export async function performFillSecret(
  br: BrowserConnector,
  opts: { handle: string; host: string; selector?: string; label?: string; submit?: boolean; prints: SecretFingerprints },
): Promise<{ site: string; purpose: string; submitted: boolean }> {
  if (!br.fillSecret) throw new Error("this browser connection can't fill secrets safely — use the Ares browser (Browser open) instead of an attached tab");
  if (!opts.selector && !opts.label) throw new Error("fill_secret needs a selector or a label for the field");
  const info = describeSecretHandle(opts.handle);
  if (!info) throw new Error("that secret handle is unknown or expired — get a fresh one");
  // Fails closed on a different site (SECRET_HANDLE_SITE_MISMATCH) and consumes a use.
  const value = redeemSecretHandle(opts.handle, { site: opts.host });
  opts.prints.add(value);
  try {
    await br.fillSecret({ ...(opts.selector ? { selector: opts.selector } : { label: opts.label! }) }, value);
  } catch (err) {
    throw cleanError(err, [value], opts.prints);
  }
  let submitted = false;
  if (opts.submit && br.submitForm && opts.selector) submitted = await br.submitForm(opts.selector).catch(() => false);
  return { site: info.site, purpose: info.purpose, submitted };
}

export function auditFill(entry: { home?: string; sessionId?: string; action: string; target: string; params: Record<string, unknown>; result: string }): void {
  void appendAudit(
    {
      actor: "ares",
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      action: entry.action,
      target: entry.target,
      params: entry.params,
      result: entry.result,
    },
    entry.home,
  );
}
