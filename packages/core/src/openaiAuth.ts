import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

type FetchLike = typeof fetch;

export interface DeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

export interface CrixOpenAIAuth {
  authMode: "chatgpt";
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

export interface OpenAIAuthStatus {
  configured: boolean;
  source: "env:CRIX_OPENAI_OAUTH_TOKEN" | "env:OPENAI_API_KEY" | "file" | "none";
  mode: "chatgpt-oauth" | "api-key" | "oauth-token" | "none";
  authPath: string;
  email?: string;
  planType?: string;
  accountId?: string;
  tokenPreview?: string;
}

export interface OpenAIAuthToken {
  token: string;
  source: Exclude<OpenAIAuthStatus["source"], "none">;
  mode: Exclude<OpenAIAuthStatus["mode"], "none">;
  accountId?: string;
}

interface DeviceCodeLoginOptions {
  onDeviceCode?: (code: DeviceCode) => void | Promise<void>;
  maxWaitMs?: number;
}

interface TokenExchangeResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

interface UserCodeResponse {
  device_auth_id: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code: string;
  code_challenge: string;
  code_verifier: string;
}

export class OpenAIAuthStore {
  readonly issuer: string;
  readonly clientId: string;
  private readonly fetchImpl: FetchLike;
  private readonly home: string;

  constructor(options: { home?: string; issuer?: string; clientId?: string; fetchImpl?: FetchLike } = {}) {
    this.home = options.home ?? crixHome();
    this.issuer = (options.issuer ?? process.env.CRIX_OPENAI_AUTH_BASE_URL ?? DEFAULT_ISSUER).replace(/\/+$/, "");
    this.clientId = options.clientId ?? process.env.CRIX_OPENAI_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  authPath(): string {
    return path.join(this.home, "auth.json");
  }

  async status(): Promise<OpenAIAuthStatus> {
    const envToken = readEnvToken();
    if (envToken) {
      return {
        configured: true,
        source: envToken.source,
        mode: envToken.mode,
        authPath: this.authPath(),
        tokenPreview: previewToken(envToken.token),
      };
    }
    const auth = await this.load();
    if (!auth) return { configured: false, source: "none", mode: "none", authPath: this.authPath() };
    return {
      configured: true,
      source: "file",
      mode: "chatgpt-oauth",
      authPath: this.authPath(),
      email: auth.profile.email,
      planType: auth.profile.planType,
      accountId: auth.tokens.accountId,
      tokenPreview: previewToken(auth.tokens.accessToken),
    };
  }

  async load(): Promise<CrixOpenAIAuth | undefined> {
    try {
      const raw = await readFile(this.authPath(), "utf8");
      return parseAuthFile(JSON.parse(raw.trimStart().replace(/^\uFEFF/, "")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(auth: CrixOpenAIAuth): Promise<void> {
    await mkdir(this.home, { recursive: true });
    await writeFile(this.authPath(), `${JSON.stringify(auth, null, 2)}\n`, "utf8");
    try {
      await chmod(this.authPath(), 0o600);
    } catch {
      // Windows may ignore POSIX modes; the file still stays outside the repo by default.
    }
  }

  async logout(): Promise<boolean> {
    try {
      await rm(this.authPath(), { force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async requestDeviceCode(): Promise<DeviceCode> {
    const response = await this.fetchJson<UserCodeResponse>(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    const userCode = response.user_code ?? response.usercode;
    if (!response.device_auth_id || !userCode) throw new Error("OpenAI device code response was missing required fields.");
    return {
      verificationUrl: `${this.issuer}/codex/device`,
      userCode,
      deviceAuthId: response.device_auth_id,
      intervalSeconds: Number(response.interval ?? 5),
    };
  }

  async loginWithDeviceCode(options: DeviceCodeLoginOptions = {}): Promise<CrixOpenAIAuth> {
    const code = await this.requestDeviceCode();
    await options.onDeviceCode?.(code);
    const deviceToken = await this.pollForDeviceAuthorization(code, options.maxWaitMs ?? 15 * 60 * 1000);
    const tokenResponse = await this.exchangeAuthorizationCode(deviceToken.authorization_code, deviceToken.code_verifier);
    const auth = authFromTokenResponse(tokenResponse);
    await this.save(auth);
    return auth;
  }

  async getBearerToken(): Promise<string> {
    return (await this.getAuthToken()).token;
  }

  async getAuthToken(): Promise<OpenAIAuthToken> {
    const envToken = readEnvToken();
    if (envToken) return envToken;
    const auth = await this.load();
    if (!auth) throw new Error("OpenAI auth is not configured. Run `crix auth login` or set CRIX_OPENAI_OAUTH_TOKEN / OPENAI_API_KEY.");
    const refreshed = await this.refreshIfNeeded(auth);
    return {
      token: refreshed.tokens.accessToken,
      source: "file",
      mode: "chatgpt-oauth",
      accountId: refreshed.tokens.accountId,
    };
  }

  async refreshIfNeeded(auth: CrixOpenAIAuth): Promise<CrixOpenAIAuth> {
    if (!shouldRefresh(auth)) return auth;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refreshToken,
      client_id: this.clientId,
    });
    const tokenResponse = await this.fetchJson<TokenExchangeResponse>(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const refreshed = authFromTokenResponse(tokenResponse);
    await this.save(refreshed);
    return refreshed;
  }

  private async pollForDeviceAuthorization(code: DeviceCode, maxWaitMs: number): Promise<DeviceTokenResponse> {
    const started = Date.now();
    const intervalMs = Math.max(1, code.intervalSeconds) * 1000;
    while (Date.now() - started <= maxWaitMs) {
      const response = await this.fetchImpl(`${this.issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode }),
      });
      if (response.ok) return (await response.json()) as DeviceTokenResponse;
      if (![403, 404].includes(response.status)) {
        throw new Error(`OpenAI device authorization failed with HTTP ${response.status}: ${await safeResponseText(response)}`);
      }
      await sleep(Math.min(intervalMs, Math.max(0, maxWaitMs - (Date.now() - started))));
    }
    throw new Error("OpenAI device authorization timed out after 15 minutes.");
  }

  private async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<TokenExchangeResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${this.issuer}/deviceauth/callback`,
      client_id: this.clientId,
      code_verifier: codeVerifier,
    });
    return await this.fetchJson<TokenExchangeResponse>(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw new Error(`OpenAI auth request failed with HTTP ${response.status}: ${await safeResponseText(response)}`);
    return (await response.json()) as T;
  }
}

export function crixHome(): string {
  return process.env.CRIX_HOME?.trim() || path.join(os.homedir(), ".crix");
}

export async function hasUsableOpenAIAuth(store = new OpenAIAuthStore()): Promise<boolean> {
  return (await store.status()).configured;
}

function authFromTokenResponse(response: TokenExchangeResponse): CrixOpenAIAuth {
  const idClaims = parseJwtPayload(response.id_token);
  const authClaims = getRecord(idClaims["https://api.openai.com/auth"]);
  const profileClaims = getRecord(idClaims["https://api.openai.com/profile"]);
  const accountId = getString(authClaims.chatgpt_account_id);
  return {
    authMode: "chatgpt",
    tokens: {
      idToken: response.id_token,
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      ...(accountId ? { accountId } : {}),
    },
    profile: {
      email: getString(idClaims.email) ?? getString(profileClaims.email),
      planType: getString(authClaims.chatgpt_plan_type),
      userId: getString(authClaims.chatgpt_user_id) ?? getString(authClaims.user_id),
    },
    lastRefresh: new Date().toISOString(),
  };
}

function parseAuthFile(value: unknown): CrixOpenAIAuth {
  if (!isRecord(value)) throw new Error("Crix auth file must be an object.");
  if (value.authMode !== "chatgpt") throw new Error("Unsupported Crix auth mode.");
  const tokens = getRecord(value.tokens);
  const profile = getRecord(value.profile);
  const idToken = expectString(tokens.idToken, "tokens.idToken");
  const accessToken = expectString(tokens.accessToken, "tokens.accessToken");
  const refreshToken = expectString(tokens.refreshToken, "tokens.refreshToken");
  return {
    authMode: "chatgpt",
    tokens: {
      idToken,
      accessToken,
      refreshToken,
      accountId: getString(tokens.accountId),
    },
    profile: {
      email: getString(profile.email),
      planType: getString(profile.planType),
      userId: getString(profile.userId),
    },
    lastRefresh: getString(value.lastRefresh) ?? new Date(0).toISOString(),
  };
}

function shouldRefresh(auth: CrixOpenAIAuth): boolean {
  const expiresAt = jwtExpiresAt(auth.tokens.accessToken);
  if (expiresAt !== undefined) return expiresAt.getTime() - Date.now() <= TOKEN_EXPIRY_SKEW_MS;
  const lastRefreshMs = Date.parse(auth.lastRefresh);
  return !Number.isFinite(lastRefreshMs) || Date.now() - lastRefreshMs >= REFRESH_INTERVAL_MS;
}

function jwtExpiresAt(jwt: string): Date | undefined {
  try {
    const payload = parseJwtPayload(jwt);
    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    return exp === undefined ? undefined : new Date(exp * 1000);
  } catch {
    return undefined;
  }
}

function parseJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) throw new Error("Invalid JWT.");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  const value = JSON.parse(json) as unknown;
  if (!isRecord(value)) throw new Error("Invalid JWT payload.");
  return value;
}

function readEnvToken(): OpenAIAuthToken | undefined {
  const oauthToken = process.env.CRIX_OPENAI_OAUTH_TOKEN?.trim();
  if (oauthToken) return { source: "env:CRIX_OPENAI_OAUTH_TOKEN", mode: "oauth-token", token: oauthToken };
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) return { source: "env:OPENAI_API_KEY", mode: "api-key", token: apiKey };
  return undefined;
}

function previewToken(token: string): string {
  if (token.length <= 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

async function safeResponseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
