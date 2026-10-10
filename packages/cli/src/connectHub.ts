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
//   plaid       (an api-key service, routed specially) a one-time form for the
//               owner's Plaid keys, then Plaid's own Hosted Link bank picker —
//               see connectPlaid.ts
//
// Unauthenticated on purpose — a phone's Safari is not carrying the gateway
// token. The flow id (24 random bytes) is the capability, like an OAuth state:
// unguessable, single-purpose, dead after FLOW_TTL_MS. Every page is no-store.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OAUTH_PROVIDERS,
  browserSessionFile,
  browserSessionsDir,
  callbackParamsFromUrl,
  clientMetadataDocument,
  clientRequiresSecret,
  forgetOAuthClient,
  getCredential,
  isServiceConnected,
  matrixFor,
  resolveOAuthClient,
  saveOAuthClient,
  scrubOAuthText,
  setCredential,
  setMcpServerToken,
  setupCopy,
  type CallbackParams,
  type ConnectBrokerV2,
  type ConnectOutcome,
  type ConnectPlan,
  type ConnectPrompt,
  type ConnectService,
  type DeviceAuthorization,
  type PendingAuthorization,
  type PollResult,
  type SetupField,
  type SetupResult,
  type StartOptions,
  type StartResult,
} from "@ares/core";
import { rememberTest } from "./connectionsSafe.js";
import { clearMcpCacheError } from "./connectionsEnrich.js";
import { DEFAULT_LOOPBACK_REDIRECT, OAuthDriver, type Prepared } from "./connectOAuth.js";
import { acquireBrowserPage, findInstalledChromium } from "@ares/connectors";
import { LIFE_VERIFIERS as LIFE_SURFACE_VERIFIERS } from "./lifeVerifiers.js";
import { LIFE_VERIFIERS, type VerifyOutcome } from "./connectVerifiersLife.js";
import { DAV_VERIFIERS } from "./connectDav.js";
import { stdioVerifiers } from "./connectVerifiersStdio.js";
import { UNIVERSAL_VERIFIERS, apiVerifierFor } from "./connectVerifiersApi.js";
import { LIVE_INPUT_DOCK, LIVE_VIEW_CSS, applyBrowserInput, captureFrame, type BrowserInput } from "./liveBrowser.js";
import { PlaidLink, isPlaidService, plaidInstructions, plaidSetupBody, type PlaidFlowState } from "./connectPlaid.js";

const FLOW_TTL_MS = 15 * 60_000;
const BROWSER_IDLE_MS = 10 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;
/** The only custom-scheme return the garrison will ever redirect to. */
const APP_RETURN = "ares://oauth";

type Phase = "idle" | "setup" | "open" | "device" | "fields" | "unsupported" | "browser";

interface Flow {
  id: string;
  service: ConnectService;
  reason?: string;
  createdAt: number;
  status: "pending" | "ok" | "failed";
  detail: string;
  waiters: Set<(outcome: ConnectOutcome) => void>;
  /** What the flow is doing right now (drives the pages and the v2 answer). */
  phase: Phase;
  plan?: ConnectPlan;
  /** The caller speaks the v2 contract (the phone app that sent {v:2}). */
  v2: boolean;
  /** Redirect to ares://oauth after the callback so an in-app auth session closes by itself. */
  returnTo: boolean;
  /** OAuth: where the owner is sent, once it is known. */
  authorizeUrl?: string;
  /** The engine's pending authorization (state, verifier): in memory only. */
  pending?: PendingAuthorization;
  finish?: (params: CallbackParams) => Promise<string>;
  /** The redirect is a loopback address only the phone app can finish (POST /complete). */
  intercept?: { redirectPrefix: string };
  device?: { info: DeviceAuthorization; abort: AbortController; running: boolean; run: (signal: AbortSignal) => Promise<string> };
  /** Why the automatic path could not be used / the flow is unsupported (owner-facing, one sentence). */
  note?: string;
  experimental?: boolean;
  browser?: LoginBrowser;
  browserStarting?: Promise<LoginBrowser>;
  /** Plaid: the Hosted Link session (connectPlaid.ts). */
  plaid?: PlaidFlowState;
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
  /** Test seam: how often a pending Plaid flow polls /link/token/get. */
  plaidPollMs?: number;
  /** Test seams for the OAuth engine's HTTP, clock and device-poll wait. */
  engineFetch?: typeof fetch;
  engineSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  engineNow?: () => number;
  /** The loopback redirect the phone app intercepts (default http://localhost:53682/oauth/callback). */
  loopbackRedirect?: string;
}

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

export class ConnectHub implements ConnectBrokerV2 {
  private readonly flows = new Map<string, Flow>();
  /** OAuth state → flow id. */
  private readonly states = new Map<string, string>();
  private readonly log: (line: string) => void;
  private readonly verifiers: Record<string, Verify>;
  private readonly plaid: PlaidLink;
  private readonly driver: OAuthDriver;

  constructor(private readonly opts: ConnectHubOptions) {
    this.log = opts.log ?? (() => {});
    this.verifiers = { ...DEFAULT_VERIFIERS, ...stdioVerifiers(opts.home), ...(opts.verifiers ?? {}) };
    this.plaid = new PlaidLink({
      home: opts.home,
      log: this.log,
      ...(opts.plaidPollMs !== undefined ? { pollMs: opts.plaidPollMs } : {}),
      ttlMs: FLOW_TTL_MS,
      complete: (flow, ok, detail) => this.complete(flow as Flow, ok, detail),
      flows: () => this.flows.values(),
    });
    this.driver = new OAuthDriver({
      ...(opts.home ? { home: opts.home } : {}),
      base: () => this.base(),
      log: this.log,
      ...(opts.engineFetch ? { engineFetch: opts.engineFetch } : {}),
      ...(opts.engineSleep ? { sleep: opts.engineSleep } : {}),
      ...(opts.engineNow ? { now: opts.engineNow } : {}),
      ...(opts.loopbackRedirect ? { loopbackRedirect: opts.loopbackRedirect } : {}),
    });
  }

  private base(): string {
    const base = (this.opts.publicUrl() ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("this garrison has no public address yet, so the phone has nowhere to connect from");
    return base;
  }

  private redirectUri(): string {
    return `${this.base()}/oauth/callback`;
  }

  // ─── ConnectBroker (the v1 shape the Connect tool and the shipped app use) ──

  async start(service: ConnectService, opts: { reason?: string } = {}): Promise<ConnectPrompt> {
    const flow = await this.newFlow(service, { v2: false, returnTo: false, ...(opts.reason ? { reason: opts.reason } : {}) });
    return {
      flowId: flow.id,
      service: flow.service.id,
      label: flow.service.label,
      kind: flow.service.kind,
      url: `${this.base()}/connect/${flow.id}`,
      instructions: isPlaidService(flow.service) ? plaidInstructions(flow) : instructionsFor(flow),
    };
  }

  /** Create the flow and prepare whatever can fail NOW, so the caller hears
   *  "this server refused" instead of the owner meeting a broken page. */
  private async newFlow(service: ConnectService, o: { v2: boolean; returnTo: boolean; reason?: string; mode?: "oauth" | "browser" }): Promise<Flow> {
    this.sweep();
    const base = this.base();
    const flow: Flow = {
      id: randomBytes(24).toString("base64url"),
      service,
      ...(o.reason ? { reason: o.reason } : {}),
      createdAt: Date.now(),
      status: "pending",
      detail: "",
      waiters: new Set(),
      phase: "idle",
      v2: o.v2,
      returnTo: o.returnTo,
    };
    if (o.mode === "browser") {
      // Explicitly asked for the experimental live-browser session.
      const fallback = service.browserFallback;
      flow.service = fallback ? { ...service, kind: "browser", loginUrl: fallback.loginUrl, domain: fallback.domain } : service;
      flow.phase = "browser";
      flow.experimental = true;
    } else if (isPlaidService(service)) {
      // Plaid with keys already set: straight to the bank picker (one tap).
      flow.phase = "fields";
      if (await this.plaid.hasKeys()) await this.plaid.prepare(flow, base);
    } else {
      await this.prepareFlow(flow);
    }
    this.flows.set(flow.id, flow);
    this.log(`connect: ${flow.service.id} flow started (${flow.service.kind}, ${flow.phase}${flow.v2 ? ", v2" : ""})`);
    return flow;
  }

  private async prepareFlow(flow: Flow): Promise<void> {
    const service = flow.service;
    const plan = await this.driver.plan(service);
    flow.plan = plan;
    switch (service.kind) {
      case "mcp-oauth":
      case "oauth-app": {
        const prepared = await this.driver.prepare(service, plan, { v2: flow.v2 });
        this.adopt(flow, prepared);
        return;
      }
      case "api-key":
      case "mcp-key":
        flow.phase = "fields";
        return;
      case "browser":
        // The shipped app expects the live browser; a v2 client is told the truth.
        if (flow.v2) {
          flow.phase = "unsupported";
          flow.note = plan.reason;
        } else flow.phase = "browser";
        return;
    }
  }

  private adopt(flow: Flow, prepared: Prepared): void {
    switch (prepared.kind) {
      case "code":
        flow.phase = "open";
        flow.authorizeUrl = prepared.authorizeUrl;
        flow.pending = prepared.pending;
        flow.finish = prepared.finish;
        if (prepared.intercept) flow.intercept = prepared.intercept;
        this.states.set(prepared.pending.state, flow.id);
        return;
      case "device":
        flow.phase = "device";
        flow.device = { info: prepared.device, abort: new AbortController(), running: false, run: prepared.run };
        return;
      case "setup":
        flow.phase = "setup";
        if (prepared.reason) flow.note = prepared.reason;
        return;
      case "unsupported":
        flow.phase = "unsupported";
        flow.note = prepared.reason;
        return;
    }
  }

  /** Begin polling the provider for a device code (once). */
  private runDevice(flow: Flow): void {
    const d = flow.device;
    if (!d || d.running || flow.status !== "pending") return;
    d.running = true;
    void d
      .run(d.abort.signal)
      .then((detail) => this.complete(flow, true, detail))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (d.abort.signal.aborted) return;
        const denied = /access_denied|denied/i.test(message);
        this.complete(flow, false, denied ? "You declined." : /expired/i.test(message) ? "The code expired before it was approved." : scrubOAuthText(message, 160));
      });
  }

  wait(flowId: string, opts: { signal: AbortSignal; timeoutMs: number }): Promise<ConnectOutcome> {
    const flow = this.flows.get(flowId);
    if (!flow) return Promise.resolve({ ok: false, detail: "that connection link expired" });
    if (flow.status !== "pending") return Promise.resolve({ ok: flow.status === "ok", detail: flow.detail });
    if (flow.phase === "device") this.runDevice(flow);
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
    if (ok) {
      // A successful connect is the newest evidence: overwrite the stored health
      // with green now, and drop the stale cached tool-list failure (the
      // "rejected the connection (HTTP 401)" latch) so it cannot come back.
      rememberTest(this.opts.home, flow.service.id, { ok: true, detail: "connected", checkedAt: Date.now() });
      void clearMcpCacheError(flow.service.id, this.opts.home);
    }
    // No token, code or URL ever reaches a log line: the service id and the verdict only.
    this.log(`connect: ${flow.service.id} ${ok ? "connected" : `failed: ${scrubOAuthText(detail, 120)}`}`);
    flow.device?.abort.abort();
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

  /** Close every live login browser and stop every device poll (garrison shutdown). */
  async close(): Promise<void> {
    for (const flow of this.flows.values()) flow.device?.abort.abort();
    await Promise.all([...this.flows.values()].map((flow) => flow.browser?.close()));
  }

  // ─── ConnectBrokerV2: the phone contract (docs/CONNECTIONS-OAUTH.md section 1) ──

  async startV2(service: ConnectService, opts: StartOptions = {}): Promise<StartResult> {
    const label = service.label;
    if (!opts.reconnect && opts.mode !== "browser" && (await isServiceConnected(service, this.opts.home).catch(() => false))) {
      return { state: "connected", service: service.id, label };
    }
    const flow = await this.newFlow(service, { v2: true, returnTo: opts.returnTo === APP_RETURN, ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.mode ? { mode: opts.mode } : {}) });
    return this.startResultOf(flow);
  }

  private startResultOf(flow: Flow): StartResult {
    const service = flow.service;
    const label = service.label;
    const plan = flow.plan;
    switch (flow.phase) {
      case "open":
        return {
          state: "open",
          service: service.id,
          label,
          url: flow.authorizeUrl!,
          pollId: flow.id,
          ...(flow.returnTo ? { returnTo: APP_RETURN as "ares://oauth" } : {}),
          ...(flow.intercept ? { intercept: flow.intercept } : {}),
        };
      case "browser":
        return { state: "open", service: service.id, label, url: `${this.base()}/connect/${flow.id}`, pollId: flow.id, experimental: true };
      case "device": {
        const d = flow.device!;
        this.runDevice(flow);
        return {
          state: "device",
          service: service.id,
          label,
          userCode: d.info.userCode,
          verificationUrl: d.info.verificationUri,
          ...(d.info.verificationUriComplete ? { verificationUrlComplete: d.info.verificationUriComplete } : {}),
          expiresInSec: Math.max(1, Math.round((d.info.expiresAt - Date.now()) / 1000)),
          intervalSec: d.info.intervalSec,
          pollId: flow.id,
        };
      }
      case "setup":
        return this.setupResultOf(flow);
      case "fields": {
        const fields: SetupField[] = (service.fields ?? []).map((f) => ({ key: f.credential, label: f.label, secret: Boolean(f.secret), hint: f.help ?? f.placeholder ?? "", ...(f.optional ? { optional: true } : {}) }));
        return {
          state: "fields",
          service: service.id,
          label,
          notOAuth: true,
          reason: plan?.reason ?? "this service has no OAuth for personal use: it only issues API keys",
          fields,
          submit: "/gateway/connections/setup",
          url: `${this.base()}/connect/${flow.id}`,
          ...(service.formHint ? { hint: service.formHint } : {}),
        };
      }
      case "unsupported": {
        const alt = plan?.browserAlternative;
        return {
          state: "unsupported",
          service: service.id,
          label,
          reason: flow.note ?? plan?.reason ?? `${label} cannot be connected with OAuth`,
          ...(alt ? { alternative: { mode: "browser" as const, label: alt.label, experimental: true as const } } : {}),
        };
      }
      default:
        throw new Error("this connection could not be prepared");
    }
  }

  private setupResultOf(flow: Flow): StartResult {
    const service = flow.service;
    const plan = flow.plan!;
    const device = plan.device;
    const redirectUri = device ? undefined : this.redirectUri();
    const copy = setupCopy(service, plan, redirectUri);
    const cfg = plan.provider ? OAUTH_PROVIDERS[plan.provider] : undefined;
    const scopes = cfg?.scopes?.length ? cfg.scopes : plan.entry?.scopes ?? [];
    const fields: SetupField[] = plan.setupFields.map((f) =>
      f.key === "client_id"
        ? { key: "client_id", label: device ? "Client ID" : "Client ID", secret: false, hint: "Copy it from the app you just registered." }
        : { key: "client_secret", label: "Client secret", secret: true, hint: f.optional ? "Leave empty for a public client." : "Shown once on the app's page; paste it here.", ...(f.optional ? { optional: true } : {}) },
    );
    return {
      state: "setup",
      service: service.id,
      label: service.label,
      ...(redirectUri ? { redirectUri } : {}),
      scopes,
      ...(copy.consoleUrl ? { consoleUrl: copy.consoleUrl } : {}),
      ...(copy.appType ? { appType: copy.appType } : {}),
      steps: copy.steps,
      fields,
      notes: copy.notes,
      ...(flow.note ? { reason: flow.note } : {}),
    };
  }

  pollFlow(pollId: string): PollResult | null {
    const flow = this.flows.get(pollId);
    if (!flow) return null;
    const service = flow.service.id;
    if (flow.status === "ok") return { state: "connected", service };
    if (flow.status === "failed") return { state: /expired/i.test(flow.detail) ? "expired" : "failed", service, error: scrubOAuthText(flow.detail, 160) };
    if (Date.now() - flow.createdAt > FLOW_TTL_MS) return { state: "expired", service };
    if (flow.phase === "device") this.runDevice(flow);
    return { state: "pending", service };
  }

  /** The app intercepted a loopback redirect and hands it over. */
  async completeFlow(pollId: string, redirectUrl: string): Promise<PollResult | null> {
    const flow = this.flows.get(pollId);
    if (!flow) return null;
    if (flow.status !== "pending" || !flow.finish || !flow.intercept || !flow.pending) return this.pollFlow(pollId);
    let params: CallbackParams;
    try {
      if (!redirectUrl.startsWith(flow.intercept.redirectPrefix)) throw new Error("not the redirect this flow registered");
      params = callbackParamsFromUrl(redirectUrl);
    } catch {
      return { state: "failed", service: flow.service.id, error: "that is not the redirect this sign-in was waiting for" };
    }
    // The state must be THIS flow's: bound at start, single use.
    if (!params.state || this.states.get(params.state) !== flow.id) return { state: "failed", service: flow.service.id, error: "the redirect did not match this sign-in" };
    this.states.delete(params.state);
    try {
      this.complete(flow, true, await flow.finish(params));
    } catch (err) {
      this.complete(flow, false, failureText(err));
    }
    return this.pollFlow(pollId);
  }

  /** Store a one-time client registration, or verify + store an API-key fallback. */
  async setupService(service: ConnectService, values: Record<string, unknown>, opts: { clear?: boolean } = {}): Promise<SetupResult> {
    const plan = await this.driver.plan(service);
    const provider = plan.provider;
    if (opts.clear) {
      if (!provider) return { ok: false, error: `${service.label} has no registered app to clear` };
      await forgetOAuthClient(provider, { ...(this.opts.home ? { home: this.opts.home } : {}) });
      return { ok: true, state: "cleared" };
    }
    const text = (k: string): string => (typeof values[k] === "string" ? (values[k] as string).trim() : "");
    if (plan.start === "fields" || service.kind === "api-key" || service.kind === "mcp-key") {
      const typed: Record<string, string> = {};
      for (const f of service.fields ?? []) {
        const v = text(f.credential);
        if (!v && !f.optional) return { ok: false, error: `${f.label} is required.` };
        if (v) typed[f.credential] = v;
      }
      try {
        const detail = await this.verifyAndStore(service, typed);
        return { ok: true, state: "connected", ...(detail ? { detail } : {}) };
      } catch (err) {
        return { ok: false, error: `${service.label} rejected that: ${scrubOAuthText(err instanceof Error ? err.message : String(err), 140)}` };
      }
    }
    if (!provider) return { ok: false, error: `${service.label} does not take a registered app` };
    const clientId = text("client_id");
    const clientSecret = text("client_secret");
    if (!clientId) return { ok: false, error: "The Client ID is required." };
    if (clientRequiresSecret(provider, plan.entry) && !clientSecret) return { ok: false, error: "This vendor needs the Client secret too." };
    try {
      await saveOAuthClient(provider, { clientId, ...(clientSecret ? { clientSecret } : {}) }, { ...(this.opts.home ? { home: this.opts.home } : {}) });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "that does not look like a client id" };
    }
    this.log(`connect: ${service.id} client registered (${provider})`);
    return { ok: true, state: "ready", next: "start" };
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  /** The provider's redirect (and the public client metadata document). False
   *  when the state isn't one of ours (the caller then offers it to the older
   *  TunnelOAuth). */
  async handleCallback(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/oauth/client.json") {
      // Public by design: it names the client and the one redirect it may use.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(clientMetadataDocument(this.base(), [this.redirectUri()])));
      return true;
    }
    if (url.pathname !== "/oauth/callback") return false;
    const state = url.searchParams.get("state") ?? "";
    const flowId = this.states.get(state);
    if (!flowId) return false;
    this.states.delete(state); // single use: a replay of this URL finds nothing
    const flow = this.flows.get(flowId);
    if (!flow || flow.status !== "pending" || !flow.finish) {
      this.respondResult(res, flow, false, "Link expired", "Ask Ares to connect again.", 400);
      return true;
    }
    const params = callbackParamsFromUrl(url.toString());
    if (params.error || !params.code) {
      const why = params.error === "access_denied" ? "You declined." : `The provider returned no code${params.error ? ` (${scrubOAuthText(params.error, 40)})` : ""}.`;
      this.complete(flow, false, why);
      this.respondResult(res, flow, false, "Not connected", why, 400);
      return true;
    }
    try {
      const detail = await flow.finish(params);
      this.complete(flow, true, detail);
      this.respondResult(res, flow, true, `${flow.service.label} connected`, "Ares is carrying on. You can go back to the app.", 200);
    } catch (err) {
      const message = failureText(err);
      this.complete(flow, false, message);
      this.respondResult(res, flow, false, "Connection failed", message, 500);
    }
    return true;
  }

  /** The browser's last page: a 302 into the app (ares://oauth) when the app asked for it, else HTML. */
  private respondResult(res: ServerResponse, flow: Flow | undefined, ok: boolean, title: string, detail: string, status: number): void {
    if (flow?.returnTo) {
      const back = `${APP_RETURN}?${new URLSearchParams({ service: flow.service.id, state: ok ? "connected" : "failed", pollId: flow.id }).toString()}`;
      res.writeHead(302, { location: back, "cache-control": "no-store" });
      res.end();
      return;
    }
    const link = flow ? `${APP_RETURN}?${new URLSearchParams({ service: flow.service.id, state: ok ? "connected" : "failed", pollId: flow.id }).toString()}` : undefined;
    page(res, status, resultPage(ok, title, detail, link));
  }

  /** Everything under /connect/. False when the path isn't ours. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (await this.plaid.handleShared(req, res, url, { page, resultPage })) return true;
    const match = /^\/connect\/([A-Za-z0-9_-]{20,64})(?:\/(frame|input|done|cancel|status))?\/?$/.exec(url.pathname);
    if (!match) return false;
    this.sweep();
    const flow = this.flows.get(match[1]!);
    const sub = match[2];
    if (!flow) {
      page(res, 404, resultPage(false, "Link expired", "Connection links last 15 minutes. Ask Ares to connect again."));
      return true;
    }
    if (sub === "status") {
      json(res, 200, this.pollFlow(flow.id) ?? { state: "expired" });
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
      if (isPlaidService(flow.service)) return await this.handlePlaid(req, res, flow);
      if (flow.phase === "browser") return await this.handleBrowser(req, res, flow, sub);
      switch (flow.service.kind) {
        case "mcp-oauth":
        case "oauth-app":
          return await this.handleOAuthPage(req, res, flow);
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
      this.log(`connect: ${flow.service.id} page error — ${scrubOAuthText(message, 120)}`);
      if (!res.headersSent) {
        if (sub) json(res, 500, { error: scrubOAuthText(message, 300) });
        else page(res, 500, resultPage(false, "Something broke", scrubOAuthText(message, 300)));
      }
      return true;
    }
  }

  /** The hub page for an OAuth flow: consent redirect, device code, setup form or an honest dead end. */
  private async handleOAuthPage(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    if (req.method === "POST" && flow.phase === "setup") return this.submitSetupForm(req, res, flow);
    switch (flow.phase) {
      case "open":
        return this.landOAuth(res, flow);
      case "device":
        this.runDevice(flow);
        page(res, 200, devicePage(flow));
        return true;
      case "setup":
        page(res, 200, setupPage(flow, this.setupResultOf(flow) as Extract<StartResult, { state: "setup" }>));
        return true;
      case "unsupported":
        page(res, 200, resultPage(false, `${flow.service.label} can't be connected here`, flow.note ?? flow.plan?.reason ?? "There is no sign-in for this service."));
        return true;
      default:
        page(res, 500, resultPage(false, "Not ready", "This connection has no sign-in page. Ask Ares to try again."));
        return true;
    }
  }

  /** Plaid: the setup form until keys exist, then Plaid's Hosted Link. */
  private async handlePlaid(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    const base = this.base();
    if (req.method === "POST" && !flow.plaid) {
      const outcome = await this.plaid.submitSetup(flow, await readForm(req), base);
      if ("error" in outcome) page(res, 400, shell("Connect your bank", plaidSetupBody(flow, base, outcome.error)));
      else {
        res.writeHead(303, { location: outcome.url, "cache-control": "no-store" });
        res.end();
      }
      return true;
    }
    if (flow.plaid) {
      this.plaid.startPolling(flow);
      res.writeHead(302, { location: flow.plaid.hostedUrl, "cache-control": "no-store" });
      res.end();
      return true;
    }
    page(res, 200, shell("Connect your bank", plaidSetupBody(flow, base)));
    return true;
  }

  private landOAuth(res: ServerResponse, flow: Flow): boolean {
    if (!flow.authorizeUrl) {
      page(res, 500, resultPage(false, "Not ready", "This connection has no sign-in page. Ask Ares to try again."));
      return true;
    }
    if (flow.intercept) {
      // A loopback redirect only the phone app can finish: a plain browser would dead-end.
      page(res, 200, resultPage(false, "Open this from the Ares app", `${flow.service.label} only accepts a sign-in that the Ares app completes. Start the connection from the Connections screen.`));
      return true;
    }
    res.writeHead(302, { location: flow.authorizeUrl, "cache-control": "no-store" });
    res.end();
    return true;
  }

  /** The form on the hub's setup page: store the client, then straight on to consent / the device code. */
  private async submitSetupForm(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    const form = await readForm(req);
    const outcome = await this.setupService(flow.service, { client_id: form.client_id ?? "", client_secret: form.client_secret ?? "" });
    if (!outcome.ok) {
      page(res, 400, setupPage(flow, this.setupResultOf(flow) as Extract<StartResult, { state: "setup" }>, outcome.error));
      return true;
    }
    await this.prepareFlow(flow);
    if (flow.phase === "open" && flow.authorizeUrl && !flow.intercept) {
      res.writeHead(303, { location: flow.authorizeUrl, "cache-control": "no-store" });
      res.end();
      return true;
    }
    if (flow.phase === "device") {
      this.runDevice(flow);
      page(res, 200, devicePage(flow));
      return true;
    }
    page(res, 200, flow.phase === "setup" ? setupPage(flow, this.setupResultOf(flow) as Extract<StartResult, { state: "setup" }>, "Saved, but the sign-in could not start. Check the values and try again.") : resultPage(false, "Not ready", flow.note ?? "The sign-in could not start."));
    return true;
  }

  /** Verify against the vendor where a check exists, then store. Returns the detail line. Throws the vendor's refusal. */
  private async verifyAndStore(service: ConnectService, values: Record<string, string>): Promise<string> {
    const fields = service.fields ?? [];
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
      if (!result.verified) throw new Error(`didn't accept that key (${result.verifyError ?? "rejected"})`);
      return `${result.toolCount ?? 0} tools available.`;
    }
    const verify = this.verifiers[service.id] ?? apiVerifierFor(service.id, this.opts.home);
    let toStore = values;
    if (verify) {
      const outcome = await verify(values, signal);
      if (outcome && typeof outcome === "object") {
        detail = outcome.detail ?? "";
        if (outcome.store) toStore = outcome.store;
      } else detail = outcome ?? "";
    }
    for (const [name, value] of Object.entries(toStore)) await setCredential(name, value, { home: this.opts.home });
    return detail;
  }

  private async submitKeys(req: IncomingMessage, res: ServerResponse, flow: Flow): Promise<boolean> {
    const form = await readForm(req);
    const service = flow.service;
    const values: Record<string, string> = {};
    for (const field of service.fields ?? []) {
      const value = (form[field.credential] ?? "").trim();
      if (!value && field.optional) continue;
      if (!value) {
        page(res, 400, keyFormPage(flow, `${field.label} is required.`));
        return true;
      }
      values[field.credential] = value;
    }
    let detail: string;
    try {
      detail = await this.verifyAndStore(service, values);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      page(res, 400, keyFormPage(flow, service.kind === "mcp-key" ? `${service.label} ${message}.` : `${service.label} rejected that: ${message}`));
      return true;
    }
    this.complete(flow, true, detail);
    page(res, 200, resultPage(true, `${service.label} connected`, "Saved securely on your Ares. You can go back to the app."));
    return true;
  }

  // ─── Live browser sign-in ──────────────────────────────────────────────

  private async ensureBrowser(flow: Flow): Promise<LoginBrowser> {
    if (flow.browser) return flow.browser;
    flow.browserStarting ??= LoginBrowser.open(flow.service, this.opts.home, this.opts.loadPlaywright).then(
      (browser) => {
        flow.browser = browser;
        return browser;
      },
      (err) => {
        // A failed start must not be cached: the next frame poll (or a fix on the box) can try again.
        flow.browserStarting = undefined;
        throw err;
      },
    );
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
    const pw = loadPlaywright ? await loadPlaywright() : await importPlaywright();
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
    return this.serial(() => captureFrame(this.page));
  }

  input(event: BrowserInput): Promise<void> {
    this.touch();
    return this.serial(() => applyBrowserInput(this.page, this.viewport, event));
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

// ─── Key verification ────────────────────────────────────────────────────────

export const DEFAULT_VERIFIERS: Record<string, Verify> = {
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
    const body = (await res.json().catch(() => ({}))) as { name?: string };
    // A send-only ("sending access") key can't list domains: Resend answers 401
    // restricted_api_key — a REAL key, exactly what Ares needs to send.
    if (body.name === "restricted_api_key") return "Send-only key — that's all sending email needs.";
    // An unknown key is HTTP 400 "API key is invalid" (found by the connector
    // doctor: only 401/403 were treated as rejection, so a typo was accepted).
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error("Resend doesn't recognise that key");
    if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}`);
    return "";
  },
  ...LIFE_VERIFIERS,
  ...DAV_VERIFIERS,
  ...UNIVERSAL_VERIFIERS,
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

export async function readJson(req: IncomingMessage): Promise<BrowserInput> {
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

export function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  res.end(html);
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function instructionsFor(flow: Flow): string {
  const service = flow.service;
  switch (flow.phase) {
    case "open":
      return flow.intercept ? `Sign in to ${service.label} from the Ares app and approve Ares.` : `Sign in to ${service.label} and approve Ares.`;
    case "device":
      return `Open ${flow.device!.info.verificationUri} and enter the code ${flow.device!.info.userCode}; then approve Ares.`;
    case "setup":
      return `One-time setup: register an app for ${service.label} (the page shows exactly how), then sign in.`;
    case "unsupported":
      return flow.note ?? `${service.label} can't be connected with OAuth.`;
    case "browser":
      return `Sign in to ${service.label} on a live browser (experimental). Tap Done when you're in.`;
    default:
      break;
  }
  switch (service.kind) {
    case "mcp-oauth":
      return `Sign in to ${service.label} and approve Ares.`;
    case "oauth-app":
      return `Sign in to ${service.label} and approve Ares.`;
    case "api-key":
    case "mcp-key":
      if (service.formHint && !service.fields?.length) return service.formHint;
      return `${service.label} has no OAuth for personal use, so it takes an API key. Enter it in a secure form; it's stored on your Ares, never in the chat.`;
    case "browser":
      return `Sign in to ${service.label} on a live browser. Tap Done when you're in.`;
  }
}

export const STYLE = `
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
.note{background:#14181d;border:1px solid #2a3038;color:#c7cdd6;padding:.7rem .85rem;border-radius:.75rem;margin-top:1rem;font-size:.85rem;line-height:1.45}
.code{font:700 2rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.15em;text-align:center;background:#12161b;border:1px solid #2a3038;border-radius:1rem;padding:1rem;margin:1rem 0;color:#ffb27a}
ol{padding-left:1.2rem;color:#c7cdd6;line-height:1.55}
code{background:#12161b;border:1px solid #2a3038;padding:.15rem .35rem;border-radius:.4rem;font-size:.85rem;word-break:break-all;color:#ffb27a}
a{color:#ff9d5c}
`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function resultPage(ok: boolean, title: string, detail: string, appLink?: string): string {
  const back = appLink ? `<a class="btn" href="${esc(appLink)}">Return to Ares</a>` : "";
  return shell(title, `<main style="text-align:center;padding-top:22vh"><div class="mark" style="margin:0 auto .9rem;${ok ? "background:#0f2119;color:#3fd18b" : "background:#2a1215;color:#ff6b75"}">${ok ? "✓" : "✕"}</div><h1>${esc(title)}</h1><p>${esc(detail)}</p>${back}</main>`);
}

function reasonLine(flow: Flow): string {
  return flow.reason ? `<p>Ares needs this ${esc(flow.reason)}.</p>` : "";
}

function keyFormPage(flow: Flow, error?: string): string {
  const service = flow.service;
  const fields = (service.fields ?? [])
    .map(
      (field) =>
        `<label for="${esc(field.credential)}">${esc(field.label)}</label><input id="${esc(field.credential)}" name="${esc(field.credential)}" ${field.secret ? 'type="password"' : 'type="text"'} autocomplete="off" autocapitalize="off" spellcheck="false" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} ${field.optional ? "" : "required"}>${field.help ? `<div class="help">${esc(field.help)}</div>` : ""}`,
    )
    .join("");
  // A zero-field form (Hue) is a pairing button: the hint is the whole page.
  const hint = service.formHint ? `<p><b>${esc(service.formHint)}</b></p>` : "";
  // The honest label: this is NOT a sign-in. Only services with no OAuth at all reach this page.
  const notOAuth = !service.id.startsWith("login:") ? `<div class="note">Not OAuth: ${esc(flow.plan?.reason ?? `${service.label} has no OAuth for personal use, so it takes an API key.`)}</div>` : "";
  if (!service.fields?.length) {
    return shell(
      `Connect ${service.label}`,
      `<main><div class="mark">🔗</div><h1>Connect ${esc(service.label)}</h1>${reasonLine(flow)}<p>${esc(service.blurb)}</p>${hint}${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post"><button type="submit">Connect</button></form></main>`,
    );
  }
  const where = service.keyUrl ? `<p>Find it at <a href="${esc(service.keyUrl)}" target="_blank" rel="noopener">${esc(service.keyUrl.replace(/^https?:\/\//, ""))}</a>.</p>` : "";
  return shell(
    `Connect ${service.label}`,
    `<main><div class="mark">🔑</div><h1>Connect ${esc(service.label)}</h1>${reasonLine(flow)}<p>${esc(service.blurb)}</p>${notOAuth}${hint}${where}${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post">${fields}<button type="submit">Connect</button></form><p class="help" style="margin-top:1rem">${service.id.startsWith("login:") ? `Stored encrypted on your Ares. Ares fills it into ${esc(service.domain ?? service.label)} only after you approve each sign-in, and can't see or repeat it.` : `Stored encrypted on your Ares and checked with ${esc(service.label)} before saving. It never appears in the chat.`}</p></main>`,
  );
}

/** The one-time "register an app" page. Matrix-driven: exact steps, redirect URI (or none for device flow), the fields it takes. NEVER a token field. */
function setupPage(flow: Flow, setup: Extract<StartResult, { state: "setup" }>, error?: string): string {
  const steps = setup.steps.map((step) => `<li>${esc(step.body)}</li>`).join("");
  const inputs = setup.fields
    .map(
      (f) =>
        `<label for="${esc(f.key)}">${esc(f.label)}${f.optional ? " (optional)" : ""}</label><input id="${esc(f.key)}" name="${esc(f.key)}" ${f.secret ? 'type="password"' : ""} autocomplete="off" autocapitalize="off" spellcheck="false" ${f.optional ? "" : "required"}><div class="help">${esc(f.hint)}</div>`,
    )
    .join("");
  const notes = setup.notes.map((n) => `<div class="note">${esc(n)}</div>`).join("");
  const reason = setup.reason ? `<div class="note">${esc(setup.reason)}.</div>` : "";
  return shell(
    `Set up ${flow.service.label}`,
    `<main><div class="mark">🔗</div><h1>Connect ${esc(flow.service.label)}</h1>${reasonLine(flow)}<p>${esc(flow.service.label)} only lets Ares in through an app you register once. After this, reconnecting is one tap.</p>${reason}${setup.consoleUrl ? `<p><a href="${esc(setup.consoleUrl)}" target="_blank" rel="noopener">Open the developer console ↗</a></p>` : ""}${setup.appType ? `<p>App type: <b>${esc(setup.appType)}</b></p>` : ""}<ol>${steps}</ol>${setup.redirectUri ? `<label>Redirect URI</label><code>${esc(setup.redirectUri)}</code>` : ""}${setup.scopes.length ? `<label>Scopes Ares asks for</label><code>${esc(setup.scopes.join(" "))}</code>` : ""}${notes}${error ? `<div class="err">${esc(error)}</div>` : ""}<form method="post">${inputs}<button type="submit">Save and sign in</button></form></main>`,
  );
}

/** The device-code page: show the code, link the vendor, and poll /connect/<id>/status until it flips. */
function devicePage(flow: Flow): string {
  const d = flow.device!.info;
  const label = esc(flow.service.label);
  const link = d.verificationUriComplete ?? d.verificationUri;
  return shell(
    `Sign in to ${flow.service.label}`,
    `<main><div class="mark">🔗</div><h1>Sign in to ${label}</h1><p>Open the page below, enter this code and approve Ares. This page updates by itself.</p><div class="code" id="code">${esc(d.userCode)}</div><a class="btn" id="open" href="${esc(link)}" target="_blank" rel="noopener">Open ${esc(d.verificationUri.replace(/^https?:\/\//, ""))}</a><p class="help" id="state" style="text-align:center;margin-top:1rem">Waiting for you to approve…</p>
<script>
(function(){var base=location.pathname.replace(/\\/$/,'');var st=document.getElementById('state');
function tick(){fetch(base+'/status',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
if(j.state==='connected'){document.body.innerHTML='<main style="text-align:center;padding-top:22vh"><h1>Connected</h1><p>You can go back to the app.</p></main>';return;}
if(j.state==='failed'||j.state==='expired'){st.textContent=(j.error||'The code expired.')+' Ask Ares to connect again.';return;}
setTimeout(tick,2500);}).catch(function(){setTimeout(tick,4000);});}
tick();})();
</script></main>`,
  );
}

/** A failed sign-in as one safe sentence (never a token, a code or a URL). */
function failureText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/state_mismatch|did not match/i.test(message)) return "That sign-in did not match the one Ares started. Start the connection again.";
  if (/replay|already used/i.test(message)) return "That sign-in link was already used. Start the connection again.";
  if (/issuer_mismatch/i.test(message)) return "The sign-in came back from a different service than expected, so Ares refused it.";
  if (/access_denied|declined/i.test(message)) return "You declined.";
  return `The token exchange failed: ${scrubOAuthText(message, 160)}`;
}

function browserPage(flow: Flow): string {
  const label = esc(flow.service.label);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta name="robots" content="noindex"><title>Sign in to ${label}</title><style>${STYLE}
${LIVE_VIEW_CSS}
</style></head><body>
<div class="top"><div class="site"><b>${label}</b><span id="where">Starting a browser…</span></div><button class="pill cancel" id="cancel">Cancel</button><button class="pill done" id="done">Done</button></div>
<div id="stage"><img id="screen" alt=""><div id="spinner">Opening ${label}…</div></div>
<div class="bottom">
${LIVE_INPUT_DOCK}
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
