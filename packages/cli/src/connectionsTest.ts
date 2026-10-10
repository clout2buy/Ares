// POST /gateway/connections/test — a real, cheap, side-effect-free liveness
// check per service type. Bounded at 10s overall; `detail` passes through
// safeText with every secret it handled registered for redaction.
//
//   mcp-oauth / mcp-key  initialize + tools/list against the server with the
//                        stored bearer (probeMcpTools — both are reads). An
//                        open server is probed without a credential.
//                        Header-key and SSE-only connectors can't be probed
//                        that way: credential/expiry presence is reported.
//   oauth-app            a valid access token (refreshed transparently if it
//                        was expired — the same path every tool call takes),
//                        then the provider's userinfo GET when we know one; the
//                        answer also records the connected `account`.
//   api-key              each credential present; then a read-only ping where
//                        one exists (OpenAI models, Resend domains, Stripe
//                        balance, Twilio account) — otherwise presence only,
//                        and the detail says so.
//   browser              the saved session file exists and isn't expired.

import { promises as fs } from "node:fs";
import {
  accountFromJson,
  OAUTH_PROVIDERS,
  browserSessionFile,
  catalogByUrl,
  getCredential,
  getMcpCallCredentials,
  getValidAccessToken,
  isServiceConnected,
  loadRemoteMcpServers,
  probeMcpTools,
  type ConnectService,
} from "@ares/core";
import { clearMcpCacheError } from "./connectionsEnrich.js";
import { cleanAccount, rememberTest, safeText, type TestRecord } from "./connectionsSafe.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TestOptions {
  home?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Overall budget; clamped to 10s. */
  timeoutMs?: number;
}

export const MAX_TEST_MS = 10_000;

interface Outcome {
  ok: boolean;
  detail: string;
  account?: string;
}

/** Provider userinfo endpoints (read-only GETs) and how to read the account. */
const USERINFO: Record<string, { url: string; account: (j: Record<string, unknown>) => unknown; headers?: Record<string, string> }> = {
  google: { url: "https://openidconnect.googleapis.com/v1/userinfo", account: (j) => j.email },
  github: { url: "https://api.github.com/user", account: (j) => j.login, headers: { "user-agent": "ares-garrison", accept: "application/vnd.github+json" } },
  spotify: { url: "https://api.spotify.com/v1/me", account: (j) => j.email ?? j.display_name ?? j.id },
  microsoft: { url: "https://graph.microsoft.com/v1.0/me", account: (j) => j.mail ?? j.userPrincipalName },
  discord: { url: "https://discord.com/api/v10/users/@me", account: (j) => j.username },
};

/** Read-only pings for key services: URL + how to authenticate. */
const KEY_PINGS: Record<string, { label: string; url: string }> = {
  openai: { label: "OpenAI", url: "https://api.openai.com/v1/models" },
  resend: { label: "Resend", url: "https://api.resend.com/domains" },
  "stripe-key": { label: "Stripe", url: "https://api.stripe.com/v1/balance" },
};

function httpVerdict(status: number, label: string): Outcome | null {
  if (status === 401 || status === 403) return { ok: false, detail: `${label} rejected the credential (HTTP ${status}); reconnect it` };
  if (status >= 200 && status < 300) return null;
  return { ok: false, detail: `${label} answered HTTP ${status}` };
}

async function checkMcp(service: ConnectService, o: Required<Pick<TestOptions, "now">> & TestOptions, guarded: FetchLike, secrets: string[]): Promise<Outcome> {
  const servers = await loadRemoteMcpServers(o.home);
  const entry = servers[service.id];
  if (!entry) return { ok: false, detail: "not connected" };
  const creds = await getMcpCallCredentials(service.id, o.home, o.now).catch(() => ({ bearer: null, headers: {} as Record<string, string> }));
  if (creds.bearer) secrets.push(creds.bearer);
  for (const v of Object.values(creds.headers)) secrets.push(v);
  const headerKeyed = !creds.bearer && Object.keys(creds.headers).length > 0;
  const sse = catalogByUrl(entry.url)?.transport === "sse";
  if (headerKeyed || sse) {
    return { ok: true, detail: headerKeyed ? "credential on file (this connector authenticates by header; not probed)" : "credential on file (SSE connector; not probed)" };
  }
  try {
    const probe = await probeMcpTools(entry.url, creds.bearer ?? undefined, guarded);
    return { ok: true, detail: `${probe.toolCount} tool${probe.toolCount === 1 ? "" : "s"} available` };
  } catch (err) {
    return { ok: false, detail: safeText(err, secrets, 160) };
  }
}

async function checkOAuthApp(service: ConnectService, o: TestOptions, guarded: FetchLike, secrets: string[]): Promise<Outcome> {
  const cfg = service.oauthProvider ? OAUTH_PROVIDERS[service.oauthProvider] : undefined;
  if (!cfg) return { ok: false, detail: "no OAuth provider configured" };
  let token: string;
  try {
    token = await getValidAccessToken(cfg, { ...(o.home ? { home: o.home } : {}), fetchImpl: guarded as unknown as typeof fetch, ...(o.now ? { now: o.now } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/OAUTH_NOT_AUTHORIZED/.test(message)) return { ok: false, detail: "not connected" };
    if (/OAUTH_EXPIRED/.test(message)) return { ok: false, detail: "the access token expired and can't be refreshed; reconnect" };
    if (/OAUTH_NO_APP/.test(message)) return { ok: false, detail: "the access token expired and the registered app credentials are missing; reconnect" };
    return { ok: false, detail: "the access token expired and the refresh was rejected; reconnect" };
  }
  secrets.push(token);
  const generic = cfg.userinfoUrl ? { url: cfg.userinfoUrl, account: (j: Record<string, unknown>) => accountFromJson(j) } : undefined;
  const info = USERINFO[cfg.provider] ?? generic;
  if (!info) return { ok: true, detail: "token present and unexpired (this provider has no account lookup)" };
  try {
    const res = await guarded(info.url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", ...((info as { headers?: Record<string, string> }).headers ?? {}) } });
    const verdict = httpVerdict(res.status, service.label);
    if (verdict) return verdict;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const account = cleanAccount(info.account(json));
    return { ok: true, detail: account ? `signed in as ${account}` : "token accepted", ...(account ? { account } : {}) };
  } catch (err) {
    return { ok: false, detail: `couldn't reach ${service.label}: ${safeText(err, secrets, 120)}` };
  }
}

async function checkApiKey(service: ConnectService, o: TestOptions, guarded: FetchLike, secrets: string[]): Promise<Outcome> {
  if (service.id === "plaid") {
    return (await isServiceConnected(service, o.home).catch(() => false)) ? { ok: true, detail: "a bank is linked (not re-checked against Plaid)" } : { ok: false, detail: "no bank linked" };
  }
  const names = service.stores ?? (service.fields ?? []).map((f) => f.credential);
  const values: Record<string, string> = {};
  for (const name of names) {
    const v = await getCredential(name, o.home ? { home: o.home } : {});
    if (!v) return { ok: false, detail: `${name} is missing` };
    values[name] = v;
    secrets.push(v);
  }
  if (service.id === "twilio") {
    const sid = values.TWILIO_ACCOUNT_SID ?? "";
    const auth = values.TWILIO_AUTH_TOKEN ?? "";
    if (/^AC[0-9a-f]{32}$/i.test(sid) && auth) {
      const basic = Buffer.from(`${sid}:${auth}`).toString("base64");
      secrets.push(basic);
      try {
        const res = await guarded(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, { headers: { authorization: `Basic ${basic}` } });
        return httpVerdict(res.status, "Twilio") ?? { ok: true, detail: "Twilio accepted the credentials" };
      } catch (err) {
        return { ok: false, detail: `couldn't reach Twilio: ${safeText(err, secrets, 120)}` };
      }
    }
  }
  const ping = KEY_PINGS[service.id];
  const key = names.length === 1 ? values[names[0]!] : (names.map((n) => values[n]).find(Boolean) ?? undefined);
  if (ping && key && names.length >= 1) {
    const bearer = values[names[0]!]!;
    try {
      const res = await guarded(ping.url, { headers: { authorization: `Bearer ${bearer}` } });
      return httpVerdict(res.status, ping.label) ?? { ok: true, detail: `${ping.label} accepted the key` };
    } catch (err) {
      return { ok: false, detail: `couldn't reach ${ping.label}: ${safeText(err, secrets, 120)}` };
    }
  }
  return { ok: true, detail: "credential on file (no read-only check exists for this service, so it isn't verified against the provider)" };
}

async function checkBrowser(service: ConnectService, o: TestOptions, now: number): Promise<Outcome> {
  const file = browserSessionFile(service.id, o.home);
  try {
    await fs.access(file);
  } catch {
    return { ok: false, detail: "not signed in" };
  }
  try {
    const state = JSON.parse(await fs.readFile(file, "utf8")) as { cookies?: Array<{ expires?: number }> };
    const persistent = (state.cookies ?? []).filter((c) => typeof c.expires === "number" && c.expires > 0);
    if (persistent.length > 0 && persistent.every((c) => c.expires! * 1000 < now)) return { ok: false, detail: "the saved sign-in has expired; sign in again" };
  } catch {
    return { ok: false, detail: "the saved sign-in file is unreadable; sign in again" };
  }
  return { ok: true, detail: "a saved sign-in is on file (not re-checked against the site)" };
}

/** Run one liveness check. Never throws; always resolves within the budget. */
export async function testConnection(service: ConnectService, o: TestOptions = {}): Promise<TestRecord> {
  const now = o.now ?? Date.now;
  const budget = Math.min(Math.max(o.timeoutMs ?? MAX_TEST_MS, 1), MAX_TEST_MS);
  const secrets: string[] = [];
  const controller = new AbortController();
  const base: FetchLike = o.fetchImpl ?? ((url, init) => fetch(url, init));
  // Every probe gets the shared deadline, and never follows a redirect off to
  // somewhere the provider didn't name.
  const guarded: FetchLike = (url, init) => base(url, { ...init, redirect: "manual", signal: controller.signal });

  const run = async (): Promise<Outcome> => {
    if (!(await isServiceConnected(service, o.home).catch(() => false))) return { ok: false, detail: "not connected" };
    switch (service.kind) {
      case "mcp-oauth":
      case "mcp-key":
        return checkMcp(service, { ...o, now }, guarded, secrets);
      case "oauth-app":
        return checkOAuthApp(service, o, guarded, secrets);
      case "api-key":
        return checkApiKey(service, o, guarded, secrets);
      case "browser":
        return checkBrowser(service, o, now());
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, detail: `timed out after ${Math.round(budget / 1000) || 1}s` });
    }, budget);
    timer.unref?.();
  });
  let outcome: Outcome;
  try {
    outcome = await Promise.race([run(), timeout]);
  } catch (err) {
    outcome = { ok: false, detail: safeText(err, secrets, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const record: TestRecord = {
    ok: outcome.ok,
    detail: safeText(outcome.detail, secrets, 200),
    checkedAt: now(),
    ...(outcome.account ? { account: outcome.account } : {}),
  };
  rememberTest(o.home, service.id, record);
  if (record.ok) await clearMcpCacheError(service.id, o.home);
  return record;
}
