// The CalDAV / CardDAV transport for the Calendar and Contacts tools.
//
// Library: tsdav (MIT) does the protocol work: service discovery
// (/.well-known, current-user-principal, calendar-home-set), PROPFIND /
// REPORT / PUT / DELETE and the XML. Everything around it is ours: the fetch
// it runs on (timeouts, size caps, credentials never leave the configured
// domain: davCommon.boundedFetch), discovery caching, id validation, and
// error classification. The tools talk to the small Backend interfaces below,
// not to tsdav, which is what lets the unit tests run against fakes.
//
// Object ids handed to the model are the object's full URL. A model (or a
// prompt injected into an email) could try to smuggle in a URL that is not on
// the owner's server, so `inside()` refuses any id that is not under one of
// the account's own collections before a single request is made.

import type { DAVAccount } from "tsdav";
import {
  DAV_LIMITS,
  DavError,
  accountSecrets,
  assertSafeDavUrl,
  boundedFetch,
  classifyError,
  classifyHttpStatus,
  type DavAccount,
  type ErrorContext,
} from "./davCommon.js";

export interface CalendarInfo {
  url: string;
  name: string;
  /** VEVENT and/or VTODO. */
  components: string[];
  description?: string;
  color?: string;
}

export interface DavObject {
  url: string;
  etag?: string;
  data: string;
}

export interface CalendarBackend {
  listCalendars(): Promise<CalendarInfo[]>;
  /** Objects of one kind in a calendar. `range` is a server-side time filter
   *  (the tool re-filters; servers differ); `uid` narrows to one event. */
  fetchObjects(cal: CalendarInfo, q: { kind: "VEVENT" | "VTODO"; range?: { start: Date; end: Date }; uid?: string; pendingOnly?: boolean }): Promise<DavObject[]>;
  getObject(url: string): Promise<DavObject | undefined>;
  create(cal: CalendarInfo, filename: string, ics: string): Promise<{ url: string; etag?: string }>;
  update(obj: DavObject): Promise<{ etag?: string }>;
  remove(obj: DavObject): Promise<void>;
}

export interface BookInfo {
  url: string;
  name: string;
}

export interface ContactsBackend {
  listBooks(): Promise<BookInfo[]>;
  /** Cards in a book. `query` is a server-side text filter (tool re-filters). */
  fetchCards(book: BookInfo, q: { query?: string; uid?: string }): Promise<DavObject[]>;
  getObject(url: string): Promise<DavObject | undefined>;
  create(book: BookInfo, filename: string, vcf: string): Promise<{ url: string; etag?: string }>;
  update(obj: DavObject): Promise<{ etag?: string }>;
  remove(obj: DavObject): Promise<void>;
}

/** Test seams: replace the real network backends. Production leaves these unset. */
export const davSeams: {
  calendarBackend?: (account: DavAccount) => CalendarBackend;
  contactsBackend?: (account: DavAccount) => ContactsBackend;
} = {};

// ─── discovery cache ─────────────────────────────────────────────────────────

const DISCOVERY_TTL_MS = 10 * 60_000;
const discovered = new Map<string, { at: number; account: DAVAccount }>();

function cacheKey(type: string, account: DavAccount): string {
  return `${type}|${account.serverUrl}|${account.username}|${account.password.length}|${account.password.slice(0, 2)}${account.password.slice(-2)}`;
}

export function clearDavDiscoveryCache(): void {
  discovered.clear();
}

function ctxFor(service: ErrorContext["service"], account: DavAccount): ErrorContext {
  let host: string | undefined;
  try {
    host = new URL(account.serverUrl.includes("://") ? account.serverUrl : `https://${account.serverUrl}`).hostname;
  } catch {
    host = undefined;
  }
  return { service, ...(host ? { host } : {}), provider: account.id, secrets: accountSecrets(account) };
}

interface Session {
  tsdav: typeof import("tsdav");
  dav: DAVAccount;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  ctx: ErrorContext;
}

async function session(type: "caldav" | "carddav", account: DavAccount): Promise<Session> {
  const ctx = ctxFor(type === "caldav" ? "CalDAV" : "CardDAV", account);
  try {
    const base = assertSafeDavUrl(account.serverUrl);
    const tsdav = await import("tsdav");
    const credentials = { username: account.username, password: account.password };
    const headers = tsdav.getBasicAuthHeaders(credentials) as Record<string, string>;
    const fetchImpl = boundedFetch({ base, secrets: ctx.secrets });
    const key = cacheKey(type, account);
    const hit = discovered.get(key);
    if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return { tsdav, dav: hit.account, headers, fetchImpl, ctx };
    const dav = await tsdav.createAccount({
      account: { serverUrl: base.href, credentials, accountType: type },
      headers,
      loadCollections: false,
      loadObjects: false,
      fetch: fetchImpl,
    });
    discovered.set(key, { at: Date.now(), account: dav });
    return { tsdav, dav, headers, fetchImpl, ctx };
  } catch (err) {
    throw classifyError(err, ctx);
  }
}

/** Run one operation with error classification; a login failure drops the
 *  cached discovery so a fixed password is picked up next call. */
async function guarded<T>(type: "caldav" | "carddav", account: DavAccount, run: (s: Session) => Promise<T>): Promise<T> {
  const s = await session(type, account);
  try {
    return await run(s);
  } catch (err) {
    const classified = classifyError(err, s.ctx);
    if (classified.kind === "auth" || classified.kind === "app-password") discovered.delete(cacheKey(type, account));
    throw classified;
  }
}

function checkOk(res: { ok: boolean; status: number }, ctx: ErrorContext, what: string): void {
  if (res.ok) return;
  if (res.status === 412) throw new DavError("server", `${what} failed: it was changed on the server since it was read. Read it again and retry.`);
  if (res.status === 409) throw new DavError("server", `${what} failed: the server reports a conflict (HTTP 409); the calendar or address book may not accept this item type.`);
  if (res.status === 507 || res.status === 413) throw new DavError("server", `${what} failed: the server says it is out of space or the item is too large (HTTP ${res.status}).`);
  throw classifyHttpStatus(res.status, ctx);
}

/** Is `url` the collection itself or something inside it? */
export function inside(collectionUrl: string, url: string): boolean {
  try {
    const c = new URL(collectionUrl);
    const u = new URL(url, c);
    if (c.origin !== u.origin && c.hostname !== u.hostname) {
      // Same-domain hop (caldav.icloud.com vs p12-caldav.icloud.com) is not enough for ids: must be the same origin.
      return false;
    }
    const cp = c.pathname.endsWith("/") ? c.pathname : `${c.pathname}/`;
    return u.pathname.startsWith(cp) && u.pathname.length > cp.length;
  } catch {
    return false;
  }
}

async function httpGet(s: Session, url: string): Promise<DavObject | undefined> {
  const res = await s.fetchImpl(url, { method: "GET", headers: { ...s.headers, accept: "text/calendar, text/vcard, text/plain, */*" } });
  if (res.status === 404 || res.status === 410) return undefined;
  checkOk(res, s.ctx, "Reading the item");
  return { url, etag: res.headers.get("etag") ?? undefined, data: await res.text() };
}

function trimDisplay(name: unknown, fallback: string): string {
  const text = typeof name === "string" ? name.trim() : "";
  return text || fallback;
}

// ─── CalDAV backend ──────────────────────────────────────────────────────────

function lastSegment(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] ?? "calendar");
  } catch {
    return "calendar";
  }
}

export function realCalendarBackend(account: DavAccount): CalendarBackend {
  return {
    async listCalendars() {
      return guarded("caldav", account, async (s) => {
        const cals = await s.tsdav.fetchCalendars({ account: s.dav, headers: s.headers, fetch: s.fetchImpl });
        return cals.slice(0, DAV_LIMITS.maxCalendars).map((c) => ({
          url: c.url,
          name: trimDisplay(c.displayName, lastSegment(c.url)),
          components: (c.components ?? []).map((x) => String(x).toUpperCase()),
          ...(typeof c.description === "string" && c.description ? { description: c.description.slice(0, 200) } : {}),
          ...(typeof c.calendarColor === "string" && c.calendarColor ? { color: c.calendarColor } : {}),
        }));
      });
    },
    async fetchObjects(cal, q) {
      return guarded("caldav", account, async (s) => {
        const compFilter: Record<string, unknown> = { _attributes: { name: q.kind } };
        if (q.range) {
          const z = (d: Date) => `${d.toISOString().slice(0, 19).replace(/[-:.]/g, "")}Z`;
          compFilter["time-range"] = { _attributes: { start: z(q.range.start), end: z(q.range.end) } };
        }
        if (q.uid) {
          compFilter["prop-filter"] = { _attributes: { name: "UID" }, "text-match": { _attributes: { collation: "i;octet" }, _text: q.uid } };
        } else if (q.kind === "VTODO" && q.pendingOnly) {
          compFilter["prop-filter"] = { _attributes: { name: "COMPLETED" }, "is-not-defined": {} };
        }
        const filters = [{ "comp-filter": { _attributes: { name: "VCALENDAR" }, "comp-filter": compFilter } }];
        const objects = await s.tsdav.fetchCalendarObjects({
          calendar: { url: cal.url } as never,
          filters: filters as never,
          urlFilter: (url: string) => Boolean(url) && !url.endsWith("/"),
          headers: s.headers,
          fetch: s.fetchImpl,
        });
        return objects
          .filter((o) => typeof o.data === "string" && o.data.length > 0)
          .slice(0, DAV_LIMITS.maxEvents * 10)
          .map((o) => ({ url: o.url, ...(o.etag ? { etag: o.etag } : {}), data: String(o.data) }));
      });
    },
    async getObject(url) {
      return guarded("caldav", account, (s) => httpGet(s, url));
    },
    async create(cal, filename, ics) {
      return guarded("caldav", account, async (s) => {
        const res = await s.tsdav.createCalendarObject({ calendar: { url: cal.url } as never, filename, iCalString: ics, headers: s.headers, fetch: s.fetchImpl });
        checkOk(res, s.ctx, "Saving the item");
        return { url: new URL(filename, cal.url.endsWith("/") ? cal.url : `${cal.url}/`).href, etag: res.headers.get("etag") ?? undefined };
      });
    },
    async update(obj) {
      return guarded("caldav", account, async (s) => {
        const res = await s.tsdav.updateCalendarObject({ calendarObject: { url: obj.url, data: obj.data, etag: obj.etag } as never, headers: s.headers, fetch: s.fetchImpl });
        checkOk(res, s.ctx, "Saving the change");
        return { etag: res.headers.get("etag") ?? undefined };
      });
    },
    async remove(obj) {
      return guarded("caldav", account, async (s) => {
        const res = await s.tsdav.deleteCalendarObject({ calendarObject: { url: obj.url, etag: obj.etag } as never, headers: s.headers, fetch: s.fetchImpl });
        if (res.status === 404 || res.status === 410) throw new DavError("not-found", "That item no longer exists on the server.");
        checkOk(res, s.ctx, "Deleting the item");
      });
    },
  };
}

// ─── CardDAV backend ─────────────────────────────────────────────────────────

/** Properties worth asking for: everything except PHOTO and other blobs. */
const CARD_PROPS = ["VERSION", "UID", "FN", "N", "EMAIL", "TEL", "ORG", "TITLE", "ADR", "BDAY", "URL", "NOTE", "NICKNAME"];

export function realContactsBackend(account: DavAccount): ContactsBackend {
  return {
    async listBooks() {
      return guarded("carddav", account, async (s) => {
        const books = await s.tsdav.fetchAddressBooks({ account: s.dav, headers: s.headers, fetch: s.fetchImpl });
        return books.slice(0, DAV_LIMITS.maxCalendars).map((b) => ({ url: b.url, name: trimDisplay(b.displayName, lastSegment(b.url)) }));
      });
    },
    async fetchCards(book, q) {
      return guarded("carddav", account, async (s) => {
        const props = {
          "d:getetag": {},
          "card:address-data": { "card:prop": CARD_PROPS.map((name) => ({ _attributes: { name } })) },
        };
        let filters: Record<string, unknown> | undefined;
        if (q.uid) {
          filters = { _attributes: { test: "anyof" }, "prop-filter": [{ _attributes: { name: "UID" }, "text-match": { _attributes: { "match-type": "equals" }, _text: q.uid } }] };
        } else if (q.query) {
          const text = (name: string) => ({ _attributes: { name }, "text-match": { _attributes: { collation: "i;unicode-casemap", "match-type": "contains" }, _text: q.query } });
          filters = { _attributes: { test: "anyof" }, "prop-filter": ["FN", "EMAIL", "TEL", "ORG", "NICKNAME"].map(text) };
        }
        const res = await s.tsdav.addressBookQuery({ url: book.url, props: props as never, ...(filters ? { filters: filters as never } : {}), depth: "1", headers: s.headers, fetch: s.fetchImpl });
        const failed = res.find((r) => !r.ok && r.status >= 400 && !r.props);
        if (failed && res.length === 1) {
          // A server that rejects the filter: retry unfiltered with a bounded read.
          if (filters && failed.status !== 401 && failed.status !== 403) {
            const again = await s.tsdav.addressBookQuery({ url: book.url, props: props as never, depth: "1", headers: s.headers, fetch: s.fetchImpl });
            return cardsFrom(again, book.url);
          }
          throw classifyHttpStatus(failed.status, s.ctx);
        }
        return cardsFrom(res, book.url);
      });
    },
    async getObject(url) {
      return guarded("carddav", account, (s) => httpGet(s, url));
    },
    async create(book, filename, vcf) {
      return guarded("carddav", account, async (s) => {
        const res = await s.tsdav.createVCard({ addressBook: { url: book.url } as never, filename, vCardString: vcf, headers: s.headers, fetch: s.fetchImpl });
        checkOk(res, s.ctx, "Saving the contact");
        return { url: new URL(filename, book.url.endsWith("/") ? book.url : `${book.url}/`).href, etag: res.headers.get("etag") ?? undefined };
      });
    },
    async update(obj) {
      return guarded("carddav", account, async (s) => {
        const res = await s.tsdav.updateVCard({ vCard: { url: obj.url, data: obj.data, etag: obj.etag } as never, headers: s.headers, fetch: s.fetchImpl });
        checkOk(res, s.ctx, "Saving the contact");
        return { etag: res.headers.get("etag") ?? undefined };
      });
    },
    async remove(obj) {
      return guarded("carddav", account, async (s) => {
        const res = await s.tsdav.deleteVCard({ vCard: { url: obj.url, etag: obj.etag } as never, headers: s.headers, fetch: s.fetchImpl });
        if (res.status === 404 || res.status === 410) throw new DavError("not-found", "That contact no longer exists on the server.");
        checkOk(res, s.ctx, "Deleting the contact");
      });
    },
  };
}

interface RawResponse {
  href?: string;
  ok: boolean;
  status: number;
  props?: Record<string, unknown>;
}

function cardsFrom(responses: RawResponse[], bookUrl: string): DavObject[] {
  const out: DavObject[] = [];
  for (const r of responses) {
    const data = (r.props?.addressData as { _cdata?: string } | string | undefined);
    const text = typeof data === "string" ? data : data?._cdata;
    if (!r.href || typeof text !== "string" || !text.includes("BEGIN:VCARD")) continue;
    const etag = r.props?.getetag;
    out.push({ url: new URL(r.href, bookUrl.endsWith("/") ? bookUrl : `${bookUrl}/`).href, ...(etag != null ? { etag: String(etag) } : {}), data: text });
    if (out.length >= DAV_LIMITS.maxContacts * 20) break;
  }
  return out;
}

export function calendarBackendFor(account: DavAccount): CalendarBackend {
  return (davSeams.calendarBackend ?? realCalendarBackend)(account);
}

export function contactsBackendFor(account: DavAccount): ContactsBackend {
  return (davSeams.contactsBackend ?? realContactsBackend)(account);
}

// ─── verification (connect hub) ──────────────────────────────────────────────

export interface DavProbe {
  collections: number;
  names: string[];
  /** Calendars only: how many hold reminders (VTODO). */
  reminderLists?: number;
}

/** A real, read-only login + discovery. Throws a DavError with a human message. */
export async function probeDav(type: "caldav" | "carddav", account: DavAccount): Promise<DavProbe> {
  clearDavDiscoveryCache();
  if (type === "caldav") {
    const cals = await realCalendarBackend(account).listCalendars();
    return { collections: cals.length, names: cals.map((c) => c.name).slice(0, 8), reminderLists: cals.filter((c) => c.components.includes("VTODO")).length };
  }
  const books = await realContactsBackend(account).listBooks();
  return { collections: books.length, names: books.map((b) => b.name).slice(0, 8) };
}
