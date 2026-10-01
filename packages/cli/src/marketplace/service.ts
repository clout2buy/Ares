// The Marketplace service: every rule that is not "how to read a Facebook page".
//
//   * one browser page, one action at a time (a queue), human-paced;
//   * a global pages-per-hour budget and a sends-per-hour cap, a per-seller
//     cap of one NEW conversation per day, all counted in a ledger on disk;
//   * ARES_MARKETPLACE=0 kills every action; the owner's pause holds them too;
//   * a wall (login / checkpoint / "temporarily blocked" / captcha) stops
//     everything and starts a cooldown, never a workaround;
//   * a message is typed only from an owner-approved, immutable draft, once,
//     and success is reported only after it is read back in the thread;
//   * every action, allowed or refused, lands in the audit trail.
//
// The page work itself is the driver's (driver.ts); parsing and walls are in core.ts.

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { appendAudit, browserSessionFile, ownerPause } from "@ares/core";
import {
  INBOX_URL,
  clean,
  detectWall,
  listingUrl,
  normalizeListingTarget,
  normalizeMessage,
  parseCards,
  parseListing,
  parseThreads,
  priceNumber,
  scrubSecrets,
  searchUrl,
  sellerKey,
  squash,
  wallMessage,
  type Conversation,
  type Listing,
  type ListingDetail,
  type SearchParams,
  type Wall,
} from "./core.js";
import { openPlaywrightDriver, type MarketplaceDriver } from "./driver.js";
import { MarketplaceStore, type Draft, type Watch, type WatchFilters } from "./store.js";

export type MarketplaceErrorCode = "disabled" | "paused" | "not_connected" | "wall" | "budget" | "cap" | "invalid" | "not_found" | "not_approved" | "mismatch" | "failed";

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Limits {
  pagesPerHour: number;
  sendsPerHour: number;
  sendsPerSellerPerDay: number;
  minWatchMinutes: number;
  maxWatches: number;
  idleCloseMs: number;
  paceMinMs: number;
  paceMaxMs: number;
  approvalTtlMs: number;
  draftTtlMs: number;
  cooldownMs: { blocked: number; checkpoint: number; captcha: number };
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function defaultLimits(): Limits {
  return {
    pagesPerHour: envInt("ARES_MARKETPLACE_PAGES_PER_HOUR", 40),
    sendsPerHour: envInt("ARES_MARKETPLACE_SENDS_PER_HOUR", 6),
    sendsPerSellerPerDay: 1,
    minWatchMinutes: 30,
    maxWatches: 10,
    idleCloseMs: 90_000,
    paceMinMs: 1_000,
    paceMaxMs: 4_000,
    approvalTtlMs: 30 * 60_000,
    draftTtlMs: 2 * 3_600_000,
    cooldownMs: { blocked: 12 * 3_600_000, checkpoint: 12 * 3_600_000, captcha: 6 * 3_600_000 },
  };
}

/** The kill switch. Read on every call so flipping it takes effect immediately. */
export function marketplaceEnabled(): boolean {
  const raw = (process.env.ARES_MARKETPLACE ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

export interface PushLike {
  (message: { title: string; body: string; data?: Record<string, unknown> }): Promise<unknown>;
}

export interface MarketplaceDeps {
  home?: string;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  openDriver?: () => Promise<MarketplaceDriver>;
  push?: PushLike;
  isPaused?: () => boolean;
  /** Is a Facebook sign-in saved, and when was it last saved? */
  sessionInfo?: () => Promise<{ connected: boolean; mtimeMs?: number }>;
  audit?: (entry: { actor: string; action: string; target?: string; params?: unknown; result?: string; sessionId?: string }) => Promise<void>;
  limits?: Partial<Limits>;
}

export interface SearchInput extends SearchParams {
  limit?: number;
}

const NOT_CONNECTED =
  "Facebook Marketplace is not connected. Call Connect {action:\"connect\", service:\"facebook-marketplace\"} so the owner can sign in once on the live browser (experimental), then retry.";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function draftLink(sessionId: string, listingId: string, text: string): string {
  return sha(`${sessionId}|${listingId}|${text}`);
}

export interface SendOutcome {
  status: "sent" | "sent_unverified";
  verified: boolean;
  message: string;
}

export class MarketplaceService {
  readonly store: MarketplaceStore;
  readonly limits: Limits;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly deps: MarketplaceDeps;
  private tail: Promise<unknown> = Promise.resolve();
  private driver: MarketplaceDriver | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** In-memory only: listing facts the owner already saw, so a draft does not re-open the page. */
  private readonly recent = new Map<string, { detail: ListingDetail; at: number }>();

  constructor(deps: MarketplaceDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limits = { ...defaultLimits(), ...(deps.limits ?? {}) };
    this.store = new MarketplaceStore(deps.home, this.now);
  }

  setPush(push: PushLike): void {
    this.deps.push = push;
  }

  // ─── plumbing ──────────────────────────────────────────────────────────────

  private audit(action: string, result: string, target?: string, params?: unknown, sessionId?: string): Promise<void> {
    const entry = { actor: "marketplace", action: `marketplace.${action}`, result: scrubSecrets(result).slice(0, 200), ...(target ? { target: scrubSecrets(target).slice(0, 200) } : {}), ...(params !== undefined ? { params } : {}), ...(sessionId ? { sessionId } : {}) };
    if (this.deps.audit) return this.deps.audit(entry).catch(() => undefined);
    return appendAudit(entry, this.deps.home);
  }

  private paused(): boolean {
    return this.deps.isPaused ? this.deps.isPaused() : ownerPause.paused;
  }

  private async session(): Promise<{ connected: boolean; mtimeMs?: number }> {
    if (this.deps.sessionInfo) return this.deps.sessionInfo();
    let best: { connected: boolean; mtimeMs?: number } = { connected: false };
    for (const id of ["facebook-marketplace", "facebook"]) {
      try {
        const st = await fs.stat(browserSessionFile(id, this.deps.home));
        if (!best.connected || st.mtimeMs > (best.mtimeMs ?? 0)) best = { connected: true, mtimeMs: st.mtimeMs };
      } catch {
        // not saved under this id
      }
    }
    return best;
  }

  private async pace(): Promise<void> {
    const { paceMinMs, paceMaxMs } = this.limits;
    await this.sleepFn(paceMinMs + Math.floor(this.random() * (paceMaxMs - paceMinMs + 1)));
  }

  /** Refuse before any page is touched: kill switch, pause, connection, wall cooldown. */
  private async gate(action: string, opts: { needsPage?: boolean } = {}): Promise<void> {
    const refuse = async (code: MarketplaceErrorCode, message: string): Promise<never> => {
      await this.audit(action, `refused: ${code}`);
      throw new MarketplaceError(code, message);
    };
    if (!marketplaceEnabled()) return refuse("disabled", "Marketplace is switched off on this machine (ARES_MARKETPLACE=0). Tell the owner; do not look for another way.");
    if (this.paused()) return refuse("paused", "Ares is paused by the owner, so Marketplace is on hold. It resumes when they resume Ares.");
    if (opts.needsPage === false) return;
    const info = await this.session();
    if (!info.connected) return refuse("not_connected", NOT_CONNECTED);
    const state = await this.store.read();
    const wall = state.wall;
    if (wall) {
      if (wall.kind === "login" && (info.mtimeMs ?? 0) > wall.at) {
        await this.store.mutate((s) => void delete s.wall); // the owner signed in again
      } else if (wall.kind !== "login" && this.now() >= wall.until) {
        await this.store.mutate((s) => void delete s.wall); // cooled down; the next page decides
      } else {
        const mins = wall.kind === "login" ? 0 : Math.ceil((wall.until - this.now()) / 60_000);
        return refuse("wall", `${wallMessage({ kind: wall.kind, reason: wall.reason })}${mins ? ` (on hold for about ${mins} more minutes)` : ""}`);
      }
    }
  }

  /** One browser action at a time, whatever called. */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async openDriver(): Promise<MarketplaceDriver> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.driver) this.driver = this.deps.openDriver ? await this.deps.openDriver() : await openPlaywrightDriver({ ...(this.deps.home ? { home: this.deps.home } : {}) });
    return this.driver;
  }

  private armIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.dispose(), this.limits.idleCloseMs);
    this.idleTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const d = this.driver;
    this.driver = null;
    await d?.close().catch(() => undefined);
  }

  private async withPage<T>(action: string, fn: (d: MarketplaceDriver, nav: (url: string) => Promise<void>) => Promise<T>): Promise<T> {
    await this.gate(action);
    return this.queue(async () => {
      // The queue may have waited minutes: check again that nothing was switched off meanwhile.
      await this.gate(action);
      const d = await this.openDriver();
      try {
        const nav = async (url: string): Promise<void> => {
          const spent = await this.store.mutate((s) => {
            if (s.pages.length >= this.limits.pagesPerHour) return false;
            s.pages.push(this.now());
            return true;
          });
          if (!spent) {
            await this.audit(action, "refused: page budget");
            throw new MarketplaceError("budget", `Marketplace page budget used up (${this.limits.pagesPerHour} pages per hour, shared by everything). Wait and retry later; do not try to get around it.`);
          }
          await this.pace();
          const surface = await d.open(url);
          const wall = detectWall(surface);
          if (wall) throw await this.hitWall(action, wall);
        };
        return await fn(d, nav);
      } catch (error) {
        if (error instanceof MarketplaceError) throw error;
        const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
        await this.audit(action, `error: ${message}`);
        // A dead page is not worth keeping: the next action gets a fresh browser.
        await this.dispose();
        throw new MarketplaceError("failed", `Marketplace browser step failed: ${message}`);
      } finally {
        if (this.driver) this.armIdleClose();
      }
    });
  }

  private async hitWall(action: string, wall: Wall): Promise<MarketplaceError> {
    const now = this.now();
    const until = wall.kind === "login" ? now : now + this.limits.cooldownMs[wall.kind];
    const fresh = await this.store.mutate((s) => {
      const had = Boolean(s.wall);
      s.wall = { kind: wall.kind, reason: wall.reason, at: now, until };
      return !had;
    });
    await this.audit(action, `wall: ${wall.kind}`);
    if (fresh && this.deps.push) {
      void this.deps.push({ title: "Marketplace stopped", body: wallMessage(wall).slice(0, 220), data: { kind: "marketplace", wall: wall.kind } }).catch(() => undefined);
    }
    return new MarketplaceError("wall", wallMessage(wall));
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  async search(input: SearchInput, sessionId?: string): Promise<{ listings: Listing[]; note?: string; url: string }> {
    const query = clean(input.query, 120);
    if (!query) throw new MarketplaceError("invalid", "search needs a query.");
    const limit = Math.min(20, Math.max(1, Math.floor(input.limit ?? 10)));
    const url = searchUrl({ ...input, query });
    const result = await this.withPage("search", async (d, nav) => {
      await nav(url);
      let listings = parseCards(await d.cards(), 60);
      for (let i = 0; i < 3 && listings.length < limit; i++) {
        await d.scroll();
        const more = parseCards(await d.cards(), 60);
        if (more.length <= listings.length) break;
        listings = more;
      }
      return listings;
    });
    const min = input.minPrice;
    const max = input.maxPrice;
    const filtered = result.filter((l) => {
      const n = priceNumber(l.price);
      if (n === null) return true;
      return (min === undefined || n >= min) && (max === undefined || n <= max);
    });
    const listings = filtered.slice(0, limit);
    await this.audit("search", `${listings.length} listings`, query, { location: input.location, limit }, sessionId);
    return {
      listings,
      url,
      ...(result.length === 0 ? { note: "No listings could be read from the page. Either nothing matched or Facebook's layout changed (selectors are unverified); do not guess listings." } : {}),
    };
  }

  async listing(target: string, sessionId?: string): Promise<ListingDetail> {
    const t = normalizeListingTarget(target);
    if (!t) throw new MarketplaceError("invalid", "listing needs a facebook.com/marketplace/item/<id> URL or a numeric listing id.");
    const detail = await this.withPage("listing", async (d, nav) => {
      await nav(t.url);
      const parsed = parseListing(await d.listing(), t.id);
      if (!parsed) throw new MarketplaceError("not_found", "That listing could not be read (removed, private, or Facebook's layout changed).");
      return parsed;
    });
    this.recent.set(detail.id, { detail, at: this.now() });
    await this.audit("listing", detail.sold ? "sold" : "ok", detail.id, undefined, sessionId);
    return detail;
  }

  async inbox(limit: number, sessionId?: string): Promise<Conversation[]> {
    const n = Math.min(20, Math.max(1, Math.floor(limit || 10)));
    const rows = await this.withPage("inbox", async (d, nav) => {
      await nav(INBOX_URL);
      return parseThreads(await d.threads(), n);
    });
    await this.audit("inbox", `${rows.length} conversations`, undefined, undefined, sessionId);
    return rows;
  }

  // ─── drafts and sends ──────────────────────────────────────────────────────

  private capProblem(state: { sends: Array<{ at: number; sellerKey: string }> }, key: string): string | null {
    const now = this.now();
    const lastHour = state.sends.filter((s) => now - s.at < 3_600_000).length;
    if (lastHour >= this.limits.sendsPerHour) return `Marketplace send cap reached (${this.limits.sendsPerHour} messages per hour across all sellers). Try again later.`;
    const today = state.sends.filter((s) => s.sellerKey === key && now - s.at < 86_400_000).length;
    if (today >= this.limits.sendsPerSellerPerDay) return "Ares already started a conversation with this seller in the last 24 hours (limit: 1 new conversation per seller per day).";
    return null;
  }

  private async detailFor(id: string, url: string, sessionId?: string): Promise<ListingDetail> {
    const hit = this.recent.get(id);
    if (hit && this.now() - hit.at < 15 * 60_000) return hit.detail;
    return this.listing(url, sessionId);
  }

  /**
   * Stage a draft for the owner's decision: bind the listing facts (seller,
   * title, price) and the exact text, and give back what the approval card must
   * show. Nothing is sent. Idempotent for the same session, listing and text.
   */
  async stageDraft(input: { target: string; text: string; sessionId: string }): Promise<{ draft: Draft; prompt: string }> {
    await this.gate("draft_message", { needsPage: false });
    const t = normalizeListingTarget(input.target);
    if (!t) throw new MarketplaceError("invalid", "draft_message needs a facebook.com/marketplace/item/<id> URL or a numeric listing id.");
    const text = normalizeMessage(input.text);
    if (!text) throw new MarketplaceError("invalid", "The message is empty or longer than 1000 characters.");
    const link = draftLink(input.sessionId, t.id, text);
    const existing = (await this.store.read()).drafts.find((d) => d.link === link && (d.status === "pending" || d.status === "approved") && this.now() - d.createdAt < this.limits.draftTtlMs);
    const detail = await this.detailFor(t.id, t.url, input.sessionId);
    if (detail.sold) throw new MarketplaceError("invalid", "That listing shows as sold or unavailable. Nothing to draft.");
    const key = sellerKey(detail);
    const draft =
      existing ??
      (await this.store.mutate((s) => {
        const problem = this.capProblem(s, key);
        if (problem) return problem;
        const d: Draft = {
          id: `mpd_${randomBytes(6).toString("hex")}`,
          listingId: detail.id,
          url: detail.url,
          title: detail.title,
          price: detail.price,
          location: detail.location,
          seller: detail.sellerName || detail.seller || "the seller",
          sellerKey: key,
          text,
          link,
          status: "pending",
          createdAt: this.now(),
        };
        s.drafts.push(d);
        return d;
      }));
    if (typeof draft === "string") {
      await this.audit("draft_message", "refused: cap", t.id, undefined, input.sessionId);
      throw new MarketplaceError("cap", draft);
    }
    await this.audit("draft_message", "staged", draft.listingId, { draftId: draft.id, chars: draft.text.length, seller: draft.seller }, input.sessionId);
    return { draft, prompt: draftPrompt(draft) };
  }

  /** The owner said yes to the prompt for (session, listing, text): mark that exact draft approved. */
  async approveDraft(input: { target: string; text: string; sessionId: string }): Promise<Draft> {
    const t = normalizeListingTarget(input.target);
    const text = normalizeMessage(input.text);
    if (!t || !text) throw new MarketplaceError("invalid", "Nothing to approve.");
    const link = draftLink(input.sessionId, t.id, text);
    const approved = await this.store.mutate((s) => {
      const d = s.drafts.find((x) => x.link === link && (x.status === "pending" || x.status === "approved"));
      if (!d) return null;
      d.status = "approved";
      d.approvedAt = this.now();
      d.approvedSession = input.sessionId;
      return { ...d };
    });
    if (!approved) {
      await this.audit("draft_message", "refused: not staged", t.id, undefined, input.sessionId);
      throw new MarketplaceError("not_approved", "That draft was not staged for approval (or expired). Call draft_message again so the owner sees the exact message.");
    }
    await this.audit("draft_message", "approved by owner", approved.listingId, { draftId: approved.id }, input.sessionId);
    return approved;
  }

  async send(input: { draftId: string; sessionId: string }): Promise<SendOutcome> {
    await this.gate("send");
    const now = this.now();
    // Reserve the send (status and ledger) in one step, before anything is typed, so a crash, a timeout or a
    // second call can never produce a second message for the same approval.
    const reserved = await this.store.mutate((s): Draft | MarketplaceError => {
      const d = s.drafts.find((x) => x.id === input.draftId);
      if (!d) return new MarketplaceError("not_found", "No such draft. Call draft_message first.");
      if (d.status === "sent" || d.status === "sent_unverified" || d.status === "sending") return new MarketplaceError("not_approved", `That draft was already ${d.status === "sending" ? "being sent" : "sent"}. One approval buys one message; draft a new one if the owner wants to send again.`);
      if (d.status !== "approved" || !d.approvedAt || d.approvedSession !== input.sessionId) return new MarketplaceError("not_approved", "The owner has not approved this draft in this session. Call draft_message and let them see the exact message.");
      if (now - d.approvedAt > this.limits.approvalTtlMs) return new MarketplaceError("not_approved", "The approval expired. Call draft_message again.");
      const problem = this.capProblem(s, d.sellerKey);
      if (problem) return new MarketplaceError("cap", problem);
      d.status = "sending";
      s.sends.push({ at: now, sellerKey: d.sellerKey, listingId: d.listingId, draftId: d.id, outcome: "sent_unverified" });
      return { ...d };
    });
    if (reserved instanceof MarketplaceError) {
      await this.audit("send", `refused: ${reserved.code}`, input.draftId, undefined, input.sessionId);
      throw reserved;
    }
    const draft = reserved;
    const release = (note: string): Promise<void> =>
      this.store.mutate((s) => {
        const d = s.drafts.find((x) => x.id === draft.id);
        if (d) {
          d.status = "approved"; // nothing was typed: the same approval may try again
          d.note = note;
        }
        s.sends = s.sends.filter((x) => x.draftId !== draft.id);
      });
    const finish = (status: "sent" | "sent_unverified", note?: string): Promise<void> =>
      this.store.mutate((s) => {
        const d = s.drafts.find((x) => x.id === draft.id);
        if (d) {
          d.status = status;
          d.sentAt = this.now();
          if (note) d.note = note;
        }
        const rec = s.sends.find((x) => x.draftId === draft.id);
        if (rec) rec.outcome = status;
      });

    let typedSomething = false;
    try {
      const outcome = await this.withPage("send", async (d, nav) => {
        await nav(draft.url);
        const page = parseListing(await d.listing(), draft.listingId);
        if (!page || page.id !== draft.listingId) throw new MarketplaceError("mismatch", "The page did not show the approved listing. Nothing was sent.");
        if (page.sold) throw new MarketplaceError("mismatch", "The listing now shows as sold or unavailable. Nothing was sent.");
        if (!titlesAgree(page.title, draft.title)) throw new MarketplaceError("mismatch", `The listing title changed ("${page.title}" instead of "${draft.title}"). Nothing was sent; review it again.`);
        if (draft.sellerKey.startsWith("id:") && page.sellerId && sellerKey(page) !== draft.sellerKey) throw new MarketplaceError("mismatch", "The listing's seller is not the one the owner approved. Nothing was sent.");
        const snippet = squash(draft.text).slice(-80);
        const before = await d.echoCount(snippet);
        const composed = await d.compose(draft.text, () => this.pace());
        typedSomething = composed.ok || composed.typed;
        if (!composed.ok && !composed.typed) {
          throw new MarketplaceError("failed", `Could not find Marketplace's message box or send button (${composed.reason}). Facebook's layout may have changed. Nothing was sent.`);
        }
        // Read it back: the message must now be in the thread.
        let seen = false;
        for (let i = 0; i < 6 && !seen; i++) {
          await this.sleepFn(1_000 + Math.floor(this.random() * 500));
          seen = (await d.echoCount(snippet)) > before;
        }
        if (!seen) {
          // Second chance: the conversation list's preview line.
          try {
            await nav(INBOX_URL);
            seen = (await d.threads()).some((row) => squash(row.text).includes(squash(draft.text).slice(0, 40)));
          } catch (error) {
            if (error instanceof MarketplaceError && error.code === "wall") throw error;
          }
        }
        if (!composed.ok && !seen) throw new MarketplaceError("failed", `Typed the message but could not send it (${composed.reason}), and it is not in the thread. Check Marketplace yourself before retrying.`);
        return seen;
      });
      if (outcome) {
        await finish("sent");
        await this.audit("send", "sent (read back)", draft.listingId, { draftId: draft.id, seller: draft.seller, chars: draft.text.length, text: draft.text.slice(0, 500) }, input.sessionId);
        return { status: "sent", verified: true, message: `Sent to ${draft.seller} about "${draft.title}" and read back in the thread.` };
      }
      await finish("sent_unverified", "no read-back");
      await this.audit("send", "sent_unverified", draft.listingId, { draftId: draft.id, seller: draft.seller, chars: draft.text.length, text: draft.text.slice(0, 500) }, input.sessionId);
      return {
        status: "sent_unverified",
        verified: false,
        message: `The message was typed and sent, but it could NOT be read back in the thread. Do not report success and do not resend. Ask the owner to check Marketplace messages for ${draft.seller}.`,
      };
    } catch (error) {
      if (!typedSomething) await release(error instanceof Error ? error.message.slice(0, 160) : "failed").catch(() => undefined);
      else await finish("sent_unverified", "typed; outcome unknown").catch(() => undefined);
      throw error;
    }
  }

  // ─── watches ───────────────────────────────────────────────────────────────

  async addWatch(input: { query: string; filters?: WatchFilters; intervalMinutes: number }, sessionId?: string): Promise<Watch> {
    await this.gate("watch.add", { needsPage: false });
    const query = clean(input.query, 120);
    if (!query) throw new MarketplaceError("invalid", "watch.add needs a query.");
    if (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < this.limits.minWatchMinutes) {
      throw new MarketplaceError("invalid", `intervalMinutes must be at least ${this.limits.minWatchMinutes}: Marketplace is watched slowly on purpose.`);
    }
    const now = this.now();
    const interval = Math.min(24 * 60, Math.floor(input.intervalMinutes));
    const result = await this.store.mutate((s) => {
      if (s.watches.length >= this.limits.maxWatches) return null;
      const w: Watch = {
        id: `mpw_${randomBytes(4).toString("hex")}`,
        query,
        filters: { ...(input.filters ?? {}) },
        intervalMinutes: interval,
        createdAt: now,
        // First look in a few minutes, jittered; it only records a baseline.
        nextDueAt: now + (2 + Math.floor(this.random() * 6)) * 60_000,
      };
      s.watches.push(w);
      return w;
    });
    if (!result) throw new MarketplaceError("cap", `At most ${this.limits.maxWatches} watches. Remove one first.`);
    await this.audit("watch.add", "ok", result.id, { query, interval }, sessionId);
    return result;
  }

  async listWatches(sessionId?: string): Promise<Watch[]> {
    await this.gate("watch.list", { needsPage: false });
    const watches = (await this.store.read()).watches;
    await this.audit("watch.list", `${watches.length} watches`, undefined, undefined, sessionId);
    return watches;
  }

  async removeWatch(id: string, sessionId?: string): Promise<boolean> {
    await this.gate("watch.remove", { needsPage: false });
    const removed = await this.store.mutate((s) => {
      const before = s.watches.length;
      s.watches = s.watches.filter((w) => w.id !== id);
      delete s.seen[id];
      return s.watches.length < before;
    });
    await this.audit("watch.remove", removed ? "ok" : "not found", id, undefined, sessionId);
    return removed;
  }

  /** Run one watch now (manual `watch.check`, or a due tick). Returns the NEW listings since the last look. */
  async checkWatch(id: string, opts: { notify?: boolean; sessionId?: string } = {}): Promise<{ watch: Watch; fresh: Listing[]; baseline: boolean }> {
    const w = (await this.store.read()).watches.find((x) => x.id === id);
    if (!w) throw new MarketplaceError("not_found", `No watch ${id}.`);
    let found: Listing[];
    try {
      found = (await this.search({ ...w.filters, query: w.query, limit: w.filters.limit ?? 20 }, opts.sessionId)).listings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((s) => {
        const x = s.watches.find((y) => y.id === id);
        if (x) {
          x.lastCheckedAt = this.now();
          x.lastResult = `error: ${message.slice(0, 120)}`;
          x.nextDueAt = this.now() + this.jitter(x.intervalMinutes);
        }
      });
      throw error;
    }
    const outcome = await this.store.mutate((s) => {
      const x = s.watches.find((y) => y.id === id);
      if (!x) return null;
      const baseline = s.seen[id] === undefined;
      const known = new Set(s.seen[id] ?? []);
      const fresh = found.filter((l) => !known.has(l.id));
      s.seen[id] = [...fresh.map((l) => l.id), ...(s.seen[id] ?? [])].slice(0, 300);
      x.lastCheckedAt = this.now();
      x.nextDueAt = this.now() + this.jitter(x.intervalMinutes);
      x.lastResult = baseline ? `baseline of ${found.length}` : `${fresh.length} new`;
      return { watch: { ...x }, fresh: baseline ? [] : fresh, baseline };
    });
    if (!outcome) throw new MarketplaceError("not_found", `No watch ${id}.`);
    if (opts.notify !== false && outcome.fresh.length && this.deps.push) {
      const lines = outcome.fresh.slice(0, 3).map((l) => `${l.title} - ${l.price || "no price"}${l.location ? ` - ${l.location}` : ""}`);
      const more = outcome.fresh.length > 3 ? ` (+${outcome.fresh.length - 3} more)` : "";
      void this.deps
        .push({ title: `Marketplace: ${outcome.fresh.length} new for "${clean(w.query, 40)}"`, body: lines.join("\n") + more, data: { kind: "marketplace", watchId: id, count: outcome.fresh.length, firstUrl: outcome.fresh[0]!.url } })
        .catch(() => undefined);
    }
    await this.audit("watch.check", outcome.baseline ? "baseline" : `${outcome.fresh.length} new`, id, undefined, opts.sessionId);
    return outcome;
  }

  /** Re-check interval with jitter: 85%-130% of the asked-for gap. */
  private jitter(intervalMinutes: number): number {
    return Math.floor(intervalMinutes * 60_000 * (0.85 + this.random() * 0.45));
  }

  /**
   * The scheduler hook. Looks at ONE due watch per tick (never a burst), only
   * while the kill switch is off, Ares is not paused, no wall is up, and the
   * hour's page budget is at most half used (the other half is for the owner).
   */
  async tick(): Promise<string> {
    if (!marketplaceEnabled() || this.paused()) return "idle";
    const state = await this.store.read();
    if (!state.watches.length) return "idle";
    if (state.wall && (state.wall.kind === "login" || this.now() < state.wall.until)) return "idle: wall";
    const now = this.now();
    const used = state.pages.filter((t) => now - t < 3_600_000).length;
    if (used >= Math.floor(this.limits.pagesPerHour / 2)) return "idle: budget";
    const due = state.watches.filter((w) => w.nextDueAt <= now).sort((a, b) => a.nextDueAt - b.nextDueAt)[0];
    if (!due) return "idle";
    try {
      const r = await this.checkWatch(due.id, { notify: true });
      return r.baseline ? "baseline" : `${r.fresh.length} new`;
    } catch (error) {
      return `error: ${(error instanceof Error ? error.message : String(error)).slice(0, 100)}`;
    }
  }

  /** What the owner or agent can see about limits right now. */
  async status(): Promise<{ enabled: boolean; paused: boolean; connected: boolean; wall?: { kind: string; reason: string; untilMs: number }; pagesLastHour: number; pagesPerHour: number; sendsLastHour: number; sendsPerHour: number; watches: number }> {
    const state = await this.store.read();
    const now = this.now();
    const info = await this.session();
    return {
      enabled: marketplaceEnabled(),
      paused: this.paused(),
      connected: info.connected,
      ...(state.wall ? { wall: { kind: state.wall.kind, reason: state.wall.reason, untilMs: state.wall.until } } : {}),
      pagesLastHour: state.pages.filter((t) => now - t < 3_600_000).length,
      pagesPerHour: this.limits.pagesPerHour,
      sendsLastHour: state.sends.filter((s) => now - s.at < 3_600_000).length,
      sendsPerHour: this.limits.sendsPerHour,
      watches: state.watches.length,
    };
  }
}

/** Loose title agreement: either contains the other's first 24 characters (ignoring case and spacing). */
export function titlesAgree(a: string, b: string): boolean {
  const x = squash(a);
  const y = squash(b);
  if (!x || !y) return false;
  const head = (s: string) => s.slice(0, 24);
  return x.includes(head(y)) || y.includes(head(x));
}

/** The approval card: seller, listing, price and the EXACT message. */
export function draftPrompt(d: Pick<Draft, "seller" | "title" | "price" | "location" | "url" | "text">): string {
  return [
    "Send this Facebook Marketplace message as you?",
    `To: ${d.seller}`,
    `About: ${d.title}${d.price ? ` (${d.price}${d.location ? `, ${d.location}` : ""})` : ""}`,
    `Listing: ${d.url}`,
    "",
    "Exact message:",
    d.text,
    "",
    "It is sent once, only if you approve here. Facebook does not allow automation and may restrict the account.",
  ].join("\n");
}

export { listingUrl };
