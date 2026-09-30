// Shared plumbing for the open-standard connectors: CalDAV / CardDAV
// (Calendar, Contacts) and IMAP / SMTP (Mail).
//
// What lives here, because every one of those tools and the connect-hub
// verifiers need exactly the same answers:
//   - where the owner's credentials are (the encrypted vault ONLY) and which
//     server/protocol each account maps to, iCloud included
//   - URL and host safety: no cleartext password over the open internet
//   - a bounded, timed, auth-scoped fetch for the DAV client
//   - error CLASSIFICATION: wrong password vs app-password-needed vs
//     unreachable vs TLS vs "not a CalDAV server", in a sentence a human can
//     act on, with every secret scrubbed out of it
//   - size bounds for everything that goes back to the model
// A secret (password, Apple ID password, Basic header) never appears in tool
// output, errors, logs or audit: `redact()` runs on every message that leaves.

import { getCredential, DAV_CREDENTIALS } from "@ares/core";

// ─── bounds ──────────────────────────────────────────────────────────────────

export const DAV_LIMITS = {
  /** Network timeout for one DAV/IMAP/SMTP operation. */
  timeoutMs: 25_000,
  /** Largest single HTTP response body accepted from a DAV server. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Largest RFC 822 source read for one message. */
  maxMessageBytes: 2 * 1024 * 1024,
  maxEvents: 200,
  maxContacts: 50,
  maxMessages: 50,
  maxReminders: 100,
  maxCalendars: 50,
  maxFolders: 200,
  /** Characters of message/event/contact body returned to the model. */
  maxBodyChars: 12_000,
  maxFieldChars: 500,
  maxNoteChars: 4_000,
  /** Occurrences walked for one recurring event (runaway RRULE guard). */
  maxOccurrences: 2_000,
  /** Recipients on one outgoing mail. */
  maxRecipients: 50,
} as const;

export function clip(text: string | undefined | null, max: number = DAV_LIMITS.maxFieldChars): string {
  const value = (text ?? "").toString();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Collapse CR/LF (header/field injection) and control characters to spaces. */
export function oneLine(value: string | undefined | null, max: number = DAV_LIMITS.maxFieldChars): string {
  // eslint-disable-next-line no-control-regex
  return clip((value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim(), max);
}

// ─── redaction ───────────────────────────────────────────────────────────────

/** Replace every secret (and its Basic-auth / base64 forms) in `text`. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined | null> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    const forms = new Set<string>([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]);
    for (const form of forms) out = out.split(form).join("[redacted]");
  }
  // Belt and braces for what we cannot enumerate: Authorization values and
  // user:password@ in URLs.
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)(basic|bearer|digest)\s+[A-Za-z0-9+/=._~-]+/gi, "$1$2 [redacted]");
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
  return out;
}

// ─── errors ──────────────────────────────────────────────────────────────────

export type DavErrorKind =
  | "auth"
  | "app-password"
  | "unreachable"
  | "timeout"
  | "tls"
  | "not-found"
  | "forbidden"
  | "not-dav"
  | "server"
  | "too-large"
  | "bad-response"
  | "insecure-url"
  | "unknown";

/** An error whose message is already safe and human: no secrets, no stack. */
export class DavError extends Error {
  constructor(
    readonly kind: DavErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DavError";
  }
}

export interface ErrorContext {
  /** Which protocol failed, for the sentence. */
  service: "CalDAV" | "CardDAV" | "IMAP" | "SMTP";
  host?: string;
  /** "icloud" adds the app-specific-password guidance. */
  provider?: string;
  secrets?: ReadonlyArray<string | undefined | null>;
}

const APP_PASSWORD_HINT =
  /app(?:lication)?[- ]?(?:specific )?password|less secure|2[- ]?step|two[- ]?(?:factor|step)|web ?login required|log ?in via your web ?browser|authenticat(?:e|ion) (?:with|using) an app|webmail|enable imap|imap (?:access )?(?:is )?(?:disabled|not enabled)/i;

const ICLOUD_APP_PASSWORD_HELP =
  "iCloud only accepts an app-specific password here, never your Apple ID password: sign in at account.apple.com, open Sign-In and Security, choose App-Specific Passwords, create one named Ares, and paste the xxxx-xxxx-xxxx-xxxx value. Two-factor authentication must be on.";

/** The most specific error code in an error and its causes (fetch wraps the
 *  socket error: TypeError("fetch failed") with cause.code or an AggregateError). */
function errorCode(err: unknown, depth = 0): string {
  if (!err || typeof err !== "object" || depth > 4) return "";
  const any = err as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof any.code === "string" && any.code) return any.code;
  const nested = errorCode(any.cause, depth + 1);
  if (nested) return nested;
  for (const inner of Array.isArray(any.errors) ? any.errors : []) {
    const c = errorCode(inner, depth + 1);
    if (c) return c;
  }
  return "";
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const extra = (err as { responseText?: unknown; response?: unknown }).responseText ?? (err as { response?: unknown }).response;
    return `${err.message} ${typeof extra === "string" ? extra : ""}`;
  }
  return String(err);
}

function where(ctx: ErrorContext): string {
  return ctx.host ? `${ctx.service} server ${ctx.host}` : `the ${ctx.service} server`;
}

/** What a 401 (or an IMAP/SMTP login rejection) means, for this provider. */
function authMessage(ctx: ErrorContext, serverSaid: string): string {
  if (ctx.provider === "icloud") {
    return `Apple rejected the Apple ID or app-specific password. ${ICLOUD_APP_PASSWORD_HELP}`;
  }
  if (APP_PASSWORD_HINT.test(serverSaid)) {
    return `${where(ctx)} needs an app password (or has IMAP/app access switched off) rather than the normal account password. Create an app password in the provider's security settings and use that.`;
  }
  return `${where(ctx)} rejected the username or password. Check both; if the account has two-factor authentication, it needs an app password instead of the normal one.`;
}

/** The kind of failure an HTTP status from a DAV server means. */
export function classifyHttpStatus(status: number, ctx: ErrorContext, serverSaid = ""): DavError {
  const secrets = ctx.secrets ?? [];
  if (status === 401) {
    const kind: DavErrorKind = ctx.provider === "icloud" || APP_PASSWORD_HINT.test(serverSaid) ? "app-password" : "auth";
    return new DavError(kind, redact(authMessage(ctx, serverSaid), secrets));
  }
  if (status === 403) {
    return new DavError(
      APP_PASSWORD_HINT.test(serverSaid) || ctx.provider === "icloud" ? "app-password" : "forbidden",
      redact(
        ctx.provider === "icloud"
          ? `Apple refused the login (HTTP 403). ${ICLOUD_APP_PASSWORD_HELP}`
          : `${where(ctx)} answered 403 Forbidden: the login is valid but this account may not use ${ctx.service}, or the server blocks this client.`,
        secrets,
      ),
    );
  }
  if (status === 404 || status === 410) return new DavError("not-found", redact(`${where(ctx)} has nothing at that address (HTTP ${status}). Check the server address.`, secrets));
  if (status === 405 || status === 501) return new DavError("not-dav", redact(`${where(ctx)} answered, but it does not speak ${ctx.service} at that address (HTTP ${status}).`, secrets));
  if (status === 429) return new DavError("server", `${where(ctx)} says slow down (HTTP 429). Try again in a minute.`);
  if (status >= 500) return new DavError("server", redact(`${where(ctx)} had an internal error (HTTP ${status}). Try again later.`, secrets));
  return new DavError("unknown", redact(`${where(ctx)} answered HTTP ${status}.`, secrets));
}

/** Turn anything thrown by fetch / tsdav / imapflow / nodemailer into a
 *  DavError with a message that is safe to show and useful to act on. */
export function classifyError(err: unknown, ctx: ErrorContext): DavError {
  if (err instanceof DavError) return err;
  const secrets = ctx.secrets ?? [];
  const text = redact(errorText(err), secrets);
  const code = errorCode(err);
  const any = err as { name?: string; authenticationFailed?: boolean; responseStatus?: string; responseCode?: number; serverResponseCode?: string } | null;

  if (any?.name === "TimeoutError" || any?.name === "AbortError" || code === "ETIMEDOUT" || code === "ESOCKET_TIMEOUT" || code === "ETIMEOUT" || /timed? ?out|timeout/i.test(text)) {
    return new DavError("timeout", `${where(ctx)} did not answer in time. It may be down, blocked by a firewall, or the address is wrong.`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || /ENOTFOUND|getaddrinfo/i.test(text)) {
    return new DavError("unreachable", `Could not find ${ctx.host ? `a server named ${ctx.host}` : "that server"}. Check the spelling of the address and that this machine has internet.`);
  }
  if (code === "ECONNREFUSED" || /ECONNREFUSED/i.test(text)) {
    return new DavError("unreachable", `${where(ctx)} refused the connection. The address or port is wrong, or the service is not running.`);
  }
  if (["ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ECONNABORTED", "ENETDOWN"].includes(code)) {
    return new DavError("unreachable", `${where(ctx)} could not be reached (${code}). Check the address and the network.`);
  }
  if (/^(ERR_TLS|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL|HOSTNAME_MISMATCH|UNABLE_TO_GET_ISSUER)/.test(code) || /self[- ]signed|certificate|unable to verify|wrong version number|ssl routines/i.test(text)) {
    return new DavError("tls", `${where(ctx)} presented a TLS certificate this machine does not trust (${code || "certificate error"}). Use the provider's real hostname, or for a server on your own network give it a trusted certificate.`);
  }
  // Login rejections: imapflow, nodemailer and our own 401 handling.
  if (any?.authenticationFailed === true || code === "EAUTH" || code === "AUTHENTICATIONFAILED" || any?.serverResponseCode === "AUTHENTICATIONFAILED" || any?.responseCode === 535 || any?.responseCode === 534 || /invalid credentials|authentication failed|auth(?:entication)? (?:rejected|required)|login failed|incorrect (?:user|password)|\[AUTHENTICATIONFAILED\]|535 |534 /i.test(text)) {
    const app = ctx.provider === "icloud" || APP_PASSWORD_HINT.test(text);
    return new DavError(app ? "app-password" : "auth", redact(authMessage(ctx, text), secrets));
  }
  const status = /\bHTTP (\d{3})\b|returned (\d{3})\b|status(?: code)?:? (\d{3})\b/i.exec(text);
  const numeric = status ? Number(status[1] ?? status[2] ?? status[3]) : NaN;
  if (Number.isFinite(numeric) && numeric >= 400) return classifyHttpStatus(numeric, ctx, text);
  if (/Invalid credentials: PROPFIND/i.test(text)) return classifyHttpStatus(401, ctx, text);
  if (/cannot find (principalUrl|homeUrl)/i.test(text)) {
    return new DavError("not-dav", `${where(ctx)} answered, but no ${ctx.service} account was found there. Give the server's base address (for example https://dav.example.com) or the full CalDAV/CardDAV URL from your provider's help page.`);
  }
  if (/cannot find calendarUserAddresses/i.test(text)) {
    return new DavError("not-dav", `${where(ctx)} did not list calendar user addresses; it may not be a full CalDAV server.`);
  }
  if (/not\s+(?:xml|dav)|unexpected token|non-whitespace before first tag|<!doctype html|<html/i.test(text)) {
    return new DavError("not-dav", `${where(ctx)} answered with a web page, not ${ctx.service}. Check the address.`);
  }
  return new DavError("unknown", `${ctx.service} failed: ${clip(text.replace(/\s+/g, " ").trim(), 240) || "unknown error"}`);
}

// ─── hosts and URLs ──────────────────────────────────────────────────────────

/** Loopback, RFC 1918, link-local, .local/.lan/.home.arpa and single-label
 *  names: hosts where cleartext http is acceptable (a home server, Proton
 *  Bridge, a test container) and a self-signed certificate is normal. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m172 = /^172\.(\d{1,3})\./.exec(h);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  if (/\.(local|lan|home\.arpa|internal|intranet)$/.test(h)) return true;
  if (!h.includes(".") && !h.includes(":")) return true;
  return false;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h);
}

/** Validate an owner-supplied CalDAV/CardDAV address. Returns the normalized
 *  URL, or throws a DavError whose message says what to change. */
export function assertSafeDavUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new DavError("insecure-url", "That server address isn't a valid URL. Use something like https://dav.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DavError("insecure-url", "The server address must start with https:// (or http:// for a server on your own network).");
  }
  if (url.username || url.password) {
    throw new DavError("insecure-url", "Don't put the username or password inside the address; use the separate fields.");
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new DavError("insecure-url", `Refusing to send a password to ${url.hostname} over plain http. Use the https:// address (plain http is only allowed for servers on your own network).`);
  }
  return url;
}

/** Split "host", "host:993" or "[::1]:143" into parts. */
export function parseHostPort(raw: string, defaultPort: number): { host: string; port: number } {
  const value = raw.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracket) return { host: bracket[1]!, port: bracket[2] ? Number(bracket[2]) : defaultPort };
  const colon = value.lastIndexOf(":");
  if (colon > 0 && value.indexOf(":") === colon && /^\d+$/.test(value.slice(colon + 1))) {
    return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
  }
  return { host: value, port: defaultPort };
}

function registrableSuffix(host: string): string {
  return host.toLowerCase().split(".").slice(-2).join(".");
}

/** May credentials follow a request from `base` to `target`? Same host, or the
 *  same registrable domain (caldav.icloud.com → p12-caldav.icloud.com). */
export function mayForwardAuth(base: URL, target: URL): boolean {
  if (base.hostname.toLowerCase() === target.hostname.toLowerCase()) return true;
  if (/^[\d.]+$/.test(base.hostname) || base.hostname.includes(":")) return false;
  return registrableSuffix(base.hostname) === registrableSuffix(target.hostname);
}

// ─── bounded fetch for the DAV client ────────────────────────────────────────

export interface BoundedFetchOptions {
  /** The server the owner configured; credentials only flow to it and to its domain. */
  base: URL;
  timeoutMs?: number;
  maxBytes?: number;
  /** Underlying fetch (tests). */
  fetchImpl?: typeof fetch;
  secrets?: ReadonlyArray<string | undefined | null>;
  /** How to word a network failure (which protocol, which provider). */
  ctx?: ErrorContext;
}

/**
 * The fetch the DAV client runs on: times out, caps the response body, refuses
 * cleartext http to public hosts, and strips the Authorization header from any
 * request that leaves the configured server's domain (a hostile redirect can
 * not harvest the password). The Response it returns carries the original
 * `url`, which the DAV client reads back.
 */
export function boundedFetch(opts: BoundedFetchOptions): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? DAV_LIMITS.timeoutMs;
  const maxBytes = opts.maxBytes ?? DAV_LIMITS.maxResponseBytes;
  const real = opts.fetchImpl ?? fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (target.protocol === "http:" && !isPrivateHost(target.hostname)) {
      throw new DavError("insecure-url", `Refusing a plain http request to ${target.hostname}: passwords only travel over https.`);
    }
    const headers = new Headers(init?.headers);
    if (!mayForwardAuth(opts.base, target)) headers.delete("authorization");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await real(target.href, { ...init, headers, signal });
    } catch (err) {
      // Classify here, where the socket error and its cause are still attached.
      if (err instanceof DavError) throw err;
      throw classifyError(err, { ...(opts.ctx ?? { service: "CalDAV" as const }), host: target.hostname, secrets: opts.secrets ?? opts.ctx?.secrets });
    }
    const bodyless = res.status === 101 || res.status === 204 || res.status === 205 || res.status === 304 || (res.status >= 300 && res.status < 400);
    let buffer: Buffer | null = null;
    if (!bodyless && res.body) {
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body.cancel().catch(() => undefined);
        throw new DavError("too-large", `The server's answer is larger than ${Math.round(maxBytes / 1_048_576)} MB; refusing to read it.`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DavError("too-large", `The server's answer is larger than ${Math.round(maxBytes / 1_048_576)} MB; refusing to read it.`);
        }
        chunks.push(Buffer.from(value));
      }
      buffer = Buffer.concat(chunks);
    }
    const out = new Response(bodyless || !buffer ? null : new Uint8Array(buffer), { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(out, "url", { value: res.url || target.href });
    return out;
  }) as typeof fetch;
}

// ─── accounts (credentials come from the vault, nowhere else) ────────────────

export type AccountId = "icloud" | "caldav" | "carddav" | "imap";

export interface DavAccount {
  id: "icloud" | "caldav" | "carddav";
  serverUrl: string;
  username: string;
  password: string;
}

export interface MailAccount {
  id: "icloud" | "imap";
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** IMAP logins to try in order (iCloud accepts the local part for some Apple IDs). */
  users: string[];
  /** The SMTP login (iCloud wants the full iCloud Mail address). */
  smtpUser: string;
  password: string;
  /** The From address. */
  from: string;
}

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";
export const ICLOUD_CARDDAV_URL = "https://contacts.icloud.com";
export const ICLOUD_IMAP = { host: "imap.mail.me.com", port: 993, secure: true } as const;
export const ICLOUD_SMTP = { host: "smtp.mail.me.com", port: 587, secure: false } as const;

export interface AccountLookup {
  home?: string;
}

async function cred(name: string, lookup: AccountLookup): Promise<string | undefined> {
  return getCredential(name, lookup.home ? { home: lookup.home } : {});
}

export const NOT_CONNECTED = (serviceIds: string): string =>
  `No account is connected for this. Call Connect {action:"connect", service:"${serviceIds}"} so the owner can add it on their phone, then retry.`;

/** The DAV account for one protocol: an explicit `account` if given, else
 *  iCloud first and then the generic server. Undefined when none is set up. */
export async function loadDavAccount(protocol: "caldav" | "carddav", account?: AccountId, lookup: AccountLookup = {}): Promise<DavAccount | undefined> {
  const order: Array<"icloud" | "caldav" | "carddav"> = account ? [account as never] : ["icloud", protocol];
  for (const id of order) {
    if (id === "icloud") {
      const appleId = await cred(DAV_CREDENTIALS.icloud.appleId, lookup);
      const password = await cred(DAV_CREDENTIALS.icloud.appPassword, lookup);
      if (appleId && password) {
        return { id: "icloud", serverUrl: protocol === "caldav" ? ICLOUD_CALDAV_URL : ICLOUD_CARDDAV_URL, username: appleId, password };
      }
    } else if (id === protocol) {
      const keys = DAV_CREDENTIALS[protocol];
      const url = await cred(keys.url, lookup);
      const username = await cred(keys.user, lookup);
      const password = await cred(keys.password, lookup);
      if (url && username && password) return { id: protocol, serverUrl: url, username, password };
    }
  }
  return undefined;
}

const ICLOUD_MAIL_DOMAINS = /@(icloud\.com|me\.com|mac\.com)$/i;

/** The default SMTP host for an IMAP host: imap.example.com → smtp.example.com. */
export function guessSmtpHost(imapHost: string): string {
  return /^imap[.-]/i.test(imapHost) ? imapHost.replace(/^imap/i, "smtp") : imapHost;
}

/** "host", "host:port", "imaps://host:port" (implicit TLS on any port). Port
 *  993 (IMAP) and 465 (SMTP) are implicit TLS; every other port is STARTTLS. */
export function parseMailEndpoint(raw: string, defaultPort: number, implicitTlsPort: number): { host: string; port: number; secure: boolean } {
  const scheme = /^([a-z]+):\/\//i.exec(raw.trim())?.[1]?.toLowerCase();
  const { host, port } = parseHostPort(raw, defaultPort);
  const explicitTls = scheme === "imaps" || scheme === "smtps" || scheme === "ssl" || scheme === "tls";
  return { host, port, secure: explicitTls || port === implicitTlsPort };
}

export function mailAccountFromValues(values: {
  host: string;
  user: string;
  password: string;
  smtpHost?: string;
  from?: string;
}): MailAccount {
  const imap = parseMailEndpoint(values.host, 993, 993);
  const smtpRaw = values.smtpHost?.trim();
  const smtp = smtpRaw ? parseMailEndpoint(smtpRaw, 587, 465) : { host: guessSmtpHost(imap.host), port: 587, secure: false };
  const from = values.from?.trim() || (values.user.includes("@") ? values.user : "");
  return {
    id: "imap",
    imap,
    smtp,
    users: [values.user],
    smtpUser: values.user,
    password: values.password,
    from,
  };
}

export async function loadMailAccount(account?: AccountId, lookup: AccountLookup = {}): Promise<MailAccount | undefined> {
  const order: Array<"icloud" | "imap"> = account ? [account as never] : ["icloud", "imap"];
  for (const id of order) {
    if (id === "icloud") {
      const appleId = await cred(DAV_CREDENTIALS.icloud.appleId, lookup);
      const password = await cred(DAV_CREDENTIALS.icloud.appPassword, lookup);
      if (!appleId || !password) continue;
      const mail = (await cred(DAV_CREDENTIALS.icloud.mailAddress, lookup)) ?? (ICLOUD_MAIL_DOMAINS.test(appleId) ? appleId : "");
      const users = [appleId];
      const local = appleId.split("@")[0];
      if (ICLOUD_MAIL_DOMAINS.test(appleId) && local) users.push(local);
      if (mail && !users.includes(mail)) users.push(mail);
      return { id: "icloud", imap: { ...ICLOUD_IMAP }, smtp: { ...ICLOUD_SMTP }, users, smtpUser: mail || appleId, password, from: mail || appleId };
    }
    if (id === "imap") {
      const host = await cred(DAV_CREDENTIALS.imap.host, lookup);
      const user = await cred(DAV_CREDENTIALS.imap.user, lookup);
      const password = await cred(DAV_CREDENTIALS.imap.password, lookup);
      if (!host || !user || !password) continue;
      return mailAccountFromValues({
        host,
        user,
        password,
        smtpHost: await cred(DAV_CREDENTIALS.imap.smtpHost, lookup),
        from: await cred(DAV_CREDENTIALS.imap.from, lookup),
      });
    }
  }
  return undefined;
}

/** Everything in an account the model must never see. */
export function accountSecrets(account: DavAccount | MailAccount): string[] {
  const password = account.password;
  const user = "username" in account ? account.username : account.users[0];
  return [password, user ? Buffer.from(`${user}:${password}`).toString("base64") : undefined].filter((s): s is string => Boolean(s));
}

/** iCloud app-specific passwords look like abcd-efgh-ijkl-mnop. */
export function looksLikeAppSpecificPassword(value: string): boolean {
  return /^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i.test(value.trim());
}
