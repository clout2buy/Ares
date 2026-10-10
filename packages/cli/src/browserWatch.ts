// Watch or take over Ares's browser — "you can watch or take over anytime".
//
// When the Browser tool opens a browser in a turn, it emits ONE
// tool_progress {kind:"browser_live", sessionId, url, label, state:"active"}
// whose url is https://<origin>/watch/<token>. Opening it streams frames of
// THAT page. Watching never blocks Ares. Tapping "Take over" flips the single
// controller from Ares to the owner:
//
//   - exactly one controller at a time. While the owner holds it, every
//     Browser action WAITS (bounded, abortable by the turn) and no agent input
//     reaches the page; while Ares holds it, the owner's input is refused.
//   - a snapshot is taken before the owner's first input (url, title, cookie
//     count, visible form fields with password values masked) and again on
//     "Hand back to Ares". The diff goes into the next Browser result, so a
//     queued agent action never runs against a page it hasn't re-read.
//   - each control window is appended to the audit log (who, from, to, url at
//     start and end).
//
// Unauthenticated on purpose, like the connect hub: the token (24 random
// bytes) is the capability. It serves frames and whitelisted input for one
// page and nothing else; it dies ENDED_TTL_MS after the browser closes.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendAudit, redactSecretValues } from "@ares/core";
import { STYLE, esc, json, page as sendPage, readJson, resultPage } from "./connectHub.js";
import { LIVE_INPUT_DOCK, LIVE_VIEW_CSS, applyBrowserInput, captureFrame, viewportOf } from "./liveBrowser.js";

export type BrowserController = "ares" | "owner";

function envMs(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long a closed browser's watch link still answers ("this browser closed") before it 404s. */
const ENDED_TTL_MS = () => envMs("ARES_BROWSER_WATCH_TTL_MS", 10 * 60_000);
/** How long a take-over waits for Ares's in-flight action to finish before the owner gets the page anyway. */
const TAKEOVER_SETTLE_MS = () => envMs("ARES_BROWSER_TAKEOVER_SETTLE_MS", 20_000);

// ─── Snapshots ───────────────────────────────────────────────────────────────

export interface PageSnapshot {
  url: string;
  title: string;
  cookies: number;
  /** Visible form fields; password values are always "•••" when non-empty. */
  fields: Array<{ name: string; type: string; value: string }>;
  at: string;
}

const MAX_FIELDS = 40;
const MAX_VALUE = 80;

/** Visible form fields, masked in the page before anything leaves it. */
const FIELD_SCRAPE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const type = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "file"].includes(type)) continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const name = el.getAttribute("name") || el.id || el.getAttribute("aria-label") || el.getAttribute("placeholder") || type;
    let value = type === "checkbox" || type === "radio" ? (el.checked ? "checked" : "") : String(el.value || "");
    if (type === "password" && value) value = "\\u2022\\u2022\\u2022";
    out.push({ name: String(name).slice(0, 60), type, value: value.slice(0, ${MAX_VALUE}) });
    if (out.length >= ${MAX_FIELDS}) break;
  }
  return out;
})()`;

export async function snapshotPage(page: any, secrets: readonly string[] = []): Promise<PageSnapshot> {
  const redact = (text: string) => redactSecretValues(text, secrets);
  const [title, cookies, fields] = await Promise.all([
    Promise.resolve(page.title?.()).catch(() => ""),
    Promise.resolve(page.context?.()?.cookies?.()).then((list: unknown) => (Array.isArray(list) ? list.length : 0)).catch(() => 0),
    Promise.resolve(page.evaluate?.(FIELD_SCRAPE)).catch(() => []),
  ]);
  return {
    url: redact(String(page.url?.() ?? "")),
    title: redact(String(title ?? "")),
    cookies: Number(cookies) || 0,
    fields: (Array.isArray(fields) ? fields : []).slice(0, MAX_FIELDS).map((field: any) => ({
      name: redact(String(field?.name ?? "")),
      type: String(field?.type ?? ""),
      value: redact(String(field?.value ?? "")),
    })),
    at: new Date().toISOString(),
  };
}

/** One paragraph for the agent: what the owner changed while they had the page. */
export function describeHandback(before: PageSnapshot | undefined, after: PageSnapshot): string {
  const parts: string[] = [];
  if (!before) {
    parts.push(`The page is now ${after.url}.`);
  } else {
    parts.push(before.url === after.url ? `The url is unchanged (${after.url}).` : `The url changed from ${before.url} to ${after.url}.`);
    if (before.title !== after.title) parts.push(`The title changed from "${before.title}" to "${after.title}".`);
    if (before.cookies !== after.cookies) parts.push(`Cookies: ${before.cookies} → ${after.cookies}${after.cookies > before.cookies ? " (a sign-in may have happened)" : ""}.`);
    const key = (f: { name: string; type: string }) => `${f.type}:${f.name}`;
    const was = new Map(before.fields.map((f) => [key(f), f.value]));
    const changed: string[] = [];
    for (const field of after.fields) {
      const prior = was.get(key(field));
      if (prior === undefined) changed.push(`${field.name} (new)`);
      else if (prior !== field.value) changed.push(field.type === "password" ? `${field.name} (password edited)` : `${field.name}: "${prior}" → "${field.value}"`);
    }
    const now = new Set(after.fields.map(key));
    for (const field of before.fields) if (!now.has(key(field))) changed.push(`${field.name} (gone)`);
    parts.push(changed.length ? `Form fields changed: ${changed.slice(0, 12).join("; ")}${changed.length > 12 ? "; …" : ""}.` : "No visible form field changed.");
  }
  parts.push("Re-read the page (state/tree/screenshot) before continuing — your previous plan may no longer hold.");
  return parts.join(" ");
}

export interface HandbackNotice {
  before?: PageSnapshot;
  after: PageSnapshot;
  note: string;
  ownerHeldMs: number;
}

// ─── One watched browser ─────────────────────────────────────────────────────

export interface WatchTarget {
  /** The page Ares is driving right now (it can change on attach). */
  page: () => any | undefined;
  /** Short name for the card: the site host or title. */
  label: string;
  /** The conversation this browser belongs to, for the audit log. */
  conversationId?: string;
  /** Values to mask out of snapshots, if the caller holds any this instant. */
  secrets?: () => readonly string[];
}

export type ControlWait =
  | { waited: false }
  | { waited: true; outcome: "handed_back"; notice: HandbackNotice | null }
  | { waited: true; outcome: "timeout" };

export class BrowserWatch {
  /** Stable id of this browser session — the `sessionId` of browser_live events. */
  readonly sessionId = `bw_${randomBytes(9).toString("base64url")}`;
  readonly token = randomBytes(24).toString("base64url");
  readonly url: string;
  label: string;
  controller: BrowserController = "ares";
  endedAt: number | undefined;
  /** The owner holds control but their inputs wait for Ares's in-flight action. */
  private ownerReady = false;
  private ownerSince = 0;
  private ownerUrlAtStart = "";
  private before: PageSnapshot | undefined;
  private notice: HandbackNotice | null = null;
  private readonly waiters = new Set<() => void>();
  private agentBusy = 0;
  private readonly idleWaiters = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly target: WatchTarget,
    base: string,
    private readonly home: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.url = `${base}/watch/${this.token}`;
    this.label = target.label;
    this.audit("ares", "browser.control.start", this.currentUrl(), {});
  }

  get ended(): boolean {
    return this.endedAt !== undefined;
  }

  private currentUrl(): string {
    try {
      return String(this.target.page()?.url?.() ?? "");
    } catch {
      return "";
    }
  }

  private secrets(): readonly string[] {
    return this.target.secrets?.() ?? [];
  }

  private audit(actor: BrowserController, action: string, target: string, params: Record<string, unknown>, result?: string): void {
    void appendAudit(
      {
        actor,
        ...(this.target.conversationId ? { sessionId: this.target.conversationId } : {}),
        action,
        target: redactSecretValues(target, this.secrets()),
        params: { browserSession: this.sessionId, ...params },
        ...(result ? { result } : {}),
      },
      this.home,
    );
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ── the agent's side ──

  /**
   * Called by the Browser tool before it touches the page. Returns at once
   * while Ares holds control; while the owner does, waits until they hand
   * back (→ the handback notice), the timeout, or the turn's abort (throws).
   */
  async waitForControl(opts: { signal: AbortSignal; timeoutMs: number; onWaiting?: () => void; heartbeatMs?: number }): Promise<ControlWait> {
    if (this.controller === "ares" || this.ended) return { waited: false };
    opts.onWaiting?.();
    return new Promise<ControlWait>((resolve, reject) => {
      let done = false;
      const heartbeat = opts.onWaiting
        ? setInterval(() => opts.onWaiting?.(), opts.heartbeatMs ?? 30_000)
        : undefined;
      heartbeat?.unref?.();
      const settle = (value: ControlWait | Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (heartbeat) clearInterval(heartbeat);
        opts.signal.removeEventListener("abort", onAbort);
        this.waiters.delete(wake);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const wake = () => settle({ waited: true, outcome: "handed_back", notice: this.takeNotice() });
      const onAbort = () => settle(new Error("the turn was stopped while the owner had the browser"));
      // NOT unref'd: a turn is actively waiting on this, and must wake to
      // report "the owner still has it" even if nothing else is scheduled.
      const timer = setTimeout(() => settle({ waited: true, outcome: "timeout" }), opts.timeoutMs);
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(wake);
    });
  }

  /** Mark an agent action in flight; the release lets a pending take-over proceed. */
  agentBegin(): () => void {
    this.agentBusy += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.agentBusy = Math.max(0, this.agentBusy - 1);
      if (this.agentBusy === 0) for (const wake of [...this.idleWaiters]) wake();
    };
  }

  /** The handback diff the agent hasn't seen yet (consumed on read). */
  takeNotice(): HandbackNotice | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  // ── the owner's side ──

  async takeOver(): Promise<boolean> {
    if (this.ended) return false;
    if (this.controller === "owner") return true;
    this.controller = "owner";
    this.ownerReady = false;
    // Let Ares's in-flight action finish (bounded) so the snapshot is the page
    // the owner actually receives, and their first tap can't race a click.
    if (this.agentBusy > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.idleWaiters.delete(done);
          resolve();
        }, TAKEOVER_SETTLE_MS());
        timer.unref?.();
        const done = () => {
          clearTimeout(timer);
          this.idleWaiters.delete(done);
          resolve();
        };
        this.idleWaiters.add(done);
      });
    }
    if (this.controller !== "owner" || this.ended) return false;
    const pageNow = this.target.page();
    this.before = pageNow ? await snapshotPage(pageNow, this.secrets()).catch(() => undefined) : undefined;
    this.ownerSince = Date.now();
    this.ownerUrlAtStart = this.before?.url ?? this.currentUrl();
    this.ownerReady = true;
    this.audit("ares", "browser.control.end", this.ownerUrlAtStart, { to: new Date(this.ownerSince).toISOString() }, "owner took over");
    this.audit("owner", "browser.control.start", this.ownerUrlAtStart, { from: new Date(this.ownerSince).toISOString() });
    this.log(`watch: owner took over ${this.label}`);
    return true;
  }

  async handBack(): Promise<boolean> {
    if (this.controller !== "owner") return false;
    const pageNow = this.target.page();
    const after = pageNow
      ? await snapshotPage(pageNow, this.secrets()).catch(() => undefined)
      : undefined;
    const snapshot = after ?? { url: this.currentUrl(), title: "", cookies: 0, fields: [], at: new Date().toISOString() };
    const heldMs = this.ownerSince ? Date.now() - this.ownerSince : 0;
    this.notice = { ...(this.before ? { before: this.before } : {}), after: snapshot, note: describeHandback(this.before, snapshot), ownerHeldMs: heldMs };
    this.controller = "ares";
    this.ownerReady = false;
    this.before = undefined;
    this.audit(
      "owner",
      "browser.control.end",
      snapshot.url,
      { from: new Date(this.ownerSince || Date.now()).toISOString(), to: new Date().toISOString(), urlAtStart: this.ownerUrlAtStart, urlAtEnd: snapshot.url },
      "handed back to Ares",
    );
    this.audit("ares", "browser.control.start", snapshot.url, {});
    this.log(`watch: owner handed ${this.label} back`);
    for (const wake of [...this.waiters]) wake();
    return true;
  }

  frame(): Promise<{ jpeg: Buffer; url: string; title: string }> {
    const pageNow = this.target.page();
    if (!pageNow) return Promise.reject(new Error("no page"));
    return this.serial(() => captureFrame(pageNow, 55));
  }

  async input(event: Parameters<typeof applyBrowserInput>[2]): Promise<"ok" | "not_in_control"> {
    if (this.controller !== "owner" || !this.ownerReady) return "not_in_control";
    const pageNow = this.target.page();
    if (!pageNow) return "not_in_control";
    await this.serial(() => applyBrowserInput(pageNow, viewportOf(pageNow), event));
    return "ok";
  }

  end(): void {
    if (this.ended) return;
    const url = this.currentUrl();
    if (this.controller === "owner") this.audit("owner", "browser.control.end", url, { to: new Date().toISOString() }, "browser closed");
    else this.audit("ares", "browser.control.end", url, { to: new Date().toISOString() }, "browser closed");
    this.endedAt = Date.now();
    this.controller = "ares";
    // A turn waiting on the owner must not hang on a browser that is gone.
    for (const wake of [...this.waiters]) wake();
  }
}

// ─── The hub ─────────────────────────────────────────────────────────────────

export interface BrowserWatchHubOptions {
  /** Public origin the phone reaches, e.g. https://ares.mistiqueai.com */
  publicUrl: () => string | undefined;
  home?: string;
  log?: (line: string) => void;
}

export class BrowserWatchHub {
  private readonly watches = new Map<string, BrowserWatch>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BrowserWatchHubOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** A watch for one live browser, or null when there is no public origin to watch from. */
  open(target: WatchTarget): BrowserWatch | null {
    this.sweep();
    const base = (this.opts.publicUrl() ?? "").replace(/\/+$/, "");
    if (!base) return null;
    const watch = new BrowserWatch(target, base, this.opts.home, this.log);
    this.watches.set(watch.token, watch);
    return watch;
  }

  get(token: string): BrowserWatch | undefined {
    return this.watches.get(token);
  }

  private sweep(): void {
    const cutoff = Date.now() - ENDED_TTL_MS();
    for (const [token, watch] of this.watches) if (watch.endedAt !== undefined && watch.endedAt < cutoff) this.watches.delete(token);
  }

  close(): void {
    for (const watch of this.watches.values()) watch.end();
  }

  /** Everything under /watch/. False when the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/watch\/([A-Za-z0-9_-]{20,64})(?:\/(frame|state|input|take|handback))?\/?$/.exec(url.pathname);
    if (!match) return false;
    this.sweep();
    const watch = this.watches.get(match[1]!);
    const sub = match[2];
    if (!watch) {
      if (sub) json(res, 404, { error: "unknown or expired link" });
      else sendPage(res, 404, resultPage(false, "Link expired", "This browser is gone. Ask Ares to open it again."));
      return true;
    }
    try {
      if (!sub) {
        if (watch.ended) sendPage(res, 200, resultPage(true, "Browser closed", "Ares finished with this browser. You can go back to the app."));
        else sendPage(res, 200, watchPage(watch));
        return true;
      }
      if (sub === "state") {
        json(res, 200, { controller: watch.controller, label: watch.label, ended: watch.ended });
        return true;
      }
      if (watch.ended) {
        json(res, 410, { error: "this browser closed", ended: true });
        return true;
      }
      if (sub === "frame") {
        const frame = await watch.frame();
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": frame.jpeg.length,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-page-url": encodeURIComponent(frame.url),
          "x-page-title": encodeURIComponent(frame.title.slice(0, 120)),
          "x-controller": watch.controller,
        });
        res.end(frame.jpeg);
        return true;
      }
      if (req.method !== "POST") {
        json(res, 405, { error: "POST only" });
        return true;
      }
      if (sub === "take") {
        const ok = await watch.takeOver();
        json(res, ok ? 200 : 409, { ok, controller: watch.controller });
        return true;
      }
      if (sub === "handback") {
        const ok = await watch.handBack();
        json(res, ok ? 200 : 409, { ok, controller: watch.controller });
        return true;
      }
      // sub === "input"
      const outcome = await watch.input(await readJson(req));
      json(res, outcome === "ok" ? 200 : 409, outcome === "ok" ? { ok: true } : { error: "Ares has the browser — tap Take over first", controller: watch.controller });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`watch: ${watch.label} error — ${message}`);
      if (!res.headersSent) json(res, 500, { error: message.slice(0, 200) });
      return true;
    }
  }
}

// ─── Where the Browser tool finds the hub ────────────────────────────────────

let installed: BrowserWatchHub | null = null;

/** The garrison installs its hub; a plain CLI has none, and emits nothing. */
export function setBrowserWatchHub(hub: BrowserWatchHub | null): void {
  installed = hub;
}

export function getBrowserWatchHub(): BrowserWatchHub | null {
  return installed;
}

// ─── The page ────────────────────────────────────────────────────────────────

function watchPage(watch: BrowserWatch): string {
  const label = esc(watch.label);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="robots" content="noindex"><title>Watching ${label}</title><style>${STYLE}
${LIVE_VIEW_CSS}
.take{background:#ff7a2e;color:#1a0d05}
.bottom.watching .row{display:none}
.bottom:not(.watching) .who{display:none}
.who{font-size:.85rem;color:#c7cdd6;text-align:center;margin:.5rem 0 .2rem}
</style></head><body>
<div class="top"><div class="site"><b>${label}</b><span id="where">Connecting…</span></div><button class="pill take" id="toggle">Take over</button></div>
<div id="stage"><img id="screen" alt=""><div id="spinner">Loading ${label}…</div></div>
<div class="bottom watching" id="dock">
<p class="who" id="who">Ares is driving. Watch, or tap Take over.</p>
${LIVE_INPUT_DOCK}
<p class="hint" id="hint">Only one of you drives at a time.</p>
</div>
<script>
(function(){
var base=location.pathname.replace(/\\/$/,'');
var img=document.getElementById('screen'),where=document.getElementById('where'),spin=document.getElementById('spinner');
var toggle=document.getElementById('toggle'),dock=document.getElementById('dock'),hint=document.getElementById('hint');
var mine=false,busy=false,stopped=false,kick=null;
function post(path,body){return fetch(base+'/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});}
function show(controller){
  mine=controller==='owner';
  toggle.textContent=mine?'Hand back to Ares':'Take over';
  toggle.className='pill '+(mine?'done':'take');
  dock.className='bottom'+(mine?'':' watching');
  hint.textContent=mine?'You are driving — Ares waits. Tap the page to click, swipe to scroll.':'Only one of you drives at a time.';
}
function refresh(){
  if(stopped||busy)return;busy=true;
  fetch(base+'/frame',{cache:'no-store'}).then(function(r){
    if(r.status===410||r.status===404){stopped=true;where.textContent='This browser closed';toggle.style.display='none';return null;}
    if(!r.ok)throw new Error('frame '+r.status);
    var u=r.headers.get('x-page-url');if(u)where.textContent=decodeURIComponent(u);
    var c=r.headers.get('x-controller');if(c)show(c);
    return r.blob();
  }).then(function(b){
    if(!b)return;var old=img.src;img.src=URL.createObjectURL(b);spin.style.display='none';if(old)URL.revokeObjectURL(old);
  }).catch(function(){where.textContent='Reconnecting…';}).then(function(){busy=false;if(!stopped)kick=setTimeout(refresh,mine?450:900);});
}
function now(){clearTimeout(kick);setTimeout(refresh,120);}
toggle.onclick=function(){toggle.disabled=true;post(mine?'handback':'take').then(function(r){return r.json();}).then(function(j){if(j&&j.controller)show(j.controller);}).catch(function(){}).then(function(){toggle.disabled=false;now();});};
var sx=0,sy=0;
img.addEventListener('touchstart',function(e){var t=e.touches[0];sx=t.clientX;sy=t.clientY;},{passive:true});
img.addEventListener('touchend',function(e){
  if(!mine)return;
  var t=e.changedTouches[0],dy=t.clientY-sy,dx=t.clientX-sx;
  if(Math.abs(dy)>24&&Math.abs(dy)>Math.abs(dx)){post('input',{type:'scroll',dy:-dy*2.2}).then(now);return;}
  var r=img.getBoundingClientRect();post('input',{type:'tap',x:(t.clientX-r.left)/r.width,y:(t.clientY-r.top)/r.height}).then(now);
  e.preventDefault();
});
img.addEventListener('click',function(e){if(!mine)return;if(e.sourceCapabilities&&e.sourceCapabilities.firesTouchEvents)return;var r=img.getBoundingClientRect();post('input',{type:'tap',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}).then(now);});
var text=document.getElementById('text');
function send(){var v=text.value;if(!v||!mine)return;text.value='';post('input',{type:'type',text:v}).then(now);}
document.getElementById('send').onclick=send;
text.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();send();}});
Array.prototype.forEach.call(document.querySelectorAll('[data-key]'),function(b){b.onclick=function(){if(mine)post('input',{type:'key',key:b.getAttribute('data-key')}).then(now);};});
Array.prototype.forEach.call(document.querySelectorAll('[data-act]'),function(b){b.onclick=function(){if(mine)post('input',{type:b.getAttribute('data-act')}).then(now);};});
refresh();
})();
</script></body></html>`;
}
