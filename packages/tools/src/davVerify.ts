// Live, read-only verification for the DAV / IMAP connect forms.
//
// The connect hub calls these BEFORE anything is stored: a wrong password,
// a normal Apple ID password where an app-specific one is required, a mistyped
// host or a server that is not CalDAV fails on the owner's phone form with a
// sentence they can act on, not three turns later in a tool call.
//
// Each verifier performs a real login and discovery (CalDAV principal and
// calendar-home-set, CardDAV address books, IMAP LIST, an SMTP connect+AUTH
// that sends nothing) and returns { detail, store }. Thrown errors are always
// DavErrors: human, classified and scrubbed of every secret. The probes are
// injectable so the classification and wiring tests need no network.

import { DAV_CREDENTIALS } from "@ares/core";
import {
  DavError,
  ICLOUD_CALDAV_URL,
  ICLOUD_CARDDAV_URL,
  accountSecrets,
  assertSafeDavUrl,
  classifyError,
  looksLikeAppSpecificPassword,
  mailAccountFromValues,
  redact,
  type DavAccount,
  type MailAccount,
} from "./davCommon.js";
import { probeDav, type DavProbe } from "./davClient.js";
import { probeMail, type MailProbe } from "./imapClient.js";

export interface DavVerifyOutcome {
  detail: string;
  store: Record<string, string>;
}

export interface DavProbes {
  dav: (type: "caldav" | "carddav", account: DavAccount) => Promise<DavProbe>;
  mail: (account: MailAccount, signal?: AbortSignal) => Promise<MailProbe>;
}

const REAL_PROBES: DavProbes = { dav: probeDav, mail: probeMail };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function names(list: string[]): string {
  return list.length ? ` (${list.slice(0, 5).join(", ")}${list.length > 5 ? ", …" : ""})` : "";
}

function need(values: Record<string, string>, key: string, label: string): string {
  const v = (values[key] ?? "").trim();
  if (!v) throw new DavError("auth", `${label} is required.`);
  return v;
}

function scrub(err: unknown, secrets: string[], service: "CalDAV" | "CardDAV" | "IMAP" | "SMTP", host?: string, provider?: string): DavError {
  const c = classifyError(err, { service, ...(host ? { host } : {}), ...(provider ? { provider } : {}), secrets });
  return new DavError(c.kind, redact(c.message, secrets));
}

function calDetail(p: DavProbe): string {
  if (p.collections === 0) return "";
  return `${plural(p.collections, "calendar")}${names(p.names)}${p.reminderLists ? `, ${plural(p.reminderLists, "reminder list")}` : ""}`;
}

export async function verifyCalDav(values: Record<string, string>, probes: DavProbes = REAL_PROBES): Promise<DavVerifyOutcome> {
  const url = need(values, DAV_CREDENTIALS.caldav.url, "The server address");
  const username = need(values, DAV_CREDENTIALS.caldav.user, "The username");
  const password = need(values, DAV_CREDENTIALS.caldav.password, "The password");
  const base = assertSafeDavUrl(url);
  const account: DavAccount = { id: "caldav", serverUrl: base.href, username, password };
  let probe: DavProbe;
  try {
    probe = await probes.dav("caldav", account);
  } catch (err) {
    throw scrub(err, accountSecrets(account), "CalDAV", base.hostname);
  }
  if (probe.collections === 0) throw new DavError("not-found", `Logged in to ${base.hostname}, but the account has no calendars.`);
  return {
    detail: `CalDAV login works: ${calDetail(probe)}.`,
    store: { [DAV_CREDENTIALS.caldav.url]: base.href, [DAV_CREDENTIALS.caldav.user]: username, [DAV_CREDENTIALS.caldav.password]: password },
  };
}

export async function verifyCardDav(values: Record<string, string>, probes: DavProbes = REAL_PROBES): Promise<DavVerifyOutcome> {
  const url = need(values, DAV_CREDENTIALS.carddav.url, "The server address");
  const username = need(values, DAV_CREDENTIALS.carddav.user, "The username");
  const password = need(values, DAV_CREDENTIALS.carddav.password, "The password");
  const base = assertSafeDavUrl(url);
  const account: DavAccount = { id: "carddav", serverUrl: base.href, username, password };
  let probe: DavProbe;
  try {
    probe = await probes.dav("carddav", account);
  } catch (err) {
    throw scrub(err, accountSecrets(account), "CardDAV", base.hostname);
  }
  if (probe.collections === 0) throw new DavError("not-found", `Logged in to ${base.hostname}, but the account has no address books.`);
  return {
    detail: `CardDAV login works: ${plural(probe.collections, "address book")}${names(probe.names)}.`,
    store: { [DAV_CREDENTIALS.carddav.url]: base.href, [DAV_CREDENTIALS.carddav.user]: username, [DAV_CREDENTIALS.carddav.password]: password },
  };
}

export async function verifyImap(values: Record<string, string>, signal?: AbortSignal, probes: DavProbes = REAL_PROBES): Promise<DavVerifyOutcome> {
  const host = need(values, DAV_CREDENTIALS.imap.host, "The IMAP server");
  const user = need(values, DAV_CREDENTIALS.imap.user, "The username");
  const password = need(values, DAV_CREDENTIALS.imap.password, "The password");
  if (/\s/.test(host)) throw new DavError("unreachable", "The IMAP server must be a host name like imap.example.com, with no spaces.");
  const smtpHost = (values[DAV_CREDENTIALS.imap.smtpHost] ?? "").trim();
  const from = (values[DAV_CREDENTIALS.imap.from] ?? "").trim();
  if (from && !EMAIL_RE.test(from)) throw new DavError("auth", "The send-as address is not an email address.");
  const account = mailAccountFromValues({ host, user, password, ...(smtpHost ? { smtpHost } : {}), ...(from ? { from } : {}) });
  let probe: MailProbe;
  try {
    probe = await probes.mail(account, signal);
  } catch (err) {
    throw scrub(err, [password], "IMAP", account.imap.host);
  }
  const sendNote = probe.smtpProblem
    ? ` Sending is NOT available yet: ${probe.smtpProblem}`
    : account.from
      ? ` Sending works (as ${account.from}).`
      : " Sending needs a send-as address (your username is not an email address).";
  const store: Record<string, string> = { [DAV_CREDENTIALS.imap.host]: host, [DAV_CREDENTIALS.imap.user]: user, [DAV_CREDENTIALS.imap.password]: password };
  if (smtpHost) store[DAV_CREDENTIALS.imap.smtpHost] = smtpHost;
  if (from) store[DAV_CREDENTIALS.imap.from] = from;
  return { detail: `IMAP login works: ${plural(probe.folders, "folder")}${probe.hasNotes ? ", including a Notes folder" : ""}.${sendNote}`, store };
}

/** iCloud: one Apple ID + app-specific password for Calendar, Reminders,
 *  Contacts and Mail. Succeeds when at least the calendar (or contacts, or
 *  mail) login works; says plainly which parts did not. */
export async function verifyIcloud(values: Record<string, string>, signal?: AbortSignal, probes: DavProbes = REAL_PROBES): Promise<DavVerifyOutcome> {
  const appleId = need(values, DAV_CREDENTIALS.icloud.appleId, "The Apple ID");
  const password = need(values, DAV_CREDENTIALS.icloud.appPassword, "The app-specific password");
  const mailAddress = (values[DAV_CREDENTIALS.icloud.mailAddress] ?? "").trim();
  if (!EMAIL_RE.test(appleId)) throw new DavError("auth", "The Apple ID is the email address you sign in to iCloud with, like you@icloud.com.");
  if (mailAddress && !EMAIL_RE.test(mailAddress)) throw new DavError("auth", "The iCloud Mail address is not an email address.");
  // Apple only accepts app-specific passwords on these servers. Catch the
  // common mistake (the normal Apple ID password) before any request is made.
  if (!looksLikeAppSpecificPassword(password)) {
    throw new DavError(
      "app-password",
      "That does not look like an app-specific password. Apple does not accept your normal Apple ID password here. At account.apple.com open Sign-In and Security, then App-Specific Passwords, create one named Ares, and paste the xxxx-xxxx-xxxx-xxxx value.",
    );
  }
  const cal: DavAccount = { id: "icloud", serverUrl: ICLOUD_CALDAV_URL, username: appleId, password };
  const card: DavAccount = { id: "icloud", serverUrl: ICLOUD_CARDDAV_URL, username: appleId, password };
  const secrets = accountSecrets(cal);
  const mail: MailAccount = {
    id: "icloud",
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    users: [...new Set([appleId, ...(/@(icloud\.com|me\.com|mac\.com)$/i.test(appleId) ? [appleId.split("@")[0]!] : []), ...(mailAddress ? [mailAddress] : [])])],
    smtpUser: mailAddress || appleId,
    password,
    from: mailAddress || (/@(icloud\.com|me\.com|mac\.com)$/i.test(appleId) ? appleId : ""),
  };
  const [calR, cardR, mailR] = await Promise.allSettled([probes.dav("caldav", cal), probes.dav("carddav", card), probes.mail(mail, signal)]);

  const parts: string[] = [];
  const problems: DavError[] = [];
  const note = (label: string, r: PromiseSettledResult<unknown>, service: "CalDAV" | "CardDAV" | "IMAP", describe: (v: never) => string): void => {
    if (r.status === "fulfilled") parts.push(`${label}: ${describe(r.value as never)}`);
    else {
      const e = scrub(r.reason, secrets, service, undefined, "icloud");
      problems.push(e);
      parts.push(`${label}: not available (${e.message.split(". ")[0]})`);
    }
  };
  note("Calendar and Reminders", calR, "CalDAV", (p: DavProbe) => `${plural(p.collections, "calendar")}${p.reminderLists ? `, ${plural(p.reminderLists, "reminder list")}` : ""}`);
  note("Contacts", cardR, "CardDAV", (p: DavProbe) => plural(p.collections, "address book"));
  note("Mail", mailR, "IMAP", (p: MailProbe) => `${plural(p.folders, "folder")}${p.hasNotes ? ", Notes folder found" : ""}${p.smtpProblem ? `; sending unavailable (${p.smtpProblem.split(". ")[0]})` : mail.from ? "; sending works" : "; sending needs your iCloud Mail address"}`);

  if (problems.length === 3) {
    // Everything failed: a login problem beats a network one for the message.
    const login = problems.find((p) => p.kind === "app-password" || p.kind === "auth");
    throw login ?? problems[0]!;
  }
  // Wrong credentials show up on every protocol; one success means they are fine.
  return {
    detail: `${parts.join(". ")}.`,
    store: {
      [DAV_CREDENTIALS.icloud.appleId]: appleId,
      [DAV_CREDENTIALS.icloud.appPassword]: password,
      ...(mailAddress ? { [DAV_CREDENTIALS.icloud.mailAddress]: mailAddress } : {}),
    },
  };
}
