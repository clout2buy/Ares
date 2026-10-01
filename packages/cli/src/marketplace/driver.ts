// The Marketplace page driver. It is the ONLY code that touches a browser page.
//
// Facebook's DOM changes constantly and none of the selectors below have been
// verified against the live site (the build machine has no Facebook login), so
// the rules are:
//   * the in-page scripts only COLLECT raw material (anchors, innerText, image
//     urls); every interpretation lives in core.ts where it is unit-tested;
//   * every element is found by role / visible text / aria-label with several
//     fallbacks, never by a hashed class name;
//   * nothing the page says is ever executed, followed or logged;
//   * one page, one action at a time, with randomised human pauses.
//
// Walls (login, checkpoint, "temporarily blocked", captcha) are detected by the
// service from the Surface this driver returns. The driver never tries to get
// past one.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { browserSessionFile } from "@ares/core";
import { acquireBrowserPage, findInstalledChromium } from "@ares/connectors";
import type { RawCard, RawListing, RawThread, Surface } from "./core.js";

export type ComposeResult =
  | { ok: true }
  | { ok: false; reason: "no_message_box" | "no_send_button" | "send_disabled" | "type_failed" | "click_failed"; typed: boolean };

export interface MarketplaceDriver {
  /** Navigate and settle; returns what the page looks like now. */
  open(url: string): Promise<Surface>;
  surface(): Promise<Surface>;
  cards(): Promise<RawCard[]>;
  /** Scroll once to load more results. */
  scroll(): Promise<void>;
  listing(): Promise<RawListing>;
  threads(): Promise<RawThread[]>;
  /** Type `text` into the open listing's message box and send it. One attempt. */
  compose(text: string, pace: () => Promise<void>): Promise<ComposeResult>;
  /** How many times `snippet` appears in the visible page text (the message box value is not counted). */
  echoCount(snippet: string): Promise<number>;
  close(): Promise<void>;
}

// ─── In-page scripts (strings; collect only) ─────────────────────────────────

const SURFACE_JS = `(() => {
  const body = document.body;
  const text = ((body && body.innerText) || '').slice(0, 1500);
  const frames = Array.from(document.querySelectorAll('iframe')).map((f) => f.src || '').join(' ').slice(0, 500);
  return {
    url: location.href,
    title: document.title || '',
    text,
    hasPassword: !!document.querySelector('input[type="password"]'),
    hasCaptcha: !!document.querySelector('.g-recaptcha, .h-captcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]'),
    frames,
  };
})()`;

const CARDS_JS = `(() => {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/marketplace/item/"]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/marketplace\\/item\\/(\\d+)/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const img = a.querySelector('img');
    out.push({
      id: m[1],
      href: a.href,
      text: (a.innerText || '').slice(0, 600),
      img: img ? (img.currentSrc || img.src || '') : '',
      alt: img ? (img.alt || '') : '',
      aria: a.getAttribute('aria-label') || '',
    });
    if (out.length >= 80) break;
  }
  return out;
})()`;

const LISTING_JS = `(() => {
  const q = (s) => document.querySelector(s);
  const meta = (p) => { const e = q('meta[property="' + p + '"]'); return e ? (e.content || '') : ''; };
  const main = q('[role="main"]') || document.body;
  const imgs = new Set();
  for (const i of main.querySelectorAll('img')) {
    const s = i.currentSrc || i.src || '';
    if (!/^https:/.test(s)) continue;
    if ((i.naturalWidth || i.width || 0) < 80) continue;
    if (/emoji|static\\.xx|rsrc\\.php|profile/i.test(s)) continue;
    imgs.add(s.split('?')[0]);
  }
  const links = Array.from(document.querySelectorAll('a[href*="/marketplace/profile/"], a[href*="profile.php?id="]'))
    .slice(0, 5)
    .map((a) => ({ href: a.href, text: a.innerText || a.getAttribute('aria-label') || '' }));
  const h1 = q('h1');
  return {
    url: location.href,
    title: document.title || '',
    h1: h1 ? (h1.innerText || '') : '',
    ogTitle: meta('og:title'),
    ogImage: meta('og:image'),
    text: ((main.innerText) || '').slice(0, 20000),
    sellerLinks: links,
    imageCount: imgs.size,
  };
})()`;

const THREADS_JS = `(() => {
  const rows = [];
  const seen = new Set();
  const sel = 'a[href*="/marketplace/inbox/"], a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"], a[href*="/marketplace/t/"], [role="row"] a[role="link"]';
  for (const a of document.querySelectorAll(sel)) {
    const href = a.href || '';
    if (!/(inbox|\\/t)\\/[A-Za-z0-9._-]{4,}/.test(href) || seen.has(href)) continue;
    const t = (a.innerText || '').trim();
    if (!t) continue;
    seen.add(href);
    rows.push({ href, text: t.slice(0, 500) });
    if (rows.length >= 40) break;
  }
  return rows;
})()`;

/**
 * Tag the message box and the send button so the driver can click them with
 * ordinary page.click(). Scoring by label/placeholder/role; visible elements
 * only; the largest box in the main column wins ties.
 */
const FIND_COMPOSER_JS = `(() => {
  const clear = () => document.querySelectorAll('[data-ares-mp]').forEach((e) => e.removeAttribute('data-ares-mp'));
  clear();
  const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 20 && r.height > 12 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const label = (e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('name') || '')).toLowerCase();
  const boxes = Array.from(document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"], input[type="text"]')).filter(visible);
  let best = null, bestScore = -1;
  for (const b of boxes) {
    const l = label(b);
    let s = 0;
    if (/message|seller|reply|write|type|say/.test(l)) s += 3;
    if (b.tagName === 'TEXTAREA') s += 2;
    if (b.closest('[role="dialog"]')) s += 1;
    if (/search|query|comment/.test(l)) s -= 5;
    if (s > bestScore) { best = b; bestScore = s; }
  }
  let box = bestScore >= 1 ? best : null;
  if (box) box.setAttribute('data-ares-mp', 'msgbox');
  const scope = box ? (box.closest('[role="dialog"]') || box.closest('form') || box.parentElement?.parentElement?.parentElement || document.body) : document.body;
  const sendCands = Array.from(scope.querySelectorAll('[role="button"], button, [aria-label], input[type="submit"]')).filter(visible);
  let send = null;
  for (const c of sendCands) {
    const t = ((c.getAttribute('aria-label') || '') + '|' + (c.innerText || c.value || '')).toLowerCase().trim();
    if (/^(send|send message|send seller a message)\\b/.test(t) || /\\|(send|send message)$/.test(t) || /^send\\|/.test(t)) { send = c; break; }
  }
  if (send) send.setAttribute('data-ares-mp', 'send');
  const disabled = send ? (send.getAttribute('aria-disabled') === 'true' || send.disabled === true) : false;
  return { box: !!box, send: !!send, disabled };
})()`;

/** When there is no box yet: tag the button that opens one ("Message", "Message seller"). */
const FIND_OPENER_JS = `(() => {
  document.querySelectorAll('[data-ares-mp="opener"]').forEach((e) => e.removeAttribute('data-ares-mp'));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 12; };
  const cands = Array.from(document.querySelectorAll('[role="button"], button, a[role="button"], [aria-label]')).filter(visible);
  for (const c of cands) {
    const t = ((c.getAttribute('aria-label') || '') + '|' + (c.innerText || '')).toLowerCase().trim();
    if (/(^|\\|)(message|message seller|send message|contact seller|chat with seller)\\s*$/.test(t) || /^message\\|/.test(t)) { c.setAttribute('data-ares-mp', 'opener'); return true; }
  }
  return false;
})()`;

const ECHO_JS = `((snippet) => {
  const norm = (s) => String(s || '').toLowerCase().replace(/\\s+/g, ' ');
  const text = norm(document.body ? document.body.innerText : '');
  const needle = norm(snippet);
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
})`;

// ─── Playwright implementation ───────────────────────────────────────────────

/** The slice of a Playwright Page the driver uses (structural, so tests can fake it). */
export interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate(script: string | ((arg: any) => unknown), arg?: unknown): Promise<any>;
  click(selector: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  waitForLoadState(state?: string, opts?: Record<string, unknown>): Promise<unknown>;
  keyboard: { type(text: string, opts?: { delay?: number }): Promise<unknown>; press(key: string): Promise<unknown> };
  mouse: { wheel(dx: number, dy: number): Promise<unknown> };
}

export interface PlaywrightDriverOptions {
  page: PwPage;
  close: () => Promise<void>;
  /** Replaces https://www.facebook.com (a local fixture server in tests). */
  origin?: string;
  random?: () => number;
}

export class PlaywrightMarketplaceDriver implements MarketplaceDriver {
  private readonly page: PwPage;
  private readonly closer: () => Promise<void>;
  private readonly origin: string | undefined;
  private readonly random: () => number;

  constructor(o: PlaywrightDriverOptions) {
    this.page = o.page;
    this.closer = o.close;
    this.origin = o.origin?.replace(/\/+$/, "");
    this.random = o.random ?? Math.random;
  }

  private map(url: string): string {
    return this.origin ? url.replace(/^https:\/\/www\.facebook\.com/i, this.origin) : url;
  }

  async open(url: string): Promise<Surface> {
    await this.page.goto(this.map(url), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    await this.page.waitForTimeout(600);
    return this.surface();
  }

  async surface(): Promise<Surface> {
    return (await this.page.evaluate(SURFACE_JS)) as Surface;
  }

  async cards(): Promise<RawCard[]> {
    return ((await this.page.evaluate(CARDS_JS)) as RawCard[]) ?? [];
  }

  async scroll(): Promise<void> {
    await this.page.mouse.wheel(0, 1400).catch(() => undefined);
    await this.page.waitForTimeout(900 + Math.floor(this.random() * 800));
  }

  async listing(): Promise<RawListing> {
    return (await this.page.evaluate(LISTING_JS)) as RawListing;
  }

  async threads(): Promise<RawThread[]> {
    return ((await this.page.evaluate(THREADS_JS)) as RawThread[]) ?? [];
  }

  async echoCount(snippet: string): Promise<number> {
    const n = await this.page.evaluate(`(${ECHO_JS})(${JSON.stringify(snippet)})`);
    return Number(n) || 0;
  }

  async compose(text: string, pace: () => Promise<void>): Promise<ComposeResult> {
    let found = (await this.page.evaluate(FIND_COMPOSER_JS)) as { box: boolean; send: boolean; disabled: boolean };
    if (!found.box) {
      // A listing page often shows only a "Message" button until it is pressed.
      const opener = (await this.page.evaluate(FIND_OPENER_JS)) as boolean;
      if (opener) {
        await this.page.click('[data-ares-mp="opener"]', { timeout: 8_000 }).catch(() => undefined);
        await pace();
        found = (await this.page.evaluate(FIND_COMPOSER_JS)) as { box: boolean; send: boolean; disabled: boolean };
      }
    }
    if (!found.box) return { ok: false, reason: "no_message_box", typed: false };
    let typed = false;
    try {
      await this.page.click('[data-ares-mp="msgbox"]', { timeout: 8_000 });
      await pace();
      // Replace whatever Facebook pre-filled ("Is this still available?").
      await this.page.keyboard.press("Control+A");
      await this.page.keyboard.press("Backspace");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) await this.page.keyboard.press("Shift+Enter");
        if (lines[i]) await this.page.keyboard.type(lines[i]!, { delay: 25 + Math.floor(this.random() * 55) });
        typed = true;
      }
    } catch {
      return { ok: false, reason: "type_failed", typed };
    }
    await pace();
    // The button is only enabled once there is text, so look again.
    found = (await this.page.evaluate(FIND_COMPOSER_JS)) as { box: boolean; send: boolean; disabled: boolean };
    if (!found.box) return { ok: false, reason: "no_message_box", typed };
    if (found.send && found.disabled) return { ok: false, reason: "send_disabled", typed };
    try {
      if (found.send) await this.page.click('[data-ares-mp="send"]', { timeout: 8_000 });
      else await this.page.keyboard.press("Enter");
    } catch {
      return { ok: false, reason: "click_failed", typed };
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    await this.closer().catch(() => undefined);
  }
}

// ─── Real browser ────────────────────────────────────────────────────────────

/** playwright is a dependency of @ares/connectors, not of this package: resolve it from there so pnpm's strict node_modules still finds it. */
async function importPlaywright(): Promise<any> {
  const moduleName = "playwright";
  try {
    return await import(moduleName);
  } catch (first) {
    try {
      const here = createRequire(import.meta.url);
      const viaConnectors = createRequire(here.resolve("@ares/connectors")).resolve(moduleName);
      return await import(pathToFileURL(viaConnectors).href);
    } catch {
      throw first;
    }
  }
}

/** The sign-in cookies the owner saved on the phone, restricted to facebook.com. */
async function savedFacebookCookies(home: string | undefined): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const id of ["facebook-marketplace", "facebook"]) {
    try {
      const state = JSON.parse(await fs.readFile(browserSessionFile(id, home), "utf8")) as { cookies?: Array<Record<string, unknown>> };
      for (const c of state.cookies ?? []) if (typeof c.domain === "string" && /(^|\.)facebook\.com$/i.test(c.domain.replace(/^\./, ""))) out.push(c);
    } catch {
      // not connected through this id
    }
  }
  return out;
}

/**
 * Launch Ares's own browser (its own profile, never the owner's real one and
 * never the Browser tool's profile, so the two cannot fight over a lock) and
 * load the saved Facebook sign-in into it.
 */
export async function openPlaywrightDriver(opts: { home?: string; loadPlaywright?: () => Promise<any> } = {}): Promise<MarketplaceDriver> {
  const pw = opts.loadPlaywright ? await opts.loadPlaywright() : await importPlaywright();
  const home = opts.home ?? process.env.ARES_HOME ?? path.join(os.homedir(), ".ares");
  const acquired = await acquireBrowserPage(pw, {
    discovery: false,
    executablePath: findInstalledChromium(),
    headless: true,
    userDataDir: path.join(home, "marketplace-profile"),
    viewport: { width: 1280, height: 900 },
  });
  const cookies = await savedFacebookCookies(opts.home);
  if (cookies.length) await acquired.page.context().addCookies(cookies).catch(() => undefined);
  return new PlaywrightMarketplaceDriver({ page: acquired.page, close: acquired.close });
}

