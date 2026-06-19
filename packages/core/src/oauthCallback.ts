// OAuth callback server — spins up a temporary localhost HTTP server to catch
// the OAuth redirect after the owner authorizes in their browser. Works for
// both the Tauri desktop app and the Telegram flow (owner taps a link, browser
// opens, authorizes, redirect lands here, server shuts down).
//
// The callback URL is always http://localhost:<port>/oauth/callback. The port is
// configurable (default 53691) and the server self-destructs after one successful
// callback or a timeout.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  storeTokens,
  clientIdName,
  clientSecretName,
  type OAuthProviderConfig,
  type OAuthTokens,
} from "./oauth.js";
import { getCredential } from "./credentials.js";

export interface OAuthFlowOptions {
  provider: OAuthProviderConfig;
  /** Override scopes for this specific flow. */
  scopes?: string[];
  port?: number;
  timeoutMs?: number;
  home?: string;
  /** Called with the authorize URL — the caller opens it (browser, Telegram inline button, etc). */
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
  /** Called on success with the tokens. */
  onSuccess?: (tokens: OAuthTokens) => void | Promise<void>;
  /** Called on failure. */
  onError?: (error: Error) => void | Promise<void>;
}

const DEFAULT_PORT = 53691;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#4ade80;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>Connected</h1><p>You can close this tab and return to Ares.</p></div></body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#f87171;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>Connection Failed</h1><p>${msg}</p></div></body></html>`;

export async function startOAuthFlow(opts: OAuthFlowOptions): Promise<OAuthTokens> {
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cfg = opts.provider;
  const home = opts.home;

  const clientId = await getCredential(clientIdName(cfg), { home });
  const clientSecret = await getCredential(clientSecretName(cfg), { home });
  if (!clientId || !clientSecret) {
    throw new Error(
      `Missing OAuth app credentials for ${cfg.provider}. ` +
      `Set ${clientIdName(cfg)} and ${clientSecretName(cfg)} in the vault first.`,
    );
  }

  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${port}/oauth/callback`;

  const authorizeUrl = buildAuthorizeUrl(cfg, {
    clientId,
    redirectUri,
    state,
    scopes: opts.scopes,
  });

  return new Promise<OAuthTokens>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;

    const cleanup = () => {
      if (server) {
        try { server.close(); } catch { /* already closed */ }
        server = undefined;
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        const err = new Error(`OAuth flow timed out after ${timeoutMs / 1000}s — the owner didn't complete authorization.`);
        void opts.onError?.(err);
        reject(err);
      }
    }, timeoutMs);

    server = createServer(async (req, res) => {
      if (settled) { res.end(); return; }

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/oauth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        settled = true;
        clearTimeout(timer);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(ERROR_HTML(error));
        cleanup();
        const err = new Error(`OAuth denied: ${error}`);
        void opts.onError?.(err);
        reject(err);
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(ERROR_HTML("Invalid callback — state mismatch or missing code."));
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(cfg, {
          code,
          clientId,
          clientSecret,
          redirectUri,
        }, { home });

        await storeTokens(cfg.provider, tokens, { home });

        settled = true;
        clearTimeout(timer);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SUCCESS_HTML);
        cleanup();
        void opts.onSuccess?.(tokens);
        resolve(tokens);
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(ERROR_HTML(msg));
        cleanup();
        void opts.onError?.(err instanceof Error ? err : new Error(msg));
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      void opts.onAuthorizeUrl?.(authorizeUrl);
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        void opts.onError?.(err);
        reject(err);
      }
    });
  });
}

/** Check which providers the owner has connected (tokens on file). */
export async function connectedProviders(
  providers: Record<string, OAuthProviderConfig>,
  home?: string,
): Promise<Record<string, boolean>> {
  const { loadTokens } = await import("./oauth.js");
  const result: Record<string, boolean> = {};
  for (const [id, _cfg] of Object.entries(providers)) {
    const tokens = await loadTokens(id, { home });
    result[id] = tokens !== undefined && tokens.accessToken !== undefined;
  }
  return result;
}
