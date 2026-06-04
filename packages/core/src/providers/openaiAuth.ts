// ChatGPT OAuth — device-code flow, Codex backend only.
//
// Crix does NOT support OPENAI_API_KEY anymore (see CHANGELOG). The
// canonical path is ChatGPT OAuth, which routes requests through the
// Codex backend at chatgpt.com.
//
// Token storage: %USERPROFILE%/.crix/auth.json (or $CRIX_HOME/auth.json).
// Bypass for tests/CI: $CRIX_OPENAI_OAUTH_TOKEN env var (still an OAuth
// access token — just sourced from env instead of file).

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OAUTH_ISSUER = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

export type AuthMode = "chatgpt-oauth" | "none";
export type AuthSource = "env:CRIX_OPENAI_OAUTH_TOKEN" | "file" | "none";

export interface AuthToken {
  token: string;
  source: Exclude<AuthSource, "none">;
  mode: Exclude<AuthMode, "none">;
  accountId?: string;
}

export interface AuthStatus {
  configured: boolean;
  source: AuthSource;
  mode: AuthMode;
  authPath: string;
  email?: string;
  planType?: string;
  accountId?: string;
  tokenPreview?: string;
}

interface AuthFile {
  mode: "chatgpt-oauth";
  tokens: {
    idToken: string;
    accessToken: string;
    refreshToken: string;
    accountId?: string;
  };
  profile: {
    email?: string;
    planType?: string;
    userId?: string;
  };
  lastRefresh: string;
}

export function crixHome(): string {
  return process.env.CRIX_HOME ?? path.join(os.homedir(), ".crix");
}

export function authFilePath(): string {
  return path.join(crixHome(), "auth.json");
}

/** Resolve the ChatGPT OAuth token. Env > file. */
export async function loadAuthToken(): Promise<AuthToken | null> {
  if (process.env.CRIX_OPENAI_OAUTH_TOKEN) {
    return {
      token: process.env.CRIX_OPENAI_OAUTH_TOKEN,
      source: "env:CRIX_OPENAI_OAUTH_TOKEN",
      mode: "chatgpt-oauth",
    };
  }
  const file = await readAuthFile();
  if (!file) return null;
  return {
    token: file.tokens.accessToken,
    source: "file",
    mode: "chatgpt-oauth",
    accountId: file.tokens.accountId,
  };
}

export async function authStatus(): Promise<AuthStatus> {
  const authPath = authFilePath();
  const token = await loadAuthToken();
  if (!token) {
    return { configured: false, source: "none", mode: "none", authPath };
  }
  const file = token.source === "file" ? await readAuthFile() : null;
  return {
    configured: true,
    source: token.source,
    mode: token.mode,
    authPath,
    email: file?.profile.email,
    planType: file?.profile.planType,
    accountId: token.accountId,
    tokenPreview: token.token.slice(0, 8) + "…",
  };
}

async function readAuthFile(): Promise<AuthFile | null> {
  try {
    const raw = await readFile(authFilePath(), "utf8");
    return JSON.parse(raw) as AuthFile;
  } catch {
    return null;
  }
}

async function writeAuthFile(file: AuthFile): Promise<void> {
  const dir = crixHome();
  await mkdir(dir, { recursive: true });
  const path_ = authFilePath();
  await writeFile(path_, JSON.stringify(file, null, 2) + "\n", "utf8");
  if (process.platform !== "win32") {
    try {
      await chmod(path_, 0o600);
    } catch {
      // best-effort
    }
  }
}

// ─── Device-code OAuth (ChatGPT) ───────────────────────────────────────

export interface DeviceCodeChallenge {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export interface DeviceCodeLoginOptions {
  /** Called as soon as we have the user code so the CLI can print it. */
  onDeviceCode?: (code: DeviceCodeChallenge) => void | Promise<void>;
  /** Cap on total polling time. Default 10 minutes. */
  maxWaitMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  interval: number;
  expires_in: number;
}

interface TokenExchangeResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account_id?: string;
}

/**
 * Begin a ChatGPT OAuth device-code login. Resolves once the user has
 * authorized in their browser (or rejects on timeout/cancel).
 */
export async function deviceCodeLogin(opts: DeviceCodeLoginOptions = {}): Promise<AuthFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxWaitMs = opts.maxWaitMs ?? 10 * 60_000;

  const dcRes = await fetchImpl(`${OAUTH_ISSUER}/oauth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      scope: "openid profile email offline_access",
    }),
  });
  if (!dcRes.ok) throw new Error(`device-code request failed: ${dcRes.status} ${await dcRes.text()}`);
  const dc = (await dcRes.json()) as DeviceCodeResponse;

  await opts.onDeviceCode?.({
    verificationUrl: dc.verification_uri_complete ?? dc.verification_uri,
    userCode: dc.user_code,
    deviceAuthId: dc.device_code,
    intervalSeconds: dc.interval,
  });

  const deadline = Date.now() + Math.min(maxWaitMs, dc.expires_in * 1000);
  let interval = (dc.interval || 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const tRes = await fetchImpl(`${OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: OAUTH_CLIENT_ID,
        device_code: dc.device_code,
      }),
    });
    if (tRes.status === 200) {
      const tok = (await tRes.json()) as TokenExchangeResponse;
      const file: AuthFile = {
        mode: "chatgpt-oauth",
        tokens: {
          idToken: tok.id_token,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accountId: tok.account_id,
        },
        profile: extractProfile(tok.id_token),
        lastRefresh: new Date().toISOString(),
      };
      await writeAuthFile(file);
      return file;
    }
    const body = (await tRes.json().catch(() => ({}))) as { error?: string };
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      interval += 5_000;
      continue;
    }
    if (body.error === "access_denied") throw new Error("user denied authorization");
    if (body.error === "expired_token") throw new Error("device code expired");
    throw new Error(`token exchange failed: ${tRes.status} ${JSON.stringify(body)}`);
  }
  throw new Error("login timed out");
}

function extractProfile(idToken: string): AuthFile["profile"] {
  try {
    const [, payload] = idToken.split(".");
    if (!payload) return {};
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      plan_type?: string;
      sub?: string;
    };
    return { email: decoded.email, planType: decoded.plan_type, userId: decoded.sub };
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export helpers tests might want
export { TOKEN_EXPIRY_SKEW_MS };
