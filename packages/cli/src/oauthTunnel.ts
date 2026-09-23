// OAuth you can finish on your phone.
//
// The stock flow redirects to http://localhost:53691 — fine on a laptop that
// is also running Ares, useless on a phone, where "localhost" is the phone.
// The garrison already has a public origin (the tunnel that serves the app),
// so the redirect comes back THERE: tap a link on the phone, authorize, and
// the garrison catches the code itself.
//
// /oauth/callback is necessarily unauthenticated — it is a browser redirect
// from Google, not an API call. What protects it is the `state`: a 32-byte
// random value minted when the flow starts and required to match a pending
// flow that has not expired. A callback with an unknown state is refused
// before any code is exchanged.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildAuthorizeUrl,
  clientIdName,
  clientSecretName,
  exchangeCodeForTokens,
  getCredential,
  getProviderConfig,
  storeTokens,
  type OAuthProviderConfig,
} from "@ares/core";

interface Pending {
  provider: OAuthProviderConfig;
  redirectUri: string;
  startedAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;

const PAGE = (ok: boolean, title: string, detail: string) => `<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#07090c;color:#e8ebf0}
.card{text-align:center;padding:2rem 1.5rem;max-width:22rem}
.mark{font-size:2.5rem;color:${ok ? "#3fd18b" : "#ff5c5c"};margin-bottom:.75rem}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#8b93a1;line-height:1.5}
</style></head><body><div class="card"><div class="mark">${ok ? "✓" : "✕"}</div>
<h1>${title}</h1><p>${detail}</p></div></body></html>`;

export class TunnelOAuth {
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** Public origin the provider redirects back to, e.g. https://ares.mistiqueai.com */
    private readonly publicUrl: () => string | undefined,
    private readonly home: string | undefined,
    private readonly log: (line: string) => void = () => {},
  ) {}

  private redirectUri(): string {
    const base = (this.publicUrl() ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("this garrison has no public address yet — a connector needs one to redirect back to");
    return `${base}/oauth/callback`;
  }

  /** The exact value to register in the provider's console. */
  callbackUrlForSetup(): string | null {
    try {
      return this.redirectUri();
    } catch {
      return null;
    }
  }

  /** Begin a flow; returns the URL to open on the phone. */
  async begin(providerId: string, scopes?: string[]): Promise<{ authorizeUrl: string; state: string }> {
    const provider = getProviderConfig(providerId);
    if (!provider) throw new Error(`unknown provider: ${providerId}`);
    const clientId = await getCredential(clientIdName(provider), { home: this.home });
    const clientSecret = await getCredential(clientSecretName(provider), { home: this.home });
    if (!clientId || !clientSecret) {
      throw new Error(`${providerId} has no OAuth app yet — store its client id and secret first`);
    }
    const redirectUri = this.redirectUri();
    const state = randomBytes(32).toString("hex");
    this.sweep();
    this.pending.set(state, { provider, redirectUri, startedAt: Date.now() });
    const authorizeUrl = buildAuthorizeUrl(provider, { clientId, redirectUri, state, scopes });
    this.log(`oauth: ${providerId} flow started (redirect ${redirectUri})`);
    return { authorizeUrl, state };
  }

  private sweep(): void {
    const cutoff = Date.now() - FLOW_TTL_MS;
    for (const [state, flow] of this.pending) if (flow.startedAt < cutoff) this.pending.delete(state);
  }

  /** Handle the provider's browser redirect. Returns false if not our path. */
  async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== "/oauth/callback") return false;
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    };
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const denied = url.searchParams.get("error");
    this.sweep();
    const flow = this.pending.get(state);
    // An unknown state is the CSRF guard doing its job — never exchange a code
    // for a flow this garrison did not start.
    if (!flow) {
      send(400, PAGE(false, "Expired or unknown", "Start the connection again from Ares."));
      return true;
    }
    this.pending.delete(state);
    if (denied || !code) {
      send(400, PAGE(false, "Not connected", denied === "access_denied" ? "You declined the request." : "The provider did not return a code."));
      return true;
    }
    try {
      const clientId = (await getCredential(clientIdName(flow.provider), { home: this.home }))!;
      const clientSecret = (await getCredential(clientSecretName(flow.provider), { home: this.home }))!;
      const tokens = await exchangeCodeForTokens(flow.provider, { code, clientId, clientSecret, redirectUri: flow.redirectUri }, { home: this.home });
      await storeTokens(flow.provider.provider, tokens, { home: this.home });
      this.log(`oauth: ${flow.provider.provider} connected`);
      send(200, PAGE(true, "Connected", `Ares can use your ${flow.provider.provider} account now. You can close this and go back.`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`oauth: ${flow.provider.provider} exchange failed — ${message}`);
      send(500, PAGE(false, "Connection failed", message.slice(0, 200)));
    }
    return true;
  }
}
