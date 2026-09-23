// Secret handles — the model handles REFERENCES, never values.
//
// A sign-in code read from email, or a password pulled from the vault for one
// fill, must never enter the model's context, the chat, a rollout or a log.
// The layer that obtains the value mints an opaque handle ("sec_…") and hands
// THAT to the model; only the trusted layer that performs the fill (the
// Browser tool's fill primitive — code, not the model) can redeem it, and only
// for the site it was minted for.
//
// Properties, each load-bearing:
//   - in memory only, never on disk: a process restart forgets every handle;
//   - short-lived (default 5 min) and single-use by default;
//   - bound to a site: redeeming for any other site fails closed;
//   - getting a handle is not authorization to use it — the caller that
//     redeems must still obtain a fresh approval naming the site and action.
//
// There is deliberately NO export that returns a value to a tool output.
// redeemSecretHandle is for the fill primitive only; grep for its callers.

import { randomBytes } from "node:crypto";

export interface SecretHandleScope {
  /** Registrable domain the value may be used on, e.g. "doordash.com". */
  site: string;
  /** What it is for, shown in approvals: "sign-in code", "password". */
  purpose: string;
}

interface Entry extends SecretHandleScope {
  value: string;
  expiresAt: number;
  usesLeft: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const handles = new Map<string, Entry>();

function sweep(now: number): void {
  for (const [handle, entry] of handles) if (entry.expiresAt <= now) handles.delete(handle);
}

/** Normalize a host or URL to the bare registrable-ish domain used for binding. */
export function handleSite(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    // keep as given
  }
  return host.replace(/^www\./, "").replace(/\.$/, "");
}

/** True when `host` is `site` or a subdomain of it. */
function siteMatches(site: string, host: string): boolean {
  const s = handleSite(site);
  const h = handleSite(host);
  return h === s || h.endsWith(`.${s}`);
}

export function mintSecretHandle(
  value: string,
  scope: SecretHandleScope,
  opts: { ttlMs?: number; uses?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  sweep(now);
  const handle = `sec_${randomBytes(18).toString("base64url")}`;
  handles.set(handle, {
    value,
    site: handleSite(scope.site),
    purpose: scope.purpose,
    expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    usesLeft: Math.max(1, opts.uses ?? 1),
  });
  return handle;
}

/** What a handle is for — never its value. Null when unknown or expired. */
export function describeSecretHandle(handle: string, now = Date.now()): (SecretHandleScope & { expiresAt: number }) | null {
  sweep(now);
  const entry = handles.get(handle);
  return entry ? { site: entry.site, purpose: entry.purpose, expiresAt: entry.expiresAt } : null;
}

/**
 * The trusted fill primitive's ONLY way to a value. Fails closed: unknown,
 * expired, used-up, or a site that isn't the one the handle was minted for.
 * A successful redeem consumes one use; the last use forgets the value.
 */
export function redeemSecretHandle(handle: string, use: { site: string }, now = Date.now()): string {
  sweep(now);
  const entry = handles.get(handle);
  if (!entry) throw new Error("SECRET_HANDLE_INVALID: unknown or expired handle");
  if (!siteMatches(entry.site, use.site)) {
    throw new Error(`SECRET_HANDLE_SITE_MISMATCH: handle is for ${entry.site}, not ${handleSite(use.site)}`);
  }
  entry.usesLeft -= 1;
  if (entry.usesLeft <= 0) handles.delete(handle);
  return entry.value;
}

/** Forget a handle without using it (denied approval, cancelled task). */
export function revokeSecretHandle(handle: string): void {
  handles.delete(handle);
}

/** Replace any occurrence of live secret values in `text` — a last-line
 *  redaction for page-derived text returned in the same call as a fill. */
export function redactSecretValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) if (value && value.length >= 3) out = out.split(value).join("•••");
  return out;
}
