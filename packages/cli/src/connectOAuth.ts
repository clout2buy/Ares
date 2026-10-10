// The OAuth half of the connect hub: turns a service + the matrix plan into a
// prepared flow (an authorize URL, a device code, a setup request or an honest
// "unsupported"), using the generic engine in @ares/core.
//
// connectHub.ts owns the flows, the HTTP pages and the phone contract; this file
// owns "how do we get a client and a token for THIS service". It never stores
// anything but through the encrypted vault (storeTokens / the MCP bundle) and
// never puts a token, code or secret in a log line or a returned string.

import {
  OAUTH_PROVIDERS,
  accountFromJson,
  beginProviderAuthorization,
  clientMetadataUrl,
  clientRequiresSecret,
  completeAuthorization,
  finalizeProviderTokens,
  matrixFor,
  planConnect,
  pollProviderDevice,
  prepareMcpAuthorization,
  probeAccount,
  resolveOAuthClient,
  scrubOAuthText,
  startProviderDevice,
  storeTokens,
  type CallbackParams,
  type ConnectPlan,
  type ConnectService,
  type DeviceAuthorization,
  type OAuthProviderConfig,
  type PendingAuthorization,
} from "@ares/core";

export interface DriverOptions {
  home?: string;
  /** The garrison's public origin (https://ares.mistiqueai.com). */
  base: () => string;
  log: (line: string) => void;
  /** Test seams. */
  engineFetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** The loopback redirect the app intercepts (default http://localhost:53682/oauth/callback). */
  loopbackRedirect?: string;
}

export type Prepared =
  | {
      kind: "code";
      authorizeUrl: string;
      pending: PendingAuthorization;
      redirectUri: string;
      /** The redirect is a loopback address: only the phone app can finish it. */
      intercept?: { redirectPrefix: string };
      issuer?: string;
      finish: (params: CallbackParams) => Promise<string>;
    }
  | { kind: "device"; device: DeviceAuthorization; run: (signal: AbortSignal) => Promise<string> }
  | { kind: "setup"; reason?: string }
  | { kind: "unsupported"; reason: string };

export const DEFAULT_LOOPBACK_REDIRECT = "http://localhost:53682/oauth/callback";

export class OAuthDriver {
  constructor(private readonly opts: DriverOptions) {}

  private deps() {
    return { ...(this.opts.engineFetch ? { fetchImpl: this.opts.engineFetch } : {}), ...(this.opts.now ? { now: this.opts.now } : {}), ...(this.opts.home ? { home: this.opts.home } : {}) };
  }

  /** The matrix plan for a service given the clients available right now. */
  async plan(service: ConnectService): Promise<ConnectPlan> {
    const entry = matrixFor(service.id);
    const provider = entry?.provider ?? service.oauthProvider ?? (service.kind === "oauth-app" ? service.id : undefined);
    let client: { hasSecret: boolean } | undefined;
    if (provider && (service.kind === "oauth-app" || (service.kind === "mcp-oauth" && entry && entry.class !== "a"))) {
      const resolved = await resolveOAuthClient(provider, { ...(this.opts.home ? { home: this.opts.home } : {}), requireSecret: clientRequiresSecret(provider, entry) });
      if (resolved) client = { hasSecret: Boolean(resolved.clientSecret) };
    }
    return planConnect(service, { client });
  }

  /** Account name for the Connections list, read once at connect time (best effort). */
  private async accountOf(cfg: OAuthProviderConfig | undefined, entryUrl: string | undefined, token: string): Promise<string | undefined> {
    const url = cfg?.userinfoUrl ?? entryUrl;
    if (!url) return undefined;
    const probe = await probeAccount({ url, token }, { ...(this.opts.engineFetch ? { fetchImpl: this.opts.engineFetch } : {}), timeoutMs: 5_000 });
    return probe.account;
  }

  async prepare(service: ConnectService, plan: ConnectPlan, o: { v2: boolean }): Promise<Prepared> {
    if (plan.start === "unsupported") return { kind: "unsupported", reason: plan.reason ?? `${service.label} cannot be connected with OAuth` };
    if (plan.start === "fields") return { kind: "setup" }; // never reached: fields are handled by the hub
    if (service.kind === "mcp-oauth") return this.prepareMcp(service, plan, o);
    return this.prepareApp(service, plan);
  }

  // ─── remote MCP servers ──────────────────────────────────────────────────

  private async prepareMcp(service: ConnectService, plan: ConnectPlan, o: { v2: boolean }): Promise<Prepared> {
    const entry = plan.entry;
    const provider = plan.provider;
    // Class a never uses a registry client: dynamic registration is the whole point.
    const client = entry && entry.class !== "a" && provider ? await resolveOAuthClient(provider, { ...(this.opts.home ? { home: this.opts.home } : {}), requireSecret: clientRequiresSecret(provider, entry) }) : undefined;
    if (plan.needsClient && !client && plan.start === "setup") return { kind: "setup" };
    const base = this.opts.base();
    const prepared = await prepareMcpAuthorization(service.mcpUrl!, {
      name: service.id,
      displayName: service.label,
      redirectUri: `${base}/oauth/callback`,
      clientMetadataUrl: clientMetadataUrl(base),
      ...(this.opts.home ? { home: this.opts.home } : {}),
      ...(client ? { client: { clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}) } } : {}),
      ...(entry && entry.class !== "a" && entry.scopes.length ? { scopes: entry.scopes } : {}),
      preferDevice: plan.device,
      // Only the v2 phone app can intercept a loopback redirect.
      ...(o.v2 && (!entry || entry.loopback || entry.allowlist || entry.class === "a") ? { loopbackRedirectUri: this.opts.loopbackRedirect ?? DEFAULT_LOOPBACK_REDIRECT } : {}),
      ...(this.opts.engineFetch ? { engineFetch: this.opts.engineFetch, fetchImpl: this.opts.engineFetch } : {}),
      ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
    });
    const detail = (r: { verified: boolean; toolCount?: number; verifyError?: string }) =>
      r.verified ? `${r.toolCount ?? 0} tools available.` : `Connected, but the first tools/list check failed (${scrubOAuthText(r.verifyError ?? "unknown", 80)}); try a call anyway.`;
    if (prepared.mode === "setup") {
      return plan.entry?.setup || plan.entry?.selfServe !== false ? { kind: "setup", reason: prepared.reason } : { kind: "unsupported", reason: prepared.reason };
    }
    if (prepared.mode === "device") {
      return { kind: "device", device: prepared.device, run: async (signal) => detail(await prepared.poll(signal)) };
    }
    return {
      kind: "code",
      authorizeUrl: prepared.authorizeUrl,
      pending: prepared.pending,
      redirectUri: prepared.redirectUri,
      ...(prepared.viaLoopback ? { intercept: { redirectPrefix: prepared.redirectUri.replace(/\?.*$/, "") } } : {}),
      ...(prepared.issuer ? { issuer: prepared.issuer } : {}),
      finish: async (params) => detail(await prepared.finish(params)),
    };
  }

  // ─── classic OAuth apps (a registered client; token in oauth/<provider>) ──

  private async prepareApp(service: ConnectService, plan: ConnectPlan): Promise<Prepared> {
    const provider = plan.provider ?? service.oauthProvider ?? service.id;
    const cfg = OAUTH_PROVIDERS[provider];
    if (!cfg) return { kind: "unsupported", reason: `${service.label} has no OAuth provider configured` };
    const client = await resolveOAuthClient(provider, { ...(this.opts.home ? { home: this.opts.home } : {}), requireSecret: clientRequiresSecret(provider, plan.entry) });
    if (!client) return { kind: "setup" };
    const scopes = plan.entry?.scopes?.length && plan.entry.provider === provider && !cfg.scopes.length ? plan.entry.scopes : cfg.scopes;
    const deps = this.deps();
    const store = async (set: Parameters<typeof finalizeProviderTokens>[1], via: "code" | "device"): Promise<string> => {
      const account = await this.accountOf(cfg, undefined, set.accessToken);
      const tokens = await finalizeProviderTokens(cfg, set, { client, via, ...(account ? { account } : {}) }, deps);
      await storeTokens(cfg.provider, tokens, deps);
      return account ? `Signed in as ${account}.` : "";
    };
    if (plan.device && cfg.deviceUrl) {
      const device = await startProviderDevice(cfg, { client, scopes }, deps);
      return {
        kind: "device",
        device,
        run: async (signal) => store(await pollProviderDevice(cfg, { client, device, signal, ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}) }, deps), "device"),
      };
    }
    const redirectUri = `${this.opts.base()}/oauth/callback`;
    const { authorizeUrl, pending } = beginProviderAuthorization(cfg, { client, redirectUri, scopes });
    return {
      kind: "code",
      authorizeUrl,
      pending,
      redirectUri,
      finish: async (params) => store(await completeAuthorization(pending, params, deps), "code"),
    };
  }
}

export { accountFromJson };
