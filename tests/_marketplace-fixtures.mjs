// Shared fixtures for the Marketplace tests: a scripted in-memory driver (no
// browser), a controllable clock, and service construction with a throwaway home.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MarketplaceService } from "../packages/cli/dist/marketplace/service.js";

export const OK_SURFACE = { url: "https://www.facebook.com/marketplace/search", title: "Marketplace", text: "Marketplace\nFilters", hasPassword: false, hasCaptcha: false };

export function listingRaw(id, o = {}) {
  const title = o.title ?? `Item ${id}`;
  const seller = o.seller ?? "Dana Rivers";
  const sellerId = o.sellerId ?? "555000";
  return {
    url: `https://www.facebook.com/marketplace/item/${id}/`,
    title: `${title} | Facebook Marketplace`,
    h1: title,
    text: [title, o.price ?? "$150", "Listed 3 days ago in Austin, TX", "Condition", "Used - Good", "Description", o.description ?? "Nice item.", "Seller information", "Seller details", seller].join("\n"),
    sellerLinks: [{ href: `https://www.facebook.com/marketplace/profile/${sellerId}/`, text: seller }],
    imageCount: 3,
  };
}

/** A scripted page driver. `script` can be changed between calls. */
export class FakeDriver {
  constructor(script = {}) {
    this.script = script;
    this.opened = [];
    this.thread = [];
    this.composeCalls = [];
    this.closed = false;
    this.active = 0;
    this.maxActive = 0;
    this.url = "";
  }
  async enter() {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setImmediate(r));
  }
  leave() {
    this.active--;
  }
  async open(url) {
    await this.enter();
    try {
      this.opened.push(url);
      this.url = url;
      const s = this.script.surface?.(url, this);
      return s ?? { ...OK_SURFACE, url };
    } finally {
      this.leave();
    }
  }
  async surface() {
    return { ...OK_SURFACE, url: this.url };
  }
  async cards() {
    return this.script.cards?.(this.url) ?? [];
  }
  async scroll() {}
  async listing() {
    const id = /item\/(\d+)/.exec(this.url)?.[1];
    return this.script.listing ? this.script.listing(id, this) : listingRaw(id);
  }
  async threads() {
    return this.script.threads?.(this) ?? [];
  }
  async compose(text, pace) {
    await pace();
    this.composeCalls.push(text);
    if (this.script.noBox) return { ok: false, reason: "no_message_box", typed: false };
    if (this.script.typedNotSent) return { ok: false, reason: "click_failed", typed: true };
    if (this.script.echo !== false) this.thread.push(text);
    return { ok: true };
  }
  async echoCount(snippet) {
    const needle = snippet.toLowerCase().replace(/\s+/g, " ");
    return this.thread.filter((t) => t.toLowerCase().replace(/\s+/g, " ").includes(needle)).length;
  }
  async close() {
    this.closed = true;
  }
}

export function makeClock(start = Date.UTC(2026, 9, 1, 12, 0, 0)) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; } };
  return clock;
}

/** A service wired to a FakeDriver, a fake clock and recorders. */
export async function makeService(o = {}) {
  const home = o.home ?? (await mkdtemp(path.join(tmpdir(), "ares-mp-")));
  const clock = o.clock ?? makeClock();
  const driver = o.driver ?? new FakeDriver();
  const sleeps = [];
  const pushes = [];
  const audits = [];
  const state = { paused: false, connected: true, mtimeMs: clock.t - 86_400_000, opened: 0 };
  const service = new MarketplaceService({
    home,
    now: clock.now,
    random: o.random ?? (() => 0.5),
    sleep: async (ms) => { sleeps.push(ms); },
    openDriver: async () => { state.opened++; return driver; },
    push: async (m) => { pushes.push(m); },
    isPaused: () => state.paused,
    sessionInfo: async () => ({ connected: state.connected, mtimeMs: state.mtimeMs }),
    audit: async (e) => { audits.push(e); },
    limits: o.limits ?? {},
  });
  return { service, driver, clock, sleeps, pushes, audits, state, home };
}

export const card = (id, title, price = "$100", loc = "Austin, TX") => ({ href: `https://www.facebook.com/marketplace/item/${id}/`, text: `${price}\n${title}\n${loc}`, img: "https://scontent.example/x.jpg" });
