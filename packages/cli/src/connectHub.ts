// The connect hub — every "connect X" becomes ONE link the owner opens.
//
// The agent calls Connect {action:"connect", service}; this hub (the garrison's
// ConnectBroker) mints a flow and a link on the garrison's public origin,
// https://<origin>/connect/<flow>. What opening it does depends on the service:
//
//   mcp-oauth   302 straight to the provider's consent page (dynamic client
//               registration + PKCE, redirect back to <origin>/oauth/callback)
//   oauth-app   the same, except the first time: a short form walks the owner
//               through registering the OAuth app (Google…) and takes the
//               client id + secret, then continues to consent
//   api-key /   a secure form. The key is verified against the service before
//   mcp-key     it is stored, and it never passes through the chat
//   browser     a live browser streamed to the phone: the owner signs in
//               themselves (2FA, human checks and all), taps Done, and the
//               session is saved for Ares's browser to reuse
//
// Unauthenticated on purpose — a phone's Safari is not carrying the gateway
// token. The flow id (24 random bytes) is the capability, like an OAuth state:
// unguessable, single-purpose, dead after FLOW_TTL_MS. Every page is no-store.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OAUTH_PROVIDERS,
  beginMcpConnect,
  browserSessionFile,
  browserSessionsDir,
  buildAuthorizeUrl,
  clientIdName,
  clientSecretName,
  exchangeCodeForTokens,
  getCredential,
  setCredential,
  setMcpServerToken,
  storeTokens,
  type ConnectBroker,
  type ConnectOutcome,
  type ConnectPrompt,
  type ConnectService,
} from "@ares/core";
import { acquireBrowserPage, findInstalledChromium } from "@ares/connectors";
import { LIFE_VERIFIERS as LIFE_SURFACE_VERIFIERS } from "./lifeVerifiers.js";
import { LIFE_VERIFIERS, type VerifyOutcome } from "./connectVerifiersLife.js";

const FLOW_TTL_MS = 15 * 60_000;
const BROWSER_IDLE_MS = 10 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;

interface Flow {
  id: string;
  /** Mutable: an OAuth server that refuses registration demotes to a token form. */
  service: ConnectService;
  reason?: string;
  createdAt: number;
  status: "pending" | "ok" | "failed";
  detail: string;
  waiters: Set<(outcome: ConnectOutcome) => void>;
  /** OAuth: where the landing page sends the owner, once it is known. */
  authorizeUrl?: string;
  finishOAuth?: (code: string) => Promise<string>;
  browser?: LoginBrowser;
  browserStarting?: Promise<LoginBrowser>;
}

/** A verifier may return `{store}` — the credentials to save INSTEAD of what
 *  was typed (Hue pairing, a claimed SimpleFIN token). */
type Verify = (values: Record<string, string>, signal: AbortSignal) => Promise<VerifyOutcome>;

export interface ConnectHubOptions {
  /** Public origin the phone reaches, e.g. https://ares.mistiqueai.com */
  publicUrl: () => string | undefined;
  home?: string;
  log?: (line: string) => void;
  /** Test seam: the Playwright module. */
  loadPlaywright?: () => Promise<any>;
  /** Test seam: service-specific key verification. */
  verifiers?: Record<string, Verify>;
}

export class ConnectHub implements ConnectBroker {
  private readonly flows = new Map<string, Flow>();
  /** OAuth state → flow id. */
  private readonly states = new Map<string, string>();
  private readonly log: (line: string) => void;
  private readonly verifiers: Record<string, Verify>;

  constructor(private readonly opts: ConnectHubOptions) {
    this.log = opts.log ?? (() => {});
    this.verifiers = { ...DEFAULT_VERIFIERS, ...(opts.verifiers ?? {}) };
  }

  private base(): string {
    const base = (this.opts.publicUrl() ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("this garrison has no public address yet, so the phone has nowhere to connect from");
    return base;
  }

  private redirectUri(): string {
    return `${this.base()}/oauth/callback`;
  }

  // ─── ConnectBroker ─────────────────────────────────────────────────────

  async start(service: ConnectService, opts: { reason?: string } = {}): Promise<ConnectPrompt> {
    this.sweep();
    const base = this.base();
    const flow: Flow = {
      id: randomBytes(24).toString("base64url"),
      service,
      ...(opts.reason ? { reason: opts.reason } : {}),
      createdAt: Date.now(),
      status: "pending",
      detail: "",
      waiters: new Set(),
    };
    // Prepare what can fail NOW, so the agent hears "Supabase refused dynamic
    // registration" instead of the owner meeting a broken page.
    if (service.kind === "mcp-oauth") {
      try {
        await this.prepareMcpOAuth(flow);
      } catch (err) {
        // Some servers only register clients with pre-approved redirects
        // (Vercel) or have no dynamic registration at all (GitHub). A token
        // pasted into the secure form still gets the owner connected — and it
        // is proven against the server's tools/list before it counts.
        const message = err instanceof Error ? err.message : String(err);
        if (!/registration|redirect/i.test(message)) throw err;
        flow.service = tokenFallback(service, message);
      }
    }
    if (service.kind === "oauth-app" && (await this.hasOAuthApp(service))) await this.prepareOAuthApp(flow);
    this.flows.set(flow.id, flow);
    this.log(`connect: ${service.id} flow started (${service.kind})`);
    return {
      flowId: flow.id,
      service: flow.service.id,
      label: flow.service.label,
      kind: flow.service.kind,
      url: `${base}/connect/${flow.id}`,
      instructions: instructionsFor(flow.service, Boolean(flow.authorizeUrl)),
    };
  }

  wait(flowId: string, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ConnectOutcome> {
    const flow = this.flows.get(flowId);
    if (!flow) return Promise.resolve({ ok: false, detail: "that connection link expired" });
    if (flow.status !== "pending") return Promise.resolve({ ok: flow.status === "ok", detail: flow.detail });
    return new Promise<ConnectOutcome>((resolve) => {
      let done = false;
      const settle = (outcome: ConnectOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        flow.waiters.delete(settle);
        resolve(outcome);
      };
      const onAbort = () => settle({ ok: false, detail: "the turn was stopped before the owner finished" });
      const timer = setTimeout(
        () => settle({ ok: false, detail: `the owner didn't finish within ${Math.round(opts.timeoutMs / 60_000)} minutes (the link stays valid a little longer — they can still finish, then ask again)` }),
        opts.timeoutMs,
      );
      timer.unref?.();
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
      flow.waiters.add(settle);
    });
  }

  private complete(flow: Flow, ok: boolean, detail: string): void {
    if (flow.status !== "pending") return;
    flow.status = ok ? "ok" : "failed";
    flow.detail = detail;
    this.log(`connect: ${flow.service.id} ${ok ? "connected" : `failed — ${detail}`}`);
    for (const waiter of [...flow.waiters]) waiter({ ok, detail });
    void flow.browser?.close();
  }

  private sweep(): void {
    const cutoff = Date.now() - FLOW_TTL_MS;
    for (const [id, flow] of this.flows) {
      if (flow.createdAt >= cutoff) continue;
      if (flow.status === "pending") this.complete(flow, false, "the connection link expired");
      void flow.browser?.close();
      this.flows.delete(id);
    }
    for (const [state, id] of this.states) if (!this.flows.has(id)) this.states.delete(state);
  }

  /** Close every live login browser (garrison shutdown). */
  async close(): Promise<void> {
    await Promise.all([...this.flows.values()].map((flow) => flow.browser?.close()));
  }

  // ─── OAuth preparation ─────────────────────────────────────────────────

  private async prepareMcpOAuth(flow: Flow): Promise<void> {
    const state = randomBytes(32).toString("hex");
    const begun = await beginMcpConnect(flow.service.mcpUrl!, {
      redirectUri: this.redirectUri(),
      state,
      name: flow.service.id,
      displayName: flow.service.label,
      home: this.opts.home,
    });
    flow.authorizeUrl = begun.authorizeUrl;
    flow.finishOAuth = async (code) => {
      const result = await begun.finish(code);
      return result.verified
        ? `${result.toolCount ?? 0} tools available.`
        : `Tokens stored, but the first tools/list check failed (${result.verifyError ?? "unknown"}) — try a call anyway.`;
    };
    this.states.set(state, flow.id);
  }

  private async hasOAuthApp(service: ConnectService): Promise<boolean> {
    const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
    if (!cfg) return false;
    return Boolean(
      (await getCredential(clientIdName(cfg), { home: this.opts.home })) &&
        (await getCredential(clientSecretName(cfg), { home: this.opts.home })),
    );
  }

  private async prepareOAuthApp(flow: Flow): Promise<void> {
    const cfg = flow.service.oauthProvider ? OAUTH_PROVIDERS[flow.service.oauthProvider] : undefined;
    if (!cfg) throw new Error(`${flow.service.label} has no OAuth provider configured`);
    const clientId = (await getCredential(clientIdName(cfg), { home: this.opts.home }))!;
    const redirectUri = this.redirectUri();
    const state = randomBytes(32).toString("hex");
    flow.authorizeUrl = buildAuthorizeUrl(cfg, { clientId, redirectUri, state });
    flow.finishOAuth = async (code) => {
      const clientSecret = (await getCredential(clientSecretName(cfg), { home: this.opts.home }))!;
      const tokens = await exchangeCodeForTokens(cfg, { code, clientId, clientSecret, redirectUri }, { home: this.opts.home });
      await storeTokens(cfg.provider, tokens, { home: this.opts.home });
      return "";
    };
    this.states.set(state, flow.id);
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  /** The provider's redirect. False when the state isn't one of ours (the
   *  caller then offers it to the older TunnelOAuth). */
  async handleCallback(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/oauth/callback") return false;
    const state = url.searchParams.get("state") ?? "";
    const flowId = this.states.get(state);
    if (!flowId) return false;
    this.states.delete(state);
    const flow = this.flows.get(flowId);
    if (!flow || flow.status !== "pending" || !flow.finishOAuth) {
      page(res, 400, resultPage(false, "Link expired", "Ask Ares to connect again."));
      return true;
    }
    const denied = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (denied || !code) {
      const why = denied === "access_denied" ? "You declined." : `The provider returned no code${denied ? ` (${denied})` : ""}.`;
      this.complete(flow, false, why);
      page(res, 400, resultPage(false, "Not connected", why));
      return true;
    }
    try {
      const detail = await flow.finishOAuth(code);
      this.complete(flow, true, detail);
      page(res, 200, resultPage(true, `${flow.service.label} connected`, "Ares is carrying on. You can go back to the app."));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.complete(flow, false, `the token exchange failed: ${message.slice(0, 200)}`);
      page(res, 500, resultPage(false, "Connection failed", message.slice(0, 200)));
    }
    return true;
  }

  /** Everything under /connect/. False when the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/connect\/([A-Za-z0-9_-]{20,64})(?:\/(frame|input|done|cancel))?\/?$/.exec(url.pathname);
    if (!match) return false;
    this.sweep();
    const flow = this.flows.get(match[1]!);
    const sub = match[2];
    if (!flow) {
      page(res, 404, resultPage(false, "Link expired", "Connection links last 15 minutes. Ask Ares to connect again."));
      return true;
    }
    if (flow.status !== "pending" && !sub) {
      page(res, 200, resultPage(flow.status === "ok", flow.status === "ok" ? `${flow.service.label} connected` : "Not connected", flow.detail || "You can go back to the app."));
      return true;
    }
    try {
      if (sub === "cancel" && req.method === "POST") {
        this.complete(flow, false, "the owner cancelled");
        json(res, 200, { ok: true });
        return true;
      }
      switch (flow.service.kind) {
        case "mcp-oauth":
          return this.landOAuth(res, flow);
        case "oauth-app":
          if (req.method === "POST") return await this.submitOAuthApp(req, res, flow);
          if (flow.authorizeUrl) return this.landOAuth(res, flow);
          page(res, 200, appSetupPage(flow, this.redirectUri()));
          return true;
        case "api-key":
        case "mcp-key":
          if (req.method === "POST") return await this.submitKeys(req, res, flow);
          page(res, 200, keyFormPage(flow));
          return true;
        case "browser":
          return await this.handleBrowser(req, res, flow, sub);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`connect: ${flow.service.id} page error — ${message}`);
      if (!res.headersSent) {
        if (sub) json(res, 500, { error: message.slice(0, 300) });
        else page(res, 500, resultPage(false, "Something broke", message.slice(0, 300)));
      }
      return true;
    }
  }

  private landOAuth(res: ServerResponse, flow: Flow): boolean {
    if (!flow.authorizeUrl) {
      page(res, 500, resultPage(false, "Not ready", "This connection has no sign-in page. Ask Ares to try again."));
      return true;
    }
    res.writeHead(302, { location: flow.authorizeUrl, "cache-control": "no-store" });
    res.end();
    return true;
  }

  private async submitOAuthApp(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    const cfg = flow.service.oauthProvider ? OAUTH_PROVIDERS[flow.service.oauthProvider] : undefined;
    if (!cfg) throw new Error("no OAuth provider for this service");
    const form = await readForm(req);
    const clientId = (form.client_id ?? "").trim();
    const clientSecret = (form.client_secret ?? "").trim();
    if (!clientId || !clientSecret) {
      page(res, 400, appSetupPage(flow, this.redirectUri(), "Both the Client ID and the Client secret are needed."));
      return true;
    }
    await setCredential(clientIdName(cfg), clientId, { home: this.opts.home });
    await setCredential(clientSecretName(cfg), clientSecret, { home: this.opts.home });
    await this.prepareOAuthApp(flow);
    // Straight on to the consent screen — one continuous flow for the owner.
    res.writeHead(303, { location: flow.authorizeUrl!, "cache-control": "no-store" });
    res.end();
    return true;
  }

  private async submitKeys(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    const form = await readForm(req);
    const service = flow.service;
    const fields = service.fields ?? [];
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = (form[field.credential] ?? "").trim();
      if (!value) {
        page(res, 400, keyFormPage(flow, `${field.label} is required.`));
        return true;
      }
      values[field.credential] = value;
    }
    const signal = AbortSignal.timeout(20_000);
    let detail = "";
    if (service.kind === "mcp-key") {
      const key = values[fields[0]!.credential]!;
      const result = await setMcpServerToken(service.mcpUrl!, key, {
        name: service.id,
        displayName: service.label,
        home: this.opts.home,
        ...(service.keyHeader ? { header: service.keyHeader } : {}),
      });
      if (!result.verified) {
        page(res, 400, keyFormPage(flow, `${service.label} didn't accept that key (${result.verifyError ?? "rejected"}).`));
        return true;
      }
      detail = `${result.toolCount ?? 0} tools available.`;
    } else {
      const verify = this.verifiers[service.id];
      let toStore = values;
      if (verify) {
        try {
          const outcome = await verify(values, signal);
          if (outcome && typeof outcome === "object") {
            detail = outcome.detail ?? "";
            if (outcome.store) toStore = outcome.store;
          } else detail = outcome ?? "";
        } catch (err) {
          page(res, 400, keyFormPage(flow, `${service.label} rejected that: ${err instanceof Error ? err.message : String(err)}`));
          return true;
        }
      }
      for (const [name, value] of Object.entries(toStore)) await setCredential(name, value, { home: this.opts.home });
    }
    this.complete(flow, true, detail);
    page(res, 200, resultPage(true, `${service.label} connected`, "Saved securely on your Ares. You can go back to the app."));
    return true;
  }

  // ─── Live browser sign-in ──────────────────────────────────────────────

  private async ensureBrowser(flow: Flow): Promise<LoginBrowser> {
    if (flow.browser) return flow.browser;
    flow.browserStarting ??= LoginBrowser.open(flow.service, this.opts.home, this.opts.loadPlaywright).then((browser) => {
      flow.browser = browser;
      return browser;
    });
    return flow.browserStarting;
  }

  private async handleBrowser(req: IncomingMessage, res: ServerResponse, flow: Flow, sub: string | undefined): Promise<boolean> {
    if (!sub) {
      page(res, 200, browserPage(flow));
      return true;
    }
    if (flow.status !== "pending") {
      json(res, 410, { error: "this sign-in is finished", status: flow.status });
      return true;
    }
    const browser = await this.ensureBrowser(flow);
    if (sub === "frame") {
      const frame = await browser.frame();
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": frame.jpeg.length,
        "cache-control": "no-store",
        "x-page-url": encodeURIComponent(frame.url),
        "x-page-title": encodeURIComponent(frame.title.slice(0, 120)),
      });
      res.end(frame.jpeg);
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "POST only" });
      return true;
    }
    if (sub === "input") {
      const body = await readJson(req);
      await browser.input(body);
      json(res, 200, { ok: true });
      return true;
    }
    if (sub === "done") {
      const saved = await browser.save();
      this.complete(flow, true, saved.cookies > 0 ? `Signed in to ${flow.service.label}; the session is saved for Ares's browser.` : `Saved, but ${flow.service.label} set no cookies — the sign-in may not have finished.`);
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: "unknown action" });
    return true;
  }
}

// ─── The login browser ───────────────────────────────────────────────────────

interface BrowserInput {
  type?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  dy?: number;
  url?: string;
}

const ALLOWED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Delete", "Space"]);

/** A throwaway browser the owner drives from their phone to sign in. Only its
 *  saved storage state outlives it. */
class LoginBrowser {
  private chain: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  private constructor(
    private readonly page: any,
    private readonly closeBrowser: () => Promise<void>,
    private readonly profileDir: string,
    private readonly service: ConnectService,
    private readonly home: string | undefined,
    private readonly viewport: { width: number; height: number },
  ) {
    this.touch();
  }

  static async open(service: ConnectService, home: string | undefined, loadPlaywright?: () => Promise<any>): Promise<LoginBrowser> {
    const moduleName = "playwright";
    const pw = loadPlaywright ? await loadPlaywright() : await import(moduleName);
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "ares-login-"));
    const viewport = { width: 412, height: 860 };
    const acquired = await acquireBrowserPage(pw, {
      discovery: false,
      executablePath: findInstalledChromium(),
      headless: true,
      userDataDir: profileDir,
      viewport,
      deviceScaleFactor: 2,
    });
    // Re-connecting? Start from the session we already have.
    try {
      const prior = JSON.parse(await fs.readFile(browserSessionFile(service.id, home), "utf8")) as { cookies?: unknown[] };
      if (Array.isArray(prior.cookies) && prior.cookies.length) await acquired.page.context().addCookies(prior.cookies);
    } catch {
      // first sign-in
    }
    await acquired.page.goto(service.loginUrl ?? `https://${service.domain}/`, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => undefined);
    return new LoginBrowser(acquired.page, acquired.close, profileDir, service, home, viewport);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), BROWSER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  frame(): Promise<{ jpeg: Buffer; url: string; title: string }> {
    this.touch();
    return this.serial(async () => ({
      jpeg: (await this.page.screenshot({ type: "jpeg", quality: 60, timeout: 10_000 })) as Buffer,
      url: String(this.page.url()),
      title: String(await this.page.title().catch(() => "")),
    }));
  }

  input(event: BrowserInput): Promise<void> {
    this.touch();
    return this.serial(async () => {
      switch (event.type) {
        case "tap": {
          const x = clamp01(event.x) * this.viewport.width;
          const y = clamp01(event.y) * this.viewport.height;
          await this.page.mouse.click(x, y);
          return;
        }
        case "type":
          if (typeof event.text === "string" && event.text.length <= 500) await this.page.keyboard.type(event.text, { delay: 25 });
          return;
        case "key":
          if (event.key && ALLOWED_KEYS.has(event.key)) await this.page.keyboard.press(event.key === "Space" ? " " : event.key);
          return;
        case "scroll":
          await this.page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(event.dy) || 0)));
          return;
        case "back":
          await this.page.goBack({ timeout: 15_000 }).catch(() => undefined);
          return;
        case "reload":
          await this.page.reload({ timeout: 20_000 }).catch(() => undefined);
          return;
        case "goto": {
          const target = typeof event.url === "string" ? event.url.trim() : "";
          if (/^https:\/\//i.test(target)) await this.page.goto(target, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => undefined);
          return;
        }
      }
    });
  }

  /** Persist the signed-in session where every Ares browser loads it. */
  save(): Promise<{ cookies: number }> {
    return this.serial(async () => {
      const state = (await this.page.context().storageState()) as { cookies?: unknown[] };
      const dir = browserSessionsDir(this.home);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = browserSessionFile(this.service.id, this.home);
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(tmp, file);
      return { cookies: Array.isArray(state.cookies) ? state.cookies.length : 0 };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.closeBrowser().catch(() => undefined);
    await fs.rm(this.profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Where to mint a token for servers that won't do OAuth with our redirect. */
const TOKEN_URLS: Record<string, string> = {
  vercel: "https://vercel.com/account/settings/tokens",
  github: "https://github.com/settings/personal-access-tokens/new",
  gitlab: "https://gitlab.com/-/user_settings/personal_access_tokens",
};

function tokenFallback(service: ConnectService, why: string): ConnectService {
  const keyUrl = service.keyUrl ?? TOKEN_URLS[service.id];
  return {
    ...service,
    kind: "mcp-key",
    blurb: `${service.label} doesn't allow a phone sign-in for Ares (${why.slice(0, 140)}). Paste an access token instead — it's checked against ${service.label} before it's saved.`,
    ...(keyUrl ? { keyUrl } : {}),
    fields: [{ credential: `mcp.key.${service.id}`, label: "Access token", secret: true, ...(keyUrl ? { help: `Create one at ${keyUrl}` } : {}) }],
  };
}

function clamp01(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

// ─── Key verification ────────────────────────────────────────────────────────

const DEFAULT_VERIFIERS: Record<string, Verify> = {
  ...LIFE_SURFACE_VERIFIERS,
  async twilio(values, signal) {
    const sid = values.TWILIO_ACCOUNT_SID!;
    const token = values.TWILIO_AUTH_TOKEN!;
    if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error("an Account SID starts with AC followed by 32 characters");
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      signal,
    });
    if (!res.ok) throw new Error(res.status === 401 ? "the SID and token don't match" : `Twilio answered HTTP ${res.status}`);
    const account = (await res.json()) as { friendly_name?: string; status?: string };
    return `Twilio account "${account.friendly_name ?? sid}" (${account.status ?? "active"}).`;
  },
  async "stripe-key"(values, signal) {
    const key = values.STRIPE_SECRET_KEY!;
    const res = await fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${key}` }, signal });
    if (!res.ok) throw new Error(res.status === 401 ? "Stripe doesn't recognise that key" : `Stripe answered HTTP ${res.status}`);
    return key.startsWith("sk_test_") || key.startsWith("rk_test_") ? "Test-mode key — no real charges." : "Live key.";
  },
  async resend(values, signal) {
    const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${values.RESEND_API_KEY}` }, signal });
    if (res.status === 401 || res.status === 403) throw new Error("Resend doesn't recognise that key");
    return "";
  },
  ...LIFE_VERIFIERS,
};

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_FORM_BYTES) throw new Error("form too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

async function readJson(req: IncomingMessage): Promise<BrowserInput> {
  try {
    const parsed = JSON.parse(await readBody(req)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as BrowserInput) : {};
  } catch {
    return {};
  }
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(html);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

// ─── Pages ───────────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function instructionsFor(service: ConnectService, oauthReady: boolean): string {
  switch (service.kind) {
    case "mcp-oauth":
      return `Sign in to ${service.label} and approve Ares.`;
    case "oauth-app":
      return oauthReady ? `Sign in to ${service.label} and approve Ares.` : `One-time setup: register an app for ${service.label}, then sign in.`;
    case "api-key":
    case "mcp-key":
      if (service.formHint && !service.fields?.length) return service.formHint;
      return `Enter your ${service.label} key in a secure form. It's stored on your Ares, never in the chat.`;
    case "browser":
      return `Sign in to ${service.label} on a live browser. Tap Done when you're in.`;
  }
}

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#eceff3;-webkit-font-smoothing:antialiased}
main{max-width:30rem;margin:0 auto;padding:1.5rem 1.25rem 3rem}
h1{font-size:1.35rem;margin:.25rem 0 .35rem}
p{color:#9aa3af;line-height:1.5;margin:.35rem 0}
.mark{width:3rem;height:3rem;border-radius:1rem;display:flex;align-items:center;justify-content:center;font-size:1.5rem;background:#1b1410;color:#ff8a3d;margin-bottom:.75rem}
label{display:block;font-size:.85rem;color:#c7cdd6;margin:1rem 0 .35rem}
input{width:100%;padding:.8rem .9rem;border-radius:.75rem;border:1px solid #2a3038;background:#12161b;color:#eceff3;font-size:1rem}
input:focus{outline:none;border-color:#ff8a3d}
.help{font-size:.8rem;color:#7d8693;margin-top:.3rem}
button,.btn{display:block;width:100%;margin-top:1.4rem;padding:.9rem;border:0;border-radius:.9rem;background:#ff7a2e;color:#1a0d05;font-weight:650;font-size:1rem;text-align:center;text-decoration:none}
.err{background:#2a1215;border:1px solid #5c2227;color:#ff9aa2;padding:.7rem .85rem;border-radius:.75rem;margin-top:1rem;font-size:.9rem}
ol{padding-left:1.2rem;color:#c7cdd6;line-height:1.55}
code{background:#12161b;border:1px solid #2a3038;padding:.15rem .35rem;border-radius:.4rem;font-size:.85rem;word-break:break-all;color:#ffb27a}
a{color:#ff9d5c}
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function resultPage(ok: boolean, title: string, detail: string): string {
  return shell(title, `<main style="text-align:center;padding-top:22vh"><div class="mark" style="margin:0 auto .9rem;${ok ? "background:#0f2119;color:#3fd18b" : "background:#2a1215;color:#ff6b75"}">${ok ? "✓" : "✕"}</div><h1>${esc(title)}</h1><p>${esc(detail)}</p></main>`);
}

function reasonLine(flow: Flow): string {
  return flow.reason ? `<p>Ares needs this ${esc(flow.reason)}.</p>` : "";
}

function keyFormPage(flow: Flow, error?: string): string {
  const service = flow.service;
  const fields = (service.fields ?? [])
    .map(
      (field) =>
        `<label for="${esc(field.credential)}">${esc(field.label)}</label><input id="${esc(field.credential)}" name="${esc(field.credential)}" ${field.secret ? 'type="password"' : 'type="text"'} autocomplete="off" autocapitalize="off" spellcheck="false" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} required>${field.help ? `<div class="help">${esc(field.help)}</div>` : ""}`,
    )
    .join("");
  // A zero-field form (Hue) is a pairing button: the hint is the whole page.
  const hint = service.formHint ? `<p><b>${esc(service.formHint)}</b></p>` : "";
  if (!service.fields?.length) {
    return shell(
      `Connect ${service.label}`,
      `<main><div class="mark">🔗</div><h1>Connect ${esc(service.label)}</h1>${reasonLine(flow)}<p>${esc(service.blurb)}</p>${hint}${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post"><button type="submit">Connect</button></form></main>`,
    );
  }
  const where = service.keyUrl ? `<p>Find it at <a href="${esc(service.keyUrl)}" target="_blank" rel="noopener">${esc(service.keyUrl.replace(/^https?:\/\//, ""))}</a>.</p>` : "";
  return shell(
    `Connect ${service.label}`,
    `<main><div class="mark">🔑</div><h1>Connect ${esc(service.label)}</h1>${reasonLine(flow)}<p>${esc(service.blurb)}</p>${hint}${where}${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post">${fields}<button type="submit">Connect</button></form><p class="help" style="margin-top:1rem">Stored encrypted on your Ares and checked with ${esc(service.label)} before saving. It never appears in the chat.</p></main>`,
  );
}

function appSetupPage(flow: Flow, redirectUri: string, error?: string): string {
  const setup = flow.service.appSetup;
  const steps = (setup?.steps ?? []).map((step) => `<li>${esc(step)}</li>`).join("");
  return shell(
    `Set up ${flow.service.label}`,
    `<main><div class="mark">🔗</div><h1>Connect ${esc(flow.service.label)}</h1>${reasonLine(flow)}<p>${esc(flow.service.label)} only lets Ares in through an app you own. This is a one-time setup; after it, reconnecting is one tap.</p>${setup ? `<p><a href="${esc(setup.consoleUrl)}" target="_blank" rel="noopener">Open the developer console ↗</a></p>` : ""}<ol>${steps}</ol><label>Redirect URI</label><code>${esc(redirectUri)}</code>${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post"><label for="client_id">Client ID</label><input id="client_id" name="client_id" autocomplete="off" autocapitalize="off" spellcheck="false" required><label for="client_secret">Client secret</label><input id="client_secret" name="client_secret" type="password" autocomplete="off" required><button type="submit">Save and sign in</button></form></main>`,
  );
}

function browserPage(flow: Flow): string {
  const label = esc(flow.service.label);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="robots" content="noindex"><title>Sign in to ${label}</title><style>${STYLE}
html,body{height:100%;overflow:hidden}
.top{position:fixed;top:0;left:0;right:0;padding:calc(env(safe-area-inset-top) + .5rem) .75rem .5rem;background:#0b0d10ee;display:flex;gap:.5rem;align-items:center;z-index:2;border-bottom:1px solid #1d2229}
.top .site{flex:1;min-width:0}
.top .site b{display:block;font-size:.95rem}
.top .site span{display:block;font-size:.72rem;color:#7d8693;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{border:0;border-radius:999px;padding:.55rem .9rem;font-weight:650;font-size:.9rem;margin:0;width:auto}
.done{background:#3fd18b;color:#04140c}
.cancel{background:#1b2027;color:#c7cdd6}
#stage{position:fixed;left:0;right:0;top:3.6rem;bottom:7.6rem;display:flex;align-items:flex-start;justify-content:center;background:#000;touch-action:none}
#screen{max-width:100%;max-height:100%;display:block;user-select:none;-webkit-user-select:none}
#spinner{position:absolute;top:40%;color:#7d8693;font-size:.9rem}
.bottom{position:fixed;left:0;right:0;bottom:0;padding:.5rem .6rem calc(env(safe-area-inset-bottom) + .5rem);background:#0b0d10;border-top:1px solid #1d2229}
.row{display:flex;gap:.4rem}
.row input{flex:1;margin:0;padding:.65rem .75rem;font-size:16px}
.row button{margin:0;width:auto;padding:.6rem .8rem;border-radius:.7rem;font-size:.9rem}
.keys{margin-top:.45rem}
.keys button{flex:1;background:#1b2027;color:#dfe4ea;font-weight:600}
.hint{font-size:.72rem;color:#7d8693;text-align:center;margin:.35rem 0 0}
</style></head><body>
<div class="top"><div class="site"><b>${label}</b><span id="where">Starting a browser…</span></div><button class="pill cancel" id="cancel">Cancel</button><button class="pill done" id="done">Done</button></div>
<div id="stage"><img id="screen" alt=""><div id="spinner">Opening ${label}…</div></div>
<div class="bottom">
<div class="row"><input id="text" type="text" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off" spellcheck="false"><button id="send">Send</button></div>
<div class="row keys"><button data-key="Enter">Enter</button><button data-key="Backspace">⌫</button><button data-key="Tab">Tab</button><button data-act="back">Back</button><button data-act="reload">↻</button></div>
<p class="hint">Tap the page to click, swipe to scroll. Sign in, then tap Done.</p>
</div>
<script>
(function(){
var base=location.pathname.replace(/\\/$/,'');
var img=document.getElementById('screen'),where=document.getElementById('where'),spin=document.getElementById('spinner');
var busy=false,stopped=false,kick=null;
function post(path,body){return fetch(base+'/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});}
function refresh(){
  if(stopped||busy)return;busy=true;
  fetch(base+'/frame',{cache:'no-store'}).then(function(r){
    if(r.status===410){stopped=true;where.textContent='Finished';return null;}
    if(!r.ok)throw new Error('frame '+r.status);
    var u=r.headers.get('x-page-url');if(u)where.textContent=decodeURIComponent(u);
    return r.blob();
  }).then(function(b){
    if(!b)return;var old=img.src;img.src=URL.createObjectURL(b);spin.style.display='none';if(old)URL.revokeObjectURL(old);
  }).catch(function(){where.textContent='Reconnecting…';}).then(function(){busy=false;if(!stopped)kick=setTimeout(refresh,450);});
}
function now(){clearTimeout(kick);setTimeout(refresh,120);}
var sx=0,sy=0,st=0;
img.addEventListener('touchstart',function(e){var t=e.touches[0];sx=t.clientX;sy=t.clientY;st=Date.now();},{passive:true});
img.addEventListener('touchend',function(e){
  var t=e.changedTouches[0],dy=t.clientY-sy,dx=t.clientX-sx;
  if(Math.abs(dy)>24&&Math.abs(dy)>Math.abs(dx)){post('input',{type:'scroll',dy:-dy*2.2}).then(now);return;}
  var r=img.getBoundingClientRect();post('input',{type:'tap',x:(t.clientX-r.left)/r.width,y:(t.clientY-r.top)/r.height}).then(now);
  e.preventDefault();
});
img.addEventListener('click',function(e){if(e.sourceCapabilities&&e.sourceCapabilities.firesTouchEvents)return;var r=img.getBoundingClientRect();post('input',{type:'tap',x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}).then(now);});
var text=document.getElementById('text');
function send(){var v=text.value;if(!v)return;text.value='';post('input',{type:'type',text:v}).then(now);}
document.getElementById('send').onclick=send;
text.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();send();}});
Array.prototype.forEach.call(document.querySelectorAll('[data-key]'),function(b){b.onclick=function(){post('input',{type:'key',key:b.getAttribute('data-key')}).then(now);};});
Array.prototype.forEach.call(document.querySelectorAll('[data-act]'),function(b){b.onclick=function(){post('input',{type:b.getAttribute('data-act')}).then(now);};});
function finish(path,msg){stopped=true;post(path).then(function(){document.body.innerHTML='<main style="text-align:center;padding-top:25vh"><h1>'+msg+'</h1><p>You can go back to the app.</p></main>';});}
document.getElementById('done').onclick=function(){finish('done','Signed in ✓');};
document.getElementById('cancel').onclick=function(){finish('cancel','Cancelled');};
refresh();
})();
</script></body></html>`;
}
