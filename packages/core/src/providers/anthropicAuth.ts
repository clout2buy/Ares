// Anthropic OAuth for Claude Pro / Max.
//
// This mirrors the working Claude Code-compatible flow used by Crypt:
// - claude.ai authorization endpoint
// - fixed localhost:53692 loopback callback
// - PKCE verifier reused as OAuth state
// - Claude Code scopes and token exchange shape
//
// Tokens are isolated under ~/.ares/anthropic-oauth.json. Ares deliberately
// does not read Claude Code or Crypt credential stores.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { aresHome } from "./openaiAuth.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_PORT = 53692;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
// Claude's own "copy this code" page: the redirect Claude Code uses when no
// loopback listener can be reached (a remote shell, a phone driving a box).
const MANUAL_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

/** Headers and identity required when a Claude subscription token calls Messages. */
export const ANTHROPIC_OAUTH_BETA = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  // NOT "fine-grained-tool-streaming": it streams tool arguments without
  // validating them, and Claude 5 emitted broken JSON (a dropped quote) on up
  // to 12 of 15 calls in a session — each one a failed tool call and a retry.
  // Without it the arguments still stream, as validated JSON, at the same speed.
  "interleaved-thinking-2025-05-14",
].join(",");
// The OAuth path is admitted as a Claude Code client, and the API gates newer
// models on the client version it sees ("Claude Code 2.1.160 does not support
// this model; version 2.1.251 or newer is required"). Track the floor Anthropic
// last demanded; ARES_ANTHROPIC_CLIENT_VERSION lifts it without a release.
const ANTHROPIC_CLIENT_VERSION = (process.env.ARES_ANTHROPIC_CLIENT_VERSION ?? "").trim().match(/^\d+\.\d+\.\d+$/) ? (process.env.ARES_ANTHROPIC_CLIENT_VERSION as string).trim() : "2.1.280";
/** The build-time floor. Kept for callers that only need a value; requests
 *  use anthropicOAuthUserAgent(), which also carries a learned version. */
export const ANTHROPIC_OAUTH_USER_AGENT = `claude-cli/${ANTHROPIC_CLIENT_VERSION}`;

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function clientVersionFile(): string {
  return path.join(aresHome(), "anthropic-client.json");
}

let learnedClientVersion: string | null | undefined;

/**
 * The client version advertised on the OAuth path: the build floor, or a
 * newer one Anthropic demanded earlier ("Claude Code 2.1.251 does not support
 * this model; version 2.1.280 or newer is required"). A hard-coded constant
 * went stale between releases and every fresh chat died on its first message
 * (four "hi" sessions in 12 minutes); the learned version lives in
 * <ARES_HOME>/anthropic-client.json so it survives restarts.
 */
export function anthropicClientVersion(): string {
  if (learnedClientVersion === undefined) {
    learnedClientVersion = null;
    try {
      const raw = JSON.parse(readFileSync(clientVersionFile(), "utf8")) as { version?: unknown };
      if (typeof raw.version === "string" && /^\d+\.\d+\.\d+$/.test(raw.version)) learnedClientVersion = raw.version;
    } catch {
      // no learned version yet
    }
  }
  return learnedClientVersion && compareVersions(learnedClientVersion, ANTHROPIC_CLIENT_VERSION) > 0
    ? learnedClientVersion
    : ANTHROPIC_CLIENT_VERSION;
}

export function anthropicOAuthUserAgent(): string {
  return `claude-cli/${anthropicClientVersion()}`;
}

/** "version 2.1.280 or newer" → "2.1.280" when the error is the client-version gate. */
export function requiredClientVersionFromError(text: string): string | null {
  if (!/does not support this model|version .{0,40}(?:or newer|required)|claude_code_version_too_old|version_too_old/i.test(text)) return null;
  const m = /version\s+v?(\d+\.\d+\.\d+)\s+or\s+(?:newer|later|higher)/i.exec(text) ?? /(?:requires?|minimum)[^0-9]{0,30}(\d+\.\d+\.\d+)/i.exec(text);
  return m ? m[1] : null;
}

/** Adopt a newer advertised version (never a lower one) and persist it.
 *  Returns true when the version actually moved, i.e. a retry is worth it. */
export function raiseAnthropicClientVersion(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  if (compareVersions(version, anthropicClientVersion()) <= 0) return false;
  learnedClientVersion = version;
  try {
    mkdirSync(aresHome(), { recursive: true });
    writeFileSync(clientVersionFile(), JSON.stringify({ version, learnedAt: new Date().toISOString() }));
  } catch {
    // still used for this process
  }
  return true;
}

/** Test hook: forget the cached learned version so the file is re-read. */
export function resetAnthropicClientVersionCache(): void {
  learnedClientVersion = undefined;
}
export const ANTHROPIC_OAUTH_X_APP = "cli";
export const ANTHROPIC_OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  scopes?: string[];
}

export interface AnthropicAuthChallenge {
  /** The URL to open in the browser. */
  authorizeUrl: string;
  /** Opaque handle the caller passes back to finishAnthropicLogin. */
  pkceVerifier: string;
  state: string;
  port: number;
  redirectUri: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authFilePath(): string {
  return path.join(aresHome(), "anthropic-oauth.json");
}

/**
 * Start a Claude sign-in. `manual: true` is the flow for a device that cannot
 * take a loopback redirect (a phone talking to a box): Claude sends the browser
 * to its own code page instead, which shows `code#state` for the person to copy
 * and paste back. The token exchange must then name that same redirect.
 */
export function startAnthropicLogin(opts: { manual?: boolean } = {}): AnthropicAuthChallenge {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const redirectUri = opts.manual ? MANUAL_REDIRECT_URI : REDIRECT_URI;

  // Claude Code's public client expects the verifier itself as state. A
  // separate random state causes its token exchange to fail.
  const state = verifier;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return {
    authorizeUrl: url.toString(),
    pkceVerifier: verifier,
    state,
    port: CALLBACK_PORT,
    redirectUri,
  };
}

/** Full loopback flow. A valid Ares login is reused; otherwise the browser opens. */
export async function runAnthropicLoginFlow(
  openUrl: (url: string) => void,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 300_000,
  force = false,
): Promise<AnthropicOAuthTokens> {
  // `force` is what an explicit "Sign in" click means: always run the real
  // browser flow. Without it, a stored token that still LOOKS alive (or a
  // refresh that succeeds against a limit-broken account) short-circuits and
  // the owner can never re-authenticate or switch accounts.
  if (force) {
    await clearAnthropicTokens().catch(() => undefined);
  } else {
    const existing = await loadAnthropicTokens();
    if (existing?.accessToken && Date.now() < existing.expiresAt - 60_000) {
      await saveAnthropicTokens(existing);
      return existing;
    }
    if (existing?.refreshToken) {
      try {
        return await refreshAnthropicTokens(existing, fetchImpl);
      } catch {
        // A rejected refresh token should fall through to an interactive login.
      }
    }
  }

  const auth = startAnthropicLogin();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, tokens?: AnthropicOAuthTokens): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      server.close();
      if (error) reject(error);
      else if (tokens) resolve(tokens);
    };

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", REDIRECT_URI);
      if (reqUrl.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end();
        return;
      }

      const providerError = reqUrl.searchParams.get("error");
      const providerDescription = reqUrl.searchParams.get("error_description");
      const code = reqUrl.searchParams.get("code") ?? "";
      const returnedState = reqUrl.searchParams.get("state") ?? "";

      if (providerError) {
        const detail = providerDescription ? `: ${providerDescription}` : "";
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h2>Claude sign-in was not completed. You can close this tab.</h2></body></html>");
        finish(new Error(`Claude authorization failed (${providerError})${detail}`));
        return;
      }
      if (!code || returnedState !== auth.state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h2>Claude sign-in failed. Close this tab and try again.</h2></body></html>");
        finish(new Error("Claude OAuth callback had a missing code or invalid state."));
        return;
      }

      void exchangeCode(code, auth.pkceVerifier, fetchImpl)
        .then((tokens) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>Signed in to Ares. You can close this tab.</h2></body></html>");
          finish(undefined, tokens);
        })
        .catch((error: unknown) => {
          res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>Claude approved access, but token exchange failed. Return to Ares for details.</h2></body></html>");
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });

    const deadline = setTimeout(() => {
      finish(new Error("Claude sign-in timed out after 5 minutes. Try again."));
    }, timeoutMs);

    server.once("error", (error: NodeJS.ErrnoException) => {
      const hint = error.code === "EADDRINUSE"
        ? `Port ${CALLBACK_PORT} is already in use. Close another Claude/Crypt login and try again.`
        : error.code === "EACCES"
        ? `Windows has reserved port ${CALLBACK_PORT}, and Claude sign-in can only use that port. Restart the PC, or in an admin terminal run: net stop winnat, then net start winnat.`
        : `Could not start Claude auth callback on ${REDIRECT_URI}: ${error.message}`;
      finish(new Error(hint));
    });

    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      try {
        openUrl(auth.authorizeUrl);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
  redirectUri: string = REDIRECT_URI,
): Promise<AnthropicOAuthTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": anthropicOAuthUserAgent(),
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state: verifier,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Claude token exchange failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tok.access_token || !tok.refresh_token) {
    throw new Error("Claude token exchange returned an incomplete token response.");
  }
  const tokens: AnthropicOAuthTokens = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    ...(tok.scope ? { scopes: tok.scope.split(/\s+/).filter(Boolean) } : {}),
  };
  await saveAnthropicTokens(tokens);
  return tokens;
}

/**
 * Complete a manually copied callback URL or authorization code (`code#state`
 * from Claude's code page, or the whole address the browser ended on).
 * `redirectUri` is the one the challenge was started with (see the manual flow).
 */
export async function finishAnthropicLogin(
  rawCode: string,
  pkceVerifier: string,
  expectedState: string,
  fetchImpl: typeof fetch = fetch,
  redirectUri: string = REDIRECT_URI,
): Promise<AnthropicOAuthTokens> {
  const raw = rawCode.trim();
  let code = raw;
  let state = "";
  try {
    const url = new URL(raw);
    code = url.searchParams.get("code") ?? "";
    state = url.searchParams.get("state") ?? "";
  } catch {
    const split = raw.split("#", 2);
    code = split[0] ?? "";
    state = split[1] ?? "";
  }
  if (!code) throw new Error("Claude authorization code is missing.");
  if (state && state !== expectedState) throw new Error("Claude OAuth state mismatch.");
  return exchangeCode(code, pkceVerifier, fetchImpl, redirectUri);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function validTokens(value: unknown): AnthropicOAuthTokens | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AnthropicOAuthTokens>;
  if (typeof row.accessToken !== "string" || !row.accessToken) return null;
  return {
    accessToken: row.accessToken,
    refreshToken: typeof row.refreshToken === "string" ? row.refreshToken : "",
    expiresAt: typeof row.expiresAt === "number" ? row.expiresAt : 0,
    ...(Array.isArray(row.scopes) ? { scopes: row.scopes.filter((scope): scope is string => typeof scope === "string") } : {}),
  };
}

async function loadAresTokens(): Promise<AnthropicOAuthTokens | null> {
  return validTokens(await readJson(authFilePath()));
}

/** Load only Ares-owned OAuth credentials. */
export async function loadAnthropicTokens(): Promise<AnthropicOAuthTokens | null> {
  return loadAresTokens();
}

export async function saveAnthropicTokens(tokens: AnthropicOAuthTokens): Promise<void> {
  const file = authFilePath();
  const temp = `${file}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(tokens, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

export async function clearAnthropicTokens(): Promise<void> {
  await rm(authFilePath(), { force: true }).catch(() => {});
}

/** Deadline for one token exchange (ARES_ANTHROPIC_REFRESH_TIMEOUT_MS, default 15s). */
function refreshTimeoutMs(): number {
  const n = Number(process.env.ARES_ANTHROPIC_REFRESH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? Math.floor(n) : 15_000;
}

/**
 * Single-flight, keyed by refresh token. The refresh runs at the top of every
 * provider stream, so a turn, its compaction summarizer and a subagent can all
 * hit an expired token at once. Each used to POST its own exchange: if the
 * server rotates the refresh token the losers present a revoked one and the
 * owner is "Not signed in" mid-task; and the exchange had no deadline, so a
 * token endpoint that never answered left the turn silent until the stream
 * stall guard gave up minutes later. Now there is one exchange per token, and
 * it fails in seconds.
 */
const refreshesInFlight = new Map<string, Promise<AnthropicOAuthTokens>>();

/** Refresh an expiring access token. Returns and persists the fresh tokens. */
export function refreshAnthropicTokens(
  tokens: AnthropicOAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<AnthropicOAuthTokens> {
  if (!tokens.refreshToken) return Promise.reject(new Error("Claude OAuth refresh token is missing."));
  const key = tokens.refreshToken;
  const existing = refreshesInFlight.get(key);
  if (existing) return existing;
  const flight = exchangeRefreshToken(tokens, fetchImpl).finally(() => {
    if (refreshesInFlight.get(key) === flight) refreshesInFlight.delete(key);
  });
  refreshesInFlight.set(key, flight);
  return flight;
}

async function exchangeRefreshToken(
  tokens: AnthropicOAuthTokens,
  fetchImpl: typeof fetch,
): Promise<AnthropicOAuthTokens> {
  const timeoutMs = refreshTimeoutMs();
  // Raced as well as signalled: an injected fetch that ignores the signal must
  // not be able to hold the turn either.
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error("token refresh timed out");
      reason.name = "TimeoutError";
      deadline.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  let res: Response;
  try {
    res = await Promise.race([expired, fetchImpl(TOKEN_URL, {
      signal: deadline.signal,
      method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": anthropicOAuthUserAgent(),
    },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: tokens.refreshToken,
      }),
    })]);
  } catch (err) {
    if (deadline.signal.aborted) {
      throw new Error(`Claude token refresh did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Claude token refresh failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!tok.access_token) throw new Error("Claude token refresh returned no access token.");
  const next: AnthropicOAuthTokens = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
    scopes: tok.scope ? tok.scope.split(/\s+/).filter(Boolean) : tokens.scopes,
  };
  await saveAnthropicTokens(next);
  return next;
}

/** Return a usable access token, importing or refreshing existing credentials. */
export async function resolveAnthropicAccessToken(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (process.env.ARES_DISABLE_ANTHROPIC_OAUTH === "1") return null;
  const envToken =
    process.env.ARES_ANTHROPIC_OAUTH_TOKEN?.trim() ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return envToken;
  let tokens = await loadAnthropicTokens();
  if (!tokens?.accessToken) return null;
  if (Date.now() > tokens.expiresAt - 60_000) {
    try {
      tokens = await refreshAnthropicTokens(tokens, fetchImpl);
    } catch {
      return null;
    }
  } else {
    await saveAnthropicTokens(tokens).catch(() => {});
  }
  return tokens.accessToken;
}
