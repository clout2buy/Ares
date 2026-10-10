// One-time codes from email — the pure half of Gmail `find_code`.
//
// A sign-in or checkout challenge ("we sent a code to c•••@gmail.com") is the
// one place Ares reads mail on a website's behalf. Getting it wrong is how an
// account gets taken over: a phishing mail with a look-alike code, a stale
// code from yesterday, the wrong account's code. So every rule here fails
// CLOSED — the lookup answers with exactly one code it is sure of, or nothing:
//
//   - the sender must be the site's own domain (or a short, explicit alias
//     list) AND Gmail's Authentication-Results must show DKIM/DMARC passing
//     for that domain — a From header alone is trivially forged;
//   - the message must be addressed to an address consistent with the masked
//     recipient the page showed;
//   - the code comes from the BODY near words like "code"/"verification",
//     never the subject or snippet;
//   - two different codes anywhere in scope is ambiguity, not a choice.
//
// Everything here is pure so the rules are pinned by tests on real-shaped
// mail; the Gmail tool does the fetching and mints the secret handle.

/** Sites whose codes arrive from a different domain than the one you sign in
 *  on. Small and explicit on purpose — every entry widens who may supply a
 *  code. Keys and values are registrable domains. */
export const CODE_SENDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "ubereats.com": ["uber.com"],
  "x.com": ["twitter.com"],
  "twitter.com": ["x.com"],
  "facebook.com": ["facebookmail.com"],
  "instagram.com": ["facebookmail.com"],
  "live.com": ["microsoft.com"],
  "outlook.com": ["microsoft.com"],
  "youtube.com": ["google.com"],
};

const MULTI_PART_SUFFIX = /^(co|com|org|net|ac|gov|edu|ne|or)$/;

/** "www.shop.doordash.com" → "doordash.com"; "amazon.co.uk" stays whole. */
export function registrableDomain(hostOrUrl: string): string {
  let host = hostOrUrl.trim().toLowerCase();
  try {
    if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    // keep as given
  }
  host = host.replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tld = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const take = tld.length === 2 && MULTI_PART_SUFFIX.test(second) ? 3 : 2;
  return parts.slice(-take).join(".");
}

/** The exact https origin a challenge page lives on, or null when `site` isn't one. */
export function parseSiteOrigin(site: string | undefined): URL | null {
  if (!site) return null;
  try {
    const url = new URL(site.trim());
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Registrable domains allowed to send a code for `site`. */
export function allowedSenderDomains(site: URL): string[] {
  const own = registrableDomain(site.hostname);
  return [own, ...(CODE_SENDER_ALIASES[own] ?? [])];
}

/** The bare address out of `"DoorDash" <no-reply@doordash.com>`. */
export function emailAddressOf(header: string): string {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(header);
  const bare = angle?.[1] ?? /([^\s<>",;]+@[^\s<>",;]+)/.exec(header)?.[1] ?? "";
  return bare.toLowerCase();
}

export function senderDomainAllowed(fromHeader: string, allowed: readonly string[]): string | null {
  const address = emailAddressOf(fromHeader);
  const host = address.split("@")[1] ?? "";
  if (!host) return null;
  const domain = registrableDomain(host);
  return allowed.includes(domain) ? domain : null;
}

/**
 * Gmail stamps every inbound message with
 *   Authentication-Results: mx.google.com; dkim=pass header.i=@doordash.com …;
 *   spf=pass …; dmarc=pass (p=REJECT …) header.from=doordash.com
 * A code counts only when DMARC passed for the sender's domain, or DKIM passed
 * with a signing domain inside it. SPF alone is not enough (it authenticates
 * the envelope, not the From the owner sees).
 */
export function authenticatedFor(authResults: readonly string[], senderDomain: string): boolean {
  const within = (d: string) => {
    const dom = d.toLowerCase().replace(/^@/, "");
    return dom === senderDomain || dom.endsWith(`.${senderDomain}`);
  };
  for (const header of authResults) {
    for (const clause of header.split(";")) {
      const c = clause.trim().toLowerCase();
      const dmarc = /^dmarc=pass\b.*header\.from=([a-z0-9.-]+)/.exec(c);
      if (dmarc && within(dmarc[1]!)) return true;
      const dkim = /^dkim=pass\b.*header\.(?:i|d)=@?([a-z0-9.-]+)/.exec(c);
      if (dkim && within(dkim[1]!)) return true;
    }
  }
  return false;
}

const MASK_CHARS = /[•●∙·*…_]|x{2,}/i;

/**
 * Does `address` fit what the page showed — "c•••@gmail.com", "c***e@g***.com",
 * "cr…@gmail.com"? Visible characters must match in place; any run of mask
 * characters stands for one or more hidden characters. An unmasked address
 * must match exactly.
 */
export function matchesMaskedRecipient(address: string, masked: string): boolean {
  const addr = address.trim().toLowerCase();
  const mask = masked.trim().toLowerCase();
  if (!addr.includes("@") || !mask.includes("@")) return false;
  const [mLocal, mDomain] = [mask.slice(0, mask.lastIndexOf("@")), mask.slice(mask.lastIndexOf("@") + 1)];
  const toPattern = (part: string, hidden: string) => {
    let out = "";
    let i = 0;
    while (i < part.length) {
      const rest = part.slice(i);
      const m = /^(?:[•●∙·*…_]+|x{2,})/i.exec(rest);
      if (m && MASK_CHARS.test(m[0])) {
        out += `${hidden}+`;
        i += m[0].length;
        continue;
      }
      out += part[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
    return out;
  };
  const re = new RegExp(`^${toPattern(mLocal, "[^@]")}@${toPattern(mDomain, "[^@]")}$`, "i");
  return re.test(addr);
}

/** Every address in To / Cc / Delivered-To style headers. */
export function addressesIn(headers: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of headers) for (const m of h.matchAll(/[^\s<>",;:]+@[^\s<>",;]+/g)) out.push(m[0].toLowerCase());
  return out;
}

// ─── Body text ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", zwnj: "", zwj: "", shy: "" };

/** Good-enough HTML → text for code mail: drop head/style/script, keep text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (all, name: string) => {
      const lower = name.toLowerCase();
      if (lower in ENTITIES) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return all;
    })
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();
}

// ─── Extraction ───────────────────────────────────────────────────────────

/** Words that announce a code. A candidate must sit close to one of these. */
const CODE_WORD = /\b(?:code|codes|passcode|otp|one[- ]time (?:password|pin)|verification|pin|security code|token)\b/gi;
const NOT_A_SIGN_IN_CODE = /\b(?:promo|promotional|coupon|discount|gift|referral|zip|postal|area|country|source|qr|bar|offer|voucher)\s*$/i;
const CODE_AFTER_WINDOW = 90;
const CODE_BEFORE_WINDOW = 40;

/** A 4–8 digit code (optionally "123 456" / "123-456"), or a 4–8 char
 *  UPPERCASE alphanumeric with both letters and digits. Never glued to a
 *  currency sign, a decimal point, a path, a phone-number dash or a percent
 *  (a sentence-ending period is fine: "Your code is 5821."). */
const CANDIDATE = /(?<![\w$€£¥#\/:@])(?<!\d[-–.,])(\d{3}[ -]\d{3}|\d{4,8}|[A-Z0-9]{4,8})(?![\w%\/:@]|[-–.,]\d)/g;
const MONTH = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

function plausible(token: string, text: string, index: number): boolean {
  const compact = token.replace(/[ -]/g, "");
  if (/^[A-Z0-9]+$/.test(compact) && /[A-Z]/.test(compact)) {
    // Alphanumeric codes need a digit AND a letter — else it's a WORD ("CODE", "HTTPS").
    if (!/\d/.test(compact)) return false;
  }
  // A US ZIP in a footer address: "San Francisco, CA 94107".
  if (/^\d{5}$/.test(compact) && /\b[A-Z]{2}\s$/.test(text.slice(Math.max(0, index - 4), index))) return false;
  // A year or a date fragment: "© 2026", "Sep 23, 2026".
  if (/^(19|20)\d\d$/.test(compact)) {
    const around = text.slice(Math.max(0, index - 16), index + token.length + 16);
    if (/©|\(c\)|copyright/i.test(around) || MONTH.test(around)) return false;
  }
  return true;
}

/**
 * The distinct codes a body offers, each within a short window of a code
 * word ("Your verification code is 123456", "123456 is your code"). Returns
 * normalized codes (spaces/dashes removed), deduplicated, in order found.
 */
export function extractCodes(body: string): string[] {
  const text = body.replace(/\r/g, "");
  const anchors: Array<[number, number]> = [];
  for (const m of text.matchAll(CODE_WORD)) {
    // "promo code SAVE20", "ZIP code 94107" — codes, but not the kind we want.
    if (NOT_A_SIGN_IN_CODE.test(text.slice(Math.max(0, m.index! - 14), m.index!))) continue;
    anchors.push([m.index!, m.index! + m[0].length]);
  }
  if (anchors.length === 0) return [];
  const found: string[] = [];
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const near = anchors.some(([a0, a1]) => (start >= a1 && start - a1 <= CODE_AFTER_WINDOW) || (end <= a0 && a0 - end <= CODE_BEFORE_WINDOW));
    if (!near || !plausible(m[0], text, start)) continue;
    const code = m[0].replace(/[ -]/g, "");
    if (!found.includes(code)) found.push(code);
  }
  return found;
}
